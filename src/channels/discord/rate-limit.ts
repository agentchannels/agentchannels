/**
 * DiscordRateLimitTracker — per-channel 429 rate-limit state tracking.
 *
 * Discord enforces per-channel edit rate limits (~5 edits/5 s).  When a
 * `channel.edit()` or `channel.send()` call throws an HTTP 429 error this
 * tracker records the hit so that:
 *
 * - `DiscordStreamHandle.flushEdit()` can extend its back-off delay instead
 *   of immediately scheduling the next flush.
 * - `DiscordAdapter` can expose `isChannelRateLimited()` so upstream code
 *   (e.g., tests, monitoring, future retry logic) can inspect the state.
 *
 * ## Thread-safety note
 * Node.js is single-threaded; no locking is required.  All methods are
 * synchronous (no async/await needed for simple Map operations).
 */

import { RATE_LIMIT_DEFAULT_COOLDOWN_MS } from "./constants.js";

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  /** Timestamp (ms since epoch) when the 429 hit was recorded. */
  detectedAt: number;
  /** Duration (ms) before the rate limit expires. */
  retryAfterMs: number;
}

// ---------------------------------------------------------------------------
// DiscordRateLimitTracker
// ---------------------------------------------------------------------------

export class DiscordRateLimitTracker {
  private readonly limits = new Map<string, RateLimitEntry>();

  // -------------------------------------------------------------------------
  // Instance methods
  // -------------------------------------------------------------------------

  /**
   * Record a 429 rate-limit hit for a channel.
   *
   * @param channelId    - The Discord channel (or thread) ID that was limited.
   * @param retryAfterMs - How long (ms) to wait before retrying. Defaults to
   *   `RATE_LIMIT_DEFAULT_COOLDOWN_MS` (5 000 ms) when the Discord response
   *   does not include a `retry_after` value.
   */
  recordHit(channelId: string, retryAfterMs = RATE_LIMIT_DEFAULT_COOLDOWN_MS): void {
    this.limits.set(channelId, {
      detectedAt: Date.now(),
      retryAfterMs,
    });
  }

  /**
   * Return `true` if the channel is currently under a rate-limit cooldown.
   *
   * The cooldown expires once `Date.now() >= detectedAt + retryAfterMs`.
   * Automatically clears stale entries from the map on access.
   */
  isRateLimited(channelId: string): boolean {
    const entry = this.limits.get(channelId);
    if (!entry) return false;

    const expired = Date.now() >= entry.detectedAt + entry.retryAfterMs;
    if (expired) {
      this.limits.delete(channelId);
      return false;
    }

    return true;
  }

  /**
   * Return the remaining cooldown duration (ms) for a channel, or `0` if
   * the channel is not currently rate-limited.
   */
  getRemainingCooldown(channelId: string): number {
    const entry = this.limits.get(channelId);
    if (!entry) return 0;

    const remaining = entry.detectedAt + entry.retryAfterMs - Date.now();
    if (remaining <= 0) {
      this.limits.delete(channelId);
      return 0;
    }

    return remaining;
  }

  /**
   * Manually clear the rate-limit state for a channel.
   *
   * Useful in tests or when an adaptive retry policy determines the limit has
   * lifted before the recorded `retryAfterMs` expires.
   */
  clear(channelId: string): void {
    this.limits.delete(channelId);
  }

  /**
   * Return the number of channels currently tracked as rate-limited.
   * Primarily useful for metrics and test assertions.
   */
  get rateLimitedCount(): number {
    // Trigger expiry cleanup on each access.
    for (const [id] of this.limits) {
      this.isRateLimited(id); // clears expired entries as a side effect
    }
    return this.limits.size;
  }

  // -------------------------------------------------------------------------
  // Static helpers — error classification
  // -------------------------------------------------------------------------

  /**
   * Return `true` when an error value represents a Discord HTTP 429
   * rate-limit response.
   *
   * Handles:
   * - `discord.js` `DiscordAPIError` objects with `status === 429`
   * - Plain `Error` objects whose message contains "429" or "rate limit"
   * - Generic objects with a `status` or `code` property of `429`
   */
  static isRateLimitError(error: unknown): boolean {
    if (error == null) return false;

    if (typeof error === "object") {
      const e = error as Record<string, unknown>;
      // discord.js DiscordAPIError / HTTPError surface the HTTP status here.
      if (e["status"] === 429 || e["code"] === 429) return true;
      // Some wrappers nest the status under `httpStatus`.
      if (e["httpStatus"] === 429) return true;
    }

    if (error instanceof Error) {
      // Catch plain error messages like "HTTP 429: You are being rate limited."
      if (/\b429\b/.test(error.message)) return true;
      if (/rate.?limit/i.test(error.message)) return true;
    }

    return false;
  }

  /**
   * Extract the `retry_after` duration (ms) from a Discord 429 error.
   *
   * Discord returns `retry_after` in **seconds** as a float in its JSON
   * body.  `discord.js` exposes it on `DiscordAPIError` as `retryAfter`
   * (seconds, numeric).
   *
   * Falls back to `RATE_LIMIT_DEFAULT_COOLDOWN_MS` when no value is found.
   */
  static extractRetryAfter(error: unknown): number {
    if (error != null && typeof error === "object") {
      const e = error as Record<string, unknown>;

      // discord.js DiscordAPIError — retryAfter is in seconds (float).
      if (typeof e["retryAfter"] === "number") {
        return Math.ceil(e["retryAfter"] * 1000);
      }

      // Older discord.js or custom wrappers may expose retry_after (seconds).
      if (typeof e["retry_after"] === "number") {
        return Math.ceil(e["retry_after"] * 1000);
      }

      // Some implementations provide it already in milliseconds.
      if (typeof e["retryAfterMs"] === "number") {
        return e["retryAfterMs"] as number;
      }
    }

    return RATE_LIMIT_DEFAULT_COOLDOWN_MS;
  }
}
