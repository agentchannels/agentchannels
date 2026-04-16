/**
 * E2E test suite: Discord DM vs Channel Thread scenarios
 *
 * Architecture:
 *   - Discord.js is fully mocked (no live Discord API calls)
 *   - Claude Managed Agent is stubbed via a minimal in-process stub
 *   - All components wired in-process (StreamingBridge + DiscordAdapter + stub AgentClient)
 *
 * Scenario categories covered:
 *   1. DM path — happy-path E2E from ChannelMessage to BridgeResult
 *   2. Guild channel @mention path — happy-path E2E with thread creation
 *   3. Session isolation — DM vs channel, cross-DM, cross-guild
 *   4. Multi-turn conversations — session reuse in both contexts
 *   5. Message routing — Discord event listener filtering (DM, @mention, non-mention, bot)
 *   6. Thread context resolution — resolveThreadContext() cases for all channel types
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelMessage } from "../../src/core/channel-adapter.js";
import type { AgentStreamEvent } from "../../src/core/chunk-parser.js";
import type { AgentClient } from "../../src/core/agent-client.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { StreamingBridge } from "../../src/core/streaming-bridge.js";

// ---------------------------------------------------------------------------
// Discord.js mock
//
// Module-level listener maps are mutated by each test via the on/once helpers.
// Mock functions are reset in beforeEach so tests are fully isolated.
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

const BOT_ID = "E2E_DM_CHAN_BOT_001";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";

const GUILD_ID = "GUILD-E2E-DM-CHAN-001";
const GUILD_ID_B = "GUILD-E2E-DM-CHAN-B01";
const THREAD_ID = "THREAD-E2E-DM-CHAN-001";
const THREAD_ID_B = "THREAD-E2E-DM-CHAN-B01";
const DM_CHANNEL_ID = "DM-CHANNEL-E2E-001";
const DM_CHANNEL_ID_B = "DM-CHANNEL-E2E-B01";

/** Local copy of ChannelType values matching the mock above */
const ChannelType = {
  GuildText: 0,
  DM: 1,
  PublicThread: 11,
  PrivateThread: 12,
  AnnouncementThread: 10,
} as const;

// ---------------------------------------------------------------------------
// StubAgentClient
//
// Minimal implementation that satisfies SessionOutputReader + StreamingBridge.
// Supports multiple session IDs (cycling) for isolation tests.
// ---------------------------------------------------------------------------

class StubAgentClient {
  private readonly sessionIds: string[];
  private callCount = 0;
  private readonly events: AgentStreamEvent[];

  constructor(options: {
    sessionId?: string;
    sessionIds?: string[];
    events?: AgentStreamEvent[];
  } = {}) {
    this.sessionIds = options.sessionIds ?? [options.sessionId ?? "stub-session-001"];
    this.events = options.events ?? [
      { type: "text_delta", text: "Hello from agent" } as AgentStreamEvent,
      { type: "done" } as AgentStreamEvent,
    ];
  }

  async createSession(): Promise<string> {
    // Cycle through session IDs for multi-session tests
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

/** Connect the adapter by simulating the Discord ready event. */
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

/** Build a DM ChannelMessage (as already processed by DiscordAdapter.setupListeners). */
function makeDMChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "dm-msg-001",
    channelId: "@dm",       // DM_GUILD_SENTINEL — no real guildId for DMs
    threadId: DM_CHANNEL_ID,
    userId: "user-dm-001",
    text: "hello from DM",
    isMention: false,
    isDirectMessage: true,
    ...overrides,
  };
}

/** Build a guild-channel ChannelMessage (as already processed by DiscordAdapter.setupListeners). */
function makeGuildChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "guild-msg-001",
    channelId: GUILD_ID,    // guildId — the actual Discord server ID
    threadId: THREAD_ID,    // Discord thread/channel ID
    userId: "user-guild-001",
    text: "what is 1 + 1?",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

/** Build a raw Discord @mention message object (for emitMessageCreate). */
function makeRawGuildMentionMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "raw-guild-msg-001",
    channelId: "text-channel-001",
    guildId: GUILD_ID,
    content: `<@${BOT_ID}> what is 1 + 1?`,
    author: { id: "user-001", bot: false },
    channel: { type: ChannelType.GuildText },
    mentions: { has: (id: string) => id === BOT_ID },
    startThread: mockStartThread,
    ...overrides,
  };
}

/** Build a raw Discord DM message object (for emitMessageCreate). */
function makeRawDMMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "raw-dm-msg-001",
    channelId: DM_CHANNEL_ID,
    guildId: null,
    content: "hello from DM",
    author: { id: "user-dm-001", bot: false },
    channel: { type: ChannelType.DM },
    mentions: { has: (_id: string) => false },
    ...overrides,
  };
}

/** Build a minimal fake sendable GuildText channel. */
function makeFakeGuildTextChannel(): Record<string, unknown> {
  return {
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
  };
}

/** Build a minimal fake sendable DM channel. */
function makeFakeDMChannel(): Record<string, unknown> {
  return {
    type: ChannelType.DM,
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
  };
}

/**
 * Create a StreamingBridge wired to the given adapter and stub client.
 *
 * Retries are disabled (maxRetries=0, retryDelayMs=0) for fast test execution.
 * Does NOT register adapter.onMessage → bridge.handleMessage; callers may call
 * bridge.handleMessage() directly or wire it explicitly for routing tests.
 */
function makeWiredBridge(
  adapter: DiscordAdapter,
  stub: StubAgentClient,
  sessionManager = new SessionManager(),
): StreamingBridge {
  return new StreamingBridge({
    adapter,
    agentClient: stub as unknown as AgentClient,
    sessionManager,
    maxRetries: 0,
    retryDelayMs: 0,
  });
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Reset listener maps so each test starts with a clean adapter
  for (const k of Object.keys(onListeners)) delete onListeners[k];
  for (const k of Object.keys(onceListeners)) delete onceListeners[k];

  // Default: login and typing succeed
  mockLogin.mockResolvedValue(undefined);
  mockSendTyping.mockResolvedValue(undefined);

  // Default: thread creation returns a thread with THREAD_ID
  mockStartThread.mockResolvedValue({ id: THREAD_ID, name: "Agent conversation" });

  // Default: channel.send returns an editable placeholder message
  const fakePlaceholder = { id: "placeholder-msg-001", edit: mockEdit };
  mockSend.mockResolvedValue(fakePlaceholder);

  // Default: edit succeeds
  mockEdit.mockResolvedValue({ id: "edited-msg-001" });

  // Default: channels.fetch returns a sendable GuildText channel
  mockChannelsFetch.mockResolvedValue(makeFakeGuildTextChannel());
});

afterEach(() => {
  vi.restoreAllMocks();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: Discord DM vs Channel Thread scenarios", () => {

  // =========================================================================
  // Part 1: DM path happy-path
  // =========================================================================

  describe("DM path — happy-path E2E", () => {
    it("DM message produces a successful BridgeResult", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const stub = new StubAgentClient({ sessionId: "dm-session-001" });
      const bridge = makeWiredBridge(adapter, stub);

      const result = await bridge.handleMessage(makeDMChannelMessage());

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("first DM creates a new session (sessionCreated=true)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const stub = new StubAgentClient({ sessionId: "dm-session-002" });
      const bridge = makeWiredBridge(adapter, stub);

      const result = await bridge.handleMessage(makeDMChannelMessage());

      expect(result.sessionCreated).toBe(true);
      expect(result.sessionId).toBe("dm-session-002");
    });

    it("second DM in the same channel reuses the existing session", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({ sessionId: "dm-reuse-session" });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const dmMessage = makeDMChannelMessage();

      const first = await bridge.handleMessage(dmMessage);
      const second = await bridge.handleMessage(dmMessage);

      expect(first.sessionCreated).toBe(true);
      expect(second.sessionCreated).toBe(false);
      expect(second.sessionId).toBe(first.sessionId);
    });

    it("DM BridgeResult.totalChars reflects the total streamed character count", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const stub = new StubAgentClient({
        sessionId: "dm-chars-001",
        events: [
          { type: "text_delta", text: "Hello!" } as AgentStreamEvent,
          { type: "text_delta", text: " How can I help?" } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ],
      });
      const bridge = makeWiredBridge(adapter, stub);

      const result = await bridge.handleMessage(makeDMChannelMessage());

      expect(result.totalChars).toBe("Hello! How can I help?".length);
    });

    it("DM response is streamed to the DM channel (fetched by threadId)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const stub = new StubAgentClient({ sessionId: "dm-stream-fetch-001" });
      const bridge = makeWiredBridge(adapter, stub);

      await bridge.handleMessage(makeDMChannelMessage({ threadId: DM_CHANNEL_ID }));

      // startStream calls fetchTextChannel(threadId), not fetchTextChannel(channelId/"@dm")
      expect(mockChannelsFetch).toHaveBeenCalledWith(DM_CHANNEL_ID);
      // Initial placeholder message sent
      expect(mockSend).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Part 2: Guild channel @mention path happy-path
  // =========================================================================

  describe("Guild channel @mention path — happy-path E2E", () => {
    it("@mention in guild channel produces a successful BridgeResult", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({ sessionId: "guild-session-001" });
      const bridge = makeWiredBridge(adapter, stub);

      const result = await bridge.handleMessage(makeGuildChannelMessage());

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("first guild @mention creates a new session (sessionCreated=true)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({ sessionId: "guild-session-002" });
      const bridge = makeWiredBridge(adapter, stub);

      const result = await bridge.handleMessage(makeGuildChannelMessage());

      expect(result.sessionCreated).toBe(true);
      expect(result.sessionId).toBe("guild-session-002");
    });

    it("subsequent message in the same guild thread reuses the session", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({ sessionId: "guild-reuse-session" });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const guildMessage = makeGuildChannelMessage();

      const first = await bridge.handleMessage(guildMessage);
      const second = await bridge.handleMessage(guildMessage);

      expect(first.sessionCreated).toBe(true);
      expect(second.sessionCreated).toBe(false);
      expect(second.sessionId).toBe(first.sessionId);
    });

    it("guild channel response is streamed to the thread channel (fetched by threadId)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({ sessionId: "guild-stream-fetch-001" });
      const bridge = makeWiredBridge(adapter, stub);

      await bridge.handleMessage(makeGuildChannelMessage({ threadId: THREAD_ID }));

      // startStream calls fetchTextChannel(threadId), not fetchTextChannel(channelId/guildId)
      expect(mockChannelsFetch).toHaveBeenCalledWith(THREAD_ID);
      expect(mockSend).toHaveBeenCalled();
    });

    it("guild BridgeResult.totalChars reflects the total streamed character count", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const expectedText = "The answer is 2.";
      const stub = new StubAgentClient({
        sessionId: "guild-chars-001",
        events: [
          { type: "text_delta", text: expectedText } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ],
      });
      const bridge = makeWiredBridge(adapter, stub);

      const result = await bridge.handleMessage(makeGuildChannelMessage());

      expect(result.totalChars).toBe(expectedText.length);
    });
  });

  // =========================================================================
  // Part 3: Session isolation
  // =========================================================================

  describe("session isolation", () => {
    it("DM session and guild channel session are completely independent", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch
        .mockResolvedValueOnce(makeFakeDMChannel())
        .mockResolvedValueOnce(makeFakeGuildTextChannel());

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({
        sessionIds: ["dm-isolated-001", "guild-isolated-001"],
      });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const dmResult = await bridge.handleMessage(makeDMChannelMessage());
      const guildResult = await bridge.handleMessage(makeGuildChannelMessage());

      // Both create new sessions in independent namespaces
      expect(dmResult.sessionCreated).toBe(true);
      expect(guildResult.sessionCreated).toBe(true);

      // Sessions are distinct
      expect(dmResult.sessionId).not.toBe(guildResult.sessionId);
    });

    it("different DM channels each create independent sessions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({
        sessionIds: ["dm-chan-a-session", "dm-chan-b-session"],
      });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const dmA = await bridge.handleMessage(
        makeDMChannelMessage({ threadId: DM_CHANNEL_ID }),
      );
      const dmB = await bridge.handleMessage(
        makeDMChannelMessage({ threadId: DM_CHANNEL_ID_B }),
      );

      expect(dmA.sessionCreated).toBe(true);
      expect(dmB.sessionCreated).toBe(true);
      expect(dmA.sessionId).not.toBe(dmB.sessionId);
    });

    it("different guild threads each create independent sessions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({
        sessionIds: ["thread-a-session", "thread-b-session"],
      });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const threadA = await bridge.handleMessage(
        makeGuildChannelMessage({ channelId: GUILD_ID, threadId: THREAD_ID }),
      );
      const threadB = await bridge.handleMessage(
        makeGuildChannelMessage({ channelId: GUILD_ID, threadId: THREAD_ID_B }),
      );

      expect(threadA.sessionCreated).toBe(true);
      expect(threadB.sessionCreated).toBe(true);
      expect(threadA.sessionId).not.toBe(threadB.sessionId);
    });

    it("different guilds with the same threadId create independent sessions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({
        sessionIds: ["guild-a-thread-session", "guild-b-thread-session"],
      });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const guildA = await bridge.handleMessage(
        makeGuildChannelMessage({ channelId: GUILD_ID, threadId: THREAD_ID }),
      );
      const guildB = await bridge.handleMessage(
        makeGuildChannelMessage({ channelId: GUILD_ID_B, threadId: THREAD_ID }),
      );

      expect(guildA.sessionCreated).toBe(true);
      expect(guildB.sessionCreated).toBe(true);
      expect(guildA.sessionId).not.toBe(guildB.sessionId);
    });

    it("DM session is stored under key discord:@dm:{dmChannelId}", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({ sessionId: "dm-key-session" });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      await bridge.handleMessage(makeDMChannelMessage({ threadId: DM_CHANNEL_ID }));

      // DM uses the "@dm" sentinel as guildId in the session key
      const sessionFromDmKey = sessionManager.getSession("discord", "@dm", DM_CHANNEL_ID);
      expect(sessionFromDmKey).toBe("dm-key-session");

      // Must NOT be stored under a real guildId
      const sessionFromGuildKey = sessionManager.getSession("discord", GUILD_ID, DM_CHANNEL_ID);
      expect(sessionFromGuildKey).toBeUndefined();
    });

    it("guild session is stored under key discord:{guildId}:{threadId}", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({ sessionId: "guild-key-session" });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      await bridge.handleMessage(
        makeGuildChannelMessage({ channelId: GUILD_ID, threadId: THREAD_ID }),
      );

      // Guild uses the real guildId in the session key
      const sessionFromGuildKey = sessionManager.getSession("discord", GUILD_ID, THREAD_ID);
      expect(sessionFromGuildKey).toBe("guild-key-session");

      // Must NOT be stored under "@dm"
      const sessionFromDmKey = sessionManager.getSession("discord", "@dm", THREAD_ID);
      expect(sessionFromDmKey).toBeUndefined();
    });
  });

  // =========================================================================
  // Part 4: Multi-turn conversations
  // =========================================================================

  describe("multi-turn conversations", () => {
    it("three consecutive DMs in the same channel share one session", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({ sessionId: "dm-multiturn-session" });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const dmMessage = makeDMChannelMessage();

      const r1 = await bridge.handleMessage(dmMessage);
      const r2 = await bridge.handleMessage(dmMessage);
      const r3 = await bridge.handleMessage(dmMessage);

      expect(r1.sessionCreated).toBe(true);
      expect(r2.sessionCreated).toBe(false);
      expect(r3.sessionCreated).toBe(false);

      expect(r1.sessionId).toBe("dm-multiturn-session");
      expect(r2.sessionId).toBe("dm-multiturn-session");
      expect(r3.sessionId).toBe("dm-multiturn-session");
    });

    it("three consecutive guild thread messages share one session", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({ sessionId: "guild-multiturn-session" });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const guildMessage = makeGuildChannelMessage();

      const r1 = await bridge.handleMessage(guildMessage);
      const r2 = await bridge.handleMessage(guildMessage);
      const r3 = await bridge.handleMessage(guildMessage);

      expect(r1.sessionCreated).toBe(true);
      expect(r2.sessionCreated).toBe(false);
      expect(r3.sessionCreated).toBe(false);

      expect(r1.sessionId).toBe("guild-multiturn-session");
      expect(r2.sessionId).toBe("guild-multiturn-session");
      expect(r3.sessionId).toBe("guild-multiturn-session");
    });

    it("interleaved DM and guild messages each reuse their own session independently", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Alternate between DM and guild channel fetches
      mockChannelsFetch
        .mockResolvedValueOnce(makeFakeDMChannel())        // dm1 setStatus
        .mockResolvedValueOnce(makeFakeDMChannel())        // dm1 startStream
        .mockResolvedValueOnce(makeFakeGuildTextChannel()) // g1 setStatus
        .mockResolvedValueOnce(makeFakeGuildTextChannel()) // g1 startStream
        .mockResolvedValueOnce(makeFakeDMChannel())        // dm2 setStatus
        .mockResolvedValueOnce(makeFakeDMChannel())        // dm2 startStream
        .mockResolvedValueOnce(makeFakeGuildTextChannel()) // g2 setStatus
        .mockResolvedValueOnce(makeFakeGuildTextChannel()); // g2 startStream

      const sessionManager = new SessionManager();
      const stub = new StubAgentClient({
        sessionIds: ["dm-interleave-session", "guild-interleave-session"],
      });
      const bridge = makeWiredBridge(adapter, stub, sessionManager);

      const dm1 = await bridge.handleMessage(makeDMChannelMessage());
      const g1 = await bridge.handleMessage(makeGuildChannelMessage());
      const dm2 = await bridge.handleMessage(makeDMChannelMessage()); // reuse DM session
      const g2 = await bridge.handleMessage(makeGuildChannelMessage()); // reuse guild session

      // First messages create new sessions
      expect(dm1.sessionCreated).toBe(true);
      expect(g1.sessionCreated).toBe(true);

      // Follow-ups reuse their respective sessions
      expect(dm2.sessionCreated).toBe(false);
      expect(g2.sessionCreated).toBe(false);

      // DM and guild sessions are distinct
      expect(dm1.sessionId).not.toBe(g1.sessionId);

      // Each context reuses its own session
      expect(dm2.sessionId).toBe(dm1.sessionId);
      expect(g2.sessionId).toBe(g1.sessionId);
    });
  });

  // =========================================================================
  // Part 5: Message routing via Discord messageCreate events
  // =========================================================================

  describe("message routing via Discord messageCreate events", () => {
    it("DM message is dispatched with channelId='@dm' and isDirectMessage=true", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate(makeRawDMMessage());

      expect(captured).toHaveLength(1);
      expect(captured[0].channelId).toBe("@dm");
      expect(captured[0].isDirectMessage).toBe(true);
      expect(captured[0].isMention).toBe(false);
      expect(captured[0].threadId).toBe(DM_CHANNEL_ID);
    });

    it("guild @mention message is dispatched with isMention=true and isDirectMessage=false", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate(makeRawGuildMentionMessage());

      expect(captured).toHaveLength(1);
      expect(captured[0].isMention).toBe(true);
      expect(captured[0].isDirectMessage).toBe(false);
      expect(captured[0].channelId).toBe(GUILD_ID);
    });

    it("bot @mention tag is stripped from the dispatched message text", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate(
        makeRawGuildMentionMessage({ content: `<@${BOT_ID}> what is 1 + 1?` }),
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].text).toBe("what is 1 + 1?");
      expect(captured[0].text).not.toContain(`<@${BOT_ID}>`);
    });

    it("non-mention guild message is NOT dispatched to handlers", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate({
        id: "non-mention-001",
        channelId: "channel-001",
        guildId: GUILD_ID,
        content: "just chatting without mentioning the bot",
        author: { id: "user-001", bot: false },
        channel: { type: ChannelType.GuildText },
        mentions: { has: (_id: string) => false }, // no bot mention
        startThread: mockStartThread,
      });

      // No handler invocation — non-mentions in guild channels are ignored
      expect(captured).toHaveLength(0);
    });

    it("messages from bots are ignored regardless of content", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      // Bot author, even with a DM type, should be ignored
      await emitMessageCreate({
        id: "other-bot-dm-001",
        channelId: DM_CHANNEL_ID,
        guildId: null,
        content: `<@${BOT_ID}> automated pipeline message`,
        author: { id: "other-bot-001", bot: true }, // ← bot author
        channel: { type: ChannelType.DM },
        mentions: { has: (id: string) => id === BOT_ID },
      });

      expect(captured).toHaveLength(0);
    });

    it("DM text content is passed through without stripping", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      const dmText = "tell me a joke please";
      await emitMessageCreate(makeRawDMMessage({ content: dmText }));

      expect(captured).toHaveLength(1);
      expect(captured[0].text).toBe(dmText);
    });

    it("message author id is preserved in the dispatched ChannelMessage", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate(makeRawDMMessage({ author: { id: "user-specific-001", bot: false } }));

      expect(captured).toHaveLength(1);
      expect(captured[0].userId).toBe("user-specific-001");
    });
  });

  // =========================================================================
  // Part 6: Thread context resolution (resolveThreadContext cases)
  // =========================================================================

  describe("thread context resolution", () => {
    it("DM channel sets channelId='@dm' (DM_GUILD_SENTINEL) and threadId=dmChannelId", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      const specificDmChannelId = "dm-specific-channel-001";
      await emitMessageCreate(makeRawDMMessage({ channelId: specificDmChannelId }));

      expect(captured).toHaveLength(1);
      expect(captured[0].channelId).toBe("@dm");
      expect(captured[0].threadId).toBe(specificDmChannelId);
    });

    it("first @mention in guild text channel creates a thread and uses thread.id as threadId", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const NEW_THREAD_ID = "created-thread-001";
      mockStartThread.mockResolvedValue({ id: NEW_THREAD_ID, name: "what is 1 + 1?" });

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate(
        makeRawGuildMentionMessage({ content: `<@${BOT_ID}> what is 1 + 1?` }),
      );

      expect(mockStartThread).toHaveBeenCalledOnce();
      expect(captured).toHaveLength(1);
      expect(captured[0].threadId).toBe(NEW_THREAD_ID);
      expect(captured[0].channelId).toBe(GUILD_ID);
    });

    it("message in an existing PublicThread reuses thread channelId without creating a new thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      const EXISTING_THREAD_CHANNEL_ID = "existing-public-thread-001";
      await emitMessageCreate({
        id: "thread-msg-001",
        channelId: EXISTING_THREAD_CHANNEL_ID,
        guildId: GUILD_ID,
        content: `<@${BOT_ID}> follow-up in thread`,
        author: { id: "user-001", bot: false },
        channel: { type: ChannelType.PublicThread },
        mentions: { has: (id: string) => id === BOT_ID },
        startThread: mockStartThread,
      });

      expect(captured).toHaveLength(1);
      // threadId is the thread's own channelId — no new thread was created
      expect(captured[0].threadId).toBe(EXISTING_THREAD_CHANNEL_ID);
      expect(captured[0].channelId).toBe(GUILD_ID);
      expect(mockStartThread).not.toHaveBeenCalled();
    });

    it("message in a PrivateThread reuses thread channelId without creating a new thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      const PRIVATE_THREAD_CHANNEL_ID = "existing-private-thread-001";
      await emitMessageCreate({
        id: "private-thread-msg-001",
        channelId: PRIVATE_THREAD_CHANNEL_ID,
        guildId: GUILD_ID,
        content: `<@${BOT_ID}> private thread follow-up`,
        author: { id: "user-001", bot: false },
        channel: { type: ChannelType.PrivateThread },
        mentions: { has: (id: string) => id === BOT_ID },
        startThread: mockStartThread,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].threadId).toBe(PRIVATE_THREAD_CHANNEL_ID);
      expect(mockStartThread).not.toHaveBeenCalled();
    });

    it("thread creation failure falls back gracefully to message.id as threadId", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Simulate CREATE_PUBLIC_THREADS permission denied
      mockStartThread.mockRejectedValue(
        new Error("Missing Permissions: CREATE_PUBLIC_THREADS"),
      );

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      const MESSAGE_ID = "mention-msg-fallback-001";
      await emitMessageCreate(
        makeRawGuildMentionMessage({ id: MESSAGE_ID }),
      );

      expect(captured).toHaveLength(1);
      // When thread creation fails, threadId falls back to the triggering message.id
      expect(captured[0].threadId).toBe(MESSAGE_ID);
      // Still dispatches — the adapter degrades gracefully
      expect(captured[0].channelId).toBe(GUILD_ID);
    });

    it("thread creation uses the stripped message text as the thread name", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const captured: ChannelMessage[] = [];
      adapter.onMessage((msg) => { captured.push(msg); });

      await emitMessageCreate(
        makeRawGuildMentionMessage({ content: `<@${BOT_ID}> explain quantum computing` }),
      );

      expect(mockStartThread).toHaveBeenCalledOnce();
      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe("explain quantum computing");
    });
  });
});
