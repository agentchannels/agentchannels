/**
 * Discord rate-limit utilities — token-bucket limiter and fallback batcher.
 *
 * Two complementary classes for handling Discord's per-channel rate limits:
 *
 * ## TokenBucketRateLimiter
 *
 * Token-bucket algorithm that gates API calls to Discord's safe cadence.
 * Discord's edit rate is ~5 edits per 5 seconds per channel; a 1 token/second
 * refill rate gives comfortable headroom.  Mirrors the Slack adapter's
 * `TokenBucketRateLimiter` with Discord-appropriate defaults.
 *
 * ## DiscordMessageBatcher
 *
 * Fallback batcher activated when edit-in-place streaming hits a 429 response.
 * Instead of editing an existing message, this class:
 *
 * 1. Accumulates streaming text deltas via `add()`.
 * 2. Flushes batches at a configurable interval (default: `STREAM_EDIT_INTERVAL_MS`).
 * 3. Rate-limits each `channel.send()` via `TokenBucketRateLimiter`.
 * 4. Splits long batches at `DISCORD_MESSAGE_LIMIT` (2 000 chars) before sending.
 *
 * This mirrors `SlackPoster` (`src/channels/slack/slack-poster.ts`) adapted for
 * Discord's `channel.send()` API and 2 K character limit.
 *
 * ## Usage
 *
 * ```ts
 * const batcher = new DiscordMessageBatcher({ channel });
 *
 * // In the fallback path, feed streaming deltas:
 * batcher.add("Hello ");
 * batcher.add("world!");
 *
 * // On stream completion, flush remaining content:
 * await batcher.dispose();
 * ```
 */

import { MessageBatcher } from "../../core/message-batcher.js";
import type { DiscordSendableChannel } from "./stream-handle.js";
import { DISCORD_MESSAGE_LIMIT, STREAM_EDIT_INTERVAL_MS } from "./constants.js";

// ---------------------------------------------------------------------------
// TokenBucketRateLimiter
// ---------------------------------------------------------------------------

export interface TokenBucketOptions {
  /**
   * Maximum number of tokens the bucket can hold (burst capacity).
   * Also the initial fill level.
   *
   * Discord's safe edit cadence is ~1 edit/second per channel.
   * @default 1
   */
  maxTokens?: number;

  /**
   * Tokens added per second.
   * Set to `1` to match Discord's ~1 edit/second channel limit.
   * @default 1
   */
  refillRate?: number;
}

const DEFAULT_MAX_TOKENS = 1;
const DEFAULT_REFILL_RATE = 1;

/**
 * Token-bucket rate limiter for Discord API calls.
 *
 * Discord enforces per-channel edit rate limits (~5 edits/5 s).  This limiter
 * uses the token-bucket algorithm to smooth bursts while sustaining the maximum
 * allowed throughput.
 *
 * ## Algorithm
 *
 * - A bucket holds up to `maxTokens` tokens (also the initial fill level).
 * - Tokens refill at `refillRate` per second.
 * - Each API call consumes one token.
 * - If no token is available, the caller waits until one refills.
 *
 * ## Usage
 *
 * ```ts
 * const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
 * await limiter.acquire();
 * await channel.send({ content: "..." });
 * ```
 */
export class TokenBucketRateLimiter {
  private readonly maxTokens: number;
  private readonly refillRate: number;

  /** Current token count (fractional during refill) */
  private tokens: number;
  /** Timestamp of the last refill calculation */
  private lastRefillTime: number;
  /** Waiters blocked on token availability */
  private waitQueue: Array<() => void> = [];
  /** Drain timer handle */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the limiter has been disposed */
  private disposed = false;

  constructor(options: TokenBucketOptions = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.refillRate = options.refillRate ?? DEFAULT_REFILL_RATE;
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
  }

  /**
   * Acquire a token from the bucket.
   *
   * Resolves immediately when a token is available; otherwise queues the
   * caller and resolves once a token refills.
   *
   * After `dispose()` is called, `acquire()` resolves instantly without
   * rate limiting.
   */
  async acquire(): Promise<void> {
    if (this.disposed) return;

    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      this.scheduleDrain();
    });
  }

  /**
   * Current available tokens (floored to integer).
   */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Number of callers waiting for a token.
   */
  get pendingCount(): number {
    return this.waitQueue.length;
  }

  /**
   * Dispose the limiter, releasing all pending waiters immediately.
   * After disposal `acquire()` resolves instantly.
   */
  dispose(): void {
    this.disposed = true;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const resolve of this.waitQueue) {
      resolve();
    }
    this.waitQueue = [];
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000; // seconds
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    if (this.waitQueue.length === 0) return;

    const deficit = 1 - this.tokens;
    const waitMs = Math.max(0, Math.ceil((deficit / this.refillRate) * 1000));

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.refill();

      while (this.waitQueue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const resolve = this.waitQueue.shift()!;
        resolve();
      }

      if (this.waitQueue.length > 0) {
        this.scheduleDrain();
      }
    }, waitMs);
  }
}

// ---------------------------------------------------------------------------
// DiscordMessageBatcher
// ---------------------------------------------------------------------------

export interface DiscordMessageBatcherOptions {
  /**
   * Discord channel (or thread) to send messages to.
   * Must implement `DiscordSendableChannel.send()`.
   */
  channel: DiscordSendableChannel;

  /**
   * Maximum time (ms) to wait before flushing accumulated text.
   * The timer starts on the first `add()` after each flush.
   *
   * @default STREAM_EDIT_INTERVAL_MS (1 000 ms)
   */
  flushIntervalMs?: number;

  /**
   * Maximum accumulated text length (chars) before triggering an immediate flush.
   * Discord's per-message limit is 2 000 characters.
   *
   * @default DISCORD_MESSAGE_LIMIT (2 000)
   */
  maxSize?: number;

  /**
   * Token bucket burst capacity.
   * @default 1
   */
  rateLimitMaxTokens?: number;

  /**
   * Token bucket refill rate (tokens/second).
   * @default 1
   */
  rateLimitRefillRate?: number;
}

/**
 * Discord fallback batcher for streaming text via `channel.send()`.
 *
 * Activated when edit-in-place streaming is unavailable (429 rate-limit hit).
 * Accumulates streaming text deltas and periodically posts them as new Discord
 * messages, splitting content at `DISCORD_MESSAGE_LIMIT` (2 000 characters)
 * and rate-limiting each post through a `TokenBucketRateLimiter`.
 *
 * Mirrors the `SlackPoster` pattern from `src/channels/slack/slack-poster.ts`
 * adapted for Discord's `channel.send()` API and 2 K character limit.
 *
 * ### Lifecycle
 *
 * ```
 * const batcher = new DiscordMessageBatcher({ channel });
 *
 * batcher.add("Hello ");
 * batcher.add("world!");
 *
 * await batcher.dispose(); // flushes remaining + cleans up rate limiter
 * ```
 *
 * ### Message splitting
 *
 * When a flushed batch exceeds `DISCORD_MESSAGE_LIMIT`, it is split into
 * ≤ 2 000-character chunks and each chunk is sent as a separate message.
 *
 * ### Rate limiting
 *
 * Each `channel.send()` call is gated by `TokenBucketRateLimiter.acquire()`.
 * With the default 1 token/second refill, sends are spaced ~1 s apart —
 * well within Discord's 5 edits/5 s per channel limit.
 */
export class DiscordMessageBatcher {
  private readonly channel: DiscordSendableChannel;
  private readonly batcher: MessageBatcher;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private _messageCount = 0;
  private _finished = false;

  constructor(options: DiscordMessageBatcherOptions) {
    this.channel = options.channel;

    this.rateLimiter = new TokenBucketRateLimiter({
      maxTokens: options.rateLimitMaxTokens ?? 1,
      refillRate: options.rateLimitRefillRate ?? 1,
    });

    this.batcher = new MessageBatcher({
      flushIntervalMs: options.flushIntervalMs ?? STREAM_EDIT_INTERVAL_MS,
      maxSize: options.maxSize ?? DISCORD_MESSAGE_LIMIT,
      onFlush: (text) => this.sendBatch(text),
    });
  }

  /**
   * Add a text delta to the batch.
   *
   * Text is accumulated by the internal `MessageBatcher` and sent to Discord
   * when the flush interval or size threshold is reached.
   * Calls after `dispose()` are silently ignored.
   *
   * @param text - Streaming text delta to accumulate.
   */
  add(text: string): void {
    if (this._finished) return;
    this.batcher.add(text);
  }

  /**
   * Immediately flush any remaining accumulated text.
   *
   * Safe to call even if there is nothing to flush.
   *
   * @returns Promise that resolves when the flush is complete.
   */
  async flush(): Promise<void> {
    await this.batcher.flush();
  }

  /**
   * Flush remaining text and release all internal resources.
   *
   * Must be called when the stream ends to prevent buffered text from being
   * silently dropped.  After `dispose()`, calls to `add()` are ignored.
   *
   * @returns Promise that resolves when all text has been sent.
   */
  async dispose(): Promise<void> {
    if (this._finished) return;
    this._finished = true;
    await this.batcher.dispose();
    this.rateLimiter.dispose();
  }

  /**
   * Number of Discord messages sent so far (including overflow splits).
   */
  get messageCount(): number {
    return this._messageCount;
  }

  /**
   * Whether `dispose()` has been called.
   */
  get isFinished(): boolean {
    return this._finished;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Send a flushed batch to Discord, splitting at `DISCORD_MESSAGE_LIMIT`
   * and rate-limiting each send via `TokenBucketRateLimiter`.
   *
   * Called by the internal `MessageBatcher.onFlush` callback.
   */
  private async sendBatch(text: string): Promise<void> {
    const chunks = DiscordMessageBatcher.splitMessage(text);

    for (const chunk of chunks) {
      await this.rateLimiter.acquire();
      await this.channel.send({ content: chunk });
      this._messageCount += 1;
    }
  }

  /**
   * Split `text` into chunks each ≤ `DISCORD_MESSAGE_LIMIT` characters.
   *
   * Attempts to split on newline characters for cleaner message boundaries.
   * Falls back to hard-splitting at the character limit when no suitable
   * newline is found in the window.
   *
   * @param text - Content to split.
   * @returns Array of chunks, each ≤ `DISCORD_MESSAGE_LIMIT` characters.
   */
  static splitMessage(text: string): string[] {
    if (text.length <= DISCORD_MESSAGE_LIMIT) {
      return text ? [text] : [];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MESSAGE_LIMIT) {
        chunks.push(remaining);
        break;
      }

      // Prefer splitting on a newline for cleaner message breaks.
      let splitIndex = remaining.lastIndexOf("\n", DISCORD_MESSAGE_LIMIT);

      if (splitIndex <= 0) {
        // No suitable newline — hard-split at the character limit.
        splitIndex = DISCORD_MESSAGE_LIMIT;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);

      // Skip the leading newline so it doesn't appear at the start of the next chunk.
      if (remaining.startsWith("\n")) {
        remaining = remaining.slice(1);
      }
    }

    return chunks;
  }
}
