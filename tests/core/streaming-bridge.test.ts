import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamingBridge } from "../../src/core/streaming-bridge.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { ChannelAdapter, ChannelMessage, StreamHandle } from "../../src/core/channel-adapter.js";
import type { AgentClient } from "../../src/core/agent-client.js";
import type { BridgePhase } from "../../src/core/streaming-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "msg-1",
    channelId: "C123",
    threadId: "thread-1",
    userId: "U456",
    text: "Hello agent",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

function makeMockStreamHandle(): StreamHandle & {
  updateCalls: string[];
  finishCalls: string[];
} {
  const handle = {
    updateCalls: [] as string[],
    finishCalls: [] as string[],
    update: vi.fn().mockImplementation(async (text: string) => {
      handle.updateCalls.push(text);
    }),
    finish: vi.fn().mockImplementation(async (text: string) => {
      handle.finishCalls.push(text);
    }),
  };
  return handle;
}

function makeMockAdapter(streamHandle?: StreamHandle): ChannelAdapter {
  const handle = streamHandle ?? makeMockStreamHandle();
  return {
    name: "test",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    startStream: vi.fn().mockResolvedValue(handle),
  };
}

function makeMockAgentClient(opts: {
  sessionId?: string;
  events?: Array<{ type: string; [k: string]: any }>;
  createSessionError?: Error;
} = {}): AgentClient {
  const sessionId = opts.sessionId ?? "session-1";
  const events = opts.events ?? [
    { type: "text_delta", text: "Hello " },
    { type: "text_delta", text: "world!" },
    { type: "done" },
  ];

  return {
    createSession: opts.createSessionError
      ? vi.fn().mockRejectedValue(opts.createSessionError)
      : vi.fn().mockResolvedValue(sessionId),
    sendMessage: vi.fn().mockImplementation(async function* () {
      for (const event of events) {
        yield event;
      }
    }),
    getAgentId: vi.fn().mockReturnValue("agent-1"),
    getEnvironmentId: vi.fn().mockReturnValue("env-1"),
  } as unknown as AgentClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamingBridge", () => {
  let adapter: ChannelAdapter;
  let agentClient: AgentClient;
  let sessionManager: SessionManager;
  let streamHandle: ReturnType<typeof makeMockStreamHandle>;

  beforeEach(() => {
    streamHandle = makeMockStreamHandle();
    adapter = makeMockAdapter(streamHandle);
    agentClient = makeMockAgentClient();
    sessionManager = new SessionManager();
  });

  function createBridge(overrides: Partial<Parameters<typeof StreamingBridge>[0] extends never ? Record<string, any> : Record<string, any>> = {}) {
    return new StreamingBridge({
      adapter,
      agentClient,
      sessionManager,
      ...overrides,
    } as any);
  }

  // --- Session lifecycle ---

  describe("session management", () => {
    it("creates a new session for the first message in a thread", async () => {
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.sessionCreated).toBe(true);
      expect(result.sessionId).toBe("session-1");
      expect(result.success).toBe(true);
      expect(agentClient.createSession).toHaveBeenCalledTimes(1);
    });

    it("reuses an existing session for subsequent messages", async () => {
      sessionManager.setSession("test", "C123", "thread-1", "existing-session");
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.sessionCreated).toBe(false);
      expect(result.sessionId).toBe("existing-session");
      expect(result.success).toBe(true);
      expect(agentClient.createSession).not.toHaveBeenCalled();
    });

    it("stores session ID in session manager after creation", async () => {
      const bridge = createBridge();
      await bridge.handleMessage(makeMessage());

      expect(sessionManager.getSession("test", "C123", "thread-1")).toBe("session-1");
    });

    it("reports error when session creation fails", async () => {
      agentClient = makeMockAgentClient({
        createSessionError: new Error("API rate limited"),
      });
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Session creation failed");
      expect(result.error).toContain("API rate limited");
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        "C123",
        "thread-1",
        expect.stringContaining("API rate limited"),
      );
    });
  });

  // --- Streaming lifecycle ---

  describe("streaming lifecycle", () => {
    it("starts a stream and finishes with accumulated text", async () => {
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(true);
      expect(result.totalChars).toBe(12); // "Hello world!"
      expect(adapter.startStream).toHaveBeenCalledWith("C123", "thread-1");
      expect(streamHandle.finishCalls.length).toBe(1);
      expect(streamHandle.finishCalls[0]).toBe("Hello world!");
    });

    it("sends empty response text when agent produces no output", async () => {
      agentClient = makeMockAgentClient({ events: [{ type: "done" }] });
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(true);
      expect(streamHandle.finishCalls[0]).toBe(
        "I received your message but had no response.",
      );
    });

    it("uses custom empty response text when configured", async () => {
      agentClient = makeMockAgentClient({ events: [{ type: "done" }] });
      const bridge = createBridge({ emptyResponseText: "No output." });
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(true);
      expect(streamHandle.finishCalls[0]).toBe("No output.");
    });

    it("reports error when stream start fails", async () => {
      (adapter.startStream as any).mockRejectedValue(new Error("Slack API down"));
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Stream start failed");
      expect(adapter.sendMessage).toHaveBeenCalled();
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("finishes stream with error message when agent emits error", async () => {
      agentClient = makeMockAgentClient({
        events: [
          { type: "text_delta", text: "partial" },
          { type: "error", error: "Internal server error" },
        ],
      });
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(false);
      expect(result.error).toBe("Internal server error");
      // Stream should be finalized with error text
      expect(streamHandle.finishCalls.length).toBe(1);
      expect(streamHandle.finishCalls[0]).toContain("Internal server error");
    });

    it("uses custom error formatter", async () => {
      agentClient = makeMockAgentClient({
        createSessionError: new Error("Bad request"),
      });
      const bridge = createBridge({
        formatError: (err: string) => `Custom: ${err}`,
      });
      await bridge.handleMessage(makeMessage());

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        "C123",
        "thread-1",
        "Custom: Bad request",
      );
    });

    it("always finalizes stream handle even on unexpected errors", async () => {
      // Make sendMessage throw mid-stream
      (agentClient.sendMessage as any).mockImplementation(async function* () {
        yield { type: "text_delta", text: "start" };
        throw new Error("Unexpected failure");
      });
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unexpected failure");
      // Stream handle must have been finalized
      expect(streamHandle.finish).toHaveBeenCalled();
    });

    it("skips empty messages", async () => {
      const bridge = createBridge();
      const result = await bridge.handleMessage(makeMessage({ text: "   " }));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Empty message");
      expect(agentClient.createSession).not.toHaveBeenCalled();
    });
  });

  // --- Thread concurrency ---

  describe("thread concurrency", () => {
    it("rejects concurrent handling of the same thread", async () => {
      let resolveStream!: () => void;
      const streamPromise = new Promise<void>((r) => { resolveStream = r; });

      agentClient = {
        createSession: vi.fn().mockResolvedValue("session-1"),
        sendMessage: vi.fn().mockImplementation(async function* () {
          await streamPromise;
          yield { type: "done" };
        }),
        getAgentId: vi.fn().mockReturnValue("agent-1"),
        getEnvironmentId: vi.fn().mockReturnValue("env-1"),
      } as unknown as AgentClient;

      const bridge = createBridge();
      const message = makeMessage();

      const first = bridge.handleMessage(message);
      // Give first message a tick to register as active
      await new Promise((r) => setTimeout(r, 10));

      const second = await bridge.handleMessage(message);
      expect(second.success).toBe(false);
      expect(second.error).toContain("already being processed");

      resolveStream();
      await first;
    });

    it("allows concurrent handling of different threads", async () => {
      const bridge = createBridge();
      const msg1 = makeMessage({ threadId: "thread-1" });
      const msg2 = makeMessage({ threadId: "thread-2" });

      const [r1, r2] = await Promise.all([
        bridge.handleMessage(msg1),
        bridge.handleMessage(msg2),
      ]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });

    it("cleans up active thread tracking after completion", async () => {
      let resolveStream!: () => void;
      const streamPromise = new Promise<void>((r) => { resolveStream = r; });

      agentClient = {
        createSession: vi.fn().mockResolvedValue("session-1"),
        sendMessage: vi.fn().mockImplementation(async function* () {
          await streamPromise;
          yield { type: "done" };
        }),
        getAgentId: vi.fn().mockReturnValue("agent-1"),
        getEnvironmentId: vi.fn().mockReturnValue("env-1"),
      } as unknown as AgentClient;

      const bridge = createBridge();
      const message = makeMessage();
      const promise = bridge.handleMessage(message);

      await new Promise((r) => setTimeout(r, 10));
      expect(bridge.isThreadActive("C123", "thread-1")).toBe(true);
      expect(bridge.activeThreadCount).toBe(1);

      resolveStream();
      await promise;

      expect(bridge.isThreadActive("C123", "thread-1")).toBe(false);
      expect(bridge.activeThreadCount).toBe(0);
    });
  });

  // --- Abort support ---

  describe("abort support", () => {
    it("aborts a specific active thread", async () => {
      let resolveStream!: () => void;
      const streamPromise = new Promise<void>((r) => { resolveStream = r; });

      agentClient = {
        createSession: vi.fn().mockResolvedValue("session-1"),
        sendMessage: vi.fn().mockImplementation(async function* () {
          await streamPromise;
          yield { type: "done" };
        }),
        getAgentId: vi.fn().mockReturnValue("agent-1"),
        getEnvironmentId: vi.fn().mockReturnValue("env-1"),
      } as unknown as AgentClient;

      const bridge = createBridge();
      const promise = bridge.handleMessage(makeMessage());

      await new Promise((r) => setTimeout(r, 10));
      const aborted = bridge.abortThread("C123", "thread-1");
      expect(aborted).toBe(true);

      resolveStream();
      const result = await promise;
      // Result may succeed or fail depending on timing, but should complete
      expect(result).toBeDefined();
    });

    it("returns false when aborting a non-active thread", () => {
      const bridge = createBridge();
      expect(bridge.abortThread("C123", "thread-1")).toBe(false);
    });

    it("abortAll cancels all active threads", async () => {
      let resolveStream1!: () => void;
      let resolveStream2!: () => void;

      let callCount = 0;
      agentClient = {
        createSession: vi.fn().mockResolvedValue("session-1"),
        sendMessage: vi.fn().mockImplementation(async function* () {
          callCount++;
          if (callCount === 1) {
            await new Promise<void>((r) => { resolveStream1 = r; });
          } else {
            await new Promise<void>((r) => { resolveStream2 = r; });
          }
          yield { type: "done" };
        }),
        getAgentId: vi.fn().mockReturnValue("agent-1"),
        getEnvironmentId: vi.fn().mockReturnValue("env-1"),
      } as unknown as AgentClient;

      const bridge = createBridge();
      const p1 = bridge.handleMessage(makeMessage({ threadId: "t1" }));
      const p2 = bridge.handleMessage(makeMessage({ threadId: "t2" }));

      await new Promise((r) => setTimeout(r, 10));
      const count = bridge.abortAll();
      expect(count).toBe(2);

      resolveStream1();
      resolveStream2();
      await Promise.all([p1, p2]);
      expect(bridge.activeThreadCount).toBe(0);
    });
  });

  // --- Lifecycle phases ---

  describe("lifecycle phase tracking", () => {
    it("emits phase changes throughout the lifecycle", async () => {
      const phases: Array<{ phase: BridgePhase; detail?: string }> = [];
      const bridge = createBridge();
      bridge.onPhaseChange((_key, phase, detail) => {
        phases.push({ phase, detail });
      });

      await bridge.handleMessage(makeMessage());

      const phaseNames = phases.map((p) => p.phase);
      expect(phaseNames).toContain("session_resolve");
      expect(phaseNames).toContain("stream_start");
      expect(phaseNames).toContain("streaming");
      expect(phaseNames).toContain("completing");
      expect(phaseNames).toContain("cleanup");
    });

    it("emits error phase on session creation failure", async () => {
      const phases: Array<{ phase: BridgePhase; detail?: string }> = [];
      agentClient = makeMockAgentClient({
        createSessionError: new Error("fail"),
      });
      const bridge = createBridge();
      bridge.onPhaseChange((_key, phase, detail) => {
        phases.push({ phase, detail });
      });

      await bridge.handleMessage(makeMessage());

      expect(phases.some((p) => p.phase === "error" && p.detail === "session_creation_failed")).toBe(true);
    });

    it("emits error phase on stream error", async () => {
      const phases: Array<{ phase: BridgePhase; detail?: string }> = [];
      agentClient = makeMockAgentClient({
        events: [{ type: "error", error: "boom" }],
      });
      const bridge = createBridge();
      bridge.onPhaseChange((_key, phase, detail) => {
        phases.push({ phase, detail });
      });

      await bridge.handleMessage(makeMessage());

      expect(phases.some((p) => p.phase === "error")).toBe(true);
    });
  });

  // --- Throttled updates ---

  describe("throttled streaming updates", () => {
    it("sends updates when text exceeds threshold", async () => {
      // Generate enough text to trigger updates
      const longText = "x".repeat(200);
      agentClient = makeMockAgentClient({
        events: [
          { type: "text_delta", text: longText },
          { type: "done" },
        ],
      });

      const bridge = createBridge({ updateThreshold: 50 });
      const result = await bridge.handleMessage(makeMessage());

      expect(result.success).toBe(true);
      expect(result.totalChars).toBe(200);
      // finish should be called with full text
      expect(streamHandle.finishCalls[0]).toBe(longText);
    });
  });
});
