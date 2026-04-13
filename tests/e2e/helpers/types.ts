/**
 * Cassette fixture types for E2E tests.
 *
 * Each cassette captures:
 *   - The SSE event stream emitted by the Claude Managed Agent (for deterministic replay)
 *   - Expected test outcomes for each assertion surface (BridgeResult, Slack thread, plan tasks)
 *
 * Cassettes are stored as JSON under tests/e2e/fixtures/ (gitignored).
 * Each contributor records their own cassette on first run.
 */

import type { AgentStreamEvent } from "../../../src/core/chunk-parser.js";
import type { StreamTask } from "../../../src/core/channel-adapter.js";

// ---------------------------------------------------------------------------
// Expected outcome shapes
// ---------------------------------------------------------------------------

/**
 * Expected values from BridgeResult (AC 2 assertions).
 * Derived deterministically from the cassette events.
 */
export interface CassetteExpectedResult {
  success: boolean;
  totalChars: number;
  updateCount: number;
}

// ---------------------------------------------------------------------------
// Slack thread expected shape — types for AC 3 assertions
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
 * content (text values, element arrays, image URLs, etc.) is NOT compared
 * exactly because:
 *   - Streaming messages may carry dynamic metadata in blocks (session IDs,
 *     timestamps, or plan-task status fields) that differ between runs.
 *   - Slack's server-side block rendering may add or reorder sub-fields.
 *
 * Stored verbatim from the live recording so the fixture is a faithful snapshot
 * of what Slack returned.
 */
export interface ExpectedSlackBlock {
  /** Slack Block Kit block type identifier (e.g. "section", "rich_text", "divider") */
  type: string;
  /** Remaining block fields — preserved verbatim from the live recording */
  [key: string]: unknown;
}

/**
 * Thread-level metadata captured for a single message entry from conversations.replies.
 *
 * Provides enough context to:
 *   1. Identify a message's position in the bot-reply ordering.
 *   2. Confirm it originated from a bot integration (not a human user).
 *   3. Surface the Slack reply_count for optional sanity checks.
 */
export interface ExpectedSlackMessageMeta {
  /**
   * Zero-based index of this message in the filtered bot-reply array.
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
   * has `bot_id` set by Slack, which is how bot replies are distinguished from
   * human replies. Should always be `true` for entries in `messages`.
   */
  isBotMessage: boolean;

  /**
   * Slack `reply_count` on this message, if returned by the API.
   *
   * For messages that are themselves replies (not thread roots) this is typically
   * `0` or absent. Stored when present so that tests requiring nested-thread
   * scenarios can assert on it.
   */
  replyCount?: number;
}

/**
 * Expected shape of a single Slack message in the thread, as captured from
 * conversations.replies during a live recording run.
 *
 * One entry per bot-reply message observed in the thread after the bridge
 * completes. Multiple entries would appear in scenarios where the bot posts
 * more than one streaming message (e.g., error fallback + normal reply).
 */
export interface ExpectedSlackMessage {
  /**
   * Full message text as returned by conversations.replies after stopStream.
   *
   * For streaming bot replies this is the final rendered text including all
   * appended text deltas. May include Slack mrkdwn formatting characters,
   * escaped entities, and bot mention strings.
   *
   * ## Assertion strategy
   * Asserted with `toContain` (not strict equality) during replay to tolerate:
   *   - Minor whitespace normalisation applied by Slack's rendering pipeline.
   *   - Slack mrkdwn escaping of special characters.
   *   - Task-indicator text that may be injected alongside main content.
   */
  text: string;

  /**
   * Whether this message was posted by the bot (has `bot_id` in Slack payload).
   *
   * All entries in `CassetteExpectedSlackThread.messages` represent bot replies,
   * so this should always be `true`. Present explicitly so assertions can confirm
   * no human messages were mistakenly included in the expected list.
   */
  isBot: boolean;

  /**
   * Slack Block Kit blocks attached to this message, if any.
   *
   * Present for messages created via chat.startStream / stopStream — Slack may
   * automatically wrap streaming content in rich_text blocks or attach plan-mode
   * task blocks. Absent for plain-text messages (chat.postMessage without blocks).
   *
   * Stored verbatim from the live recording. During replay assertions only block
   * types are compared (not full block content) because dynamic fields may differ.
   *
   * `undefined` means no blocks were present on this message during recording.
   * An empty array (`[]`) means Slack returned a blocks field but it was empty.
   */
  blocks?: ExpectedSlackBlock[];

  /** Thread and identity metadata for this message */
  meta: ExpectedSlackMessageMeta;
}

/**
 * Expected final state of the Slack thread after the StreamingBridge completes
 * (AC 3 assertions). Captured from conversations.replies during the recording run;
 * compared against the live thread during replay.
 *
 * ## What is captured
 *
 * After `bridge.handleMessage()` resolves, the recording path calls
 * conversations.replies and captures every bot reply in the thread. This
 * snapshot becomes the ground truth for replay assertions.
 *
 * ## Replay assertions
 *
 * During replay, the live Slack thread (also real — Slack round-trips are always
 * live) is read via conversations.replies and each bot reply is matched against
 * this stored snapshot:
 *
 *   1. `messages.length`            → `toHaveLength(1)` — exactly one bot reply
 *   2. `messages[0].isBot`          → `toBe(true)` — bot authorship confirmed
 *   3. `messages[0].text`           → `toContain(finalText)` — text matches cassette
 *   4. `messages[0].blocks[*].type` → structural block type check when blocks present
 *
 * ## Backward compatibility
 *
 * `finalText` is kept as the primary field for compatibility with existing test
 * assertions.  `messages` is optional so that cassettes recorded before this
 * field was introduced remain valid without re-recording.
 */
export interface CassetteExpectedSlackThread {
  /**
   * Concatenation of all `text_delta.text` values from the cassette SSE events.
   *
   * This is the complete text the bot streamed and what should appear verbatim
   * inside the final Slack reply. Used in `assertSlackThread()` with `toContain`.
   *
   * Derivable deterministically from `cassette.events` via `computeFullText()`.
   */
  finalText: string;

  /**
   * Ordered list of bot-reply messages observed in the Slack thread after the
   * bridge run, captured from conversations.replies during the recording phase.
   *
   * Messages appear in chronological order (earliest reply first), matching the
   * ordering returned by Slack's conversations.replies API.
   *
   * For a typical single-turn test this array has exactly one entry — the single
   * streaming reply produced by the StreamingBridge run.
   *
   * Optional: absent in cassettes recorded before this schema version. When absent
   * only `finalText` is used for AC 3 Slack thread assertions.
   */
  messages?: ExpectedSlackMessage[];
}

// ---------------------------------------------------------------------------
// Cassette
// ---------------------------------------------------------------------------

/**
 * Full cassette fixture: captured SSE events + expected outcomes.
 *
 * In record mode: populated from a live Claude Managed Agent run.
 * In replay mode: loaded from disk and used to drive assertions.
 */
export interface Cassette {
  /**
   * Unique run tag (timestamp + short random hex) used for fixture isolation.
   * Included in the Slack message text so each run is identifiable in the channel.
   */
  tag: string;

  /**
   * The Claude Managed Agent session ID created during recording.
   * ReplayAgentClient returns this from createSession() in replay mode.
   */
  sessionId: string;

  /**
   * Complete SSE event stream captured from Claude during recording.
   * ReplayAgentClient replays these events deterministically in replay mode.
   */
  events: AgentStreamEvent[];

  /** Expected test outcomes for each assertion surface */
  expected: {
    /** BridgeResult assertions (AC 2) */
    result: CassetteExpectedResult;
    /** Slack thread reply assertions (AC 3) */
    slackThread?: CassetteExpectedSlackThread;
    /** Plan-mode task indicator assertions (AC 4) */
    planTasks?: StreamTask[];
  };
}
