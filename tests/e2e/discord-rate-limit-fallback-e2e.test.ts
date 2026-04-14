/**
 * E2E test suite: Discord ↔ StreamingBridge — rate-limit fallback
 *
 * Architecture:
 *   - Discord.js is fully mocked (no live Discord API calls)
 *   - Claude Managed Agent is stubbed via a minimal in-process stub
 *   - All components wired in-process (StreamingBridge + DiscordAdapter + StubAgentClient)
 *   - vi.useFakeTimers({ now: 0 }) pins Date.now() at 0 so scheduled flushes
 *     always defer (delay = 1 000ms > 0 → setTimeout, never fires automatically).
 *     finish() cancels the pending timer and drains the buffer synchronously.
 *
 * ## Rate-limit fallback paths in DiscordStreamHandle
 *
 * **Path A — Pre-rate-limited (channel already tracked when stream starts)**
 *   DiscordStreamHandle constructor calls rateLimitTracker.isRateLimited(channelId).
 *   If true → _inFallbackMode = true immediately.  No edit is ever attempted.
 *   finish() posts the full buffer via channel.send().
 *
 * **Path B — 429 during streaming (appendTasks init-indicator edit throws)**
 *   StreamingBridge always calls stream.appendTasks([initTask]) right after
 *   startStream().  appendTasks() calls message.edit() directly (bypasses the
 *   1-second cadence timer).  If that edit throws a Discord 429, the catch
 *   block calls _handleRateLimitError(), which sets _inFallbackMode = true
 *   and records the hit in the shared rateLimitTracker.  All subsequent
 *   append() calls buffer silently; finish() posts via channel.send().
 *
 * ## "No partial edits left behind" invariant
 *
 * In both paths the initial placeholder ("⏳ Thinking…") is never partially
 * modified:
 *   - Path A: no edit is attempted, placeholder is never touched.
 *   - Path B: the single edit attempt (from appendTasks) was rejected by
 *     Discord (429), so the placeholder content is unchanged on Discord's side.
 *     The final response arrives as a NEW message via channel.send().
 *
 * ## Scenario categories covered
 *
 *  1. Pre-rate-limited channel: fallback mode at stream construction
 *  2. 429 during appendTasks (init indicator): mid-stream switch to fallback
 *  3. retry_after extraction: tracker stores correct cooldown duration
 *  4. adapter.isChannelRateLimited() reflects live 429 state
 *  5. Content integrity: all accumulated text delivered via channel.send()
 *  6. No partial edits: placeholder message unchanged after fallback switch
 *  7. Empty response in fallback: "(no response)" posted via channel.send()
 *  8. Overflow in fallback: >2 K response chunked into multiple channel.send() calls
 *  9. BridgeResult: success=true, totalChars accurate even in fallback
 * 10. Consecutive streams: second stream on same channel auto-enters fallback
 * 11. DM channel: rate-limit fallback works identically for DM channels
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
// Hoisted module-level mocks, same pattern as discord-happy-path-e2e.test.ts.
// All mock functions are reset in beforeEach; individual tests override via
// mockResolvedValueOnce / mockRejectedValueOnce as needed.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => unknown;

/** Persistent listeners (client.on) keyed by event name. */
const onListeners: Record<string, Listener[]> = {};
/** One-shot listeners (client.once) keyed by event name. */
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
      onListeners[event]!.push(listener);
      return this;
    }

    once(event: string, listener: Listener) {
      if (!onceListeners[event]) onceListeners[event] = [];
      onceListeners[event]!.push(listener);
      return this;
    }

    login = mockLogin;
    destroy = mockDestroy;
  }

  return {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768, DirectMessages: 4096 },
    Partials: { Channel: "Channel", Message: "Message" },
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

// Import AFTER the mock is registered.
import { DiscordAdapter } from "../../src/channels/discord/index.js";
import {
  THINKING_PLACEHOLDER,
  DISCORD_MESSAGE_LIMIT,
  RATE_LIMIT_DEFAULT_COOLDOWN_MS,
} from "../../src/channels/discord/constants.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_ID = "RL_FALLBACK_BOT_7001";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";
const GUILD_ID = "GUILD-RL-E2E-001";
const THREAD_ID = "THREAD-RL-E2E-001";
const MSG_ID = "MSG-RL-E2E-001";
const SESSION_ID = "session-rl-fallback-e2e-abc";

// ---------------------------------------------------------------------------
// 429 error factory
// ---------------------------------------------------------------------------

/**
 * Build a Discord-style 429 error that DiscordRateLimitTracker.isRateLimitError()
 * will recognise (status === 429).  Optionally includes retryAfter (seconds)
 * for DiscordRateLimitTracker.extractRetryAfter().
 */
function make429Error(retryAfterSeconds?: number): Error {
  return Object.assign(
    new Error("HTTP 429: You are being rate limited."),
    {
      status: 429,
      ...(retryAfterSeconds !== undefined ? { retryAfter: retryAfterSeconds } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// StubAgentClient
// ---------------------------------------------------------------------------

/**
 * Minimal stub satisfying the SessionOutputReader + StreamingBridge contract.
 * Configurable session ID and event sequence.
 */
class StubAgentClient {
  private readonly _sessionId: string;
  private readonly _events: AgentStreamEvent[];

  constructor(
    options: {
      sessionId?: string;
      events?: AgentStreamEvent[];
    } = {},
  ) {
    this._sessionId = options.sessionId ?? SESSION_ID;
    this._events = options.events ?? [
      { type: "text_delta", text: "Hello, world!" } as AgentStreamEvent,
      { type: "done" } as AgentStreamEvent,
    ];
  }

  async createSession(): Promise<string> {
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
 * Simulate the Discord "ready" event so adapter.connect() resolves and
 * this.botUserId is populated before message handling begins.
 */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) l({ user: { id: botId, tag: "RateLimitBot#0001" } });
  await connectPromise;
}

/**
 * Build a ChannelMessage with sensible defaults for a guild @mention.
 * threadId MUST equal the Discord channel/thread ID used by fetchTextChannel()
 * (not the guildId) per the AC 3 thread-fetch contract.
 */
function makeChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: MSG_ID,
    channelId: GUILD_ID,  // guildId — used as the session-key prefix
    threadId: THREAD_ID,  // actual Discord channel ID — used for fetching/sending
    userId: "user-rl-e2e-001",
    text: "What is 1 + 1?",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

/**
 * Build a minimal fake sendable GuildText channel backed by mock functions.
 */
function makeFakeChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 0, // ChannelType.GuildText
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
    ...overrides,
  };
}

/**
 * Wire a StreamingBridge with the given adapter and stub client.
 * Retries disabled for fast, deterministic tests.
 */
function makeWiredBridge(
  adapter: DiscordAdapter,
  stubClient: StubAgentClient,
): StreamingBridge {
  return new StreamingBridge({
    adapter,
    agentClient: stubClient as unknown as AgentClient,
    sessionManager: new SessionManager(),
    maxRetries: 0,
    retryDelayMs: 0,
  });
}

/**
 * Return the content string from the Nth mockSend call (0-based).
 * Negative indices count from the end (e.g. -1 = last call).
 */
function getSendContent(index: number): string {
  const calls = mockSend.mock.calls;
  const i = index < 0 ? calls.length + index : index;
  const call = calls[i];
  if (!call) {
    throw new Error(`No send call at index ${index}; total calls: ${calls.length}`);
  }
  return (call[0] as { content: string }).content;
}

/**
 * Return all content strings passed to channel.send(), excluding the initial
 * placeholder so assertions focus on the actual response content.
 */
function getResponseSendContents(): string[] {
  return mockSend.mock.calls
    .map((c) => (c[0] as { content: string }).content)
    .filter((content) => content !== THINKING_PLACEHOLDER);
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Pin Date.now() at 0 so DiscordStreamHandle.scheduleFlush() always defers:
  //   elapsed = Date.now() - lastEditTime = 0 - 0 = 0
  //   delay   = STREAM_EDIT_INTERVAL_MS - elapsed = 1000ms → setTimeout
  // The timer never fires; finish() cancels it and flushes synchronously.
  // This makes every test deterministic — we never depend on real wall-clock timing.
  vi.useFakeTimers({ now: 0 });

  vi.clearAllMocks();

  // Reset listener maps between tests.
  for (const k of Object.keys(onListeners)) delete onListeners[k];
  for (const k of Object.keys(onceListeners)) delete onceListeners[k];

  // Default mock behaviours (individual tests override as needed).
  mockLogin.mockResolvedValue(undefined);
  mockSendTyping.mockResolvedValue(undefined);
  mockChannelsFetch.mockResolvedValue(makeFakeChannel());
  // Each channel.send() returns a message with the shared mockEdit.
  mockSend.mockResolvedValue({ id: "msg-placeholder", edit: mockEdit });
  mockEdit.mockResolvedValue({ id: "msg-edited" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // Remove any SIGINT/SIGTERM handlers registered by serve/bridge code in-process
  // to prevent signal-handler stacking across tests (Coordinator Warning #3).
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Discord ↔ StreamingBridge: rate-limit fallback", () => {
  // =========================================================================
  // 1. Pre-rate-limited channel (Path A)
  //
  // A 429 hit is already recorded for THREAD_ID in the adapter's tracker
  // when startStream() is called.  DiscordStreamHandle enters fallback mode
  // immediately at construction — no Discord API edits are ever attempted.
  // =========================================================================

  describe("pre-rate-limited channel", () => {
    it("enters fallback mode immediately when channel has an active 429 cooldown", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Seed the tracker with a 429 hit for this thread before the stream starts.
      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "The answer is 2." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // Bridge must complete successfully even in fallback mode.
      expect(result.success).toBe(true);
      // Channel must still be reported as rate-limited (cooldown has not expired
      // because fake timers keep Date.now() fixed at 0).
      expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);
    });

    it("never calls message.edit() when channel is pre-rate-limited", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // In fallback mode: appendTasks() is a no-op, append() buffers silently,
      // and finish() posts via channel.send().  message.edit() must never fire.
      expect(mockEdit).not.toHaveBeenCalled();
    });

    it("posts full response via channel.send() at finish, not by editing the placeholder", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      const responseText = "The answer is 2.";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: responseText } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // channel.send() must be called exactly twice:
      //   call[0] — placeholder ("⏳ Thinking…") posted by DiscordAdapter.startStream()
      //   call[1] — full response posted by finish() in fallback mode
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(getSendContent(0)).toBe(THINKING_PLACEHOLDER);
      expect(getSendContent(1)).toBe(responseText);
    });

    it("leaves the placeholder message unchanged — no edits at any point", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // The placeholder is posted by channel.send() (call index 0) and must
      // remain THINKING_PLACEHOLDER throughout — never edited.
      expect(mockEdit).not.toHaveBeenCalled();
      expect(getSendContent(0)).toBe(THINKING_PLACEHOLDER);
    });

    it("posts the empty-response fallback text via channel.send() when stream yields no text in fallback mode", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      // No text_delta events — agent produced no output.
      const events: AgentStreamEvent[] = [
        { type: "done" } as AgentStreamEvent,
      ];
      // Configure a recognisable emptyResponseText so finish() delivers it via
      // channel.send() in fallback mode (StreamingBridge passes emptyResponseText
      // to stream.finish() when fullText is empty).
      const EMPTY_TEXT = "(no response)";
      const bridge = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient({ events }) as unknown as AgentClient,
        sessionManager: new SessionManager(),
        maxRetries: 0,
        retryDelayMs: 0,
        emptyResponseText: EMPTY_TEXT,
      });
      await bridge.handleMessage(makeChannelMessage());

      // finish() in fallback mode must post the empty-response text via channel.send()
      // so the user always sees a reply; the placeholder is never the last message.
      const allSendContents = mockSend.mock.calls.map(
        (c) => (c[0] as { content: string }).content,
      );
      expect(allSendContents).toContain(EMPTY_TEXT);
    });

    it("chunks a >2 000-char response across multiple channel.send() calls in fallback mode", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      // Build a response longer than one Discord message (2 000 + 1 000 = 3 000 chars).
      const part1 = "A".repeat(DISCORD_MESSAGE_LIMIT);      // chars 0–1 999
      const part2 = "B".repeat(DISCORD_MESSAGE_LIMIT / 2); // chars 2 000–2 999
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: part1 } as AgentStreamEvent,
        { type: "text_delta", text: part2 } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // Expected: placeholder (index 0) + chunk 1 (index 1) + chunk 2 (index 2).
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(getSendContent(1)).toBe(part1);
      expect(getSendContent(2)).toBe(part2);
    });
  });

  // =========================================================================
  // 2. 429 received during appendTasks (Path B — mid-stream switch)
  //
  // StreamingBridge always calls stream.appendTasks([initTask]) right after
  // startStream().  appendTasks() calls message.edit() directly, bypassing
  // the 1-second cadence timer.  If edit() throws a 429, _handleRateLimitError()
  // switches the handle to fallback mode before any text_delta arrives.
  // finish() then posts via channel.send() and never edits the placeholder.
  // =========================================================================

  describe("429 received during appendTasks (init indicator edit)", () => {
    it("switches to fallback mode when the init-indicator edit throws a 429", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // The first (and only) edit attempt — from appendTasks — must fail with 429.
      mockEdit.mockRejectedValueOnce(make429Error());

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      // Bridge must complete successfully; fallback mode is transparent to callers.
      expect(result.success).toBe(true);
      // Adapter's shared tracker must reflect the hit.
      expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);
    });

    it("makes no further edit attempts after the 429 from appendTasks", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      // Three text_delta events so there is plenty of content to buffer.
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "chunk1" } as AgentStreamEvent,
        { type: "text_delta", text: "chunk2" } as AgentStreamEvent,
        { type: "text_delta", text: "chunk3" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // Exactly one edit attempt (the failed appendTasks call) must have occurred.
      // All subsequent content arrives via channel.send() — no additional edit calls.
      expect(mockEdit).toHaveBeenCalledTimes(1);
    });

    it("delivers all accumulated text via channel.send() at finish — no content lost", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const parts = ["Hello", ", ", "world", "!"];
      const expectedText = parts.join(""); // "Hello, world!"
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // The last channel.send() must carry the full accumulated text — nothing dropped.
      expect(getSendContent(-1)).toBe(expectedText);
    });

    it("leaves the placeholder unchanged — the failed edit is the only attempt", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // The first channel.send() is the placeholder posted by startStream().
      // The failed edit (from appendTasks) was rejected by Discord — so the
      // placeholder's actual content on Discord's side was never changed.
      // Confirm the placeholder content string is unchanged.
      expect(getSendContent(0)).toBe(THINKING_PLACEHOLDER);

      // The response must arrive as a separate channel.send() call — not an edit.
      // There must be at least one additional send beyond the placeholder.
      expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("records the 429 hit in the shared rate-limit tracker", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // The 429 from appendTasks must be reflected in the shared tracker.
      expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);
      // Remaining cooldown must be positive (default 5 000 ms with fake timers at 0).
      expect(adapter.getRateLimitTracker().getRemainingCooldown(THREAD_ID)).toBeGreaterThan(0);
    });

    it("BridgeResult.success is true even after a mid-stream 429", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(true);
    });

    it("BridgeResult.totalChars counts all text_delta chars even in fallback mode", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const parts = ["Alpha", " Beta", " Gamma"];
      const expectedChars = parts.reduce((sum, p) => sum + p.length, 0);
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.totalChars).toBe(expectedChars);
    });

    it("posts the empty-response fallback text via channel.send() when stream yields no text after a 429", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      // No text_delta events — only a 429 from appendTasks then done.
      const events: AgentStreamEvent[] = [
        { type: "done" } as AgentStreamEvent,
      ];
      // Configure a recognisable emptyResponseText so finish() delivers it via
      // channel.send() in fallback mode.
      const EMPTY_TEXT = "(no response)";
      const bridge = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient({ events }) as unknown as AgentClient,
        sessionManager: new SessionManager(),
        maxRetries: 0,
        retryDelayMs: 0,
        emptyResponseText: EMPTY_TEXT,
      });
      await bridge.handleMessage(makeChannelMessage());

      const allSendContents = mockSend.mock.calls.map(
        (c) => (c[0] as { content: string }).content,
      );
      expect(allSendContents).toContain(EMPTY_TEXT);
    });
  });

  // =========================================================================
  // 3. retry_after value extraction and tracker state
  //
  // Discord 429 responses include an optional retry_after field (in seconds).
  // DiscordRateLimitTracker.extractRetryAfter() converts it to milliseconds.
  // The tracker stores it so future streams know how long to wait.
  // =========================================================================

  describe("retry_after extraction and tracker state", () => {
    it("stores RATE_LIMIT_DEFAULT_COOLDOWN_MS when 429 has no retry_after field", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // 429 without retryAfter — tracker must apply the default 5 000 ms cooldown.
      mockEdit.mockRejectedValueOnce(make429Error());

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // With fake timers at now=0: detectedAt=0, retryAfterMs=5000.
      // getRemainingCooldown = 0 + 5000 - 0 = 5000 ms.
      const remaining = adapter.getRateLimitTracker().getRemainingCooldown(THREAD_ID);
      expect(remaining).toBe(RATE_LIMIT_DEFAULT_COOLDOWN_MS);
    });

    it("stores the retry_after duration (in ms) from the 429 response body", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const retryAfterSeconds = 3.5;
      // 429 with retryAfter field (seconds, as discord.js exposes it).
      mockEdit.mockRejectedValueOnce(make429Error(retryAfterSeconds));

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // extractRetryAfter: Math.ceil(3.5 * 1000) = 3500 ms.
      // With fake timers at now=0: getRemainingCooldown = 0 + 3500 - 0 = 3500 ms.
      const remaining = adapter.getRateLimitTracker().getRemainingCooldown(THREAD_ID);
      expect(remaining).toBe(Math.ceil(retryAfterSeconds * 1000));
    });

    it("isChannelRateLimited() returns true immediately after a 429", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error(5));

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);
    });

    it("rateLimitedCount increases after a 429 and is positive", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      expect(adapter.getRateLimitTracker().rateLimitedCount).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. Overflow in fallback mode
  //
  // When the accumulated response exceeds DISCORD_MESSAGE_LIMIT (2 000 chars)
  // and the handle is in fallback mode, finish() must split the buffer into
  // ≤2 000-char chunks, each posted via a separate channel.send() call.
  // No edits are made — all chunks arrive as new messages.
  // =========================================================================

  describe("overflow in fallback mode", () => {
    it("posts a 2 000-char response as a single channel.send() call (no chunking needed)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const exactly2K = "X".repeat(DISCORD_MESSAGE_LIMIT); // exactly 2 000 chars
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: exactly2K } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // 2 000 chars fits in one message — one content send (plus placeholder).
      const contentSends = getResponseSendContents();
      expect(contentSends).toHaveLength(1);
      expect(contentSends[0]).toBe(exactly2K);
    });

    it("splits a 2 001+ char response across exactly two channel.send() calls", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const firstChunk = "A".repeat(DISCORD_MESSAGE_LIMIT); // 2 000 chars
      const secondChunk = "B".repeat(500);                   //   500 chars
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: firstChunk } as AgentStreamEvent,
        { type: "text_delta", text: secondChunk } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      const contentSends = getResponseSendContents();
      expect(contentSends).toHaveLength(2);
      expect(contentSends[0]).toBe(firstChunk);
      expect(contentSends[1]).toBe(secondChunk);
    });

    it("splits a 5 000-char response across three channel.send() calls (2k+2k+1k)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      mockEdit.mockRejectedValueOnce(make429Error());

      const text5K = "C".repeat(5000); // 2 000 + 2 000 + 1 000 chars
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: text5K } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      const contentSends = getResponseSendContents();
      expect(contentSends).toHaveLength(3);
      expect(contentSends[0]).toBe("C".repeat(2000));
      expect(contentSends[1]).toBe("C".repeat(2000));
      expect(contentSends[2]).toBe("C".repeat(1000));
    });

    it("content integrity: all chars present across overflow chunks in fallback", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      adapter.getRateLimitTracker().recordHit(THREAD_ID);

      // Interleave multiple text_delta events spanning > 2 K chars total.
      const parts = [
        "A".repeat(800),
        "B".repeat(800),
        "C".repeat(800),
      ]; // 2 400 chars total
      const expectedFull = parts.join("");
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // Reassemble all response chunks and verify no content was dropped.
      const contentSends = getResponseSendContents();
      const reassembled = contentSends.join("");
      expect(reassembled).toBe(expectedFull);
    });
  });

  // =========================================================================
  // 5. Consecutive streams — second stream auto-enters fallback
  //
  // After a 429, the adapter's rate-limit tracker retains the hit for the
  // channel's cooldown duration.  A second handleMessage() call on the SAME
  // adapter (and thus the same tracker) before the cooldown expires must
  // auto-enter fallback mode at DiscordStreamHandle construction.
  // =========================================================================

  describe("consecutive streams after 429", () => {
    it("second stream on the same channel auto-enters fallback mode", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // First stream: 429 from appendTasks.
      mockEdit.mockRejectedValueOnce(make429Error());
      const bridge1 = makeWiredBridge(adapter, new StubAgentClient());
      await bridge1.handleMessage(makeChannelMessage({ text: "first message" }));

      // Verify the first stream recorded the 429.
      expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);

      // Reset mock call counts so second-stream assertions are clean.
      vi.clearAllMocks();
      mockChannelsFetch.mockResolvedValue(makeFakeChannel());
      mockSend.mockResolvedValue({ id: "msg-second", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited-second" });

      // Second stream: channel is still rate-limited (fake timers at now=0,
      // cooldown has not expired).  DiscordStreamHandle constructor detects
      // the active cooldown → enters fallback mode immediately.
      const bridge2 = makeWiredBridge(adapter, new StubAgentClient());
      await bridge2.handleMessage(makeChannelMessage({ text: "second message" }));

      // No edits must have occurred in the second stream (fallback at construction).
      expect(mockEdit).not.toHaveBeenCalled();
      // Content delivered via channel.send() only: placeholder + response.
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("second stream content is fully delivered via channel.send() after first-stream 429", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // First stream: 429.
      mockEdit.mockRejectedValueOnce(make429Error());
      const bridge1 = makeWiredBridge(adapter, new StubAgentClient());
      await bridge1.handleMessage(makeChannelMessage({ text: "first message" }));

      vi.clearAllMocks();
      mockChannelsFetch.mockResolvedValue(makeFakeChannel());
      mockSend.mockResolvedValue({ id: "msg-second", edit: mockEdit });
      mockEdit.mockResolvedValue({ id: "edited-second" });

      const secondResponse = "Second response text.";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: secondResponse } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge2 = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge2.handleMessage(makeChannelMessage({ text: "second message" }));

      // The second stream's response must arrive as the last channel.send().
      expect(getSendContent(-1)).toBe(secondResponse);
    });
  });

  // =========================================================================
  // 6. DM channel rate-limit fallback
  //
  // DMs use the "@dm" sentinel as guildId and the actual DM channel ID as
  // threadId.  Rate-limit tracking and fallback behaviour must be identical
  // to guild channels since DiscordStreamHandle only uses channelId (threadId).
  // =========================================================================

  describe("DM channel rate-limit fallback", () => {
    it("enters fallback mode for a pre-rate-limited DM channel", async () => {
      const DM_CHANNEL_ID = "DM-CHANNEL-RL-E2E-001";
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Seed a 429 hit for the DM thread ID (not the sentinel guildId).
      adapter.getRateLimitTracker().recordHit(DM_CHANNEL_ID);

      const responseText = "DM reply in fallback mode.";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: responseText } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(
        makeChannelMessage({
          channelId: "@dm",       // sentinel guildId for session key
          threadId: DM_CHANNEL_ID, // actual DM channel ID for fetching/sending
          isDirectMessage: true,
          isMention: false,
        }),
      );

      // No edits — DM channel was pre-rate-limited.
      expect(mockEdit).not.toHaveBeenCalled();
      // Full response delivered via channel.send().
      expect(getSendContent(-1)).toBe(responseText);
    });

    it("does not confuse DM channel rate-limit with guild channel rate-limit", async () => {
      const DM_CHANNEL_ID = "DM-CHANNEL-RL-E2E-002";
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Rate-limit the DM channel only — the guild THREAD_ID must be unaffected.
      adapter.getRateLimitTracker().recordHit(DM_CHANNEL_ID);

      expect(adapter.isChannelRateLimited(DM_CHANNEL_ID)).toBe(true);
      expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(false);
    });
  });
});
