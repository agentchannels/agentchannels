/**
 * Integration test skeleton for end-to-end flow.
 *
 * These tests exercise the full message lifecycle using mocked external
 * dependencies (Slack API and Anthropic API). They verify that the
 * components wire together correctly:
 *
 *   Slack message → ChannelAdapter → SessionManager → AgentClient → stream back to Slack
 *
 * No real network calls are made — both the Slack adapter and the Anthropic
 * agent client are replaced with in-memory fakes that implement the same
 * interfaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ChannelAdapter,
  ChannelMessage,
  MessageHandler,
  StreamHandle,
} from "../../src/core/channel-adapter.js";
import type { AgentStreamEvent } from "../../src/core/agent-client.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { handleMessage } from "../../src/commands/serve.js";

// ─── Fake Adapter ─────────────────────────────────────────────────────────
// An in-memory ChannelAdapter that lets tests simulate inbound messages and
// inspect outbound messages/streams without any Slack dependency.

interface FakeStreamHandle extends StreamHandle {
  /** All texts passed to update(), in order */
  updates: string[];
  /** The final text passed to finish() */
  finalText: string | undefined;
}

class FakeAdapter implements ChannelAdapter {
  readonly name = "slack";
  private handlers: MessageHandler[] = [];

  /** Outbound simple messages: { channelId, threadId, text }[] */
  sentMessages: Array<{ channelId: string; threadId: string; text: string }> = [];
  /** Outbound streams, keyed by "channelId:threadId" */
  streams = new Map<string, FakeStreamHandle>();

  async connect(): Promise<void> {
    /* no-op for tests */
  }

  async disconnect(): Promise<void> {
    /* no-op for tests */
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendMessage(channelId: string, threadId: string, text: string): Promise<void> {
    this.sentMessages.push({ channelId, threadId, text });
  }

  async startStream(channelId: string, threadId: string): Promise<StreamHandle> {
    const handle: FakeStreamHandle = {
      updates: [],
      finalText: undefined,
      update: async (text: string) => {
        handle.updates.push(text);
      },
      finish: async (text: string) => {
        handle.finalText = text;
      },
    };
    this.streams.set(`${channelId}:${threadId}`, handle);
    return handle;
  }

  /** Simulate an incoming message (triggers all registered handlers) */
  async simulateMessage(message: ChannelMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  getStream(channelId: string, threadId: string): FakeStreamHandle | undefined {
    return this.streams.get(`${channelId}:${threadId}`);
  }
}

// ─── Fake Agent Client ────────────────────────────────────────────────────
// Simulates the Anthropic Managed Agent API without network calls.

class FakeAgentClient {
  /** Session counter for auto-generated IDs */
  private sessionCounter = 0;
  /** Map of sessionId → messages received */
  receivedMessages: Map<string, string[]> = new Map();
  /** Canned responses per session (default: a simple greeting) */
  private cannedResponses: Map<string, AgentStreamEvent[]> = new Map();
  /** Default response events if no canned response is set */
  private defaultResponse: AgentStreamEvent[] = [
    { type: "text_delta" as const, text: "Hello from the agent!" },
    { type: "done" as const },
  ];

  async createSession(): Promise<string> {
    const id = `test-session-${++this.sessionCounter}`;
    this.receivedMessages.set(id, []);
    return id;
  }

  async *sendMessage(sessionId: string, text: string): AsyncGenerator<AgentStreamEvent> {
    // Track the message
    const messages = this.receivedMessages.get(sessionId) ?? [];
    messages.push(text);
    this.receivedMessages.set(sessionId, messages);

    // Yield canned or default response
    const events = this.cannedResponses.get(sessionId) ?? this.defaultResponse;
    for (const event of events) {
      yield event;
    }
  }

  /** Set a canned response for a specific session */
  setCannedResponse(sessionId: string, events: AgentStreamEvent[]): void {
    this.cannedResponses.set(sessionId, events);
  }

  /** Set the default response for all sessions without a canned response */
  setDefaultResponse(events: AgentStreamEvent[]): void {
    this.defaultResponse = events;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: "msg-001",
    channelId: "C-general",
    threadId: "thread-100",
    userId: "U-alice",
    text: "What is TypeScript?",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

// ─── Integration Tests ────────────────────────────────────────────────────

describe("End-to-end flow integration", () => {
  let adapter: FakeAdapter;
  let agentClient: FakeAgentClient;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    adapter = new FakeAdapter();
    agentClient = new FakeAgentClient();
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Scenario 1: First mention in a channel creates a new session ──

  describe("new thread creates a new session and streams response", () => {
    it("creates a session, forwards the message to the agent, and streams the response back", async () => {
      const message = makeMessage();

      await handleMessage(adapter, agentClient as any, sessionManager, message);

      // A session was created and stored
      const sessionId = sessionManager.getSession("slack", "C-general", "thread-100");
      expect(sessionId).toBe("test-session-1");

      // The user text was forwarded to the agent
      const received = agentClient.receivedMessages.get("test-session-1");
      expect(received).toEqual(["What is TypeScript?"]);

      // The response was streamed back to the correct channel/thread
      const stream = adapter.getStream("C-general", "thread-100");
      expect(stream).toBeDefined();
      expect(stream!.finalText).toBe("Hello from the agent!");
    });
  });

  // ── Scenario 2: Follow-up messages reuse the same session ──

  describe("multi-turn conversation in the same thread", () => {
    it("reuses the session for follow-up messages in the same thread", async () => {
      const msg1 = makeMessage({ text: "What is TypeScript?" });
      const msg2 = makeMessage({ id: "msg-002", text: "Can you give an example?" });

      await handleMessage(adapter, agentClient as any, sessionManager, msg1);
      await handleMessage(adapter, agentClient as any, sessionManager, msg2);

      // Only one session was created
      expect(sessionManager.size).toBe(1);
      const sessionId = sessionManager.getSession("slack", "C-general", "thread-100");
      expect(sessionId).toBe("test-session-1");

      // Both messages were sent to the same session
      const received = agentClient.receivedMessages.get("test-session-1");
      expect(received).toEqual(["What is TypeScript?", "Can you give an example?"]);
    });
  });

  // ── Scenario 3: Different threads get separate sessions ──

  describe("parallel threads get independent sessions", () => {
    it("creates separate sessions for messages in different threads", async () => {
      const msgThreadA = makeMessage({ threadId: "thread-A", text: "Hello from thread A" });
      const msgThreadB = makeMessage({ threadId: "thread-B", text: "Hello from thread B" });

      await handleMessage(adapter, agentClient as any, sessionManager, msgThreadA);
      await handleMessage(adapter, agentClient as any, sessionManager, msgThreadB);

      expect(sessionManager.size).toBe(2);
      expect(sessionManager.getSession("slack", "C-general", "thread-A")).toBe("test-session-1");
      expect(sessionManager.getSession("slack", "C-general", "thread-B")).toBe("test-session-2");

      // Each session received its own message
      expect(agentClient.receivedMessages.get("test-session-1")).toEqual(["Hello from thread A"]);
      expect(agentClient.receivedMessages.get("test-session-2")).toEqual(["Hello from thread B"]);
    });
  });

  // ── Scenario 4: Different channels with same threadId are isolated ──

  describe("cross-channel session isolation", () => {
    it("threads in different channels produce separate sessions even with the same threadId", async () => {
      const msgChannelA = makeMessage({ channelId: "C-dev", threadId: "thread-X", text: "dev msg" });
      const msgChannelB = makeMessage({ channelId: "C-ops", threadId: "thread-X", text: "ops msg" });

      await handleMessage(adapter, agentClient as any, sessionManager, msgChannelA);
      await handleMessage(adapter, agentClient as any, sessionManager, msgChannelB);

      expect(sessionManager.size).toBe(2);
      expect(sessionManager.getSession("slack", "C-dev", "thread-X")).toBe("test-session-1");
      expect(sessionManager.getSession("slack", "C-ops", "thread-X")).toBe("test-session-2");
    });
  });

  // ── Scenario 5: Streaming response with multiple text deltas ──

  describe("streaming multi-chunk response", () => {
    it("accumulates text deltas and finishes with the complete text", async () => {
      agentClient.setDefaultResponse([
        { type: "text_delta" as const, text: "Type" },
        { type: "text_delta" as const, text: "Script " },
        { type: "text_delta" as const, text: "is a typed " },
        { type: "text_delta" as const, text: "superset of JavaScript." },
        { type: "done" as const },
      ]);

      await handleMessage(adapter, agentClient as any, sessionManager, makeMessage());

      const stream = adapter.getStream("C-general", "thread-100");
      expect(stream).toBeDefined();
      expect(stream!.finalText).toBe("TypeScript is a typed superset of JavaScript.");
    });
  });

  // ── Scenario 6: Agent error event mid-stream ──

  describe("agent error during streaming", () => {
    it("finishes the stream with an error message when the agent emits an error event", async () => {
      agentClient.setDefaultResponse([
        { type: "text_delta" as const, text: "Starting to think..." },
        { type: "error" as const, error: "Context window exceeded" },
      ]);

      await handleMessage(adapter, agentClient as any, sessionManager, makeMessage());

      const stream = adapter.getStream("C-general", "thread-100");
      expect(stream).toBeDefined();
      expect(stream!.finalText).toContain("Context window exceeded");
    });
  });

  // ── Scenario 7: Session creation failure ──

  describe("session creation failure", () => {
    it("sends an error message to Slack when the agent API fails to create a session", async () => {
      const failingClient = {
        createSession: vi.fn().mockRejectedValue(new Error("API unavailable")),
        sendMessage: vi.fn(),
      };

      await handleMessage(adapter, failingClient as any, sessionManager, makeMessage());

      // No session stored
      expect(sessionManager.size).toBe(0);

      // Error message sent via sendMessage (not startStream)
      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]).toEqual({
        channelId: "C-general",
        threadId: "thread-100",
        text: expect.stringContaining("API unavailable"),
      });

      // No stream was started
      expect(adapter.streams.size).toBe(0);
    });
  });

  // ── Scenario 8: Empty messages are ignored ──

  describe("empty message filtering", () => {
    it("does not create a session or contact the agent for empty messages", async () => {
      await handleMessage(adapter, agentClient as any, sessionManager, makeMessage({ text: "" }));
      await handleMessage(adapter, agentClient as any, sessionManager, makeMessage({ text: "   " }));

      expect(sessionManager.size).toBe(0);
      expect(adapter.streams.size).toBe(0);
      expect(adapter.sentMessages).toHaveLength(0);
    });
  });

  // ── Scenario 9: Complex multi-thread interleaving ──

  describe("interleaved multi-thread conversation", () => {
    it("correctly routes interleaved messages from multiple threads", async () => {
      const threads = ["thread-A", "thread-B", "thread-C"];
      const messagesByThread: Record<string, string[]> = {
        "thread-A": ["A1", "A2", "A3"],
        "thread-B": ["B1", "B2"],
        "thread-C": ["C1"],
      };

      // Interleave: A1, B1, A2, C1, B2, A3
      const sequence = [
        { threadId: "thread-A", text: "A1" },
        { threadId: "thread-B", text: "B1" },
        { threadId: "thread-A", text: "A2" },
        { threadId: "thread-C", text: "C1" },
        { threadId: "thread-B", text: "B2" },
        { threadId: "thread-A", text: "A3" },
      ];

      for (const { threadId, text } of sequence) {
        await handleMessage(
          adapter,
          agentClient as any,
          sessionManager,
          makeMessage({ threadId, text }),
        );
      }

      // 3 separate sessions created
      expect(sessionManager.size).toBe(3);

      // Verify each thread's messages went to the correct session
      const sessionA = sessionManager.getSession("slack", "C-general", "thread-A")!;
      const sessionB = sessionManager.getSession("slack", "C-general", "thread-B")!;
      const sessionC = sessionManager.getSession("slack", "C-general", "thread-C")!;

      expect(agentClient.receivedMessages.get(sessionA)).toEqual(["A1", "A2", "A3"]);
      expect(agentClient.receivedMessages.get(sessionB)).toEqual(["B1", "B2"]);
      expect(agentClient.receivedMessages.get(sessionC)).toEqual(["C1"]);
    });
  });

  // ── Scenario 10: DM vs. channel mention both work ──

  describe("DMs and channel mentions", () => {
    it("handles direct messages the same as channel mentions", async () => {
      const channelMsg = makeMessage({
        channelId: "C-public",
        threadId: "thread-mention",
        text: "Help me",
        isMention: true,
        isDirectMessage: false,
      });
      const dmMsg = makeMessage({
        channelId: "D-alice",
        threadId: "thread-dm",
        text: "Help me too",
        isMention: false,
        isDirectMessage: true,
      });

      await handleMessage(adapter, agentClient as any, sessionManager, channelMsg);
      await handleMessage(adapter, agentClient as any, sessionManager, dmMsg);

      // Both created sessions
      expect(sessionManager.size).toBe(2);

      // Both got responses streamed back
      expect(adapter.getStream("C-public", "thread-mention")?.finalText).toBe("Hello from the agent!");
      expect(adapter.getStream("D-alice", "thread-dm")?.finalText).toBe("Hello from the agent!");
    });
  });

  // ── Scenario 11: Agent returns no text ──

  describe("agent returns no text", () => {
    it("sends a fallback message when the agent produces no text_delta events", async () => {
      agentClient.setDefaultResponse([
        { type: "done" as const },
      ]);

      await handleMessage(adapter, agentClient as any, sessionManager, makeMessage());

      const stream = adapter.getStream("C-general", "thread-100");
      expect(stream).toBeDefined();
      expect(stream!.finalText).toBe("I received your message but had no response.");
    });
  });

  // ── Scenario 12: Full adapter lifecycle via onMessage handler ──

  describe("full adapter lifecycle (onMessage wiring)", () => {
    it("wires up handleMessage via adapter.onMessage and processes simulated messages", async () => {
      // Wire up the handler as runServe would
      adapter.onMessage(async (message: ChannelMessage) => {
        await handleMessage(adapter, agentClient as any, sessionManager, message);
      });

      // Simulate a message arriving from Slack
      await adapter.simulateMessage(makeMessage({ text: "ping" }));

      // Verify the full pipeline executed
      expect(sessionManager.size).toBe(1);
      expect(agentClient.receivedMessages.get("test-session-1")).toEqual(["ping"]);
      expect(adapter.getStream("C-general", "thread-100")?.finalText).toBe("Hello from the agent!");
    });
  });
});
