/**
 * Discord 2K message overflow utilities.
 *
 * Pure async utilities for distributing streamed text content across multiple
 * Discord messages when content approaches or exceeds the 2000-character limit.
 *
 * These functions work with the minimal `DiscordEditableMessage` and
 * `DiscordSendableChannel` interfaces, so they can be unit-tested without the
 * full discord.js client and reused by any Discord streaming layer.
 *
 * ## Overflow semantics
 *
 * ```
 * original text: [-------- 2000 --------][-------- 2000 --------][-- rest --]
 *                ↑                       ↑                       ↑
 *             part1                  overflowDisplay          remainingBuffer
 *             → edit currentMessage  → send new message       → returned to
 *                                     (new activeMessage)       caller for
 *                                                               next flush
 * ```
 *
 * ### Function overview
 *
 * | Function           | Use case                                          |
 * |--------------------|---------------------------------------------------|
 * | `splitIntoChunks`  | Pure split — no Discord calls, useful for tests   |
 * | `flushToMessage`   | Mid-stream overflow: one edit + optional one send |
 * | `drainBuffer`      | `finish()` normal mode: exhausts entire buffer    |
 * | `sendChunks`       | `finish()` fallback mode: all-new-send, no edits  |
 */

import { DISCORD_MESSAGE_LIMIT, THINKING_PLACEHOLDER } from "./constants.js";
import type {
  DiscordEditableMessage,
  DiscordSendableChannel,
} from "./stream-handle.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link flushToMessage} after writing content to Discord.
 */
export interface FlushResult {
  /**
   * The Discord message currently being tracked for in-place edits.
   *
   * - Equal to the input `currentMessage` when no overflow occurred (text ≤ 2 K).
   * - Points to the newly-created follow-up message when overflow occurred.
   *
   * The caller should replace their `currentMessage` reference with this value
   * so subsequent edits target the correct message.
   */
  activeMessage: DiscordEditableMessage;

  /**
   * Characters that were **not** written to any Discord message in this call.
   *
   * `""` in the common case (original text ≤ 4 K).
   *
   * Non-empty only when the original text exceeded 4 K: the characters
   * beyond position 4000 could not fit in the overflow follow-up message and
   * must be stored in the caller's accumulation buffer for a subsequent flush.
   *
   * ### Why this matters (mid-stream overflow edge case)
   *
   * If the caller were to truncate the stored buffer to 2 K after an overflow,
   * text between positions 2 K–4 K would silently appear in `overflowDisplay`
   * but never be re-edited (it's gone from the accumulation buffer). By
   * returning the **full** remaining string (`overflow.slice(2000)`) the caller
   * can store it verbatim and let the next flush handle it correctly.
   */
  remainingBuffer: string;
}

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

/**
 * Split `text` into an array of strings each ≤ `limit` characters.
 *
 * This is a **pure, synchronous** function — no Discord API calls are made.
 * It is useful for:
 * - Pre-calculating how many messages a buffer will require.
 * - Testing overflow logic independently of async Discord interactions.
 *
 * @param text  - Content to split. Returns `[]` for empty / falsy input.
 * @param limit - Per-chunk character limit. Defaults to `DISCORD_MESSAGE_LIMIT` (2000).
 * @returns Array of chunks, each ≤ `limit` characters. Order is preserved.
 *
 * @example
 * splitIntoChunks("abcde", 2) // → ["ab", "cd", "e"]
 * splitIntoChunks("hello")    // → ["hello"]  (fits in one message)
 * splitIntoChunks("")         // → []
 */
export function splitIntoChunks(
  text: string,
  limit: number = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Async Discord operations
// ---------------------------------------------------------------------------

/**
 * Write `text` to `currentMessage`, handling 2K overflow with a follow-up message.
 *
 * This is the **mid-stream** overflow primitive — it performs exactly one edit
 * and at most one send per call, then hands control back to the caller via
 * the returned {@link FlushResult}. It does not loop; for exhaustive draining
 * use {@link drainBuffer} instead.
 *
 * ### When text fits (≤ 2000 chars)
 *
 * Edits `currentMessage` in-place. Returns:
 * ```ts
 * { activeMessage: currentMessage, remainingBuffer: "" }
 * ```
 *
 * ### When text overflows (> 2000 chars)
 *
 * 1. Edits `currentMessage` with `text.slice(0, 2000)`.
 * 2. Posts `text.slice(2000, 4000)` as a new follow-up message via `channel.send()`.
 * 3. Returns:
 *    ```ts
 *    { activeMessage: newMessage, remainingBuffer: text.slice(4000) }
 *    ```
 *    `remainingBuffer` is non-empty only when the original text exceeded 4 K.
 *    The caller should store the full remaining text in their accumulation buffer
 *    and schedule another flush — **not** truncate it.
 *
 * @param text           - Full text to display (may exceed 2 K).
 * @param currentMessage - Discord message to edit in-place.
 * @param channel        - Discord channel used to post overflow follow-up messages.
 * @returns {@link FlushResult} with the updated active message reference and any
 *   remaining characters that could not be written in this call.
 *
 * @throws Re-throws any error from `currentMessage.edit()` or `channel.send()`.
 *   Callers (e.g., `DiscordStreamHandle`) are responsible for rate-limit error
 *   detection and recovery.
 */
export async function flushToMessage(
  text: string,
  currentMessage: DiscordEditableMessage,
  channel: DiscordSendableChannel,
): Promise<FlushResult> {
  // Happy path: text fits in one message.
  if (text.length <= DISCORD_MESSAGE_LIMIT) {
    await currentMessage.edit({ content: text });
    return { activeMessage: currentMessage, remainingBuffer: "" };
  }

  // Overflow path:
  // 1. Finalise the current message with the first 2 K.
  // 2. Post the next ≤2 K as a new follow-up message.
  // 3. Return the remainder (> 4 K) so the caller can re-schedule a flush.
  const part1 = text.slice(0, DISCORD_MESSAGE_LIMIT);
  const overflow = text.slice(DISCORD_MESSAGE_LIMIT); // everything beyond 2 K
  const overflowDisplay = overflow.slice(0, DISCORD_MESSAGE_LIMIT); // next ≤2 K
  const remainingBuffer = overflow.slice(DISCORD_MESSAGE_LIMIT); // beyond 4 K

  await currentMessage.edit({ content: part1 });
  const newMessage = await channel.send({ content: overflowDisplay });

  return { activeMessage: newMessage, remainingBuffer };
}

/**
 * Drain an **entire** text buffer to Discord, posting additional messages as
 * needed until all content is written.
 *
 * Used by `DiscordStreamHandle.finish()` (**normal mode** — not rate-limit
 * fallback) to synchronously flush all remaining buffered content at stream
 * completion.
 *
 * Unlike {@link flushToMessage}, this function loops until the buffer is empty,
 * making it suitable for arbitrarily long responses.
 *
 * ### Behavior
 *
 * | Input buffer              | Action                                           |
 * |---------------------------|--------------------------------------------------|
 * | Empty                     | Edits `currentMessage` with `emptyFallback`      |
 * | ≤ 2000 chars              | Edits `currentMessage` once                      |
 * | > 2000 chars              | Edits + posts follow-up messages in a loop       |
 *
 * Between chunks, a `nextMessagePlaceholder` (default: `"⏳ Thinking…"`) is
 * used as the initial content of each new follow-up message before it is
 * immediately overwritten with real content on the next loop iteration.
 *
 * @param buffer                        - Full text buffer to drain.
 * @param currentMessage                - Discord message to begin writing into.
 * @param channel                       - Discord channel for overflow follow-up messages.
 * @param options.emptyFallback         - Content to use when buffer is empty
 *   (default: `"(no response)"`).
 * @param options.nextMessagePlaceholder - Initial content of each overflow message
 *   (default: `"⏳ Thinking…"`).
 * @returns The final {@link DiscordEditableMessage} after draining — the last
 *   message written to. Useful for chaining or verification in tests.
 *
 * @throws Re-throws any error from Discord API calls. Callers are responsible
 *   for error handling.
 */
export async function drainBuffer(
  buffer: string,
  currentMessage: DiscordEditableMessage,
  channel: DiscordSendableChannel,
  options: {
    emptyFallback?: string;
    nextMessagePlaceholder?: string;
  } = {},
): Promise<DiscordEditableMessage> {
  const emptyFallback = options.emptyFallback ?? "(no response)";
  const nextPlaceholder = options.nextMessagePlaceholder ?? THINKING_PLACEHOLDER;

  if (!buffer) {
    await currentMessage.edit({ content: emptyFallback });
    return currentMessage;
  }

  let remaining = buffer;
  let active = currentMessage;

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
    remaining = remaining.slice(DISCORD_MESSAGE_LIMIT);

    await active.edit({ content: chunk });

    if (remaining.length > 0) {
      // Post a placeholder for the next chunk; it will be immediately
      // overwritten in the next loop iteration with the real content.
      active = await channel.send({ content: nextPlaceholder });
    }
  }

  return active;
}

/**
 * Send an entire text buffer as one or more **new** Discord messages.
 *
 * Used by `DiscordStreamHandle.finish()` in **rate-limit fallback mode**, where
 * no streaming edits were made during the stream and the accumulated text must
 * be delivered as fresh messages rather than editing the existing placeholder.
 *
 * Unlike {@link drainBuffer}, this function **never calls `message.edit()`** —
 * it only calls `channel.send()`. The initial placeholder message created at
 * stream start is intentionally left unchanged (per the fallback mode contract).
 *
 * ### Behavior
 *
 * | Input buffer     | Action                                         |
 * |------------------|------------------------------------------------|
 * | Empty            | Sends one message with `emptyFallback` content |
 * | ≤ 2000 chars     | Sends one message                              |
 * | > 2000 chars     | Splits into ≤2 K chunks and sends each         |
 *
 * @param buffer                - Full text buffer to send.
 * @param channel               - Discord channel to send messages to.
 * @param options.emptyFallback - Content sent when buffer is empty
 *   (default: `"(no response)"`).
 *
 * @throws Re-throws any error from `channel.send()`. Callers are responsible
 *   for error handling.
 */
export async function sendChunks(
  buffer: string,
  channel: DiscordSendableChannel,
  options: { emptyFallback?: string } = {},
): Promise<void> {
  const emptyFallback = options.emptyFallback ?? "(no response)";

  if (!buffer) {
    await channel.send({ content: emptyFallback });
    return;
  }

  let remaining = buffer;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
    remaining = remaining.slice(DISCORD_MESSAGE_LIMIT);
    await channel.send({ content: chunk });
  }
}
