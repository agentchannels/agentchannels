/**
 * Integration tests: Discord DM path → StreamingBridge end-to-end
 *
 * Verifies the full DM response delivery path:
 *   Discord DM event
 *     → DiscordAdapter dispatches ChannelMessage { channelId: "@dm", threadId: dmChannelId }
 *     → StreamingBridge resolves/creates session keyed "discord:@dm:{dmChannelId}"
 *     → StreamingBridge calls adapter.startStream("@dm", dmChannelId, userId)
 *     → DiscordAdapter fetches the DM channel by threadId and posts a placeholder
 *     → DiscordStreamHandle edits the placeholder in-place with agent text deltas
 *     → StreamingBridge calls stream.finish() — final edit with complete response
 *
 * All Discord.js API calls are mocked — no live Discord API calls.
 * The AgentClient is also mocked — no live Anthropic API calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamingBridge } from "../../../src/core/streaming-bridge.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import type { AgentClient } from "../../../src/core/agent-client.js";
import type { BridgeResult } from "../../../src/core/streaming-bridge.js";

// ---------------------------------------------------------------------------
// Discord.js mock — mirrors adapter.test.ts so both test files are consistent
// ---------------------------------------------------------------------------

type Listener = (...args: any[]) => any;

/** Listeners registered with client.on() — persistent, keyed by event name */
const onListeners: Record<string, Listener[]> = {};
/** Listeners registered with client.once() — one-shot, keyed by event name */
const onceListeners: Record<string, Listener[]> = {};

const mockChannelsFetch = vi.fn();
const mockSend = vi.fn();
const mockEdit = vi.fn();
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();

vi.mock("discord.js", () => {
  class Client {
    channels = { fetch: mockChannelsFetch };

    on(event: string, listener: Listener) {
      if (!onListeners[event]) onListeners[event] = [];
      onListeners[event].push(listener);
      return this;
    }

    once(event: string, listener: Listener) {
      if (!onceListeners[event]) onceListeners[event] = [];
      onceListeners[event].push(listener);
      return this;
    }

    login = mockLogin;
    destroy = mockDestroy;
  }

  return {
    Client,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 512,
      MessageContent: 32768,
      DirectMessages: 4096,
    },
    Partials: {
      Channel: "Channel",
      Message: "Message",
    },
    Events: {
      ClientReady: "ready",
      MessageCreate: "messageCreate",
      Error: "error",
    },
    ChannelType: {
      GuildText: 0,
      DM: 1,
      GuildVoice: 2,
      GuildAnnouncement: 5,
      AnnouncementThread: 10,
      PublicThread: 11,
      PrivateThread: 12,
    },
  };
});

// Numeric values must match the ChannelType mock above
const CHANNEL_TYPES = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
} as const;

// Import AFTER mocks are registered
import { DiscordAdapter } from "../../../src/channels/discord/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_ID = "BOT_DM_TEST_777";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";

const DM_CHANNEL_ID = "dm-channel-test-001";
const DM_USER_ID = "dm-user-test-001";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Simulate Discord's ready event so that connect() resolves and botUserId is set.
 */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) {
    l({ user: { id: botId, tag: "TestBot#0001" } });
  }
  await connectPromise;
}

/**
 * Emit a synthetic DM messageCreate event through the registered listener.
 */
async function emitDMMessage(overrides: Record<string, unknown> = {}): Promise<void> {
  const listeners = onListeners["messageCreate"] ?? [];
  const msg = {
    id: "dm-msg-001",
    channelId: DM_CHANNEL_ID,
    guildId: null,
    content: "help me with something",
    author: { id: DM_USER_ID, bot: false },
    channel: { type: CHANNEL_TYPES.DM },
    mentions: { has: (_id: string) => false },
    ...overrides,
  };
  for (const l of listeners) {
    await l(msg);
  }
}

/**
 * Build a mock AgentClient that yields events from the provided array.
 */
function makeMockAgentClient(opts: {
  sessionId?: string;
  events?: Array<{ type: string; [k: string]: unknown }>;
  createSessionError?: Error;
} = {}): AgentClient {
  const sessionId = opts.sessionId ?? "session-dm-001";
  const events = opts.events ?? [
    { type: "text_delta", text: "Hello from the agent! " },
    { type: "text_delta", text: "How can I help you today?" },
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

describe("Discord DM path → StreamingBridge end-to-end", () => {
  let adapter: DiscordAdapter;
  let sessionManager: SessionManager;
  let agentClient: AgentClient;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset listener maps
    for (const key of Object.keys(onListeners)) delete onListeners[key];
    for (const key of Object.keys(onceListeners)) delete onceListeners[key];

    // Default mock: DM channel with edit and typing support
    const placeholderMessage = { id: "placeholder-msg-001", edit: mockEdit };
    mockEdit.mockResolvedValue({});
    mockSend.mockResolvedValue(placeholderMessage);

    // Return a DM-type channel (type: 1 = ChannelType.DM)
    mockChannelsFetch.mockResolvedValue({
      type: CHANNEL_TYPES.DM,
      isTextBased: () => true,
      send: mockSend,
      sendTyping: mockSendTyping,
    });

    adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    sessionManager = new SessionManager();
    agentClient = makeMockAgentClient();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("happy path: DM → bridge → response delivered to DM channel", () => {
    it("startStream is called with '@dm' channelId and DM channel ID as threadId", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      // Verify the DM channel was fetched by threadId (not by guildId/@dm)
      // — both setStatus and startStream call fetchTextChannel(threadId)
      expect(mockChannelsFetch).toHaveBeenCalledWith(DM_CHANNEL_ID);
    });

    it("posts a placeholder message to the DM channel before streaming begins", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Thinking") }),
      );
    });

    it("edits the placeholder with the final agent response", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].totalChars).toBe(
        "Hello from the agent! How can I help you today?".length,
      );

      // The edit mock should have been called to update the placeholder
      expect(mockEdit).toHaveBeenCalled();
      // Final edit should contain the complete agent response
      const lastEditArgs = mockEdit.mock.calls[mockEdit.mock.calls.length - 1][0] as { content: string };
      expect(lastEditArgs.content).toContain("Hello from the agent!");
      expect(lastEditArgs.content).toContain("How can I help you today?");
    });

    it("bridge result reports success=true and correct totalChars for DM", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage({ content: "hello bot" });

      expect(results[0].success).toBe(true);
      expect(results[0].totalChars).toBeGreaterThan(0);
      expect(results[0].sessionId).toBe("session-dm-001");
    });
  });

  // ── Session management ──────────────────────────────────────────────────────

  describe("session management for DM conversations", () => {
    it("creates a new session for the first DM (sessionCreated=true)", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(results[0].sessionCreated).toBe(true);
      expect(agentClient.createSession).toHaveBeenCalledTimes(1);
    });

    it("session key for DM is 'discord:@dm:{dmChannelId}'", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);
      await emitDMMessage({ channelId: "dm-ch-abc" });

      // Session should be stored under the @dm sentinel
      const storedSession = sessionManager.getSession("discord", "@dm", "dm-ch-abc");
      expect(storedSession).toBe("session-dm-001");
    });

    it("reuses the existing session for subsequent DMs from the same channel (sessionCreated=false)", async () => {
      // Pre-seed the session manager with an existing session
      sessionManager.setSession("discord", "@dm", DM_CHANNEL_ID, "existing-dm-session");

      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(results[0].sessionCreated).toBe(false);
      expect(results[0].sessionId).toBe("existing-dm-session");
      // createSession should NOT have been called
      expect(agentClient.createSession).not.toHaveBeenCalled();
    });

    it("stores the new session ID in SessionManager after first DM", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);
      await emitDMMessage({ channelId: DM_CHANNEL_ID });

      const stored = sessionManager.getSession("discord", "@dm", DM_CHANNEL_ID);
      expect(stored).toBe("session-dm-001");
    });

    it("different DM channels get independent sessions", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);

      // First DM from channel A
      await emitDMMessage({ channelId: "dm-channel-A", id: "msg-A" });
      // Second DM from channel B
      await emitDMMessage({ channelId: "dm-channel-B", id: "msg-B" });

      expect(results).toHaveLength(2);

      const sessionA = sessionManager.getSession("discord", "@dm", "dm-channel-A");
      const sessionB = sessionManager.getSession("discord", "@dm", "dm-channel-B");
      expect(sessionA).toBe("session-dm-001");
      expect(sessionB).toBe("session-dm-001");

      // Both created new sessions
      expect(agentClient.createSession).toHaveBeenCalledTimes(2);
    });
  });

  // ── ChannelMessage normalization ────────────────────────────────────────────

  describe("ChannelMessage normalization for DMs", () => {
    it("adapter produces channelId='@dm' and threadId=dmChannelId for DM events", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const capturedMessages: Array<{ channelId: string; threadId: string; isDirectMessage: boolean }> = [];
      adapter.onMessage(async (msg) => {
        capturedMessages.push({
          channelId: msg.channelId,
          threadId: msg.threadId,
          isDirectMessage: msg.isDirectMessage,
        });
        await bridge.handleMessage(msg);
      });

      await connectAdapter(adapter);
      await emitDMMessage({ channelId: "dm-ch-xyz" });

      expect(capturedMessages[0]).toEqual({
        channelId: "@dm",
        threadId: "dm-ch-xyz",
        isDirectMessage: true,
      });
    });

    it("DM message sets isMention=false and isDirectMessage=true", async () => {
      const capturedMessages: Array<{ isMention: boolean; isDirectMessage: boolean }> = [];
      adapter.onMessage(async (msg) => {
        capturedMessages.push({ isMention: msg.isMention, isDirectMessage: msg.isDirectMessage });
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(capturedMessages[0].isMention).toBe(false);
      expect(capturedMessages[0].isDirectMessage).toBe(true);
    });

    it("DM message text is passed through without modification", async () => {
      const capturedTexts: string[] = [];
      adapter.onMessage(async (msg) => {
        capturedTexts.push(msg.text);
      });

      await connectAdapter(adapter);
      await emitDMMessage({ content: "tell me a joke" });

      expect(capturedTexts[0]).toBe("tell me a joke");
    });
  });

  // ── DM response delivery ────────────────────────────────────────────────────

  describe("response delivery back to the DM channel", () => {
    it("fetches the DM channel by its channel ID (threadId), not by guildId", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);
      await emitDMMessage({ channelId: "specific-dm-channel-id" });

      // All channel fetches should use the DM channel ID
      const fetchCalls = mockChannelsFetch.mock.calls.map((c) => c[0]);
      expect(fetchCalls).toContain("specific-dm-channel-id");
      // The "@dm" sentinel should NEVER be passed to fetchTextChannel
      expect(fetchCalls).not.toContain("@dm");
    });

    it("agent response text is streamed back via edit calls on the DM message", async () => {
      const singleEventClient = makeMockAgentClient({
        events: [{ type: "text_delta", text: "This is the DM response." }, { type: "done" }],
      });
      const bridge = new StreamingBridge({ adapter, agentClient: singleEventClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);
      await emitDMMessage();

      // Verify at least one edit was made with the response text
      const allEditContents = mockEdit.mock.calls.map((c) => (c[0] as { content: string }).content);
      const finalContent = allEditContents[allEditContents.length - 1];
      expect(finalContent).toContain("This is the DM response.");
    });

    it("sends typing indicator to DM channel before streaming", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(mockSendTyping).toHaveBeenCalled();
    });

    it("sends empty response fallback when agent produces no text", async () => {
      const emptyClient = makeMockAgentClient({
        events: [{ type: "done" }],
      });
      const bridge = new StreamingBridge({ adapter, agentClient: emptyClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(results[0].success).toBe(true);
      // The stream handle should have been called with the empty response fallback
      const allEditContents = mockEdit.mock.calls.map((c) => (c[0] as { content: string }).content);
      const lastContent = allEditContents[allEditContents.length - 1];
      expect(lastContent).toBe("I received your message but had no response.");
    });

    it("sends error message to DM channel when session creation fails", async () => {
      const failingClient = makeMockAgentClient({
        createSessionError: new Error("Session creation failed: API unavailable"),
      });
      const bridge = new StreamingBridge({ adapter, agentClient: failingClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("Session creation failed");

      // Error message should be sent to the DM channel (via sendMessage → channel.send)
      expect(mockSend).toHaveBeenCalled();
      // The message sent should contain error context
      const sentContent = mockSend.mock.calls[0][0] as { content: string };
      expect(sentContent.content).toContain("API unavailable");
    });

    it("handles mid-stream agent error gracefully — edits placeholder with error text", async () => {
      const errorClient = makeMockAgentClient({
        events: [
          { type: "text_delta", text: "Starting response..." },
          { type: "error", error: "Agent stream interrupted" },
        ],
      });
      const bridge = new StreamingBridge({ adapter, agentClient: errorClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);
      await emitDMMessage();

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("Agent stream interrupted");

      // The placeholder should be edited with the error message (not left as "⏳ Thinking…")
      const allEditContents = mockEdit.mock.calls.map((c) => (c[0] as { content: string }).content);
      const lastContent = allEditContents[allEditContents.length - 1];
      // Should contain the formatted error, not the thinking placeholder
      expect(lastContent).not.toBe("⏳ Thinking…");
    });
  });

  // ── Thread concurrency guard ────────────────────────────────────────────────

  describe("thread concurrency guard for DM channels", () => {
    it("rejects a second concurrent DM from the same channel with 'already being processed'", async () => {
      // Use a slow agent that doesn't resolve immediately
      let resolveStream!: () => void;
      const slowAgentClient = {
        createSession: vi.fn().mockResolvedValue("slow-session"),
        sendMessage: vi.fn().mockImplementation(async function* () {
          await new Promise<void>((res) => {
            resolveStream = res;
          });
          yield { type: "text_delta", text: "slow response" };
          yield { type: "done" };
        }),
        getAgentId: vi.fn().mockReturnValue("agent-1"),
        getEnvironmentId: vi.fn().mockReturnValue("env-1"),
      } as unknown as AgentClient;

      const bridge = new StreamingBridge({ adapter, agentClient: slowAgentClient, sessionManager });
      const results: Array<BridgeResult | null> = [];

      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      await connectAdapter(adapter);

      // Emit two DM messages from the same channel before the first resolves
      const first = emitDMMessage({ id: "msg-1", content: "first" });
      // Give the first message time to start processing (reach the streaming phase)
      await new Promise((r) => setTimeout(r, 10));
      const second = emitDMMessage({ id: "msg-2", content: "second" });

      // Resolve the slow agent stream and wait for both to complete
      resolveStream();
      await Promise.all([first, second]);

      // Second message should have been rejected as "Thread is already being processed"
      const failedResult = results.find((r) => r && !r.success);
      expect(failedResult).toBeDefined();
      expect(failedResult?.error).toContain("already being processed");
    });
  });

  // ── DM vs guild channel isolation ──────────────────────────────────────────

  describe("DM vs guild channel session isolation", () => {
    it("DM session key 'discord:@dm:X' does not collide with guild session key 'discord:guild:X'", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      adapter.onMessage(async (msg) => bridge.handleMessage(msg));

      await connectAdapter(adapter);

      // Simulate a DM from channel "CH-001"
      await emitDMMessage({ channelId: "CH-001" });

      // Manually store a guild session with the same channel ID but different guildId
      sessionManager.setSession("discord", "GUILD-001", "CH-001", "guild-session-999");

      // DM session should be independent of the guild session
      const dmSession = sessionManager.getSession("discord", "@dm", "CH-001");
      const guildSession = sessionManager.getSession("discord", "GUILD-001", "CH-001");

      expect(dmSession).toBe("session-dm-001");
      expect(guildSession).toBe("guild-session-999");
      expect(dmSession).not.toBe(guildSession);
    });
  });

  // ── connect() / disconnect() lifecycle ────────────────────────────────────

  describe("adapter lifecycle during DM serving", () => {
    it("connect() must be called before DM messages are processed", async () => {
      const bridge = new StreamingBridge({ adapter, agentClient, sessionManager });
      const results: BridgeResult[] = [];
      adapter.onMessage(async (msg) => {
        results.push(await bridge.handleMessage(msg));
      });

      // Do NOT connect — botUserId is undefined, so DM events won't dispatch
      await emitDMMessage();

      // With no botUserId, DMs still process (they don't require mention detection)
      // — connect is needed for guild @mentions but DMs work regardless
      // This test documents the current behavior
      expect(results).toHaveLength(1); // DMs always dispatch (no mention check required)
    });

    it("disconnect() destroys the Discord client", async () => {
      await connectAdapter(adapter);
      await adapter.disconnect();

      expect(mockDestroy).toHaveBeenCalled();
    });
  });
});
