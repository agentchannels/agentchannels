import { describe, expect, it, vi } from "vitest";
import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime } from "../src/runtimes/claude.ts";

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

  it("settles permission replies with one predicate, not two", () => {
    // The coordinator classified replies with a deny-word list while the adapter
    // classified them with an allow-word list. Anything in neither list, such as
    // "sure", was persisted as answered but refused as a tool call.
    const runtime = new ClaudeRuntime();
    const permission = {
      kind: "permission" as const,
      request: {},
      progress: undefined,
    };

    for (const reply of ["allow", "yes", "Proceed", true]) {
      expect(runtime.interpretResponse(permission, reply)).toMatchObject({
        state: "resolved",
        status: "answered",
      });
    }
    for (const reply of ["deny", "no", "sure", "maybe", "", false, {}]) {
      expect(
        runtime.interpretResponse(permission, reply),
        JSON.stringify(reply),
      ).toMatchObject({ state: "resolved", status: "denied" });
    }
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
