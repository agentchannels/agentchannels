/**
 * DiscordStreamHandle — Edit-in-place streaming response for Discord.
 *
 * Manages a streaming agent response as an incrementally-edited Discord message,
 * respecting Discord's rate limits and 2 K character limit per message.
 *
 * ## Architecture
 *
 * ```
 * StreamingBridge.handleMessage()
 *   ↓ text_delta events
 * DiscordStreamHandle.append()
 *   ↓ rate-limited flush (~1 s cadence)
 * currentMessage.edit()   ← edits the Discord message in-place
 *   ↓ when buffer > 2000 chars
 * channel.send()          ← posts overflow as a new follow-up message
 * ```
 *
 * ## Rate limiting
 *
 * Discord enforces ~5 edits per 5 seconds per channel. This class enforces a
 * `STREAM_EDIT_INTERVAL_MS` (1 000 ms) minimum cadence: rapid `append()` calls
 * are coalesced — only the most recent buffered content is sent when the timer fires.
 *
 * ## 2 K overflow
 *
 * When accumulated text exceeds `DISCORD_MESSAGE_LIMIT` (2 000 characters),
 * the current message is finalised at the limit and a new follow-up message
 * is posted to the channel. All subsequent edits target the new message.
 */

import type { StreamHandle, StreamTask } from "../../core/channel-adapter.js";
import {
  DISCORD_MESSAGE_LIMIT,
  STREAM_EDIT_INTERVAL_MS,
  THINKING_PLACEHOLDER,
} from "./constants.js";
import { DiscordRateLimitTracker } from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip Slack-style `:emoji_code:` patterns and trailing `✓` checkmarks
 * from task description text, producing clean Discord-displayable text.
 *
 * `StreamingBridge` calls `describeToolUse()` which returns Slack-formatted
 * strings like `:wrench: Using \`name\`` or `:gear: Running \`cmd\``.
 * These colon-codes do not render as emojis on Discord; stripping them
 * yields clean text that pairs naturally with Discord Unicode emojis.
 *
 * @example
 * cleanTaskText(":wrench: Using `bash`")     // → "Using `bash`"
 * cleanTaskText(":gear: Running `cmd` ✓")    // → "Running `cmd`"
 * cleanTaskText("Analyzing your request...")  // → "Analyzing your request..."
 */
export function cleanTaskText(text: string): string {
  return text
    .replace(/:[a-zA-Z0-9_]+:/g, "") // Strip Slack :emoji_code: patterns
    .replace(/\s*✓\s*$/, "") // Strip trailing ✓ (redundant alongside ✅)
    .trim();
}

/**
 * Render a single `StreamTask` as a Discord-friendly indicator line.
 *
 * Emoji mapping:
 * - `💡` — thinking / initializing steps (`id === "init"` or `id` starts with `"thinking_"`)
 * - `🔧` — tool use step in progress (`id` starts with `"tool_"`, `status === "in_progress"`)
 * - `✅` — tool use step complete  (`id` starts with `"tool_"`, `status === "complete"`)
 * - `⚙️` — generic in_progress fallback (non-standard id)
 * - `🔄` — generic pending fallback (non-standard id)
 *
 * Returns `null` for task/status combinations that should not be rendered
 * (e.g. completed thinking steps, errored tasks).
 */
export function renderTaskLine(task: StreamTask): string | null {
  const isThinkingTask = task.id === "init" || task.id.startsWith("thinking_");
  const isToolTask = task.id.startsWith("tool_");
  const text = cleanTaskText(task.text);

  if (isThinkingTask) {
    // Show active thinking/init tasks with lightbulb — completed ones are silent.
    if (task.status === "in_progress" || task.status === "pending") {
      return `💡 ${text}`;
    }
    return null;
  }

  if (isToolTask) {
    if (task.status === "in_progress") return `🔧 ${text}`;
    if (task.status === "complete") return `✅ ${text}`;
    return null; // error / pending tool tasks are silently dropped
  }

  // Generic fallback for tasks with non-standard IDs.
  if (task.status === "in_progress") return `⚙️ ${text}`;
  if (task.status === "pending") return `🔄 ${text}`;
  return null;
}

// ---------------------------------------------------------------------------
// Discord abstraction interfaces (for testability — no discord.js import)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a Discord message that supports in-place editing.
 *
 * Abstracts `discord.js` `Message` so that `DiscordStreamHandle` can be
 * unit-tested without mocking the full discord.js module.
 */
export interface DiscordEditableMessage {
  edit(options: { content: string }): Promise<unknown>;
}

/**
 * Minimal interface for a Discord text channel that can post new messages.
 *
 * Used by `DiscordStreamHandle` to post overflow messages when the 2 K limit
 * is reached mid-stream.
 */
export interface DiscordSendableChannel {
  send(options: { content: string }): Promise<DiscordEditableMessage>;
}

// ---------------------------------------------------------------------------
// DiscordStreamHandle
// ---------------------------------------------------------------------------

/**
 * Manages an edit-in-place streaming response on Discord.
 *
 * Implements `StreamHandle` (from `src/core/channel-adapter.ts`) by buffering
 * incoming text deltas and periodically editing a Discord message to reflect the
 * latest accumulated content.
 *
 * ### Lifecycle
 *
 * 1. Caller creates the initial placeholder message and passes it to the constructor.
 * 2. `StreamingBridge` calls `append(delta)` for each `text_delta` event.
 *    - Deltas are appended to `accumulatedText`.
 *    - A rate-limited flush is scheduled; rapid appends within the 1 s window
 *      are coalesced into a single edit.
 * 3. `StreamingBridge` (optionally) calls `appendTasks(tasks)` for thinking/tool steps.
 *    - Active tasks are rendered as prefix lines on the current message.
 * 4. `StreamingBridge` calls `finish([finalText])` when the agent stream ends.
 *    - Any pending timer is cancelled.
 *    - All remaining buffered content is written out synchronously, posting
 *      overflow follow-up messages as needed until the buffer is fully drained.
 *
 * ### Usage example
 *
 * ```ts
 * const placeholder = await channel.send({ content: "⏳ Thinking…" });
 * const handle = new DiscordStreamHandle(placeholder, channel);
 *
 * await handle.append("Hello ");
 * await handle.append("world!");
 * await handle.finish(); // flushes remaining buffer
 * ```
 */
export class DiscordStreamHandle implements StreamHandle {
  /**
   * Accumulated text buffer.
   *
   * All `append()` deltas since the last overflow reset are held here.
   * The buffer is replaced (not cleared) when overflow occurs — it is set
   * to the overflow text that was posted as the new follow-up message.
   */
  private accumulatedText = "";

  /** Timestamp of the most recent successful edit call (Date.now() in ms). */
  private lastEditTime = 0;

  /** Timer handle for the deferred rate-limit flush (undefined when idle). */
  private pendingFlush: ReturnType<typeof setTimeout> | undefined;

  /**
   * The Discord message currently being edited in-place.
   *
   * Mutated on each overflow: after posting the overflow content as a new
   * message, `currentMessage` is replaced with the new message so subsequent
   * edits target it instead of the now-full original.
   */
  private currentMessage: DiscordEditableMessage;

  /**
   * Whether a 429 rate-limit error was detected on the most recent flush.
   *
   * Set to `true` when `flushEdit()` or `appendTasks()` catches a 429 error.
   * Reset to `false` on the next successful edit.
   * Queryable via the public `isRateLimited` getter.
   */
  private _isRateLimited = false;

  /**
   * Tracks the currently-running timer-based flush promise.
   *
   * Set by `scheduleFlush()` when `flushEdit()` is started (either immediately
   * when `delay <= 0`, or when the deferred timer fires). Cleared via `.finally()`
   * when the flush completes.
   *
   * Used by `appendTasks()` and `finish()` to await any in-flight timer flush
   * before issuing their own `edit()` calls, preventing concurrent Discord API
   * edit requests from racing each other.
   */
  private flushTask: Promise<void> | undefined = undefined;

  /**
   * Whether the handle is operating in complete-message fallback mode.
   *
   * Fallback mode is active when:
   * - The channel was already rate-limited when this handle was constructed
   *   (pre-checked via `rateLimitTracker.isRateLimited(channelId)`), OR
   * - A 429 error was received during a streaming flush or task-indicator edit.
   *
   * In fallback mode:
   * - `append()` accumulates text in the buffer without scheduling any Discord edits.
   * - `appendTasks()` is a no-op (indicator updates are skipped).
   * - `finish()` drains the accumulated buffer by posting new `channel.send()` messages
   *   instead of editing `currentMessage`.  The initial placeholder message is left
   *   unchanged.
   */
  private _inFallbackMode = false;

  /**
   * @param initialMessage    - The Discord placeholder message to edit in-place.
   *   Created by the caller (e.g., `DiscordAdapter.startStream`) before
   *   constructing the handle.
   * @param channel           - The Discord channel used to post overflow messages when
   *   accumulated text exceeds 2 000 characters.
   * @param channelId         - The Discord channel/thread ID (used for per-channel
   *   rate-limit tracking). Optional; rate-limit recording is skipped when omitted.
   * @param rateLimitTracker  - Shared `DiscordRateLimitTracker` instance. When
   *   provided, 429 errors are recorded so `DiscordAdapter.isChannelRateLimited()`
   *   reflects the current state. Optional for backward compatibility.
   */
  constructor(
    initialMessage: DiscordEditableMessage,
    private readonly channel: DiscordSendableChannel,
    private readonly channelId?: string,
    private readonly rateLimitTracker?: DiscordRateLimitTracker,
  ) {
    this.currentMessage = initialMessage;
    // If the channel is already under a rate-limit cooldown when the handle is
    // created, enter fallback mode immediately so that no streaming edits are
    // attempted at all — the full response will be posted as a single message
    // via channel.send() when finish() is called.
    if (channelId && rateLimitTracker?.isRateLimited(channelId)) {
      this._inFallbackMode = true;
    }
  }

  // -------------------------------------------------------------------------
  // StreamHandle — public interface
  // -------------------------------------------------------------------------

  /**
   * `true` when the most recent flush attempt was rejected with a Discord 429
   * rate-limit error.  Resets to `false` on the next successful edit.
   *
   * Useful for downstream monitoring and adaptive back-off strategies.
   */
  get isRateLimited(): boolean {
    return this._isRateLimited;
  }

  /**
   * `true` when the handle is in complete-message fallback mode.
   *
   * In fallback mode all text is buffered silently (no streaming edits) until
   * `finish()` posts the full accumulated content via `channel.send()`.
   *
   * Becomes `true` either at construction (channel already rate-limited) or as
   * soon as the first 429 error is received during streaming.
   */
  get inFallbackMode(): boolean {
    return this._inFallbackMode;
  }

  /**
   * Append a text delta to the accumulation buffer and schedule a
   * rate-limited edit of the current Discord message.
   *
   * Rapid successive calls within the 1 s cadence window are coalesced:
   * only one edit fires per cadence interval, reflecting the latest buffer.
   *
   * @param delta - Incremental text to append (ignored if empty).
   */
  async append(delta: string): Promise<void> {
    if (!delta) return;
    this.accumulatedText += delta;
    // In fallback mode, text is buffered silently — no streaming edits are
    // scheduled.  finish() will drain the full buffer via channel.send().
    if (!this._inFallbackMode) {
      this.scheduleFlush();
    }
  }

  /**
   * Update inline agent activity indicators (thinking steps, tool use steps).
   *
   * Renders tasks as emoji-prefixed lines above the accumulated response text,
   * using Discord-native Unicode emojis:
   *
   * - `💡 text` — thinking / initializing tasks (id `"init"` or `"thinking_*"`)
   * - `🔧 text` — tool use in progress (id `"tool_*"`, status `"in_progress"`)
   * - `✅ text` — completed tool use (id `"tool_*"`, status `"complete"`)
   * - `⚙️ text` — generic in_progress fallback
   * - `🔄 text` — generic pending fallback
   *
   * Slack-style `:emoji_code:` patterns in task text are stripped before display
   * since Discord renders them as literal colons, not images. Trailing `✓`
   * checkmarks are also stripped (the `✅` emoji conveys the same meaning).
   *
   * The combined indicator + accumulated text is capped at 2 000 characters.
   * This path bypasses the rate-limit timer so activity indicators appear
   * promptly rather than waiting for the next cadence window.
   *
   * @param tasks - Current task list from `StreamingBridge`.
   */
  async appendTasks(tasks: StreamTask[]): Promise<void> {
    // In fallback mode, skip indicator updates entirely — no edits are made
    // during the stream.  The complete response will be posted at finish() time.
    if (this._inFallbackMode) return;
    if (tasks.length === 0) return;

    const taskLines = tasks
      .map((t) => renderTaskLine(t))
      .filter((line): line is string => line !== null);

    if (taskLines.length === 0) return;

    // Wait for any currently-running timer-based flush to complete before
    // issuing this direct edit.  Without this await, a floating flushEdit()
    // promise (started when delay ≤ 0 in scheduleFlush) and this appendTasks
    // edit could both call currentMessage.edit() concurrently, causing one to
    // silently overwrite the other.
    if (this.flushTask !== undefined) {
      await this.flushTask;
    }
    // Cancel any pending-but-not-yet-running timer flush.  After appendTasks
    // edits the message (with the latest accumulatedText as context), the
    // timer's edit would overwrite the task-indicator prefix with plain text.
    // Subsequent append() calls will reschedule a fresh flush as needed.
    if (this.pendingFlush !== undefined) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }

    // Re-check fallback mode: a concurrent flush may have entered it while
    // we were awaiting flushTask above.
    if (this._inFallbackMode) return;

    const indicator = taskLines.join("\n") + "\n\n";
    const displayText = (indicator + this.accumulatedText).slice(0, DISCORD_MESSAGE_LIMIT);

    try {
      await this.currentMessage.edit({ content: displayText });
      this.lastEditTime = Date.now();
      this._isRateLimited = false;
    } catch (err) {
      if (DiscordRateLimitTracker.isRateLimitError(err)) {
        this._handleRateLimitError(err);
      }
      console.warn("[discord] appendTasks edit failed:", err);
    }
  }

  /**
   * Finalize the stream, flushing all remaining buffered content to Discord.
   *
   * Cancels any pending rate-limit timer, then synchronously drains the
   * accumulation buffer by editing the current message. When content exceeds
   * 2 000 characters, posts new follow-up messages until the buffer is empty.
   *
   * If the buffer is empty after appending `finalText`, posts `"(no response)"`
   * so the placeholder is never left showing `"⏳ Thinking…"` after the agent
   * has finished.
   *
   * @param finalText  - Optional final text to append before flushing.
   * @param _finalTasks - Final task state. Accepted for interface compatibility;
   *   Discord does not have a native plan-mode render like Slack's `stopStream`,
   *   so tasks are not rendered in the final flush.
   */
  async finish(finalText?: string, _finalTasks?: StreamTask[]): Promise<void> {
    // Cancel any pending deferred flush — we are flushing everything right now.
    if (this.pendingFlush !== undefined) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }

    // Wait for any currently-running timer-based flush to complete before we
    // drain the buffer.  Without this, a floating flushEdit() started by an
    // immediate scheduleFlush (delay ≤ 0) could race with finish()'s own
    // edit() call and overwrite the final content.
    if (this.flushTask !== undefined) {
      await this.flushTask;
    }

    if (finalText) {
      this.accumulatedText += finalText;
    }

    const bufferText = this.accumulatedText;

    if (this._inFallbackMode) {
      // ── Fallback mode ────────────────────────────────────────────────────
      // No streaming edits were made during the stream; the initial placeholder
      // message is left unchanged.  Post the full accumulated content as one or
      // more new messages via channel.send() so the placeholder is never the
      // last thing the user sees.
      if (!bufferText) {
        await this.channel.send({ content: "(no response)" });
        return;
      }

      let remaining = bufferText;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
        remaining = remaining.slice(DISCORD_MESSAGE_LIMIT);
        await this.channel.send({ content: chunk });
      }
      return;
    }

    // ── Normal mode ──────────────────────────────────────────────────────────
    // Drain the buffer: write 2 K chunks, posting overflow messages as needed.
    if (!bufferText) {
      await this.currentMessage.edit({ content: "(no response)" });
      return;
    }

    let remaining = bufferText;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
      remaining = remaining.slice(DISCORD_MESSAGE_LIMIT);

      await this.currentMessage.edit({ content: chunk });

      if (remaining.length > 0) {
        // Post a new follow-up message and target it for subsequent edits.
        this.currentMessage = await this.channel.send({ content: THINKING_PLACEHOLDER });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal — rate limiting and overflow
  // -------------------------------------------------------------------------

  /**
   * Perform a rate-limited edit of the current Discord message with the
   * latest accumulated content. Handles 2 K overflow inline.
   *
   * On overflow: edits the current message with the first 2 K characters,
   * then posts the remainder as a new follow-up message that becomes the
   * new `currentMessage` edit target.
   */
  private async flushEdit(): Promise<void> {
    // Clear the timer handle — we are executing the flush now.
    if (this.pendingFlush !== undefined) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }
    this.lastEditTime = Date.now();

    const textToDisplay = this.accumulatedText || THINKING_PLACEHOLDER;

    if (textToDisplay.length <= DISCORD_MESSAGE_LIMIT) {
      // Happy path: content fits in a single message — just edit in-place.
      try {
        await this.currentMessage.edit({ content: textToDisplay });
        this._isRateLimited = false;
      } catch (err) {
        if (DiscordRateLimitTracker.isRateLimitError(err)) {
          this._handleRateLimitError(err);
        }
        throw err;
      }
    } else {
      // Overflow path: finalize the current message at the 2 K limit, then
      // post the overflow as a new message that becomes the edit target.
      const part1 = textToDisplay.slice(0, DISCORD_MESSAGE_LIMIT);
      const overflow = textToDisplay.slice(DISCORD_MESSAGE_LIMIT);

      try {
        await this.currentMessage.edit({ content: part1 });
        this._isRateLimited = false;
      } catch (err) {
        if (DiscordRateLimitTracker.isRateLimitError(err)) {
          this._handleRateLimitError(err);
        }
        throw err;
      }

      // Post the first 2 K of the overflow as the new message's initial content.
      // Store the FULL overflow in accumulatedText (not truncated) so that
      // content beyond 4 K is never silently discarded.
      const overflowDisplay = overflow.slice(0, DISCORD_MESSAGE_LIMIT);
      this.currentMessage = await this.channel.send({ content: overflowDisplay });
      // Store the full overflow so subsequent appends (and the next flush) build
      // on all remaining content, not just the first 2 K that was displayed.
      this.accumulatedText = overflow;
      this.lastEditTime = Date.now();

      // When the overflow itself exceeds 2 K there is additional content to
      // display (chars beyond 4 K in the original buffer). Schedule another
      // flush so the remaining text is drained progressively — without waiting
      // for the next append() call — preserving all content > 4 K.
      if (overflow.length > DISCORD_MESSAGE_LIMIT) {
        this.scheduleFlush();
      }
    }
  }

  /**
   * Schedule a `flushEdit()` call, respecting the `STREAM_EDIT_INTERVAL_MS`
   * minimum cadence between edits.
   *
   * - If enough time has elapsed since the last edit, flushes immediately.
   * - Otherwise, sets a deferred timer for the remaining wait duration.
   * - If a timer is already pending, does nothing: the pending flush will
   *   pick up all text that has been appended since it was scheduled.
   */
  private scheduleFlush(): void {
    if (this.pendingFlush !== undefined) {
      // A flush is already scheduled — it will incorporate the latest text.
      return;
    }

    const elapsed = Date.now() - this.lastEditTime;
    let delay = STREAM_EDIT_INTERVAL_MS - elapsed;

    // If the channel is under an active rate-limit cooldown, extend the delay
    // to respect the remaining cooldown window so we don't hammer Discord
    // while the limit is still active.
    if (this.channelId && this.rateLimitTracker?.isRateLimited(this.channelId)) {
      const cooldown = this.rateLimitTracker.getRemainingCooldown(this.channelId);
      delay = Math.max(delay, cooldown);
    }

    // Run the flush and track it in `this.flushTask` so that appendTasks()
    // and finish() can await it before issuing their own edit() calls.
    const runFlush = () => {
      this.pendingFlush = undefined;
      this.flushTask = this.flushEdit()
        .catch((err) => {
          console.error("[discord] stream flush failed:", err);
        })
        .finally(() => {
          this.flushTask = undefined;
        });
    };

    if (delay <= 0) {
      // Enough time has passed — flush immediately.
      runFlush();
    } else {
      // Still within the rate-limit window — defer.
      this.pendingFlush = setTimeout(runFlush, delay);
    }
  }

  /**
   * Handle a confirmed 429 rate-limit error:
   * - Set `this._isRateLimited = true` so callers can inspect the state.
   * - Switch to fallback mode (`_inFallbackMode = true`) so that all future
   *   `append()` calls are silently buffered and no further Discord edits are
   *   attempted until `finish()` drains the buffer via `channel.send()`.
   * - Cancel any pending deferred flush timer so we don't attempt another edit
   *   while still in the rate-limit window.
   * - Record the hit in the shared `rateLimitTracker` (if provided) so
   *   `DiscordAdapter.isChannelRateLimited()` reflects the current state.
   */
  private _handleRateLimitError(err: unknown): void {
    this._isRateLimited = true;
    this._inFallbackMode = true;
    // Cancel any scheduled flush — we will not attempt further streaming edits.
    if (this.pendingFlush !== undefined) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }
    if (this.channelId && this.rateLimitTracker) {
      const retryAfterMs = DiscordRateLimitTracker.extractRetryAfter(err);
      this.rateLimitTracker.recordHit(this.channelId, retryAfterMs);
    }
  }
}
