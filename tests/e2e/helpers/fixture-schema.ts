/**
 * Canonical fixture file schema for E2E cassette-based tests.
 *
 * Cassette fixtures are stored as JSON files under tests/e2e/fixtures/
 * (that directory is gitignored — each contributor records their own).
 *
 * ## Design rationale
 *
 * Events are stored in **raw SSE wire format** (each entry has an `event` field
 * for the SSE event name and a `data` field for the JSON payload) rather than in
 * the already-parsed `AgentStreamEvent` form.  Storing raw events:
 *   - Preserves the full original payload without information loss from parsing.
 *   - Allows replay to call `parseSSEEvent(e.data)` so that any future improvement
 *     to the parser is exercised automatically without re-recording.
 *   - Keeps the fixture independent of the `AgentStreamEvent` discriminated-union
 *     schema — cassettes remain valid across parser refactors.
 *
 * ## Fixture file format (JSON)
 *
 * ```json
 * {
 *   "version": 1,
 *   "scenario": "basic-mention",
 *   "recordedAt": "2026-04-13T12:00:00.000Z",
 *   "sessionId": "sess_abc123",
 *   "tag": "e2e-20260413120000000-a1b2c3d4",
 *   "events": [
 *     {
 *       "event": "session.status_running",
 *       "data": { "type": "session.status_running" }
 *     },
 *     {
 *       "event": "content_block_delta",
 *       "data": {
 *         "type": "content_block_delta",
 *         "index": 0,
 *         "delta": { "type": "text_delta", "text": "Hello, " }
 *       }
 *     },
 *     {
 *       "event": "content_block_delta",
 *       "data": {
 *         "type": "content_block_delta",
 *         "index": 0,
 *         "delta": { "type": "text_delta", "text": "world!" }
 *       }
 *     },
 *     {
 *       "event": "session.status_idle",
 *       "data": {
 *         "type": "session.status_idle",
 *         "stop_reason": { "type": "end_turn" }
 *       }
 *     }
 *   ],
 *   "expectedSlackThread": {
 *     "finalText": "Hello, world!",
 *     "messages": [
 *       {
 *         "text": "Hello, world!",
 *         "isBot": true,
 *         "blocks": [
 *           { "type": "rich_text" }
 *         ],
 *         "meta": {
 *           "replyIndex": 0,
 *           "isBotMessage": true
 *         }
 *       }
 *     ]
 *   }
 * }
 * ```
 *
 * ## File path convention
 *
 * Each fixture is stored at `tests/e2e/fixtures/<scenario>.json` where
 * `<scenario>` is the kebab-case scenario identifier used by the test suite
 * (e.g. `"basic-mention"` → `fixtures/basic-mention.json`).
 *
 * ## Versioning
 *
 * `CASSETTE_SCHEMA_VERSION` is the current integer schema version.  Increment it
 * whenever the on-disk format changes in a breaking way (field renames, type
 * changes, etc.) so that old cassettes can be detected and re-recorded.
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Current cassette schema version stored in every fixture file.
 *
 * Increment this constant when the on-disk format changes in a breaking way.
 * Replay helpers should reject cassettes whose `version` field does not match.
 */
export const CASSETTE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// ExpectedSlackThread — expected final Slack thread state (AC 3 assertions)
// ---------------------------------------------------------------------------

/**
 * A single Slack Block Kit block as returned from conversations.replies.
 *
 * Stored as a flexible index-signature object because Slack block schemas vary
 * widely across block types (section, rich_text, divider, context, header, etc.).
 *
 * ## Assertion strategy during replay
 *
 * Only the `type` field is asserted structurally during replay. Full block
 * content is NOT compared exactly because streaming messages may carry dynamic
 * metadata (session IDs, plan-task status, timestamps) that changes between runs.
 *
 * Stored verbatim from the live recording so the fixture is a faithful snapshot
 * of what Slack returned via conversations.replies.
 */
export interface ExpectedSlackBlock {
  /** Slack Block Kit block type (e.g. "section", "rich_text", "divider", "context") */
  type: string;
  /** Remaining block fields — preserved verbatim from the live recording */
  [key: string]: unknown;
}

/**
 * Thread-level metadata captured for a single message from conversations.replies.
 *
 * Provides enough context to:
 *   1. Identify the message's position in the bot-reply ordering (replyIndex).
 *   2. Confirm it originated from a bot integration (isBotMessage).
 *   3. Surface the Slack reply_count for optional additional checks.
 */
export interface ExpectedSlackMessageMeta {
  /**
   * Zero-based position of this message in the filtered bot-reply array.
   *
   * Index 0 is the first bot reply in the thread (the trigger user message is
   * excluded before indexing). Used to match recorded messages to live replies
   * positionally during replay assertions.
   *
   * For a typical single-turn test, there is exactly one bot reply at index 0.
   */
  replyIndex: number;

  /**
   * True when the Slack API returned a `bot_id` field on this message.
   *
   * Every streaming message posted via chat.startStream / appendStream / stopStream
   * has `bot_id` set by Slack. Should always be `true` for entries in `messages`.
   */
  isBotMessage: boolean;

  /**
   * Slack `reply_count` for this message, if returned by the API.
   *
   * For messages that are themselves replies (not thread roots) this is typically
   * `0` or absent. Stored when present for scenarios that assert on nested threads.
   */
  replyCount?: number;
}

/**
 * Expected shape of a single Slack message in the thread, as captured from
 * conversations.replies during a live recording run.
 *
 * One entry per bot-reply message observed in the thread after the bridge
 * completes. A typical single-turn test produces exactly one entry.
 */
export interface ExpectedSlackMessage {
  /**
   * Full message text as returned by conversations.replies after stopStream.
   *
   * For streaming bot replies this is the final rendered text including all
   * appended text deltas. May include Slack mrkdwn formatting characters.
   *
   * Asserted with `toContain` (not exact equality) during replay to tolerate
   * minor whitespace or mrkdwn normalisation by Slack's rendering pipeline.
   */
  text: string;

  /**
   * Whether this message was posted by the bot (has `bot_id` in Slack payload).
   *
   * All entries in `ExpectedSlackThread.messages` represent bot replies so this
   * should always be `true`. Present explicitly so assertions can verify that no
   * human messages were mistakenly included in the expected list.
   */
  isBot: boolean;

  /**
   * Slack Block Kit blocks attached to this message, if any.
   *
   * Present for messages created via chat.startStream / stopStream; Slack may
   * attach rich_text or plan-mode task blocks automatically.
   * Absent for plain-text messages (chat.postMessage without blocks parameter).
   *
   * Stored verbatim from live recording. During replay, only block *types* are
   * asserted (not full content) because dynamic fields may differ between runs.
   *
   * `undefined` means no blocks were present during recording.
   * An empty array means Slack returned a blocks field but it was empty.
   */
  blocks?: ExpectedSlackBlock[];

  /** Thread-position and identity metadata for this message */
  meta: ExpectedSlackMessageMeta;
}

/**
 * Expected final state of the Slack thread after StreamingBridge completes.
 *
 * Captured from conversations.replies during the recording run and stored in
 * the cassette fixture. During replay the live Slack thread is read and each
 * bot reply is asserted against the corresponding entry here.
 *
 * ## What is captured
 *
 * After `bridge.handleMessage()` resolves, the recording path calls
 * conversations.replies and captures every message in the thread that has
 * `bot_id` set. This snapshot becomes the AC 3 assertion ground truth.
 *
 * ## Replay assertion contract
 *
 * ```ts
 * // 1. Thread has exactly one bot reply
 * expect(botReplies).toHaveLength(messages.length);
 *
 * // 2. Each reply's authorship is correct
 * expect(reply.bot_id).toBeDefined();   // isBot === true
 *
 * // 3. Each reply text contains the expected content
 * expect(reply.text).toContain(messages[0].text);
 *
 * // 4. Block types match (when blocks are present)
 * for (const [i, block] of (reply.blocks ?? []).entries()) {
 *   expect(block.type).toBe(messages[0].blocks![i].type);
 * }
 * ```
 *
 * ## Optional field
 *
 * Cassettes recorded before this field was introduced will not have it.
 * When absent, only `finalText` is used for Slack thread assertions (AC 3).
 * Freshly recorded cassettes will have this fully populated.
 */
export interface ExpectedSlackThread {
  /**
   * Concatenation of all `text_delta.text` values from the cassette SSE events.
   *
   * This is the complete text the bot streamed and what should appear verbatim
   * inside the final Slack reply. Used in `assertSlackThread()` with `toContain`.
   *
   * Derivable deterministically from cassette events via `computeFullText()`.
   */
  finalText: string;

  /**
   * Ordered list of bot-reply messages observed in the Slack thread, captured
   * from conversations.replies during the recording phase.
   *
   * Messages appear in chronological order (earliest reply first), matching the
   * order Slack returns from conversations.replies.
   *
   * For a typical single-turn test this array has exactly one entry — the single
   * streaming reply produced by one StreamingBridge.handleMessage() run.
   *
   * Optional: absent in cassettes recorded before this field was introduced.
   * When absent only `finalText` is used for AC 3 assertions.
   */
  messages?: ExpectedSlackMessage[];
}

// ---------------------------------------------------------------------------
// RawSSEEvent — the unit of capture
// ---------------------------------------------------------------------------

/**
 * A single raw SSE event frame captured from the Claude Managed Agent sessions
 * API (`/v1/sessions/{id}/events` stream).
 *
 * Each frame in the SSE stream consists of two lines on the wire:
 *
 * ```
 * event: content_block_delta
 * data:  {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
 * ```
 *
 * `RawSSEEvent` mirrors this structure: `event` holds the event-name line value
 * and `data` holds the parsed JSON object from the data line.
 *
 * ### Notes on `event` vs `data.type`
 *
 * For Claude Managed Agent events, `event` and `data.type` are almost always
 * identical (e.g. both equal `"content_block_delta"`).  However they are kept
 * as separate fields to faithfully represent the SSE wire protocol and to guard
 * against any future divergence.
 *
 * ### Terminal events
 *
 * A well-formed cassette ends with exactly one terminal event whose `event`
 * field is one of:
 *   - `"session.status_idle"` — normal completion
 *   - `"session.status_terminated"` — forced termination
 *   - `"session.error"` — session-level error
 *   - `"session.deleted"` — session deleted mid-stream
 *
 * Replay stubs should stop yielding events after the first terminal event,
 * matching the behaviour of `parseSSEEvent()`'s `terminal: true` flag.
 */
export interface RawSSEEvent {
  /**
   * SSE event name — the value of the `event:` line in the SSE frame.
   *
   * Common values: `"content_block_delta"`, `"content_block_start"`,
   * `"content_block_stop"`, `"agent.message"`, `"agent.tool_use"`,
   * `"agent.tool_result"`, `"agent.thinking"`, `"session.status_running"`,
   * `"session.status_idle"`, `"session.status_terminated"`, `"session.error"`,
   * `"session.deleted"`, `"span.model_request_start"`, etc.
   */
  event: string;

  /**
   * Parsed JSON payload from the `data:` line of the SSE frame.
   *
   * This is the full, unmodified object as received from the API.  Replay code
   * passes `data` directly to `parseSSEEvent()` to reconstruct the typed
   * `AgentStreamEvent` stream.
   *
   * The `type` property inside `data` typically equals the `event` field, but
   * the full `data` object is always preserved to retain all fields (e.g.
   * `index`, `delta`, `content_block`, tool inputs, stop reasons, etc.).
   */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CassetteFixtureSchema — top-level fixture file shape
// ---------------------------------------------------------------------------

/**
 * Complete schema for a cassette fixture file stored on disk.
 *
 * One instance of this interface is serialised as a single `.json` file
 * under `tests/e2e/fixtures/`.  It captures everything needed to replay the
 * Claude Managed Agent SSE stream deterministically in a test run:
 *
 *   1. The raw SSE events (`events`) — replayed via a stub that yields them in
 *      order and passes each `data` object through `parseSSEEvent()`.
 *   2. The session ID (`sessionId`) — returned by the stub's `createSession()`
 *      so that `BridgeResult.sessionId` is stable across replay runs.
 *   3. The run tag (`tag`) — embedded in the Slack trigger message for run
 *      isolation (AC 8); stored for traceability.
 *   4. Metadata (`version`, `scenario`, `recordedAt`) — schema hygiene and
 *      debugging aids.
 */
export interface CassetteFixtureSchema {
  /**
   * Schema version.  Must equal `CASSETTE_SCHEMA_VERSION` (currently `1`).
   *
   * If a loaded fixture has a different version number, replay should fail fast
   * with a descriptive error asking the contributor to re-record.
   */
  version: typeof CASSETTE_SCHEMA_VERSION;

  /**
   * Kebab-case test scenario identifier.
   *
   * Matches the filename stem: `"basic-mention"` is stored at
   * `tests/e2e/fixtures/basic-mention.json`.
   *
   * The scenario name is embedded here so the file is self-describing when
   * inspected directly.
   */
  scenario: string;

  /**
   * ISO 8601 UTC timestamp of when this cassette was recorded.
   *
   * Example: `"2026-04-13T12:00:00.000Z"`
   *
   * Useful for tracking fixture freshness.  A cassette is considered stale when
   * it was recorded against a significantly older agent version or environment.
   * There is no automated staleness enforcement — this is purely informational.
   */
  recordedAt: string;

  /**
   * The Claude Managed Agent session ID created during recording.
   *
   * The replay stub returns this from `createSession()` so that
   * `BridgeResult.sessionId` is consistent and assertable across replay runs.
   *
   * In record mode this is the real session ID returned by the Anthropic API.
   * In replay mode it is a stable string used only for identity comparisons —
   * no actual API calls are made with it.
   */
  sessionId: string;

  /**
   * Unique run-isolation tag embedded in the Slack trigger message.
   *
   * Format: `e2e-{15 digits}-{8 hex chars}` (from `makeRunTag()`).
   * Example: `"e2e-20260413120000000-a1b2c3d4"`
   *
   * Stored for traceability — each cassette can be linked back to the specific
   * Slack message that triggered the recording run.
   */
  tag: string;

  /**
   * Ordered sequence of raw SSE events captured from the live Claude API.
   *
   * ## Ordering
   *
   * Events are stored in the exact order they were received from the SSE
   * stream, earliest first.  Replay stubs must yield them in this order.
   *
   * ## Terminal event
   *
   * A well-formed cassette's `events` array ends with exactly one terminal
   * event (`session.status_idle`, `session.status_terminated`, `session.error`,
   * or `session.deleted`).  Replay stubs stop after the terminal event,
   * matching the `terminal: true` signal from `parseSSEEvent()`.
   *
   * ## Minimum viable cassette
   *
   * The smallest valid cassette has at least two events:
   *   1. At least one content event (e.g. `content_block_delta` with text)
   *   2. A terminal event (`session.status_idle`)
   *
   * An empty `events` array is invalid and should cause replay to fail.
   *
   * ## Replay contract
   *
   * ```ts
   * for (const raw of cassette.events) {
   *   const { events, terminal } = parseSSEEvent(raw.data);
   *   for (const e of events) yield e;
   *   if (terminal) return;
   * }
   * ```
   */
  events: RawSSEEvent[];

  /**
   * Expected final state of the Slack thread after the bridge completes (AC 3).
   *
   * Captured from conversations.replies during the recording run and stored
   * alongside the SSE events so that replay runs can assert against it without
   * requiring a separate expected-outcomes file.
   *
   * ## Structure
   *
   * Contains the ordered list of bot-reply messages observed in the thread,
   * each with full text, optional Block Kit blocks, and thread metadata.
   * See `ExpectedSlackThread` for the complete field documentation.
   *
   * ## Presence
   *
   * This field is optional for backward compatibility with cassettes recorded
   * before this schema extension was introduced.  When absent, replay falls
   * back to the `finalText`-only assertion path.  Freshly recorded cassettes
   * (i.e., recorded after this field was added) always include it.
   *
   * ## Derivation vs capture
   *
   * `finalText` is derivable from `events` via `computeFullText()`.
   * `messages[*].blocks` must be captured from the live Slack API response —
   * they cannot be reconstructed from SSE events alone.
   */
  expectedSlackThread?: ExpectedSlackThread;
}

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

/**
 * Runtime type guard that checks whether a parsed JSON value conforms to the
 * `CassetteFixtureSchema` shape.
 *
 * Validates:
 *   - `version` equals `CASSETTE_SCHEMA_VERSION`
 *   - `scenario`, `recordedAt`, `sessionId`, `tag` are non-empty strings
 *   - `events` is an array where every entry has `event: string` and
 *     `data: object` fields (deep event-payload validation is deferred to
 *     `parseSSEEvent()` at replay time)
 *   - `expectedSlackThread`, when present, satisfies `isExpectedSlackThread()`
 *
 * @param value  The candidate value — typically the result of `JSON.parse()`
 * @returns `true` when `value` satisfies `CassetteFixtureSchema`
 *
 * @example
 * ```ts
 * const raw = JSON.parse(await readFile(path, "utf-8"));
 * if (!isCassetteFixtureSchema(raw)) {
 *   throw new Error(`Invalid cassette at ${path}: unexpected schema`);
 * }
 * // raw is now typed as CassetteFixtureSchema
 * const events = raw.events; // RawSSEEvent[]
 * const thread = raw.expectedSlackThread; // ExpectedSlackThread | undefined
 * ```
 */
export function isCassetteFixtureSchema(
  value: unknown,
): value is CassetteFixtureSchema {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  // Version must match exactly — old cassettes need to be re-recorded
  if (v["version"] !== CASSETTE_SCHEMA_VERSION) return false;

  // Required string fields
  if (
    typeof v["scenario"] !== "string" || v["scenario"].length === 0 ||
    typeof v["recordedAt"] !== "string" || v["recordedAt"].length === 0 ||
    typeof v["sessionId"] !== "string" || v["sessionId"].length === 0 ||
    typeof v["tag"] !== "string" || v["tag"].length === 0
  ) {
    return false;
  }

  // events must be an array
  if (!Array.isArray(v["events"])) return false;

  // Every event entry must have string `event` and object `data` fields
  for (const entry of v["events"] as unknown[]) {
    if (entry == null || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (
      typeof e["event"] !== "string" || e["event"].length === 0 ||
      e["data"] == null || typeof e["data"] !== "object" || Array.isArray(e["data"])
    ) {
      return false;
    }
  }

  // expectedSlackThread is optional; when present it must be structurally valid
  if (
    v["expectedSlackThread"] !== undefined &&
    !isExpectedSlackThread(v["expectedSlackThread"])
  ) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// ExpectedSlackThread type guard helpers
// ---------------------------------------------------------------------------

/**
 * Runtime type guard for `ExpectedSlackThread`.
 *
 * Validates:
 *   - `finalText` is a string (may be empty for no-text responses)
 *   - `messages`, when present, is an array of valid `ExpectedSlackMessage` entries
 *
 * @param value  The candidate value
 * @returns `true` when `value` satisfies `ExpectedSlackThread`
 */
export function isExpectedSlackThread(
  value: unknown,
): value is ExpectedSlackThread {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  // finalText must be a string (empty string is valid — no text was streamed)
  if (typeof v["finalText"] !== "string") return false;

  // messages is optional; when present it must be a valid array
  if (v["messages"] !== undefined) {
    if (!Array.isArray(v["messages"])) return false;
    for (const entry of v["messages"] as unknown[]) {
      if (!isExpectedSlackMessage(entry)) return false;
    }
  }

  return true;
}

/**
 * Runtime type guard for `ExpectedSlackMessage`.
 *
 * Validates:
 *   - `text` is a string
 *   - `isBot` is a boolean
 *   - `blocks`, when present, is an array where every entry has `type: string`
 *   - `meta` satisfies `isExpectedSlackMessageMeta()`
 *
 * @param value  The candidate value
 * @returns `true` when `value` satisfies `ExpectedSlackMessage`
 */
export function isExpectedSlackMessage(
  value: unknown,
): value is ExpectedSlackMessage {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (typeof v["text"] !== "string") return false;
  if (typeof v["isBot"] !== "boolean") return false;

  // blocks is optional; when present every entry must have a string `type` field
  if (v["blocks"] !== undefined) {
    if (!Array.isArray(v["blocks"])) return false;
    for (const block of v["blocks"] as unknown[]) {
      if (block == null || typeof block !== "object") return false;
      const b = block as Record<string, unknown>;
      if (typeof b["type"] !== "string" || b["type"].length === 0) return false;
    }
  }

  // meta is required
  if (!isExpectedSlackMessageMeta(v["meta"])) return false;

  return true;
}

/**
 * Runtime type guard for `ExpectedSlackMessageMeta`.
 *
 * Validates:
 *   - `replyIndex` is a non-negative integer
 *   - `isBotMessage` is a boolean
 *   - `replyCount`, when present, is a non-negative integer
 *
 * @param value  The candidate value
 * @returns `true` when `value` satisfies `ExpectedSlackMessageMeta`
 */
export function isExpectedSlackMessageMeta(
  value: unknown,
): value is ExpectedSlackMessageMeta {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (typeof v["replyIndex"] !== "number" || v["replyIndex"] < 0) return false;
  if (typeof v["isBotMessage"] !== "boolean") return false;

  // replyCount is optional; when present must be a non-negative integer
  if (
    v["replyCount"] !== undefined &&
    (typeof v["replyCount"] !== "number" || v["replyCount"] < 0)
  ) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Terminal event helpers
// ---------------------------------------------------------------------------

/**
 * SSE event names that signal the end of a Claude Managed Agent SSE stream.
 *
 * A well-formed cassette must end with one of these event names.
 * Replay stubs should stop yielding after encountering any of these events.
 */
export const TERMINAL_SSE_EVENTS = new Set<string>([
  "session.status_idle",
  "session.status_terminated",
  "session.error",
  "session.deleted",
]);

/**
 * Returns `true` if the given `RawSSEEvent` is a terminal event that signals
 * the end of the SSE stream.
 *
 * @example
 * ```ts
 * for (const raw of cassette.events) {
 *   processEvent(raw);
 *   if (isTerminalSSEEvent(raw)) break;
 * }
 * ```
 */
export function isTerminalSSEEvent(event: RawSSEEvent): boolean {
  return TERMINAL_SSE_EVENTS.has(event.event);
}
