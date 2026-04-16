/**
 * Unit tests for DiscordStreamer.
 *
 * All Discord API interactions are replaced by lightweight in-memory fakes —
 * no live network calls are made.
 *
 * Coverage:
 * - start() posts THINKING_PLACEHOLDER as the initial message
 * - start() returns a StreamHandle with append / appendTasks / finish
 * - append() accumulates text and triggers a rate-limited edit
 * - appendTasks() renders thinking / tool-use indicators as emoji prefix lines
 * - finish() drains the full buffer, including empty-response guard
 * - 2 K overflow: excess text posted as a new follow-up message
 * - Pre-existing rate-limit cooldown enters fallback mode immediately
 * - Operations are serialised (enqueue pattern prevents concurrent edits)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordStreamer } from "../../../src/channels/discord/streamer.js";
import { DiscordRateLimitTracker } from "../../../src/channels/discord/rate-limit.js";
import { THINKING_PLACEHOLDER, STREAM_EDIT_INTERVAL_MS } from "../../../src/channels/discord/constants.js";
import type {
  DiscordEditableMessage,
  DiscordSendableChannel,
} from "../../../src/channels/discord/stream-handle.js";

// ---------------------------------------------------------------------------
// Fake Discord primitives
// ---------------------------------------------------------------------------

/** Tracks all content values written to a single fake Discord message. */
class FakeMessage implements DiscordEditableMessage {
  public edits: string[] = [];
  /** When set, the next edit() call will throw this error. */
  private _nextError: unknown | undefined;

  async edit(options: { content: string }): Promise<void> {
    if (this._nextError !== undefined) {
      const err = this._nextError;
      this._nextError = undefined;
      throw err;
    }
    this.edits.push(options.content);
  }

  /** Convenience: the most recent edit content. */
  get lastContent(): string {
    return this.edits[this.edits.length - 1] ?? "";
  }

  /** Schedule an error to be thrown on the next edit(). */
  failNextEdit(err: unknown): void {
    this._nextError = err;
  }
}

/** Fake channel that records all sent messages and returns controllable FakeMessages. */
class FakeChannel implements DiscordSendableChannel {
  public sentMessages: FakeMessage[] = [];
  /** Queue of message instances to return for successive send() calls. */
  private nextMessages: FakeMessage[] = [];

  queueNextMessage(msg: FakeMessage): void {
    this.nextMessages.push(msg);
  }

  async send(options: { content: string }): Promise<FakeMessage> {
    const msg = this.nextMessages.shift() ?? new FakeMessage();
    // Record the initial content so FakeMessage.lastContent reflects what Discord received.
    msg.edits.push(options.content);
    this.sentMessages.push(msg);
    return msg;
  }

  /** Convenience: first message sent (usually the placeholder). */
  get firstMessage(): FakeMessage {
    return this.sentMessages[0]!;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamer(tracker?: DiscordRateLimitTracker): {
  streamer: DiscordStreamer;
  channel: FakeChannel;
  tracker: DiscordRateLimitTracker;
} {
  const channel = new FakeChannel();
  const t = tracker ?? new DiscordRateLimitTracker();
  const streamer = new DiscordStreamer(channel, "ch-123", t);
  return { streamer, channel, tracker: t };
}

/** Advance fake timers past the full edit interval and flush microtasks. */
async function tickEditInterval(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STREAM_EDIT_INTERVAL_MS + 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Placeholder setup
  // -------------------------------------------------------------------------

  it("start() posts THINKING_PLACEHOLDER as the first message", async () => {
    const { streamer, channel } = makeStreamer();
    await streamer.start();

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.firstMessage.lastContent).toBe(THINKING_PLACEHOLDER);
  });

  it("start() returns a StreamHandle with append, appendTasks, and finish", async () => {
    const { streamer } = makeStreamer();
    const handle = await streamer.start();

    expect(typeof handle.append).toBe("function");
    expect(typeof handle.appendTasks).toBe("function");
    expect(typeof handle.finish).toBe("function");
  });

  // -------------------------------------------------------------------------
  // append() — text accumulation + rate-limited flush
  // -------------------------------------------------------------------------

  it("append() accumulates text and edits the placeholder — final content is correct", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    // Note: because lastEditTime starts at 0 and Date.now() is a large number,
    // the FIRST append fires its flush immediately (elapsed >> STREAM_EDIT_INTERVAL_MS).
    // Subsequent appends within 1 s ARE coalesced into a single deferred flush.
    await handle.append("Hello ");
    await handle.append("world!");

    await tickEditInterval();

    // After the interval, both deltas should be reflected in the final edit.
    expect(channel.firstMessage.lastContent).toBe("Hello world!");
  });

  it("rapid appends after the first are coalesced into a single deferred edit", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    // append("A") fires immediately (lastEditTime=0 → elapsed >> interval).
    // append("B") and append("C") are issued within 1 s, so they share one
    // deferred flush — i.e. B and C are coalesced, NOT all three.
    await handle.append("A");
    await handle.append("B");
    await handle.append("C");

    await tickEditInterval();

    // Final content must reflect all three deltas.
    expect(channel.firstMessage.lastContent).toBe("ABC");
    // B and C were coalesced: edits = [initial-placeholder, "A", "ABC"] = 3.
    // If they were NOT coalesced we'd see 4 edits — verifies the enqueue
    // cadence is doing its job for rapid subsequent appends.
    expect(channel.firstMessage.edits).toHaveLength(3);
  });

  it("empty append() calls are ignored", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.append("");
    await tickEditInterval();

    // No edit scheduled for empty delta.
    expect(channel.firstMessage.edits).toHaveLength(1); // only initial
  });

  // -------------------------------------------------------------------------
  // appendTasks() — agent activity indicators
  // -------------------------------------------------------------------------

  it("appendTasks() renders a thinking task as 💡 prefix", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.appendTasks([{ id: "init", text: "Initializing", status: "in_progress" }]);

    expect(channel.firstMessage.lastContent).toMatch(/^💡 Initializing/);
  });

  it("appendTasks() renders a tool_use in_progress task as 🔧 prefix", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.appendTasks([{ id: "tool_1", text: "Running bash", status: "in_progress" }]);

    expect(channel.firstMessage.lastContent).toMatch(/^🔧 Running bash/);
  });

  it("appendTasks() renders a tool_use complete task as ✅ prefix", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.appendTasks([{ id: "tool_1", text: "Running bash", status: "complete" }]);

    expect(channel.firstMessage.lastContent).toMatch(/^✅ Running bash/);
  });

  it("appendTasks() renders indicators above accumulated text", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.append("partial response...");
    await tickEditInterval();

    await handle.appendTasks([{ id: "tool_1", text: "Searching", status: "in_progress" }]);

    const content = channel.firstMessage.lastContent;
    expect(content).toMatch(/^🔧 Searching/);
    expect(content).toContain("partial response...");
    // Indicator comes before the text body.
    expect(content.indexOf("🔧")).toBeLessThan(content.indexOf("partial response"));
  });

  it("appendTasks() strips Slack :emoji_code: patterns from task text", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.appendTasks([{ id: "tool_1", text: ":wrench: Using `bash`", status: "in_progress" }]);

    const content = channel.firstMessage.lastContent;
    // Slack emoji code should be stripped, Discord emoji prefix added.
    expect(content).not.toContain(":wrench:");
    expect(content).toContain("Using `bash`");
    expect(content).toMatch(/^🔧/);
  });

  it("appendTasks() does nothing when tasks array is empty", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    const editsBefore = channel.firstMessage.edits.length;
    await handle.appendTasks([]);

    expect(channel.firstMessage.edits.length).toBe(editsBefore);
  });

  it("appendTasks() silently drops completed thinking tasks", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    const editsBefore = channel.firstMessage.edits.length;
    // Completed thinking tasks render null → no visible output.
    await handle.appendTasks([{ id: "thinking_1", text: "Analyzing", status: "complete" }]);

    expect(channel.firstMessage.edits.length).toBe(editsBefore);
  });

  // -------------------------------------------------------------------------
  // finish() — drain and finalize
  // -------------------------------------------------------------------------

  it("finish() writes accumulated text to the message", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.append("response text");
    await handle.finish();

    expect(channel.firstMessage.lastContent).toBe("response text");
  });

  it("finish() appends finalText before writing", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.append("Hello ");
    await handle.finish("world!");

    expect(channel.firstMessage.lastContent).toBe("Hello world!");
  });

  it("finish() writes (no response) when buffer is empty", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    await handle.finish();

    expect(channel.firstMessage.lastContent).toBe("(no response)");
  });

  it("finish() cancels any pending flush timer and drains fully", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    // Append text (schedules a deferred flush within STREAM_EDIT_INTERVAL_MS).
    await handle.append("content");
    // Finish immediately — should cancel the pending timer and drain now.
    await handle.finish();

    expect(channel.firstMessage.lastContent).toBe("content");
    // The deferred timer should have been cancelled; advance time to confirm
    // no second edit fires.
    const editCount = channel.firstMessage.edits.length;
    await tickEditInterval();
    expect(channel.firstMessage.edits.length).toBe(editCount);
  });

  // -------------------------------------------------------------------------
  // 2 K overflow
  // -------------------------------------------------------------------------

  it("2 K overflow: edits current message with first 2000 chars, posts remainder as new message", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    // Build a string just over 2000 characters.
    const longText = "A".repeat(2000) + "B".repeat(100);
    await handle.append(longText);

    await tickEditInterval();

    // The original placeholder message should be edited with exactly 2000 chars.
    expect(channel.firstMessage.lastContent).toBe("A".repeat(2000));
    // A new follow-up message should be posted with the overflow.
    expect(channel.sentMessages).toHaveLength(2);
    expect(channel.sentMessages[1]!.lastContent).toBe("B".repeat(100));
  });

  it("finish() drains multi-chunk overflow correctly", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    // Build a string that spans 3 messages worth of content.
    const longText = "X".repeat(4500);
    await handle.append(longText);
    await handle.finish();

    // First message: 2000 chars.
    expect(channel.firstMessage.lastContent).toBe("X".repeat(2000));
    // Total messages: placeholder + 2 overflow.
    expect(channel.sentMessages.length).toBeGreaterThanOrEqual(2);
    // Total characters across all sent messages should equal 4500.
    const totalChars = channel.sentMessages
      .map((m) => m.lastContent.length)
      .reduce((a, b) => a + b, 0);
    expect(totalChars).toBe(4500);
  });

  // -------------------------------------------------------------------------
  // Rate-limit fallback mode
  // -------------------------------------------------------------------------

  it("enters fallback mode when channel is pre-rate-limited at start()", async () => {
    const tracker = new DiscordRateLimitTracker();
    // Record a rate-limit hit so the channel is cooled down.
    tracker.recordHit("ch-123", 5000);

    const { streamer, channel } = makeStreamer(tracker);
    const handle = await streamer.start();

    // Append text — should be silently buffered (no edits).
    await handle.append("buffered during cooldown");
    await tickEditInterval();

    // Only the initial placeholder send — no edits during the stream.
    expect(channel.firstMessage.edits).toHaveLength(1);

    // finish() should post the full buffer as a new send() call.
    await handle.finish();
    // A new message (not an edit) should contain the buffered text.
    expect(channel.sentMessages).toHaveLength(2);
    expect(channel.sentMessages[1]!.lastContent).toBe("buffered during cooldown");
  });

  it("fallback mode: finish() with empty buffer posts (no response) via send()", async () => {
    const tracker = new DiscordRateLimitTracker();
    tracker.recordHit("ch-123", 5000);

    const { streamer, channel } = makeStreamer(tracker);
    const handle = await streamer.start();

    await handle.finish();

    // Should post a new message with (no response) since buffer is empty.
    expect(channel.sentMessages).toHaveLength(2);
    expect(channel.sentMessages[1]!.lastContent).toBe("(no response)");
  });

  it("fallback mode: appendTasks() is a no-op", async () => {
    const tracker = new DiscordRateLimitTracker();
    tracker.recordHit("ch-123", 5000);

    const { streamer, channel } = makeStreamer(tracker);
    const handle = await streamer.start();

    const editsBefore = channel.firstMessage.edits.length;
    await handle.appendTasks([{ id: "tool_1", text: "Searching", status: "in_progress" }]);

    // No additional edits in fallback mode.
    expect(channel.firstMessage.edits.length).toBe(editsBefore);
  });

  // -------------------------------------------------------------------------
  // Serialisation (enqueue chain)
  // -------------------------------------------------------------------------

  it("serialises concurrent operations so they do not overlap", async () => {
    const { streamer, channel } = makeStreamer();
    const handle = await streamer.start();

    // Issue append and appendTasks concurrently.
    await Promise.all([
      handle.append("hello "),
      handle.appendTasks([{ id: "init", text: "Thinking", status: "in_progress" }]),
      handle.append("world"),
    ]);

    // Ensure final state is internally consistent (no partial overwrites).
    // After serialisation, the last operation's result should reflect all prior ops.
    // Advance timers so any scheduled flush fires.
    await tickEditInterval();

    // The last edit should contain the accumulated text.
    expect(channel.firstMessage.lastContent).toContain("hello world");
  });

  it("multiple start() calls each create independent streaming sessions", async () => {
    const { streamer, channel } = makeStreamer();

    const handle1 = await streamer.start();
    const handle2 = await streamer.start();

    await handle1.append("session one");
    await handle2.append("session two");

    await tickEditInterval();

    // Two separate placeholder messages should have been posted.
    expect(channel.sentMessages.length).toBeGreaterThanOrEqual(2);
    // Each has accumulated its own text independently.
    expect(channel.sentMessages[0]!.lastContent).toContain("session one");
    expect(channel.sentMessages[1]!.lastContent).toContain("session two");
  });
});
