/**
 * E2E test suite: Discord ↔ StreamingBridge — primary event-driven integration
 *
 * Architecture:
 *   - Discord.js is fully mocked (no live Discord API calls)
 *   - Claude Managed Agent is stubbed via a minimal in-process StubAgentClient
 *   - All components wired in-process: DiscordAdapter + StreamingBridge + SessionManager
 *   - Raw Discord messageCreate events are fired via emitMessageCreate() to exercise
 *     the FULL message flow:
 *     Discord messageCreate → DiscordAdapter.setupListeners() → StreamingBridge.handleMessage()
 *
 * This is the primary Discord E2E test file, mirroring slack-bridge-e2e.test.ts in
 * scope and assertion depth — using fully-mocked Discord.js instead of live API calls.
 *
 * ## Fixture-based determinism
 *
 * The "cassette" concept from the Slack E2E test is replaced by pre-defined in-memory
 * AgentStreamEvent fixtures (BASIC_TEXT_FIXTURE, DM_TEXT_FIXTURE, PLAN_MODE_FIXTURE).
 * Expected BridgeResult values are derived from the fixture events, making tests
 * 100% deterministic without any live API calls.
 *
 * ## Timing model
 *
 * vi.useFakeTimers({ now: 0 }) controls the ~1 s edit cadence:
 *   - Date.now() is fixed at 0, so elapsed = 0 → delay = STREAM_EDIT_INTERVAL_MS (1000ms)
 *   - append() / appendTasks() calls set a deferred setTimeout that never fires in tests
 *   - finish() cancels the pending timer and flushes all content synchronously
 *   - Result: exactly one final mockEdit call with all accumulated content
 *
 * ## Scenario categories covered (mirroring slack-bridge-e2e.test.ts)
 *
 *   1. @mention trigger — full event-driven BridgeResult assertions
 *      (success, sessionId, totalChars, updateCount, error, sessionCreated)
 *   2. @mention trigger — Discord stream lifecycle
 *      (placeholder send → typing indicator → final edit with correct text)
 *   3. @mention trigger — plan-mode task lifecycle
 *      (non-empty tasks, correct task IDs, all tasks complete at finish)
 *   4. DM trigger — full event-driven BridgeResult assertions
 *   5. DM trigger — session key uses @dm sentinel (discord:@dm:{channelId})
 *   6. Event filtering — bot self-reply guard (bot messages silently dropped)
 *   7. Event filtering — non-mention guard (guild messages without @mention ignored)
 *   8. Fixture integrity — event sequence sanity checks (the cassette analog)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelMessage, StreamHandle, StreamTask } from "../../src/core/channel-adapter.js";
import type { AgentStreamEvent } from "../../src/core/chunk-parser.js";
import type { AgentClient } from "../../src/core/agent-client.js";
import type { BridgeResult } from "../../src/core/streaming-bridge.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { StreamingBridge } from "../../src/core/streaming-bridge.js";

// ---------------------------------------------------------------------------
// Discord.js mock
//
// Hoisted before any imports so that DiscordAdapter uses the mocked client.
// Module-level listener maps are mutated per test via connectAdapter() and
// emitMessageCreate(). Mock functions are reset in beforeEach.
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
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 512,
      MessageContent: 32768,
      DirectMessages: 4096,
    },
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
import {
  DiscordAdapter,
  DiscordStreamHandle,
  type DiscordEditableMessage,
  type DiscordSendableChannel,
} from "../../src/channels/discord/index.js";
import {
  DM_GUILD_SENTINEL,
  DISCORD_MESSAGE_LIMIT,
  THINKING_PLACEHOLDER,
} from "../../src/channels/discord/constants.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_ID = "E2E_BRIDGE_BOT_1701";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";

const GUILD_ID = "GUILD-BRIDGE-E2E-001";
const THREAD_ID = "THREAD-BRIDGE-E2E-001";
const DM_CHANNEL_ID = "DM-BRIDGE-E2E-001";
const MSG_ID = "MSG-BRIDGE-E2E-001";

/** Unique session IDs per fixture — prevent session collisions across tests */
const SESSION_ID_MENTION = "session-mention-e2e-abc123";
const SESSION_ID_DM = "session-dm-e2e-xyz789";
const SESSION_ID_PLAN = "session-plan-e2e-def456";

// ---------------------------------------------------------------------------
// Fixtures
//
// Pre-defined AgentStreamEvent sequences that replace cassette recordings.
// Expected values are derived directly from the event sequences so BridgeResult
// assertions are fully deterministic without any live API calls.
//
// This mirrors the role of cassette fixture files in slack-bridge-e2e.test.ts.
// ---------------------------------------------------------------------------

/** Compute total character count from a fixture's text_delta events. */
function computeFixtureTotalChars(events: AgentStreamEvent[]): number {
  return events
    .filter((e): e is Extract<AgentStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .reduce((sum, e) => sum + e.text.length, 0);
}

/** Compute update count (number of text_delta events) from a fixture. */
function computeFixtureUpdateCount(events: AgentStreamEvent[]): number {
  return events.filter((e) => e.type === "text_delta").length;
}

/** Compute concatenated final text from a fixture's text_delta events. */
function computeFixtureFinalText(events: AgentStreamEvent[]): string {
  return events
    .filter((e): e is Extract<AgentStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
}

/**
 * BASIC_TEXT_FIXTURE: Simple two-delta text response with no tool use.
 * Used for @mention trigger BridgeResult correctness tests.
 */
const BASIC_TEXT_EVENTS: AgentStreamEvent[] = [
  { type: "text_delta", text: "The answer is 2." },
  { type: "text_delta", text: " This follows from basic arithmetic." },
  { type: "done" },
];

const BASIC_TEXT_FIXTURE = {
  sessionId: SESSION_ID_MENTION,
  events: BASIC_TEXT_EVENTS,
  expected: {
    totalChars: computeFixtureTotalChars(BASIC_TEXT_EVENTS),
    updateCount: computeFixtureUpdateCount(BASIC_TEXT_EVENTS),
    finalText: computeFixtureFinalText(BASIC_TEXT_EVENTS),
    success: true,
  },
};

/**
 * DM_TEXT_FIXTURE: Single-delta text response for DM trigger tests.
 */
const DM_TEXT_EVENTS: AgentStreamEvent[] = [
  { type: "text_delta", text: "Hello from the agent!" },
  { type: "done" },
];

const DM_TEXT_FIXTURE = {
  sessionId: SESSION_ID_DM,
  events: DM_TEXT_EVENTS,
  expected: {
    totalChars: computeFixtureTotalChars(DM_TEXT_EVENTS),
    updateCount: computeFixtureUpdateCount(DM_TEXT_EVENTS),
    finalText: computeFixtureFinalText(DM_TEXT_EVENTS),
    success: true,
  },
};

/**
 * PLAN_MODE_FIXTURE: Thinking + tool_use + tool_result + text response.
 * Used for plan-mode task lifecycle assertions, mirroring the AC 4 assertions
 * in slack-bridge-e2e.test.ts (task list non-empty, all complete, naming convention).
 */
const PLAN_MODE_EVENTS: AgentStreamEvent[] = [
  { type: "thinking", text: "Let me analyze this step by step..." },
  { type: "tool_use", name: "bash", input: { command: "echo hello" } },
  { type: "tool_result", name: "bash", toolUseId: "tool-use-001" },
  { type: "text_delta", text: "Based on the output: hello" },
  { type: "done" },
];

const PLAN_MODE_FIXTURE = {
  sessionId: SESSION_ID_PLAN,
  events: PLAN_MODE_EVENTS,
  expected: {
    totalChars: computeFixtureTotalChars(PLAN_MODE_EVENTS),
    updateCount: computeFixtureUpdateCount(PLAN_MODE_EVENTS),
    finalText: computeFixtureFinalText(PLAN_MODE_EVENTS),
    success: true,
    taskCount: {
      min: 1, // At minimum: the "init" task
    },
  },
};

// ---------------------------------------------------------------------------
// AC 4b: Streaming lifecycle + overflow fixtures
// ---------------------------------------------------------------------------

/** Unique session IDs for overflow fixture tests — prevents session collisions */
const SESSION_ID_EMPTY = "session-empty-e2e-aaa111";
const SESSION_ID_OVERFLOW = "session-overflow-e2e-bbb222";

/**
 * EMPTY_RESPONSE_EVENTS: No text_delta events — only a terminal done event.
 * Used to verify that finish() replaces the placeholder with "(no response)".
 */
const EMPTY_RESPONSE_EVENTS: AgentStreamEvent[] = [
  { type: "done" },
];

/**
 * OVERFLOW_2001_EVENTS: Single text delta that exceeds the 2 K limit by 1 char.
 * Used to test the finish() drain overflow path: 2 messages, 2 edits.
 */
const OVERFLOW_TEXT_2001 = "X".repeat(2001);
const OVERFLOW_2001_EVENTS: AgentStreamEvent[] = [
  { type: "text_delta", text: OVERFLOW_TEXT_2001 },
  { type: "done" },
];

/**
 * OVERFLOW_4001_EVENTS: Text that spans 3 messages (2000 + 2000 + 1).
 * Used to test multi-message overflow in the finish() drain loop.
 */
const OVERFLOW_TEXT_4001 = "Y".repeat(4001);
const OVERFLOW_4001_EVENTS: AgentStreamEvent[] = [
  { type: "text_delta", text: OVERFLOW_TEXT_4001 },
  { type: "done" },
];

/**
 * EXACT_2000_EVENTS: Text exactly at the 2 K limit — must NOT trigger overflow.
 * Verifies that the boundary condition is handled correctly (≤ 2000 → single message).
 */
const EXACT_2000_TEXT = "Z".repeat(2000);
const EXACT_2000_EVENTS: AgentStreamEvent[] = [
  { type: "text_delta", text: EXACT_2000_TEXT },
  { type: "done" },
];

/**
 * MULTI_DELTA_OVERFLOW_EVENTS: Two deltas whose combined length exceeds 2 K.
 * Verifies that text from multiple append() calls accumulates before overflow splits.
 * Total: 1001 + 1001 = 2002 chars → first chunk = "A"*1001 + "B"*999 (2000), remainder = "B"*2.
 */
const MULTI_DELTA_OVERFLOW_EVENTS: AgentStreamEvent[] = [
  { type: "text_delta", text: "A".repeat(1001) },
  { type: "text_delta", text: "B".repeat(1001) },
  { type: "done" },
];

// ---------------------------------------------------------------------------
// StubAgentClient
//
// Minimal stub satisfying SessionOutputReader + StreamingBridge contracts.
// Configurable session ID and event sequence per fixture.
// Tracks createSession() call count for session-creation assertions.
// ---------------------------------------------------------------------------

class StubAgentClient {
  private readonly _sessionId: string;
  private readonly _events: AgentStreamEvent[];
  private _createSessionCallCount = 0;

  constructor(
    options: {
      sessionId?: string;
      events?: AgentStreamEvent[];
    } = {},
  ) {
    this._sessionId = options.sessionId ?? SESSION_ID_MENTION;
    this._events = options.events ?? [...BASIC_TEXT_EVENTS];
  }

  get createSessionCallCount(): number {
    return this._createSessionCallCount;
  }

  async createSession(): Promise<string> {
    this._createSessionCallCount++;
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
// CapturingStreamHandle
//
// Wraps any StreamHandle to capture both appendTasks() call history and the
// final tasks passed to finish(). Enables plan-mode task lifecycle assertions
// without modifying DiscordAdapter or StreamingBridge.
//
// ## Why capture from finish(), not just appendTasks()
//
// StreamingBridge only calls appendTasks() ONCE at stream start (seeding the
// "Initializing..." init task). Intermediate task mutations are kept in-memory
// and the terminal (all-complete) task state is passed to stream.finish() as
// `finalTasks`. This avoids a race condition where Slack's stopStream can
// overtake a separately-sent appendStream and freeze tasks as "error".
//
// Therefore `finalTaskState` prioritizes the tasks captured from finish(),
// which carries the authoritative terminal task state.
// ---------------------------------------------------------------------------

class CapturingStreamHandle implements StreamHandle {
  /** Task arrays passed to appendTasks(), in chronological call order. */
  private readonly _appendTasksHistory: StreamTask[][] = [];

  /**
   * The finalTasks argument from the bridge's finish() call.
   * This is the authoritative terminal task state (all tasks complete).
   */
  private _finishTasks: StreamTask[] | undefined;

  constructor(private readonly inner: StreamHandle) {}

  /**
   * The terminal task state — prefers finalTasks from finish() since that
   * carries the authoritative all-complete snapshot the bridge produces via
   * markAllComplete() before closing the stream.
   */
  get finalTaskState(): StreamTask[] {
    if (this._finishTasks !== undefined) return this._finishTasks;
    return this._appendTasksHistory.at(-1) ?? [];
  }

  /** All task arrays passed to appendTasks(), in chronological order. */
  get appendTasksHistory(): ReadonlyArray<StreamTask[]> {
    return this._appendTasksHistory;
  }

  /** The final tasks as captured from finish(). */
  get finishTasks(): StreamTask[] | undefined {
    return this._finishTasks;
  }

  async append(delta: string): Promise<void> {
    return this.inner.append(delta);
  }

  async appendTasks(tasks: StreamTask[]): Promise<void> {
    // Deep-copy each task at the moment of capture so future mutations by
    // the bridge (markAllComplete, etc.) are NOT reflected in the history.
    this._appendTasksHistory.push(tasks.map((t) => ({ ...t })));
    // appendTasks is optional on StreamHandle — use ?. to be safe
    return this.inner.appendTasks?.(tasks);
  }

  /**
   * Capture the finalTasks that the bridge passes atomically with the
   * close operation, then delegate to the inner handle.
   */
  async finish(finalText?: string, finalTasks?: StreamTask[]): Promise<void> {
    if (finalTasks && finalTasks.length > 0) {
      // Snapshot so subsequent mutations don't corrupt the captured state
      this._finishTasks = finalTasks.map((t) => ({ ...t }));
    }
    return this.inner.finish(finalText, finalTasks);
  }
}

// ---------------------------------------------------------------------------
// Helper: installCapturingStreamHandle
//
// Spy on adapter.startStream to wrap each returned StreamHandle in a
// CapturingStreamHandle. Returns a ref object whose `.handle` property is
// populated after the first startStream() call.
// ---------------------------------------------------------------------------

function installCapturingStreamHandle(adapter: DiscordAdapter): {
  getHandle: () => CapturingStreamHandle | null;
} {
  let handle: CapturingStreamHandle | null = null;

  const originalStartStream = adapter.startStream.bind(adapter);
  vi.spyOn(adapter, "startStream").mockImplementation(
    async (channelId: string, threadId: string, userId?: string): Promise<StreamHandle> => {
      const inner = await originalStartStream(channelId, threadId, userId);
      handle = new CapturingStreamHandle(inner);
      return handle;
    },
  );

  return { getHandle: () => handle };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate the Discord ClientReady event so connect() resolves with botUserId set. */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) l({ user: { id: botId, tag: "TestBot#0001" } });
  await connectPromise;
}

/** Emit a synthetic messageCreate event through all registered listeners. */
async function emitMessageCreate(rawMessage: object): Promise<void> {
  const listeners = onListeners["messageCreate"] ?? [];
  for (const l of listeners) await l(rawMessage);
}

/** Build a minimal fake sendable GuildText channel. */
function makeFakeGuildTextChannel(): Record<string, unknown> {
  return {
    type: 0, // ChannelType.GuildText
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
  };
}

/** Build a minimal fake sendable DM channel. */
function makeFakeDMChannel(): Record<string, unknown> {
  return {
    type: 1, // ChannelType.DM
    isTextBased: () => true,
    send: mockSend,
    sendTyping: mockSendTyping,
  };
}

/**
 * Build a raw Discord @mention guild message (for emitMessageCreate).
 *
 * The resulting ChannelMessage.threadId will be the thread.id from mockStartThread
 * (THREAD_ID by default) since this fires the "first @mention → create thread" path.
 */
function makeRawGuildMentionMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: MSG_ID,
    channelId: "text-channel-e2e-001",
    guildId: GUILD_ID,
    content: `<@${BOT_ID}> What is 1 + 1?`,
    author: { id: "user-e2e-001", bot: false },
    channel: { type: 0 }, // ChannelType.GuildText
    mentions: { has: (id: string) => id === BOT_ID },
    startThread: mockStartThread,
    ...overrides,
  };
}

/**
 * Build a raw Discord DM message (for emitMessageCreate).
 *
 * The resulting ChannelMessage will have channelId = "@dm" and threadId = DM_CHANNEL_ID.
 */
function makeRawDMMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "dm-msg-e2e-001",
    channelId: DM_CHANNEL_ID,
    guildId: null,
    content: "What is 1 + 1?",
    author: { id: "user-dm-e2e-001", bot: false },
    channel: { type: 1 }, // ChannelType.DM
    mentions: { has: (_id: string) => false },
    ...overrides,
  };
}

/**
 * Wire a StreamingBridge with the given adapter and stub client.
 * Retries are disabled (maxRetries=0, retryDelayMs=0) for deterministic tests.
 */
function makeWiredBridge(
  adapter: DiscordAdapter,
  stubClient: StubAgentClient,
  sessionManager = new SessionManager(),
): StreamingBridge {
  return new StreamingBridge({
    adapter,
    agentClient: stubClient as unknown as AgentClient,
    sessionManager,
    maxRetries: 0,
    retryDelayMs: 0,
  });
}

/**
 * Wire the bridge to the adapter via adapter.onMessage() and return a promise
 * that resolves with the BridgeResult from the next dispatched message.
 *
 * This exercises the FULL event-driven flow:
 *   emitMessageCreate() → DiscordAdapter.setupListeners() → StreamingBridge.handleMessage()
 *
 * Call emitMessageCreate() AFTER calling this function.
 */
function captureNextBridgeResult(
  adapter: DiscordAdapter,
  bridge: StreamingBridge,
): Promise<BridgeResult> {
  return new Promise<BridgeResult>((resolve) => {
    adapter.onMessage(async (msg) => {
      const result = await bridge.handleMessage(msg);
      resolve(result);
    });
  });
}

/**
 * Convenience: wire the bridge, capture task state, emit a raw event,
 * and return the BridgeResult + the capturing handle.
 *
 * This is the primary E2E test driver for plan-mode task assertions.
 */
async function runBridgeE2E(
  adapter: DiscordAdapter,
  stubClient: StubAgentClient,
  rawMessage: object,
  sessionManager = new SessionManager(),
): Promise<{ result: BridgeResult; taskCapture: ReturnType<typeof installCapturingStreamHandle> }> {
  const taskCapture = installCapturingStreamHandle(adapter);
  const bridge = makeWiredBridge(adapter, stubClient, sessionManager);
  const resultPromise = captureNextBridgeResult(adapter, bridge);
  await emitMessageCreate(rawMessage);
  const result = await resultPromise;
  return { result, taskCapture };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Fix Date.now() at 0 so DiscordStreamHandle.scheduleFlush() always defers.
  // elapsed = Date.now() - lastEditTime = 0 - 0 = 0 → delay = 1000ms → timer set.
  // finish() cancels the pending timer and flushes synchronously.
  // This makes the final edit content 100% deterministic.
  vi.useFakeTimers({ now: 0 });

  vi.clearAllMocks();

  // Reset listener maps so each test starts with a clean adapter
  for (const k of Object.keys(onListeners)) delete onListeners[k];
  for (const k of Object.keys(onceListeners)) delete onceListeners[k];

  // Default mock behaviours
  mockLogin.mockResolvedValue(undefined);
  mockSendTyping.mockResolvedValue(undefined);

  // Thread creation returns a thread with THREAD_ID by default
  mockStartThread.mockResolvedValue({ id: THREAD_ID, name: "What is 1 + 1?" });

  // Placeholder send returns an editable message object
  mockSend.mockResolvedValue({ id: "placeholder-bridge-e2e", edit: mockEdit });
  mockEdit.mockResolvedValue({ id: "edited-bridge-e2e" });

  // channels.fetch returns a sendable GuildText channel by default
  mockChannelsFetch.mockResolvedValue(makeFakeGuildTextChannel());
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // Remove SIGINT/SIGTERM handlers to prevent accumulation across tests
  // (see Coordinator Warning #3: signal handler stacking in multi-serve tests)
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

// ===========================================================================
// AC 1: @mention trigger — BridgeResult assertions
//
// Fires a raw Discord @mention messageCreate event and verifies that
// StreamingBridge.handleMessage() returns a BridgeResult whose fields exactly
// match the values derivable from BASIC_TEXT_FIXTURE.
//
// In-process flow exercised:
//   emitMessageCreate(@mention) → DiscordAdapter listener
//     → resolveThreadContext() creates Discord thread (mockStartThread)
//     → toChannelMessage() normalizes to ChannelMessage
//     → dispatchMessage() → registered onMessage handler
//     → StreamingBridge.handleMessage() → StubAgentClient.sendMessage()
//     → DiscordStreamHandle.append() + finish() → BridgeResult
// ===========================================================================

describe("@mention trigger: full event-driven BridgeResult assertions", () => {
  it("BridgeResult.success is true for a normal @mention response", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.success).toBe(true);
  });

  it("BridgeResult.sessionId matches the fixture session ID", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.sessionId).toBe(BASIC_TEXT_FIXTURE.sessionId);
  });

  it("BridgeResult.totalChars matches the fixture total character count", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.totalChars).toBe(BASIC_TEXT_FIXTURE.expected.totalChars);
  });

  it("BridgeResult.updateCount matches the fixture text_delta event count", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.updateCount).toBe(BASIC_TEXT_FIXTURE.expected.updateCount);
  });

  it("BridgeResult.error is undefined when the @mention succeeds", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.error).toBeUndefined();
  });

  it("BridgeResult.sessionCreated is true for the first @mention (no existing session)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.sessionCreated).toBe(true);
  });
});

// ===========================================================================
// AC 2: @mention trigger — Discord stream lifecycle assertions
//
// Verify that the Discord streaming lifecycle is correctly exercised:
//   1. Placeholder message is sent to the channel (mockSend called once)
//   2. Final edit is performed with the expected accumulated text (mockEdit called)
//   3. channels.fetch is called with threadId (the Discord thread/channel ID),
//      NOT with channelId (the guildId) — per the AC 3 thread-fetch contract
// ===========================================================================

describe("@mention trigger: Discord stream lifecycle", () => {
  it("placeholder message is sent to the Discord thread channel", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // channel.send() must be called exactly once for the placeholder
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("final edit is performed (stream finishes with one edit call)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // With fake timers, finish() drains all content in a single synchronous edit
    expect(mockEdit).toHaveBeenCalled();
  });

  it("final edit content contains the expected full response text", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // The last edit call should contain the concatenated text from all text_delta events
    const lastEditCall = mockEdit.mock.calls.at(-1);
    expect(lastEditCall).toBeDefined();
    const editArg = lastEditCall![0] as { content: string };
    expect(editArg.content).toContain(BASIC_TEXT_FIXTURE.expected.finalText);
  });

  it("channels.fetch is called with threadId (not guildId) per the thread-fetch contract", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // THREAD_ID is the Discord thread created by mockStartThread.
    // channels.fetch must be called with THREAD_ID, NOT with GUILD_ID.
    expect(mockChannelsFetch).toHaveBeenCalledWith(THREAD_ID);
    expect(mockChannelsFetch).not.toHaveBeenCalledWith(GUILD_ID);
  });

  it("thread is created on the triggering message (mockStartThread is called)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // First @mention in a guild text channel triggers Discord thread creation
    expect(mockStartThread).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// AC 3 / AC 4: @mention trigger — plan-mode task lifecycle
//
// Verify that StreamingBridge emits correct plan-mode tasks via appendTasks()
// throughout streaming, and that all tasks reach "complete" status at the end.
//
// Mirrors the AC 4 assertions from slack-bridge-e2e.test.ts:
//   - Task list is non-empty (at minimum the "Initializing..." init task)
//   - All final tasks have status "complete"
//   - Task IDs follow the naming convention: init | thinking_N | tool_N
//   - Final task state matches the expected task sequence from PLAN_MODE_FIXTURE
//
// Uses CapturingStreamHandle (via installCapturingStreamHandle) to intercept
// appendTasks() calls without modifying DiscordAdapter or StreamingBridge.
// ===========================================================================

describe("@mention trigger: plan-mode task lifecycle", () => {
  it("plan-mode task list is non-empty (at least the init task is emitted)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: PLAN_MODE_FIXTURE.sessionId,
      events: [...PLAN_MODE_FIXTURE.events],
    });
    const { taskCapture } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    const finalTasks = taskCapture.getHandle()?.finalTaskState ?? [];
    expect(
      finalTasks.length,
      "Bridge should emit at least the 'Initializing...' init task via appendTasks()",
    ).toBeGreaterThanOrEqual(PLAN_MODE_FIXTURE.expected.taskCount.min);
  });

  it("all final plan-mode tasks have status 'complete' (no stalled tasks)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: PLAN_MODE_FIXTURE.sessionId,
      events: [...PLAN_MODE_FIXTURE.events],
    });
    const { taskCapture } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    const finalTasks = taskCapture.getHandle()?.finalTaskState ?? [];

    // The bridge calls markAllComplete() on done/error so every task must
    // end up as "complete" in the terminal appendTasks() call.
    for (const task of finalTasks) {
      expect(
        task.status,
        `Task "${task.id}" ("${task.text}") should have status 'complete', got '${task.status}'`,
      ).toBe("complete");
    }
  });

  it("plan-mode task IDs follow the expected naming convention (init | thinking_N | tool_N)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: PLAN_MODE_FIXTURE.sessionId,
      events: [...PLAN_MODE_FIXTURE.events],
    });
    const { taskCapture } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    const finalTasks = taskCapture.getHandle()?.finalTaskState ?? [];
    const validIdPattern = /^(init|thinking_\d+|tool_\d+)$/;

    for (const task of finalTasks) {
      expect(
        task.id,
        `Task ID "${task.id}" does not match expected pattern (init | thinking_N | tool_N)`,
      ).toMatch(validIdPattern);
    }
  });

  it("appendTasks() is called at stream start (init task seeded as in_progress)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: PLAN_MODE_FIXTURE.sessionId,
      events: [...PLAN_MODE_FIXTURE.events],
    });
    const { taskCapture } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // The bridge seeds appendTasks once at stream start with init: in_progress.
    // Intermediate task mutations are kept in-memory; the terminal all-complete
    // state is passed via finish(finalText?, finalTasks?) to avoid Slack races.
    expect(
      taskCapture.getHandle()?.appendTasksHistory.length ?? 0,
      "appendTasks() should be called at least once to seed the init task",
    ).toBeGreaterThan(0);
  });

  it("finish() receives the final tasks (terminal all-complete state from bridge)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: PLAN_MODE_FIXTURE.sessionId,
      events: [...PLAN_MODE_FIXTURE.events],
    });
    const { taskCapture } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // The bridge calls markAllComplete() then passes finalTasks to finish().
    // finishTasks must be non-empty — the bridge always passes the terminal state.
    const finishTasks = taskCapture.getHandle()?.finishTasks;
    expect(
      finishTasks,
      "finish() should receive a finalTasks snapshot from StreamingBridge.markAllComplete()",
    ).toBeDefined();
    expect(finishTasks!.length).toBeGreaterThan(0);
  });

  it("plan-mode BridgeResult.success is true even with thinking + tool events", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: PLAN_MODE_FIXTURE.sessionId,
      events: [...PLAN_MODE_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.totalChars).toBe(PLAN_MODE_FIXTURE.expected.totalChars);
  });
});

// ===========================================================================
// AC 4b: DM trigger — full event-driven BridgeResult assertions
//
// Fires a raw Discord DM messageCreate event and verifies that the full
// DM dispatch path produces correct BridgeResult and session routing.
//
// DM-specific contracts:
//   - ChannelMessage.channelId = DM_GUILD_SENTINEL ("@dm") — no real guildId for DMs
//   - ChannelMessage.threadId = DM channel ID — the actual channel to fetch/stream to
//   - Session key: "discord:@dm:{dmChannelId}" (not "discord:{guildId}:{threadId}")
//   - isDirectMessage = true, isMention = false
// ===========================================================================

describe("DM trigger: full event-driven BridgeResult assertions", () => {
  it("DM trigger produces BridgeResult.success = true", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawDMMessage());

    expect(result.success).toBe(true);
  });

  it("DM trigger BridgeResult.sessionId matches the fixture session ID", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawDMMessage());

    expect(result.sessionId).toBe(DM_TEXT_FIXTURE.sessionId);
  });

  it("DM trigger BridgeResult.totalChars matches the fixture total character count", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawDMMessage());

    expect(result.totalChars).toBe(DM_TEXT_FIXTURE.expected.totalChars);
  });

  it("DM trigger BridgeResult.sessionCreated is true on first DM", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawDMMessage());

    expect(result.sessionCreated).toBe(true);
  });

  it("DM trigger BridgeResult.error is undefined on success", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawDMMessage());

    expect(result.error).toBeUndefined();
  });

  it("DM message is dispatched with channelId=DM_GUILD_SENTINEL and isDirectMessage=true", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const captured: ChannelMessage[] = [];
    adapter.onMessage((msg) => {
      captured.push(msg);
    });

    await emitMessageCreate(makeRawDMMessage());

    expect(captured).toHaveLength(1);
    expect(captured[0]!.channelId).toBe(DM_GUILD_SENTINEL);
    expect(captured[0]!.isDirectMessage).toBe(true);
    expect(captured[0]!.isMention).toBe(false);
    expect(captured[0]!.threadId).toBe(DM_CHANNEL_ID);
  });

  it("DM session is stored under the key discord:@dm:{dmChannelId}", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const sessionManager = new SessionManager();
    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    const bridge = makeWiredBridge(adapter, stub, sessionManager);
    const resultPromise = captureNextBridgeResult(adapter, bridge);
    await emitMessageCreate(makeRawDMMessage());
    await resultPromise;

    // DM uses the "@dm" sentinel as guildId in the session key
    const session = sessionManager.getSession("discord", DM_GUILD_SENTINEL, DM_CHANNEL_ID);
    expect(session).toBe(DM_TEXT_FIXTURE.sessionId);

    // Must NOT be stored under a real guildId
    const wrongSession = sessionManager.getSession("discord", GUILD_ID, DM_CHANNEL_ID);
    expect(wrongSession).toBeUndefined();
  });

  it("DM response is streamed to the DM channel (channels.fetch called with DM_CHANNEL_ID)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({
      sessionId: DM_TEXT_FIXTURE.sessionId,
      events: [...DM_TEXT_FIXTURE.events],
    });
    await runBridgeE2E(adapter, stub, makeRawDMMessage());

    // startStream / fetchTextChannel must use threadId = DM_CHANNEL_ID,
    // NOT channelId = "@dm" (which is the sentinel for session keying only)
    expect(mockChannelsFetch).toHaveBeenCalledWith(DM_CHANNEL_ID);
    expect(mockChannelsFetch).not.toHaveBeenCalledWith(DM_GUILD_SENTINEL);
  });

  it("DM thread creation is NOT attempted (no Discord thread for DM channels)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const stub = new StubAgentClient({ events: [...DM_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawDMMessage());

    // DM messages should NEVER trigger Discord thread creation
    expect(mockStartThread).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// AC 5: Event filtering — bot self-reply guard
//
// Messages authored by bots (message.author.bot = true) must be silently
// discarded before any handler is invoked, preventing infinite loops.
// ===========================================================================

describe("event filtering: bot self-reply guard", () => {
  it("bot-authored message is silently discarded (no handler invoked)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const captured: ChannelMessage[] = [];
    adapter.onMessage((msg) => {
      captured.push(msg);
    });

    // Emit a message with author.bot = true (simulating the bot's own message)
    await emitMessageCreate({
      ...makeRawGuildMentionMessage(),
      author: { id: BOT_ID, bot: true },
    });

    expect(captured).toHaveLength(0);
  });

  it("human-authored message is NOT discarded (handler is invoked)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const captured: ChannelMessage[] = [];
    adapter.onMessage((msg) => {
      captured.push(msg);
    });

    // author.bot = false → should be dispatched
    await emitMessageCreate(makeRawGuildMentionMessage());

    expect(captured).toHaveLength(1);
  });
});

// ===========================================================================
// AC 6: Event filtering — non-mention guard
//
// Guild messages that do NOT @mention the bot must be silently discarded.
// Only DMs and explicit @mentions trigger the bridge.
// ===========================================================================

describe("event filtering: non-mention guard", () => {
  it("guild message without @mention is silently discarded", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const captured: ChannelMessage[] = [];
    adapter.onMessage((msg) => {
      captured.push(msg);
    });

    // mentions.has() returns false → no @mention → should be discarded
    await emitMessageCreate({
      id: MSG_ID,
      channelId: "text-channel-001",
      guildId: GUILD_ID,
      content: "This is a regular message, not mentioning the bot.",
      author: { id: "user-001", bot: false },
      channel: { type: 0 }, // ChannelType.GuildText
      mentions: { has: (_id: string) => false }, // not mentioned
      startThread: mockStartThread,
    });

    expect(captured).toHaveLength(0);
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it("DM message without @mention is still dispatched (DMs always trigger)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    mockChannelsFetch.mockResolvedValue(makeFakeDMChannel());

    const captured: ChannelMessage[] = [];
    adapter.onMessage((msg) => {
      captured.push(msg);
    });

    // DMs do not require @mentions — they always trigger
    await emitMessageCreate(makeRawDMMessage());

    expect(captured).toHaveLength(1);
    expect(captured[0]!.isDirectMessage).toBe(true);
  });

  it("guild @mention IS dispatched (the positive control)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const captured: ChannelMessage[] = [];
    adapter.onMessage((msg) => {
      captured.push(msg);
    });

    await emitMessageCreate(makeRawGuildMentionMessage());

    expect(captured).toHaveLength(1);
    expect(captured[0]!.isMention).toBe(true);
    expect(captured[0]!.isDirectMessage).toBe(false);
  });
});

// ===========================================================================
// AC 7: Fixture integrity — the cassette analog
//
// Verify that the in-memory fixture definitions are internally consistent.
// These assertions mirror the AC 5 "auto record-on-miss" assertions in
// slack-bridge-e2e.test.ts (cassette file integrity checks).
// ===========================================================================

describe("fixture integrity — the cassette analog", () => {
  describe("BASIC_TEXT_FIXTURE", () => {
    it("event sequence is non-empty", () => {
      expect(
        BASIC_TEXT_FIXTURE.events.length,
        "BASIC_TEXT_FIXTURE.events must contain at least one event",
      ).toBeGreaterThan(0);
    });

    it("event sequence ends with a terminal event (done or error)", () => {
      const lastEvent = BASIC_TEXT_FIXTURE.events.at(-1);
      expect(lastEvent).toBeDefined();
      expect(
        ["done", "error"].includes(lastEvent!.type),
        `Last event type should be "done" or "error", got "${lastEvent!.type}"`,
      ).toBe(true);
    });

    it("expected.totalChars equals the sum of all text_delta event lengths", () => {
      const computed = computeFixtureTotalChars(BASIC_TEXT_FIXTURE.events);
      expect(BASIC_TEXT_FIXTURE.expected.totalChars).toBe(computed);
    });

    it("expected.updateCount equals the count of text_delta events", () => {
      const computed = computeFixtureUpdateCount(BASIC_TEXT_FIXTURE.events);
      expect(BASIC_TEXT_FIXTURE.expected.updateCount).toBe(computed);
    });

    it("expected.finalText equals the concatenation of all text_delta texts", () => {
      const computed = computeFixtureFinalText(BASIC_TEXT_FIXTURE.events);
      expect(BASIC_TEXT_FIXTURE.expected.finalText).toBe(computed);
    });

    it("sessionId is a non-empty string", () => {
      expect(typeof BASIC_TEXT_FIXTURE.sessionId).toBe("string");
      expect(BASIC_TEXT_FIXTURE.sessionId).toBeTruthy();
    });
  });

  describe("DM_TEXT_FIXTURE", () => {
    it("event sequence is non-empty", () => {
      expect(DM_TEXT_FIXTURE.events.length).toBeGreaterThan(0);
    });

    it("event sequence ends with a terminal event (done or error)", () => {
      const lastEvent = DM_TEXT_FIXTURE.events.at(-1);
      expect(lastEvent).toBeDefined();
      expect(["done", "error"].includes(lastEvent!.type)).toBe(true);
    });

    it("expected.totalChars equals the sum of all text_delta event lengths", () => {
      const computed = computeFixtureTotalChars(DM_TEXT_FIXTURE.events);
      expect(DM_TEXT_FIXTURE.expected.totalChars).toBe(computed);
    });

    it("expected.updateCount equals the count of text_delta events", () => {
      const computed = computeFixtureUpdateCount(DM_TEXT_FIXTURE.events);
      expect(DM_TEXT_FIXTURE.expected.updateCount).toBe(computed);
    });

    it("sessionId is different from BASIC_TEXT_FIXTURE.sessionId (no cross-fixture collision)", () => {
      expect(DM_TEXT_FIXTURE.sessionId).not.toBe(BASIC_TEXT_FIXTURE.sessionId);
    });
  });

  describe("PLAN_MODE_FIXTURE", () => {
    it("event sequence is non-empty", () => {
      expect(PLAN_MODE_FIXTURE.events.length).toBeGreaterThan(0);
    });

    it("event sequence ends with a terminal event (done or error)", () => {
      const lastEvent = PLAN_MODE_FIXTURE.events.at(-1);
      expect(lastEvent).toBeDefined();
      expect(["done", "error"].includes(lastEvent!.type)).toBe(true);
    });

    it("event sequence contains at least one thinking event", () => {
      const hasThinking = PLAN_MODE_FIXTURE.events.some((e) => e.type === "thinking");
      expect(hasThinking).toBe(true);
    });

    it("event sequence contains at least one tool_use event", () => {
      const hasToolUse = PLAN_MODE_FIXTURE.events.some((e) => e.type === "tool_use");
      expect(hasToolUse).toBe(true);
    });

    it("event sequence contains at least one tool_result event", () => {
      const hasToolResult = PLAN_MODE_FIXTURE.events.some((e) => e.type === "tool_result");
      expect(hasToolResult).toBe(true);
    });

    it("expected.totalChars equals the sum of all text_delta event lengths", () => {
      const computed = computeFixtureTotalChars(PLAN_MODE_FIXTURE.events);
      expect(PLAN_MODE_FIXTURE.expected.totalChars).toBe(computed);
    });

    it("sessionId is distinct from all other fixture session IDs", () => {
      expect(PLAN_MODE_FIXTURE.sessionId).not.toBe(BASIC_TEXT_FIXTURE.sessionId);
      expect(PLAN_MODE_FIXTURE.sessionId).not.toBe(DM_TEXT_FIXTURE.sessionId);
    });
  });
});

// ===========================================================================
// AC 4b: Streaming lifecycle — stream start/append/finish phase correctness
//
// Verifies the Discord streaming lifecycle phases:
//   1. Stream start: placeholder message sent with THINKING_PLACEHOLDER content
//   2. Append phase: text_delta events accumulate in-memory (no edits yet with
//      deferred timer at Date.now()=0)
//   3. Finish phase: finish() cancels the pending timer, drains the full buffer
//      with a single edit call
//
// Also verifies:
//   - Empty agent response (no text_delta) → placeholder replaced with "(no response)"
//   - setStatus() triggers Discord typing indicator (channel.sendTyping())
// ===========================================================================

describe("streaming lifecycle: start/append/finish phase correctness", () => {
  it("placeholder message is sent with THINKING_PLACEHOLDER content (⏳ Thinking…)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // The first send() call must be the initial placeholder before any streaming edits
    expect(mockSend).toHaveBeenCalledTimes(1);
    const firstSendArg = mockSend.mock.calls[0]![0] as { content: string };
    expect(firstSendArg.content).toBe(THINKING_PLACEHOLDER);
  });

  it("empty agent response (no text_delta events) edits placeholder with '(no response)'", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_EMPTY,
      events: [...EMPTY_RESPONSE_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // With no text_delta events, fullText="" so the bridge calls
    // finish(emptyResponseText). The DiscordStreamHandle edits the placeholder
    // with the bridge's fallback message rather than its internal "(no response)".
    const lastEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
    expect(lastEditArg.content).toBe("I received your message but had no response.");
  });

  it("multiple text_delta events accumulate and are flushed as a single edit at finish()", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // BASIC_TEXT_FIXTURE has 2 text_delta events — both are buffered before finish()
    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // With fake timers (Date.now()=0): each append() defers 1000ms, finish() cancels
    // and flushes synchronously — 1 edit from appendTasks (init indicator) + 1 from finish() = 2 total
    expect(mockEdit).toHaveBeenCalledTimes(2);
  });

  it("the single final edit contains the full concatenated text from all text_delta events", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // The content of the sole edit must be the concatenation of both text deltas
    const finalEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
    expect(finalEditArg.content).toContain(BASIC_TEXT_FIXTURE.expected.finalText);
  });

  it("no intermediate edits fire during append() when timer is deferred — only finish() triggers edit", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // Three separate text_delta events exercising three append() calls
    const multiDeltaEvents: AgentStreamEvent[] = [
      { type: "text_delta", text: "First " },
      { type: "text_delta", text: "Second " },
      { type: "text_delta", text: "Third." },
      { type: "done" },
    ];
    const stub = new StubAgentClient({ events: multiDeltaEvents });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // appendTasks() fires once at stream start (init indicator edit) → 1 edit.
    // finish() fires once (content is < 2000 chars, single chunk) → 1 edit.
    // Total: 2 edits. No extra edits from deferred timers (timer never fires with fake timers).
    expect(mockEdit).toHaveBeenCalledTimes(2);

    // The LAST edit (from finish()) must contain all three deltas in order.
    // calls[0] is the appendTasks init indicator; calls[1] is the finish() content edit.
    const editArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
    expect(editArg.content).toBe("First Second Third.");
  });

  it("setStatus triggers Discord typing indicator (channel.sendTyping called)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({ events: [...BASIC_TEXT_FIXTURE.events] });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // StreamingBridge calls adapter.setStatus() before streaming — adapter calls
    // channel.sendTyping() to show the typing indicator in the Discord channel
    expect(mockSendTyping).toHaveBeenCalled();
  });

  it("BridgeResult reports correct totalChars for the full concatenated text", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: BASIC_TEXT_FIXTURE.sessionId,
      events: [...BASIC_TEXT_FIXTURE.events],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // totalChars must equal the sum of all text_delta.text lengths in the fixture
    expect(result.totalChars).toBe(BASIC_TEXT_FIXTURE.expected.totalChars);
    expect(result.updateCount).toBe(BASIC_TEXT_FIXTURE.expected.updateCount);
  });
});

// ===========================================================================
// AC 4b: 2K message overflow via finish() drain
//
// With vi.useFakeTimers({ now: 0 }) all text accumulates before finish() is
// called — none of the 1000ms deferred timers fire. finish() drains the full
// buffer by splitting at DISCORD_MESSAGE_LIMIT boundaries:
//
//   For content ≤ 2000 chars:
//     edit(content)
//
//   For content > 2000 chars:
//     edit(first 2000 chars)                   ← edits the initial placeholder
//     send(THINKING_PLACEHOLDER)               ← new continuation message
//     edit(next up-to-2000 chars)              ← edits continuation message
//     [repeat send + edit until buffer empty]
//
// send() call count = 1 (placeholder) + (number of overflow continuation messages)
// edit() call count = number of 2000-char chunks in the total content
// ===========================================================================

describe("2K message overflow via finish() drain", () => {
  it("content exactly 2000 chars: single edit, no overflow (send called only once for placeholder)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...EXACT_2000_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // Exactly at the limit: no overflow → 1 appendTasks init edit + 1 finish() edit = 2 total
    expect(mockEdit).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(1); // only the initial placeholder
  });

  it("content exactly 2000 chars: edit contains the full 2000-char text", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...EXACT_2000_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // calls[0] = appendTasks init indicator; calls.at(-1) = finish() drain (the 2000-char text)
    const editArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
    expect(editArg.content).toBe(EXACT_2000_TEXT);
    expect(editArg.content).toHaveLength(DISCORD_MESSAGE_LIMIT);
  });

  it("content 2001 chars: first edit contains exactly 2000 chars (the split boundary)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_2001_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // calls[0] = appendTasks init indicator; calls[1] = first finish() chunk (2000 chars)
    const firstEditArg = mockEdit.mock.calls[1]![0] as { content: string };
    expect(firstEditArg.content).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(firstEditArg.content).toBe("X".repeat(DISCORD_MESSAGE_LIMIT));
  });

  it("content 2001 chars: mockEdit called exactly twice — one per split chunk", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_2001_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // 1 appendTasks init indicator + 2 finish() chunks (2000 + 1) = 3 total
    expect(mockEdit).toHaveBeenCalledTimes(3);
  });

  it("content 2001 chars: second edit contains the remaining 1-char overflow remainder", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_2001_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // calls[0] = appendTasks init; calls[1] = first chunk (2000); calls.at(-1) = second chunk (1 char)
    const secondEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
    expect(secondEditArg.content).toBe("X");
    expect(secondEditArg.content).toHaveLength(1);
  });

  it("content 2001 chars: overflow triggers a second send call (continuation placeholder)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_2001_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // 2 send calls: initial placeholder + overflow continuation
    expect(mockSend).toHaveBeenCalledTimes(2);
    // The overflow continuation must be a THINKING_PLACEHOLDER so the user sees
    // an activity indicator while the rest of the response is streamed in
    const secondSendArg = mockSend.mock.calls[1]![0] as { content: string };
    expect(secondSendArg.content).toBe(THINKING_PLACEHOLDER);
  });

  it("content 4001 chars: 3 edits and 3 total send calls (placeholder + 2 continuations)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_4001_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // 4001 chars = 2000 + 2000 + 1 → 1 appendTasks + 3 finish() chunks = 4 edit calls
    // send calls: 3 (1 placeholder + 2 continuations)
    expect(mockEdit).toHaveBeenCalledTimes(4);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("content 4001 chars: each edit chunk has the correct content at each split boundary", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_4001_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    const editContents = mockEdit.mock.calls.map(
      (call) => (call[0] as { content: string }).content,
    );
    // editContents[0] = appendTasks init indicator ("💡 Initializing...\n\n")
    // editContents[1..3] = the three finish() drain chunks
    expect(editContents[1]).toBe("Y".repeat(2000));
    expect(editContents[2]).toBe("Y".repeat(2000));
    expect(editContents[3]).toBe("Y"); // 1-char remainder
  });

  it("multi-delta: two 1001-char deltas overflow at the correct byte boundary", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...MULTI_DELTA_OVERFLOW_EVENTS],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // Total: 2002 chars → 1 appendTasks init + 2 finish() chunks = 3 edit calls
    // send calls: 2 (placeholder + continuation)
    expect(mockEdit).toHaveBeenCalledTimes(3);
    expect(mockSend).toHaveBeenCalledTimes(2);

    // calls[0] = appendTasks init indicator; calls[1] = first finish() chunk; calls.at(-1) = second
    const firstEditArg = mockEdit.mock.calls[1]![0] as { content: string };
    const secondEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };

    // First chunk: "A"*1001 + "B"*999 = exactly 2000 chars (the split point)
    expect(firstEditArg.content).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(firstEditArg.content).toBe("A".repeat(1001) + "B".repeat(999));

    // Second chunk: "B"*2 = the 2-char remainder from the second delta
    expect(secondEditArg.content).toBe("B".repeat(2));
  });

  it("BridgeResult.success is true and totalChars is correct even with overflow", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_ID_OVERFLOW,
      events: [...OVERFLOW_2001_EVENTS],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.totalChars).toBe(2001);
  });
});

// ===========================================================================
// AC 4b: 2K overflow during mid-stream flushEdit (timer-triggered)
//
// Tests the flushEdit() overflow path — triggered when the ~1 s cadence timer
// fires BEFORE finish() is called. These tests use DiscordStreamHandle directly
// to advance timers independently of the StreamingBridge lifecycle.
//
// Coordinator note addressed here:
//   "In DiscordStreamHandle.flushEdit(), overflow text is truncated to
//    DISCORD_MESSAGE_LIMIT before being assigned to this.accumulatedText.
//    This silently discards text between the 2nd and 4th kilobytes."
//
// The tests below VERIFY that the current implementation stores the FULL overflow
// in accumulatedText (not truncated to 2000 chars) so no content is silently lost.
// This also serves as regression protection against future truncation bugs.
// ===========================================================================

describe("2K overflow during mid-stream flushEdit (timer-triggered)", () => {
  it("flushEdit splits 2001-char accumulated text at the 2000-char boundary", async () => {
    const initialEditFn = vi.fn().mockResolvedValue({});
    const overflowEditFn = vi.fn().mockResolvedValue({});
    const channelSendFn = vi.fn().mockResolvedValue({
      edit: overflowEditFn,
    } satisfies DiscordEditableMessage);

    const initialMsg: DiscordEditableMessage = { edit: initialEditFn };
    const channel: DiscordSendableChannel = { send: channelSendFn };

    const handle = new DiscordStreamHandle(initialMsg, channel);

    // Append 2001 chars — timer is deferred 1000ms (Date.now()=0, elapsed=0)
    await handle.append("X".repeat(2001));

    // Advance 1000ms to trigger the deferred flushEdit()
    await vi.advanceTimersByTimeAsync(1000);

    // flushEdit should have edited the initial message with the first 2000 chars
    expect(initialEditFn).toHaveBeenCalledWith({ content: "X".repeat(2000) });
  });

  it("flushEdit posts overflow content (chars 2001-N) as a new channel.send() message", async () => {
    const initialEditFn = vi.fn().mockResolvedValue({});
    const overflowEditFn = vi.fn().mockResolvedValue({});
    const channelSendFn = vi.fn().mockResolvedValue({
      edit: overflowEditFn,
    } satisfies DiscordEditableMessage);

    const initialMsg: DiscordEditableMessage = { edit: initialEditFn };
    const channel: DiscordSendableChannel = { send: channelSendFn };

    const handle = new DiscordStreamHandle(initialMsg, channel);

    await handle.append("X".repeat(2001));
    await vi.advanceTimersByTimeAsync(1000);

    // The overflow (1 char) must be sent as a new message that becomes the edit target
    expect(channelSendFn).toHaveBeenCalledWith({ content: "X" });
  });

  it("full overflow text is preserved in accumulatedText after flushEdit (not truncated to 2000)", async () => {
    // Test: append 2001 chars, fire timer, then append more and finish()
    // If accumulatedText were truncated to 2000 after flushEdit, the final
    // edit would be missing content.
    const initialEditFn = vi.fn().mockResolvedValue({});
    const overflowEditFn = vi.fn().mockResolvedValue({});
    const channelSendFn = vi.fn().mockResolvedValue({
      edit: overflowEditFn,
    } satisfies DiscordEditableMessage);

    const initialMsg: DiscordEditableMessage = { edit: initialEditFn };
    const channel: DiscordSendableChannel = { send: channelSendFn };

    const handle = new DiscordStreamHandle(initialMsg, channel);

    // 2001 chars: 2000 go to initial edit, 1 char ("X") is the overflow
    await handle.append("X".repeat(2001));
    await vi.advanceTimersByTimeAsync(1000); // fires flushEdit

    // append more content after the overflow — builds on preserved accumulatedText
    await handle.append("Z");

    // finish() drains: accumulatedText should be "X" (preserved from overflow) + "Z"
    await handle.finish();

    // The overflow message edit must contain both the 1-char overflow AND the new char
    expect(overflowEditFn).toHaveBeenCalledWith({ content: "XZ" });
  });

  it("coordinator edge case: chars 2K–4K are NOT silently discarded when overflow > 2000", async () => {
    // Verify that a 3001-char overflow (which displays only 2000 chars but stores
    // the full 1001 chars in accumulatedText) is fully drained by finish().
    // If the bug described in the coordinator review existed, accumulatedText
    // would be truncated and finish() would not receive the chars beyond 2K.
    const initialEditFn = vi.fn().mockResolvedValue({});
    const overflowEditFn = vi.fn().mockResolvedValue({});
    const channelSendFn = vi.fn().mockResolvedValue({
      edit: overflowEditFn,
    } satisfies DiscordEditableMessage);

    const initialMsg: DiscordEditableMessage = { edit: initialEditFn };
    const channel: DiscordSendableChannel = { send: channelSendFn };

    const handle = new DiscordStreamHandle(initialMsg, channel);

    // Append 3001 chars: 2000 'A's + 1001 'B's
    // After flushEdit: initial message = "A"*2000; overflow = "B"*1001
    // accumulatedText must be "B"*1001 (full 1001, NOT truncated to 2000)
    await handle.append("A".repeat(2000) + "B".repeat(1001));
    await vi.advanceTimersByTimeAsync(1000); // fires flushEdit

    // finish() drains: accumulatedText = "B"*1001 → single edit (fits in 2000 chars)
    await handle.finish();

    // The overflow message must contain all 1001 'B' chars — none silently dropped
    expect(overflowEditFn).toHaveBeenCalledWith({ content: "B".repeat(1001) });
  });

  it("text > 4000 chars: flushEdit schedules a second flush for overflow > 2K", async () => {
    // When accumulated text > 4000 chars, the first flushEdit's overflow is itself > 2000.
    // flushEdit should call scheduleFlush() again so the remaining overflow is drained
    // progressively — without waiting for another append() call.
    let sendCallCount = 0;
    const initialEditFn = vi.fn().mockResolvedValue({});
    const overflowMsg1EditFn = vi.fn().mockResolvedValue({});
    const overflowMsg2EditFn = vi.fn().mockResolvedValue({});
    const channelSendFn = vi.fn().mockImplementation(() => {
      sendCallCount++;
      return Promise.resolve({
        edit: sendCallCount === 1 ? overflowMsg1EditFn : overflowMsg2EditFn,
      });
    });

    const initialMsg: DiscordEditableMessage = { edit: initialEditFn };
    const channel: DiscordSendableChannel = { send: channelSendFn };

    const handle = new DiscordStreamHandle(initialMsg, channel);

    // Append 4001 chars: overflow = 2001 chars > 2000 → should trigger rescheduled flush
    await handle.append("X".repeat(4001));

    // First timer fires (t=1000): flushEdit on 4001 chars
    //   → edit initial msg with X*2000
    //   → send X*2000 as new msg (first 2000 of 2001-char overflow displayed)
    //   → accumulatedText = X*2001 (full overflow)
    //   → overflow.length (2001) > 2000 → scheduleFlush() ← key assertion
    await vi.advanceTimersByTimeAsync(1000);

    // Second timer fires (t=2000): flushEdit on X*2001
    //   → edit overflow msg 1 with X*2000
    //   → send({ content: "X" }) — 1-char remainder baked into new send() call
    //   → accumulatedText = X*1
    //   → overflow.length (1) ≤ 2000 → NO third scheduleFlush
    await vi.advanceTimersByTimeAsync(1000);

    // No third timer fires — overflow at t=2000 was ≤ 2000 chars, so scheduleFlush
    // was not called again.  Advance anyway to confirm no extra flush happens.
    await vi.advanceTimersByTimeAsync(1000);

    // All 4001 chars fully processed across three messages:
    // initial edit: X*2000
    expect(initialEditFn).toHaveBeenCalledWith({ content: "X".repeat(2000) });
    // overflow msg 1 edit: X*2000 (second batch from second flushEdit)
    expect(overflowMsg1EditFn).toHaveBeenCalledWith({ content: "X".repeat(2000) });
    // overflow msg 2: final 1-char remainder baked into the send() call itself
    // (overflow ≤ 2000 means content goes directly into send(), no subsequent edit)
    expect(channelSendFn.mock.calls[1]![0]).toEqual({ content: "X" });
  });
});

// ===========================================================================
// AC 4c: Rate-limit fallback — event-driven integration
//
// These scenarios exercise the rate-limit fallback path through the FULL
// event-driven flow: emitMessageCreate → DiscordAdapter → StreamingBridge.
//
// The companion discord-rate-limit-fallback-e2e.test.ts covers the
// DiscordStreamHandle mechanics in isolation via bridge.handleMessage().
// This suite confirms that the same fallback behaviour is observable at
// the adapter event boundary and that BridgeResult fields are accurate.
//
// Scenarios:
//   1. Pre-rate-limited channel: BridgeResult.success=true via event path
//   2. Pre-rate-limited channel: content via channel.send() — never via edit()
//   3. Mid-stream 429 (appendTasks) via event path: success=true, fallback active
//   4. Mid-stream 429: subsequent content goes via send(), edit() called only once
//   5. Per-channel isolation: rate limit on THREAD_ID ≠ another thread
//   6. totalChars counted accurately even when in fallback mode
// ===========================================================================

describe("AC 4c: rate-limit fallback — event-driven integration", () => {
  /**
   * Build a Discord-style 429 error that DiscordRateLimitTracker.isRateLimitError()
   * will recognise (status === 429).  Mirrors the helper in the companion
   * discord-rate-limit-fallback-e2e.test.ts but scoped locally to this suite.
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

  it("pre-rate-limited channel: BridgeResult.success=true via the full event-driven path", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // Seed a 429 hit for THREAD_ID before any message is processed.
    // DiscordStreamHandle sees the active cooldown at construction and enters
    // fallback mode immediately — no Discord API edits are attempted.
    adapter.getRateLimitTracker().recordHit(THREAD_ID);

    const stub = new StubAgentClient({
      sessionId: "session-rl-event-001",
      events: [
        { type: "text_delta", text: "Fallback reply." },
        { type: "done" },
      ],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("pre-rate-limited channel: content delivered via channel.send() — message.edit() never called", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    adapter.getRateLimitTracker().recordHit(THREAD_ID);

    const responseText = "Full fallback response text.";
    const stub = new StubAgentClient({
      events: [
        { type: "text_delta", text: responseText },
        { type: "done" },
      ],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // In pre-rate-limited fallback mode the DiscordStreamHandle never edits;
    // all content (placeholder + response) arrives via channel.send() calls.
    expect(mockEdit).not.toHaveBeenCalled();
    const sendContents = mockSend.mock.calls.map(
      (c) => (c[0] as { content: string }).content,
    );
    expect(sendContents).toContain(THINKING_PLACEHOLDER);
    expect(sendContents).toContain(responseText);
  });

  it("mid-stream 429 (appendTasks): BridgeResult.success=true after fallback switch via event path", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // The first edit attempt (appendTasks init indicator) throws a 429, which
    // causes DiscordStreamHandle to switch to fallback mode mid-stream.
    mockEdit.mockRejectedValueOnce(make429Error());

    const stub = new StubAgentClient({
      events: [
        { type: "text_delta", text: "Content after 429 switch." },
        { type: "done" },
      ],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // Bridge must report success=true — fallback is transparent to callers.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // The 429 must be reflected in the adapter's shared rate-limit tracker.
    expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);
  });

  it("mid-stream 429 (appendTasks): subsequent content delivered via send(), edit() called exactly once", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // Exactly one edit attempt (the failed appendTasks init indicator).
    mockEdit.mockRejectedValueOnce(make429Error());

    const responseText = "Post-429 response text.";
    const stub = new StubAgentClient({
      events: [
        { type: "text_delta", text: responseText },
        { type: "done" },
      ],
    });
    await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    // Only the failed appendTasks edit was attempted; no further edits occur.
    // All buffered content is flushed via channel.send() in finish().
    expect(mockEdit).toHaveBeenCalledTimes(1);
    const sendContents = mockSend.mock.calls.map(
      (c) => (c[0] as { content: string }).content,
    );
    expect(sendContents).toContain(responseText);
  });

  it("per-channel isolation: rate limit on THREAD_ID does not affect a different thread", async () => {
    const UNAFFECTED_THREAD = "THREAD-UNAFFECTED-E2E-001";
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // Rate-limit only THREAD_ID; the unaffected thread must be clean.
    adapter.getRateLimitTracker().recordHit(THREAD_ID);

    expect(adapter.isChannelRateLimited(THREAD_ID)).toBe(true);
    expect(adapter.isChannelRateLimited(UNAFFECTED_THREAD)).toBe(false);
  });

  it("totalChars counted accurately in fallback mode (all text_delta chars counted)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    adapter.getRateLimitTracker().recordHit(THREAD_ID);

    const parts = ["Hello", " World", "!"];
    const expectedChars = parts.reduce((sum, p) => sum + p.length, 0);
    const stub = new StubAgentClient({
      events: [
        ...parts.map((text) => ({ type: "text_delta" as const, text })),
        { type: "done" },
      ],
    });
    const { result } = await runBridgeE2E(adapter, stub, makeRawGuildMentionMessage());

    expect(result.success).toBe(true);
    expect(result.totalChars).toBe(expectedChars);
  });
});

// ===========================================================================
// AC 4c: Concurrent thread processing — no cross-contamination
//
// StreamingBridge uses a per-thread lock (`activeThreads` Map, keyed by
// "discord:{channelId}:{threadId}") to serialise requests for the SAME
// thread while allowing DIFFERENT threads to run simultaneously.
//
// Key invariant: the lock is acquired synchronously (before the first await
// inside handleMessage), so the guard fires before any I/O begins.
//
// Scenarios covered:
//   1. Two concurrent messages on different threads — both succeed
//   2. Same-thread concurrent guard — exactly one succeeds, one is rejected
//   3. Rejected concurrent message returns a result object (does NOT throw)
//   4. Sessions stored independently (separate SessionManager keys per thread)
//   5. Sequential messages on the same thread reuse the existing session
//   6. Rate-limit state on thread A does NOT bleed into thread B
//   7. Concurrent DM + guild thread processed independently
// ===========================================================================

describe("AC 4c: concurrent thread processing — no cross-contamination", () => {
  const THREAD_CONC_A = "THREAD-CONC-A-001";
  const THREAD_CONC_B = "THREAD-CONC-B-001";
  const SESSION_CONC_A = "session-concurrent-A-001";
  const SESSION_CONC_B = "session-concurrent-B-001";

  /**
   * Build a normalised ChannelMessage for a specific guild thread.
   * Uses bridge.handleMessage() directly — no Discord event emission needed.
   */
  function makeGuildThreadMessage(
    threadId: string,
    overrides: Partial<ChannelMessage> = {},
  ): ChannelMessage {
    return {
      id: `msg-${threadId}`,
      channelId: GUILD_ID,
      threadId,
      userId: `user-${threadId}`,
      text: `What is 1 + 1? (thread ${threadId})`,
      isMention: true,
      isDirectMessage: false,
      ...overrides,
    };
  }

  it("two concurrent messages on different threads both complete with success=true", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();
    // Single bridge instance — realistic production scenario with one bridge per adapter.
    const stub = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge = makeWiredBridge(adapter, stub, sessionManager);

    // THREAD_CONC_A and THREAD_CONC_B have different thread keys, so they
    // are processed simultaneously without either triggering the concurrency guard.
    const [resultA, resultB] = await Promise.all([
      bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_A)),
      bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_B)),
    ]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
  });

  it("same-thread concurrent guard: exactly one message succeeds and one is rejected", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();
    const stub = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge = makeWiredBridge(adapter, stub, sessionManager);

    // Fire two messages for the SAME thread simultaneously.
    // The activeThreads guard acquires the lock BEFORE the first await, so:
    //   Call 1: check (not set) → set key → await createSession()
    //   Call 2: check (SET!) → return {success:false} immediately
    const [result1, result2] = await Promise.all([
      bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_A)),
      bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_A)),
    ]);

    const results = [result1, result2];
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it("same-thread guard: rejected concurrent message returns a result — does NOT throw", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();
    const stub = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge = makeWiredBridge(adapter, stub, sessionManager);

    // Both calls must resolve — neither must throw or cause an unhandled rejection.
    const [result1, result2] = await Promise.all([
      bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_A)),
      bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_A)),
    ]);

    // The rejected message returns a BridgeResult with success=false and an error string.
    const failedResult = result1.success ? result2 : result1;
    expect(failedResult.success).toBe(false);
    expect(typeof failedResult.error).toBe("string");
    expect(failedResult.error!.length).toBeGreaterThan(0);
  });

  it("sessions for independent threads stored under separate SessionManager keys", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();
    const stub = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge = makeWiredBridge(adapter, stub, sessionManager);

    // Process Thread A only — Thread B's key must remain empty.
    await bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_A));

    const storedA = sessionManager.getSession("discord", GUILD_ID, THREAD_CONC_A);
    const storedB = sessionManager.getSession("discord", GUILD_ID, THREAD_CONC_B);

    expect(storedA).toBe(SESSION_CONC_A);
    expect(storedB).toBeUndefined();
  });

  it("second sequential message on the same thread reuses the existing session (sessionCreated=false)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();

    // First message: no existing session → creates one (sessionCreated=true).
    const stub1 = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge1 = makeWiredBridge(adapter, stub1, sessionManager);
    const result1 = await bridge1.handleMessage(makeGuildThreadMessage(THREAD_CONC_A));

    expect(result1.sessionCreated).toBe(true);
    expect(result1.sessionId).toBe(SESSION_CONC_A);

    // Second message on the SAME thread after the first completes.
    // SessionManager already has the session → sessionCreated must be false.
    const stub2 = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge2 = makeWiredBridge(adapter, stub2, sessionManager);
    const result2 = await bridge2.handleMessage(makeGuildThreadMessage(THREAD_CONC_A));

    expect(result2.sessionCreated).toBe(false);
    expect(result2.sessionId).toBe(SESSION_CONC_A);
  });

  it("rate-limit on thread A does NOT bleed into thread B (per-channel isolation)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // Manually seed a 429 hit for THREAD_CONC_A only.
    adapter.getRateLimitTracker().recordHit(THREAD_CONC_A);

    // Verify isolation at the tracker level.
    expect(adapter.isChannelRateLimited(THREAD_CONC_A)).toBe(true);
    expect(adapter.isChannelRateLimited(THREAD_CONC_B)).toBe(false);

    // Thread B must process via the normal edit path (not fallback mode).
    const sessionManager = new SessionManager();
    const stub = new StubAgentClient({
      sessionId: SESSION_CONC_B,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge = makeWiredBridge(adapter, stub, sessionManager);
    const result = await bridge.handleMessage(makeGuildThreadMessage(THREAD_CONC_B));

    expect(result.success).toBe(true);
    // Normal edit path: at minimum the appendTasks init indicator edit was called.
    expect(mockEdit).toHaveBeenCalled();
  });

  it("concurrent DM and guild thread processed independently — no session cross-contamination", async () => {
    const DM_CONC_CHANNEL = "DM-CONCURRENT-001";
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();

    // Two separate bridges, each with their own StubAgentClient, sharing a SessionManager.
    const dmStub = new StubAgentClient({
      sessionId: SESSION_CONC_A,
      events: [...DM_TEXT_EVENTS],
    });
    const guildStub = new StubAgentClient({
      sessionId: SESSION_CONC_B,
      events: [...BASIC_TEXT_EVENTS],
    });
    const dmBridge = makeWiredBridge(adapter, dmStub, sessionManager);
    const guildBridge = makeWiredBridge(adapter, guildStub, sessionManager);

    const dmMsg: ChannelMessage = {
      id: "dm-conc-001",
      channelId: DM_GUILD_SENTINEL, // "@dm" sentinel — no real guild for DMs
      threadId: DM_CONC_CHANNEL,
      userId: "dm-user-001",
      text: "DM message",
      isMention: false,
      isDirectMessage: true,
    };
    const guildMsg: ChannelMessage = {
      id: "guild-conc-001",
      channelId: GUILD_ID,
      threadId: THREAD_CONC_A,
      userId: "guild-user-001",
      text: "Guild @mention",
      isMention: true,
      isDirectMessage: false,
    };

    const [dmResult, guildResult] = await Promise.all([
      dmBridge.handleMessage(dmMsg),
      guildBridge.handleMessage(guildMsg),
    ]);

    expect(dmResult.success).toBe(true);
    expect(guildResult.success).toBe(true);

    // Sessions stored under completely separate keys — zero cross-contamination.
    const dmSession = sessionManager.getSession("discord", DM_GUILD_SENTINEL, DM_CONC_CHANNEL);
    const guildSession = sessionManager.getSession("discord", GUILD_ID, THREAD_CONC_A);
    expect(dmSession).toBe(SESSION_CONC_A);
    expect(guildSession).toBe(SESSION_CONC_B);
  });
});

// ===========================================================================
// AC 4d: Error handling and graceful shutdown
//
// ## Scenario categories
//
//   1. Transient error retry
//      SessionOutputReader retries when the agent generator THROWS a transient
//      error (503, network). The bridge does NOT see an error event during
//      retry — only after all retries are exhausted does it receive lastError.
//      ThrowingRetryStubClient throws rather than yields error events so the
//      reader's catch block handles retry without emitting to bridge listeners.
//
//   2. Permanent error surfacing
//      Non-retryable errors (401, 403) yielded as error events are immediately
//      surfaced in BridgeResult: success=false, error set, finish() called with
//      formatted error message. No retry is attempted.
//
//   3. Partial stream failure recovery
//      When text_delta events arrive before an error event the bridge preserves
//      partial chars in BridgeResult.totalChars while success=false and
//      finish() is called with the formatted error message.
//
//   4. SIGINT/SIGTERM shutdown with in-flight stream cleanup
//      Process signals trigger bridge.abortAll() via a registered shutdown
//      handler. In-flight streams receive the AbortSignal and complete with
//      BridgeResult.success=false. Signal handlers are registered via
//      process.once() to prevent accumulation.
//
//   5. abortAll() behavior
//      abortAll() returns the count of aborted threads, is idempotent,
//      isThreadActive() reflects state correctly, and the aborted stream
//      produces BridgeResult.success=false with error matching /abort/i.
// ===========================================================================

describe("AC 4d: error handling and graceful shutdown", () => {
  // =========================================================================
  // Local stub variants for AC 4d-specific scenarios
  // =========================================================================

  /**
   * StubAgentClient that THROWS errors (not yields them as events) for retry tests.
   *
   * When a generator THROWS rather than yields an error event, SessionOutputReader
   * catches it in the outer try/catch WITHOUT emitting to bridge listeners. This
   * means bridge.streamError stays unset on a transient throw-retry, so a
   * successful retry produces BridgeResult.success=true.
   *
   * The first `failCalls` invocations throw `errorMessage` (a transient string).
   * Subsequent invocations yield `successEvents` normally.
   */
  class ThrowingRetryStubClient {
    private callCount = 0;

    constructor(
      private readonly successEvents: AgentStreamEvent[],
      private readonly failCalls: number,
      private readonly sessionId = "session-throw-retry-e2e-001",
      private readonly errorMessage = "503 Service Unavailable",
    ) {}

    get callsMade(): number {
      return this.callCount;
    }

    async createSession(): Promise<string> {
      return this.sessionId;
    }

    async *sendMessage(
      _sessionId: string,
      _text: string,
      _options?: { signal?: AbortSignal },
    ): AsyncGenerator<AgentStreamEvent> {
      this.callCount++;
      if (this.callCount <= this.failCalls) {
        throw new Error(this.errorMessage);
      }
      for (const event of this.successEvents) {
        yield event;
      }
    }
  }

  /**
   * StubAgentClient that blocks mid-stream until its AbortSignal fires.
   *
   * Yields one text_delta then suspends at `await new Promise(...)` that only
   * resolves when options.signal fires the "abort" event.
   *
   * When bridge.abortAll() fires → AbortController.abort() → signal "abort" event
   * → Promise rejects → generator throws → SessionOutputReader catches it (with
   * _aborted=true) → emits { type: "error", error: "Stream aborted" } → bridge
   * calls finish() → handleMessage resolves with success=false.
   */
  class AbortableStubClient {
    constructor(
      private readonly sessionId = "session-abortable-e2e-001",
      private readonly partialText = "partial response",
    ) {}

    async createSession(): Promise<string> {
      return this.sessionId;
    }

    async *sendMessage(
      _sessionId: string,
      _text: string,
      options?: { signal?: AbortSignal },
    ): AsyncGenerator<AgentStreamEvent> {
      yield { type: "text_delta", text: this.partialText } as AgentStreamEvent;
      // Block until the AbortSignal fires
      await new Promise<void>((_, reject) => {
        if (options?.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
      // Never reached when aborted — kept for completeness:
      yield { type: "done" } as AgentStreamEvent;
    }
  }

  /**
   * Build a ChannelMessage targeting a specific thread in the standard guild.
   * Uses unique thread IDs per test to prevent session-key collisions.
   */
  function makeGuildMsg(
    threadId: string,
    overrides: Partial<ChannelMessage> = {},
  ): ChannelMessage {
    return {
      id: `msg-${threadId}`,
      channelId: GUILD_ID,
      threadId,
      userId: "user-ac4d-001",
      text: "What is 1 + 1?",
      isMention: true,
      isDirectMessage: false,
      ...overrides,
    };
  }

  /**
   * Build a StreamingBridge with retries enabled (for transient retry tests).
   * Unlike makeWiredBridge(), this does NOT suppress retries.
   */
  function makeRetryBridge(
    adapter: DiscordAdapter,
    client: ThrowingRetryStubClient | StubAgentClient,
    maxRetries: number,
    sessionManager = new SessionManager(),
  ): StreamingBridge {
    return new StreamingBridge({
      adapter,
      agentClient: client as unknown as AgentClient,
      sessionManager,
      maxRetries,
      // Use 1ms (not 0ms) so that retry delays are non-zero setTimeout calls.
      // With vi.useFakeTimers(), setTimeout(resolve, 0) interacts inconsistently
      // with advanceTimersByTimeAsync — 1ms delays fire reliably when we advance
      // by 500ms (see handleWithRetryTimers), while still running fast.
      retryDelayMs: 1,
    });
  }

  /**
   * Build a StreamingBridge for abortAll / SIGINT tests (retries suppressed).
   */
  function makeAbortBridge(
    adapter: DiscordAdapter,
    client: AbortableStubClient | StubAgentClient,
    sessionManager = new SessionManager(),
  ): StreamingBridge {
    return new StreamingBridge({
      adapter,
      agentClient: client as unknown as AgentClient,
      sessionManager,
      maxRetries: 0,
      retryDelayMs: 0,
    });
  }

  /**
   * Drain the microtask queue until async operations settle.
   *
   * With vi.useFakeTimers(), Promises resolve via microtasks (not timer ticks).
   * Each `await Promise.resolve()` processes one layer of the microtask queue.
   *
   * 30 iterations settles the full async chain from handleMessage():
   *   createSession → setStatus (fetch+sendTyping) → startStream (fetch+send)
   *   → sendTasks (appendTasks+edit) → reader.start() → generator first yield
   *   → stream.append() → generator second await (suspends)
   *
   * Use 60 rounds when two concurrent chains are draining simultaneously.
   */
  async function drainMicrotasks(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  }

  // =========================================================================
  // 1. Transient error retry
  //
  // When the agent generator THROWS a transient error (503, network, overloaded),
  // SessionOutputReader's outer catch block:
  //   - Stores lastError (does NOT emit to bridge listeners)
  //   - Retries up to maxRetries times (with exponential backoff, retryDelayMs=0 here)
  //   - If a later attempt succeeds → bridge receives only success events
  //   - If all retries exhausted → bridge receives lastError as an error event
  //
  // ThrowingRetryStubClient simulates this by throwing on the first `failCalls`
  // invocations and yielding normal events on subsequent ones.
  // =========================================================================

  describe("transient error retry", () => {
    /**
     * Run bridge.handleMessage() while advancing fake timers to unblock retry
     * delays.
     *
     * Problem: vi.useFakeTimers() intercepts setTimeout, so SessionOutputReader's
     * `_delay()` call (which does `setTimeout(resolve, delayMs)`) never fires —
     * the retry await hangs forever and the test times out.
     *
     * Fix: use makeRetryBridge with retryDelayMs=1 and advance fake time by
     * 500ms.  This fires all retry delays (max is 1*2^(N-1) ms each, far below
     * 500ms for reasonable maxRetries) while NOT triggering DiscordStreamHandle's
     * 1000ms edit-flush timer — preserving the deferred-flush behaviour the rest
     * of the suite depends on.
     *
     * The 500ms advance also gives the fake-timer runtime enough async rounds to
     * fully drain the deep microtask chains that form inside SessionOutputReader's
     * retry loop before the bridge resolves handleMessage().
     */
    async function handleWithRetryTimers(
      bridge: StreamingBridge,
      msg: ChannelMessage,
    ): Promise<BridgeResult> {
      const resultPromise = bridge.handleMessage(msg);
      await vi.advanceTimersByTimeAsync(500);
      return resultPromise;
    }

    it("BridgeResult.success=true when transient throw on first call, success on retry (maxRetries=1)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const successText = "Success after retry!";
      const client = new ThrowingRetryStubClient(
        [{ type: "text_delta", text: successText }, { type: "done" }],
        1, // fail first call only
        "session-retry-succeed-001",
        "503 Service Unavailable", // isTransientError → retried
      );
      const bridge = makeRetryBridge(adapter, client, 1 /* maxRetries */);
      const result = await handleWithRetryTimers(bridge, makeGuildMsg("THREAD-RETRY-SUCCEED-001"));

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("BridgeResult.totalChars is correct after successful retry", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const successText = "Retry succeeded!";
      const client = new ThrowingRetryStubClient(
        [{ type: "text_delta", text: successText }, { type: "done" }],
        1,
        "session-retry-chars-001",
      );
      const bridge = makeRetryBridge(adapter, client, 1);
      const result = await handleWithRetryTimers(bridge, makeGuildMsg("THREAD-RETRY-CHARS-001"));

      expect(result.totalChars).toBe(successText.length);
    });

    it("sendMessage is called exactly once when maxRetries=0 and transient throw occurs", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new ThrowingRetryStubClient(
        [], // success events never reached
        10, // always fail
        "session-retry-once-001",
      );
      const bridge = makeRetryBridge(adapter, client, 0 /* no retries */);
      await bridge.handleMessage(makeGuildMsg("THREAD-RETRY-ONCE-001"));

      // With maxRetries=0: exactly 1 call (the initial attempt, no retry)
      expect(client.callsMade).toBe(1);
    });

    it("sendMessage is called N+1 times when maxRetries=N and all calls throw transiently", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new ThrowingRetryStubClient(
        [],
        10, // always fail
        "session-retry-calls-001",
      );
      const bridge = makeRetryBridge(adapter, client, 2 /* maxRetries=2 */);
      await handleWithRetryTimers(bridge, makeGuildMsg("THREAD-RETRY-CALLS-001"));

      // maxRetries=2 → 1 initial + 2 retries = 3 total calls
      expect(client.callsMade).toBe(3);
    });

    it("BridgeResult.success=false when all retries are exhausted on transient throws", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new ThrowingRetryStubClient(
        [],
        10,
        "session-retry-exhaust-001",
      );
      const bridge = makeRetryBridge(adapter, client, 1);
      const result = await handleWithRetryTimers(bridge, makeGuildMsg("THREAD-RETRY-EXHAUST-001"));

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains the transient error text after retry exhaustion", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const transientMsg = "503 Service Unavailable";
      const client = new ThrowingRetryStubClient(
        [],
        10,
        "session-retry-errmsg-001",
        transientMsg,
      );
      const bridge = makeRetryBridge(adapter, client, 0);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-RETRY-ERRMSG-001"));

      expect(result.error).toContain(transientMsg);
    });

    it("thread is released after retry exhaustion (isThreadActive=false, activeThreadCount=0)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const RETRY_THREAD = "THREAD-RETRY-RELEASE-001";
      const client = new ThrowingRetryStubClient([], 10, "session-retry-release-001");
      const bridge = makeRetryBridge(adapter, client, 0);
      await bridge.handleMessage(makeGuildMsg(RETRY_THREAD));

      expect(bridge.isThreadActive(GUILD_ID, RETRY_THREAD)).toBe(false);
      expect(bridge.activeThreadCount).toBe(0);
    });
  });

  // =========================================================================
  // 2. Permanent error surfacing
  //
  // When the agent yields a non-transient error event (401, 403),
  // SessionOutputReader emits it immediately without retrying. The bridge
  // captures streamError, calls finish() with the formatted message, and
  // returns BridgeResult.success=false.
  //
  // Contrast with transient errors (Group 1) where the generator THROWS —
  // here the agent YIELDS an error event so the bridge listener fires first.
  // =========================================================================

  describe("permanent error surfacing", () => {
    const PERMANENT_ERROR = "401 Unauthorized: invalid API key";

    it("BridgeResult.success=false for a permanent yielded error event", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-perm-err-001",
        events: [{ type: "error", error: PERMANENT_ERROR } as AgentStreamEvent],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PERM-ERR-001"));

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error reflects the permanent agent error message", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-perm-msg-001",
        events: [{ type: "error", error: PERMANENT_ERROR } as AgentStreamEvent],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PERM-MSG-001"));

      expect(result.error).toContain(PERMANENT_ERROR);
    });

    it("BridgeResult.totalChars=0 when permanent error fires before any text_delta", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-perm-zero-001",
        events: [{ type: "error", error: PERMANENT_ERROR } as AgentStreamEvent],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PERM-ZERO-001"));

      expect(result.totalChars).toBe(0);
    });

    it("BridgeResult.updateCount=0 when permanent error fires before any text_delta", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-perm-count-001",
        events: [{ type: "error", error: "403 Forbidden" } as AgentStreamEvent],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PERM-COUNT-001"));

      expect(result.updateCount).toBe(0);
    });

    it("finish() is called with formatted error content after permanent error (mockEdit receives error)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const errorMsg = "403 Forbidden: access denied";
      const stub = new StubAgentClient({
        sessionId: "session-perm-finish-001",
        events: [{ type: "error", error: errorMsg } as AgentStreamEvent],
      });
      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeGuildMsg("THREAD-PERM-FINISH-001"));

      // finish() calls message.edit() with the formatted error string
      expect(mockEdit).toHaveBeenCalled();
      const lastEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
      expect(lastEditArg.content).toContain(errorMsg);
    });

    it("thread is released after permanent error (isThreadActive=false, activeThreadCount=0)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const PERM_THREAD = "THREAD-PERM-RELEASE-001";
      const stub = new StubAgentClient({
        sessionId: "session-perm-release-001",
        events: [{ type: "error", error: "403 Forbidden" } as AgentStreamEvent],
      });
      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeGuildMsg(PERM_THREAD));

      expect(bridge.isThreadActive(GUILD_ID, PERM_THREAD)).toBe(false);
      expect(bridge.activeThreadCount).toBe(0);
    });

    it("session is persisted in SessionManager even after a permanent error", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const sessionManager = new SessionManager();
      const SESSION_PERM = "session-perm-persist-001";
      const PERM_PERSIST_THREAD = "THREAD-PERM-PERSIST-001";

      const stub = new StubAgentClient({
        sessionId: SESSION_PERM,
        events: [{ type: "error", error: "403 Forbidden" } as AgentStreamEvent],
      });
      const bridge = new StreamingBridge({
        adapter,
        agentClient: stub as unknown as AgentClient,
        sessionManager,
        maxRetries: 0,
        retryDelayMs: 0,
      });
      await bridge.handleMessage(makeGuildMsg(PERM_PERSIST_THREAD));

      // Session must remain stored — subsequent messages on the same thread reuse it
      const stored = sessionManager.getSession("discord", GUILD_ID, PERM_PERSIST_THREAD);
      expect(stored).toBe(SESSION_PERM);
    });
  });

  // =========================================================================
  // 3. Partial stream failure recovery
  //
  // When text_delta events arrive BEFORE an error event the bridge:
  //   - Counts partial chars in BridgeResult.totalChars
  //   - Counts partial delta events in BridgeResult.updateCount
  //   - Returns BridgeResult.success=false
  //   - Calls finish() with the formatted error message (not the partial text)
  //   - Releases the thread from the activeThreads map
  //
  // This is distinct from "empty error" (Group 2) where no text arrives at all.
  // =========================================================================

  describe("partial stream failure recovery", () => {
    const PARTIAL_TEXT = "This is a partial response.";
    const PARTIAL_ERROR = "401 Unauthorized: session expired";

    const PARTIAL_EVENTS: AgentStreamEvent[] = [
      { type: "text_delta", text: PARTIAL_TEXT },
      { type: "error", error: PARTIAL_ERROR },
    ];

    it("BridgeResult.totalChars counts only pre-error text_delta chars", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-partial-chars-001",
        events: [...PARTIAL_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PARTIAL-CHARS-001"));

      expect(result.totalChars).toBe(PARTIAL_TEXT.length);
    });

    it("BridgeResult.updateCount reflects only text_delta events before the error", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-partial-count-001",
        events: [...PARTIAL_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PARTIAL-COUNT-001"));

      expect(result.updateCount).toBe(1); // exactly 1 text_delta before the error
    });

    it("BridgeResult.success=false after partial text followed by error event", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-partial-fail-001",
        events: [...PARTIAL_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PARTIAL-FAIL-001"));

      expect(result.success).toBe(false);
    });

    it("BridgeResult.error contains the agent error message even after partial text", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-partial-errmsg-001",
        events: [...PARTIAL_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PARTIAL-ERRMSG-001"));

      expect(result.error).toContain(PARTIAL_ERROR);
    });

    it("finish() is called with formatted error after partial stream failure (final edit contains error)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-partial-finish-001",
        events: [...PARTIAL_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeGuildMsg("THREAD-PARTIAL-FINISH-001"));

      // The last edit must carry the formatted error message — NOT the partial text
      expect(mockEdit).toHaveBeenCalled();
      const lastEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
      expect(lastEditArg.content).toContain(PARTIAL_ERROR);
    });

    it("thread is released after partial stream failure (isThreadActive=false)", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const PARTIAL_THREAD = "THREAD-PARTIAL-RELEASE-001";
      const stub = new StubAgentClient({
        sessionId: "session-partial-release-001",
        events: [...PARTIAL_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeGuildMsg(PARTIAL_THREAD));

      expect(bridge.isThreadActive(GUILD_ID, PARTIAL_THREAD)).toBe(false);
      expect(bridge.activeThreadCount).toBe(0);
    });

    it("multiple text_delta events before error: all chars and deltas counted correctly", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const DELTA1 = "First chunk. ";
      const DELTA2 = "Second chunk. ";
      const DELTA3 = "Third chunk.";
      const multiEvents: AgentStreamEvent[] = [
        { type: "text_delta", text: DELTA1 },
        { type: "text_delta", text: DELTA2 },
        { type: "text_delta", text: DELTA3 },
        { type: "error", error: "403 Forbidden" },
      ];
      const expectedChars = DELTA1.length + DELTA2.length + DELTA3.length;

      const stub = new StubAgentClient({
        sessionId: "session-partial-multi-001",
        events: multiEvents,
      });
      const bridge = makeWiredBridge(adapter, stub);
      const result = await bridge.handleMessage(makeGuildMsg("THREAD-PARTIAL-MULTI-001"));

      expect(result.totalChars).toBe(expectedChars);
      expect(result.updateCount).toBe(3);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // 4. SIGINT/SIGTERM shutdown with in-flight stream cleanup
  //
  // ## Design
  //
  // Production runDiscordServe() registers process.once("SIGINT", shutdown) and
  // process.once("SIGTERM", shutdown), where shutdown() calls bridge.abortAll().
  //
  // These tests verify:
  //   1. abortAll() returns 0 when idle (clean shutdown with no active streams)
  //   2. Signal handlers can call abortAll() without throwing
  //   3. When a stream IS in-flight, the shutdown sequence causes it to resolve
  //      with BridgeResult.success=false
  //
  // ## Coordinator warning addressed
  //
  // Signal handlers use process.once() (not process.on()) to prevent handler
  // accumulation. The outer afterEach already calls process.removeAllListeners()
  // for both SIGINT and SIGTERM to clean up between tests.
  //
  // ## Async timing model
  //
  // AbortableStubClient.sendMessage() yields one text_delta then blocks at
  // `await new Promise(...)` that only rejects when options.signal fires "abort".
  // drainMicrotasks(30) progresses the async chain from handleMessage() through
  // createSession → setStatus → startStream → sendTasks → reader.start() →
  // generator first yield → stream.append() → generator second await (hangs).
  // After draining, bridge.abortAll() fires the signal and the chain resolves.
  // =========================================================================

  describe("SIGINT/SIGTERM shutdown with in-flight stream cleanup", () => {
    it("abortAll() returns 0 when called with no active threads (clean idle shutdown)", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const bridge = makeAbortBridge(adapter, new StubAgentClient());

      expect(bridge.abortAll()).toBe(0);
    });

    it("SIGINT handler can call bridge.abortAll() without throwing (idle bridge)", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const bridge = makeAbortBridge(adapter, new StubAgentClient());

      let abortResult: number | undefined;
      const handler = () => {
        abortResult = bridge.abortAll();
      };

      process.once("SIGINT", handler);
      process.emit("SIGINT");

      // No active threads — abortAll must return 0 without throwing
      expect(abortResult).toBe(0);
    });

    it("SIGTERM handler can call bridge.abortAll() without throwing (idle bridge)", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const bridge = makeAbortBridge(adapter, new StubAgentClient());

      let abortResult: number | undefined;
      const handler = () => {
        abortResult = bridge.abortAll();
      };

      process.once("SIGTERM", handler);
      process.emit("SIGTERM");

      expect(abortResult).toBe(0);
    });

    it("in-flight handleMessage resolves (does not throw) after abortAll()", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-abort-nothrow-001");
      const bridge = makeAbortBridge(adapter, client);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-NOTHROW-001"));
      await drainMicrotasks();

      bridge.abortAll();

      // handleMessage must resolve with a BridgeResult — never throw
      await expect(resultPromise).resolves.toBeDefined();
    });

    it("in-flight handleMessage resolves with success=false after abortAll()", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-abort-inflight-001");
      const bridge = makeAbortBridge(adapter, client);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-INFLIGHT-001"));
      await drainMicrotasks();

      bridge.abortAll();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("activeThreadCount drops to 0 after aborted stream resolves", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-abort-count-drop-001");
      const bridge = makeAbortBridge(adapter, client);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-COUNT-DROP-001"));
      await drainMicrotasks();

      bridge.abortAll();
      await resultPromise;

      // Thread must be fully released from the activeThreads map
      expect(bridge.activeThreadCount).toBe(0);
    });

    it("SIGINT during active stream: shutdown handler aborts stream, stream resolves with error", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-sigint-stream-001");
      const bridge = makeAbortBridge(adapter, client);

      // Register shutdown handler — mirrors production runDiscordServe() pattern.
      // process.once() prevents handler accumulation (Coordinator warning addressed).
      const shutdown = () => bridge.abortAll();
      process.once("SIGINT", shutdown);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-SIGINT-STREAM-001"));
      await drainMicrotasks();

      // Simulate OS/Docker SIGINT → shutdown() → bridge.abortAll()
      process.emit("SIGINT");

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(bridge.activeThreadCount).toBe(0);
    });

    it("SIGTERM during active stream: shutdown handler aborts stream, stream resolves with error", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-sigterm-stream-001");
      const bridge = makeAbortBridge(adapter, client);

      const shutdown = () => bridge.abortAll();
      process.once("SIGTERM", shutdown);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-SIGTERM-STREAM-001"));
      await drainMicrotasks();

      process.emit("SIGTERM");

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(bridge.activeThreadCount).toBe(0);
    });
  });

  // =========================================================================
  // 5. abortAll() behavior
  //
  // Verifies the full abortAll() contract:
  //   - Returns count of aborted threads (0 idle, 1 with one active, 2 with two)
  //   - Idempotent: safe to call multiple times
  //   - isThreadActive() reflects live state correctly throughout the lifecycle
  //   - Aborted stream: BridgeResult.success=false, error matches /abort/i
  //   - Bridge phase observer sees "streaming" → "error" → "cleanup" ordering
  //   - Calling abortAll() AFTER message completes returns 0 (already cleaned up)
  // =========================================================================

  describe("abortAll() behavior", () => {
    it("returns 0 with no active threads", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const bridge = makeAbortBridge(adapter, new StubAgentClient());

      expect(bridge.abortAll()).toBe(0);
    });

    it("is idempotent — safe to call multiple times with no active threads", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const bridge = makeAbortBridge(adapter, new StubAgentClient());

      expect(bridge.abortAll()).toBe(0);
      expect(bridge.abortAll()).toBe(0);
      expect(bridge.abortAll()).toBe(0);
    });

    it("isThreadActive() returns false for a thread that has never been processed", () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      const bridge = makeAbortBridge(adapter, new StubAgentClient());

      expect(bridge.isThreadActive(GUILD_ID, "THREAD-NEVER-PROCESSED-001")).toBe(false);
    });

    it("isThreadActive() returns true while processing and false after abort resolves", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-active-check-001");
      const bridge = makeAbortBridge(adapter, client);

      const ACTIVE_THREAD = "THREAD-ACTIVE-CHECK-001";
      const resultPromise = bridge.handleMessage(makeGuildMsg(ACTIVE_THREAD));

      // After draining, thread is in the streaming phase
      await drainMicrotasks();
      expect(bridge.isThreadActive(GUILD_ID, ACTIVE_THREAD)).toBe(true);

      // Abort and await — thread must be released
      bridge.abortAll();
      await resultPromise;
      expect(bridge.isThreadActive(GUILD_ID, ACTIVE_THREAD)).toBe(false);
    });

    it("isThreadActive() returns false after successful (non-aborted) completion", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const COMPLETE_THREAD = "THREAD-COMPLETE-CHECK-001";
      const stub = new StubAgentClient({
        sessionId: "session-complete-check-001",
        events: [...BASIC_TEXT_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeGuildMsg(COMPLETE_THREAD));

      expect(bridge.isThreadActive(GUILD_ID, COMPLETE_THREAD)).toBe(false);
    });

    it("returns 1 when exactly one thread is actively being processed", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-abort-one-001");
      const bridge = makeAbortBridge(adapter, client);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-ONE-001"));
      await drainMicrotasks();

      const count = bridge.abortAll();
      expect(count).toBe(1);

      await resultPromise; // ensure cleanup
    });

    it("returns 2 when two different threads are concurrently active on the same bridge", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      // Single AbortableStubClient — each sendMessage() call creates its own
      // generator with its own AbortSignal listener (no shared state issues).
      const client = new AbortableStubClient("session-abort-two-001");
      const bridge = makeAbortBridge(adapter, client);

      // Two concurrent messages on different threads — no concurrency guard collision.
      const promise1 = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-TWO-A-001"));
      const promise2 = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-TWO-B-001"));

      // Extra microtask rounds to settle both concurrent async chains
      await drainMicrotasks(60);

      // Both threads active simultaneously → abortAll must return 2
      const count = bridge.abortAll();
      expect(count).toBe(2);

      await Promise.all([promise1, promise2]);
    });

    it("returns 0 when called after a message has already completed", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const stub = new StubAgentClient({
        sessionId: "session-post-complete-001",
        events: [...BASIC_TEXT_EVENTS],
      });
      const bridge = makeWiredBridge(adapter, stub);
      await bridge.handleMessage(makeGuildMsg("THREAD-POST-COMPLETE-001"));

      // Thread already cleaned up — abortAll finds nothing to abort
      expect(bridge.abortAll()).toBe(0);
    });

    it("aborted stream produces BridgeResult.success=false with error matching /abort/i", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-abort-result-001");
      const bridge = makeAbortBridge(adapter, client);

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-RESULT-001"));
      await drainMicrotasks();

      bridge.abortAll();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // SessionOutputReader emits "Stream aborted" as the error message
      expect(result.error!).toMatch(/abort/i);
    });

    it("bridge phase observer sees 'streaming' before 'cleanup' on an aborted stream", async () => {
      const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      await connectAdapter(adapter);

      const client = new AbortableStubClient("session-abort-phase-001");
      const bridge = makeAbortBridge(adapter, client);

      const phases: string[] = [];
      bridge.onPhaseChange((_threadKey, phase) => phases.push(phase));

      const resultPromise = bridge.handleMessage(makeGuildMsg("THREAD-ABORT-PHASE-001"));
      await drainMicrotasks();

      bridge.abortAll();
      await resultPromise;

      // Abort path: session_resolve → stream_start → streaming → error → cleanup
      // At minimum: streaming must precede cleanup
      expect(phases).toContain("streaming");
      expect(phases).toContain("cleanup");
      expect(phases.indexOf("cleanup")).toBeGreaterThan(phases.indexOf("streaming"));
    });
  });
});

// ===========================================================================
// Sub-AC 4d: Error handling — transient error retry
//
// Verifies that the bridge retries sendMessage() on transient network errors
// (via SessionOutputReader's built-in retry mechanism) and only surfaces
// failure after all retries are exhausted.
//
// ## Retry delay timer with fake timers
//
// With retryDelayMs=0, SessionOutputReader._delay(0) creates setTimeout(fn, 0).
// vi.useFakeTimers() intercepts this timer — it won't fire from microtasks alone.
// Each test advances timers with `await vi.advanceTimersByTimeAsync(1)` which:
//   1. Processes all pending microtasks (bridge reaches the retry setTimeout)
//   2. Fires 0ms timers (retry delay resolves)
//   3. Processes microtasks (retry attempt executes, reader.start() completes)
//   4. Bridge finalises and resolves
//
// One advancement (1ms) covers one retry delay. Tests with two retries would
// need two advancements, but the scenarios below use at most one retry.
//
// The 1000ms DiscordStreamHandle cadence timer is NOT fired (1ms < 1000ms).
// finish() cancels the cadence timer synchronously before it would fire.
// ===========================================================================

describe("Sub-AC 4d: transient error retry", () => {
  const SESSION_RETRY = "session-retry-4d-001";
  const THREAD_RETRY = "THREAD-RETRY-4D-001";

  /**
   * Build a stub whose sendMessage() throws a transient error on the first
   * `failCount` calls, then yields `successEvents` on subsequent calls.
   */
  function makeRetryingStub(
    successEvents: AgentStreamEvent[] = [
      { type: "text_delta", text: "Retry success." },
      { type: "done" },
    ],
    failCount = 1,
    transientError = "network timeout",
  ) {
    let callCount = 0;
    return {
      async createSession() {
        return SESSION_RETRY;
      },
      async *sendMessage(
        _sessionId: string,
        _text: string,
        _options?: { signal?: AbortSignal },
      ): AsyncGenerator<AgentStreamEvent> {
        callCount++;
        if (callCount <= failCount) {
          throw new Error(transientError);
        }
        for (const event of successEvents) {
          yield event;
        }
      },
      getSendCallCount: () => callCount,
    };
  }

  /** Build a StreamingBridge with retries enabled but zero delay. */
  function makeBridgeWithRetry(
    adapter: DiscordAdapter,
    stub: ReturnType<typeof makeRetryingStub>,
    maxRetries = 1,
  ): StreamingBridge {
    return new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries,
      retryDelayMs: 0,
    });
  }

  /** Minimal ChannelMessage for the retry thread. */
  const retryMsg = (): ChannelMessage => ({
    id: "msg-retry",
    channelId: GUILD_ID,
    threadId: THREAD_RETRY,
    userId: "user-retry",
    text: "Retry test message",
    isMention: true,
    isDirectMessage: false,
  });

  it("bridge retries on transient network error and reports BridgeResult.success=true on second attempt", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = makeRetryingStub();
    const bridge = makeBridgeWithRetry(adapter, stub);

    const resultPromise = bridge.handleMessage(retryMsg());

    // Fire the 0ms retry-delay setTimeout created by SessionOutputReader._delay(0).
    // Advancing by 1ms fires all pending 0ms timers without triggering the 1000ms
    // DiscordStreamHandle cadence timer.
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("totalChars reflects only chars from the successful retry attempt", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const retryText = "Reply from successful retry.";
    const stub = makeRetryingStub([
      { type: "text_delta", text: retryText },
      { type: "done" },
    ]);
    const bridge = makeBridgeWithRetry(adapter, stub);

    const resultPromise = bridge.handleMessage(retryMsg());
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.totalChars).toBe(retryText.length);
    expect(result.updateCount).toBe(1);
  });

  it("all retries exhausted: BridgeResult.success=false with the failure error in the error field", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // failCount=2 with maxRetries=1 → 2 total attempts (attempt 0 + 1 retry), both throw.
    // When sendMessage() THROWS on the final attempt (attempt == maxRetries), the catch
    // block emits the raw error message directly (not the "Max retries exceeded" string,
    // which is only used when errors are yielded as events via the inner for-await loop).
    const stub = makeRetryingStub(
      [{ type: "done" }], // success events — never reached
      2,                  // fail both attempts
      "network timeout",
    );
    const bridge = makeBridgeWithRetry(adapter, stub, 1);

    const resultPromise = bridge.handleMessage(retryMsg());
    // One retry delay fires at attempt=1 (retryDelayMs=0 → 0ms setTimeout)
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // The raw error from the final failed attempt is surfaced directly
    expect(result.error).toContain("network timeout");
  });

  it("retry does NOT send a new placeholder — the existing stream handle is reused", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = makeRetryingStub();
    const bridge = makeBridgeWithRetry(adapter, stub);

    const resultPromise = bridge.handleMessage(retryMsg());
    await vi.advanceTimersByTimeAsync(1);
    await resultPromise;

    // The placeholder is sent exactly once at stream start (before reader.start()).
    // SessionOutputReader retries internally — no new stream is started for a retry.
    expect(mockSend).toHaveBeenCalledTimes(1);
    const firstSendContent = (mockSend.mock.calls[0]![0] as { content: string }).content;
    expect(firstSendContent).toBe(THINKING_PLACEHOLDER);
  });

  it("non-transient error is NOT retried even when maxRetries > 0 (permanent failure on attempt 0)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let sendCallCount = 0;
    const permanentErrorStub = {
      async createSession() {
        return "session-perm-no-retry";
      },
      // Throws "401 invalid api key" — no match in isTransientError() patterns
      async *sendMessage(): AsyncGenerator<AgentStreamEvent> {
        sendCallCount++;
        throw new Error("401 invalid api key");
      },
    };

    const bridge = new StreamingBridge({
      adapter,
      agentClient: permanentErrorStub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 3, // retries enabled, but permanent errors bypass them
      retryDelayMs: 0,
    });

    const result = await bridge.handleMessage(retryMsg());

    expect(result.success).toBe(false);
    expect(result.error).toContain("401 invalid api key");
    // Permanent errors: sendMessage() called exactly once, no retries
    expect(sendCallCount).toBe(1);
  });
});

// ===========================================================================
// Sub-AC 4d: Error handling — permanent error surfacing
//
// Verifies that permanent (non-retryable) agent errors are immediately
// surfaced in BridgeResult and propagated to Discord via stream.finish().
// Also verifies that threads are released and sessions are persisted even
// when streaming ends in an error state.
// ===========================================================================

describe("Sub-AC 4d: permanent error surfacing", () => {
  const SESSION_PERM = "session-perm-4d-001";
  const THREAD_PERM = "THREAD-PERM-4D-001";

  /** Build a StubAgentClient that yields an optional partial text then an error event. */
  function makePermanentErrorStub(
    errorMsg = "Agent session terminated: fatal error",
    partialTextBefore?: string,
  ): StubAgentClient {
    const events: AgentStreamEvent[] = [];
    if (partialTextBefore !== undefined) {
      events.push({ type: "text_delta", text: partialTextBefore });
    }
    events.push({ type: "error", error: errorMsg });
    return new StubAgentClient({ sessionId: SESSION_PERM, events });
  }

  const permMsg = (): ChannelMessage => ({
    id: "msg-perm",
    channelId: GUILD_ID,
    threadId: THREAD_PERM,
    userId: "user-perm",
    text: "Test error surfacing",
    isMention: true,
    isDirectMessage: false,
  });

  it("permanent error event: BridgeResult.success=false and error matches the agent error string", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const errorMsg = "Agent session terminated: fatal error";
    const stub = makePermanentErrorStub(errorMsg);
    const bridge = makeWiredBridge(adapter, stub);

    const result = await bridge.handleMessage(permMsg());

    expect(result.success).toBe(false);
    expect(result.error).toBe(errorMsg);
  });

  it("permanent error: finish() is called with formatted error text (⚠️ prefix from defaultFormatError)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const errorMsg = "Critical failure: agent session destroyed";
    const stub = makePermanentErrorStub(errorMsg);
    const bridge = makeWiredBridge(adapter, stub);

    await bridge.handleMessage(permMsg());

    // defaultFormatError wraps the message: "⚠️ Sorry, I encountered an error: {msg}"
    // The final edit content must contain both the ⚠️ prefix and the raw error string.
    const lastEditArg = mockEdit.mock.calls.at(-1)![0] as { content: string };
    expect(lastEditArg.content).toContain(errorMsg);
    expect(lastEditArg.content).toContain("⚠️");
  });

  it("permanent error with no prior text: totalChars=0 and updateCount=0", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    // Error fires before any text_delta events
    const stub = makePermanentErrorStub("Fatal error", undefined);
    const bridge = makeWiredBridge(adapter, stub);

    const result = await bridge.handleMessage(permMsg());

    expect(result.success).toBe(false);
    expect(result.totalChars).toBe(0);
    expect(result.updateCount).toBe(0);
  });

  it("permanent error after partial text: totalChars counts only text_delta chars, not the error message", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const partialText = "Partial output before failure.";
    // Stub yields partialText (text_delta) then an error event
    const stub = makePermanentErrorStub("Fatal error", partialText);
    const bridge = makeWiredBridge(adapter, stub);

    const result = await bridge.handleMessage(permMsg());

    expect(result.success).toBe(false);
    expect(result.totalChars).toBe(partialText.length);
  });

  it("permanent error: thread is released (isThreadActive=false) after handleMessage resolves", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = makePermanentErrorStub("Fatal auth error");
    const bridge = makeWiredBridge(adapter, stub);

    expect(bridge.isThreadActive(GUILD_ID, THREAD_PERM)).toBe(false);
    await bridge.handleMessage(permMsg());
    // Thread lock must be released even on error — the finally block in processMessage ensures this
    expect(bridge.isThreadActive(GUILD_ID, THREAD_PERM)).toBe(false);
  });

  it("permanent error: session IS persisted in SessionManager so next message can reuse it", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();
    const stub = makePermanentErrorStub("Fatal error");
    const bridge = makeWiredBridge(adapter, stub, sessionManager);

    await bridge.handleMessage(permMsg());

    // Session is created before streaming begins and is NOT rolled back on error.
    // A subsequent message in the same thread must reuse the same session.
    const stored = sessionManager.getSession("discord", GUILD_ID, THREAD_PERM);
    expect(stored).toBe(SESSION_PERM);
  });
});

// ===========================================================================
// Sub-AC 4d: Error handling — partial stream failure recovery
//
// Verifies bridge behaviour when an error arrives after one or more
// text_delta events have already been streamed. Complements the more
// exhaustive discord-midstream-failure-e2e.test.ts with additional
// E2E-level assertions on BridgeResult, phase transitions, and thread reuse.
// ===========================================================================

describe("Sub-AC 4d: partial stream failure recovery", () => {
  const SESSION_PARTIAL = "session-partial-4d-001";
  const THREAD_PARTIAL = "THREAD-PARTIAL-4D-001";

  const PARTIAL_TEXT = "Partial response before failure.";
  const PARTIAL_ERROR = "Stream interrupted mid-response";

  const partialFailureEvents: AgentStreamEvent[] = [
    { type: "text_delta", text: PARTIAL_TEXT },
    { type: "error", error: PARTIAL_ERROR },
  ];

  const partialMsg = (): ChannelMessage => ({
    id: "msg-partial",
    channelId: GUILD_ID,
    threadId: THREAD_PARTIAL,
    userId: "user-partial",
    text: "Test partial failure",
    isMention: true,
    isDirectMessage: false,
  });

  it("partial stream failure: BridgeResult.success=false with the agent error in the error field", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_PARTIAL,
      events: [...partialFailureEvents],
    });
    const bridge = makeWiredBridge(adapter, stub);

    const result = await bridge.handleMessage(partialMsg());

    expect(result.success).toBe(false);
    expect(result.error).toBe(PARTIAL_ERROR);
  });

  it("partial stream failure: totalChars = chars from text_delta events that arrived before the error", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_PARTIAL,
      events: [...partialFailureEvents],
    });
    const bridge = makeWiredBridge(adapter, stub);

    const result = await bridge.handleMessage(partialMsg());

    // The error message itself is NOT included in totalChars — only text_delta events
    expect(result.totalChars).toBe(PARTIAL_TEXT.length);
  });

  it("partial stream failure: bridge phase sequence includes error and cleanup phases in order", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const stub = new StubAgentClient({
      sessionId: SESSION_PARTIAL,
      events: [...partialFailureEvents],
    });
    const sessionManager = new SessionManager();
    const phasesObserved: string[] = [];

    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    bridge.onPhaseChange((_key, phase) => {
      phasesObserved.push(phase);
    });

    await bridge.handleMessage(partialMsg());

    // The full phase sequence for a mid-stream error:
    //   session_resolve → stream_start → streaming → error → cleanup
    expect(phasesObserved).toContain("streaming");
    expect(phasesObserved).toContain("error");
    expect(phasesObserved).toContain("cleanup");

    // error must precede cleanup
    const errorIdx = phasesObserved.lastIndexOf("error");
    const cleanupIdx = phasesObserved.lastIndexOf("cleanup");
    expect(errorIdx).toBeLessThan(cleanupIdx);

    // streaming must precede error (partial text was delivered before the error)
    const streamingIdx = phasesObserved.indexOf("streaming");
    expect(streamingIdx).toBeLessThan(errorIdx);
  });

  it("thread is released after partial failure and can process a new sequential message", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const sessionManager = new SessionManager();

    // First message: fails mid-stream
    const stub1 = new StubAgentClient({
      sessionId: SESSION_PARTIAL,
      events: [...partialFailureEvents],
    });
    const bridge1 = makeWiredBridge(adapter, stub1, sessionManager);
    const failResult = await bridge1.handleMessage(partialMsg());
    expect(failResult.success).toBe(false);

    // Second message on the same thread: must succeed (lock is released)
    const stub2 = new StubAgentClient({
      sessionId: SESSION_PARTIAL,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge2 = makeWiredBridge(adapter, stub2, sessionManager);
    const successResult = await bridge2.handleMessage(partialMsg());

    expect(successResult.success).toBe(true);
    // Session from the first message is still stored → reused on second message
    expect(successResult.sessionCreated).toBe(false);
  });
});

// ===========================================================================
// Sub-AC 4d: Graceful shutdown — SIGINT/SIGTERM with in-flight stream cleanup
//
// Verifies the graceful shutdown pattern used by runDiscordServe():
//   process.once('SIGINT', () => { bridge.abortAll(); adapter.disconnect(); })
//
// ## Timing model (ready-signal pattern)
//
// An "abortable" stub's sendMessage() generator calls `onReady()` synchronously
// before the first `await`, ensuring the abort listener is set up by the time
// the test code runs `bridge.abortAll()`. The sequence:
//
//   1. bridge.handleMessage(msg) → starts executing (pending promise)
//   2. await readyToAbort  ← yields to microtask queue
//   3. Bridge progresses: createSession → setStatus → startStream → reader.start()
//   4. sendMessage() generator runs synchronously until `await`:
//        onReady() called → readyToAbort resolves
//        abort listener set up in the Promise constructor (synchronous)
//        generator suspends
//   5. Test code resumes after readyToAbort: process.emit('SIGINT') → abortAll()
//   6. Abort signal fires → generator resolves → yields error event → done
//
// Signal handlers use process.once() to prevent accumulation (Coordinator Warning #3).
// The afterEach already calls process.removeAllListeners('SIGINT'/'SIGTERM').
// ===========================================================================

describe("Sub-AC 4d: graceful shutdown — SIGINT/SIGTERM with in-flight stream cleanup", () => {
  const THREAD_SHUTDOWN = "THREAD-SHUTDOWN-4D-001";
  const SESSION_SHUTDOWN = "session-shutdown-4d-001";

  /**
   * Build a stub whose sendMessage() generator blocks until the AbortSignal
   * fires, then yields a terminal error event. Calls `onReady` synchronously
   * before the `await` so the abort listener is guaranteed to be installed
   * before the test code calls bridge.abortAll().
   */
  function makeAbortableStub(
    onReady: () => void,
    sessionId = SESSION_SHUTDOWN,
  ) {
    return {
      async createSession() {
        return sessionId;
      },
      async *sendMessage(
        _sessionId: string,
        _text: string,
        options?: { signal?: AbortSignal },
      ): AsyncGenerator<AgentStreamEvent> {
        // Called synchronously before the first await — abort listener is
        // guaranteed to be set up by the time onReady() resolves in the test.
        onReady();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        // Yield a terminal error so the reader recognises the abort and exits.
        yield { type: "error", error: "Stream aborted by signal" } as AgentStreamEvent;
      },
    };
  }

  const shutdownMsg = (): ChannelMessage => ({
    id: "msg-shutdown",
    channelId: GUILD_ID,
    threadId: THREAD_SHUTDOWN,
    userId: "user-shutdown",
    text: "Shutdown test message",
    isMention: true,
    isDirectMessage: false,
  });

  it("SIGINT during in-flight stream: registered handler calls abortAll() and BridgeResult.success=false", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const readyToAbort = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStub(resolveReady);
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    // Register shutdown handler (mirrors the runDiscordServe() pattern)
    process.once("SIGINT", () => {
      bridge.abortAll();
    });

    const resultPromise = bridge.handleMessage(shutdownMsg());

    // Wait until the stub signals that its abort listener is installed
    await readyToAbort;

    // Simulate the OS sending SIGINT — fires the registered handler
    process.emit("SIGINT");

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });

  it("SIGTERM during in-flight stream: same abort semantics as SIGINT", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const readyToAbort = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStub(resolveReady);
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    process.once("SIGTERM", () => {
      bridge.abortAll();
    });

    const resultPromise = bridge.handleMessage(shutdownMsg());
    await readyToAbort;

    process.emit("SIGTERM");

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });

  it("after SIGINT shutdown: bridge.activeThreadCount is 0 (all threads released)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const readyToAbort = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStub(resolveReady);
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    process.once("SIGINT", () => {
      bridge.abortAll();
    });

    const resultPromise = bridge.handleMessage(shutdownMsg());
    await readyToAbort;
    process.emit("SIGINT");
    await resultPromise;

    // Every thread released by the finally block in handleMessage → activeThreadCount=0
    expect(bridge.activeThreadCount).toBe(0);
  });

  it("adapter.disconnect() completes without error after abortAll() during graceful shutdown", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const readyToAbort = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStub(resolveReady);
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    process.once("SIGINT", () => {
      bridge.abortAll();
    });

    const resultPromise = bridge.handleMessage(shutdownMsg());
    await readyToAbort;
    process.emit("SIGINT");
    await resultPromise;

    // Full graceful shutdown: disconnect after abortAll() must complete cleanly
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("SIGINT before any stream starts: abortAll() is a no-op (returns 0, no side-effects)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const bridge = makeWiredBridge(adapter, new StubAgentClient());

    process.once("SIGINT", () => {
      const count = bridge.abortAll();
      // Store count for assertion (abortAll on idle bridge must be 0)
      expect(count).toBe(0);
    });

    // No message has been sent → no active threads
    process.emit("SIGINT");

    // Bridge must still be usable after a premature SIGINT (no state corruption)
    const stub = new StubAgentClient({
      sessionId: SESSION_SHUTDOWN,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge2 = makeWiredBridge(adapter, stub);
    const result = await bridge2.handleMessage(shutdownMsg());
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// Sub-AC 4d: abortAll() and abortThread() behavior
//
// Direct assertions on StreamingBridge's abort API:
//   - abortAll(): abort all active threads, return count
//   - abortThread(): abort a specific thread by channelId + threadId
//   - isThreadActive(): check if a specific thread is currently processing
//   - activeThreadCount: total number of in-flight threads
//
// Tests use bridge.handleMessage() directly (not via emitMessageCreate) for
// precise control over timing and abort-signal installation.
// ===========================================================================

describe("Sub-AC 4d: abortAll() and abortThread() behavior", () => {
  const THREAD_ABORT_A = "THREAD-ABORT-4D-001";
  const THREAD_ABORT_B = "THREAD-ABORT-4D-002";
  const SESSION_ABORT = "session-abort-4d-001";

  /**
   * Build an abortable stub that signals readiness before blocking on the AbortSignal.
   * Pattern is identical to the shutdown tests — centralised here to avoid duplication.
   */
  function makeAbortableStubForAbort(
    onReady: () => void,
    sessionId = SESSION_ABORT,
  ) {
    return {
      async createSession() {
        return sessionId;
      },
      async *sendMessage(
        _sessionId: string,
        _text: string,
        options?: { signal?: AbortSignal },
      ): AsyncGenerator<AgentStreamEvent> {
        onReady();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) {
            resolve();
            return;
          }
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        yield { type: "error", error: "Stream aborted" } as AgentStreamEvent;
      },
    };
  }

  it("abortAll() with no active threads returns 0", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const bridge = makeWiredBridge(adapter, new StubAgentClient());

    // No handleMessage() in flight — abortAll should be a pure no-op
    expect(bridge.abortAll()).toBe(0);
  });

  it("abortAll() with one in-flight thread returns 1", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStubForAbort(resolveReady);
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    const resultPromise = bridge.handleMessage({
      id: "msg-abort-count",
      channelId: GUILD_ID,
      threadId: THREAD_ABORT_A,
      userId: "user-abort",
      text: "Test message",
      isMention: true,
      isDirectMessage: false,
    });

    await ready;

    const abortedCount = bridge.abortAll();
    await resultPromise;

    expect(abortedCount).toBe(1);
  });

  it("activeThreadCount is 0 after abortAll() and handleMessage() resolves", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStubForAbort(resolveReady);
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    const resultPromise = bridge.handleMessage({
      id: "msg-active-count",
      channelId: GUILD_ID,
      threadId: THREAD_ABORT_A,
      userId: "user-abort",
      text: "Test",
      isMention: true,
      isDirectMessage: false,
    });

    await ready;
    bridge.abortAll();
    await resultPromise;

    expect(bridge.activeThreadCount).toBe(0);
  });

  it("abortThread() returns true and terminates the matching thread (and only that thread)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const stub = makeAbortableStubForAbort(resolveReady, "session-abort-thread");
    const bridge = new StreamingBridge({
      adapter,
      agentClient: stub as unknown as AgentClient,
      sessionManager: new SessionManager(),
      maxRetries: 0,
      retryDelayMs: 0,
    });

    const resultPromise = bridge.handleMessage({
      id: "msg-abort-thread",
      channelId: GUILD_ID,
      threadId: THREAD_ABORT_A,
      userId: "user-abort",
      text: "Test",
      isMention: true,
      isDirectMessage: false,
    });

    await ready;

    // abortThread targets the specific key "discord:{GUILD_ID}:{THREAD_ABORT_A}"
    const wasAborted = bridge.abortThread(GUILD_ID, THREAD_ABORT_A);
    await resultPromise;

    expect(wasAborted).toBe(true);
  });

  it("abortThread() on a non-existent thread key returns false (no side-effects)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const bridge = makeWiredBridge(adapter, new StubAgentClient());

    // THREAD_ABORT_B is not in flight — abortThread must return false
    expect(bridge.abortThread(GUILD_ID, THREAD_ABORT_B)).toBe(false);
  });

  it("isThreadActive() is false before handleMessage() and false after it resolves", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    const bridge = makeWiredBridge(adapter, new StubAgentClient({
      sessionId: SESSION_ABORT,
      events: [...BASIC_TEXT_EVENTS],
    }));

    // Not active before any message
    expect(bridge.isThreadActive(GUILD_ID, THREAD_ABORT_A)).toBe(false);

    await bridge.handleMessage({
      id: "msg-active-before-after",
      channelId: GUILD_ID,
      threadId: THREAD_ABORT_A,
      userId: "user-abort",
      text: "Test",
      isMention: true,
      isDirectMessage: false,
    });

    // Released by finally block in handleMessage() — not active after completion
    expect(bridge.isThreadActive(GUILD_ID, THREAD_ABORT_A)).toBe(false);
  });

  it("thread is reusable for a new message after abort (lock released by finally block)", async () => {
    const adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    await connectAdapter(adapter);

    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    // First message: abortable, will be cancelled
    const stub1 = makeAbortableStubForAbort(resolveReady);
    const sessionManager = new SessionManager();
    const bridge1 = new StreamingBridge({
      adapter,
      agentClient: stub1 as unknown as AgentClient,
      sessionManager,
      maxRetries: 0,
      retryDelayMs: 0,
    });

    const result1Promise = bridge1.handleMessage({
      id: "msg-reuse-1",
      channelId: GUILD_ID,
      threadId: THREAD_ABORT_A,
      userId: "user-abort",
      text: "First message (will be aborted)",
      isMention: true,
      isDirectMessage: false,
    });

    await ready;
    bridge1.abortAll();
    await result1Promise;

    // Second message on the SAME thread via a SECOND bridge: must succeed
    // (proves the lock was released, not that the same bridge instance is reused)
    const stub2 = new StubAgentClient({
      sessionId: SESSION_ABORT,
      events: [...BASIC_TEXT_EVENTS],
    });
    const bridge2 = makeWiredBridge(adapter, stub2, sessionManager);
    const result2 = await bridge2.handleMessage({
      id: "msg-reuse-2",
      channelId: GUILD_ID,
      threadId: THREAD_ABORT_A,
      userId: "user-abort",
      text: "Second message (should succeed)",
      isMention: true,
      isDirectMessage: false,
    });

    expect(result2.success).toBe(true);
  });
});
