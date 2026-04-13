/**
 * Slack thread assertion helpers for the e2e test suite.
 *
 * Implements AC 3: verifies that after the StreamingBridge processes a message,
 * the Slack thread (read via conversations.replies) contains exactly one bot
 * reply whose text matches the expected fixture text.
 *
 * Built on top of SlackUserClient which handles low-level polling and filtering.
 */

import { expect } from "vitest";
import type { SlackUserClient, SlackMessage, PollOptions } from "./slack-user-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssertSlackThreadOptions {
  /**
   * SlackUserClient configured with the user token and channel ID.
   * Used to call conversations.replies and poll for replies.
   */
  userClient: SlackUserClient;

  /**
   * Thread root timestamp (ts of the message that triggered the bot).
   * Passed to conversations.replies as `ts`.
   */
  threadTs: string;

  /**
   * Only consider replies strictly after this timestamp.
   * Typically set to `threadTs` so the trigger message itself is excluded.
   */
  afterTs: string;

  /**
   * Bot user ID (Uxxxxxxxx) used to filter bot replies.
   * When provided, only messages from this user ID or with bot_id set are counted.
   * When omitted, any message with bot_id is treated as a bot reply.
   */
  botUserId?: string;

  /**
   * Expected final text that the bot reply must contain.
   * Derived from the fixture's accumulated text_delta events.
   */
  expectedText: string;

  /**
   * Polling options passed to SlackUserClient.pollForBotReply.
   * Defaults: maxAttempts=30, intervalMs=2000 (up to 60 seconds of polling).
   */
  pollOptions?: PollOptions;
}

/** Result returned by assertSlackThread for downstream use */
export interface SlackThreadAssertionResult {
  /** The single bot reply message found in the thread */
  botReply: SlackMessage;

  /** All bot reply messages found (should be length 1) */
  allBotReplies: SlackMessage[];
}

// ---------------------------------------------------------------------------
// Core assertion
// ---------------------------------------------------------------------------

/**
 * AC 3 assertion: reads the Slack thread via conversations.replies and asserts:
 *   1. Exactly one bot reply is present in the thread.
 *   2. The bot reply text contains the expected fixture text.
 *
 * Polls the thread until at least one bot reply appears (or times out).
 *
 * @throws If no bot reply appears before timeout, or assertions fail.
 * @returns The bot reply message and metadata for downstream assertions.
 */
export async function assertSlackThread(
  opts: AssertSlackThreadOptions,
): Promise<SlackThreadAssertionResult> {
  const {
    userClient,
    threadTs,
    afterTs,
    botUserId,
    expectedText,
    pollOptions,
  } = opts;

  // Poll until at least one bot reply appears (bridge may take a moment to finish)
  const botReplies = await userClient.pollForBotReply(threadTs, afterTs, {
    maxAttempts: 30,
    intervalMs: 2000,
    ...pollOptions,
    botUserId,
  });

  // ── Assertion 1: Exactly one bot reply ──────────────────────────────────────
  //
  // After a single bridge.handleMessage() call, the bridge creates exactly one
  // streaming message via chat.startStream → appendStream → stopStream.
  // Multiple bot messages would indicate a bug (e.g., error fallback + stream).
  expect(
    botReplies,
    `Expected exactly 1 bot reply in thread ${threadTs} but found ${botReplies.length}.\n` +
      `Bot replies: ${JSON.stringify(botReplies.map((m) => ({ ts: m.ts, text: m.text?.slice(0, 80) })), null, 2)}`,
  ).toHaveLength(1);

  const botReply = botReplies[0];

  // ── Assertion 2: Bot reply text matches fixture expected text ────────────────
  //
  // The bridge accumulates text_delta events and appends them to the stream.
  // The fixture's expectedText is the concatenation of all text_delta.text values.
  // After stopStream, conversations.replies should show the finalized text.
  //
  // We use toContain rather than exact equality because:
  //   - Slack may normalize whitespace or add formatting characters
  //   - Streaming messages may include task indicator text in addition to content
  const replyText = botReply.text ?? "";

  expect(
    replyText,
    `Bot reply text should contain the fixture's expected text.\n` +
      `  Expected to contain: ${JSON.stringify(expectedText.slice(0, 200))}\n` +
      `  Actual reply text:   ${JSON.stringify(replyText.slice(0, 200))}`,
  ).toContain(expectedText);

  return { botReply, allBotReplies: botReplies };
}

// ---------------------------------------------------------------------------
// Lower-level helper for direct thread inspection (no assertions)
// ---------------------------------------------------------------------------

/**
 * Fetch all bot replies in a Slack thread without running assertions.
 *
 * Useful for debugging and for composing custom assertions in tests that
 * need to inspect the thread state without the AC 3 assertion semantics.
 *
 * @param userClient  SlackUserClient for API calls
 * @param threadTs    Thread root timestamp
 * @param afterTs     Only return messages with ts > afterTs
 * @param botUserId   Bot user ID filter (optional)
 * @returns Array of bot reply messages (may be empty if none found)
 */
export async function fetchBotReplies(
  userClient: SlackUserClient,
  threadTs: string,
  afterTs: string,
  botUserId?: string,
): Promise<SlackMessage[]> {
  return userClient.fetchThreadReplies(threadTs, afterTs, botUserId);
}

/**
 * Build a human-readable summary of a Slack thread for error messages.
 *
 * @param replies  Array of SlackMessage objects to summarise
 * @returns Formatted string for use in assertion error messages
 */
export function summariseReplies(replies: SlackMessage[]): string {
  if (replies.length === 0) return "(no replies)";
  return replies
    .map(
      (m, i) =>
        `  [${i + 1}] ts=${m.ts} botId=${m.botId ?? "—"} text=${JSON.stringify((m.text ?? "").slice(0, 100))}`,
    )
    .join("\n");
}
