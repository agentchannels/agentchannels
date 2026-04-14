/**
 * E2E test suite: Discord ↔ StreamingBridge — mid-stream failure handling
 *
 * Architecture:
 *   - Discord.js is fully mocked (no live Discord API calls)
 *   - Claude Managed Agent is stubbed via a minimal in-process stub
 *   - All components wired in-process (StreamingBridge + DiscordAdapter + StubAgentClient)
 *
 * ## What "mid-stream failure" means
 *
 * A mid-stream failure occurs when the stream has already started and at least
 * one text_delta has been emitted, but before the stream terminates cleanly:
 *
 *   Phase sequence: session_resolve → stream_start → streaming → [FAILURE] → cleanup
 *
 * This is distinct from:
 *   - Session creation failure (before streaming starts)
 *   - Stream start failure (channel fetch / send placeholder fails)
 *
 * ## Scenario categories covered
 *
 *   1. Agent error event after partial text — agent emits `{ type: "error" }` mid-stream.
 *      BridgeResult.success=false, BridgeResult.error non-empty, totalChars counts
 *      partial chars, finish() is called with the formatted error message.
 *
 *   2. Generator throw mid-stream — sendMessage() generator throws synchronously
 *      during iteration after yielding some text_delta events. Bridge outer catch fires,
 *      stream.finish() is called with formatted error text, BridgeResult.success=false.
 *
 *   3. finish() failure after error event — stream.finish() throws after an error
 *      event, but bridge swallows it with .catch(() => {}). No unhandled rejection.
 *
 *   4. Edit failure during streaming is caught gracefully — message.edit() throws a
 *      non-rate-limit error during finish(). Bridge catches it via the outer catch,
 *      returns BridgeResult.success=false, and no unhandled rejections occur.
 *
 *   5. Bridge phase sequence on mid-stream error — onPhaseChange callback records
 *      the correct sequence: streaming → error → cleanup.
 *
 *   6. Thread released after mid-stream error — isThreadActive() is false once
 *      handleMessage() resolves, so the thread can be reused.
 *
 *   7. Session persisted across error — even on mid-stream error the session is
 *      stored in SessionManager so subsequent messages in the same thread reuse it.
 *
 *   8. Partial chars accounted — totalChars = length of text_delta events that
 *      arrived BEFORE the error (not the error message itself).
 *
 *   9. Error text in final Discord edit — finish() is called with the formatted
 *      error string, which ends up as the content passed to message.edit().
 *
 *  10. DM channel mid-stream error — same error semantics apply when the message
 *      originates from a DM (channelId = "@dm" sentinel).
 *
 *  11. Empty partial text before error — totalChars=0 when error fires immediately
 *      before any text_delta events.
 *
 *  12. updateCount reflects only deltas before the error — updates accumulate per
 *      text_delta event; the error itself does not increment updateCount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelMessage } from "../../src/core/channel-adapter.js";
import type { AgentStreamEvent } from "../../src/core/chunk-parser.js";
import type { AgentClient } from "../../src/core/agent-client.js";
import type { BridgePhase } from "../../src/core/streaming-bridge.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { StreamingBridge } from "../../src/core/streaming-bridge.js";

// ---------------------------------------------------------------------------
// Discord.js mock
//
// Follows the same module-level mock pattern used in all Discord E2E tests.
// Mock functions are reset in beforeEach; listener maps are cleared between tests.
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

// Import AFTER mock is registered
import { DiscordAdapter } from "../../src/channels/discord/index.js";
import { DM_GUILD_SENTINEL } from "../../src/channels/discord/constants.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_ID = "MIDSTREAM_BOT_6001";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";
const GUILD_ID = "GUILD-MIDSTREAM-E2E-001";
const THREAD_ID = "THREAD-MIDSTREAM-E2E-001";
const MSG_ID = "MSG-MIDSTREAM-E2E-001";
const SESSION_ID = "session-midstream-e2e-abc";

// ---------------------------------------------------------------------------
// StubAgentClient — configurable for mid-stream failures
// ---------------------------------------------------------------------------

/**
 * Minimal stub satisfying the SessionOutputReader + StreamingBridge contract.
 *
 * Supports three failure injection modes:
 *  - `events`: explicit event sequence (use `{ type: "error", error: "..." }` for error events)
 *  - `throwAt`: throw an Error at this 0-based iteration index (simulates network failure).
 *    The throw fires BEFORE yielding the event at that index (or after all events if
 *    throwAt >= events.length). This allows the throw to occur mid-stream after N
 *    successful text_delta events.
 *  - `createSession`: override the createSession() return value (e.g. to throw)
 */
class StubAgentClient {
  private readonly _sessionId: string;
  private readonly _events: AgentStreamEvent[];
  private readonly _throwAt?: number;
  private readonly _createSessionFn?: () => Promise<string>;

  constructor(
    options: {
      sessionId?: string;
      events?: AgentStreamEvent[];
      /** Throw at this 0-based iteration index (may be >= events.length to throw after all events) */
      throwAt?: number;
      createSession?: () => Promise<string>;
    } = {},
  ) {
    this._sessionId = options.sessionId ?? SESSION_ID;
    this._events = options.events ?? [
      { type: "text_delta", text: "Hello" } as AgentStreamEvent,
      { type: "done" } as AgentStreamEvent,
    ];
    this._throwAt = options.throwAt;
    this._createSessionFn = options.createSession;
  }

  async createSession(): Promise<string> {
    if (this._createSessionFn) return this._createSessionFn();
    return this._sessionId;
  }

  async *sendMessage(
    _sessionId: string,
    _text: string,
    _options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentStreamEvent> {
    // The iteration range covers both the event array AND any throwAt position
    // beyond the end of the array. This ensures throwAt fires even when it is
    // >= events.length (i.e. after all events have been yielded).
    const limit = Math.max(
      this._events.length,
      this._throwAt !== undefined ? this._throwAt + 1 : 0,
    );

    for (let i = 0; i < limit; i++) {
      // Check throw BEFORE yielding at this index
      if (this._throwAt !== undefined && i === this._throwAt) {
        throw new Error("network connection interrupted");
      }
      // Yield the event at this index (if one exists)
      if (i < this._events.length) {
        yield this._events[i]!;
      }
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
  for (const l of readyListeners) l({ user: { id: botId, tag: "MidstreamBot#0001" } });
  await connectPromise;
}

/**
 * Build a ChannelMessage with sensible defaults for a guild @mention.
 */
function makeChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: MSG_ID,
    channelId: GUILD_ID,
    threadId: THREAD_ID,
    userId: "user-midstream-001",
    text: "Tell me something",
    isMention: true,
    isDirectMessage: false,
    ...overrides,
  };
}

/**
 * Build a ChannelMessage representing a DM.
 */
function makeDMChannelMessage(dmChannelId: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: MSG_ID,
    channelId: DM_GUILD_SENTINEL,
    threadId: dmChannelId,
    userId: "user-midstream-dm-001",
    text: "Tell me something via DM",
    isMention: false,
    isDirectMessage: true,
    ...overrides,
  };
}

/**
 * Build a minimal fake sendable GuildText channel.
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
 * Retries are disabled for fast, deterministic tests.
 */
function makeWiredBridge(
  adapter: DiscordAdapter,
  stubClient: StubAgentClient,
  sessionManager?: SessionManager,
): StreamingBridge {
  return new StreamingBridge({
    adapter,
    agentClient: stubClient as unknown as AgentClient,
    sessionManager: sessionManager ?? new SessionManager(),
    maxRetries: 0,
    retryDelayMs: 0,
  });
}

/**
 * Extract the content string from a mockEdit call at the given index.
 * Negative indexes work from the end (e.g. -1 = last call).
 */
function getEditContent(index: number): string {
  const calls = mockEdit.mock.calls;
  const i = index < 0 ? calls.length + index : index;
  const call = calls[i];
  if (!call) throw new Error(`No edit call at index ${index}; total calls: ${calls.length}`);
  return (call[0] as { content: string }).content;
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Fix Date.now() at 0 so DiscordStreamHandle.scheduleFlush() always defers
  // (elapsed = 0 - 0 = 0 < STREAM_EDIT_INTERVAL_MS=1000 → timer, never fires).
  // finish() cancels any pending timer and flushes synchronously.
  vi.useFakeTimers({ now: 0 });

  vi.clearAllMocks();

  // Reset listener maps between tests
  for (const k of Object.keys(onListeners)) delete onListeners[k];
  for (const k of Object.keys(onceListeners)) delete onceListeners[k];

  // Default mock behaviours
  mockLogin.mockResolvedValue(undefined);
  mockSendTyping.mockResolvedValue(undefined);
  mockChannelsFetch.mockResolvedValue(makeFakeChannel());
  mockSend.mockResolvedValue({ id: "msg-placeholder", edit: mockEdit });
  mockEdit.mockResolvedValue({ id: "msg-edited" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // Remove SIGINT/SIGTERM handlers to prevent stacking across tests.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Discord ↔ StreamingBridge: mid-stream failure handling", () => {
  // =========================================================================
  // 1. Agent error event after partial text
  //
  // The agent emits some text_delta events followed by an `error` event.
  // StreamingBridge routes the error to the `error` listener which sets
  // streamError. After reader.start() resolves, finish() is called with the
  // formatted error and BridgeResult.success=false.
  // =========================================================================

  describe("agent error event after partial text deltas", () => {
    const PARTIAL_TEXT = "I started answering but then ";
    const ERROR_MSG = "internal_server_error: upstream timeout";

    const eventsWithMidError: AgentStreamEvent[] = [
      { type: "text_delta", text: PARTIAL_TEXT } as AgentStreamEvent,
      { type: "error", error: ERROR_MSG } as AgentStreamEvent,
    ];

    it("BridgeResult.success is false when agent emits error event mid-stream", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events: eventsWithMidError }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains the agent error text", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events: eventsWithMidError }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toBeDefined();
      expect(result.error).toContain(ERROR_MSG);
    });

    it("BridgeResult.sessionId matches the stub session", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ sessionId: SESSION_ID, events: eventsWithMidError }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.sessionId).toBe(SESSION_ID);
    });

    it("BridgeResult.totalChars counts only the partial text deltas received before the error", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events: eventsWithMidError }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // Only the text from text_delta events — not the error message itself
      expect(result.totalChars).toBe(PARTIAL_TEXT.length);
    });

    it("finish() is called with the formatted error message (last Discord edit contains error text)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events: eventsWithMidError }));
      await bridge.handleMessage(makeChannelMessage());

      // finish() writes the formatted error to the Discord message via message.edit()
      expect(mockEdit).toHaveBeenCalled();
      const lastEditContent = getEditContent(-1);
      expect(lastEditContent).toContain(ERROR_MSG);
    });

    it("message.send (placeholder) is called exactly once before streaming begins", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events: eventsWithMidError }));
      await bridge.handleMessage(makeChannelMessage());

      // One send() = initial placeholder from startStream()
      expect(mockSend).toHaveBeenCalledTimes(1);
      const sendContent = (mockSend.mock.calls[0]![0] as { content: string }).content;
      expect(sendContent).toMatch(/thinking/i);
    });
  });

  // =========================================================================
  // 2. Generator throw mid-stream (simulated network failure)
  //
  // The sendMessage() generator throws at a specific index after emitting
  // some text_delta events. StreamingBridge's outer catch block fires,
  // calls stream.finish() with the formatted error.
  //
  // Implementation note: StubAgentClient uses an extended loop that runs
  // from 0 to max(events.length, throwAt+1), ensuring the throw fires even
  // when throwAt >= events.length (i.e. after all events are yielded).
  // =========================================================================

  describe("generator throws during iteration (network interruption)", () => {
    const PRE_ERROR_TEXT_1 = "Here is the first part ";
    const PRE_ERROR_TEXT_2 = "and the second part ";

    // throwAt=2: yield events[0] and events[1], then throw at index 2
    const eventsBeforeThrow: AgentStreamEvent[] = [
      { type: "text_delta", text: PRE_ERROR_TEXT_1 } as AgentStreamEvent,
      { type: "text_delta", text: PRE_ERROR_TEXT_2 } as AgentStreamEvent,
    ];

    it("BridgeResult.success is false when the generator throws after emitting text", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: eventsBeforeThrow, throwAt: 2 }),
      );
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains the thrown error message", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: eventsBeforeThrow, throwAt: 2 }),
      );
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toBeDefined();
      expect(result.error).toContain("network connection interrupted");
    });

    it("BridgeResult.totalChars counts chars from text_delta events delivered before the throw", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: eventsBeforeThrow, throwAt: 2 }),
      );
      const result = await bridge.handleMessage(makeChannelMessage());

      const expectedChars = PRE_ERROR_TEXT_1.length + PRE_ERROR_TEXT_2.length;
      expect(result.totalChars).toBe(expectedChars);
    });

    it("finish() is called with a formatted error message after the generator throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: eventsBeforeThrow, throwAt: 2 }),
      );
      await bridge.handleMessage(makeChannelMessage());

      // The bridge calls stream.finish(formatError(errorMsg)) — should edit the Discord message
      expect(mockEdit).toHaveBeenCalled();
      const lastContent = getEditContent(-1);
      // defaultFormatError wraps the message in "⚠️ Sorry, I encountered an error: ..."
      expect(lastContent).toMatch(/⚠️|error|interrupted/i);
    });

    it("handleMessage() resolves (does not throw) when generator throws mid-stream", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: eventsBeforeThrow, throwAt: 2 }),
      );

      // Should not throw — bridge catches and returns a BridgeResult
      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();
    });

    it("immediate generator throw (throwAt=0, no events) produces a graceful BridgeResult", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // throwAt=0 with empty events: throw fires before yielding anything
      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: [], throwAt: 0 }),
      );
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
      expect(result.totalChars).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("network connection interrupted");
    });

    it("throw mid-text produces updateCount equal to text_delta events before the throw", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(
        adapter,
        new StubAgentClient({ events: eventsBeforeThrow, throwAt: 2 }),
      );
      const result = await bridge.handleMessage(makeChannelMessage());

      // 2 text_delta events were yielded before the throw
      expect(result.updateCount).toBe(2);
    });
  });

  // =========================================================================
  // 3. finish() failure after error event
  //
  // When stream.finish() itself throws (e.g. network error while posting error
  // message), the bridge must NOT propagate this as an unhandled rejection.
  // The outer bridge code uses .catch(() => {}) for this exact scenario.
  // =========================================================================

  describe("finish() throws after a stream error event", () => {
    it("handleMessage() resolves even when finish() rejects after error event", async () => {
      // Make message.edit() always reject (simulates Discord API down during finalization)
      mockEdit.mockRejectedValue(new Error("API unavailable"));

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Partial " } as AgentStreamEvent,
        { type: "error", error: "agent_error: upstream failure" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));

      // Must resolve (not throw) even though finish() cannot edit the message
      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();
    });

    it("BridgeResult.success is false when finish() also fails after stream error", async () => {
      mockEdit.mockRejectedValue(new Error("API unavailable"));

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Some text" } as AgentStreamEvent,
        { type: "error", error: "upstream_error" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(false);
    });

    it("handleMessage() resolves when both generator throw AND finish() reject", async () => {
      // Both the generator AND finish() fail — bridge must still return a result
      mockEdit.mockRejectedValue(new Error("cannot write"));

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "hello" } as AgentStreamEvent,
        // throwAt=1 fires after yielding events[0]
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 1 }));

      // Should resolve (not throw) — bridge swallows finish() errors via .catch(() => {})
      const result = await bridge.handleMessage(makeChannelMessage());
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("BridgeResult.totalChars reflects text received before generator throw even when finish() fails", async () => {
      mockEdit.mockRejectedValue(new Error("cannot write"));

      const partialText = "partial content";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: partialText } as AgentStreamEvent,
        // throwAt=1 fires after events[0]
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 1 }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.totalChars).toBe(partialText.length);
    });
  });

  // =========================================================================
  // 4. Edit failure during streaming is handled gracefully
  //
  // When message.edit() throws a non-rate-limit error during finish(),
  // the bridge catches it via the outer catch block and returns a BridgeResult
  // with success=false. No unhandled rejections occur.
  //
  // Note: With fake timers, the deferred flush timer never fires during the
  // test. finish() is the first call to edit(). If that fails, the outer
  // catch fires and calls finish() a second time with .catch(() => {}).
  // =========================================================================

  describe("edit failure during streaming is handled gracefully", () => {
    it("BridgeResult.success is false when message.edit() throws in finish()", async () => {
      // Edit always throws a non-rate-limit error
      mockEdit.mockRejectedValue(new Error("Unknown Message"));

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "chunk one " } as AgentStreamEvent,
        { type: "text_delta", text: "chunk two" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // finish() throws → outer catch → success=false
      expect(result.success).toBe(false);
    });

    it("handleMessage() resolves (no throw) when message.edit() fails", async () => {
      mockEdit.mockRejectedValue(new Error("Unknown Message"));

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "content" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));

      // Must not propagate as an unhandled promise rejection
      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();
    });

    it("totalChars still counts all text deltas even when finish() fails", async () => {
      mockEdit.mockRejectedValue(new Error("Unknown Message"));

      const parts = ["alpha ", "beta ", "gamma"];
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];
      const expectedChars = parts.reduce((sum, p) => sum + p.length, 0);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // totalChars counts text_delta events regardless of whether finish() succeeded
      expect(result.totalChars).toBe(expectedChars);
    });

    it("error message from edit failure is captured in BridgeResult.error", async () => {
      const editError = "Unknown Message: cannot edit deleted message";
      mockEdit.mockRejectedValue(new Error(editError));

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "text" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toBeDefined();
      expect(result.error).toContain(editError);
    });
  });

  // =========================================================================
  // 5. Bridge phase sequence on mid-stream error
  //
  // The onPhaseChange callback should record the expected lifecycle phases
  // when a mid-stream error event is received.
  // =========================================================================

  describe("bridge phase sequence on mid-stream error event", () => {
    it("records session_resolve → stream_start → streaming → error → cleanup phases", async () => {
      const phases: BridgePhase[] = [];

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "partial" } as AgentStreamEvent,
        { type: "error", error: "simulated_error" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      bridge.onPhaseChange((_threadKey, phase) => phases.push(phase));

      await bridge.handleMessage(makeChannelMessage());

      expect(phases).toContain("session_resolve");
      expect(phases).toContain("stream_start");
      expect(phases).toContain("streaming");
      expect(phases).toContain("error");
      expect(phases).toContain("cleanup");
    });

    it("records streaming → error → cleanup in that order", async () => {
      const phases: BridgePhase[] = [];

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "some text" } as AgentStreamEvent,
        { type: "error", error: "error_event" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      bridge.onPhaseChange((_key, phase) => phases.push(phase));

      await bridge.handleMessage(makeChannelMessage());

      const streamingIdx = phases.indexOf("streaming");
      const errorIdx = phases.indexOf("error");
      const cleanupIdx = phases.indexOf("cleanup");

      expect(streamingIdx).toBeGreaterThanOrEqual(0);
      expect(errorIdx).toBeGreaterThan(streamingIdx);
      expect(cleanupIdx).toBeGreaterThan(errorIdx);
    });

    it("records error phase detail containing the thrown error message on generator throw", async () => {
      const phaseDetails: Array<{ phase: BridgePhase; detail?: string }> = [];

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "pre-throw" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 1 }));
      bridge.onPhaseChange((_key, phase, detail) => phaseDetails.push({ phase, detail }));

      await bridge.handleMessage(makeChannelMessage());

      const errorPhase = phaseDetails.find((p) => p.phase === "error");
      expect(errorPhase).toBeDefined();
      // Generator throw is caught by SessionOutputReader and surfaced as a streamError;
      // the bridge emits the error message string as the phase detail.
      expect(errorPhase?.detail).toContain("network connection interrupted");
    });
  });

  // =========================================================================
  // 6. Thread released after mid-stream error
  //
  // After handleMessage() resolves (even with an error), the thread must no
  // longer be in the active set so subsequent messages are accepted.
  // =========================================================================

  describe("thread released after mid-stream error", () => {
    it("isThreadActive() returns false after a mid-stream error BridgeResult", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "partial text" } as AgentStreamEvent,
        { type: "error", error: "stream_interrupted" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      expect(bridge.isThreadActive(GUILD_ID, THREAD_ID)).toBe(false);
    });

    it("a second message on the same thread is accepted after an error result", async () => {
      const failEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: "oops " } as AgentStreamEvent,
        { type: "error", error: "transient_error" } as AgentStreamEvent,
      ];

      const successEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: "retry worked!" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // First message fails mid-stream
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events: failEvents }));
      const firstResult = await bridge.handleMessage(makeChannelMessage());
      expect(firstResult.success).toBe(false);

      // Second message — wire a new bridge so the StubAgentClient resets
      const bridge2 = makeWiredBridge(adapter, new StubAgentClient({ events: successEvents }));
      const secondResult = await bridge2.handleMessage(makeChannelMessage());
      expect(secondResult.success).toBe(true);
    });

    it("isThreadActive() returns false after generator throw", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "hello" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 1 }));
      await bridge.handleMessage(makeChannelMessage());

      expect(bridge.isThreadActive(GUILD_ID, THREAD_ID)).toBe(false);
    });
  });

  // =========================================================================
  // 7. Session persisted across mid-stream error
  //
  // Even when a mid-stream error occurs, the session ID should still be stored
  // in the SessionManager so the NEXT message on the same thread can reuse it.
  // =========================================================================

  describe("session persisted after mid-stream error", () => {
    it("sessionId in BridgeResult matches the one returned by createSession()", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "oops" } as AgentStreamEvent,
        { type: "error", error: "error" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ sessionId: SESSION_ID, events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.sessionId).toBe(SESSION_ID);
    });

    it("subsequent message on the same thread returns sessionCreated=false (session reused)", async () => {
      const errorEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: "partial" } as AgentStreamEvent,
        { type: "error", error: "oops" } as AgentStreamEvent,
      ];

      const sessionManager = new SessionManager();
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // First message creates the session (and fails mid-stream)
      const bridge1 = makeWiredBridge(
        adapter,
        new StubAgentClient({ sessionId: SESSION_ID, events: errorEvents }),
        sessionManager,
      );
      const firstResult = await bridge1.handleMessage(makeChannelMessage());
      expect(firstResult.sessionCreated).toBe(true);

      // Second message on same thread — session already exists in sessionManager
      const successEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: "it works now" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge2 = makeWiredBridge(
        adapter,
        new StubAgentClient({ sessionId: SESSION_ID, events: successEvents }),
        sessionManager,
      );
      const secondResult = await bridge2.handleMessage(makeChannelMessage());

      expect(secondResult.sessionCreated).toBe(false);
      expect(secondResult.sessionId).toBe(SESSION_ID);
    });
  });

  // =========================================================================
  // 8. Partial chars accounted
  //
  // totalChars must equal the sum of text_delta lengths received BEFORE the
  // error event. The error message text itself is never added to totalChars.
  // =========================================================================

  describe("totalChars accounts for partial text before the error", () => {
    it("totalChars=0 when error fires immediately with no prior text_delta events", async () => {
      const events: AgentStreamEvent[] = [
        { type: "error", error: "immediate_failure" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.totalChars).toBe(0);
      expect(result.success).toBe(false);
    });

    it("totalChars counts multiple partial deltas before the error event", async () => {
      const deltas = ["Hello, ", "world. ", "I was going to say "];
      const events: AgentStreamEvent[] = [
        ...deltas.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "error", error: "cut_off" } as AgentStreamEvent,
      ];
      const expectedChars = deltas.reduce((sum, d) => sum + d.length, 0);

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.totalChars).toBe(expectedChars);
    });

    it("error message text does NOT appear in totalChars", async () => {
      const partialText = "partial answer";
      const errorText = "this is a very long error message that should NOT count as chars";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: partialText } as AgentStreamEvent,
        { type: "error", error: errorText } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // totalChars = only partialText length, NOT partialText + errorText
      expect(result.totalChars).toBe(partialText.length);
      expect(result.totalChars).not.toBe(partialText.length + errorText.length);
    });
  });

  // =========================================================================
  // 9. updateCount reflects only deltas before the error
  //
  // Each text_delta event increments updateCount by 1. The error event itself
  // does NOT increment updateCount.
  // =========================================================================

  describe("updateCount reflects only text_delta events before the error", () => {
    it("updateCount=0 when error fires before any text_delta events", async () => {
      const events: AgentStreamEvent[] = [
        { type: "error", error: "no_output" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.updateCount).toBe(0);
    });

    it("updateCount equals the number of text_delta events before the error", async () => {
      const deltaCount = 4;
      const events: AgentStreamEvent[] = [
        ...Array.from({ length: deltaCount }, (_, i) => ({
          type: "text_delta" as const,
          text: `chunk${i} `,
        } as AgentStreamEvent)),
        { type: "error", error: "final_error" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.updateCount).toBe(deltaCount);
    });

    it("updateCount equals text_delta events before generator throw", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "a" } as AgentStreamEvent,
        { type: "text_delta", text: "b" } as AgentStreamEvent,
        { type: "text_delta", text: "c" } as AgentStreamEvent,
        // throwAt=3: throw after all 3 events are yielded
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 3 }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.updateCount).toBe(3);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // 10. DM channel mid-stream error
  //
  // The same error semantics apply when the message originates from a DM.
  // channelId = DM_GUILD_SENTINEL, threadId = DM channel ID.
  // =========================================================================

  describe("DM channel mid-stream error", () => {
    const DM_CHANNEL_ID = "DM-CHAN-MIDSTREAM-001";

    it("BridgeResult.success is false on DM mid-stream error", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Starting to reply..." } as AgentStreamEvent,
        { type: "error", error: "dm_stream_error" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeDMChannelMessage(DM_CHANNEL_ID));

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error is set on DM mid-stream error", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Starting..." } as AgentStreamEvent,
        { type: "error", error: "dm_upstream_timeout" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeDMChannelMessage(DM_CHANNEL_ID));

      expect(result.error).toContain("dm_upstream_timeout");
    });

    it("thread is released after DM mid-stream error", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "hey" } as AgentStreamEvent,
        { type: "error", error: "dm_fail" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeDMChannelMessage(DM_CHANNEL_ID));

      expect(bridge.isThreadActive(DM_GUILD_SENTINEL, DM_CHANNEL_ID)).toBe(false);
    });

    it("DM generator throw produces graceful BridgeResult", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "DM reply" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 1 }));
      const result = await bridge.handleMessage(makeDMChannelMessage(DM_CHANNEL_ID));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // =========================================================================
  // 11. Final edit content after mid-stream error
  //
  // After multiple text_delta events, an error event fires. The final Discord
  // message edit (from finish()) should contain the error indication, not the
  // raw partial text.
  // =========================================================================

  describe("final edit content after mid-stream error", () => {
    it("last Discord edit contains ⚠️ error marker from defaultFormatError (error event)", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Starting to answer " } as AgentStreamEvent,
        { type: "text_delta", text: "your question about " } as AgentStreamEvent,
        { type: "error", error: "upstream_timeout" } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // The last edit from finish() should be the formatted error
      expect(mockEdit).toHaveBeenCalled();
      const lastContent = getEditContent(-1);
      // defaultFormatError wraps with "⚠️ Sorry, I encountered an error: ..."
      expect(lastContent).toMatch(/⚠️|error|upstream_timeout/i);
    });

    it("last Discord edit from generator throw also contains error indication", async () => {
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "First chunk " } as AgentStreamEvent,
      ];

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // throwAt=1: throw after yielding events[0]
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events, throwAt: 1 }));
      await bridge.handleMessage(makeChannelMessage());

      expect(mockEdit).toHaveBeenCalled();
      const lastContent = getEditContent(-1);
      expect(lastContent).toMatch(/⚠️|error|interrupted/i);
    });
  });

  // =========================================================================
  // 12. Concurrent request guard during mid-stream failure
  //
  // The bridge rejects a second message on the same thread while a
  // mid-stream failure is still in progress (i.e., handleMessage is pending).
  // After the failure resolves, the thread becomes available again.
  // =========================================================================

  describe("concurrent request guard with mid-stream failure", () => {
    it("second message on same thread is rejected while first is processing", async () => {
      // Use a slow stub: first message takes time (controlled by promise)
      let resolveStream!: () => void;
      const blockStream = new Promise<void>((resolve) => { resolveStream = resolve; });

      class SlowStubClient {
        async createSession(): Promise<string> { return SESSION_ID; }
        async *sendMessage(): AsyncGenerator<AgentStreamEvent> {
          await blockStream;
          yield { type: "text_delta", text: "late response" } as AgentStreamEvent;
          yield { type: "done" } as AgentStreamEvent;
        }
      }

      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = new StreamingBridge({
        adapter,
        agentClient: new SlowStubClient() as unknown as AgentClient,
        sessionManager: new SessionManager(),
        maxRetries: 0,
        retryDelayMs: 0,
      });

      // Start first message (will block on blockStream)
      const firstPromise = bridge.handleMessage(makeChannelMessage());

      // Thread is now active — second message should be rejected immediately
      const secondResult = await bridge.handleMessage(makeChannelMessage());
      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain("Thread is already being processed");

      // Release the first message and let it complete
      resolveStream();
      const firstResult = await firstPromise;
      expect(firstResult.success).toBe(true);
    });
  });
});
