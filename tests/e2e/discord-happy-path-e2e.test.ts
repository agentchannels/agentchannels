/**
 * E2E test suite: Discord ↔ StreamingBridge — happy-path edit-in-place streaming
 *
 * Architecture:
 *   - Discord.js is fully mocked (no live Discord API calls)
 *   - Claude Managed Agent is stubbed via a minimal in-process stub
 *   - All components wired in-process (StreamingBridge + DiscordAdapter + StubAgentClient)
 *   - vi.useFakeTimers({ now: 0 }) controls the ~1 s edit cadence deterministically:
 *     With Date.now() fixed at 0 and lastEditTime=0, each append() call schedules a
 *     1 000 ms timer (delay = STREAM_EDIT_INTERVAL_MS - elapsed = 1000 - 0 = 1000ms).
 *     Timers never fire during the test; finish() cancels them and flushes all
 *     accumulated content synchronously in a single final edit. This makes the
 *     final message content 100% deterministic regardless of how many text_delta
 *     events arrive.
 *
 * ## Timing model
 *
 * Real-timer behavior (for reference):
 *   append("chunk1") → lastEditTime=0, elapsed >> 1000ms → immediate async flush
 *   append("chunk2") → pendingFlush=undefined, elapsed ≈ 0 → 1000ms timer set
 *   finish()         → clears timer, flushes "chunk1chunk2"
 *
 * Fake-timer behavior (used here):
 *   append("chunk1") → lastEditTime=0, elapsed=0, delay=1000ms → timer set
 *   append("chunk2") → pendingFlush exists → returns immediately (coalesced)
 *   finish()         → clears timer, flushes "chunk1chunk2"
 *
 * Result: exactly one edit from finish() with all accumulated text,
 * plus one from appendTasks() for the initial indicator.
 *
 * ## Scenario categories covered
 *
 *   1. BridgeResult correctness (success, sessionId, totalChars, updateCount, error)
 *   2. Edit-in-place lifecycle (placeholder post → indicator edit → final drain)
 *   3. Inline activity indicators (💡 Initializing... via sendTasks at stream start)
 *   4. Multi-delta coalescing (rapid appends coalesced in 1 s cadence window)
 *   5. Session creation and multi-turn session reuse
 *   6. Thread isolation (different threadId = different session)
 *   7. DM message routing (channelId = "@dm" sentinel)
 *   8. Empty response fallback (placeholder replaced, never left as ⏳ Thinking…)
 *   9. Bridge lifecycle completeness (setStatus, clearStatus, no unhandled rejections)
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
// Mirrors the hoisted mock pattern from tests/e2e/discord-permission-e2e.test.ts.
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

// Import AFTER the mock is registered
import { DiscordAdapter } from "../../src/channels/discord/index.js";
import { THINKING_PLACEHOLDER } from "../../src/channels/discord/constants.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_ID = "HAPPY_PATH_BOT_8001";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";
const GUILD_ID = "GUILD-HAPPY-E2E-001";
const THREAD_ID = "THREAD-HAPPY-E2E-001";
const MSG_ID = "MSG-HAPPY-E2E-001";
const SESSION_ID = "session-happy-path-e2e-abc";

// ---------------------------------------------------------------------------
// StubAgentClient
//
// Minimal stub satisfying the SessionOutputReader + StreamingBridge contract.
// Configurable session ID and event sequence.
// ---------------------------------------------------------------------------

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
 * Simulate the Discord ready event so connect() resolves and botUserId is set.
 */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) l({ user: { id: botId, tag: "TestBot#0001" } });
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
    userId: "user-happy-e2e-001",
    text: "What is 1 + 1?",
    isMention: true,
    isDirectMessage: false,
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
 * Extract the content string from a mockEdit call at the given index.
 * @param index  0-based index into mockEdit.mock.calls; negative = from end.
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
  // (elapsed = 0 - 0 = 0, delay = 1000ms > 0 → setTimeout, never fires).
  // finish() cancels pending timers and flushes synchronously.
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
  // Remove SIGINT/SIGTERM handlers added by any serve/bridge code in-process
  // to prevent handler stacking across tests (see Coordinator Warning #3).
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Discord ↔ StreamingBridge: happy-path edit-in-place streaming", () => {
  // =========================================================================
  // 1. BridgeResult correctness
  //
  // Verify that StreamingBridge.handleMessage() returns a BridgeResult whose
  // fields accurately reflect the stub's session and the event stream.
  // =========================================================================

  describe("BridgeResult correctness", () => {
    it("BridgeResult.success is true for a normal text response", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "The answer is 2." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(true);
    });

    it("BridgeResult.sessionId matches the stub session ID", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ sessionId: SESSION_ID }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.sessionId).toBe(SESSION_ID);
    });

    it("BridgeResult.totalChars equals the sum of all text_delta event lengths", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const parts = ["Hello", ", ", "world", "!"];
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];
      const expectedChars = parts.reduce((sum, p) => sum + p.length, 0); // 13

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.totalChars).toBe(expectedChars);
    });

    it("BridgeResult.updateCount equals the number of text_delta events", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "A" } as AgentStreamEvent,
        { type: "text_delta", text: "B" } as AgentStreamEvent,
        { type: "text_delta", text: "C" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.updateCount).toBe(3);
    });

    it("BridgeResult.error is undefined on a successful response", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.error).toBeUndefined();
    });

    it("BridgeResult.sessionCreated is true for the first message in a thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.sessionCreated).toBe(true);
    });

    it("BridgeResult.sessionCreated is false for a subsequent message in the same thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const bridge = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient() as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      const message = makeChannelMessage();
      const first = await bridge.handleMessage(message);
      const second = await bridge.handleMessage(message);

      expect(first.sessionCreated).toBe(true);
      expect(second.sessionCreated).toBe(false);
    });

    it("BridgeResult.sessionId is the same across both turns of a multi-turn conversation", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const bridge = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient({ sessionId: SESSION_ID }) as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      const message = makeChannelMessage();
      const first = await bridge.handleMessage(message);
      const second = await bridge.handleMessage(message);

      expect(first.sessionId).toBe(SESSION_ID);
      expect(second.sessionId).toBe(SESSION_ID);
    });
  });

  // =========================================================================
  // 2. Edit-in-place streaming lifecycle
  //
  // Verify the Discord-specific streaming model:
  //   1. channel.send() posts the ⏳ Thinking… placeholder exactly once.
  //   2. message.edit() is called at least once (indicator + final drain).
  //   3. The final edit content contains the full response text.
  //   4. The placeholder is never left visible after streaming ends.
  // =========================================================================

  describe("edit-in-place streaming lifecycle", () => {
    it("posts the thinking placeholder via channel.send() before streaming begins", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // startStream() sends the placeholder as the first Discord API call
      expect(mockSend).toHaveBeenCalledWith({ content: THINKING_PLACEHOLDER });
    });

    it("channel.send() is called exactly once (placeholder only — no duplicate posts)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "A short response." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // One send() for the placeholder; no additional send() for short responses
      // (overflow send() only happens when content exceeds 2 000 chars)
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("message.edit() is called at least once during the bridge run", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      expect(mockEdit.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("final message edit (from finish) contains the complete response text", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "The answer" } as AgentStreamEvent,
        { type: "text_delta", text: " is 2." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const fullText = "The answer is 2.";

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // finish() drains all buffered content as the last edit call
      const lastContent = getEditContent(-1);
      expect(lastContent).toBe(fullText);
    });

    it("placeholder is replaced — final edit does not contain the ⏳ Thinking… string", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "My actual response." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      const lastContent = getEditContent(-1);
      // The streaming placeholder must be replaced, not left in the final message
      expect(lastContent).not.toBe(THINKING_PLACEHOLDER);
      expect(lastContent).not.toContain("⏳");
    });

    it("edit-in-place: indicator edit precedes the response text edit", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Final answer" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // The bridge always calls appendTasks (indicator) before finish (response text),
      // so there are at least 2 edits: indicator then final drain.
      expect(mockEdit.mock.calls.length).toBeGreaterThanOrEqual(2);

      const firstContent = getEditContent(0);
      const lastContent = getEditContent(-1);

      // First edit: activity indicator (💡 from init task)
      expect(firstContent).toContain("💡");
      // Last edit: response text (from finish drain)
      expect(lastContent).toContain("Final answer");
      expect(lastContent).not.toContain("💡");
    });

    it("produces a non-empty fallback when no text_delta events are emitted", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Only done — no text deltas → bridge calls finish(emptyResponseText)
      const events: AgentStreamEvent[] = [
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // The placeholder must always be replaced — never left showing ⏳ Thinking…
      const lastContent = getEditContent(-1);
      expect(lastContent).not.toBe(THINKING_PLACEHOLDER);
      expect(lastContent.trim().length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. Inline activity indicators
  //
  // The bridge pushes an "Initializing..." init task and calls
  // stream.appendTasks() once before reader.start(). DiscordStreamHandle
  // renders this immediately as an in-place edit with the 💡 emoji prefix.
  // =========================================================================

  describe("inline activity indicators", () => {
    it("first edit shows the 💡 Initializing... init indicator before response text arrives", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "Response text" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // appendTasks() is the first edit — called before reader.start()
      const firstContent = getEditContent(0);
      expect(firstContent).toContain("💡");
      expect(firstContent).toContain("Initializing...");
    });

    it("first indicator edit does not contain the response text (pure indicator)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const responseText = "UNIQUE_RESPONSE_TEXT_XYZ";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: responseText } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // The first edit is from appendTasks() before any text_delta arrives,
      // so accumulatedText is still "" — indicator only, no response text yet.
      const firstContent = getEditContent(0);
      expect(firstContent).not.toContain(responseText);
    });

    it("appendTasks is called with the init task (bridge lifecycle correctness)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Spy on appendTasks by wrapping startStream
      const appendTasksSpy = vi.fn().mockImplementation(async () => {});
      const originalStartStream = adapter.startStream.bind(adapter);
      vi.spyOn(adapter, "startStream").mockImplementation(async (...args) => {
        const handle = await originalStartStream(...args);
        // Replace appendTasks with our spy while delegating to the original
        const originalAppendTasks = handle.appendTasks?.bind(handle);
        if (originalAppendTasks) {
          handle.appendTasks = async (tasks) => {
            appendTasksSpy(tasks);
            return originalAppendTasks(tasks);
          };
        }
        return handle;
      });

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // appendTasks is called at least once with the init task.
      // Note: Vitest stores argument references, not deep copies, so the task
      // object's `status` may already be mutated to "complete" by the time
      // the assertion runs (markAllComplete() fires after reader.start()).
      // We assert on id and text only — the important invariant is that the
      // init task was included in the call, not its terminal status.
      expect(appendTasksSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "init", text: "Initializing..." }),
        ]),
      );
    });

    it("stream completes successfully when thinking events are present", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "thinking", text: "Let me work this out..." } as AgentStreamEvent,
        { type: "text_delta", text: "1 + 1 = 2" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      // The bridge handles thinking events gracefully
      expect(result.success).toBe(true);
      expect(result.totalChars).toBe("1 + 1 = 2".length);
    });

    it("stream completes successfully when tool_use and tool_result events are present", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        {
          type: "tool_use",
          name: "calculator",
          id: "tool-call-001",
          input: { expression: "1 + 1" },
        } as AgentStreamEvent,
        {
          type: "tool_result",
          name: "calculator",
          toolUseId: "tool-call-001",
        } as AgentStreamEvent,
        { type: "text_delta", text: "The result is 2." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(true);
      expect(result.totalChars).toBe("The result is 2.".length);
    });
  });

  // =========================================================================
  // 4. Multi-delta coalescing
  //
  // With fake timers (Date.now() = 0), the first append() call schedules a
  // 1 000 ms timer. Subsequent appends within the window find pendingFlush set
  // and return immediately (coalescing). finish() cancels the timer and drains
  // all accumulated text in a single final edit.
  // =========================================================================

  describe("streaming cadence and delta coalescing", () => {
    it("multiple text_delta events accumulate into the buffer correctly", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const parts = ["One", ", ", "two", ", ", "three."];
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      const expectedLength = parts.reduce((sum, p) => sum + p.length, 0);
      expect(result.totalChars).toBe(expectedLength);
      expect(result.updateCount).toBe(parts.length);
    });

    it("finish() drains all accumulated content: final edit equals joined deltas", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const parts = ["Hello", ", ", "world", "!"];
      const fullText = parts.join(""); // "Hello, world!"
      const events: AgentStreamEvent[] = [
        ...parts.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      // finish() edits with all accumulated content as the final call
      const lastContent = getEditContent(-1);
      expect(lastContent).toBe(fullText);
    });

    it("20 rapid text_delta events coalesce correctly into the final edit", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Many rapid deltas within the 1 s cadence window (fake timers → none fire)
      const deltas = Array.from({ length: 20 }, (_, i) => `chunk${i} `);
      const fullText = deltas.join("");
      const events: AgentStreamEvent[] = [
        ...deltas.map((text) => ({ type: "text_delta" as const, text } as AgentStreamEvent)),
        { type: "done" } as AgentStreamEvent,
      ];

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(true);
      expect(result.totalChars).toBe(fullText.length);

      // finish() produces the single authoritative final edit
      const lastContent = getEditContent(-1);
      expect(lastContent).toBe(fullText);
    });

    it("BridgeResult is correct regardless of how many text_delta events coalesce", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // One big delta vs many small deltas should yield the same BridgeResult stats
      const singleEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: "abcde" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const manyEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: "a" } as AgentStreamEvent,
        { type: "text_delta", text: "b" } as AgentStreamEvent,
        { type: "text_delta", text: "c" } as AgentStreamEvent,
        { type: "text_delta", text: "d" } as AgentStreamEvent,
        { type: "text_delta", text: "e" } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const sessionManager1 = new SessionManager();
      const bridge1 = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient({ events: singleEvents }) as unknown as AgentClient,
        sessionManager: sessionManager1,
        maxRetries: 0,
        retryDelayMs: 0,
      });
      const result1 = await bridge1.handleMessage(makeChannelMessage({ threadId: "THREAD-SINGLE" }));

      const sessionManager2 = new SessionManager();
      const bridge2 = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient({ events: manyEvents }) as unknown as AgentClient,
        sessionManager: sessionManager2,
        maxRetries: 0,
        retryDelayMs: 0,
      });
      const result2 = await bridge2.handleMessage(makeChannelMessage({ threadId: "THREAD-MANY" }));

      // totalChars should be the same — "abcde" vs "a"+"b"+"c"+"d"+"e"
      expect(result1.totalChars).toBe(result2.totalChars);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  // =========================================================================
  // 5. Session management
  //
  // Verifies SessionManager key format "discord:{guildId}:{threadId}" through
  // the adapter.name + ChannelMessage.channelId + threadId path.
  // =========================================================================

  describe("session management", () => {
    it("creates a new session for the first message in a thread (sessionCreated=true)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ sessionId: SESSION_ID }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.sessionCreated).toBe(true);
      expect(result.sessionId).toBe(SESSION_ID);
    });

    it("reuses the session for subsequent messages in the same thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const bridge = new StreamingBridge({
        adapter,
        agentClient: new StubAgentClient({ sessionId: SESSION_ID }) as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      const message = makeChannelMessage();
      await bridge.handleMessage(message);
      const second = await bridge.handleMessage(message);

      expect(second.sessionCreated).toBe(false);
      expect(second.sessionId).toBe(SESSION_ID);
    });

    it("createSession() is invoked exactly once across two messages in the same thread", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      let createSessionCount = 0;
      const countingClient = {
        createSession: async () => {
          createSessionCount++;
          return SESSION_ID;
        },
        async *sendMessage() {
          yield { type: "text_delta", text: "ok" } as AgentStreamEvent;
          yield { type: "done" } as AgentStreamEvent;
        },
      };
      const sessionManager = new SessionManager();
      const bridge = new StreamingBridge({
        adapter,
        agentClient: countingClient as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      const message = makeChannelMessage();
      await bridge.handleMessage(message);
      await bridge.handleMessage(message);

      expect(createSessionCount).toBe(1);
    });

    it("different threadId values get isolated independent sessions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      let sessionCounter = 0;
      const multiSessionClient = {
        createSession: async () => `session-${++sessionCounter}`,
        async *sendMessage() {
          yield { type: "text_delta", text: "ok" } as AgentStreamEvent;
          yield { type: "done" } as AgentStreamEvent;
        },
      };
      const sessionManager = new SessionManager();
      const bridge = new StreamingBridge({
        adapter,
        agentClient: multiSessionClient as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      const resultA = await bridge.handleMessage(
        makeChannelMessage({ threadId: "THREAD-ISO-A" }),
      );
      const resultB = await bridge.handleMessage(
        makeChannelMessage({ threadId: "THREAD-ISO-B" }),
      );

      expect(resultA.sessionCreated).toBe(true);
      expect(resultB.sessionCreated).toBe(true);
      expect(resultA.sessionId).not.toBe(resultB.sessionId);
    });
  });

  // =========================================================================
  // 6. DM message routing
  //
  // DM messages use channelId = "@dm" (DM_GUILD_SENTINEL) so the session key
  // becomes "discord:@dm:{threadId}" — guaranteed not to collide with real
  // guild IDs starting with a snowflake integer.
  // =========================================================================

  describe("DM message routing", () => {
    it("processes a DM message successfully (BridgeResult.success = true)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(
        makeChannelMessage({
          channelId: "@dm",
          threadId: "DM-CHANNEL-E2E-001",
          isDirectMessage: true,
          isMention: false,
        }),
      );

      expect(result.success).toBe(true);
    });

    it("DM totalChars and updateCount are correct for a DM response", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: "DM response text." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(
        makeChannelMessage({
          channelId: "@dm",
          threadId: "DM-CHANNEL-E2E-002",
          isDirectMessage: true,
          isMention: false,
        }),
      );

      expect(result.totalChars).toBe("DM response text.".length);
      expect(result.updateCount).toBe(1);
    });

    it("DM sessions are isolated from guild thread sessions", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      let sessionCounter = 0;
      const client = {
        createSession: async () => `session-${++sessionCounter}`,
        async *sendMessage() {
          yield { type: "text_delta", text: "ok" } as AgentStreamEvent;
          yield { type: "done" } as AgentStreamEvent;
        },
      };
      const sessionManager = new SessionManager();
      const bridge = new StreamingBridge({
        adapter,
        agentClient: client as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });

      const guildResult = await bridge.handleMessage(
        makeChannelMessage({ channelId: GUILD_ID, threadId: "THREAD-GUILD-01" }),
      );
      const dmResult = await bridge.handleMessage(
        makeChannelMessage({
          channelId: "@dm",
          threadId: "DM-CHANNEL-01",
          isDirectMessage: true,
          isMention: false,
        }),
      );

      expect(guildResult.sessionCreated).toBe(true);
      expect(dmResult.sessionCreated).toBe(true);
      expect(guildResult.sessionId).not.toBe(dmResult.sessionId);
    });
  });

  // =========================================================================
  // 7. Bridge lifecycle completeness
  //
  // Verifies that adapter lifecycle hooks (setStatus, clearStatus) are called
  // at the correct points, and that the bridge completes without throwing.
  // =========================================================================

  describe("bridge lifecycle completeness", () => {
    it("completes the full bridge lifecycle without throwing for a normal response", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await expect(bridge.handleMessage(makeChannelMessage())).resolves.toBeDefined();
    });

    it("setStatus (typing indicator) is triggered during the bridge run", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      await bridge.handleMessage(makeChannelMessage());

      // DiscordAdapter.setStatus() fetches the channel and calls sendTyping()
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it("clearStatus (no-op) does not throw when called explicitly", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // clearStatus is a no-op for Discord (typing auto-expires)
      await expect(adapter.clearStatus(GUILD_ID, THREAD_ID)).resolves.toBeUndefined();
    });

    it("mockEdit contains the expected text in at least one call", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const expectedText = "1 + 1 = 2";
      const events: AgentStreamEvent[] = [
        { type: "text_delta", text: expectedText } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];
      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      await bridge.handleMessage(makeChannelMessage());

      const allEditContents = mockEdit.mock.calls.map(
        (call) => (call[0] as { content: string }).content,
      );
      expect(allEditContents.some((c) => c.includes(expectedText))).toBe(true);
    });

    it("BridgeResult success is true and totalChars > 0 for a non-empty response", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const bridge = makeWiredBridge(adapter, new StubAgentClient());
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(true);
      expect(result.totalChars).toBeGreaterThan(0);
    });

    it("bridge processes a complex event stream (thinking + tool_use + text_delta) correctly", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const events: AgentStreamEvent[] = [
        { type: "thinking", text: "I need to compute this." } as AgentStreamEvent,
        {
          type: "tool_use",
          name: "bash",
          id: "tool-001",
          input: { command: "echo 2" },
        } as AgentStreamEvent,
        {
          type: "tool_result",
          name: "bash",
          toolUseId: "tool-001",
        } as AgentStreamEvent,
        { type: "text_delta", text: "The result is 2." } as AgentStreamEvent,
        { type: "done" } as AgentStreamEvent,
      ];

      const bridge = makeWiredBridge(adapter, new StubAgentClient({ events }));
      const result = await bridge.handleMessage(makeChannelMessage());

      expect(result.success).toBe(true);
      expect(result.totalChars).toBe("The result is 2.".length);
      expect(result.updateCount).toBe(1);

      // Final edit must contain the text response
      const lastContent = getEditContent(-1);
      expect(lastContent).toContain("The result is 2.");
    });
  });
});
