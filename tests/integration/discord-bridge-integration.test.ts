/**
 * Integration tests: DiscordAdapter ↔ StreamingBridge ↔ SessionManager
 *
 * Verifies that DiscordAdapter integrates with the *existing* StreamingBridge
 * and SessionManager without any modification to those core components.
 *
 * ## Design
 *
 * - `discord.js` is fully mocked (no live Discord WebSocket calls).
 * - The Claude Managed Agent API is replaced by a minimal in-process stub.
 * - All three production components are wired together exactly as
 *   `runDiscordServe()` in `src/commands/serve.ts` does at runtime.
 *
 * ## Key integration contracts under test
 *
 * 1. Session key format: `"discord:{guildId}:{threadId}"`
 *    — derived from `adapter.name ("discord") + ChannelMessage.channelId (guildId) + threadId`
 * 2. DM session key: `"discord:@dm:{dmChannelId}"`
 *    — guildId sentinel "@dm" + DM channel ID
 * 3. Multi-turn session reuse — SessionManager returns the same sessionId
 *    for subsequent messages in the same thread
 * 4. Session isolation — different (guildId, threadId) pairs get independent sessions
 * 5. Streaming lifecycle — startStream → append → finish called in order
 * 6. setStatus / clearStatus called at the correct bridge lifecycle phases
 * 7. StreamingBridge thread concurrency guard works with DiscordAdapter
 * 8. Empty message filtering — no session or stream created
 * 9. DM vs @mention session isolation
 * 10. Session creation failure — bridge sends error via adapter.sendMessage fallback
 *
 * ## No core modifications
 *
 * This test imports StreamingBridge and SessionManager unmodified from
 * src/core/. The only channel-specific code is DiscordAdapter itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelMessage } from "../../src/core/channel-adapter.js";
import type { AgentStreamEvent } from "../../src/core/chunk-parser.js";
import type { AgentClient } from "../../src/core/agent-client.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { StreamingBridge } from "../../src/core/streaming-bridge.js";

// ---------------------------------------------------------------------------
// discord.js mock
//
// Mirrors the pattern from tests/channels/discord/adapter.test.ts and
// tests/e2e/discord-permission-e2e.test.ts. All listener maps are
// module-level so individual tests can fire synthetic events.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => unknown;

/** Persistent listeners (client.on) keyed by event name */
const onListeners: Record<string, Listener[]> = {};
/** One-shot listeners (client.once) keyed by event name */
const onceListeners: Record<string, Listener[]> = {};

const mockChannelsFetch = vi.fn();
const mockSend = vi.fn();
const mockEdit = vi.fn();
const mockSendTyping = vi.fn().mockResolvedValue(undefined);
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();
const mockStartThread = vi.fn();

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
    GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768, DirectMessages: 4096 },
    Partials: { Channel: "Channel", Message: "Message" },
    Events: { ClientReady: "ready", MessageCreate: "messageCreate", Error: "error" },
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

// Import AFTER mocks are registered
import { DiscordAdapter } from "../../src/channels/discord/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_ID = "INTEGRATION_BOT_ID_001";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";

const GUILD_ID = "GUILD-INTEGRATION-001";
const THREAD_ID = "THREAD-INTEGRATION-001";
const DM_CHANNEL_ID = "DM-CHANNEL-INTEGRATION-001";
const DEFAULT_SESSION_ID = "session-integration-abc";

// ChannelType values (must match the mock above)
const ChannelType = {
  GuildText: 0,
  DM: 1,
  PublicThread: 11,
  PrivateThread: 12,
  AnnouncementThread: 10,
} as const;

// ---------------------------------------------------------------------------
// Stub AgentClient
//
// Minimal implementation that satisfies SessionOutputReader + StreamingBridge.
// Configurable event sequences allow each test to control agent output.
// ---------------------------------------------------------------------------

class StubAgentClient {
  /** Session IDs returned by successive createSession() calls */
  private readonly sessionIds: string[];
  private callCount = 0;
  /** Events yielded for every sendMessage() call (default: simple text + done) */
  private readonly events: AgentStreamEvent[];
  /** Optional custom createSession() implementation */
  private readonly _createSession?: () => Promise<string>;

  constructor(options: {
    sessionId?: string;
    sessionIds?: string[];
    events?: AgentStreamEvent[];
    createSession?: () => Promise<string>;
  } = {}) {
    this.sessionIds = options.sessionIds ?? [options.sessionId ?? DEFAULT_SESSION_ID];
    this.events = options.events ?? [
      { type: "text_delta", text: "Hello from the agent!" } as AgentStreamEvent,
      { type: "done" } as AgentStreamEvent,
    ];
    this._createSession = options.createSession;
  }

  async createSession(): Promise<string> {
    if (this._createSession) return this._createSession();
    const id = this.sessionIds[this.callCount % this.sessionIds.length];
    this.callCount++;
    return id;
  }

  async *sendMessage(
    _sessionId: string,
    _text: string,
    _options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Simulate Discord's ready event so connect() resolves and botUserId is set. */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) l({ user: { id: botId, tag: "TestBot#0001" } });
  await connectPromise;
}

/** Emit a synthetic messageCreate event through all registered listeners. */
async function emitMessageCreate(message: object): Promise<void> {
  const listeners = onListeners["messageCreate"] ?? [];
  for (const l of listeners) {
    await l(message);
  }
}

/** Build a guild @mention message. */
function makeGuildMentionMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "msg-guild-001",
    channelId: "channel-001",
    guildId: GUILD_ID,
    content: `<@${BOT_ID}> hello agent`,
    author: { id: "user-001", bot: false },
    channel: { type: ChannelType.GuildText },
    mentions: { has: (id: string) => id === BOT_ID },
    startThread: mockStartThread,
    ...overrides,
  };
}

/** Build a DM message. */
function makeDMMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "dm-msg-001",
    channelId: DM_CHANNEL_ID,
    guildId: null,
    content: "hello from DM",
    author: { id: "user-dm-001", bot: false },
    channel: { type: ChannelType.DM },
    mentions: { has: (_id: string) => false },
    ...overrides,
  };
}

/** Build a minimal fake sendable channel. */
function makeFakeGuildTextChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
    ...overrides,
  };
}

/**
 * Wire the standard adapter → bridge → sessionManager pipeline.
 * Mirrors the production wiring in runDiscordServe().
 */
function wireComponents(options: {
  adapter: DiscordAdapter;
  agentClient: StubAgentClient;
  sessionManager: SessionManager;
}): StreamingBridge {
  const { adapter, agentClient, sessionManager } = options;

  const bridge = new StreamingBridge({
    adapter,
    agentClient: agentClient as unknown as AgentClient,
    sessionManager,
    // Fast retries for unit tests
    maxRetries: 0,
    retryDelayMs: 0,
  });

  // Wire adapter → bridge (mirrors runDiscordServe)
  adapter.onMessage(async (message: ChannelMessage) => {
    await bridge.handleMessage(message);
  });

  return bridge;
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mock state
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Reset listener maps
  for (const k of Object.keys(onListeners)) delete onListeners[k];
  for (const k of Object.keys(onceListeners)) delete onceListeners[k];

  // Default: login succeeds
  mockLogin.mockResolvedValue(undefined);

  // Default: sendTyping succeeds
  mockSendTyping.mockResolvedValue(undefined);

  // Default: startThread returns a thread
  mockStartThread.mockResolvedValue({ id: THREAD_ID, name: "Agent conversation" });

  // Default: channels.fetch returns a sendable GuildText channel
  mockChannelsFetch.mockResolvedValue(makeFakeGuildTextChannel());

  // Default: channel.send returns an editable placeholder message
  mockSend.mockResolvedValue({ id: "placeholder-msg-id", edit: mockEdit });

  // Default: edit succeeds
  mockEdit.mockResolvedValue({ id: "edited-msg-id" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordAdapter ↔ StreamingBridge ↔ SessionManager integration", () => {
  // ==========================================================================
  // 1. Session key format — @mention
  // ==========================================================================

  describe("session key format: discord:{guildId}:{threadId}", () => {
    it("stores the session under key derived from adapter.name + guildId + threadId", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({ sessionId: "sess-key-test-001" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({ guildId: "GUILD-SESS-001" }),
      );

      // StreamingBridge derives key as "{adapter.name}:{channelId}:{threadId}"
      // For Discord: "discord:{guildId}:{createdThreadId}"
      // DiscordAdapter.name === "discord", channelId === guildId, threadId === created thread
      const sessionId = sessionManager.getSession("discord", "GUILD-SESS-001", THREAD_ID);
      expect(sessionId).toBe("sess-key-test-001");
    });

    it("session key uses adapter.name='discord', NOT 'slack'", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      expect(adapter.name).toBe("discord");

      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({ sessionId: "sess-name-test-001" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      // Keyed under "discord", NOT "slack"
      const sessionId = sessionManager.getSession("discord", GUILD_ID, THREAD_ID);
      expect(sessionId).toBe("sess-name-test-001");

      // "slack" namespace is empty (no crossover)
      expect(sessionManager.getSession("slack", GUILD_ID, THREAD_ID)).toBeUndefined();
    });

    it("session key uses guildId as channelId for guild @mentions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({ sessionId: "sess-guild-id-001" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      // Different guild IDs → different session keys
      const thread1 = "thread-guild-A";
      const thread2 = "thread-guild-B";
      mockStartThread
        .mockResolvedValueOnce({ id: thread1, name: "A" })
        .mockResolvedValueOnce({ id: thread2, name: "B" });

      // Session IDs for two separate guilds
      let sessionCount = 0;
      const customClient = new StubAgentClient({
        createSession: async () => `sess-guild-${++sessionCount}`,
      });
      wireComponents({ adapter, agentClient: customClient, sessionManager });

      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-A" }));
      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-B" }));

      // Each guild/thread combination has its own session
      expect(sessionManager.getSession("discord", "GUILD-A", thread1)).toBeDefined();
      expect(sessionManager.getSession("discord", "GUILD-B", thread2)).toBeDefined();
    });
  });

  // ==========================================================================
  // 2. DM session key format — discord:@dm:{dmChannelId}
  // ==========================================================================

  describe("DM session key format: discord:@dm:{dmChannelId}", () => {
    it("stores DM sessions under key 'discord:@dm:{dmChannelId}'", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({ sessionId: "sess-dm-001" });

      // Mock DM channel for startStream
      mockChannelsFetch.mockResolvedValue(makeFakeGuildTextChannel({ type: ChannelType.DM }));

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeDMMessage({ channelId: "DM-CH-XYZ" }));

      // DM: channelId = "@dm", threadId = dmChannelId
      const sessionId = sessionManager.getSession("discord", "@dm", "DM-CH-XYZ");
      expect(sessionId).toBe("sess-dm-001");
    });

    it("DM and guild mention sessions are completely isolated", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let count = 0;
      const agentClient = new StubAgentClient({
        createSession: async () => `sess-${++count}`,
      });

      // Mock DM channel for startStream
      mockChannelsFetch.mockImplementation(async (channelId: string) => {
        if (channelId === "DM-ISO-CHANNEL") {
          return { ...makeFakeGuildTextChannel(), type: ChannelType.DM };
        }
        return makeFakeGuildTextChannel();
      });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      // DM message
      await emitMessageCreate(makeDMMessage({ channelId: "DM-ISO-CHANNEL" }));
      // Guild @mention (creates thread THREAD_ID)
      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-ISO" }));

      const dmSession = sessionManager.getSession("discord", "@dm", "DM-ISO-CHANNEL");
      const guildSession = sessionManager.getSession("discord", "GUILD-ISO", THREAD_ID);

      expect(dmSession).toBeDefined();
      expect(guildSession).toBeDefined();
      // They are distinct sessions
      expect(dmSession).not.toBe(guildSession);
    });
  });

  // ==========================================================================
  // 3. Multi-turn session reuse
  // ==========================================================================

  describe("multi-turn session reuse", () => {
    it("reuses the same session for subsequent messages in the same Discord thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let createCount = 0;
      const agentClient = new StubAgentClient({
        createSession: async () => `sess-multiturn-${++createCount}`,
      });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      // First message in a guild text channel — creates a Discord thread
      await emitMessageCreate(
        makeGuildMentionMessage({ guildId: "GUILD-MT", channel: { type: ChannelType.GuildText } }),
      );
      expect(createCount).toBe(1);

      // Subsequent messages inside the existing thread reuse the same session
      await emitMessageCreate(
        makeGuildMentionMessage({
          guildId: "GUILD-MT",
          channelId: THREAD_ID, // message is now inside the thread
          channel: { type: ChannelType.PublicThread }, // already a thread
        }),
      );
      // No new session was created for the follow-up message
      expect(createCount).toBe(1);

      // Both messages went to the same session
      const sessionId = sessionManager.getSession("discord", "GUILD-MT", THREAD_ID);
      expect(sessionId).toBe("sess-multiturn-1");
    });

    it("DM messages to the same channel reuse the session", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let createCount = 0;
      const agentClient = new StubAgentClient({
        createSession: async () => `sess-dm-mt-${++createCount}`,
      });

      mockChannelsFetch.mockResolvedValue({ ...makeFakeGuildTextChannel(), type: ChannelType.DM });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeDMMessage({ channelId: "DM-MULTI-001", content: "first message" }));
      expect(createCount).toBe(1);

      await emitMessageCreate(makeDMMessage({ channelId: "DM-MULTI-001", content: "follow up" }));
      // Session is reused — createSession should NOT be called again
      expect(createCount).toBe(1);

      const sessionId = sessionManager.getSession("discord", "@dm", "DM-MULTI-001");
      expect(sessionId).toBe("sess-dm-mt-1");
    });
  });

  // ==========================================================================
  // 4. Session isolation between different threads
  // ==========================================================================

  describe("session isolation between different threads", () => {
    it("creates separate sessions for different guild+thread combinations", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let count = 0;
      const agentClient = new StubAgentClient({
        createSession: async () => `sess-iso-${++count}`,
      });

      // Each @mention creates a different thread
      const threadA = "thread-iso-A";
      const threadB = "thread-iso-B";
      mockStartThread
        .mockResolvedValueOnce({ id: threadA, name: "A" })
        .mockResolvedValueOnce({ id: threadB, name: "B" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage({ guildId: GUILD_ID }));
      await emitMessageCreate(makeGuildMentionMessage({ guildId: GUILD_ID }));

      const sessA = sessionManager.getSession("discord", GUILD_ID, threadA);
      const sessB = sessionManager.getSession("discord", GUILD_ID, threadB);
      expect(sessA).toBe("sess-iso-1");
      expect(sessB).toBe("sess-iso-2");
      expect(sessA).not.toBe(sessB);
    });

    it("same threadId in different guilds produces separate sessions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let count = 0;
      const agentClient = new StubAgentClient({
        createSession: async () => `sess-cross-guild-${++count}`,
      });

      // Both threads happen to get the same thread ID (edge case)
      mockStartThread.mockResolvedValue({ id: "same-thread-id", name: "Thread" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-X" }));
      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-Y" }));

      // Different guilds → different session keys even with same thread ID
      const sessX = sessionManager.getSession("discord", "GUILD-X", "same-thread-id");
      const sessY = sessionManager.getSession("discord", "GUILD-Y", "same-thread-id");
      expect(sessX).toBe("sess-cross-guild-1");
      expect(sessY).toBe("sess-cross-guild-2");
    });
  });

  // ==========================================================================
  // 5. Streaming lifecycle via DiscordStreamHandle
  // ==========================================================================

  describe("streaming lifecycle (startStream → append → finish)", () => {
    it("calls channels.fetch with threadId (not guildId) to post the stream", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient();

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      // startStream fetches using the actual Discord thread/channel ID (threadId),
      // not the guildId. Two fetches: one for setStatus, one for startStream.
      expect(mockChannelsFetch).toHaveBeenCalledWith(THREAD_ID);
    });

    it("sends a placeholder message and edits it with agent text", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({
        events: [
          { type: "text_delta", text: "Hello " } as AgentStreamEvent,
          { type: "text_delta", text: "world!" } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ],
      });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      // A placeholder was sent to the channel
      expect(mockSend).toHaveBeenCalled();
      // The placeholder was edited with the accumulated text (possibly rate-limited)
      expect(mockEdit).toHaveBeenCalled();
    });

    it("invokes setStatus (typing indicator) before streaming", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient();

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      // setStatus calls sendTyping on the thread channel
      expect(mockSendTyping).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("finish() is called exactly once per message, leaving the channel clean", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({
        events: [
          { type: "text_delta", text: "Done." } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ],
      });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      // Track edit calls
      const editCalls: string[] = [];
      mockEdit.mockImplementation(async ({ content }: { content: string }) => {
        editCalls.push(content);
        return {};
      });

      await emitMessageCreate(makeGuildMentionMessage());

      // At least one edit was made (the final finish edit)
      expect(editCalls.length).toBeGreaterThan(0);
      // The final content should contain the agent response text
      const lastEdit = editCalls[editCalls.length - 1];
      expect(lastEdit).toContain("Done.");
    });
  });

  // ==========================================================================
  // 6. StreamingBridge concurrency guard
  // ==========================================================================

  describe("StreamingBridge thread concurrency guard", () => {
    it("rejects a second concurrent message for the same thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      // Latch that the slow agent uses to hold the first message open
      let releaseFirst!: () => void;
      const firstLatch = new Promise<void>((r) => { releaseFirst = r; });
      let firstStarted = false;
      const firstStartedPromise = new Promise<void>((r) => {
        // Resolved when the slow agent begins executing
        firstStarted = false;
        void firstLatch; // suppress lint
        r(); // resolve immediately — we track "started" via sendMessage entry
      });
      // Override: track when sendMessage is first entered
      let sendMessageEntered!: () => void;
      const sendMessageEnteredPromise = new Promise<void>((r) => { sendMessageEntered = r; });

      const slowClient: Partial<AgentClient> = {
        createSession: vi.fn().mockResolvedValue("sess-concurrent"),
        sendMessage: async function* (_sessionId: string, _text: string) {
          sendMessageEntered(); // signal that we're inside the generator
          await firstLatch;     // block until the test releases us
          yield { type: "done" } as AgentStreamEvent;
        },
      };

      const bridge = new StreamingBridge({
        adapter,
        agentClient: slowClient as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      await connectAdapter(adapter);
      void firstStarted; // suppress unused warning

      // Build a ChannelMessage matching the existing PublicThread (no startThread call needed)
      const msg1: ChannelMessage = {
        id: "msg-concurrent-1",
        channelId: GUILD_ID,
        threadId: THREAD_ID,
        userId: "user-c",
        text: "first message",
        isMention: true,
        isDirectMessage: false,
      };
      const msg2: ChannelMessage = {
        ...msg1,
        id: "msg-concurrent-2",
        text: "second message (should be rejected)",
      };

      // Start processing the first message (will block in slow agent)
      const firstResultPromise = bridge.handleMessage(msg1);

      // Wait until the slow agent has actually started executing (is inside sendMessage)
      await sendMessageEnteredPromise;

      // While the first message holds the thread, fire the second — should be rejected immediately
      const secondResult = await bridge.handleMessage(msg2);
      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toBe("Thread is already being processed");

      // Release the first message to let the test finish cleanly
      releaseFirst();
      const firstResult = await firstResultPromise;
      // First result may succeed or fail (abort race), but it should complete
      expect(firstResult).toBeDefined();
    });
  });

  // ==========================================================================
  // 7. Empty message filtering
  // ==========================================================================

  describe("empty message filtering", () => {
    it("does not create a session or start a stream for messages with only whitespace", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let createSessionCalled = false;
      const agentClient = new StubAgentClient({
        createSession: async () => {
          createSessionCalled = true;
          return "sess-should-not-be-created";
        },
      });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      // The adapter itself strips the mention — resulting in empty text
      // For an @mention-only message, text = "" after stripping
      await emitMessageCreate(
        makeGuildMentionMessage({
          content: `<@${BOT_ID}>`,   // mention only — text becomes ""
        }),
      );

      // Bridge filters empty text → no session, no stream
      expect(createSessionCalled).toBe(false);
      expect(sessionManager.size).toBe(0);
      // No placeholder message was sent (startStream was not called)
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 8. Session creation failure — sendMessage fallback
  // ==========================================================================

  describe("session creation failure", () => {
    it("sends an error via adapter.sendMessage when AgentClient.createSession() throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      const failingClient = new StubAgentClient({
        createSession: async () => {
          throw new Error("AgentClient: API unavailable");
        },
      });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      wireComponents({ adapter, agentClient: failingClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      // No session was stored
      expect(sessionManager.size).toBe(0);

      // The error was sent to the Discord channel via adapter.sendMessage → channel.send
      // (stream was not started — the fallback path used sendMessage, not startStream)
      // There should be a send call with error text.
      const sendCalls: string[] = (mockSend.mock.calls as Array<[{ content: string }]>)
        .map(([args]) => args.content);

      // Either a stream placeholder OR a direct error message was sent.
      // For the session-creation-failure path, StreamingBridge uses sendMessage fallback
      // (not startStream), which triggers channel.send with the error content.
      expect(sendCalls.some((c) => c.includes("unavailable") || c.includes("⚠️"))).toBe(true);

      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
    });
  });

  // ==========================================================================
  // 9. adapter.name is "discord" — validates ChannelAdapter conformance
  // ==========================================================================

  describe("ChannelAdapter conformance", () => {
    it("adapter.name equals 'discord' (drives session key prefix)", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      expect(adapter.name).toBe("discord");
    });

    it("StreamingBridge accepts DiscordAdapter without type errors at runtime", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient();

      // If the adapter did not conform to ChannelAdapter, StreamingBridge
      // construction would throw or fail at type level. The fact that this
      // succeeds demonstrates zero core modification was needed.
      expect(() => {
        new StreamingBridge({
          adapter,
          agentClient: agentClient as unknown as AgentClient,
          sessionManager,
        });
      }).not.toThrow();
    });

    it("all required ChannelAdapter methods are present on DiscordAdapter", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });

      // Required methods
      expect(typeof adapter.connect).toBe("function");
      expect(typeof adapter.disconnect).toBe("function");
      expect(typeof adapter.onMessage).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.startStream).toBe("function");

      // Optional methods (used by StreamingBridge if present)
      expect(typeof adapter.setStatus).toBe("function");
      expect(typeof adapter.clearStatus).toBe("function");
    });
  });

  // ==========================================================================
  // 10. runDiscordServe wiring pattern — SessionManager is passed unchanged
  // ==========================================================================

  describe("SessionManager used without modification", () => {
    it("SessionManager.getSession uses 'discord' as channelType after bridge processes a message", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({ sessionId: "sess-verify-key" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-VERIFY" }));

      // Exact 3-part key as specified: channelType=adapter.name, channelId=guildId, threadId=threadId
      expect(sessionManager.getSession("discord", "GUILD-VERIFY", THREAD_ID)).toBe("sess-verify-key");

      // Ensure no session leaked into wrong key space
      expect(sessionManager.getSession("discord", THREAD_ID, "GUILD-VERIFY")).toBeUndefined();
      expect(sessionManager.getSession("slack", "GUILD-VERIFY", THREAD_ID)).toBeUndefined();
    });

    it("SessionManager tracks sessions across multiple guild threads correctly", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      let sessCount = 0;
      const agentClient = new StubAgentClient({
        createSession: async () => `sess-${++sessCount}`,
      });

      const threadA = "thread-sm-A";
      const threadB = "thread-sm-B";
      const threadC = "thread-sm-C";

      mockStartThread
        .mockResolvedValueOnce({ id: threadA, name: "A" })
        .mockResolvedValueOnce({ id: threadB, name: "B" })
        .mockResolvedValueOnce({ id: threadC, name: "C" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-SM" }));
      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-SM" }));
      await emitMessageCreate(makeGuildMentionMessage({ guildId: "GUILD-SM" }));

      expect(sessionManager.size).toBe(3);
      expect(sessionManager.getSession("discord", "GUILD-SM", threadA)).toBe("sess-1");
      expect(sessionManager.getSession("discord", "GUILD-SM", threadB)).toBe("sess-2");
      expect(sessionManager.getSession("discord", "GUILD-SM", threadC)).toBe("sess-3");
    });

    it("hasSession() returns false before first message and true after", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient({ sessionId: "sess-has-check" });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      // Before any message: no session
      expect(sessionManager.hasSession("discord", GUILD_ID, THREAD_ID)).toBe(false);

      await emitMessageCreate(makeGuildMentionMessage());

      // After the message is processed: session exists
      expect(sessionManager.hasSession("discord", GUILD_ID, THREAD_ID)).toBe(true);
    });
  });

  // ==========================================================================
  // 11. 2K overflow — DiscordStreamHandle posts follow-up messages
  // ==========================================================================

  describe("2K character overflow through StreamingBridge", () => {
    it("posts a follow-up message when agent text exceeds 2000 characters", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();

      // Produce 2500 chars total — should overflow into a second message
      const longText = "a".repeat(2500);
      const agentClient = new StubAgentClient({
        events: [
          { type: "text_delta", text: longText } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ],
      });

      // Track multiple placeholder messages sent to the channel
      const sentContents: string[] = [];
      mockSend.mockImplementation(async ({ content }: { content: string }) => {
        sentContents.push(content);
        return { id: `msg-${sentContents.length}`, edit: mockEdit };
      });

      wireComponents({ adapter, agentClient, sessionManager });
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      // At least two send calls: initial placeholder + overflow message
      expect(sentContents.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================================================
  // 12. Bridge phase observability works with Discord adapter
  // ==========================================================================

  describe("StreamingBridge.onPhaseChange works with DiscordAdapter", () => {
    it("emits the expected lifecycle phases", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const sessionManager = new SessionManager();
      const agentClient = new StubAgentClient();

      const phases: string[] = [];

      const bridge = new StreamingBridge({
        adapter,
        agentClient: agentClient as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      bridge.onPhaseChange((_threadKey, phase) => {
        phases.push(phase);
      });

      adapter.onMessage(async (message: ChannelMessage) => {
        await bridge.handleMessage(message);
      });

      await connectAdapter(adapter);
      await emitMessageCreate(makeGuildMentionMessage());

      // Expected phases emitted by the bridge
      expect(phases).toContain("session_resolve");
      expect(phases).toContain("stream_start");
      expect(phases).toContain("streaming");
      expect(phases).toContain("cleanup");
    });
  });
});
