import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenBucketRateLimiter } from "../../../src/channels/slack/rate-limiter.js";

describe("TokenBucketRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Constructor defaults ---

  describe("constructor defaults", () => {
    it("starts with maxTokens available", () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 3 });
      expect(limiter.availableTokens).toBe(3);
      limiter.dispose();
    });

    it("defaults to maxTokens=1, refillRate=1", async () => {
      const limiter = new TokenBucketRateLimiter();
      expect(limiter.availableTokens).toBe(1);

      // First acquire should be instant
      await limiter.acquire();
      expect(limiter.availableTokens).toBe(0);

      limiter.dispose();
    });
  });

  // --- Immediate acquire ---

  describe("immediate acquire", () => {
    it("resolves immediately when tokens are available", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 2, refillRate: 1 });

      const start = Date.now();
      await limiter.acquire();
      expect(Date.now() - start).toBe(0);

      await limiter.acquire();
      expect(Date.now() - start).toBe(0);

      expect(limiter.availableTokens).toBe(0);
      limiter.dispose();
    });

    it("consumes one token per acquire", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 3, refillRate: 1 });

      await limiter.acquire();
      expect(limiter.availableTokens).toBe(2);

      await limiter.acquire();
      expect(limiter.availableTokens).toBe(1);

      await limiter.acquire();
      expect(limiter.availableTokens).toBe(0);

      limiter.dispose();
    });
  });

  // --- Waiting for tokens ---

  describe("waiting for tokens", () => {
    it("waits when no tokens are available", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });

      await limiter.acquire(); // consumes the one token

      let resolved = false;
      const acquirePromise = limiter.acquire().then(() => {
        resolved = true;
      });

      // Should not resolve immediately
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Advance time by 1 second (1 token at 1/sec)
      vi.advanceTimersByTime(1000);
      await acquirePromise;
      expect(resolved).toBe(true);

      limiter.dispose();
    });

    it("queues multiple waiters in FIFO order", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });

      await limiter.acquire(); // consume initial token

      const order: number[] = [];
      const p1 = limiter.acquire().then(() => order.push(1));
      const p2 = limiter.acquire().then(() => order.push(2));

      expect(limiter.pendingCount).toBe(2);

      // After 1 second, first waiter gets a token
      vi.advanceTimersByTime(1000);
      await p1;
      expect(order).toEqual([1]);

      // After another second, second waiter gets a token
      vi.advanceTimersByTime(1000);
      await p2;
      expect(order).toEqual([1, 2]);

      limiter.dispose();
    });

    it("respects custom refill rate", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 2 });

      await limiter.acquire(); // consume initial token

      let resolved = false;
      const p = limiter.acquire().then(() => {
        resolved = true;
      });

      // At 2 tokens/sec, should refill in 500ms
      vi.advanceTimersByTime(499);
      await Promise.resolve();
      expect(resolved).toBe(false);

      vi.advanceTimersByTime(1);
      await p;
      expect(resolved).toBe(true);

      limiter.dispose();
    });
  });

  // --- Token refill ---

  describe("token refill", () => {
    it("refills tokens over time", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 3, refillRate: 1 });

      // Drain all tokens
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();
      expect(limiter.availableTokens).toBe(0);

      // After 2 seconds, should have 2 tokens
      vi.advanceTimersByTime(2000);
      expect(limiter.availableTokens).toBe(2);

      limiter.dispose();
    });

    it("does not exceed maxTokens", () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 2, refillRate: 10 });

      // Wait a long time — tokens should cap at maxTokens
      vi.advanceTimersByTime(10_000);
      expect(limiter.availableTokens).toBe(2);

      limiter.dispose();
    });
  });

  // --- Dispose ---

  describe("dispose", () => {
    it("resolves all pending waiters on dispose", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });

      await limiter.acquire();

      let r1 = false;
      let r2 = false;
      const p1 = limiter.acquire().then(() => { r1 = true; });
      const p2 = limiter.acquire().then(() => { r2 = true; });

      limiter.dispose();
      await p1;
      await p2;

      expect(r1).toBe(true);
      expect(r2).toBe(true);
    });

    it("acquire resolves immediately after dispose", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });

      await limiter.acquire();
      limiter.dispose();

      // Should resolve immediately even with no tokens
      await limiter.acquire();
    });

    it("clears pending count on dispose", async () => {
      const limiter = new TokenBucketRateLimiter({ maxTokens: 1, refillRate: 1 });
      await limiter.acquire();

      limiter.acquire(); // queued
      limiter.acquire(); // queued
      expect(limiter.pendingCount).toBe(2);

      limiter.dispose();
      expect(limiter.pendingCount).toBe(0);
    });
  });
});
