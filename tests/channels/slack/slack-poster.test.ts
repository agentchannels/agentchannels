import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackPoster } from "../../../src/channels/slack/slack-poster.js";

// --- Mock WebClient ---

function createMockWebClient() {
  let tsCounter = 0;
  const postedMessages: Array<{ channel: string; thread_ts: string; text: string }> = [];

  const client = {
    chat: {
      postMessage: vi.fn(async (args: { channel: string; thread_ts: string; text: string }) => {
        tsCounter++;
        const ts = `msg-${tsCounter}`;
        postedMessages.push({ channel: args.channel, thread_ts: args.thread_ts, text: args.text });
        return { ok: true, ts };
      }),
    },
    _postedMessages: postedMessages,
  };

  return client;
}

describe("SlackPoster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Basic posting ---

  describe("basic posting", () => {
    it("posts batched text as a threaded reply", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "1234567890.123456",
        batchIntervalMs: 100,
        batchMaxSize: 5000,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("Hello ");
      poster.post("World!");

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(client._postedMessages[0]).toEqual({
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: "Hello World!",
      });

      await poster.finish();
    });

    it("tracks posted message timestamps", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 50,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("msg1");
      vi.advanceTimersByTime(50);
      await vi.runAllTimersAsync();

      poster.post("msg2");
      vi.advanceTimersByTime(50);
      await vi.runAllTimersAsync();

      expect(poster.messageCount).toBe(2);
      expect(poster.postedTimestamps).toEqual(["msg-1", "msg-2"]);

      await poster.finish();
    });
  });

  // --- Finish behavior ---

  describe("finish()", () => {
    it("flushes remaining text on finish", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 5000,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("leftover text");
      await poster.finish();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(client._postedMessages[0].text).toBe("leftover text");
    });

    it("ignores post() calls after finish", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 100,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      await poster.finish();
      poster.post("should be ignored");

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(poster.isFinished).toBe(true);
    });

    it("is safe to call multiple times", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 5000,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("data");
      await poster.finish();
      await poster.finish();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  // --- Batching integration ---

  describe("batching", () => {
    it("batches multiple rapid posts into a single message", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 200,
        batchMaxSize: 10000,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("a");
      poster.post("b");
      poster.post("c");
      poster.post("d");

      // Before interval, nothing posted
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      expect(client.chat.postMessage).not.toHaveBeenCalled();

      // After interval, all batched into one
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(client._postedMessages[0].text).toBe("abcd");

      await poster.finish();
    });

    it("flushes when batch size is exceeded", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 5000,
        batchMaxSize: 10,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("12345");
      poster.post("67890"); // hits 10 chars

      await vi.runAllTimersAsync();
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(client._postedMessages[0].text).toBe("1234567890");

      await poster.finish();
    });
  });

  // --- Message splitting ---

  describe("splitMessage", () => {
    it("returns single chunk for short messages", () => {
      expect(SlackPoster.splitMessage("hello")).toEqual(["hello"]);
    });

    it("returns single chunk for exactly max-length messages", () => {
      const text = "x".repeat(40_000);
      expect(SlackPoster.splitMessage(text)).toEqual([text]);
    });

    it("splits long messages at newlines", () => {
      const part1 = "a".repeat(39_999) + "\n";
      const part2 = "b".repeat(100);
      const text = part1 + part2;

      const chunks = SlackPoster.splitMessage(text);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe("a".repeat(39_999));
      expect(chunks[1]).toBe("b".repeat(100));
    });

    it("hard-splits when no newline is available", () => {
      const text = "x".repeat(80_000);
      const chunks = SlackPoster.splitMessage(text);

      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(40_000);
      expect(chunks[1].length).toBe(40_000);
    });

    it("handles multiple splits", () => {
      const text = "x".repeat(120_000);
      const chunks = SlackPoster.splitMessage(text);

      expect(chunks.length).toBe(3);
      for (const chunk of chunks) {
        expect(chunk.length).toBe(40_000);
      }
    });
  });

  // --- Rate limiting integration ---

  describe("rate limiting", () => {
    it("delays posts when rate limit is exhausted", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 50,
        batchMaxSize: 5,
        rateLimitMaxTokens: 1,
        rateLimitRefillRate: 1, // 1 token/sec
      });

      // First batch — immediate (has 1 token)
      poster.post("aaaaa");
      await vi.runAllTimersAsync();
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);

      // Second batch — should be rate-limited
      poster.post("bbbbb");
      await vi.runAllTimersAsync();

      // Need to wait for rate limit token to refill (1 second)
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).toHaveBeenCalledTimes(2);

      await poster.finish();
    });
  });

  // --- Empty text handling ---

  describe("empty text", () => {
    it("does not post empty text", async () => {
      const client = createMockWebClient();
      const poster = new SlackPoster(client as any, {
        channelId: "C123",
        threadTs: "ts1",
        batchIntervalMs: 100,
        rateLimitMaxTokens: 10,
        rateLimitRefillRate: 10,
      });

      poster.post("");
      poster.post("");

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(client.chat.postMessage).not.toHaveBeenCalled();

      await poster.finish();
    });
  });
});
