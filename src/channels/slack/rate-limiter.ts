/**
 * Token-bucket rate limiter for Slack API calls.
 *
 * Slack's Web API enforces per-method rate limits (typically ~1 req/sec for
 * chat.postMessage in a single channel). This limiter uses the token-bucket
 * algorithm to smooth out bursts while sustaining the maximum allowed throughput.
 *
 * ## Algorithm
 *
 * - A bucket holds up to `maxTokens` tokens.
 * - Tokens refill at `refillRate` tokens per second.
 * - Each API call consumes one token.
 * - If no tokens are available, the caller waits until one refills.
 *
 * ## Usage
 *
 * ```ts
 * const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
 * await limiter.acquire(); // waits if needed
 * await slackClient.chat.postMessage(...);
 * ```
 */

export interface TokenBucketOptions {
  /**
   * Maximum number of tokens the bucket can hold.
   * This is also the initial number of tokens (burst capacity).
   * @default 1
   */
  maxTokens?: number;

  /**
   * Number of tokens added per second.
   * For Slack's chat.postMessage, ~1/sec is safe per channel.
   * @default 1
   */
  refillRate?: number;
}

const DEFAULT_MAX_TOKENS = 1;
const DEFAULT_REFILL_RATE = 1;

/**
 * Token-bucket rate limiter.
 *
 * Callers use `acquire()` to obtain permission to make an API call.
 * If the bucket is empty, `acquire()` returns a promise that resolves
 * once a token becomes available.
 */
export class TokenBucketRateLimiter {
  private readonly maxTokens: number;
  private readonly refillRate: number;

  /** Current number of available tokens (can be fractional during refill) */
  private tokens: number;
  /** Timestamp of the last token refill calculation */
  private lastRefillTime: number;
  /** Queue of waiters blocked on token availability */
  private waitQueue: Array<() => void> = [];
  /** Timer for draining the wait queue as tokens refill */
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
   * If a token is immediately available, resolves right away.
   * Otherwise, queues the caller and resolves once a token refills.
   *
   * @returns Promise that resolves when a token has been acquired
   */
  async acquire(): Promise<void> {
    if (this.disposed) return;

    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // No tokens available — wait for one to refill
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      this.scheduleDrain();
    });
  }

  /**
   * Returns the current number of available tokens (floored to integer).
   */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Returns the number of callers waiting for a token.
   */
  get pendingCount(): number {
    return this.waitQueue.length;
  }

  /**
   * Dispose the limiter, resolving all pending waiters immediately.
   * After disposal, `acquire()` resolves instantly without rate limiting.
   */
  dispose(): void {
    this.disposed = true;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    // Release all waiters
    for (const resolve of this.waitQueue) {
      resolve();
    }
    this.waitQueue = [];
  }

  // --- Internal helpers ---

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000; // seconds
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }

  /**
   * Schedule a timer to drain the wait queue as tokens become available.
   */
  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    if (this.waitQueue.length === 0) return;

    // Calculate wait time until next token is available
    const deficit = 1 - this.tokens;
    const waitMs = Math.max(0, Math.ceil((deficit / this.refillRate) * 1000));

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.refill();

      // Drain as many waiters as we have tokens for
      while (this.waitQueue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const resolve = this.waitQueue.shift()!;
        resolve();
      }

      // If more waiters remain, schedule another drain
      if (this.waitQueue.length > 0) {
        this.scheduleDrain();
      }
    }, waitMs);
  }
}
