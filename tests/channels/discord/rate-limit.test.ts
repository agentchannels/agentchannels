/**
 * Unit tests for DiscordRateLimitTracker and rate-limit detection integration.
 *
 * Covers:
 * - DiscordRateLimitTracker.recordHit() / isRateLimited() / getRemainingCooldown()
 * - Automatic expiry after retryAfterMs elapses
 * - DiscordRateLimitTracker.isRateLimitError() — 429 detection heuristics
 * - DiscordRateLimitTracker.extractRetryAfter() — retry_after parsing
 * - DiscordStreamHandle integration: 429 hit sets isRateLimited flag + records to tracker
 * - DiscordStreamHandle scheduleFlush() respects tracker cooldown
 * - DiscordAdapter.isChannelRateLimited() / getRateLimitTracker() wired correctly
 * - sendMessage() 429 detection records to adapter's tracker
 *
 * No live Discord API calls — all interactions use in-memory fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordRateLimitTracker } from "../../../src/channels/discord/rate-limit.js";
import {
  DiscordStreamHandle,
  type DiscordEditableMessage,
  type DiscordSendableChannel,
} from "../../../src/channels/discord/stream-handle.js";

// ---------------------------------------------------------------------------
// Discord.js mock (module-level — vi.mock is hoisted, so vars must be top-level)
//
// Pattern mirrors adapter.test.ts: inline vi.fn() in the factory, and expose
// mutable module-level handles for per-test configuration.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => unknown;

const onListeners: Record<string, Listener[]> = {};
const onceListeners: Record<string, Listener[]> = {};

const mockChannelsFetch = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();

vi.mock("discord.js", () => {
  class Client {
    channels = { fetch: mockChannelsFetch };

    on(event: string, listener: Listener) {
      if (!onListeners[event]) onListeners[event] = [];
      onListeners[event].push(listener);
      return this;
    }

    once(event: string, listener: Listener) {
      if (!onceListeners[event]) onceListeners[event] = [];
      onceListeners[event].push(listener);
      return this;
    }

    login = mockLogin;
    destroy = mockDestroy;
  }

  return {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 512, MessageContent: 32768, DirectMessages: 4096 },
    Partials: { Channel: "Channel", Message: "Message" },
    Events: { ClientReady: "ready", MessageCreate: "messageCreate", Error: "error" },
    ChannelType: {
      GuildText: 0,
      DM: 1,
      GuildVoice: 2,
      GuildAnnouncement: 5,
      AnnouncementThread: 10,
      PublicThread: 11,
      PrivateThread: 12,
    },
  };
});

// Import DiscordAdapter AFTER mock registration
import { DiscordAdapter } from "../../../src/channels/discord/index.js";

// ---------------------------------------------------------------------------
// Fake Discord primitives (for DiscordStreamHandle tests — no discord.js needed)
// ---------------------------------------------------------------------------

class FakeMessage implements DiscordEditableMessage {
  public edits: string[] = [];
  public shouldFail = false;
  public failWithRateLimit = false;

  async edit(options: { content: string }): Promise<void> {
    if (this.failWithRateLimit) {
      const err = Object.assign(new Error("HTTP 429: You are being rate limited."), {
        status: 429,
        retryAfter: 2, // 2 seconds
      });
      throw err;
    }
    if (this.shouldFail) {
      throw new Error("Generic Discord API error");
    }
    this.edits.push(options.content);
  }

  get lastContent(): string {
    return this.edits[this.edits.length - 1] ?? "";
  }
}

class FakeChannel implements DiscordSendableChannel {
  public sentMessages: FakeMessage[] = [];

  async send(options: { content: string }): Promise<FakeMessage> {
    const msg = new FakeMessage();
    msg.edits.push(options.content);
    this.sentMessages.push(msg);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// DiscordRateLimitTracker unit tests
// ---------------------------------------------------------------------------

describe("DiscordRateLimitTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // recordHit / isRateLimited
  // -------------------------------------------------------------------------

  describe("recordHit() and isRateLimited()", () => {
    it("returns false for an unknown channel", () => {
      const tracker = new DiscordRateLimitTracker();
      expect(tracker.isRateLimited("unknown-channel")).toBe(false);
    });

    it("returns true immediately after recording a hit", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 5000);
      expect(tracker.isRateLimited("ch-1")).toBe(true);
    });

    it("returns false after the cooldown has elapsed", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 3000);

      // Still rate-limited at 2 999 ms
      vi.advanceTimersByTime(2999);
      expect(tracker.isRateLimited("ch-1")).toBe(true);

      // Expired at 3 001 ms
      vi.advanceTimersByTime(2);
      expect(tracker.isRateLimited("ch-1")).toBe(false);
    });

    it("uses RATE_LIMIT_DEFAULT_COOLDOWN_MS (5 000) when retryAfterMs is omitted", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1");

      vi.advanceTimersByTime(4999);
      expect(tracker.isRateLimited("ch-1")).toBe(true);

      vi.advanceTimersByTime(2);
      expect(tracker.isRateLimited("ch-1")).toBe(false);
    });

    it("tracks multiple channels independently", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-a", 2000);
      tracker.recordHit("ch-b", 8000);

      vi.advanceTimersByTime(3000);

      expect(tracker.isRateLimited("ch-a")).toBe(false); // expired
      expect(tracker.isRateLimited("ch-b")).toBe(true);  // still active
      expect(tracker.isRateLimited("ch-c")).toBe(false); // never hit
    });

    it("refreshes an existing entry when recordHit() is called again", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 1000);

      vi.advanceTimersByTime(800); // 200 ms remaining
      // Re-record with a longer cooldown
      tracker.recordHit("ch-1", 5000);

      vi.advanceTimersByTime(4500); // past the original 1 s, but within new 5 s
      expect(tracker.isRateLimited("ch-1")).toBe(true);

      vi.advanceTimersByTime(600);
      expect(tracker.isRateLimited("ch-1")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getRemainingCooldown
  // -------------------------------------------------------------------------

  describe("getRemainingCooldown()", () => {
    it("returns 0 for an unknown channel", () => {
      const tracker = new DiscordRateLimitTracker();
      expect(tracker.getRemainingCooldown("ch-unknown")).toBe(0);
    });

    it("returns a positive value immediately after recording a hit", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 5000);
      const remaining = tracker.getRemainingCooldown("ch-1");
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5000);
    });

    it("decreases over time", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 5000);

      vi.advanceTimersByTime(2000);
      const remaining = tracker.getRemainingCooldown("ch-1");

      // Should be approximately 3 000 ms
      expect(remaining).toBeGreaterThanOrEqual(2900);
      expect(remaining).toBeLessThanOrEqual(3100);
    });

    it("returns 0 and clears entry after cooldown expires", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 1000);

      vi.advanceTimersByTime(1001);
      expect(tracker.getRemainingCooldown("ch-1")).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // clear()
  // -------------------------------------------------------------------------

  describe("clear()", () => {
    it("immediately removes an active rate-limit entry", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 10000);

      expect(tracker.isRateLimited("ch-1")).toBe(true);
      tracker.clear("ch-1");
      expect(tracker.isRateLimited("ch-1")).toBe(false);
    });

    it("is a no-op for a channel that was never rate-limited", () => {
      const tracker = new DiscordRateLimitTracker();
      expect(() => tracker.clear("ch-never")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // rateLimitedCount
  // -------------------------------------------------------------------------

  describe("rateLimitedCount", () => {
    it("returns 0 when no channels are rate-limited", () => {
      const tracker = new DiscordRateLimitTracker();
      expect(tracker.rateLimitedCount).toBe(0);
    });

    it("increments for each newly rate-limited channel", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 5000);
      tracker.recordHit("ch-2", 5000);
      expect(tracker.rateLimitedCount).toBe(2);
    });

    it("decrements when a cooldown expires", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-1", 1000);
      tracker.recordHit("ch-2", 5000);

      vi.advanceTimersByTime(1001);
      expect(tracker.rateLimitedCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // isRateLimitError() — static error classification
  // -------------------------------------------------------------------------

  describe("DiscordRateLimitTracker.isRateLimitError()", () => {
    it("returns false for null", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(undefined)).toBe(false);
    });

    it("returns true for an Error with '429' in the message", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(
        new Error("HTTP 429: You are being rate limited."),
      )).toBe(true);
    });

    it("returns true for an Error with 'rate limit' in the message (case-insensitive)", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(
        new Error("Rate Limit exceeded"),
      )).toBe(true);
    });

    it("returns true for an Error with 'ratelimit' in the message (no space)", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(
        new Error("ratelimit hit"),
      )).toBe(true);
    });

    it("returns true for an object with status === 429 (discord.js DiscordAPIError shape)", () => {
      expect(DiscordRateLimitTracker.isRateLimitError({ status: 429 })).toBe(true);
    });

    it("returns true for an object with code === 429", () => {
      expect(DiscordRateLimitTracker.isRateLimitError({ code: 429 })).toBe(true);
    });

    it("returns true for an object with httpStatus === 429", () => {
      expect(DiscordRateLimitTracker.isRateLimitError({ httpStatus: 429 })).toBe(true);
    });

    it("returns false for a 500 error", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(
        Object.assign(new Error("Internal Server Error"), { status: 500 }),
      )).toBe(false);
    });

    it("returns false for a generic Error with no rate-limit indicators", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(
        new Error("Unknown error"),
      )).toBe(false);
    });

    it("returns false for a plain string", () => {
      expect(DiscordRateLimitTracker.isRateLimitError("some string")).toBe(false);
    });

    it("returns false for a number", () => {
      expect(DiscordRateLimitTracker.isRateLimitError(404)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // extractRetryAfter() — static retry_after parsing
  // -------------------------------------------------------------------------

  describe("DiscordRateLimitTracker.extractRetryAfter()", () => {
    it("extracts retryAfter (seconds) from discord.js DiscordAPIError shape and converts to ms", () => {
      const err = { retryAfter: 2.5 };
      expect(DiscordRateLimitTracker.extractRetryAfter(err)).toBe(2500);
    });

    it("extracts retry_after (seconds) from alternate property name and converts to ms", () => {
      const err = { retry_after: 1 };
      expect(DiscordRateLimitTracker.extractRetryAfter(err)).toBe(1000);
    });

    it("extracts retryAfterMs directly when already in milliseconds", () => {
      const err = { retryAfterMs: 3000 };
      expect(DiscordRateLimitTracker.extractRetryAfter(err)).toBe(3000);
    });

    it("prefers retryAfter over retry_after when both are present", () => {
      const err = { retryAfter: 3, retry_after: 10 };
      expect(DiscordRateLimitTracker.extractRetryAfter(err)).toBe(3000);
    });

    it("rounds up fractional seconds (ceil)", () => {
      const err = { retryAfter: 1.1 };
      expect(DiscordRateLimitTracker.extractRetryAfter(err)).toBe(1100);
    });

    it("falls back to RATE_LIMIT_DEFAULT_COOLDOWN_MS (5 000) when no retry_after found", () => {
      expect(DiscordRateLimitTracker.extractRetryAfter(new Error("429"))).toBe(5000);
      expect(DiscordRateLimitTracker.extractRetryAfter(null)).toBe(5000);
      expect(DiscordRateLimitTracker.extractRetryAfter({})).toBe(5000);
    });
  });
});

// ---------------------------------------------------------------------------
// DiscordStreamHandle + rate-limit integration
// ---------------------------------------------------------------------------

describe("DiscordStreamHandle — rate-limit detection and tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // isRateLimited flag on the handle
  // -------------------------------------------------------------------------

  describe("isRateLimited getter", () => {
    it("starts as false", () => {
      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel);
      expect(handle.isRateLimited).toBe(false);
    });

    it("becomes true after a 429 error on a periodic flush", async () => {
      const msg = new FakeMessage();
      msg.failWithRateLimit = true;
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);
      await handle.append("hello");
      await vi.runAllTimersAsync();

      expect(handle.isRateLimited).toBe(true);
      errorSpy.mockRestore();
    });

    it("stays true once set — fallback mode prevents further edit attempts so the flag cannot reset", async () => {
      const rateLimitErr = Object.assign(new Error("429"), { status: 429 });
      const msg: DiscordEditableMessage = {
        async edit() {
          throw rateLimitErr;
        },
      };

      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const handle = new DiscordStreamHandle(msg, channel);

      // First flush: 429 → isRateLimited = true AND inFallbackMode = true
      await handle.append("a");
      await vi.runAllTimersAsync();
      expect(handle.isRateLimited).toBe(true);
      expect(handle.inFallbackMode).toBe(true);

      // In fallback mode, subsequent appends are buffered — no edit attempts made.
      // isRateLimited cannot reset to false because no successful edit ever fires.
      vi.advanceTimersByTime(1100);
      await handle.append("b");
      await vi.runAllTimersAsync();
      expect(handle.isRateLimited).toBe(true); // stays true — fallback mode is permanent

      errorSpy.mockRestore();
    });

    it("stays false when a non-429 error occurs (other Discord errors don't set the flag)", async () => {
      const msg = new FakeMessage();
      msg.shouldFail = true;
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);
      await handle.append("hello");
      await vi.runAllTimersAsync();

      // Non-429 error — flag should remain false
      expect(handle.isRateLimited).toBe(false);
      errorSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Shared tracker integration
  // -------------------------------------------------------------------------

  describe("shared DiscordRateLimitTracker integration", () => {
    it("records a hit to the shared tracker when a 429 occurs on flush", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "channel-123";

      const msg = new FakeMessage();
      msg.failWithRateLimit = true;
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);
      await handle.append("hello");
      await vi.runAllTimersAsync();

      expect(tracker.isRateLimited(channelId)).toBe(true);
      errorSpy.mockRestore();
    });

    it("does NOT record to tracker when channelId is not provided", async () => {
      const tracker = new DiscordRateLimitTracker();

      const msg = new FakeMessage();
      msg.failWithRateLimit = true;
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // No channelId passed
      const handle = new DiscordStreamHandle(msg, channel, undefined, tracker);
      await handle.append("hello");
      await vi.runAllTimersAsync();

      // handle.isRateLimited should be true (flag always set on 429)
      expect(handle.isRateLimited).toBe(true);
      // But tracker has nothing recorded (no channelId to key on)
      expect(tracker.rateLimitedCount).toBe(0);
      errorSpy.mockRestore();
    });

    it("records the retry_after from the 429 error into the tracker", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "ch-retry";

      // Throw a 429 with retryAfter = 3 seconds
      const rateLimitErr = Object.assign(new Error("HTTP 429"), {
        status: 429,
        retryAfter: 3,
      });
      const msg: DiscordEditableMessage = {
        async edit() {
          throw rateLimitErr;
        },
      };
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);
      await handle.append("test");
      await vi.runAllTimersAsync();

      // 2 999 ms should still be rate-limited (3 000 ms cooldown)
      vi.advanceTimersByTime(2999);
      expect(tracker.isRateLimited(channelId)).toBe(true);

      // After 3 001 ms total, should be clear
      vi.advanceTimersByTime(2);
      expect(tracker.isRateLimited(channelId)).toBe(false);

      errorSpy.mockRestore();
    });

    it("records a 429 from appendTasks to the tracker", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "ch-tasks";

      const msg = new FakeMessage();
      msg.failWithRateLimit = true;
      const channel = new FakeChannel();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);
      await handle.appendTasks([{ id: "t1", text: "Thinking", status: "in_progress" }]);

      expect(tracker.isRateLimited(channelId)).toBe(true);
      expect(handle.isRateLimited).toBe(true);
      warnSpy.mockRestore();
    });

    it("does NOT record a non-429 appendTasks error to the tracker", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "ch-nontasks";

      const msg = new FakeMessage();
      msg.shouldFail = true; // Generic error, not 429
      const channel = new FakeChannel();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);
      await handle.appendTasks([{ id: "t1", text: "Thinking", status: "in_progress" }]);

      expect(tracker.isRateLimited(channelId)).toBe(false);
      expect(handle.isRateLimited).toBe(false);
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // scheduleFlush respects tracker cooldown
  // -------------------------------------------------------------------------

  describe("scheduleFlush() — respects tracker cooldown when rate-limited", () => {
    it("defers the next flush by the tracker's remaining cooldown (external hit recorded after construction)", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "ch-delay";

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      // No pre-existing rate-limit — handle starts in NORMAL mode
      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);

      // First flush: immediate (establishes lastEditTime)
      await handle.append("init");
      await vi.runAllTimersAsync();
      expect(msg.edits.length).toBeGreaterThan(0);

      // Advance past cadence window, then simulate an EXTERNAL rate-limit hit
      // (e.g. another concurrent stream or sendMessage() on the same channel)
      vi.advanceTimersByTime(1100);
      tracker.recordHit(channelId, 3000);

      // Next append: scheduleFlush() should extend delay by the 3 s cooldown
      await handle.append("hello");
      const editsAfterAppend = msg.edits.length;

      // After only 1 s, no additional edit should have fired yet
      vi.advanceTimersByTime(1000);
      expect(msg.edits.length).toBe(editsAfterAppend);

      // After the full 3 s+ cooldown, the deferred flush fires
      vi.advanceTimersByTime(2001);
      await vi.runAllTimersAsync();

      expect(msg.edits.length).toBeGreaterThan(editsAfterAppend);
      expect(msg.lastContent).toContain("hello");
    });

    it("pre-seeded fallback: tracker rate-limited at construction → handle enters fallback mode, no flushes", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "ch-prefilled";

      // Record a rate-limit BEFORE constructing the handle
      tracker.recordHit(channelId, 3000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);

      // Handle should be in fallback mode immediately
      expect(handle.inFallbackMode).toBe(true);

      // append() must buffer without triggering any edits
      await handle.append("hello");
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(msg.edits).toHaveLength(0);

      // finish() must post via channel.send(), not currentMessage.edit()
      await handle.finish();

      expect(msg.edits).toHaveLength(0);
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toBe("hello");
    });

    it("flushes normally when the tracker shows no active rate-limit", async () => {
      const tracker = new DiscordRateLimitTracker();
      const channelId = "ch-ok";
      // No rate-limit recorded for this channel

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, channelId, tracker);

      await handle.append("hello");
      await vi.runAllTimersAsync();

      // Normal immediate flush (elapsed >> STREAM_EDIT_INTERVAL_MS from epoch)
      expect(msg.edits.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// DiscordAdapter — rate-limit public API
// ---------------------------------------------------------------------------

describe("DiscordAdapter — isChannelRateLimited() and getRateLimitTracker()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockChannelsFetch.mockReset();
    mockLogin.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isChannelRateLimited() returns false for an unknown channel before any 429", () => {
    const adapter = new DiscordAdapter({ botToken: "fake-token" });
    expect(adapter.isChannelRateLimited("ch-unknown")).toBe(false);
  });

  it("getRateLimitTracker() returns the shared DiscordRateLimitTracker instance", () => {
    const adapter = new DiscordAdapter({ botToken: "fake-token" });
    const tracker = adapter.getRateLimitTracker();
    expect(tracker).toBeInstanceOf(DiscordRateLimitTracker);
  });

  it("isChannelRateLimited() returns true after manually recording a hit to the tracker", () => {
    const adapter = new DiscordAdapter({ botToken: "fake-token" });

    adapter.getRateLimitTracker().recordHit("ch-manual", 5000);
    expect(adapter.isChannelRateLimited("ch-manual")).toBe(true);
  });

  it("sendMessage() records a 429 hit to the adapter tracker and re-throws", async () => {
    const adapter = new DiscordAdapter({ botToken: "fake-token" });

    const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429, retryAfter: 2 });
    const fakeChannel = {
      type: 0, // GuildText
      isTextBased: () => true,
      send: vi.fn().mockRejectedValue(rateLimitErr),
    };
    mockChannelsFetch.mockResolvedValue(fakeChannel);

    await expect(adapter.sendMessage("guild-1", "ch-123", "hello")).rejects.toThrow();

    expect(adapter.isChannelRateLimited("ch-123")).toBe(true);
  });

  it("sendMessage() does NOT record non-429 errors to the tracker", async () => {
    const adapter = new DiscordAdapter({ botToken: "fake-token" });

    const genericErr = new Error("Internal server error");
    const fakeChannel = {
      type: 0,
      isTextBased: () => true,
      send: vi.fn().mockRejectedValue(genericErr),
    };
    mockChannelsFetch.mockResolvedValue(fakeChannel);

    await expect(adapter.sendMessage("guild-1", "ch-456", "hello")).rejects.toThrow();

    expect(adapter.isChannelRateLimited("ch-456")).toBe(false);
  });

  it("startStream() passes channelId and tracker to DiscordStreamHandle — 429 flows back to adapter", async () => {
    const adapter = new DiscordAdapter({ botToken: "fake-token" });

    const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429, retryAfter: 1 });
    const fakeEditableMsg = { edit: vi.fn().mockRejectedValue(rateLimitErr) };
    const fakeChannel = {
      type: 0,
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue(fakeEditableMsg),
    };
    mockChannelsFetch.mockResolvedValue(fakeChannel);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handle = await adapter.startStream("guild-1", "thread-789");
    await handle.append("streaming text");
    await vi.runAllTimersAsync();

    // The 429 from the handle's edit should have flowed to the adapter's tracker
    expect(adapter.isChannelRateLimited("thread-789")).toBe(true);

    errorSpy.mockRestore();
  });
});
