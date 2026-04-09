import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageBatcher } from "../../src/core/message-batcher.js";

describe("MessageBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Construction & defaults ---

  describe("constructor defaults", () => {
    it("uses default flushIntervalMs of 300", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush });

      batcher.add("hello");
      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(299);
      // Drain microtasks without running more timers
      await Promise.resolve();
      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      // Let the scheduled flush chain resolve
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledWith("hello");

      await batcher.dispose();
    });

    it("uses default maxSize of 2000", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush });

      // Add text just under threshold
      batcher.add("x".repeat(1999));
      // Drain microtasks without advancing timers
      await Promise.resolve();
      expect(onFlush).not.toHaveBeenCalled();

      // Cross the threshold
      batcher.add("y");
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledWith("x".repeat(1999) + "y");

      await batcher.dispose();
    });
  });

  // --- Time-based flushing ---

  describe("time-based flushing", () => {
    it("flushes after flushIntervalMs", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 100 });

      batcher.add("chunk1");
      batcher.add("chunk2");

      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith("chunk1chunk2");

      await batcher.dispose();
    });

    it("resets timer after each flush", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 100 });

      batcher.add("batch1");
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledTimes(1);

      batcher.add("batch2");
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush).toHaveBeenLastCalledWith("batch2");

      await batcher.dispose();
    });

    it("does not flush if no chunks are added", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 100 });

      vi.advanceTimersByTime(500);
      await vi.runAllTimersAsync();

      expect(onFlush).not.toHaveBeenCalled();

      await batcher.dispose();
    });
  });

  // --- Size-based flushing ---

  describe("size-based flushing", () => {
    it("flushes immediately when maxSize is reached", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, maxSize: 10, flushIntervalMs: 5000 });

      batcher.add("12345");
      await Promise.resolve();
      expect(onFlush).not.toHaveBeenCalled();

      batcher.add("67890");
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledWith("1234567890");

      await batcher.dispose();
    });

    it("flushes when a single chunk exceeds maxSize", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, maxSize: 5 });

      batcher.add("this is way too long");
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledWith("this is way too long");

      await batcher.dispose();
    });

    it("flushes multiple batches when continuously adding", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, maxSize: 5, flushIntervalMs: 5000 });

      batcher.add("aaaaa"); // reaches maxSize
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith("aaaaa");

      batcher.add("bbbbb"); // reaches maxSize again
      await vi.runAllTimersAsync();
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush).toHaveBeenLastCalledWith("bbbbb");

      await batcher.dispose();
    });
  });

  // --- Manual flush ---

  describe("flush()", () => {
    it("flushes accumulated chunks immediately", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 5000 });

      batcher.add("early");
      batcher.add(" bird");

      await batcher.flush();

      expect(onFlush).toHaveBeenCalledWith("early bird");

      await batcher.dispose();
    });

    it("is safe to call with no buffered chunks", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush });

      await batcher.flush();

      expect(onFlush).not.toHaveBeenCalled();

      await batcher.dispose();
    });

    it("clears the timer", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 100 });

      batcher.add("data");
      await batcher.flush();

      expect(onFlush).toHaveBeenCalledTimes(1);

      // Advancing time should NOT trigger another flush
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledTimes(1);

      await batcher.dispose();
    });
  });

  // --- Dispose ---

  describe("dispose()", () => {
    it("flushes remaining chunks before disposing", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 5000 });

      batcher.add("leftover");
      await batcher.dispose();

      expect(onFlush).toHaveBeenCalledWith("leftover");
      expect(batcher.isDisposed).toBe(true);
    });

    it("ignores add() calls after dispose", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush });

      await batcher.dispose();
      batcher.add("ignored");

      expect(batcher.bufferedSize).toBe(0);
      expect(batcher.bufferedChunks).toBe(0);
    });

    it("is safe to call multiple times", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush });

      batcher.add("data");
      await batcher.dispose();
      await batcher.dispose();

      expect(onFlush).toHaveBeenCalledTimes(1);
    });
  });

  // --- Empty text handling ---

  describe("empty text handling", () => {
    it("ignores empty string chunks", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 100 });

      batcher.add("");
      batcher.add("");

      expect(batcher.bufferedSize).toBe(0);
      expect(batcher.bufferedChunks).toBe(0);

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onFlush).not.toHaveBeenCalled();

      await batcher.dispose();
    });
  });

  // --- Properties ---

  describe("buffered state", () => {
    it("tracks bufferedSize correctly", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 5000 });

      expect(batcher.bufferedSize).toBe(0);

      batcher.add("hello");
      expect(batcher.bufferedSize).toBe(5);

      batcher.add(" world");
      expect(batcher.bufferedSize).toBe(11);

      await batcher.flush();
      expect(batcher.bufferedSize).toBe(0);

      await batcher.dispose();
    });

    it("tracks bufferedChunks correctly", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 5000 });

      expect(batcher.bufferedChunks).toBe(0);

      batcher.add("a");
      batcher.add("b");
      batcher.add("c");
      expect(batcher.bufferedChunks).toBe(3);

      await batcher.flush();
      expect(batcher.bufferedChunks).toBe(0);

      await batcher.dispose();
    });
  });

  // --- Async onFlush ---

  describe("async onFlush callback", () => {
    it("awaits async onFlush during flush()", async () => {
      const order: string[] = [];
      const onFlush = vi.fn(async (_text: string) => {
        order.push("flush-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("flush-end");
      });
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 5000 });

      batcher.add("async data");
      const flushPromise = batcher.flush();

      vi.advanceTimersByTime(50);
      await flushPromise;

      expect(order).toEqual(["flush-start", "flush-end"]);
      expect(onFlush).toHaveBeenCalledWith("async data");

      await batcher.dispose();
    });

    it("handles onFlush errors gracefully", async () => {
      const onFlush = vi.fn().mockRejectedValueOnce(new Error("network error"));
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 5000 });

      batcher.add("will fail");

      // Should not throw
      await expect(batcher.flush()).rejects.toThrow("network error");

      // Batcher should still be functional after error
      batcher.add("recovery");
      onFlush.mockResolvedValueOnce(undefined);
      await batcher.flush();
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush).toHaveBeenLastCalledWith("recovery");

      await batcher.dispose();
    });
  });

  // --- Concatenation ---

  describe("text concatenation", () => {
    it("joins chunks without separators", async () => {
      const onFlush = vi.fn();
      const batcher = new MessageBatcher({ onFlush, flushIntervalMs: 100 });

      batcher.add("Hello");
      batcher.add(" ");
      batcher.add("World");
      batcher.add("!");

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(onFlush).toHaveBeenCalledWith("Hello World!");

      await batcher.dispose();
    });
  });
});
