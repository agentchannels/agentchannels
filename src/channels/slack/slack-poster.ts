/**
 * Rate-limited Slack poster that sends batched messages as threaded replies.
 *
 * Combines the MessageBatcher (which accumulates streaming text chunks) with
 * a TokenBucketRateLimiter to ensure Slack API calls stay within rate limits.
 *
 * ## How it works
 *
 * 1. Streaming text deltas arrive via `post(text)`.
 * 2. The MessageBatcher accumulates them and flushes at configured intervals.
 * 3. On each flush, the poster acquires a rate-limit token before calling
 *    `chat.postMessage` to send the batched text as a threaded reply.
 *
 * ## Message splitting
 *
 * If a batched message exceeds Slack's 40,000-character limit, it is split
 * into multiple messages, each sent as a separate threaded reply.
 *
 * ## Lifecycle
 *
 * ```
 *   const poster = new SlackPoster(client, options);
 *   poster.post("chunk1");
 *   poster.post("chunk2");
 *   await poster.finish();   // flushes remaining + cleans up
 * ```
 */

import type { WebClient } from "@slack/web-api";
import { MessageBatcher } from "../../core/message-batcher.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";

/** Slack's maximum message text length */
const SLACK_MAX_MESSAGE_LENGTH = 40_000;

export interface SlackPosterOptions {
  /** The Slack channel ID to post in */
  channelId: string;

  /** The thread timestamp to reply in */
  threadTs: string;

  /**
   * Maximum time in ms to batch incoming text before posting.
   * @default 500
   */
  batchIntervalMs?: number;

  /**
   * Maximum batched text size (chars) before triggering a post.
   * @default 3000
   */
  batchMaxSize?: number;

  /**
   * Token bucket: max burst capacity.
   * @default 1
   */
  rateLimitMaxTokens?: number;

  /**
   * Token bucket: tokens refilled per second.
   * @default 1
   */
  rateLimitRefillRate?: number;
}

/**
 * Sends batched, rate-limited messages as threaded replies in Slack.
 *
 * Designed to bridge Claude's streaming text output to Slack without
 * overwhelming the API. Each flush from the MessageBatcher becomes a
 * single `chat.postMessage` call (or multiple if the text exceeds
 * Slack's character limit), rate-limited by a token bucket.
 */
export class SlackPoster {
  private readonly client: WebClient;
  private readonly channelId: string;
  private readonly threadTs: string;
  private readonly batcher: MessageBatcher;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly messageTimestamps: string[] = [];
  private finished = false;

  constructor(client: WebClient, options: SlackPosterOptions) {
    this.client = client;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;

    this.rateLimiter = new TokenBucketRateLimiter({
      maxTokens: options.rateLimitMaxTokens ?? 1,
      refillRate: options.rateLimitRefillRate ?? 1,
    });

    this.batcher = new MessageBatcher({
      flushIntervalMs: options.batchIntervalMs ?? 500,
      maxSize: options.batchMaxSize ?? 3000,
      onFlush: (text) => this.sendMessage(text),
    });
  }

  /**
   * Add a text chunk to be batched and eventually posted.
   *
   * The text is accumulated by the MessageBatcher and sent as a
   * threaded reply when the batch interval or size threshold is reached.
   *
   * @param text - Text chunk to add (e.g., a streaming delta from Claude)
   */
  post(text: string): void {
    if (this.finished) return;
    this.batcher.add(text);
  }

  /**
   * Flush any remaining batched text and clean up resources.
   *
   * Must be called when the stream is complete to ensure no text is lost.
   * After calling finish(), further calls to post() are ignored.
   *
   * @returns Promise that resolves when all messages have been sent
   */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.batcher.dispose();
    this.rateLimiter.dispose();
  }

  /**
   * Returns the timestamps of all messages posted by this poster.
   * Useful for tracking or cleaning up messages.
   */
  get postedTimestamps(): ReadonlyArray<string> {
    return this.messageTimestamps;
  }

  /**
   * Returns the number of messages posted so far.
   */
  get messageCount(): number {
    return this.messageTimestamps.length;
  }

  /**
   * Returns whether the poster has been finished.
   */
  get isFinished(): boolean {
    return this.finished;
  }

  // --- Internal ---

  /**
   * Send a message as a threaded reply, handling rate limiting and splitting.
   */
  private async sendMessage(text: string): Promise<void> {
    const chunks = SlackPoster.splitMessage(text);

    for (const chunk of chunks) {
      await this.rateLimiter.acquire();

      const result = await this.client.chat.postMessage({
        channel: this.channelId,
        thread_ts: this.threadTs,
        text: chunk,
      });

      if (result.ts) {
        this.messageTimestamps.push(result.ts);
      }
    }
  }

  /**
   * Split a message into chunks that fit within Slack's character limit.
   *
   * Attempts to split on newlines for cleaner breaks. Falls back to
   * hard splitting at the character limit if no newline is found.
   *
   * @param text - The text to split
   * @returns Array of text chunks, each within SLACK_MAX_MESSAGE_LENGTH
   */
  static splitMessage(text: string): string[] {
    if (text.length <= SLACK_MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= SLACK_MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to find a newline to split on for cleaner breaks
      let splitIndex = remaining.lastIndexOf("\n", SLACK_MAX_MESSAGE_LENGTH);

      if (splitIndex <= 0) {
        // No good newline found — hard split at the limit
        splitIndex = SLACK_MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);

      // Skip the newline character if we split on one
      if (remaining.startsWith("\n")) {
        remaining = remaining.slice(1);
      }
    }

    return chunks;
  }
}
