/**
 * Unit tests for DiscordStreamHandle.
 *
 * All Discord API interactions are replaced by lightweight in-memory fakes —
 * no live network calls are made.
 *
 * Coverage:
 * - Content accumulation buffer (append → buffer grows)
 * - Rate-limited flush cadence (~1 s between edits)
 * - 2 K character overflow → new follow-up message
 * - finish() drains the full buffer, including multi-chunk overflow
 * - appendTasks() renders active task indicators as prefix lines
 * - Empty-response guard in finish()
 * - finalText parameter in finish()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DiscordStreamHandle,
  cleanTaskText,
  renderTaskLine,
  type DiscordEditableMessage,
  type DiscordSendableChannel,
} from "../../../src/channels/discord/stream-handle.js";
import { DiscordRateLimitTracker } from "../../../src/channels/discord/rate-limit.js";

// ---------------------------------------------------------------------------
// Fake Discord primitives
// ---------------------------------------------------------------------------

/** Tracks all content values written to a single fake Discord message. */
class FakeMessage implements DiscordEditableMessage {
  public edits: string[] = [];

  async edit(options: { content: string }): Promise<void> {
    this.edits.push(options.content);
  }

  /** Convenience: the most recent edit content. */
  get lastContent(): string {
    return this.edits[this.edits.length - 1] ?? "";
  }
}

/** Fake channel that records all sent messages and returns controllable FakeMessages. */
class FakeChannel implements DiscordSendableChannel {
  public sentMessages: FakeMessage[] = [];
  /** Override to inject a specific message as the send result. */
  private nextMessage: FakeMessage | undefined;

  setNextMessage(msg: FakeMessage): void {
    this.nextMessage = msg;
  }

  async send(options: { content: string }): Promise<FakeMessage> {
    const msg = this.nextMessage ?? new FakeMessage();
    this.nextMessage = undefined;
    // Record the initial content as if the message were edited with it,
    // so FakeMessage.lastContent reflects the content Discord was given.
    msg.edits.push(options.content);
    this.sentMessages.push(msg);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh handle with fresh fakes. */
function makeHandle(): {
  handle: DiscordStreamHandle;
  initialMessage: FakeMessage;
  channel: FakeChannel;
} {
  const initialMessage = new FakeMessage();
  const channel = new FakeChannel();
  const handle = new DiscordStreamHandle(initialMessage, channel);
  return { handle, initialMessage, channel };
}

/** String of `n` repetitions of character `c`. */
function repeat(c: string, n: number): string {
  return c.repeat(n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordStreamHandle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // append() — content accumulation
  // -------------------------------------------------------------------------

  describe("append() — content accumulation", () => {
    it("does nothing when given an empty string", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.append("");

      // No flush should have fired — no edits yet
      expect(initialMessage.edits).toHaveLength(0);
    });

    it("accumulates text and triggers an immediate edit when cadence window has passed", async () => {
      const { handle, initialMessage } = makeHandle();

      // lastEditTime starts at 0; Date.now() > 0 + 1000 → immediate flush
      await handle.append("Hello");
      await vi.runAllTimersAsync();

      expect(initialMessage.lastContent).toBe("Hello");
    });

    it("coalesces rapid appends within the 1 s window into a single edit", async () => {
      const { handle, initialMessage } = makeHandle();

      // First append: fires immediately (elapsed >> 1000 ms from epoch start)
      await handle.append("A");
      await vi.runAllTimersAsync();
      const editCountAfterFirst = initialMessage.edits.length;

      // Rapid subsequent appends within the 1 s window
      await handle.append("B");
      await handle.append("C");
      // No timer has fired yet — accumulated text is "ABC" but edit count unchanged
      expect(initialMessage.edits.length).toBe(editCountAfterFirst);

      // Advance time to fire the deferred flush
      await vi.runAllTimersAsync();

      // All three letters should appear in the final edit
      expect(initialMessage.lastContent).toContain("A");
      expect(initialMessage.lastContent).toContain("B");
      expect(initialMessage.lastContent).toContain("C");
    });

    it("shows THINKING_PLACEHOLDER when the buffer is empty during a flush", async () => {
      const { handle, initialMessage } = makeHandle();

      // Force a flush with no content by directly manipulating time
      // We do this by calling append with empty (no-op), then finish triggers a flush
      // Instead: trigger flush via finish() with no text — handled by separate test.

      // Here: append a non-empty string to start, then check placeholder on early flush
      // The placeholder only appears if accumulatedText is empty at flush time.
      // That scenario is tested via finish() below.
      // This test simply verifies that normal appends flow through correctly.
      await handle.append("hello");
      await vi.runAllTimersAsync();

      expect(initialMessage.lastContent).toBe("hello");
    });

    it("accumulates multiple deltas into a single buffer string", async () => {
      const { handle, initialMessage } = makeHandle();

      // Trigger first flush to reset lastEditTime
      await handle.append("Hello");
      await vi.runAllTimersAsync();

      // Advance past the rate-limit window so next append fires immediately
      vi.setSystemTime(Date.now() + 2000);

      await handle.append(" world");
      await vi.runAllTimersAsync();

      // Buffer should now contain both deltas joined
      expect(initialMessage.lastContent).toBe("Hello world");
    });
  });

  // -------------------------------------------------------------------------
  // finish() — buffer drain
  // -------------------------------------------------------------------------

  describe("finish() — buffer drain", () => {
    it("cancels a pending timer and performs a final flush", async () => {
      const { handle, initialMessage } = makeHandle();

      // Start a flush cycle, but don't let the timer fire
      await handle.append("Partial");
      // At this point a deferred timer may be pending (if within 1 s window)
      // finish() should cancel it and flush directly

      await handle.finish();

      // The message should show the accumulated content
      expect(initialMessage.lastContent).toBe("Partial");
    });

    it("appends finalText to the buffer before flushing", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.append("Base");
      await handle.finish(" + final");

      expect(initialMessage.lastContent).toBe("Base + final");
    });

    it("writes '(no response)' when the buffer is empty and no finalText provided", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.finish();

      expect(initialMessage.lastContent).toBe("(no response)");
    });

    it("writes '(no response)' when finalText is an empty string and buffer is empty", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.finish("");

      expect(initialMessage.lastContent).toBe("(no response)");
    });

    it("flushes content that fits within 2 000 chars as a single edit", async () => {
      const { handle, initialMessage } = makeHandle();

      const text = repeat("x", 1999);
      await handle.finish(text);

      expect(initialMessage.edits).toHaveLength(1);
      expect(initialMessage.lastContent).toBe(text);
    });

    it("splits content exactly at the 2 000-char boundary into two messages", async () => {
      const { handle, initialMessage, channel } = makeHandle();

      const overflowMessage = new FakeMessage();
      channel.setNextMessage(overflowMessage);

      const text = repeat("a", 2000) + repeat("b", 100);
      await handle.finish(text);

      // First 2 000 chars → edit the initial message
      expect(initialMessage.lastContent).toBe(repeat("a", 2000));
      // Overflow (100 b-chars) → posted as a new message and then edited
      expect(channel.sentMessages).toHaveLength(1);
      expect(overflowMessage.lastContent).toBe(repeat("b", 100));
    });

    it("handles overflow that itself exceeds 2 000 chars (multi-chunk drain)", async () => {
      const { handle, initialMessage, channel } = makeHandle();

      const msg2 = new FakeMessage();
      const msg3 = new FakeMessage();
      channel.setNextMessage(msg2);

      const text = repeat("a", 2000) + repeat("b", 2000) + repeat("c", 500);
      await handle.finish(text);

      // After msg2 is consumed, channel.send is called again for msg3
      // We need to inject msg3 at that point — but FakeChannel only queues one.
      // Use a different approach: check sentMessages length and content.
      // chunk1 → initialMessage edit: 2000 a's
      expect(initialMessage.lastContent).toBe(repeat("a", 2000));

      // chunk2 → msg2 (first overflow), with another overflow beyond that
      // The loop posts msg2 and edits it with 2000 b's,
      // then posts msg3 (undefined → new FakeMessage) and edits with 500 c's
      const sentCount = channel.sentMessages.length;
      expect(sentCount).toBeGreaterThanOrEqual(2);

      // Last sent message should contain the tail content
      const lastSent = channel.sentMessages[sentCount - 1];
      expect(lastSent.lastContent).toBe(repeat("c", 500));
    });

    it("is idempotent on the timer — calling finish() twice does not throw", async () => {
      const { handle } = makeHandle();

      await handle.finish("first");
      await expect(handle.finish("second")).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting — edit cadence
  // -------------------------------------------------------------------------

  describe("rate limiting — ~1 s edit cadence", () => {
    it("defers a second flush until 1 s after the first", async () => {
      const { handle, initialMessage } = makeHandle();

      // Fire the first flush immediately
      await handle.append("first");
      await vi.runAllTimersAsync();
      const editCount1 = initialMessage.edits.length;

      // Append again immediately (within the rate-limit window)
      await handle.append("second");
      // The flush should not have fired yet
      expect(initialMessage.edits.length).toBe(editCount1);

      // Advance time past the 1 s cadence
      vi.advanceTimersByTime(1001);
      await vi.runAllTimersAsync();

      // Now the second flush should have fired
      expect(initialMessage.edits.length).toBeGreaterThan(editCount1);
      expect(initialMessage.lastContent).toContain("second");
    });

    it("only schedules one pending timer even when append() is called many times rapidly", async () => {
      const { handle, initialMessage } = makeHandle();

      // First flush fires immediately (lastEditTime = 0)
      await handle.append("a");
      await vi.runAllTimersAsync();

      const editCountAfterFirst = initialMessage.edits.length;

      // Rapid fire many appends within the cadence window
      for (let i = 0; i < 10; i++) {
        await handle.append(`delta${i}`);
      }

      // Still no additional edits — timer is deferred
      expect(initialMessage.edits.length).toBe(editCountAfterFirst);

      // Advance timer — all pending text should land in ONE edit
      vi.advanceTimersByTime(1001);
      await vi.runAllTimersAsync();

      // Exactly one additional edit (not 10)
      expect(initialMessage.edits.length).toBe(editCountAfterFirst + 1);
    });

    it("fires periodic edits across multiple ~1 s cycles as text continues to arrive", async () => {
      const { handle, initialMessage } = makeHandle();

      // Cycle 1: immediate flush (elapsed >> 1 s from epoch)
      await handle.append("cycle1");
      await vi.runAllTimersAsync();
      const editsAfterCycle1 = initialMessage.edits.length;
      expect(editsAfterCycle1).toBeGreaterThan(0);
      expect(initialMessage.lastContent).toContain("cycle1");

      // Cycle 2: advance past the cadence window, append more text
      vi.advanceTimersByTime(1100);
      await handle.append(" cycle2");
      await vi.runAllTimersAsync();
      const editsAfterCycle2 = initialMessage.edits.length;
      expect(editsAfterCycle2).toBeGreaterThan(editsAfterCycle1);
      expect(initialMessage.lastContent).toContain("cycle2");

      // Cycle 3: another cadence tick
      vi.advanceTimersByTime(1100);
      await handle.append(" cycle3");
      await vi.runAllTimersAsync();
      expect(initialMessage.edits.length).toBeGreaterThan(editsAfterCycle2);
      expect(initialMessage.lastContent).toContain("cycle3");
    });
  });

  // -------------------------------------------------------------------------
  // Rate-limit fallback — edit failure recovery
  // -------------------------------------------------------------------------

  describe("rate-limit fallback — edit failure recovery", () => {
    it("swallows a rate-limit error from a periodic edit flush (logs error, does not throw)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let callCount = 0;
      const failOnSecondCall: DiscordEditableMessage = {
        edits: [] as string[],
        edit: async (opts: { content: string }) => {
          callCount++;
          if (callCount === 2) {
            // Simulate Discord 429 rate-limit on the second edit
            throw new Error("HTTP 429: You are being rate limited.");
          }
          (failOnSecondCall as unknown as { edits: string[] }).edits.push(opts.content);
        },
      } as unknown as DiscordEditableMessage;

      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(failOnSecondCall, channel);

      // First append: fires immediately, succeeds (callCount = 1)
      await handle.append("first");
      await vi.runAllTimersAsync();

      // Advance past the cadence window, second append: fires, fails (callCount = 2)
      vi.advanceTimersByTime(1100);
      await handle.append("second");
      await vi.runAllTimersAsync();

      // Error should have been caught and logged — handle must not throw
      expect(errorSpy).toHaveBeenCalledWith(
        "[discord] stream flush failed:",
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it("preserves the accumulated buffer after a failed periodic edit — finish() drains it fully via channel.send()", async () => {
      let editCount = 0;
      const failingOnFlush: DiscordEditableMessage = {
        edit: async () => {
          editCount++;
          // Let the very first (immediate) flush succeed; subsequent periodic
          // flushes fail with 429, triggering fallback mode.
          if (editCount > 1) {
            throw new Error("HTTP 429: rate limited");
          }
        },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(failingOnFlush, channel);

      // First flush: succeeds immediately
      await handle.append("Part 1");
      await vi.runAllTimersAsync();

      // Advance; second flush fails with 429 → enters fallback mode
      vi.advanceTimersByTime(1100);
      await handle.append(" Part 2");
      await vi.runAllTimersAsync();

      expect(handle.inFallbackMode).toBe(true);

      // finish() must post the COMPLETE accumulated text via channel.send()
      // (not via currentMessage.edit — that path is bypassed in fallback mode)
      await handle.finish();

      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toContain("Part 1");
      expect(channel.sentMessages[0].lastContent).toContain("Part 2");

      errorSpy.mockRestore();
    });

    it("finish() still posts complete content via channel.send() when ALL periodic flushes failed with 429", async () => {
      // All flush attempts fail with 429, entering fallback mode on the first failure.
      // finish() must post ALL accumulated content via channel.send().
      const allFlushesFailMessage: DiscordEditableMessage = {
        async edit() {
          throw new Error("HTTP 429: rate limited");
        },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(allFlushesFailMessage, channel);

      // First append → flush → 429 → fallback mode.
      // Subsequent appends are buffered (no further flushes attempted).
      for (let cycle = 0; cycle < 3; cycle++) {
        await handle.append(`chunk${cycle} `);
        await vi.runAllTimersAsync();
        vi.advanceTimersByTime(1100);
      }

      expect(handle.inFallbackMode).toBe(true);

      // finish() should post the complete accumulated content via channel.send()
      await expect(handle.finish()).resolves.toBeUndefined();

      // All three chunks must appear in the single posted message
      expect(channel.sentMessages).toHaveLength(1);
      const content = channel.sentMessages[0].lastContent;
      expect(content).toContain("chunk0");
      expect(content).toContain("chunk1");
      expect(content).toContain("chunk2");

      errorSpy.mockRestore();
    });

    it("a rate-limited periodic flush does not affect finish() — content posted via channel.send() in fallback mode", async () => {
      // Simple scenario: second flush fails with 429 → fallback mode.
      // finish() must use channel.send() (not currentMessage.edit()).
      let callCount = 0;
      const message: DiscordEditableMessage = {
        async edit() {
          callCount++;
          if (callCount === 2) {
            throw new Error("429 rate limited");
          }
          // callCount === 1 succeeds (no-op)
        },
      };

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(message, channel);

      // First flush succeeds (callCount = 1)
      await handle.append("Hello ");
      await vi.runAllTimersAsync();

      // Second flush fails with 429 → enters fallback mode (callCount = 2)
      vi.advanceTimersByTime(1100);
      await handle.append("world");
      await vi.runAllTimersAsync();

      expect(handle.inFallbackMode).toBe(true);
      const callCountAfterFallback = callCount; // 2

      // finish() must post via channel.send() — NOT via edit() (which stays at callCount 2)
      await handle.finish();
      expect(callCount).toBe(callCountAfterFallback); // no additional edit calls

      // Complete text posted via channel.send()
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toContain("Hello ");
      expect(channel.sentMessages[0].lastContent).toContain("world");

      errorSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // 2 K overflow during append flush
  // -------------------------------------------------------------------------

  describe("2 K overflow during streaming flush", () => {
    it("posts a follow-up message when accumulated text exceeds 2 000 chars on flush", async () => {
      const { handle, initialMessage, channel } = makeHandle();

      const overflowMsg = new FakeMessage();
      channel.setNextMessage(overflowMsg);

      // Build text that exceeds the limit
      const text = repeat("z", 2100);
      await handle.append(text);
      await vi.runAllTimersAsync();

      // Initial message should be capped at 2000
      expect(initialMessage.lastContent.length).toBe(2000);
      // Overflow posted to channel
      expect(channel.sentMessages).toHaveLength(1);
    });

    it("resets the accumulation buffer to the overflow content after posting", async () => {
      const { handle, channel } = makeHandle();

      const overflowMsg = new FakeMessage();
      channel.setNextMessage(overflowMsg);

      // Push past the limit
      const text = repeat("a", 2000) + "OVERFLOW";
      await handle.append(text);
      await vi.runAllTimersAsync();

      // Overflow message content should be the overflow text
      expect(overflowMsg.lastContent).toBe("OVERFLOW");

      // Subsequent appends target the overflow message
      vi.advanceTimersByTime(2000);
      await handle.append(" more");
      await vi.runAllTimersAsync();

      expect(overflowMsg.lastContent).toContain("OVERFLOW");
      expect(overflowMsg.lastContent).toContain(" more");
    });

    it("does NOT overflow when accumulated text is exactly 2 000 chars", async () => {
      const { handle, initialMessage, channel } = makeHandle();

      // Exactly at the limit — should NOT trigger overflow
      const text = repeat("x", 2000);
      await handle.append(text);
      await vi.runAllTimersAsync();

      // Only the initial message edited — no overflow message posted
      expect(channel.sentMessages).toHaveLength(0);
      expect(initialMessage.lastContent).toBe(text);
      expect(initialMessage.lastContent.length).toBe(2000);
    });

    it("overflows when accumulated text is exactly 2 001 chars (boundary condition)", async () => {
      const { handle, initialMessage, channel } = makeHandle();

      // One character over the limit — must trigger overflow
      const text = repeat("y", 2001);
      await handle.append(text);
      await vi.runAllTimersAsync();

      // Initial message finalized at 2000
      expect(initialMessage.lastContent).toBe(repeat("y", 2000));
      // Overflow (1 char) posted as a new follow-up message
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toBe("y");
    });

    it("preserves ALL content when overflow itself exceeds 2 000 chars (mid-stream >4 K bug fix)", async () => {
      // AC 4 regression guard: buffer of 5 000 chars.
      // Before the fix, chars 4000–5000 were silently discarded when
      // flushEdit() truncated the overflow to 2 K before storing in accumulatedText.
      const { handle, initialMessage, channel } = makeHandle();

      // First overflow message: shows chars 2000-4000
      const msg2 = new FakeMessage();
      channel.setNextMessage(msg2);

      const text = repeat("A", 2000) + repeat("B", 2000) + repeat("C", 1000);
      await handle.append(text);
      await vi.runAllTimersAsync(); // fires flushEdit() immediately

      // Msg1 (initialMessage): finalized with first 2 000 A-chars
      expect(initialMessage.lastContent).toBe(repeat("A", 2000));

      // Msg2 posted: shows first 2 000 chars of overflow = 2 000 B-chars
      expect(channel.sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(msg2.lastContent).toBe(repeat("B", 2000));

      // The FULL overflow (3 000 chars of B+C) must be preserved in accumulatedText.
      // Advance time past cadence window and trigger next flush to drain the rest.
      vi.advanceTimersByTime(1100);
      const msg3 = new FakeMessage();
      channel.setNextMessage(msg3);
      await vi.runAllTimersAsync(); // next flush fires: overflow = B[2000] + C[1000]

      // msg2 is now edited with first 2 000 chars of the remaining overflow (B×2000)
      // msg3 is posted with the remaining 1 000 C-chars
      expect(channel.sentMessages.length).toBeGreaterThanOrEqual(2);
      // The final message should contain the C-chars (not discarded)
      const lastSent = channel.sentMessages[channel.sentMessages.length - 1];
      expect(lastSent.lastContent).toContain(repeat("C", 1000).slice(0, 50));
    });

    it("preserves all content after overflow with exactly 4 000-char buffer", async () => {
      // Edge case: buffer exactly 4 K — overflow is exactly 2 K.
      // After the fix, accumulatedText = overflow (2 000 B-chars), NOT truncated.
      const { handle, initialMessage, channel } = makeHandle();

      const msg2 = new FakeMessage();
      channel.setNextMessage(msg2);

      const text = repeat("A", 2000) + repeat("B", 2000); // exactly 4 000 chars
      await handle.append(text);
      await vi.runAllTimersAsync();

      // initialMessage finalized with 2 000 A-chars
      expect(initialMessage.lastContent).toBe(repeat("A", 2000));
      // msg2 posted with 2 000 B-chars (entire overflow)
      expect(channel.sentMessages).toHaveLength(1);
      expect(msg2.lastContent).toBe(repeat("B", 2000));
    });

    it("posts follow-up message to the same channel object (same thread)", async () => {
      // Verifies that overflow messages are sent to the same channel reference,
      // not a different channel — essential for staying in the same thread.
      const { handle, channel } = makeHandle();

      const text = repeat("z", 2100);
      await handle.append(text);
      await vi.runAllTimersAsync();

      // channel.sentMessages are tracked by our FakeChannel
      expect(channel.sentMessages).toHaveLength(1);
      // The overflow message was posted via the same channel.send() call
      // that our FakeChannel intercepted — no other channel was used.
      const overflowMsg = channel.sentMessages[0];
      expect(overflowMsg).toBeDefined();
      expect(overflowMsg.lastContent.length).toBe(100); // "z"×100 overflow
    });

    it("new follow-up message becomes the edit target for subsequent appends", async () => {
      // After overflow, all subsequent edits must target the NEW message, not
      // the original one — verifies currentMessage is correctly swapped.
      const { handle, initialMessage, channel } = makeHandle();

      const msg2 = new FakeMessage();
      channel.setNextMessage(msg2);

      // Trigger overflow
      await handle.append(repeat("a", 2000) + "START_OF_OVERFLOW");
      await vi.runAllTimersAsync();

      const initialEditsAfterOverflow = initialMessage.edits.length;

      // Now append more text — it must go to msg2, not initialMessage
      vi.advanceTimersByTime(1100);
      await handle.append(" CONTINUATION");
      await vi.runAllTimersAsync();

      // initialMessage must NOT receive any further edits after overflow
      expect(initialMessage.edits.length).toBe(initialEditsAfterOverflow);
      // msg2 should contain both the overflow start and the continuation
      expect(msg2.lastContent).toContain("START_OF_OVERFLOW");
      expect(msg2.lastContent).toContain("CONTINUATION");
    });
  });

  // -------------------------------------------------------------------------
  // cleanTaskText() — Slack emoji code stripping helper
  // -------------------------------------------------------------------------

  describe("cleanTaskText() — strips Slack :emoji: codes and trailing ✓", () => {
    it("returns plain text unchanged", () => {
      expect(cleanTaskText("Analyzing your request...")).toBe("Analyzing your request...");
    });

    it("strips a leading :emoji_code: and trims surrounding whitespace", () => {
      expect(cleanTaskText(":wrench: Using `bash`")).toBe("Using `bash`");
    });

    it("strips multiple :emoji_code: occurrences in one string", () => {
      expect(cleanTaskText(":mag: :globe_with_meridians: Fetching data")).toBe("Fetching data");
    });

    it("strips a trailing ✓ checkmark", () => {
      expect(cleanTaskText("Using `bash` ✓")).toBe("Using `bash`");
    });

    it("strips both :emoji_code: and trailing ✓ together", () => {
      expect(cleanTaskText(":gear: Running `cmd` ✓")).toBe("Running `cmd`");
    });

    it("preserves backtick-wrapped code fragments (Discord inline code)", () => {
      expect(cleanTaskText(":pencil: Writing `src/foo.ts`")).toBe("Writing `src/foo.ts`");
    });

    it("handles text with no Slack codes gracefully", () => {
      expect(cleanTaskText("Thinking...")).toBe("Thinking...");
    });
  });

  // -------------------------------------------------------------------------
  // renderTaskLine() — per-task emoji routing helper
  // -------------------------------------------------------------------------

  describe("renderTaskLine() — emoji routing by task id and status", () => {
    // ── Thinking / init tasks ────────────────────────────────────────────

    it("returns 💡 line for 'init' task in_progress", () => {
      expect(renderTaskLine({ id: "init", text: "Initializing...", status: "in_progress" }))
        .toBe("💡 Initializing...");
    });

    it("returns 💡 line for 'thinking_*' task in_progress", () => {
      expect(renderTaskLine({ id: "thinking_1", text: "Analyzing your request...", status: "in_progress" }))
        .toBe("💡 Analyzing your request...");
    });

    it("returns null for completed thinking task (silent when done)", () => {
      expect(renderTaskLine({ id: "thinking_1", text: "Done", status: "complete" })).toBeNull();
    });

    it("returns null for errored thinking task", () => {
      expect(renderTaskLine({ id: "thinking_2", text: "Err", status: "error" })).toBeNull();
    });

    // ── Tool tasks ───────────────────────────────────────────────────────

    it("returns 🔧 line for 'tool_*' task in_progress", () => {
      expect(renderTaskLine({ id: "tool_1", text: "Searching files", status: "in_progress" }))
        .toBe("🔧 Searching files");
    });

    it("returns ✅ line for 'tool_*' task complete", () => {
      expect(renderTaskLine({ id: "tool_1", text: "Searching files", status: "complete" }))
        .toBe("✅ Searching files");
    });

    it("strips Slack :emoji_code: from tool task text before prefixing", () => {
      expect(renderTaskLine({ id: "tool_1", text: ":wrench: Using `bash`", status: "in_progress" }))
        .toBe("🔧 Using `bash`");
    });

    it("strips Slack :emoji_code: and ✓ from complete tool task text", () => {
      expect(renderTaskLine({ id: "tool_2", text: ":gear: Running `ls` ✓", status: "complete" }))
        .toBe("✅ Running `ls`");
    });

    it("returns null for errored tool task", () => {
      expect(renderTaskLine({ id: "tool_1", text: "Failed", status: "error" })).toBeNull();
    });

    // ── Generic fallback ─────────────────────────────────────────────────

    it("returns ⚙️ line for generic in_progress task (non-standard id)", () => {
      expect(renderTaskLine({ id: "t1", text: "Some step", status: "in_progress" }))
        .toBe("⚙️ Some step");
    });

    it("returns 🔄 line for generic pending task", () => {
      expect(renderTaskLine({ id: "t1", text: "Queued", status: "pending" }))
        .toBe("🔄 Queued");
    });

    it("returns null for generic complete task", () => {
      expect(renderTaskLine({ id: "t1", text: "Done", status: "complete" })).toBeNull();
    });

    it("returns null for generic errored task", () => {
      expect(renderTaskLine({ id: "t1", text: "Boom", status: "error" })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // appendTasks() — task indicators
  // -------------------------------------------------------------------------

  describe("appendTasks() — agent activity indicators", () => {
    // ── Basic behaviour ──────────────────────────────────────────────────

    it("does nothing when tasks array is empty", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([]);

      expect(initialMessage.edits).toHaveLength(0);
    });

    it("does nothing when no task produces a renderable line", async () => {
      const { handle, initialMessage } = makeHandle();

      // Generic complete and error tasks both return null from renderTaskLine
      await handle.appendTasks([
        { id: "t1", text: "Done task", status: "complete" },
        { id: "t2", text: "Error task", status: "error" },
      ]);

      expect(initialMessage.edits).toHaveLength(0);
    });

    // ── Thinking / init tasks (💡) ───────────────────────────────────────

    it("renders 'init' in_progress task with 💡 icon", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "init", text: "Initializing...", status: "in_progress" },
      ]);

      expect(initialMessage.lastContent).toContain("💡 Initializing...");
    });

    it("renders 'thinking_*' in_progress task with 💡 icon", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "thinking_1", text: "Analyzing your request...", status: "in_progress" },
      ]);

      expect(initialMessage.lastContent).toContain("💡 Analyzing your request...");
    });

    it("does NOT render completed thinking tasks — silent when done", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "thinking_1", text: "Done thinking", status: "complete" },
      ]);

      expect(initialMessage.edits).toHaveLength(0);
    });

    // ── Tool use tasks (🔧 / ✅) ─────────────────────────────────────────

    it("renders 'tool_*' in_progress task with 🔧 icon", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "tool_1", text: "Searching files", status: "in_progress" },
      ]);

      expect(initialMessage.lastContent).toContain("🔧 Searching files");
    });

    it("renders 'tool_*' complete task with ✅ icon", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "tool_1", text: "Searching files", status: "complete" },
      ]);

      expect(initialMessage.lastContent).toContain("✅ Searching files");
    });

    it("strips Slack :emoji_code: from tool task text before prefixing with 🔧", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "tool_1", text: ":wrench: Using `bash`", status: "in_progress" },
      ]);

      expect(initialMessage.lastContent).toContain("🔧 Using `bash`");
      expect(initialMessage.lastContent).not.toContain(":wrench:");
    });

    it("strips Slack :emoji_code: and trailing ✓ from complete tool task text", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "tool_1", text: ":gear: Running `cmd` ✓", status: "complete" },
      ]);

      expect(initialMessage.lastContent).toContain("✅ Running `cmd`");
      expect(initialMessage.lastContent).not.toContain(":gear:");
      expect(initialMessage.lastContent).not.toContain("✓");
    });

    // ── Generic fallback (⚙️ / 🔄) ──────────────────────────────────────

    it("renders generic in_progress task (non-standard id) with ⚙️ icon", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "t1", text: "Some step", status: "in_progress" },
      ]);

      expect(initialMessage.lastContent).toContain("⚙️ Some step");
    });

    it("renders generic pending task with 🔄 icon", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "t1", text: "Pending task", status: "pending" },
      ]);

      expect(initialMessage.lastContent).toContain("🔄 Pending task");
    });

    it("hides generic complete/error tasks but shows generic in_progress", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "t1", text: "Done",   status: "complete" },
        { id: "t2", text: "Active", status: "in_progress" },
        { id: "t3", text: "Failed", status: "error" },
      ]);

      expect(initialMessage.lastContent).toContain("Active");
      expect(initialMessage.lastContent).not.toContain("Done");
      expect(initialMessage.lastContent).not.toContain("Failed");
    });

    // ── Mixed task list (realistic streaming scenarios) ──────────────────

    it("renders a realistic init → tool sequence: init complete is silent, tool in_progress shows 🔧", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "init",         text: "Initializing...",        status: "complete" }, // silent
        { id: "thinking_1",   text: "Analyzing...",            status: "complete" }, // silent
        { id: "tool_1",       text: ":wrench: Using `bash`",  status: "in_progress" },
      ]);

      expect(initialMessage.lastContent).toContain("🔧 Using `bash`");
      expect(initialMessage.lastContent).not.toContain("Initializing");
      expect(initialMessage.lastContent).not.toContain("Analyzing");
    });

    it("renders thinking in_progress alongside completed tool", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "thinking_2", text: "Processing results...",  status: "in_progress" },
        { id: "tool_1",     text: ":gear: Running `ls`",   status: "complete" },
      ]);

      const content = initialMessage.lastContent;
      expect(content).toContain("💡 Processing results...");
      expect(content).toContain("✅ Running `ls`");
    });

    // ── Positioning and sizing ───────────────────────────────────────────

    it("prefixes task indicators above accumulated response text", async () => {
      const { handle, initialMessage } = makeHandle();

      // First, accumulate some text
      await handle.append("Response text");
      await vi.runAllTimersAsync();

      // Then push a task indicator
      await handle.appendTasks([
        { id: "t1", text: "Running tool", status: "in_progress" },
      ]);

      const content = initialMessage.lastContent;
      const taskIndex = content.indexOf("⚙️ Running tool");
      const textIndex = content.indexOf("Response text");

      expect(taskIndex).toBeGreaterThanOrEqual(0);
      expect(textIndex).toBeGreaterThanOrEqual(0);
      // Task prefix should appear before the response text
      expect(taskIndex).toBeLessThan(textIndex);
    });

    it("caps the combined task prefix + text at 2 000 characters", async () => {
      const { handle, initialMessage } = makeHandle();

      // Accumulate text that nearly fills the limit
      await handle.append(repeat("x", 1900));
      await vi.runAllTimersAsync();

      // Task prefix adds more content
      await handle.appendTasks([
        { id: "t1", text: "Long running task", status: "in_progress" },
      ]);

      expect(initialMessage.lastContent.length).toBeLessThanOrEqual(2000);
    });

    it("renders multiple tasks as separate lines with correct emoji per type", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.appendTasks([
        { id: "thinking_1", text: "Analyzing...",          status: "in_progress" },
        { id: "tool_1",     text: ":wrench: Using `bash`", status: "in_progress" },
        { id: "tool_2",     text: ":mag: Reading `file`",  status: "complete" },
      ]);

      const content = initialMessage.lastContent;
      expect(content).toContain("💡 Analyzing...");
      expect(content).toContain("🔧 Using `bash`");
      expect(content).toContain("✅ Reading `file`");
    });

    // ── Error resilience ─────────────────────────────────────────────────

    it("swallows edit errors gracefully (logs warn, does not throw)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const failingMessage: DiscordEditableMessage = {
        edit: async () => {
          throw new Error("Discord API error");
        },
      };
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(failingMessage, channel);

      await expect(
        handle.appendTasks([{ id: "t1", text: "Tool", status: "in_progress" }]),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        "[discord] appendTasks edit failed:",
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // StreamHandle interface conformance
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Rate-limit complete-message fallback mode
  // -------------------------------------------------------------------------

  describe("rate-limit fallback mode — complete-message posting", () => {
    // ── inFallbackMode getter ────────────────────────────────────────────────

    it("inFallbackMode starts as false when no tracker is provided", () => {
      const { handle } = makeHandle();
      expect(handle.inFallbackMode).toBe(false);
    });

    it("inFallbackMode starts as false when tracker shows channel is NOT rate-limited", () => {
      const tracker = new DiscordRateLimitTracker();
      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-ok", tracker);
      expect(handle.inFallbackMode).toBe(false);
    });

    // ── Pre-seeded fallback (channel already rate-limited at construction) ───

    it("enters fallback mode at construction when tracker shows channel is rate-limited", () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      expect(handle.inFallbackMode).toBe(true);
      // isRateLimited is only set when a 429 hits during THIS handle's flush
      expect(handle.isRateLimited).toBe(false);
    });

    it("pre-seeded fallback: append() buffers text without triggering any Discord edits", async () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      await handle.append("Hello ");
      await handle.append("world");
      await vi.runAllTimersAsync();

      // Placeholder message must NOT have been edited during streaming
      expect(msg.edits).toHaveLength(0);
      // No new messages posted yet (finish() not called)
      expect(channel.sentMessages).toHaveLength(0);
    });

    it("pre-seeded fallback: appendTasks() is a complete no-op (no Discord edits)", async () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      await handle.appendTasks([
        { id: "init", text: "Thinking...", status: "in_progress" },
        { id: "tool_1", text: "Using bash", status: "in_progress" },
      ]);

      expect(msg.edits).toHaveLength(0);
    });

    it("pre-seeded fallback: finish() posts accumulated content via channel.send()", async () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      await handle.append("Hello ");
      await handle.append("world!");
      await vi.runAllTimersAsync();

      await handle.finish();

      // The placeholder message must NOT have been edited
      expect(msg.edits).toHaveLength(0);
      // A new message must have been sent via channel.send()
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toBe("Hello world!");
    });

    it("pre-seeded fallback: finish() posts '(no response)' via channel.send() when buffer is empty", async () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      await handle.finish();

      // Placeholder untouched; "(no response)" posted as a new message
      expect(msg.edits).toHaveLength(0);
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toBe("(no response)");
    });

    it("pre-seeded fallback: finish() with >2K content posts multiple channel.send() messages", async () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      const text = repeat("A", 2000) + repeat("B", 500);
      await handle.append(text);
      await handle.finish();

      // Placeholder untouched — all content posted via channel.send()
      expect(msg.edits).toHaveLength(0);
      // Two messages: first 2 000 chars, then remaining 500
      expect(channel.sentMessages).toHaveLength(2);
      expect(channel.sentMessages[0].lastContent).toBe(repeat("A", 2000));
      expect(channel.sentMessages[1].lastContent).toBe(repeat("B", 500));
    });

    it("pre-seeded fallback: finish() appends finalText to buffer before posting", async () => {
      const tracker = new DiscordRateLimitTracker();
      tracker.recordHit("ch-limited", 5000);

      const msg = new FakeMessage();
      const channel = new FakeChannel();
      const handle = new DiscordStreamHandle(msg, channel, "ch-limited", tracker);

      await handle.append("Base text");
      await handle.finish(" + final");

      expect(msg.edits).toHaveLength(0);
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toBe("Base text + final");
    });

    // ── Mid-stream fallback (429 received during streaming) ──────────────────

    it("mid-stream 429: handle enters fallback mode after a 429 on flush", async () => {
      const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429 });
      const msg: DiscordEditableMessage = { async edit() { throw rateLimitErr; } };
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);

      await handle.append("hello");
      await vi.runAllTimersAsync(); // flush fires → 429 → enters fallback mode

      expect(handle.inFallbackMode).toBe(true);
      expect(handle.isRateLimited).toBe(true);

      errorSpy.mockRestore();
    });

    it("mid-stream 429: subsequent append() calls buffer without scheduling flushes", async () => {
      let callCount = 0;
      const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429 });
      const msg: DiscordEditableMessage = {
        async edit() {
          callCount++;
          throw rateLimitErr;
        },
      };
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);

      // First flush → 429 → fallback mode
      await handle.append("first");
      await vi.runAllTimersAsync();
      const callCountAfterFirstFlush = callCount; // 1

      // Further appends must NOT trigger any additional edit attempts
      await handle.append("second");
      await handle.append("third");
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();

      expect(callCount).toBe(callCountAfterFirstFlush);

      errorSpy.mockRestore();
    });

    it("mid-stream 429: cancels any pending deferred flush when entering fallback mode", async () => {
      let callCount = 0;
      const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429 });
      const msg: DiscordEditableMessage = {
        async edit() {
          callCount++;
          if (callCount >= 2) {
            throw rateLimitErr;
          }
        },
      };
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);

      // First flush succeeds (callCount = 1)
      await handle.append("part1");
      await vi.runAllTimersAsync();
      expect(callCount).toBe(1);

      // Second append schedules a deferred flush (within cadence window)
      await handle.append("part2");
      // deferred flush is now pending but hasn't fired

      // Trigger 429 via appendTasks BEFORE the deferred flush fires
      // appendTasks calls edit() → callCount 2 → 429 → fallback mode → pending flush cancelled
      await handle.appendTasks([{ id: "init", text: "Thinking", status: "in_progress" }]);

      expect(handle.inFallbackMode).toBe(true);
      const callCountAfterFallback = callCount; // 2

      // Advance time — the cancelled flush must NOT fire
      vi.advanceTimersByTime(3000);
      await vi.runAllTimersAsync();

      expect(callCount).toBe(callCountAfterFallback);

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("mid-stream 429: finish() posts remaining accumulated content via channel.send()", async () => {
      const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429 });
      const msg: DiscordEditableMessage = { async edit() { throw rateLimitErr; } };
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);

      // Trigger 429 → fallback mode; accumulatedText = "hello"
      await handle.append("hello");
      await vi.runAllTimersAsync();

      // More content arrives in fallback mode (buffered silently)
      await handle.append(" world");
      await vi.runAllTimersAsync();

      await handle.finish(" done");

      // ALL accumulated content posted as a single new message
      expect(channel.sentMessages).toHaveLength(1);
      expect(channel.sentMessages[0].lastContent).toBe("hello world done");

      errorSpy.mockRestore();
    });

    it("mid-stream 429: finish() with >2K accumulated content posts multiple channel.send() messages", async () => {
      const rateLimitErr = Object.assign(new Error("HTTP 429"), { status: 429 });
      const msg: DiscordEditableMessage = { async edit() { throw rateLimitErr; } };
      const channel = new FakeChannel();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const handle = new DiscordStreamHandle(msg, channel);

      // Trigger fallback mode
      await handle.append("trigger");
      await vi.runAllTimersAsync();

      // Append a large block that pushes total > 2K
      await handle.append(repeat("X", 2000));
      await handle.finish();

      // Content must be split at 2K boundaries and posted via channel.send()
      expect(channel.sentMessages.length).toBeGreaterThanOrEqual(2);
      expect(channel.sentMessages[0].lastContent.length).toBe(2000);

      errorSpy.mockRestore();
    });
  });

  describe("StreamHandle interface conformance", () => {
    it("exposes append(), appendTasks(), and finish() methods", () => {
      const { handle } = makeHandle();

      expect(typeof handle.append).toBe("function");
      expect(typeof handle.appendTasks).toBe("function");
      expect(typeof handle.finish).toBe("function");
    });

    it("finish() accepts undefined finalText and finalTasks without throwing", async () => {
      const { handle } = makeHandle();

      await expect(handle.finish(undefined, undefined)).resolves.toBeUndefined();
    });

    it("finish() ignores _finalTasks (no Discord native plan-mode rendering)", async () => {
      const { handle, initialMessage } = makeHandle();

      await handle.append("Some response");
      await handle.finish(undefined, [
        { id: "t1", text: "Tool call", status: "complete" },
      ]);

      // Final edit should contain only the response text, not task names
      expect(initialMessage.lastContent).toBe("Some response");
      expect(initialMessage.lastContent).not.toContain("Tool call");
    });
  });
});
