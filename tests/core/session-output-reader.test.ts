import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionOutputReader, isTransientError } from "../../src/core/session-output-reader.js";
import type { AgentStreamEvent } from "../../src/core/chunk-parser.js";
import type { AgentClient } from "../../src/core/agent-client.js";

/** Create a mock AgentClient with a configurable sendMessage generator */
function createMockClient(
  sendMessageImpl: (
    sessionId: string,
    text: string,
    options?: any,
  ) => AsyncGenerator<AgentStreamEvent>,
): AgentClient {
  return {
    sendMessage: sendMessageImpl,
  } as unknown as AgentClient;
}

/** Helper: create a sendMessage that yields events from an array */
function mockSendMessage(events: AgentStreamEvent[]) {
  return async function* (_sid: string, _text: string, _opts?: any) {
    for (const event of events) {
      yield event;
    }
  };
}

describe("isTransientError", () => {
  it("identifies network errors as transient", () => {
    expect(isTransientError("Network error")).toBe(true);
    expect(isTransientError("ECONNRESET")).toBe(true);
    expect(isTransientError("ECONNREFUSED")).toBe(true);
    expect(isTransientError("ETIMEDOUT")).toBe(true);
    expect(isTransientError("ENOTFOUND")).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError("Request timeout")).toBe(true);
  });

  it("identifies server errors as transient", () => {
    expect(isTransientError("502 Bad Gateway")).toBe(true);
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("504 Gateway Timeout")).toBe(true);
    expect(isTransientError("529 overloaded")).toBe(true);
    expect(isTransientError("API overloaded")).toBe(true);
    expect(isTransientError("rate limit exceeded")).toBe(true);
  });

  it("identifies stream interruption errors as transient", () => {
    expect(isTransientError("stream aborted")).toBe(true);
    expect(isTransientError("stream ended unexpectedly")).toBe(true);
    expect(isTransientError("stream terminated")).toBe(true);
  });

  it("identifies permanent errors as non-transient", () => {
    expect(isTransientError("401 Unauthorized")).toBe(false);
    expect(isTransientError("Invalid API key")).toBe(false);
    expect(isTransientError("400 Bad Request")).toBe(false);
    expect(isTransientError("Agent not found")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTransientError("")).toBe(false);
  });
});

describe("SessionOutputReader", () => {
  describe("EventEmitter interface (start)", () => {
    it("emits typed events from the stream", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "status", status: "running" },
          { type: "text_delta", text: "Hello " },
          { type: "text_delta", text: "world" },
          { type: "done", stopReason: "end_turn" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi");
      const events: AgentStreamEvent[] = [];

      reader.on("text_delta", (e) => events.push(e));
      reader.on("status", (e) => events.push(e));
      reader.on("done", (e) => events.push(e));

      await reader.start();

      expect(events).toEqual([
        { type: "status", status: "running" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        { type: "done", stopReason: "end_turn" },
      ]);
      expect(reader.completed).toBe(true);
      expect(reader.attempts).toBe(1);
    });

    it("emits tool_use events", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "tool_use", name: "search", input: { q: "test" } },
          { type: "done" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Search");
      const events: AgentStreamEvent[] = [];
      reader.on("tool_use", (e) => events.push(e));
      await reader.start();

      expect(events).toEqual([
        { type: "tool_use", name: "search", input: { q: "test" } },
      ]);
    });

    it("emits thinking events", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "thinking", text: "Let me think..." },
          { type: "done" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Think");
      const events: AgentStreamEvent[] = [];
      reader.on("thinking", (e) => events.push(e));
      await reader.start();

      expect(events).toEqual([{ type: "thinking", text: "Let me think..." }]);
    });

    it("handles permanent errors without retry", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "error", error: "Invalid API key" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 3,
      });
      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      expect(errors).toEqual([{ type: "error", error: "Invalid API key" }]);
      expect(reader.completed).toBe(true);
      expect(reader.attempts).toBe(1); // No retries for permanent errors
    });

    it("retries on transient errors with exponential backoff", async () => {
      let callCount = 0;

      const client = createMockClient(async function* () {
        callCount++;
        if (callCount <= 2) {
          yield { type: "error" as const, error: "Network error" };
          return;
        }
        yield { type: "text_delta" as const, text: "Success" };
        yield { type: "done" as const };
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 3,
        retryDelayMs: 10, // fast for tests
      });

      const retries: any[] = [];
      const events: AgentStreamEvent[] = [];
      reader.on("retry", (info) => retries.push(info));
      reader.on("text_delta", (e) => events.push(e));
      reader.on("done", (e) => events.push(e));

      await reader.start();

      expect(callCount).toBe(3);
      expect(retries).toHaveLength(2);
      expect(retries[0]).toEqual({ attempt: 1, maxRetries: 3, delayMs: 10 });
      expect(retries[1]).toEqual({ attempt: 2, maxRetries: 3, delayMs: 20 });
      expect(events).toContainEqual({ type: "text_delta", text: "Success" });
      expect(reader.completed).toBe(true);
    });

    it("emits max retries exceeded error when all retries fail", async () => {
      const client = createMockClient(async function* () {
        yield { type: "error" as const, error: "503 Service Unavailable" };
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 2,
        retryDelayMs: 10,
      });

      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      // 3 individual 503 errors (attempt 0, 1, 2) + 1 max retries error
      expect(errors.length).toBe(4);
      // Individual transient errors are emitted
      expect(errors[0]).toEqual({ type: "error", error: "503 Service Unavailable" });
      // Final error indicates retries exhausted
      const lastError = errors[errors.length - 1];
      expect(lastError.type).toBe("error");
      expect((lastError as any).error).toContain("Max retries (2) exceeded");
      expect(reader.completed).toBe(true);
    });

    it("throws if start() is called twice", async () => {
      const client = createMockClient(
        mockSendMessage([{ type: "done" }]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi");
      await reader.start();

      await expect(reader.start()).rejects.toThrow(
        "SessionOutputReader has already been started",
      );
    });

    it("handles abort signal before start", async () => {
      const controller = new AbortController();
      controller.abort();

      const client = createMockClient(mockSendMessage([]));
      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        signal: controller.signal,
      });

      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      expect(errors).toEqual([{ type: "error", error: "Stream aborted" }]);
      expect(reader.completed).toBe(true);
    });

    it("handles abort signal during stream", async () => {
      const controller = new AbortController();
      let yieldCount = 0;

      const client = createMockClient(async function* () {
        yield { type: "text_delta" as const, text: "First" };
        yieldCount++;
        controller.abort();
        // The client's sendMessage checks abort and yields error
        yield { type: "error" as const, error: "Stream aborted" };
        yieldCount++;
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        signal: controller.signal,
      });

      const events: AgentStreamEvent[] = [];
      reader.on("text_delta", (e) => events.push(e));
      reader.on("error", (e) => events.push(e));

      await reader.start();

      expect(events[0]).toEqual({ type: "text_delta", text: "First" });
      expect(reader.completed).toBe(true);
    });

    it("handles exceptions thrown by sendMessage", async () => {
      const client = createMockClient(async function* () {
        throw new Error("Unexpected crash");
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 0,
      });

      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      expect(errors).toEqual([{ type: "error", error: "Unexpected crash" }]);
      expect(reader.completed).toBe(true);
    });

    it("retries on transient exceptions thrown by sendMessage", async () => {
      let callCount = 0;

      const client = createMockClient(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error("ECONNRESET");
        }
        yield { type: "text_delta" as const, text: "Recovered" };
        yield { type: "done" as const };
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 2,
        retryDelayMs: 10,
      });

      const events: AgentStreamEvent[] = [];
      reader.on("text_delta", (e) => events.push(e));
      reader.on("done", (e) => events.push(e));

      await reader.start();

      expect(callCount).toBe(2);
      expect(events).toContainEqual({ type: "text_delta", text: "Recovered" });
    });
  });

  describe("async iterable interface", () => {
    it("yields all events via for-await-of", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "status", status: "running" },
          { type: "text_delta", text: "Hello" },
          { type: "done", stopReason: "end_turn" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi");
      const events: AgentStreamEvent[] = [];

      for await (const event of reader) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "status", status: "running" },
        { type: "text_delta", text: "Hello" },
        { type: "done", stopReason: "end_turn" },
      ]);
    });

    it("stops iteration on error event", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "text_delta", text: "Before error" },
          { type: "error", error: "Something broke" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 0,
      });
      const events: AgentStreamEvent[] = [];

      for await (const event of reader) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "text_delta", text: "Before error" },
        { type: "error", error: "Something broke" },
      ]);
    });

    it("works with retries via EventEmitter", async () => {
      let callCount = 0;

      const client = createMockClient(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: "error" as const, error: "Network error" };
          return;
        }
        yield { type: "text_delta" as const, text: "After retry" };
        yield { type: "done" as const };
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 2,
        retryDelayMs: 10,
      });

      const events: AgentStreamEvent[] = [];
      reader.on("error", (e) => events.push(e));
      reader.on("text_delta", (e) => events.push(e));
      reader.on("done", (e) => events.push(e));

      await reader.start();

      // The transient error is emitted, then retry happens, then success
      expect(events).toContainEqual({ type: "error", error: "Network error" });
      expect(events).toContainEqual({ type: "text_delta", text: "After retry" });
      expect(callCount).toBe(2);
    });
  });

  describe("options defaults", () => {
    it("uses default options when none provided", async () => {
      const client = createMockClient(
        mockSendMessage([{ type: "done" }]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi");
      const events: AgentStreamEvent[] = [];

      for await (const event of reader) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "done" }]);
      expect(reader.completed).toBe(true);
      expect(reader.attempts).toBe(1);
    });
  });

  describe("raw events", () => {
    it("passes emitRawEvents option to client.sendMessage", async () => {
      const sendMessageSpy = vi.fn(async function* (
        _sid: string,
        _text: string,
        opts?: any,
      ) {
        expect(opts?.emitRawEvents).toBe(true);
        yield { type: "done" as const };
      });

      const client = createMockClient(sendMessageSpy);
      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        emitRawEvents: true,
      });

      await reader.start();

      expect(sendMessageSpy).toHaveBeenCalledWith("sesn_1", "Hi", {
        emitRawEvents: true,
        signal: undefined,
      });
    });
  });

  describe("stream consumption edge cases", () => {
    it("handles an empty stream that ends without done event", async () => {
      // sendMessage yields nothing — stream ends normally without explicit done
      const client = createMockClient(async function* () {
        // yields nothing
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi");
      const events: AgentStreamEvent[] = [];
      reader.on("done", (e) => events.push(e));
      reader.on("error", (e) => events.push(e));

      await reader.start();

      // Should complete gracefully without errors
      expect(reader.completed).toBe(true);
      expect(events).toHaveLength(0);
    });

    it("handles non-Error objects thrown by sendMessage", async () => {
      const client = createMockClient(async function* () {
        throw "string error thrown";
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 0,
      });

      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      expect(errors).toEqual([{ type: "error", error: "string error thrown" }]);
      expect(reader.completed).toBe(true);
    });

    it("passes abort signal to client.sendMessage", async () => {
      const controller = new AbortController();
      const sendMessageSpy = vi.fn(async function* (
        _sid: string,
        _text: string,
        opts?: any,
      ) {
        expect(opts?.signal).toBe(controller.signal);
        yield { type: "done" as const };
      });

      const client = createMockClient(sendMessageSpy);
      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        signal: controller.signal,
      });

      await reader.start();

      expect(sendMessageSpy).toHaveBeenCalledWith("sesn_1", "Hi", {
        emitRawEvents: false,
        signal: controller.signal,
      });
    });

    it("handles abort during retry delay", async () => {
      const controller = new AbortController();
      let callCount = 0;

      const client = createMockClient(async function* () {
        callCount++;
        if (callCount === 1) {
          // Abort during the retry delay
          setTimeout(() => controller.abort(), 5);
          yield { type: "error" as const, error: "503 Service Unavailable" };
          return;
        }
        // Should not reach here
        yield { type: "text_delta" as const, text: "Should not see this" };
        yield { type: "done" as const };
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 3,
        retryDelayMs: 50, // long enough for abort to fire
        signal: controller.signal,
      });

      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      expect(reader.completed).toBe(true);
      // Should have aborted rather than continuing with more retries
      const lastError = errors[errors.length - 1];
      expect((lastError as any).error).toContain("aborted");
    });

    it("handles maxRetries=0 with transient exception (no retries)", async () => {
      const client = createMockClient(async function* () {
        throw new Error("ECONNRESET");
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 0,
      });

      const errors: AgentStreamEvent[] = [];
      reader.on("error", (e) => errors.push(e));

      await reader.start();

      // With maxRetries=0, a transient exception should still fail
      expect(errors).toHaveLength(1);
      expect((errors[0] as any).error).toContain("ECONNRESET");
      expect(reader.completed).toBe(true);
      expect(reader.attempts).toBe(1);
    });
  });

  describe("async iterable edge cases", () => {
    it("stops async iteration on first error event (even if transient)", async () => {
      let callCount = 0;

      const client = createMockClient(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: "error" as const, error: "Network error" };
          return;
        }
        yield { type: "text_delta" as const, text: "Success after retry" };
        yield { type: "done" as const };
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 2,
        retryDelayMs: 10,
      });

      const events: AgentStreamEvent[] = [];
      for await (const event of reader) {
        events.push(event);
      }

      // Async iterable terminates on error event — it does NOT follow retries
      // Use EventEmitter interface (start()) for retry-aware consumption
      expect(events).toEqual([{ type: "error", error: "Network error" }]);
    });

    it("can early-break from for-await-of", async () => {
      const client = createMockClient(
        mockSendMessage([
          { type: "text_delta", text: "First" },
          { type: "text_delta", text: "Second" },
          { type: "text_delta", text: "Third" },
          { type: "done" },
        ]),
      );

      const reader = new SessionOutputReader(client, "sesn_1", "Hi");
      const events: AgentStreamEvent[] = [];

      for await (const event of reader) {
        events.push(event);
        if (events.length === 2) break;
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "text_delta", text: "First" });
      expect(events[1]).toEqual({ type: "text_delta", text: "Second" });
    });

    it("handles exception in async iterable from sendMessage", async () => {
      const client = createMockClient(async function* () {
        yield { type: "text_delta" as const, text: "Before crash" };
        throw new Error("Unexpected failure");
      });

      const reader = new SessionOutputReader(client, "sesn_1", "Hi", {
        maxRetries: 0,
      });

      const events: AgentStreamEvent[] = [];
      for await (const event of reader) {
        events.push(event);
      }

      expect(events[0]).toEqual({ type: "text_delta", text: "Before crash" });
      // Should end with error event
      expect(events[events.length - 1].type).toBe("error");
      expect((events[events.length - 1] as any).error).toBe("Unexpected failure");
    });
  });

  describe("constructor state", () => {
    it("initial state: completed=false, attempts=0", () => {
      const client = createMockClient(mockSendMessage([{ type: "done" }]));
      const reader = new SessionOutputReader(client, "sesn_1", "Hi");

      expect(reader.completed).toBe(false);
      expect(reader.attempts).toBe(0);
    });
  });
});
