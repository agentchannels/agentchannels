/**
 * DiscordStreamer — High-level streaming session factory for Discord.
 *
 * Encapsulates the full lifecycle of starting an edit-in-place streaming
 * response on a Discord channel:
 *
 * 1. Posts the initial "⏳ Thinking…" placeholder message.
 * 2. Creates a `DiscordStreamHandle` for incremental edit-in-place updates.
 * 3. Wraps all `StreamHandle` operations in a serialised `enqueue` chain,
 *    matching the Slack adapter's concurrency-safety pattern.
 *
 * ## Usage
 *
 * ```ts
 * const channel = await client.channels.fetch(threadId) as TextChannel;
 * const streamer = new DiscordStreamer(channel, threadId, rateLimitTracker);
 * const handle = await streamer.start();
 *
 * await handle.append("Hello ");
 * await handle.appendTasks([{ id: "init", text: "Thinking…", status: "in_progress" }]);
 * await handle.finish("Hello world!");
 * ```
 *
 * ## Concurrency safety
 *
 * All three `StreamHandle` methods (`append`, `appendTasks`, `finish`) are
 * serialised onto a single promise chain via the `enqueue` helper. This
 * prevents concurrent Discord API calls against the same message — without
 * serialisation a `text_delta` event and a simultaneous `tool_use` event
 * could both invoke `message.edit()` in parallel, causing one update to
 * silently overwrite the other.
 *
 * `DiscordStreamHandle` also maintains its own internal `flushTask` guard so
 * that timer-driven background flushes and direct `appendTasks` / `finish`
 * calls cannot race each other — this provides a second layer of protection.
 */

import type { StreamHandle, StreamTask } from "../../core/channel-adapter.js";
import {
  DiscordStreamHandle,
  type DiscordSendableChannel,
} from "./stream-handle.js";
import { DiscordRateLimitTracker } from "./rate-limit.js";
import { THINKING_PLACEHOLDER } from "./constants.js";

// ---------------------------------------------------------------------------
// DiscordStreamer
// ---------------------------------------------------------------------------

/**
 * Factory that starts an edit-in-place streaming response on a Discord channel.
 *
 * Separating this from `DiscordAdapter` makes the streaming lifecycle
 * independently testable without wiring the full Discord bot client.
 *
 * The pattern mirrors the Slack adapter's `startStream()` method:
 * - Slack: `chat.startStream()` → returns serialised `StreamHandle`
 * - Discord: `channel.send(placeholder)` → `DiscordStreamHandle` → returns serialised `StreamHandle`
 *
 * ### Task indicators
 *
 * The returned `StreamHandle.appendTasks()` method renders active agent
 * activity as Discord-native Unicode emoji prefix lines on the current message:
 *
 * | Task type      | Status      | Rendered as         |
 * |----------------|-------------|---------------------|
 * | thinking/init  | in_progress | `💡 text`           |
 * | tool_*         | in_progress | `🔧 text`           |
 * | tool_*         | complete    | `✅ text`           |
 * | generic        | in_progress | `⚙️ text`           |
 * | generic        | pending     | `🔄 text`           |
 *
 * Slack-style `:emoji_code:` patterns in task text are stripped before display
 * since Discord renders them as literal colons.
 */
export class DiscordStreamer {
  /**
   * @param channel           - The Discord channel/thread to stream into.
   *   Must support both `send()` (for the placeholder and overflow messages)
   *   and the returned messages must support `edit()`.
   * @param channelId         - The Discord channel/thread ID (for per-channel
   *   rate-limit tracking). Must match the ID of `channel`.
   * @param rateLimitTracker  - Shared rate-limit tracker from the owning adapter.
   *   Used to pre-check for active cooldowns and record 429 hits.
   */
  constructor(
    private readonly channel: DiscordSendableChannel,
    private readonly channelId: string,
    private readonly rateLimitTracker: DiscordRateLimitTracker,
  ) {}

  /**
   * Start a new streaming session.
   *
   * Posts the initial `⏳ Thinking…` placeholder message to the channel,
   * then returns a `StreamHandle` that progressively edits it in-place
   * at a ~1 s cadence.
   *
   * All `StreamHandle` operations are serialised onto a single promise chain
   * to prevent concurrent Discord API calls against the same message.
   *
   * If the channel is already under an active rate-limit cooldown when `start()`
   * is called, the returned handle enters fallback mode immediately — all text
   * is buffered silently and posted via `channel.send()` when `finish()` is
   * called, leaving the placeholder unchanged.
   *
   * @returns A `StreamHandle` ready to receive `append`, `appendTasks`, and
   *   `finish` calls from `StreamingBridge`.
   */
  async start(): Promise<StreamHandle> {
    const initialMessage = await this.channel.send({
      content: THINKING_PLACEHOLDER,
    });

    const handle = new DiscordStreamHandle(
      initialMessage,
      this.channel,
      this.channelId,
      this.rateLimitTracker,
    );

    // Serialise all operations onto a single promise chain.
    // This mirrors the Slack adapter's `enqueue` pattern: concurrent
    // append / appendTasks / finish calls are prevented from racing.
    //
    // Without serialisation:
    //   - A `text_delta` event and a simultaneous `tool_use` event could both
    //     trigger `message.edit()` concurrently, silently overwriting each other.
    //   - A `finish()` issued while a background timer flush is running could
    //     write stale content over the final edit.
    let chain: Promise<void> = Promise.resolve();

    const enqueue = <T>(label: string, op: () => Promise<T>): Promise<T> => {
      const next = chain.then(
        () => op(),
        () => op(),
      );
      chain = next.then(
        () => undefined,
        (err) => {
          console.error(`[discord] stream op "${label}" failed:`, err);
        },
      );
      return next;
    };

    return {
      append: (delta: string) =>
        enqueue("append", () => handle.append(delta)),
      appendTasks: (tasks: StreamTask[]) =>
        enqueue("appendTasks", () => handle.appendTasks(tasks)),
      finish: (finalText?: string, finalTasks?: StreamTask[]) =>
        enqueue("finish", () => handle.finish(finalText, finalTasks)),
    };
  }
}
