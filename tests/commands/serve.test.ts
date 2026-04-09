import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ChannelAdapter,
  ChannelMessage,
  StreamHandle,
} from "../../src/core/channel-adapter.js";
import type { AgentStreamEvent } from "../../src/core/agent-client.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { handleMessage } from "../../src/commands/serve.js";

// ─── Test Helpers ───

function createMockAdapter(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  return {
    name: "slack",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    startStream: vi.fn().mockResolvedValue({
      update: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  };
}

function defaultSendMessage(): (sessionId: string, text: string) => AsyncGenerator<AgentStreamEvent> {
  return async function* () {
    yield { type: "text_delta" as const, text: "Hello " };
    yield { type: "text_delta" as const, text: "world!" };
    yield { type: "done" as const };
  };
}

function createMockAgentClient(overrides?: {
  createSession?: ReturnType<typeof vi.fn>;
  sendMessage?: (sessionId: string, text: string) => AsyncGenerator<AgentStreamEvent>;
}) {
  const sendMessageImpl = overrides?.sendMessage ?? defaultSendMessage();
  return {
    createSession: overrides?.createSession ?? vi.fn().mockResolvedValue("session-001"),
    sendMessage: vi.fn().mockImplementation(sendMessageImpl),
  } as any;
}

function createMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: "msg-001",
    channelId: "C123",
    threadId: "thread-001",
    userId: "U456",
    text: "Hello agent",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

// ─── Tests ───

describe("handleMessage", () => {
  let adapter: ChannelAdapter;
  let sessionManager: SessionManager;
  let mockStream: StreamHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockStream = {
      update: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    };

    adapter = createMockAdapter({
      startStream: vi.fn().mockResolvedValue(mockStream),
    });

    sessionManager = new SessionManager();
  });

  describe("message filtering", () => {
    it("ignores empty text messages", async () => {
      const agentClient = createMockAgentClient();
      const message = createMessage({ text: "" });

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(agentClient.createSession).not.toHaveBeenCalled();
      expect(adapter.startStream).not.toHaveBeenCalled();
    });

    it("ignores whitespace-only messages", async () => {
      const agentClient = createMockAgentClient();
      const message = createMessage({ text: "   \n\t  " });

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(agentClient.createSession).not.toHaveBeenCalled();
    });
  });

  describe("session management", () => {
    it("creates a new session for a new thread", async () => {
      const agentClient = createMockAgentClient();
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(agentClient.createSession).toHaveBeenCalledTimes(1);
      expect(sessionManager.getSession("slack", "C123", "thread-001")).toBe("session-001");
    });

    it("reuses an existing session for the same thread", async () => {
      sessionManager.setSession("slack", "C123", "thread-001", "existing-session");
      const agentClient = createMockAgentClient();
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(agentClient.createSession).not.toHaveBeenCalled();
      // sendMessage should use the existing session
      expect(agentClient.sendMessage).toHaveBeenCalledWith("existing-session", "Hello agent", expect.any(Object));
    });

    it("sends error message to Slack when session creation fails", async () => {
      const agentClient = createMockAgentClient({
        createSession: vi.fn().mockRejectedValue(new Error("API down")),
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        "C123",
        "thread-001",
        expect.stringContaining("API down"),
      );
      // Should NOT start streaming
      expect(adapter.startStream).not.toHaveBeenCalled();
    });

    it("does not store session when creation fails", async () => {
      const agentClient = createMockAgentClient({
        createSession: vi.fn().mockRejectedValue(new Error("API down")),
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(sessionManager.hasSession("slack", "C123", "thread-001")).toBe(false);
    });

    it("creates separate sessions for different threads", async () => {
      let callCount = 0;
      const agentClient = createMockAgentClient({
        createSession: vi.fn().mockImplementation(async () => `session-${++callCount}`),
      });

      await handleMessage(adapter, agentClient, sessionManager, createMessage({ threadId: "thread-A" }));
      await handleMessage(adapter, agentClient, sessionManager, createMessage({ threadId: "thread-B" }));

      expect(sessionManager.getSession("slack", "C123", "thread-A")).toBe("session-1");
      expect(sessionManager.getSession("slack", "C123", "thread-B")).toBe("session-2");
    });
  });

  describe("message forwarding to agent", () => {
    it("sends the message text to the agent client with the correct session", async () => {
      const agentClient = createMockAgentClient();
      const message = createMessage({ text: "What is TypeScript?" });

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(agentClient.sendMessage).toHaveBeenCalledWith("session-001", "What is TypeScript?", expect.any(Object));
    });

    it("starts a stream in the correct channel and thread", async () => {
      const agentClient = createMockAgentClient();
      const message = createMessage({ channelId: "C999", threadId: "thread-XYZ" });

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(adapter.startStream).toHaveBeenCalledWith("C999", "thread-XYZ");
    });
  });

  describe("response streaming back to Slack", () => {
    it("concatenates text_delta events and finishes with full text", async () => {
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          yield { type: "text_delta", text: "Hello " };
          yield { type: "text_delta", text: "world!" };
          yield { type: "done" };
        },
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(mockStream.finish).toHaveBeenCalledWith("Hello world!");
    });

    it("sends fallback message when agent returns no text", async () => {
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          yield { type: "done" };
        },
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(mockStream.finish).toHaveBeenCalledWith(
        "I received your message but had no response.",
      );
    });

    it("throttles stream updates to avoid rate limits", async () => {
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          // Each chunk is 10 chars, need 10 chunks to hit 100-char threshold
          for (let i = 0; i < 15; i++) {
            yield { type: "text_delta", text: "0123456789" };
          }
          yield { type: "done" };
        },
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      // 150 chars total. Updates at 100 chars, then finish at end.
      // update calls should be limited (not every chunk triggers an update)
      const updateCalls = (mockStream.update as ReturnType<typeof vi.fn>).mock.calls;
      expect(updateCalls.length).toBeLessThan(15); // Not every chunk
      expect(updateCalls.length).toBeGreaterThanOrEqual(1); // At least one intermediate update
      expect(mockStream.finish).toHaveBeenCalledTimes(1);
    });

    it("handles agent error events by finishing with error message", async () => {
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          yield { type: "text_delta", text: "Starting..." };
          yield { type: "error", error: "Context window exceeded" };
        },
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(mockStream.finish).toHaveBeenCalledWith(expect.stringContaining("Context window exceeded"));
    });

    it("ignores non-text events (thinking, tool_use, status)", async () => {
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          yield { type: "thinking" };
          yield { type: "text_delta", text: "Hello" };
          yield { type: "tool_use", name: "search", input: {} };
          yield { type: "status", status: "running" };
          yield { type: "text_delta", text: " there" };
          yield { type: "done" };
        },
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(mockStream.finish).toHaveBeenCalledWith("Hello there");
    });
  });

  describe("error handling", () => {
    it("finishes stream with error message when agent throws", async () => {
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          throw new Error("Invalid request payload");
        },
      });
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(mockStream.finish).toHaveBeenCalledWith(
        expect.stringContaining("Invalid request payload"),
      );
    });

    it("falls back to sendMessage when stream setup fails", async () => {
      adapter = createMockAdapter({
        startStream: vi.fn().mockRejectedValue(new Error("Stream API unavailable")),
      });
      const agentClient = createMockAgentClient();
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        "C123",
        "thread-001",
        expect.stringContaining("Stream API unavailable"),
      );
    });

    it("does not throw when stream finish fails during error recovery", async () => {
      const failingStream: StreamHandle = {
        update: vi.fn().mockResolvedValue(undefined),
        finish: vi.fn().mockRejectedValue(new Error("Stream already closed")),
      };
      adapter = createMockAdapter({
        startStream: vi.fn().mockResolvedValue(failingStream),
      });
      const agentClient = createMockAgentClient({
        sendMessage: async function* () {
          throw new Error("Agent crashed");
        },
      });
      const message = createMessage();

      // Should not throw
      await expect(
        handleMessage(adapter, agentClient, sessionManager, message),
      ).resolves.toBeUndefined();
    });
  });

  describe("thread-to-session mapping correctness", () => {
    it("maps same channel+thread to same session across multiple messages", async () => {
      const agentClient = createMockAgentClient();

      // First message creates the session
      await handleMessage(adapter, agentClient, sessionManager, createMessage());
      // Second message in the same thread reuses it
      await handleMessage(adapter, agentClient, sessionManager, createMessage({ text: "Follow-up" }));

      expect(agentClient.createSession).toHaveBeenCalledTimes(1);
      expect(agentClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(agentClient.sendMessage).toHaveBeenNthCalledWith(1, "session-001", "Hello agent", expect.any(Object));
      expect(agentClient.sendMessage).toHaveBeenNthCalledWith(2, "session-001", "Follow-up", expect.any(Object));
    });

    it("uses adapter.name as channel type for session key", async () => {
      const agentClient = createMockAgentClient();
      const message = createMessage();

      await handleMessage(adapter, agentClient, sessionManager, message);

      // Verify the session is keyed by adapter.name
      expect(sessionManager.getSession("slack", "C123", "thread-001")).toBe("session-001");
      // A different channel type would not find the session
      expect(sessionManager.getSession("discord", "C123", "thread-001")).toBeUndefined();
    });

    it("thread messages reuse the same session while new threads create new sessions", async () => {
      let callCount = 0;
      const agentClient = createMockAgentClient({
        createSession: vi.fn().mockImplementation(async () => `session-${++callCount}`),
      });

      // Thread A: first message creates session-1
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        threadId: "thread-A", text: "msg1",
      }));
      expect(agentClient.createSession).toHaveBeenCalledTimes(1);
      expect(agentClient.sendMessage).toHaveBeenLastCalledWith("session-1", "msg1", expect.any(Object));

      // Thread A: second message reuses session-1 (no new session created)
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        threadId: "thread-A", text: "msg2",
      }));
      expect(agentClient.createSession).toHaveBeenCalledTimes(1); // Still 1
      expect(agentClient.sendMessage).toHaveBeenLastCalledWith("session-1", "msg2", expect.any(Object));

      // Thread B: first message creates session-2
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        threadId: "thread-B", text: "msg3",
      }));
      expect(agentClient.createSession).toHaveBeenCalledTimes(2);
      expect(agentClient.sendMessage).toHaveBeenLastCalledWith("session-2", "msg3", expect.any(Object));

      // Thread A: third message still reuses session-1
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        threadId: "thread-A", text: "msg4",
      }));
      expect(agentClient.createSession).toHaveBeenCalledTimes(2); // Still 2
      expect(agentClient.sendMessage).toHaveBeenLastCalledWith("session-1", "msg4", expect.any(Object));

      // Thread B: second message reuses session-2
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        threadId: "thread-B", text: "msg5",
      }));
      expect(agentClient.createSession).toHaveBeenCalledTimes(2); // Still 2
      expect(agentClient.sendMessage).toHaveBeenLastCalledWith("session-2", "msg5", expect.any(Object));

      // Thread C: creates session-3
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        threadId: "thread-C", text: "msg6",
      }));
      expect(agentClient.createSession).toHaveBeenCalledTimes(3);
      expect(agentClient.sendMessage).toHaveBeenLastCalledWith("session-3", "msg6", expect.any(Object));
    });

    it("threads in different channels get separate sessions even with same threadId", async () => {
      let callCount = 0;
      const agentClient = createMockAgentClient({
        createSession: vi.fn().mockImplementation(async () => `session-${++callCount}`),
      });

      // Same threadId but in channel C100
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        channelId: "C100", threadId: "thread-X", text: "hello",
      }));
      // Same threadId but in channel C200
      await handleMessage(adapter, agentClient, sessionManager, createMessage({
        channelId: "C200", threadId: "thread-X", text: "hello",
      }));

      expect(agentClient.createSession).toHaveBeenCalledTimes(2);
      expect(sessionManager.getSession("slack", "C100", "thread-X")).toBe("session-1");
      expect(sessionManager.getSession("slack", "C200", "thread-X")).toBe("session-2");
    });

    it("many sequential messages in a single thread only create one session", async () => {
      const agentClient = createMockAgentClient();

      for (let i = 0; i < 10; i++) {
        await handleMessage(adapter, agentClient, sessionManager, createMessage({
          threadId: "thread-busy", text: `message ${i}`,
        }));
      }

      expect(agentClient.createSession).toHaveBeenCalledTimes(1);
      expect(agentClient.sendMessage).toHaveBeenCalledTimes(10);
      // Every call used the same session
      for (const call of (agentClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls) {
        expect(call[0]).toBe("session-001");
      }
    });
  });
});
