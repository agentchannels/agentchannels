import {
  query,
  type CanUseTool,
  type Options,
  type PermissionUpdate,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { InteractionKind } from "../model.ts";
import type {
  InteractionOutcome,
  InteractionResult,
  PendingInteractionState,
  Runtime,
  RuntimeEvent,
  RuntimeInteractionRequest,
  RuntimeResumeOptions,
  RuntimeStartOptions,
  RuntimeTurn,
} from "./contract.ts";

type QueryFactory = typeof query;

/** A small streaming-input queue. Streaming is required for Query.interrupt(). */
class PromptQueue
  implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage>
{
  private readonly waiting: ((
    result: IteratorResult<SDKUserMessage>,
  ) => void)[] = [];
  private readonly values: SDKUserMessage[] = [];
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  push(value: SDKUserMessage): void {
    const resolve = this.waiting.shift();
    if (resolve) resolve({ done: false, value });
    else if (!this.closed) this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.waiting.splice(0))
      resolve({ done: true, value: undefined });
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const textFromContent = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    return record.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
};

type ToolCall = { id: string; action: string; parameter: string };

/**
 * The tool argument a person would recognise the call by.
 *
 * These are the argument names Claude Code's own tools use for their subject.
 * Anything else falls back to the serialized input, so a tool this does not
 * know still renders as itself rather than as an empty line.
 */
function toolParameter(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "")
      return truncate(value, PARAMETER_LIMIT);
  }
  return truncate(safeJson(input), PARAMETER_LIMIT);
}

const toolCalls = (content: unknown): ToolCall[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): ToolCall[] => {
    const record = asRecord(block);
    if (record.type !== "tool_use" || typeof record.id !== "string") return [];
    return [
      {
        id: record.id,
        action: typeof record.name === "string" ? record.name : "tool",
        parameter: toolParameter(asRecord(record.input)),
      },
    ];
  });
};

const toolResults = (content: unknown): { id: string; result: string }[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): { id: string; result: string }[] => {
    const record = asRecord(block);
    if (record.type !== "tool_result" || typeof record.tool_use_id !== "string")
      return [];
    return [
      {
        id: record.tool_use_id,
        result: truncate(
          textFromContent(record.content).join("\n").trim(),
          RESULT_LIMIT,
        ),
      },
    ];
  });
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? "";
  } catch {
    return "Unserializable interaction input";
  }
}

/** The option values this adapter offers for a permission request. */
const ALLOW_ONCE = "allow";
const ALLOW_ALWAYS = "allow_always";
const DENY = "deny";

/** Long enough to hold a real command, short enough that a file body cannot flood a channel. */
const FENCE_LIMIT = 1500;
const PARAMETER_LIMIT = 200;
const RESULT_LIMIT = 2000;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * The suggestions this adapter is willing to make sticky.
 *
 * Only rules the SDK itself proposed, and only permissive ones. Nothing here
 * composes a rule, widens one, or rewrites the destination it came with.
 */
function stickySuggestions(suggestions: unknown): PermissionUpdate[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((suggestion): suggestion is PermissionUpdate => {
    const record = asRecord(suggestion);
    return (
      record.type === "addRules" &&
      record.behavior === "allow" &&
      Array.isArray(record.rules) &&
      record.rules.length > 0
    );
  });
}

/** One rule in the `Tool(content)` spelling that `Settings.permissions` uses. */
function ruleText(rule: unknown): string {
  const record = asRecord(rule);
  const toolName = typeof record.toolName === "string" ? record.toolName : "";
  if (toolName === "") return "";
  return typeof record.ruleContent === "string" && record.ruleContent !== ""
    ? `${toolName}(${record.ruleContent})`
    : toolName;
}

function ruleTexts(updates: readonly PermissionUpdate[]): string[] {
  return updates.flatMap((update) =>
    "rules" in update
      ? update.rules.map(ruleText).filter((text) => text !== "")
      : [],
  );
}

/**
 * Rules this Agent has already made sticky.
 *
 * The stored blob is revalidated on the way out rather than trusted, so a row
 * written by an older build degrades to "no rules" instead of reaching the SDK
 * as a malformed permission update.
 */
function storedRules(state: unknown): PermissionUpdate[] {
  return stickySuggestions(asRecord(state).permissionRules);
}

function mergeStoredRules(
  state: unknown,
  granted: readonly PermissionUpdate[],
): { permissionRules: PermissionUpdate[] } {
  const kept = storedRules(state);
  const seen = new Set(kept.map((update) => safeJson(update)));
  for (const update of granted) {
    const key = safeJson(update);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(update);
  }
  return { permissionRules: kept };
}

function permissionAllowRules(state: unknown): string[] {
  return [...new Set(ruleTexts(storedRules(state)))];
}

/** What a channel reply says about a permission request, including "nothing I can read". */
type PermissionVerdict = "allow" | "allow_always" | "deny" | "unclear";

const APPROVES = new Set([
  "allow",
  "approve",
  "approved",
  "proceed",
  "yes",
  "y",
  "ok",
  "okay",
  "sure",
  "go ahead",
  "do it",
  "continue",
  "승인",
  "허용",
  "네",
  "넵",
  "예",
  "응",
  "그래",
  "좋아",
  "좋아요",
  "해줘",
  "진행",
  "ㅇㅇ",
  "ㅇㅋ",
  "ㄱㄱ",
]);

const REFUSES = new Set([
  "deny",
  "denied",
  "decline",
  "declined",
  "no",
  "n",
  "nope",
  "stop",
  "cancel",
  "don't",
  "dont",
  "do not",
  "거부",
  "거절",
  "아니",
  "아니오",
  "아니요",
  "아뇨",
  "안돼",
  "안됨",
  "하지마",
  "하지 마",
  "중단",
  "취소",
  "ㄴㄴ",
]);

function normalizeReply(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^["'`“‘]+/, "")
    .replace(/["'`”’.!]+$/, "")
    .trim();
}

/**
 * Read a reply as an approval, a refusal, or neither.
 *
 * Matching is on the whole reply, never a prefix: "no, run it with sudo instead"
 * asks for a different command and must not be read as the refusal its first
 * word looks like. Anything this cannot place is `unclear`, which the caller
 * must not settle in either direction.
 */
function permissionVerdict(response: unknown): PermissionVerdict {
  if (response === true) return "allow";
  if (response === false) return "deny";
  if (typeof response === "string") {
    const reply = normalizeReply(response);
    if (reply === ALLOW_ALWAYS) return "allow_always";
    if (APPROVES.has(reply)) return "allow";
    if (REFUSES.has(reply)) return "deny";
    return "unclear";
  }
  const record = asRecord(response);
  if (record.action === ALLOW_ALWAYS) return "allow_always";
  if (
    record.behavior === "allow" ||
    record.allowed === true ||
    record.approved === true ||
    record.allow === true ||
    record.action === "allow" ||
    record.action === "approve" ||
    record.action === "proceed"
  )
    return "allow";
  if (
    record.behavior === "deny" ||
    record.allowed === false ||
    record.approved === false ||
    record.allow === false ||
    record.action === "deny"
  )
    return "deny";
  return "unclear";
}

function denyMessage(response: unknown, fallback: string): string {
  if (typeof response === "string" && response.trim() !== "") return response;
  const record = asRecord(response);
  for (const key of ["message", "reason", "feedback", "text"]) {
    if (typeof record[key] === "string" && record[key].length > 0)
      return record[key];
  }
  return fallback;
}

function questionAnswers(
  response: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof response === "string") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = asRecord(questions[0]);
    return typeof first.question === "string"
      ? { [first.question]: response }
      : null;
  }
  if (!response || typeof response !== "object") return null;
  const record = asRecord(response);
  const answers = record.answers ?? response;
  return typeof answers === "object"
    ? (answers as Record<string, unknown>)
    : null;
}

/**
 * Merge one channel reply into the answers collected so far for an
 * `AskUserQuestion` request, and report whether every question now has one.
 *
 * A reply may name its question by index, carry a whole `answers` object, or be
 * a bare value for the next unanswered question.
 */
function accumulateAnswers(
  request: unknown,
  progress: unknown,
  incoming: unknown,
): { result: { answers: Record<string, unknown> }; complete: boolean } {
  const data = asRecord(asRecord(request).data);
  const questions = (Array.isArray(data.questions) ? data.questions : [])
    .map(asRecord)
    .filter((question) => typeof question.question === "string");
  if (questions.length === 0)
    return { result: { answers: { response: incoming } }, complete: true };

  const answers: Record<string, unknown> = {
    ...asRecord(asRecord(progress).answers),
  };
  const incomingRecord = asRecord(incoming);
  if (
    typeof incomingRecord.answers === "object" &&
    incomingRecord.answers !== null
  ) {
    Object.assign(answers, incomingRecord.answers);
  } else {
    const explicitIndex =
      typeof incomingRecord.questionIndex === "number"
        ? incomingRecord.questionIndex
        : undefined;
    const nextIndex =
      explicitIndex ??
      questions.findIndex(
        (question) => !Object.hasOwn(answers, question.question as string),
      );
    const question = questions[nextIndex];
    if (question !== undefined) {
      let answer = Object.hasOwn(incomingRecord, "answer")
        ? incomingRecord.answer
        : incoming;
      if (question.multiSelect === true && typeof answer === "string") {
        answer = answer
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
      answers[question.question as string] = answer;
    }
  }

  return {
    result: { answers },
    complete: questions.every((question) =>
      Object.hasOwn(answers, question.question as string),
    ),
  };
}

function initialUserMessage(prompt: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  };
}

/** The tool argument worth putting in front of a person, fenced. */
function fencedInput(input: Record<string, unknown>): string {
  const command = input.command;
  return typeof command === "string" && command.trim() !== ""
    ? `\`\`\`sh\n${truncate(command, FENCE_LIMIT)}\n\`\`\``
    : `\`\`\`json\n${truncate(safeJson(input, 2), FENCE_LIMIT)}\n\`\`\``;
}

/**
 * What the operator is being asked to approve, in a shape a channel renders.
 *
 * A permission request used to travel as the tool input on one JSON line, and
 * the Linear connector posted the body alone, so an approval showed a tool name
 * and nothing about what would actually run.
 */
function permissionBody(
  title: string,
  input: Record<string, unknown>,
  description: string | undefined,
  sticky: readonly PermissionUpdate[],
): string {
  const parts = [`**${title}**`];
  if (description !== undefined && description.trim() !== "")
    parts.push(description);
  parts.push(fencedInput(input));
  const rules = ruleTexts(sticky);
  if (rules.length > 0) {
    parts.push(
      `Allowing this every time stores ${rules.map((rule) => `\`${rule}\``).join(", ")} for this Agent, so later Sessions will not ask again.`,
    );
  }
  return parts.join("\n\n");
}

/**
 * The choices a permission request offers.
 *
 * Labels carry the whole signal: the channel APIs have no destructive or primary
 * styling, so a one-word "Yes" would leave a person clicking with no idea what
 * they were agreeing to. The sticky choice appears only when the SDK proposed a
 * rule for it.
 */
function permissionOptions(
  toolName: string,
  sticky: readonly PermissionUpdate[],
): { label: string; value: string }[] {
  const rules = ruleTexts(sticky);
  return [
    { label: `Allow this ${toolName} call once`, value: ALLOW_ONCE },
    ...(rules.length > 0
      ? [
          {
            label: `Always allow ${truncate(rules.join(", "), PARAMETER_LIMIT)} for this Agent`,
            value: ALLOW_ALWAYS,
          },
        ]
      : []),
    { label: `Deny this ${toolName} call`, value: DENY },
  ];
}

/** Put an unreadable reply back to the channel instead of settling it. */
function clarificationBody(request: unknown): string {
  const title = asRecord(request).title;
  return [
    typeof title === "string" && title !== ""
      ? `**${title}**`
      : "**The pending request is still waiting.**",
    `That reply did not read as an approval or a refusal, so nothing ran and the request is still waiting. Choose one of the options, or reply exactly \`${ALLOW_ONCE}\` or \`${DENY}\`.`,
  ].join("\n\n");
}

/** ExitPlanMode carries the plan as markdown already; serializing it hides it. */
function planBody(input: Record<string, unknown>): string {
  const plan = input.plan;
  return typeof plan === "string" && plan.trim() !== ""
    ? plan
    : safeJson(input);
}

function questionBody(input: Record<string, unknown>): string {
  if (!Array.isArray(input.questions)) return safeJson(input);
  return input.questions
    .map((question, index) => {
      const record = asRecord(question);
      const title =
        typeof record.question === "string"
          ? record.question
          : `Question ${String(index + 1)}`;
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              const value = asRecord(option);
              const label =
                typeof value.label === "string" ? value.label : "Option";
              return typeof value.description === "string"
                ? `- ${label}: ${value.description}`
                : `- ${label}`;
            })
            .join("\n")
        : "";
      return `${title}${options === "" ? "" : `\n${options}`}${record.multiSelect === true ? "\nSelect all that apply." : ""}`;
    })
    .join("\n\n");
}

/** Claude Agent SDK adapter; the SDK's omitted executable path selects its bundled pinned CLI. */
export class ClaudeRuntime implements Runtime {
  readonly type = "claude-code" as const;
  private readonly sdkQuery: QueryFactory;

  constructor(sdkQuery: QueryFactory = query) {
    this.sdkQuery = sdkQuery;
  }

  start(options: RuntimeStartOptions): RuntimeTurn {
    return this.createTurn(options);
  }

  /**
   * A question is settled only once every part has an answer; a permission or
   * plan is settled by the first reply it can read. All three decisions live
   * here because all three depend on how this runtime's tools encode requests.
   *
   * A plan stays two-way on purpose. Any reply that is not an approval is sent
   * to Claude verbatim as revision feedback, so an unreadable reply there is
   * still acted on and nothing is lost by settling it. A permission has no such
   * path: an unreadable reply used to become a silent denial.
   */
  interpretResponse(
    pending: PendingInteractionState,
    incoming: unknown,
  ): InteractionOutcome {
    if (pending.kind === "question") {
      const accumulated = accumulateAnswers(
        pending.request,
        pending.progress,
        incoming,
      );
      return accumulated.complete
        ? {
            state: "resolved",
            status: "answered",
            response: accumulated.result,
          }
        : { state: "partial", progress: accumulated.result };
    }

    const verdict = permissionVerdict(incoming);
    if (pending.kind === "plan") {
      return {
        state: "resolved",
        status:
          verdict === "allow" || verdict === "allow_always"
            ? "answered"
            : "denied",
        response: incoming,
      };
    }
    if (verdict === "unclear")
      return { state: "unresolved", body: clarificationBody(pending.request) };
    if (verdict === "deny")
      return { state: "resolved", status: "denied", response: incoming };

    const granted =
      verdict === "allow_always"
        ? stickySuggestions(
            asRecord(asRecord(pending.request).data).suggestions,
          )
        : [];
    if (granted.length === 0)
      return { state: "resolved", status: "answered", response: incoming };
    return {
      state: "resolved",
      status: "answered",
      response: { ...asRecord(incoming), updatedPermissions: granted },
      runtimeState: mergeStoredRules(pending.runtimeState, granted),
    };
  }

  resume(options: RuntimeResumeOptions): RuntimeTurn {
    return this.createTurn(options, options.runtimeSessionId);
  }

  private createTurn(
    options: RuntimeStartOptions,
    runtimeSessionId?: string,
  ): RuntimeTurn {
    const prompts = new PromptQueue();
    let activeQuery: Query | undefined;
    let startupError: string | undefined;

    const canUseTool: CanUseTool = async (
      toolName,
      input,
      sdkOptions,
    ): Promise<PermissionResult> => {
      const isQuestion = toolName === "AskUserQuestion";
      const isPlan = toolName === "ExitPlanMode";
      const kind: InteractionKind = isQuestion
        ? "question"
        : isPlan
          ? "plan"
          : "permission";
      const title = isQuestion
        ? "Claude has a question"
        : isPlan
          ? "Claude has a plan"
          : (sdkOptions.title ?? `Claude wants to use ${toolName}`);
      const sticky =
        isQuestion || isPlan ? [] : stickySuggestions(sdkOptions.suggestions);
      const request: RuntimeInteractionRequest = {
        kind,
        title,
        body: isQuestion
          ? (sdkOptions.description ?? questionBody(input))
          : isPlan
            ? (sdkOptions.description ?? planBody(input))
            : permissionBody(title, input, sdkOptions.description, sticky),
        data: {
          toolName,
          input,
          ...(isQuestion && Array.isArray(input.questions)
            ? {
                questions: input.questions,
                options: input.questions.flatMap((question): unknown[] => {
                  const record = asRecord(question);
                  return Array.isArray(record.options) ? record.options : [];
                }),
              }
            : {}),
          ...(!isQuestion && isPlan
            ? {
                options: [
                  {
                    label: "Approve this plan and start the work",
                    value: "proceed",
                  },
                  { label: "Send the plan back with changes", value: "revise" },
                ],
              }
            : {}),
          ...(!isQuestion && !isPlan
            ? { options: permissionOptions(toolName, sticky) }
            : {}),
          ...(sdkOptions.suggestions
            ? { suggestions: sdkOptions.suggestions }
            : {}),
          ...(sdkOptions.blockedPath
            ? { blockedPath: sdkOptions.blockedPath }
            : {}),
        },
        signal: sdkOptions.signal,
      };

      let settled: InteractionResult;
      try {
        settled = await options.requestInteraction(request);
      } catch (error) {
        return {
          behavior: "deny",
          message: `Interaction failed: ${errorMessage(error)}`,
        };
      }
      const { status, response } = settled;

      if (isQuestion) {
        const answers = questionAnswers(response, input);
        return status === "answered" && answers
          ? { behavior: "allow", updatedInput: { ...input, answers } }
          : { behavior: "deny", message: "The question was not answered." };
      }

      // ExitPlanMode itself is the SDK's plan gate. Only an explicit proceed
      // response allows it; no mutating tool is approved by this adapter.
      if (isPlan) {
        if (status === "answered") return { behavior: "allow" };
        const feedback = denyMessage(response, "The plan was not approved.");
        prompts.push(initialUserMessage(feedback));
        return { behavior: "deny", message: feedback };
      }

      return status === "answered"
        ? {
            behavior: "allow",
            ...(asRecord(response).updatedInput &&
            typeof asRecord(response).updatedInput === "object"
              ? {
                  updatedInput: asRecord(response).updatedInput as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
            ...(asRecord(response).updatedPermissions &&
            Array.isArray(asRecord(response).updatedPermissions)
              ? {
                  updatedPermissions: asRecord(response)
                    .updatedPermissions as PermissionUpdate[],
                }
              : {}),
          }
        : {
            behavior: "deny",
            message: denyMessage(response, "The operator denied this action."),
          };
    };

    // `settings` is an additional layer, not a replacement for the settings files
    // the SDK loads on its own. Rules the operator made sticky are replayed here
    // because the destination the SDK names for them, localSettings, resolves
    // inside a Session worktree that is deleted along with the Session.
    //
    // Nothing else is passed. `settingSources`, `env`, and `mcpServers` are
    // omitted so the SDK applies its own defaults and the Session inherits the
    // operator's real environment, which is the whole point of the product.
    const allowRules = permissionAllowRules(options.runtimeState);
    const sdkOptions: Options = {
      cwd: options.cwd,
      additionalDirectories: [...options.additionalDirectories],
      canUseTool,
      ...(allowRules.length > 0
        ? { settings: { permissions: { allow: allowRules } } }
        : {}),
      ...(runtimeSessionId ? { resume: runtimeSessionId } : {}),
    };

    try {
      activeQuery = this.sdkQuery({ prompt: prompts, options: sdkOptions });
      prompts.push(initialUserMessage(options.prompt));
    } catch (error) {
      startupError = errorMessage(error);
    }

    const events = this.events(activeQuery, startupError);
    return {
      events,
      interrupt: async () => {
        if (activeQuery) await activeQuery.interrupt();
      },
      dispose: () => {
        prompts.close();
        activeQuery?.close();
      },
    };
  }

  private async *events(
    activeQuery: Query | undefined,
    startupError: string | undefined,
  ): AsyncIterable<RuntimeEvent> {
    if (startupError) {
      yield { type: "error", message: startupError };
      return;
    }
    if (!activeQuery) return;

    let announcedSession = false;
    let pendingAssistantText: string[] = [];
    const startedCalls = new Map<string, ToolCall>();
    for await (const message of activeQuery) {
      if (
        !announcedSession &&
        "session_id" in message &&
        typeof message.session_id === "string"
      ) {
        announcedSession = true;
        yield {
          type: "session_started",
          runtimeSessionId: message.session_id,
        };
      }
      if (message.type === "assistant") {
        for (const body of pendingAssistantText)
          yield { type: "progress", body };
        pendingAssistantText = [];
        const calls = toolCalls(message.message.content);
        if (calls.length === 0) {
          // Held back one message: only the last assistant text can repeat the
          // final result, and this is not yet known to be the last.
          pendingAssistantText = textFromContent(message.message.content);
        } else {
          // A message that calls a tool is never the last one, so its text can
          // go out now and stay ahead of the calls it introduces.
          for (const body of textFromContent(message.message.content))
            yield { type: "progress", body };
          for (const call of calls) {
            startedCalls.set(call.id, call);
            yield {
              type: "tool_started",
              action: call.action,
              parameter: call.parameter,
            };
          }
        }
        if (message.error) yield { type: "error", message: message.error };
        continue;
      }
      if (message.type === "result") {
        if (message.subtype === "success") {
          for (const body of pendingAssistantText) {
            if (body !== message.result) yield { type: "progress", body };
          }
          yield { type: "final", body: message.result };
        } else {
          yield {
            type: "error",
            message: message.errors.join("; ") || message.subtype,
          };
        }
        return;
      }
      if (message.type === "user") {
        for (const finished of toolResults(message.message.content)) {
          const started = startedCalls.get(finished.id);
          if (started === undefined) continue;
          startedCalls.delete(finished.id);
          yield {
            type: "tool_finished",
            action: started.action,
            parameter: started.parameter,
            result: finished.result,
          };
        }
      }
      for (const body of pendingAssistantText) yield { type: "progress", body };
      pendingAssistantText = [];
    }
    for (const body of pendingAssistantText) yield { type: "progress", body };
  }
}
