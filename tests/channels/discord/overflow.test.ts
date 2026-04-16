/**
 * Unit tests for src/channels/discord/overflow.ts
 *
 * All Discord API interactions are replaced by lightweight in-memory fakes —
 * no live network calls are made.
 *
 * Coverage:
 * - `splitIntoChunks`: pure split logic (empty, exact limit, over limit, > 4 K)
 * - `flushToMessage`: fits, overflow to new message, mid-stream > 4 K edge case
 * - `drainBuffer`: empty fallback, single chunk, multi-chunk, > 4 K buffer
 * - `sendChunks`: empty fallback, single chunk, multi-chunk (fallback mode)
 */

import { describe, it, expect } from "vitest";
import {
  splitIntoChunks,
  flushToMessage,
  drainBuffer,
  sendChunks,
} from "../../../src/channels/discord/overflow.js";
import { DISCORD_MESSAGE_LIMIT } from "../../../src/channels/discord/constants.js";
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

  async edit(options: { content: string }): Promise<void> {
    this.edits.push(options.content);
  }

  /** Convenience: the most recent edit content. */
  get lastContent(): string {
    return this.edits[this.edits.length - 1] ?? "";
  }
}

/** Fake channel that records all sent messages and returns FakeMessage instances. */
class FakeChannel implements DiscordSendableChannel {
  /** All messages posted via `send()`, in order. */
  public sentMessages: FakeMessage[] = [];

  async send(options: { content: string }): Promise<FakeMessage> {
    const msg = new FakeMessage();
    // Record the initial `send()` content as the first "edit" so
    // FakeMessage.lastContent reflects what Discord was given on send.
    msg.edits.push(options.content);
    this.sentMessages.push(msg);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a string of `n` repetitions of character `c`. */
function repeat(c: string, n: number): string {
  return c.repeat(n);
}

/** Build a fresh FakeMessage + FakeChannel pair. */
function makePrimitives(): { msg: FakeMessage; channel: FakeChannel } {
  return { msg: new FakeMessage(), channel: new FakeChannel() };
}

// ---------------------------------------------------------------------------
// splitIntoChunks — pure function
// ---------------------------------------------------------------------------

describe("splitIntoChunks", () => {
  it("returns [] for empty string", () => {
    expect(splitIntoChunks("")).toEqual([]);
  });

  it("returns [] for falsy-like empty", () => {
    // Ensure no chunks for genuinely-empty content
    expect(splitIntoChunks("")).toHaveLength(0);
  });

  it("returns a single chunk when text fits within the limit", () => {
    const text = "Hello, world!";
    const chunks = splitIntoChunks(text);
    expect(chunks).toEqual([text]);
  });

  it("returns a single chunk when text is exactly the limit", () => {
    const text = repeat("a", DISCORD_MESSAGE_LIMIT);
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
  });

  it("returns two chunks when text is one character over the limit", () => {
    const text = repeat("a", DISCORD_MESSAGE_LIMIT + 1);
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(chunks[1]).toHaveLength(1);
  });

  it("returns two chunks for text exactly 2× the limit", () => {
    const text = repeat("b", DISCORD_MESSAGE_LIMIT * 2);
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(2);
    chunks.forEach((c) => expect(c).toHaveLength(DISCORD_MESSAGE_LIMIT));
  });

  it("returns three chunks for text > 4 K (mid-stream overflow scenario)", () => {
    // 4001 chars → 3 chunks: [2000, 2000, 1]
    const text = repeat("c", DISCORD_MESSAGE_LIMIT * 2 + 1);
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(chunks[1]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(chunks[2]).toHaveLength(1);
  });

  it("respects a custom limit", () => {
    const chunks = splitIntoChunks("abcde", 2);
    expect(chunks).toEqual(["ab", "cd", "e"]);
  });

  it("preserves the full content across chunks (no chars lost)", () => {
    const text = repeat("x", 5001);
    const chunks = splitIntoChunks(text);
    expect(chunks.join("")).toBe(text);
  });

  it("returns one chunk per character when limit is 1", () => {
    const text = "abc";
    const chunks = splitIntoChunks(text, 1);
    expect(chunks).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// flushToMessage
// ---------------------------------------------------------------------------

describe("flushToMessage", () => {
  it("edits currentMessage in-place when text fits within 2 K", async () => {
    const { msg, channel } = makePrimitives();
    const text = "Hello, Discord!";

    const result = await flushToMessage(text, msg, channel);

    expect(result.activeMessage).toBe(msg);
    expect(result.remainingBuffer).toBe("");
    expect(msg.edits).toEqual([text]);
    expect(channel.sentMessages).toHaveLength(0);
  });

  it("edits currentMessage in-place when text is exactly 2 K", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("a", DISCORD_MESSAGE_LIMIT);

    const result = await flushToMessage(text, msg, channel);

    expect(result.activeMessage).toBe(msg);
    expect(result.remainingBuffer).toBe("");
    expect(msg.edits).toEqual([text]);
    expect(channel.sentMessages).toHaveLength(0);
  });

  it("returns empty remainingBuffer for empty text (treated as no overflow)", async () => {
    const { msg, channel } = makePrimitives();
    const result = await flushToMessage("", msg, channel);

    expect(result.activeMessage).toBe(msg);
    expect(result.remainingBuffer).toBe("");
    expect(msg.edits).toEqual([""]);
  });

  it("handles overflow: edits with first 2 K, sends remainder as new message", async () => {
    const { msg, channel } = makePrimitives();
    // 2001 chars: part1 = 2000 chars, overflow = 1 char, remainingBuffer = ""
    const part1 = repeat("a", DISCORD_MESSAGE_LIMIT);
    const extra = "Z";
    const text = part1 + extra;

    const result = await flushToMessage(text, msg, channel);

    expect(result.activeMessage).not.toBe(msg);
    expect(result.remainingBuffer).toBe("");
    expect(msg.edits).toEqual([part1]);
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(extra);
  });

  it("handles overflow: returns a new activeMessage pointing to the follow-up", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("x", DISCORD_MESSAGE_LIMIT + 500);

    const result = await flushToMessage(text, msg, channel);

    // The new activeMessage should be what channel.send() returned.
    expect(result.activeMessage).toBe(channel.sentMessages[0]);
    expect(result.activeMessage.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT),
    );
  });

  it("handles overflow exactly at 4 K boundary (remainingBuffer empty)", async () => {
    const { msg, channel } = makePrimitives();
    // Exactly 4000 chars: part1 = 2000, overflowDisplay = 2000, remainingBuffer = ""
    const text = repeat("y", DISCORD_MESSAGE_LIMIT * 2);

    const result = await flushToMessage(text, msg, channel);

    expect(msg.edits).toEqual([text.slice(0, DISCORD_MESSAGE_LIMIT)]);
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT),
    );
    expect(result.remainingBuffer).toBe("");
  });

  it("mid-stream > 4 K: returns non-empty remainingBuffer (critical edge case)", async () => {
    const { msg, channel } = makePrimitives();
    // 4001 chars: part1 = 2000, overflowDisplay = 2000, remainingBuffer = 1 char
    const text = repeat("z", DISCORD_MESSAGE_LIMIT * 2 + 1);

    const result = await flushToMessage(text, msg, channel);

    // currentMessage gets the first 2000 chars
    expect(msg.edits).toEqual([text.slice(0, DISCORD_MESSAGE_LIMIT)]);
    // A new follow-up message is sent with the next 2000 chars
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT, DISCORD_MESSAGE_LIMIT * 2),
    );
    // The last 1 char is returned as remainingBuffer — must NOT be discarded
    expect(result.remainingBuffer).toBe("z");
    expect(result.remainingBuffer).toHaveLength(1);
  });

  it("mid-stream > 6 K: remainingBuffer contains all chars beyond 4 K", async () => {
    const { msg, channel } = makePrimitives();
    // 6001 chars: part1 = 2000, overflowDisplay = 2000, remainingBuffer = 2001
    const text = repeat("w", DISCORD_MESSAGE_LIMIT * 3 + 1);

    const result = await flushToMessage(text, msg, channel);

    expect(msg.edits).toEqual([text.slice(0, DISCORD_MESSAGE_LIMIT)]);
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT, DISCORD_MESSAGE_LIMIT * 2),
    );
    expect(result.remainingBuffer).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT * 2),
    );
    expect(result.remainingBuffer).toHaveLength(DISCORD_MESSAGE_LIMIT + 1);
  });

  it("no content is silently discarded: part1 + overflowDisplay + remainingBuffer = original", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("q", DISCORD_MESSAGE_LIMIT * 2 + 500);

    const result = await flushToMessage(text, msg, channel);

    const part1 = msg.edits[0]!;
    const overflowDisplay = channel.sentMessages[0]!.lastContent;
    const remaining = result.remainingBuffer;

    expect(part1 + overflowDisplay + remaining).toBe(text);
  });

  it("re-throws errors from currentMessage.edit()", async () => {
    const channel = new FakeChannel();
    const brokenMsg: DiscordEditableMessage = {
      async edit() {
        throw new Error("edit failed");
      },
    };

    await expect(flushToMessage("hello", brokenMsg, channel)).rejects.toThrow(
      "edit failed",
    );
  });

  it("re-throws errors from channel.send() on overflow", async () => {
    const msg = new FakeMessage();
    const brokenChannel: DiscordSendableChannel = {
      async send() {
        throw new Error("send failed");
      },
    };
    const text = repeat("a", DISCORD_MESSAGE_LIMIT + 1);

    await expect(flushToMessage(text, msg, brokenChannel)).rejects.toThrow(
      "send failed",
    );
  });
});

// ---------------------------------------------------------------------------
// drainBuffer
// ---------------------------------------------------------------------------

describe("drainBuffer", () => {
  it("edits with default empty fallback when buffer is empty", async () => {
    const { msg, channel } = makePrimitives();

    const finalMsg = await drainBuffer("", msg, channel);

    expect(finalMsg).toBe(msg);
    expect(msg.edits).toEqual(["(no response)"]);
    expect(channel.sentMessages).toHaveLength(0);
  });

  it("accepts a custom emptyFallback for empty buffer", async () => {
    const { msg, channel } = makePrimitives();

    await drainBuffer("", msg, channel, { emptyFallback: "Agent had nothing to say." });

    expect(msg.edits).toEqual(["Agent had nothing to say."]);
  });

  it("edits currentMessage once when buffer fits in 2 K", async () => {
    const { msg, channel } = makePrimitives();
    const text = "Short response.";

    await drainBuffer(text, msg, channel);

    expect(msg.edits).toEqual([text]);
    expect(channel.sentMessages).toHaveLength(0);
  });

  it("edits currentMessage when buffer is exactly 2 K", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("a", DISCORD_MESSAGE_LIMIT);

    await drainBuffer(text, msg, channel);

    expect(msg.edits).toEqual([text]);
    expect(channel.sentMessages).toHaveLength(0);
  });

  it("posts a follow-up message when buffer exceeds 2 K", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("b", DISCORD_MESSAGE_LIMIT + 1);

    await drainBuffer(text, msg, channel);

    expect(msg.edits).toEqual([text.slice(0, DISCORD_MESSAGE_LIMIT)]);
    expect(channel.sentMessages).toHaveLength(1);
    // The placeholder is overwritten with the overflow content immediately
    expect(channel.sentMessages[0]!.lastContent).toBe("b");
  });

  it("drains exactly 4 K across two messages", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("c", DISCORD_MESSAGE_LIMIT * 2);

    await drainBuffer(text, msg, channel);

    expect(msg.edits).toEqual([text.slice(0, DISCORD_MESSAGE_LIMIT)]);
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT),
    );
  });

  it("drains > 4 K across three messages (verifies no content loss)", async () => {
    const { msg, channel } = makePrimitives();
    // 5000 chars → 3 messages: [2000, 2000, 1000]
    const text = repeat("d", DISCORD_MESSAGE_LIMIT * 2 + 1000);

    const finalMsg = await drainBuffer(text, msg, channel);

    expect(msg.edits).toEqual([text.slice(0, DISCORD_MESSAGE_LIMIT)]);
    expect(channel.sentMessages).toHaveLength(2);
    expect(channel.sentMessages[0]!.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT, DISCORD_MESSAGE_LIMIT * 2),
    );
    expect(channel.sentMessages[1]!.lastContent).toBe(
      text.slice(DISCORD_MESSAGE_LIMIT * 2),
    );
    // Returns the final active message
    expect(finalMsg).toBe(channel.sentMessages[1]);
  });

  it("no content is silently discarded across all messages", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("e", DISCORD_MESSAGE_LIMIT * 3 + 750);

    await drainBuffer(text, msg, channel);

    const allContent =
      msg.edits[0]! +
      channel.sentMessages.map((m) => m.lastContent).join("");
    expect(allContent).toBe(text);
  });

  it("returns currentMessage (unchanged) when buffer is empty", async () => {
    const { msg, channel } = makePrimitives();
    const result = await drainBuffer("", msg, channel);
    expect(result).toBe(msg);
  });

  it("returns the last sent message after multi-overflow drain", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("f", DISCORD_MESSAGE_LIMIT * 3);

    const result = await drainBuffer(text, msg, channel);

    expect(channel.sentMessages).toHaveLength(2);
    expect(result).toBe(channel.sentMessages[1]);
  });

  it("uses default THINKING_PLACEHOLDER as placeholder for intermediate messages", async () => {
    const { msg, channel } = makePrimitives();
    // 4100 chars → 3 chunks: [0–2000, 2000–4000, 4000–4100]
    // → 2 channel.send() calls (one per chunk boundary)
    const text = repeat("g", DISCORD_MESSAGE_LIMIT * 2 + 100);

    await drainBuffer(text, msg, channel);

    expect(channel.sentMessages).toHaveLength(2);
    // Each intermediate message is posted with the placeholder first (send()),
    // then immediately overwritten with real content (edit()).
    expect(channel.sentMessages[0]!.edits[0]).toBe("⏳ Thinking…"); // placeholder on send
    expect(channel.sentMessages[0]!.edits[1]).toBe(               // real content
      text.slice(DISCORD_MESSAGE_LIMIT, DISCORD_MESSAGE_LIMIT * 2),
    );
    expect(channel.sentMessages[1]!.edits[0]).toBe("⏳ Thinking…"); // placeholder on send
    expect(channel.sentMessages[1]!.edits[1]).toBe(               // real content
      text.slice(DISCORD_MESSAGE_LIMIT * 2),
    );
  });

  it("accepts a custom nextMessagePlaceholder", async () => {
    const { msg, channel } = makePrimitives();
    const text = repeat("h", DISCORD_MESSAGE_LIMIT * 2 + 1);

    await drainBuffer(text, msg, channel, {
      nextMessagePlaceholder: "⌛ Continuing...",
    });

    expect(channel.sentMessages[0]!.edits[0]).toBe("⌛ Continuing...");
  });
});

// ---------------------------------------------------------------------------
// sendChunks (rate-limit fallback mode)
// ---------------------------------------------------------------------------

describe("sendChunks", () => {
  it("sends default '(no response)' when buffer is empty", async () => {
    const channel = new FakeChannel();

    await sendChunks("", channel);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe("(no response)");
  });

  it("accepts a custom emptyFallback for empty buffer", async () => {
    const channel = new FakeChannel();

    await sendChunks("", channel, { emptyFallback: "Nothing to report." });

    expect(channel.sentMessages[0]!.lastContent).toBe("Nothing to report.");
  });

  it("sends a single message when buffer fits within 2 K", async () => {
    const channel = new FakeChannel();
    const text = "This is the complete agent response.";

    await sendChunks(text, channel);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(text);
  });

  it("sends exactly one message when buffer is exactly 2 K", async () => {
    const channel = new FakeChannel();
    const text = repeat("i", DISCORD_MESSAGE_LIMIT);

    await sendChunks(text, channel);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.lastContent).toBe(text);
  });

  it("sends two messages when buffer is 2 K + 1 char", async () => {
    const channel = new FakeChannel();
    const text = repeat("j", DISCORD_MESSAGE_LIMIT + 1);

    await sendChunks(text, channel);

    expect(channel.sentMessages).toHaveLength(2);
    expect(channel.sentMessages[0]!.lastContent).toBe(
      text.slice(0, DISCORD_MESSAGE_LIMIT),
    );
    expect(channel.sentMessages[1]!.lastContent).toBe("j");
  });

  it("sends multiple messages for a long buffer, preserving all content", async () => {
    const channel = new FakeChannel();
    const text = repeat("k", DISCORD_MESSAGE_LIMIT * 3 + 500);

    await sendChunks(text, channel);

    expect(channel.sentMessages).toHaveLength(4);
    const allContent = channel.sentMessages.map((m) => m.lastContent).join("");
    expect(allContent).toBe(text);
  });

  it("never calls edit() — only channel.send() is used", async () => {
    const channel = new FakeChannel();
    const text = repeat("l", DISCORD_MESSAGE_LIMIT * 2 + 1);

    await sendChunks(text, channel);

    // Every sent message should have exactly 1 edit entry (from send() recording)
    // — no subsequent edit() calls are made.
    for (const m of channel.sentMessages) {
      expect(m.edits).toHaveLength(1);
    }
  });

  it("re-throws errors from channel.send()", async () => {
    const brokenChannel: DiscordSendableChannel = {
      async send() {
        throw new Error("send failed in fallback");
      },
    };

    await expect(sendChunks("hello", brokenChannel)).rejects.toThrow(
      "send failed in fallback",
    );
  });

  it("sends empty-fallback message even when channel errors on first call", async () => {
    // Verify error propagation for empty buffer too
    let callCount = 0;
    const brokenChannel: DiscordSendableChannel = {
      async send() {
        callCount++;
        throw new Error("channel down");
      },
    };

    await expect(sendChunks("", brokenChannel)).rejects.toThrow("channel down");
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: flushToMessage → drainBuffer continuity
// ---------------------------------------------------------------------------

describe("flushToMessage + drainBuffer continuity", () => {
  it("caller can store remainingBuffer and drain it with drainBuffer", async () => {
    // Simulate the typical DiscordStreamHandle pattern:
    // 1. flushToMessage mid-stream on > 4 K content
    // 2. Store remainingBuffer in accumulatedText
    // 3. Call drainBuffer at finish() time

    const channel = new FakeChannel();
    const initialMsg = new FakeMessage();

    // 5000 chars: flushToMessage handles 0→4000, returns 4000→5000 as remainingBuffer
    const fullText = repeat("m", DISCORD_MESSAGE_LIMIT * 2 + 1000);

    const { activeMessage, remainingBuffer } = await flushToMessage(
      fullText,
      initialMsg,
      channel,
    );

    expect(channel.sentMessages).toHaveLength(1); // overflow message sent
    expect(remainingBuffer).toHaveLength(1000);

    // Now caller stores remainingBuffer and drains it at finish() time
    // (simulating appended text being flushed after the stream ends)
    await drainBuffer(remainingBuffer, activeMessage, channel);

    // The overflow message should now be edited with the remaining content
    const overflowMsg = channel.sentMessages[0]!;
    const allEdits = [
      initialMsg.edits[0]!,
      overflowMsg.edits[0]!, // initial send content
      overflowMsg.edits[1]!, // drain edit
    ];
    expect(allEdits.join("")).toBe(fullText);
  });

  it("no content is lost across flush + drain for a 6 K message", async () => {
    const channel = new FakeChannel();
    const initialMsg = new FakeMessage();

    // 6000 chars exactly
    const fullText = repeat("n", DISCORD_MESSAGE_LIMIT * 3);

    const { activeMessage, remainingBuffer } = await flushToMessage(
      fullText,
      initialMsg,
      channel,
    );

    // flushToMessage sends 1 new message (chars 2000–4000); remainingBuffer = chars 4000–6000
    expect(remainingBuffer).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(channel.sentMessages).toHaveLength(1);

    await drainBuffer(remainingBuffer, activeMessage, channel);

    // drainBuffer edits the SAME activeMessage (no new send needed — remainingBuffer
    // fits exactly in one edit on the already-created overflow message).
    // So channel.sentMessages still has length 1.
    expect(channel.sentMessages).toHaveLength(1);

    const reconstructed =
      initialMsg.edits[0]! +               // chars 0–2000 (flushToMessage edit)
      channel.sentMessages[0]!.edits[0]! + // chars 2000–4000 (flushToMessage send)
      channel.sentMessages[0]!.edits[1]!;  // chars 4000–6000 (drainBuffer edit)
    expect(reconstructed).toBe(fullText);
  });
});
