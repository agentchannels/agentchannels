import {
  query,
  type CanUseTool,
  type Options,
  type PermissionUpdate,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { InteractionKind } from "../core/types.js";

export type RuntimeInteractionRequest = {
  kind: InteractionKind;
  title: string;
  body: string;
  data: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
};

export type RuntimeEvent =
  | { type: "session_started"; runtimeSessionId: string }
  | { type: "progress"; body: string }
  | { type: "final"; body: string }
  | { type: "error"; message: string };

export type RuntimeTurn = {
  events: AsyncIterable<RuntimeEvent>;
  interrupt(): Promise<void>;
  dispose(): void;
};

export type RuntimeStartOptions = {
  cwd: string;
  additionalDirectories: readonly string[];
  prompt: string;
  requestInteraction(request: RuntimeInteractionRequest): Promise<unknown>;
};

export type RuntimeResumeOptions = RuntimeStartOptions & {
  runtimeSessionId: string;
};

export type Runtime = {
  readonly type: "claude-code";
  start(options: RuntimeStartOptions): RuntimeTurn;
  resume(options: RuntimeResumeOptions): RuntimeTurn;
};

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function allowResult(response: unknown): boolean {
  const record = asRecord(response);
  return (
    response === true ||
    (typeof response === "string" &&
      /^(allow|approve|approved|proceed|yes)$/i.test(response.trim())) ||
    record.behavior === "allow" ||
    record.allowed === true ||
    record.approved === true ||
    record.action === "allow" ||
    record.allow === true ||
    record.action === "approve" ||
    record.action === "proceed"
  );
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

function initialUserMessage(prompt: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  };
}

function interactionBody(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "Unserializable interaction input";
  }
}

function questionBody(input: Record<string, unknown>): string {
  if (!Array.isArray(input.questions)) return interactionBody(input);
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
      const request: RuntimeInteractionRequest = {
        kind,
        title,
        body:
          sdkOptions.description ??
          (isQuestion ? questionBody(input) : interactionBody(input)),
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
                  { label: "Proceed", value: "proceed" },
                  { label: "Revise", value: "revise" },
                ],
              }
            : {}),
          ...(!isQuestion && !isPlan
            ? {
                options: [
                  { label: "Allow", value: "allow" },
                  { label: "Deny", value: "deny" },
                ],
              }
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

      let response: unknown;
      try {
        response = await options.requestInteraction(request);
      } catch (error) {
        return {
          behavior: "deny",
          message: `Interaction failed: ${errorMessage(error)}`,
        };
      }

      if (isQuestion) {
        const answers = questionAnswers(response, input);
        return answers
          ? { behavior: "allow", updatedInput: { ...input, answers } }
          : { behavior: "deny", message: "The question was not answered." };
      }

      // ExitPlanMode itself is the SDK's plan gate. Only an explicit proceed
      // response allows it; no mutating tool is approved by this adapter.
      if (isPlan) {
        if (allowResult(response)) return { behavior: "allow" };
        const feedback = denyMessage(response, "The plan was not approved.");
        prompts.push(initialUserMessage(feedback));
        return { behavior: "deny", message: feedback };
      }

      return allowResult(response)
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

    const sdkOptions: Options = {
      cwd: options.cwd,
      additionalDirectories: [...options.additionalDirectories],
      canUseTool,
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
        pendingAssistantText = textFromContent(message.message.content);
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
      for (const body of pendingAssistantText) yield { type: "progress", body };
      pendingAssistantText = [];
    }
    for (const body of pendingAssistantText) yield { type: "progress", body };
  }
}
