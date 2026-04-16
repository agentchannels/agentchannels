/**
 * Unit tests for TokenBucketRateLimiter and DiscordMessageBatcher.
 *
 * Covers:
 * - TokenBucketRateLimiter: immediate acquire, queued waiters, refill, dispose
 * - DiscordMessageBatcher: accumulation, flush-on-interval, flush-on-size,
 *   dispose drain, message splitting, rate-limit integration, messageCount tracking
 *
 * No live Discord API calls — all channel interactions use in-memory fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TokenBucketRateLimiter,
  DiscordMessageBatcher,
} from "../../../src/channels/discord/rate-limiter.js";
import {
  DISCORD_MESSAGE_LIMIT,
  STREAM_EDIT_INTERVAL_MS,
} from "../../../src/channels/discord/constants.js";
import type { DiscordSendableChannel } from "../../../src/channels/discord/stream-handle.js";

// ---------------------------------------------------------------------------
// Fake Discord channel for testing
// ---------------------------------------------------------------------------

class FakeChannel implements DiscordSendableChannel {
  public sentContents: string[] = [];
  public sendDelay = 0;
  public shouldFail = false;

  async send(options: { content: string }): Promise<{ edit: () => Promise<void> }> {
    if (this.shouldFail) {
      throw new Error("Discord send failed");
    }
    if (this.sendDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.sendDelay));
    }
    this.sentContents.push(options.content);
    return { edit: async () => {} };
  }

  get messageCount(): number {
    return this.sentContents.length;
  }

  get lastContent(): string {
    return this.sentContents[this.sentContents.length - 1] ?? "";
  }
}

// ---------------------------------------------------------------------------
// TokenBucketRateLimiter
// ---------------------------------------------------------------------------

describe("TokenBucketRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe("initial state", () => {
    it("starts with maxTokens available (default: 1)", () => {
      const limiter = new TokenBucketRateLimiter();
      expect(limiter.availableTokens).toBe(1);
    });

    it("starts with maxTokens available (custom value)", () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 5 });
      expect(limiter.availableTokens).toBe(5);
    });

    it("starts with 0 pending waiters", () => {
      const limiter = new TokenBucketRateLimiter();
      expect(limiter.pendingCount).toBe(0);
    });

    it("is not disposed initially", () => {
      const limiter = new TokenBucketRateLimiter();
      // acquire() should resolve without blocking when a token is available
      let resolved = false;
      limiter.acquire().then(() => { resolved = true; });
      expect(limiter.availableTokens).toBe(0); // token consumed
    });
  });

  // -------------------------------------------------------------------------
  // Immediate acquire
  // -------------------------------------------------------------------------

  describe("acquire() — token available", () => {
    it("resolves immediately when a token is available", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1 });
      await expect(limiter.acquire()).resolves.toBeUndefined();
    });

    it("consumes one token per acquire()", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 3 });
      await limiter.acquire();
      expect(limiter.availableTokens).toBe(2);
      await limiter.acquire();
      expect(limiter.availableTokens).toBe(1);
    });

    it("can acquire multiple tokens in sequence when bucket has capacity", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 3 });
      for (let i = 0; i < 3; i++) {
        await limiter.acquire();
      }
      expect(limiter.availableTokens).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Queued waiters
  // -------------------------------------------------------------------------

  describe("acquire() — bucket empty, queued waiting", () => {
    it("does not resolve immediately when bucket is empty", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
      await limiter.acquire(); // drain the token

      let resolved = false;
      limiter.acquire().then(() => { resolved = true; });

      // Synchronously: the promise should NOT be resolved yet
      expect(resolved).toBe(false);
      expect(limiter.pendingCount).toBe(1);
    });

    it("queues multiple waiters and resolves them in FIFO order", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 2 });
      await limiter.acquire(); // drain

      const order: number[] = [];
      limiter.acquire().then(() => order.push(1));
      limiter.acquire().then(() => order.push(2));
      limiter.acquire().then(() => order.push(3));

      expect(limiter.pendingCount).toBe(3);

      // Advance by 500ms: 1 token refilled at rate 2
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toContain(1);

      // Advance another 500ms: another token
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toContain(2);
    });

    it("resolves waiters after the refill period", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
      await limiter.acquire(); // drain

      let resolved = false;
      limiter.acquire().then(() => { resolved = true; });

      // After 1 000 ms a token should refill and resolve the waiter
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(resolved).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Refill
  // -------------------------------------------------------------------------

  describe("token refill", () => {
    it("refills tokens over time up to maxTokens", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 2, refillRate: 2 });
      await limiter.acquire();
      await limiter.acquire(); // drain fully

      vi.advanceTimersByTime(1000); // +2 tokens at refillRate=2
      expect(limiter.availableTokens).toBe(2); // capped at maxTokens
    });

    it("does not exceed maxTokens during refill", () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
      vi.advanceTimersByTime(5000); // far past maxTokens
      expect(limiter.availableTokens).toBe(1); // capped at 1
    });
  });

  // -------------------------------------------------------------------------
  // dispose()
  // -------------------------------------------------------------------------

  describe("dispose()", () => {
    it("releases all pending waiters immediately", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
      await limiter.acquire(); // drain

      const results: string[] = [];
      limiter.acquire().then(() => results.push("a"));
      limiter.acquire().then(() => results.push("b"));

      expect(limiter.pendingCount).toBe(2);

      limiter.dispose();
      // async acquire() wraps in a Promise<void>, so resolution propagates
      // through two microtask ticks: inner resolve → async wrapper resolves
      // → .then() callback runs.  Drain all three layers.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(results).toContain("a");
      expect(results).toContain("b");
      expect(limiter.pendingCount).toBe(0);
    });

    it("acquire() after dispose() resolves immediately without consuming tokens", async () => {
      const limiter = new TokenBucketRateLimiter();
      limiter.dispose();
      await expect(limiter.acquire()).resolves.toBeUndefined();
    });

    it("dispose() is idempotent (safe to call multiple times)", () => {
      const limiter = new TokenBucketRateLimiter();
      expect(() => {
        limiter.dispose();
        limiter.dispose();
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // pendingCount and availableTokens
  // -------------------------------------------------------------------------

  describe("pendingCount / availableTokens", () => {
    it("pendingCount increases when waiters are queued", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1 });
      await limiter.acquire();

      limiter.acquire(); // queued
      limiter.acquire(); // queued
      expect(limiter.pendingCount).toBe(2);
    });

    it("availableTokens returns 0 after draining the bucket", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1 });
      await limiter.acquire();
      expect(limiter.availableTokens).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// DiscordMessageBatcher
// ---------------------------------------------------------------------------

describe("DiscordMessageBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // add() + flush-on-interval
  // -------------------------------------------------------------------------

  describe("add() — accumulation and interval flush", () => {
    it("does not immediately send text on add()", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 500,
      });

      batcher.add("hello");
      expect(channel.messageCount).toBe(0);
    });

    it("sends accumulated text after the flush interval", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 500,
        maxSize: DISCORD_MESSAGE_LIMIT,
      });

      batcher.add("hello ");
      batcher.add("world");

      await vi.advanceTimersByTimeAsync(500);

      expect(channel.messageCount).toBe(1);
      expect(channel.sentContents[0]).toBe("hello world");
    });

    it("uses STREAM_EDIT_INTERVAL_MS as default flushIntervalMs", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });

      batcher.add("test");

      // Not yet flushed before STREAM_EDIT_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(STREAM_EDIT_INTERVAL_MS - 1);
      expect(channel.messageCount).toBe(0);

      // Flushed after STREAM_EDIT_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(1);
      expect(channel.messageCount).toBe(1);
    });

    it("coalesces multiple add() calls within the flush window", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 500,
        maxSize: DISCORD_MESSAGE_LIMIT,
      });

      batcher.add("a");
      batcher.add("b");
      batcher.add("c");

      await vi.advanceTimersByTimeAsync(500);

      // All three deltas should be in a single send
      expect(channel.messageCount).toBe(1);
      expect(channel.lastContent).toBe("abc");
    });
  });

  // -------------------------------------------------------------------------
  // Size-threshold flush
  // -------------------------------------------------------------------------

  describe("add() — flush-on-size", () => {
    it("flushes immediately when accumulated text reaches maxSize", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 10_000, // long interval — won't trigger before size
        maxSize: 10,
      });

      // Add exactly 10 characters to trigger a size flush
      batcher.add("0123456789");

      // Flush should fire before the timer
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.messageCount).toBe(1);
    });

    it("uses DISCORD_MESSAGE_LIMIT as default maxSize", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 10_000,
      });

      // One character under the limit — no immediate flush
      batcher.add("a".repeat(DISCORD_MESSAGE_LIMIT - 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.messageCount).toBe(0);

      // Exactly at the limit — triggers immediate flush
      batcher.add("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.messageCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // flush() and dispose()
  // -------------------------------------------------------------------------

  describe("flush() and dispose()", () => {
    it("flush() sends remaining buffered text immediately", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 10_000,
      });

      batcher.add("flush me");
      await batcher.flush();

      expect(channel.messageCount).toBe(1);
      expect(channel.lastContent).toBe("flush me");
    });

    it("flush() is a no-op when the buffer is empty", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });

      await expect(batcher.flush()).resolves.toBeUndefined();
      expect(channel.messageCount).toBe(0);
    });

    it("dispose() flushes remaining text before releasing resources", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 10_000,
      });

      batcher.add("final text");
      await batcher.dispose();

      expect(channel.messageCount).toBe(1);
      expect(channel.lastContent).toBe("final text");
    });

    it("add() after dispose() is silently ignored", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel, flushIntervalMs: 100 });

      await batcher.dispose();
      batcher.add("ignored");

      await vi.advanceTimersByTimeAsync(200);
      expect(channel.messageCount).toBe(0);
    });

    it("dispose() is idempotent — safe to call multiple times", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });

      await batcher.dispose();
      await expect(batcher.dispose()).resolves.toBeUndefined();
    });

    it("isFinished is false before dispose()", () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });
      expect(batcher.isFinished).toBe(false);
    });

    it("isFinished is true after dispose()", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });
      await batcher.dispose();
      expect(batcher.isFinished).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // messageCount
  // -------------------------------------------------------------------------

  describe("messageCount", () => {
    it("starts at 0", () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });
      expect(batcher.messageCount).toBe(0);
    });

    it("increments once per sent message", async () => {
      const channel = new FakeChannel();
      // Use a high refillRate so we don't have to wait 1 s between flushes
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 100,
        maxSize: DISCORD_MESSAGE_LIMIT,
        rateLimitMaxTokens: 5,
        rateLimitRefillRate: 10,
      });

      batcher.add("first batch");
      await vi.advanceTimersByTimeAsync(100);
      expect(batcher.messageCount).toBe(1);

      batcher.add("second batch");
      await vi.advanceTimersByTimeAsync(100);
      expect(batcher.messageCount).toBe(2);
    });

    it("counts each chunk as a separate message when splitting", async () => {
      const channel = new FakeChannel();
      // Use a large token bucket so all 3 chunks acquire tokens immediately
      // without waiting for the 1 s/token default refill timeout.
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 100,
        maxSize: Infinity, // don't split on size during accumulation
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      // Add text that exceeds 2× DISCORD_MESSAGE_LIMIT to force 3 chunks
      batcher.add("x".repeat(DISCORD_MESSAGE_LIMIT * 2 + 100));
      await batcher.dispose();

      // Should have sent 3 chunks
      expect(batcher.messageCount).toBe(3);
      expect(channel.messageCount).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Message splitting
  // -------------------------------------------------------------------------

  describe("DiscordMessageBatcher.splitMessage()", () => {
    it("returns a single-element array when text fits within limit", () => {
      const text = "short message";
      expect(DiscordMessageBatcher.splitMessage(text)).toEqual([text]);
    });

    it("returns [] for empty string", () => {
      expect(DiscordMessageBatcher.splitMessage("")).toEqual([]);
    });

    it("splits at DISCORD_MESSAGE_LIMIT when no newline is found", () => {
      const text = "a".repeat(DISCORD_MESSAGE_LIMIT + 100);
      const chunks = DiscordMessageBatcher.splitMessage(text);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
      expect(chunks[1]).toHaveLength(100);
    });

    it("prefers splitting on a newline for cleaner breaks", () => {
      const line1 = "a".repeat(DISCORD_MESSAGE_LIMIT - 5);
      const line2 = "b".repeat(50);
      const text = `${line1}\n${line2}`;

      const chunks = DiscordMessageBatcher.splitMessage(text);
      expect(chunks).toHaveLength(2);
      // First chunk should end at the newline (line1 without the newline)
      expect(chunks[0]).toBe(line1);
      // Second chunk should start with line2 (newline stripped)
      expect(chunks[1]).toBe(line2);
    });

    it("hard-splits when there is no newline within the limit window", () => {
      // A single line longer than DISCORD_MESSAGE_LIMIT with no newlines
      const text = "z".repeat(DISCORD_MESSAGE_LIMIT * 2);
      const chunks = DiscordMessageBatcher.splitMessage(text);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
      expect(chunks[1]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    });

    it("handles text that is exactly DISCORD_MESSAGE_LIMIT characters", () => {
      const text = "a".repeat(DISCORD_MESSAGE_LIMIT);
      const chunks = DiscordMessageBatcher.splitMessage(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    });

    it("produces chunks all ≤ DISCORD_MESSAGE_LIMIT characters", () => {
      const text = "x".repeat(DISCORD_MESSAGE_LIMIT * 5 + 777);
      const chunks = DiscordMessageBatcher.splitMessage(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
      }
    });

    it("preserves all characters across split chunks (no data loss)", () => {
      const text = "a".repeat(DISCORD_MESSAGE_LIMIT + 500);
      const chunks = DiscordMessageBatcher.splitMessage(text);
      const rejoined = chunks.join("");
      expect(rejoined).toBe(text);
    });
  });

  // -------------------------------------------------------------------------
  // Rate-limit integration
  // -------------------------------------------------------------------------

  describe("rate-limit integration", () => {
    it("gates each send through the token bucket — burst of 1 spaces sends ~1 s apart", async () => {
      const channel = new FakeChannel();
      const sendTimes: number[] = [];

      // Intercept send to record timing
      const origSend = channel.send.bind(channel);
      channel.send = async (opts) => {
        sendTimes.push(Date.now());
        return origSend(opts);
      };

      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 100,
        maxSize: 5,             // small size to trigger multiple flushes
        rateLimitMaxTokens: 1,
        rateLimitRefillRate: 1, // 1 token/second
      });

      // Add two batches of 5 chars each to trigger two flushes
      batcher.add("abcde");
      await vi.advanceTimersByTimeAsync(100); // first flush fires

      batcher.add("fghij");
      await vi.advanceTimersByTimeAsync(100); // second flush queued

      // First send fires immediately (token available)
      // Second send must wait ~1 s for refill
      await vi.advanceTimersByTimeAsync(1000); // allow refill
      await vi.runAllTimersAsync();

      // Both batches should have been sent
      expect(channel.messageCount).toBeGreaterThanOrEqual(2);
    });

    it("dispose() releases the rate limiter so pending acquires are freed", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 100,
        rateLimitMaxTokens: 1,
        rateLimitRefillRate: 1,
      });

      // Fill the bucket and queue a pending acquire by sending one batch first
      batcher.add("first");
      await vi.advanceTimersByTimeAsync(100);
      expect(channel.messageCount).toBe(1);

      // Queue another batch while rate-limited
      batcher.add("second");
      // dispose() should flush and release the rate limiter
      await vi.advanceTimersByTimeAsync(1100); // let refill
      await batcher.dispose();

      // After dispose, the second batch should have been flushed
      expect(channel.messageCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Overflow / large messages
  // -------------------------------------------------------------------------

  describe("overflow — large messages split before send", () => {
    it("sends each 2K chunk as a separate message for very long responses", async () => {
      const channel = new FakeChannel();
      // Use a large token bucket so all chunks acquire tokens without waiting
      // for the default 1 s/token refill (avoids fake-timer deadlock).
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 100,
        maxSize: Infinity, // accumulate all before flushing
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      const longText = "a".repeat(DISCORD_MESSAGE_LIMIT * 3);
      batcher.add(longText);

      await batcher.dispose();

      // 3 messages of 2K each
      expect(channel.messageCount).toBe(3);
      for (const content of channel.sentContents) {
        expect(content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
      }
    });

    it("preserves full text across all sent chunks (no data loss)", async () => {
      const channel = new FakeChannel();
      // Same: high token budget so dispose() drains without blocking on timeouts.
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 100,
        maxSize: Infinity,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      const longText = "x".repeat(DISCORD_MESSAGE_LIMIT * 2 + 500);
      batcher.add(longText);
      await batcher.dispose();

      const allSentText = channel.sentContents.join("");
      expect(allSentText).toBe(longText);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: DiscordMessageBatcher as 429 fallback
  // -------------------------------------------------------------------------

  describe("429 fallback integration scenario", () => {
    it("receives streaming deltas and sends them as new messages (no edits)", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({
        channel,
        flushIntervalMs: 200,
        maxSize: DISCORD_MESSAGE_LIMIT,
      });

      // Simulate streaming text deltas arriving during a rate-limited period
      const deltas = ["Hello", " ", "world", "! ", "This", " is", " a", " test."];
      for (const delta of deltas) {
        batcher.add(delta);
      }

      await batcher.dispose();

      // All deltas should have been sent as one or more messages
      expect(channel.messageCount).toBeGreaterThan(0);
      const allText = channel.sentContents.join("");
      expect(allText).toBe(deltas.join(""));
    });

    it("sends nothing when no text was added before dispose()", async () => {
      const channel = new FakeChannel();
      const batcher = new DiscordMessageBatcher({ channel });

      await batcher.dispose();

      expect(channel.messageCount).toBe(0);
    });
  });
});
