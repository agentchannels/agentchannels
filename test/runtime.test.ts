import { describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime } from "../src/runtimes/claude.ts";
import type { RuntimeInteractionRequest } from "../src/runtimes/contract.ts";

function fakeQuery(messages: SDKMessage[]): Query {
  const iterator = (async function* (): AsyncIterable<SDKMessage> {
    await Promise.resolve();
    yield* messages;
  })();
  return Object.assign(iterator, {
    interrupt: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  }) as unknown as Query;
}

const resultMessage = (result: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    result,
    session_id: "runtime-1",
    uuid: "uuid-1",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  }) as unknown as SDKMessage;

const assistantMessage = (text: string): SDKMessage =>
  ({
    type: "assistant",
    session_id: "runtime-1",
    message: { content: [{ type: "text", text }] },
  }) as unknown as SDKMessage;

describe("ClaudeRuntime", () => {
  it("does not emit the same assistant text as both progress and final", async () => {
    const sdkQuery = vi.fn(() =>
      fakeQuery([assistantMessage("done"), resultMessage("done")]),
    );
    const turn = new ClaudeRuntime(sdkQuery as never).start({
      cwd: "/repo/worktree",
      additionalDirectories: [],
      prompt: "hello",
      runtimeState: null,
      requestInteraction: vi.fn(),
    });
    const events: unknown[] = [];
    for await (const event of turn.events) events.push(event);
    expect(events).toEqual([
      { type: "session_started", runtimeSessionId: "runtime-1" },
      { type: "final", body: "done" },
    ]);
  });

  it("preserves distinct progress before the final response", async () => {
    const sdkQuery = vi.fn(() =>
      fakeQuery([assistantMessage("working"), resultMessage("done")]),
    );
    const turn = new ClaudeRuntime(sdkQuery as never).start({
      cwd: "/repo/worktree",
      additionalDirectories: [],
      prompt: "hello",
      runtimeState: null,
      requestInteraction: vi.fn(),
    });
    const events: unknown[] = [];
    for await (const event of turn.events) events.push(event);
    expect(events).toEqual([
      { type: "session_started", runtimeSessionId: "runtime-1" },
      { type: "progress", body: "working" },
      { type: "final", body: "done" },
    ]);
  });

  it("starts with exact cwd/additional directories and maps SDK output", async () => {
    let captured: Options | undefined;
    const sdkQuery = vi.fn(
      (params: {
        prompt: string | AsyncIterable<unknown>;
        options?: Options;
      }) => {
        captured = params.options;
        return fakeQuery([resultMessage("done")]);
      },
    );
    const runtime = new ClaudeRuntime(sdkQuery as never);
    const turn = runtime.start({
      cwd: "/repo/worktree",
      additionalDirectories: ["/shared"],
      prompt: "hello",
      runtimeState: null,
      requestInteraction: vi.fn(),
    });

    expect(captured?.cwd).toBe("/repo/worktree");
    expect(captured?.additionalDirectories).toEqual(["/shared"]);
    expect(captured?.pathToClaudeCodeExecutable).toBeUndefined();
    await expect(turn.interrupt()).resolves.toBeUndefined();
    const events: unknown[] = [];
    for await (const event of turn.events) events.push(event);
    expect(events).toEqual([
      { type: "session_started", runtimeSessionId: "runtime-1" },
      { type: "final", body: "done" },
    ]);
    turn.dispose();
  });

  it("resumes with runtime ID and routes interaction callbacks", async () => {
    let captured: Options | undefined;
    const requestInteraction = vi.fn(() =>
      Promise.resolve({
        status: "answered" as const,
        response: { answers: { "Which?": "yes" } },
      }),
    );
    const sdkQuery = vi.fn((params: { options?: Options }) => {
      captured = params.options;
      return fakeQuery([]);
    });
    const runtime = new ClaudeRuntime(sdkQuery as never);
    runtime.resume({
      cwd: "/repo/session",
      additionalDirectories: [],
      prompt: "continue",
      runtimeSessionId: "runtime-1",
      runtimeState: null,
      requestInteraction,
    });
    expect(captured?.resume).toBe("runtime-1");
    const canUseTool = captured?.canUseTool;
    expect(canUseTool).toBeDefined();
    const question = await canUseTool?.(
      "AskUserQuestion",
      { questions: [] },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
      },
    );
    expect(question).toEqual({
      behavior: "allow",
      updatedInput: { questions: [], answers: { "Which?": "yes" } },
    });
    expect(requestInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "question" }),
    );
  });

  it("reads a permission reply as an approval, a refusal, or neither", () => {
    // One predicate settles both sides: the coordinator used to classify replies
    // with a deny-word list while the adapter used an allow-word list, so a
    // reply in neither was persisted as answered and refused as a tool call.
    // The third branch is what a reply in neither list gets now. Turning it into
    // a denial is what made an operator think they had approved something.
    const runtime = new ClaudeRuntime();
    const permission = {
      kind: "permission" as const,
      request: { title: "Claude wants to use Bash" },
      progress: undefined,
      runtimeState: null,
    };

    for (const reply of ["allow", "yes", "Proceed", "ok", "ㅇㅇ", "네", true]) {
      expect(
        runtime.interpretResponse(permission, reply),
        JSON.stringify(reply),
      ).toMatchObject({ state: "resolved", status: "answered" });
    }
    for (const reply of ["deny", "no", "cancel", "아니요", "ㄴㄴ", false]) {
      expect(
        runtime.interpretResponse(permission, reply),
        JSON.stringify(reply),
      ).toMatchObject({ state: "resolved", status: "denied" });
    }
    for (const reply of [
      "maybe",
      "",
      "no, run it with sudo instead",
      "why does it need that?",
      {},
    ]) {
      const outcome = runtime.interpretResponse(permission, reply);
      expect(outcome.state, JSON.stringify(reply)).toBe("unresolved");
      if (outcome.state !== "unresolved") throw new Error("expected a re-ask");
      expect(outcome.body).toContain("Claude wants to use Bash");
    }
  });

  it("shows the command being approved and offers the sticky choice", async () => {
    // The request used to travel as the tool input on one JSON line, and Linear
    // posts the body alone, so an approval showed a tool name and nothing else.
    let captured: Options | undefined;
    const requestInteraction = vi.fn((_request: RuntimeInteractionRequest) =>
      Promise.resolve({ status: "denied" as const, response: "deny" }),
    );
    const sdkQuery = vi.fn((params: { options?: Options }) => {
      captured = params.options;
      return fakeQuery([]);
    });
    new ClaudeRuntime(sdkQuery as never).start({
      cwd: "/repo/worktree",
      additionalDirectories: [],
      prompt: "check the vault",
      runtimeState: null,
      requestInteraction,
    });
    await captured?.canUseTool?.(
      "Bash",
      { command: "op whoami" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
        title: "Claude wants to use Bash",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "op whoami *" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
    );

    const request = requestInteraction.mock.calls[0]?.[0];
    const options = (request?.data.options ?? []) as {
      label: string;
      value: string;
    }[];
    expect(request?.body).toContain("Claude wants to use Bash");
    expect(request?.body).toContain("```sh\nop whoami\n```");
    expect(options.map((option) => option.value)).toEqual([
      "allow",
      "allow_always",
      "deny",
    ]);
    // No styling exists on either channel, so the label is the only warning.
    for (const option of options)
      expect(option.label.split(" ").length).toBeGreaterThan(1);
    expect(options[1]?.label).toContain("Bash(op whoami *)");
  });

  it("omits the sticky choice when the SDK proposed no rule", async () => {
    let captured: Options | undefined;
    const requestInteraction = vi.fn((_request: RuntimeInteractionRequest) =>
      Promise.resolve({ status: "denied" as const, response: "deny" }),
    );
    const sdkQuery = vi.fn((params: { options?: Options }) => {
      captured = params.options;
      return fakeQuery([]);
    });
    new ClaudeRuntime(sdkQuery as never).start({
      cwd: "/repo/worktree",
      additionalDirectories: [],
      prompt: "read it",
      runtimeState: null,
      requestInteraction,
    });
    await captured?.canUseTool?.(
      "Read",
      { file_path: "/repo/worktree/a.ts" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-2",
        requestId: "request-2",
      },
    );
    const options = (requestInteraction.mock.calls[0]?.[0].data.options ??
      []) as { value: string }[];
    expect(options.map((option) => option.value)).toEqual(["allow", "deny"]);
  });

  it("returns the SDK's own rule and keeps it for the Agent when made sticky", () => {
    const suggestion = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "op whoami *" }],
      behavior: "allow",
      destination: "localSettings",
    };
    const outcome = new ClaudeRuntime().interpretResponse(
      {
        kind: "permission",
        request: {
          title: "Claude wants to use Bash",
          data: { suggestions: [suggestion] },
        },
        progress: undefined,
        runtimeState: null,
      },
      "allow_always",
    );
    expect(outcome).toMatchObject({
      state: "resolved",
      status: "answered",
      // Handed back verbatim: the destination is the SDK's to choose.
      response: { updatedPermissions: [suggestion] },
      runtimeState: { permissionRules: [suggestion] },
    });
  });

  it("replays stored rules through settings without inheriting less", async () => {
    // The advantage this product has is that it omits settingSources, env, and
    // mcpServers, so the SDK loads the operator's real environment. That is a
    // default rather than a decision, and one added key would end it silently.
    let captured: Options | undefined;
    const sdkQuery = vi.fn((params: { options?: Options }) => {
      captured = params.options;
      return fakeQuery([resultMessage("done")]);
    });
    new ClaudeRuntime(sdkQuery as never).start({
      cwd: "/repo/worktree",
      additionalDirectories: [],
      prompt: "again",
      runtimeState: {
        permissionRules: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "op whoami *" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
      requestInteraction: vi.fn(),
    });
    expect(captured?.settings).toEqual({
      permissions: { allow: ["Bash(op whoami *)"] },
    });
    for (const key of ["settingSources", "env", "mcpServers"])
      expect(Object.hasOwn(captured ?? {}, key), key).toBe(false);
  });

  it("keeps a multi-part question partial until every part is answered", () => {
    const runtime = new ClaudeRuntime();
    const pending = {
      kind: "question" as const,
      request: {
        data: {
          questions: [{ question: "Which?" }, { question: "When?" }],
        },
      },
      progress: undefined as unknown,
      runtimeState: null,
    };

    const first = runtime.interpretResponse(pending, {
      questionIndex: 0,
      answer: "the first",
    });
    expect(first.state).toBe("partial");

    const second = runtime.interpretResponse(
      { ...pending, progress: first.state === "partial" ? first.progress : {} },
      { questionIndex: 1, answer: "tomorrow" },
    );
    expect(second).toMatchObject({
      state: "resolved",
      status: "answered",
      response: { answers: { "Which?": "the first", "When?": "tomorrow" } },
    });
  });

  it("sends plan revision feedback as a real streamed user message", async () => {
    let captured: Options | undefined;
    let prompts: AsyncIterable<unknown> | undefined;
    const sdkQuery = vi.fn(
      (params: {
        prompt: string | AsyncIterable<unknown>;
        options?: Options;
      }) => {
        captured = params.options;
        if (typeof params.prompt !== "string") prompts = params.prompt;
        return fakeQuery([]);
      },
    );
    const runtime = new ClaudeRuntime(sdkQuery as never);
    runtime.start({
      cwd: "/repo/session",
      additionalDirectories: [],
      prompt: "plan this",
      runtimeState: null,
      requestInteraction: () =>
        Promise.resolve({
          status: "denied" as const,
          response: "Revise the second step",
        }),
    });
    if (prompts === undefined || captured?.canUseTool === undefined)
      throw new Error("Streaming prompts were not configured");
    const iterator = prompts[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { message: { content: "plan this" } },
    });
    await expect(
      captured.canUseTool(
        "ExitPlanMode",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-plan",
          requestId: "request-plan",
        },
      ),
    ).resolves.toEqual({ behavior: "deny", message: "Revise the second step" });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { message: { content: "Revise the second step" } },
    });
  });
});
