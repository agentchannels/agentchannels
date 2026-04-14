/**
 * E2E test suite: Discord ↔ StreamingBridge — permission error handling
 *
 * Architecture:
 *   - Discord.js is fully mocked (no live Discord API calls)
 *   - Claude Managed Agent is stubbed via a minimal in-process stub
 *   - All components wired in-process (StreamingBridge + DiscordAdapter + stub AgentClient)
 *
 * Scenario categories covered:
 *   - Bot login failure (invalid token / CLIENT_NOT_READY)
 *   - Channel not found (no VIEW_CHANNEL / channels.fetch returns null)
 *   - Non-text channel (fetching a voice channel)
 *   - Missing SEND_MESSAGES: startStream placeholder send fails
 *   - Missing MANAGE_MESSAGES: finish() edit throws after streaming
 *   - Thread creation denied (CREATE_PUBLIC_THREADS): graceful fallback to message.id
 *   - Session creation failure: AgentClient.createSession() throws
 *   - Concurrent thread processing guard (same channelId+threadId)
 *   - Double permission failure: sendMessage fallback also fails, bridge still returns error
 *   - setStatus typing indicator fails gracefully (does not abort bridge)
 *   - appendTasks edit fails gracefully (does not abort bridge)
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
// Mirrors the hoisted mock pattern from tests/channels/discord/adapter.test.ts.
// Module-level mocks are mutated per test via mockResolvedValue / mockRejectedValue.
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
// Test constants
// ---------------------------------------------------------------------------

const BOT_ID = "PERM_TEST_BOT_9001";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";
const GUILD_ID = "GUILD-PERM-TEST-001";
const THREAD_ID = "THREAD-PERM-TEST-001";
const MSG_ID = "MSG-PERM-TEST-001";
const SESSION_ID = "session-perm-test-abc";

// ---------------------------------------------------------------------------
// Stub AgentClient
// ---------------------------------------------------------------------------

/**
 * Minimal stub that satisfies the SessionOutputReader + StreamingBridge contract.
 * Configurable session creation behavior and event sequence.
 */
class StubAgentClient {
  private readonly _sessionId: string;
  private readonly _events: AgentStreamEvent[];
  private readonly _createSession?: () => Promise<string>;

  constructor(options: {
    sessionId?: string;
    events?: AgentStreamEvent[];
    createSession?: () => Promise<string>;
  } = {}) {
    this._sessionId = options.sessionId ?? SESSION_ID;
    this._events = options.events ?? [
      { type: "text_delta", text: "Hello" } as AgentStreamEvent,
      { type: "done" } as AgentStreamEvent,
    ];
    this._createSession = options.createSession;
  }

  async createSession(): Promise<string> {
    if (this._createSession) return this._createSession();
    return this._sessionId;
  }

  async *sendMessage(
    _sessionId: string,
    _text: string,
    _options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentStreamEvent> {
    for (const event of this._events) {
      yield event;
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Simulate the Discord ready event so connect() resolves and botUserId is set.
 */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) l({ user: { id: botId, tag: "TestBot#0001" } });
  await connectPromise;
}

/**
 * Build a ChannelMessage with sensible defaults.
 */
function makeChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: MSG_ID,
    channelId: GUILD_ID,
    threadId: THREAD_ID,
    userId: "user-perm-001",
    text: "hello, what is 1 + 1?",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

/**
 * Build a fake sendable text channel (GuildText).
 */
function makeFakeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 0, // GuildText
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
    ...overrides,
  };
}

/**
 * Wire a StreamingBridge with the given adapter and stub AgentClient.
 */
function makeWiredBridge(
  adapter: DiscordAdapter,
  stubClient: StubAgentClient,
): StreamingBridge {
  return new StreamingBridge({
    adapter,
    agentClient: stubClient as unknown as AgentClient,
    sessionManager: new SessionManager(),
    // Suppress retries for faster tests
    maxRetries: 0,
    retryDelayMs: 0,
  });
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

  // Default: startThread creates a thread
  mockStartThread.mockResolvedValue({ id: THREAD_ID, name: "Agent conversation" });

  // Default: channels.fetch returns a sendable channel
  mockChannelsFetch.mockResolvedValue(makeFakeChannel());

  // Default: channel.send returns an editable message
  mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });

  // Default: message.edit succeeds
  mockEdit.mockResolvedValue({ id: "edited-msg-id" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Discord ↔ StreamingBridge: permission error handling", () => {
  // =========================================================================
  // 1. Bot login failure (invalid token / bad credentials)
  // =========================================================================

  describe("bot login failure", () => {
    it("connect() rejects with 'Login failed' when client.login() throws", async () => {
      mockLogin.mockRejectedValueOnce(new Error("TOKEN_INVALID"));

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });

      await expect(adapter.connect()).rejects.toThrow("Login failed");
    });

    it("connect() rejects when Discord emits an error event during handshake", async () => {
      // Make login hang indefinitely so the error event arrives first
      mockLogin.mockReturnValue(new Promise<void>(() => {}));

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const connectPromise = adapter.connect();

      // Emit an error event before the ready event
      const errorListeners = onceListeners["error"] ?? [];
      for (const l of errorListeners) l(new Error("WebSocket connection closed"));

      await expect(connectPromise).rejects.toThrow("Connection error");
    });
  });

  // =========================================================================
  // 2. Channel not found — no VIEW_CHANNEL permission or wrong ID
  // =========================================================================

  describe("channel not found (VIEW_CHANNEL denied / invalid ID)", () => {
    it("BridgeResult.success is false when channels.fetch() returns null", async () => {
      mockChannelsFetch.mockResolvedValue(null);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains 'Stream start failed' when channel is not found", async () => {
      mockChannelsFetch.mockResolvedValue(null);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toMatch(/Stream start failed/i);
    });

    it("BridgeResult.totalChars is 0 when channel is not found", async () => {
      mockChannelsFetch.mockResolvedValue(null);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.totalChars).toBe(0);
    });

    it("bridge does not throw when sendMessage fallback also fails (double null channel)", async () => {
      // Both startStream and the fallback sendMessage will fail (null channel)
      mockChannelsFetch.mockResolvedValue(null);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());

      // Should not throw — bridge swallows the secondary sendMessage failure
      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 3. Non-text channel (voice, category, etc.)
  // =========================================================================

  describe("non-text channel (SEND_MESSAGES not applicable)", () => {
    it("BridgeResult.success is false when fetched channel is not text-based", async () => {
      mockChannelsFetch.mockResolvedValue({
        type: 2, // GuildVoice
        isTextBased: () => false,
      });

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains 'Stream start failed' for non-text channel", async () => {
      mockChannelsFetch.mockResolvedValue({
        type: 2, // GuildVoice
        isTextBased: () => false,
      });

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toMatch(/Stream start failed/i);
    });
  });

  // =========================================================================
  // 4. Missing SEND_MESSAGES — initial placeholder send throws
  // =========================================================================

  describe("missing SEND_MESSAGES permission (channel.send throws)", () => {
    it("BridgeResult.success is false when channel.send throws Missing Permissions", async () => {
      const permError = new Error("Missing Permissions");
      const ch = makeFakeChannel({ send: vi.fn().mockRejectedValue(permError) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error mentions 'Stream start failed' when send is denied", async () => {
      const permError = new Error("Missing Permissions");
      const ch = makeFakeChannel({ send: vi.fn().mockRejectedValue(permError) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toMatch(/Stream start failed/i);
    });

    it("BridgeResult.updateCount is 0 when send is denied before streaming begins", async () => {
      const ch = makeFakeChannel({ send: vi.fn().mockRejectedValue(new Error("50013")) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.updateCount).toBe(0);
    });

    it("bridge does not throw when both startStream and sendMessage fallback fail", async () => {
      const permError = new Error("Missing Permissions");
      const ch = makeFakeChannel({ send: vi.fn().mockRejectedValue(permError) });
      mockChannelsFetch.mockResolvedValue(ch);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());

      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();

      consoleSpy.mockRestore();
    });

    it("BridgeResult.sessionCreated may be true even when send fails (session was created before stream)", async () => {
      // Session creation succeeds before the startStream attempt
      const permError = new Error("Missing Permissions");
      const ch = makeFakeChannel({ send: vi.fn().mockRejectedValue(permError) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      // Session was created in Phase 1 before Phase 2 (startStream) failed
      expect(result.sessionCreated).toBe(true);
      expect(result.sessionId).toBe(SESSION_ID);
    });
  });

  // =========================================================================
  // 5. Missing MANAGE_MESSAGES — finish() edit throws after streaming
  //
  // Uses vi.useFakeTimers() so Date.now() returns 0, which keeps
  //   elapsed = Date.now() - lastEditTime = 0 - 0 = 0 < STREAM_EDIT_INTERVAL_MS (1000 ms)
  // This causes scheduleFlush() to schedule a setTimeout instead of immediately
  // calling `void flushEdit()`. finish() cancels the pending timeout and calls
  // edit() directly in its awaited while-loop, so the thrown error propagates
  // cleanly through finish() to the bridge's catch block — no unhandled rejections.
  // =========================================================================

  describe("missing MANAGE_MESSAGES permission (message.edit throws in finish)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("BridgeResult.success is false when message.edit throws during finish()", async () => {
      // Placeholder send succeeds, but all edits fail (MANAGE_MESSAGES denied)
      const editError = new Error("Missing Access");
      const sentMsg = { id: "placeholder-msg", edit: vi.fn().mockRejectedValue(editError) };
      const ch = makeFakeChannel({ send: vi.fn().mockResolvedValue(sentMsg) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "The answer is 2" },
        { type: "done" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error is set when message.edit throws in finish()", async () => {
      const editError = new Error("Missing Access");
      const sentMsg = { id: "placeholder-msg", edit: vi.fn().mockRejectedValue(editError) };
      const ch = makeFakeChannel({ send: vi.fn().mockResolvedValue(sentMsg) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Hello there" },
        { type: "done" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toBeDefined();
      expect(result.error).not.toBeUndefined();
    });

    it("bridge does not throw when finish() edit permission is denied", async () => {
      const editError = new Error("50013: Missing Permissions");
      const sentMsg = { id: "placeholder-msg", edit: vi.fn().mockRejectedValue(editError) };
      const ch = makeFakeChannel({ send: vi.fn().mockResolvedValue(sentMsg) });
      mockChannelsFetch.mockResolvedValue(ch);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [{ type: "text_delta", text: "Hi" }, { type: "done" }];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));

      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();

      consoleSpy.mockRestore();
    });

    it("text is still accumulated even when edits fail (totalChars reflects streamed text)", async () => {
      // Edits fail but text_delta events still accumulate on the bridge side
      const editError = new Error("Missing Permissions");
      const sentMsg = { id: "placeholder-msg", edit: vi.fn().mockRejectedValue(editError) };
      const ch = makeFakeChannel({ send: vi.fn().mockResolvedValue(sentMsg) });
      mockChannelsFetch.mockResolvedValue(ch);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world!" },
        { type: "done" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // Text was counted even though edits failed
      expect(result.totalChars).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 6. appendTasks edit fails gracefully (does not abort bridge)
  // =========================================================================

  describe("appendTasks edit permission failure (graceful degradation)", () => {
    it("BridgeResult.success is true even when appendTasks edit throws", async () => {
      // send() for placeholder succeeds; edit fails only for appendTasks calls,
      // but succeeds for the final finish() call
      let editCallCount = 0;
      const editFn = vi.fn().mockImplementation(() => {
        editCallCount++;
        // First edit (appendTasks) fails; subsequent edits (finish) succeed
        if (editCallCount <= 1) throw new Error("Missing Permissions");
        return Promise.resolve({ id: "edited" });
      });
      const sentMsg = { id: "placeholder-msg", edit: editFn };
      const ch = makeFakeChannel({ send: vi.fn().mockResolvedValue(sentMsg) });
      mockChannelsFetch.mockResolvedValue(ch);

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "2" },
        { type: "done" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // Stream should complete successfully despite appendTasks failure
      expect(result.success).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 7. setStatus typing indicator fails gracefully
  // =========================================================================

  describe("setStatus typing indicator permission failure", () => {
    it("bridge continues normally when sendTyping throws (no SEND_MESSAGES in typing)", async () => {
      // sendTyping throws but channel.send succeeds
      const ch = makeFakeChannel({
        sendTyping: vi.fn().mockRejectedValue(new Error("Missing Permissions")),
        send: mockSend,
      });
      mockChannelsFetch.mockResolvedValue(ch);
      mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited" });

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Hello!" },
        { type: "done" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // setStatus failure should not abort the bridge
      expect(result.success).toBe(true);
      expect(result.totalChars).toBe("Hello!".length);

      consoleSpy.mockRestore();
    });

    it("setStatus channels.fetch failure is swallowed and does not affect streaming", async () => {
      // First fetch (setStatus) returns null, subsequent fetches (startStream) succeed
      let fetchCallCount = 0;
      mockChannelsFetch.mockImplementation(() => {
        fetchCallCount++;
        if (fetchCallCount === 1) return Promise.resolve(null);
        return Promise.resolve(makeFakeChannel());
      });
      mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited" });

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [{ type: "text_delta", text: "Hi" }, { type: "done" }];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // Despite setStatus failure, streaming completes
      expect(result.success).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 8. Thread creation denied (CREATE_PUBLIC_THREADS) — graceful fallback
  // =========================================================================

  describe("CREATE_PUBLIC_THREADS permission denied", () => {
    it("adapter falls back to message.id as threadId when startThread throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const receivedMessages: ChannelMessage[] = [];
      adapter.onMessage(async (msg) => { receivedMessages.push(msg); });

      // Simulate the messageCreate event with a startThread that throws
      const failingStartThread = vi.fn().mockRejectedValue(
        new Error("Missing Permissions: CREATE_PUBLIC_THREADS"),
      );

      const listeners = onListeners["messageCreate"] ?? [];
      for (const l of listeners) {
        await l({
          id: MSG_ID,
          channelId: "channel-001",
          guildId: GUILD_ID,
          content: `<@${BOT_ID}> what is 1 + 1?`,
          author: { id: "user-001", bot: false },
          channel: { type: 0 }, // GuildText
          mentions: { has: (id: string) => id === BOT_ID },
          startThread: failingStartThread,
        });
      }

      expect(receivedMessages).toHaveLength(1);
      // Falls back to message.id when startThread fails
      expect(receivedMessages[0].threadId).toBe(MSG_ID);

      warnSpy.mockRestore();
    });

    it("bridge processes message normally with fallback threadId when startThread fails", async () => {
      // Setup: startThread fails, but channel.send + edit succeed using message.id
      mockChannelsFetch.mockResolvedValue(makeFakeChannel());
      mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited" });

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "The answer is 2." },
        { type: "done" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));

      // Manually send a message with fallback threadId (as adapter would produce)
      const result = await bridge.handleMessage(
        makeChannelMessage({ threadId: MSG_ID }),
      );

      expect(result.success).toBe(true);
      expect(result.totalChars).toBe("The answer is 2.".length);

      warnSpy.mockRestore();
    });

    it("warns to console when startThread fails", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      adapter.onMessage(async () => {});

      const listeners = onListeners["messageCreate"] ?? [];
      for (const l of listeners) {
        await l({
          id: MSG_ID,
          channelId: "channel-001",
          guildId: GUILD_ID,
          content: `<@${BOT_ID}> test`,
          author: { id: "user-001", bot: false },
          channel: { type: 0 },
          mentions: { has: (id: string) => id === BOT_ID },
          startThread: vi.fn().mockRejectedValue(new Error("50013")),
        });
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not create thread"),
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // 9. Session creation failure (AgentClient.createSession throws)
  // =========================================================================

  describe("session creation failure", () => {
    it("BridgeResult.success is false when createSession() throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        createSession: async () => {
          throw new Error("Unauthorized: invalid API key");
        },
      });

      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains 'Session creation failed' when createSession throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        createSession: async () => {
          throw new Error("Unauthorized");
        },
      });

      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toMatch(/Session creation failed/i);
    });

    it("BridgeResult.sessionId is empty string when createSession throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        createSession: async () => {
          throw new Error("Forbidden");
        },
      });

      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.sessionId).toBe("");
    });

    it("bridge tries to send an error message to the channel after session creation failure", async () => {
      mockChannelsFetch.mockResolvedValue(makeFakeChannel());
      mockSend.mockResolvedValue({ id: "err-msg-id", edit: mockEdit });

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        createSession: async () => {
          throw new Error("Unauthorized");
        },
      });

      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeChannelMessage());

      // sendErrorMessage calls adapter.sendMessage → channel.send
      expect(mockChannelsFetch).toHaveBeenCalledWith(THREAD_ID);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.any(String) }),
      );
    });
  });

  // =========================================================================
  // 10. Concurrent thread processing guard
  // =========================================================================

  describe("concurrent thread processing guard", () => {
    it("second message to same thread returns error while first is in progress", async () => {
      let resolveFirstMessage!: () => void;
      const firstMessageBarrier = new Promise<void>((res) => { resolveFirstMessage = res; });

      // Stub that stalls the first message
      const stallingStub = {
        createSession: async () => SESSION_ID,
        async *sendMessage() {
          await firstMessageBarrier;
          yield { type: "text_delta", text: "ok" } as AgentStreamEvent;
          yield { type: "done" } as AgentStreamEvent;
        },
      };

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited" });

      const bridge = makeWiredBridge(adapter, stallingStub as unknown as StubAgentClient);
      const msg = makeChannelMessage();

      // Start first message (stalls)
      const first = bridge.handleMessage(msg);

      // Second message to same thread should be rejected immediately
      const second = await bridge.handleMessage(msg);

      expect(second.success).toBe(false);
      expect(second.error).toBe("Thread is already being processed");

      // Resolve the stall so the first message can finish
      resolveFirstMessage();
      const firstResult = await first;
      expect(firstResult.success).toBe(true);
    });

    it("second message to same thread has zero totalChars (no streaming occurred)", async () => {
      let resolveFirst!: () => void;
      const barrier = new Promise<void>((res) => { resolveFirst = res; });

      const stallingStub = {
        createSession: async () => SESSION_ID,
        async *sendMessage() {
          await barrier;
          yield { type: "done" } as AgentStreamEvent;
        },
      };

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);
      mockSend.mockResolvedValue({ id: "s", edit: mockEdit });
      mockEdit.mockResolvedValue({});

      const bridge = makeWiredBridge(adapter, stallingStub as unknown as StubAgentClient);
      const msg = makeChannelMessage();

      const first = bridge.handleMessage(msg);
      const second = await bridge.handleMessage(msg);

      expect(second.totalChars).toBe(0);
      expect(second.updateCount).toBe(0);

      resolveFirst();
      await first;
    });
  });

  // =========================================================================
  // 11. Empty message guard
  // =========================================================================

  describe("empty message guard", () => {
    it("BridgeResult.success is false for an empty text message", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage({ text: "   " }));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Empty message");
    });
  });

  // =========================================================================
  // 12. Double permission failure (startStream + fallback sendMessage both fail)
  // =========================================================================

  describe("double permission failure (startStream + sendMessage fallback)", () => {
    it("BridgeResult is returned (not thrown) when both start and fallback fail", async () => {
      // channels.fetch succeeds but send always throws
      const ch = makeFakeChannel({
        send: vi.fn().mockRejectedValue(new Error("Missing Permissions")),
      });
      mockChannelsFetch.mockResolvedValue(ch);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());

      // Must resolve (not reject) even when both send attempts fail
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result).toBeDefined();
      expect(result.success).toBe(false);

      consoleSpy.mockRestore();
    });

    it("secondary sendMessage error is swallowed and does not appear in BridgeResult.error", async () => {
      // First send throws with start-stream error; second send throws with different error
      const ch = makeFakeChannel({
        send: vi.fn()
          .mockRejectedValueOnce(new Error("50013: Missing Permissions"))  // startStream
          .mockRejectedValue(new Error("50001: Missing Access")),           // sendMessage fallback
      });
      mockChannelsFetch.mockResolvedValue(ch);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      // The BridgeResult.error should reflect the startStream failure, not the secondary
      expect(result.error).toMatch(/Stream start failed.*50013/i);

      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 13. Agent stream error event (permission/auth error from Claude)
  // =========================================================================

  describe("agent stream error events (permission/auth errors from Claude API)", () => {
    it("BridgeResult.success is false when agent stream emits an error event", async () => {
      mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited" });

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "error", error: "Unauthorized: invalid API key" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains the agent's error message", async () => {
      mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited" });

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "error", error: "authorization token is invalid or expired" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toContain("authorization token is invalid or expired");
    });

    it("bridge calls stream.finish() with formatted error when agent emits error event", async () => {
      const editFn = vi.fn().mockResolvedValue({});
      const sentMsg = { id: "sent-msg-id", edit: editFn };
      const ch = makeFakeChannel({ send: vi.fn().mockResolvedValue(sentMsg) });
      mockChannelsFetch.mockResolvedValue(ch);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "error", error: "stream permission denied" },
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // finish() was called with the formatted error text
      const lastCall = editFn.mock.calls.at(-1)?.[0] as { content?: string } | undefined;
      expect(lastCall?.content).toMatch(/error/i);
    });
  });

  // =========================================================================
  // 14. Disconnect during processing (abortAll)
  // =========================================================================

  describe("abortAll during active processing", () => {
    it("abortAll() returns the count of active threads that were aborted", async () => {
      let resolveStream!: () => void;
      const barrier = new Promise<void>((r) => { resolveStream = r; });

      const stallingStub = {
        createSession: async () => SESSION_ID,
        async *sendMessage(_id: string, _text: string, opts?: { signal?: AbortSignal }) {
          await barrier;
          if (opts?.signal?.aborted) return;
          yield { type: "done" } as AgentStreamEvent;
        },
      };

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);
      mockSend.mockResolvedValue({ id: "s", edit: mockEdit });
      mockEdit.mockResolvedValue({});

      const bridge = makeWiredBridge(adapter, stallingStub as unknown as StubAgentClient);

      const msgA = makeChannelMessage({ channelId: "G-A", threadId: "T-A" });
      const msgB = makeChannelMessage({ channelId: "G-B", threadId: "T-B" });

      const p1 = bridge.handleMessage(msgA);
      const p2 = bridge.handleMessage(msgB);

      // Two threads should be active
      expect(bridge.activeThreadCount).toBe(2);

      const aborted = bridge.abortAll();
      expect(aborted).toBe(2);

      resolveStream();
      await Promise.allSettled([p1, p2]);
    });
  });
});
