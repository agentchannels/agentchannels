/**
 * Slack user-side API helper for e2e tests.
 *
 * Wraps the Slack Web API using an xoxp- user token to:
 *   - Post mention messages to a dedicated test channel as a human user
 *   - Poll for new messages from a bot user in a thread
 *   - Fetch thread replies and channel history for assertions
 *
 * This module contains no test logic — it is a pure HTTP utility layer
 * that e2e test files can compose to drive and observe Slack interactions.
 *
 * Required env vars (contributor-only; tests skip when absent):
 *   SLACK_TEST_USER_TOKEN  — xoxp- user OAuth token for posting
 *   SLACK_TEST_CHANNEL_ID  — dedicated test channel ID (e.g. C0123456789)
 */

import { WebClient } from "@slack/web-api";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SlackUserClientConfig {
  /** xoxp- user OAuth token used to post messages as a human user */
  userToken: string;

  /** Channel ID of the dedicated e2e test channel */
  channelId: string;

  /**
   * Bot user ID (Uxxxxxxxx) used to filter bot replies when polling.
   * When omitted, any bot message in the thread is considered a bot reply.
   */
  botUserId?: string;
}

/** Minimal representation of a Slack message returned by this helper */
export interface SlackMessage {
  /** Slack message timestamp — unique identifier and sort key */
  ts: string;

  /** Decoded message text (may contain Slack mrkdwn) */
  text: string;

  /** Slack user ID of the sender (absent for bot-only messages) */
  userId?: string;

  /** Slack bot_id (present on messages posted by a bot integration) */
  botId?: string;

  /**
   * Thread timestamp this message belongs to.
   * Equals ts for top-level messages; equals parent ts for replies.
   */
  threadTs?: string;
}

/** Result returned after successfully posting a message */
export interface PostedMessage {
  /** Slack timestamp — use as threadTs for polling replies */
  ts: string;

  /** Channel the message was posted to */
  channelId: string;

  /** The text that was posted */
  text: string;
}

/** Options for the pollForBotReply utility */
export interface PollOptions {
  /**
   * Maximum number of polling attempts before giving up.
   * @default 30
   */
  maxAttempts?: number;

  /**
   * Milliseconds to wait between polling attempts.
   * @default 2000
   */
  intervalMs?: number;

  /**
   * Override the bot user ID filter for this specific poll.
   * Falls back to the SlackUserClientConfig.botUserId when omitted.
   */
  botUserId?: string;
}

// ---------------------------------------------------------------------------
// SlackUserClient
// ---------------------------------------------------------------------------

/**
 * Thin HTTP wrapper around the Slack Web API for driving e2e tests as a user.
 *
 * Uses an xoxp- token so messages appear as an actual workspace user rather
 * than a bot, which is important for triggering app_mention events in Slack.
 */
export class SlackUserClient {
  private readonly client: WebClient;
  private readonly channelId: string;
  private readonly defaultBotUserId: string | undefined;

  constructor(config: SlackUserClientConfig) {
    if (!config.userToken) {
      throw new Error("SlackUserClient: userToken is required");
    }
    if (!config.channelId) {
      throw new Error("SlackUserClient: channelId is required");
    }

    this.client = new WebClient(config.userToken);
    this.channelId = config.channelId;
    this.defaultBotUserId = config.botUserId;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /**
   * Post a message to the configured test channel.
   *
   * To trigger the bot, include a mention in the text:
   * ```ts
   * await client.postMessage(`<@${BOT_USER_ID}> hello`);
   * ```
   *
   * @param text - Full message text, including any @mention markup
   * @returns Metadata about the posted message, including its `ts` (use as threadTs)
   */
  async postMessage(text: string): Promise<PostedMessage> {
    const result = await this.client.chat.postMessage({
      channel: this.channelId,
      text,
    });

    if (!result.ok || !result.ts) {
      throw new Error(
        `SlackUserClient.postMessage failed: ${result.error ?? "no ts returned"}`,
      );
    }

    return {
      ts: result.ts,
      channelId: this.channelId,
      text,
    };
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  /**
   * Poll a thread for bot replies, returning as soon as at least one arrives.
   *
   * Filters to messages posted after `afterTs` so the original user message
   * is never returned as a "reply". Applies bot-user filter when configured.
   *
   * ```ts
   * const posted = await client.postMessage(`<@${BOT}> hello`);
   * const replies = await client.pollForBotReply(posted.ts, posted.ts);
   * ```
   *
   * @param threadTs - Thread root timestamp (ts of the original user message)
   * @param afterTs  - Only consider messages with ts strictly greater than this
   * @param options  - Polling behaviour overrides
   * @returns Array of bot messages found (empty array on timeout)
   */
  async pollForBotReply(
    threadTs: string,
    afterTs: string,
    options?: PollOptions,
  ): Promise<SlackMessage[]> {
    const maxAttempts = options?.maxAttempts ?? 30;
    const intervalMs = options?.intervalMs ?? 2000;
    const botUserId = options?.botUserId ?? this.defaultBotUserId;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const replies = await this.fetchThreadReplies(threadTs, afterTs, botUserId);

      if (replies.length > 0) {
        return replies;
      }

      if (attempt < maxAttempts - 1) {
        await sleep(intervalMs);
      }
    }

    return [];
  }

  // ── Fetching ───────────────────────────────────────────────────────────────

  /**
   * Fetch all replies in a thread, optionally filtered by timestamp and bot user.
   *
   * The Slack API returns the parent message as the first item in `replies`
   * — this helper strips it so only actual replies are returned.
   *
   * @param threadTs  - Thread root timestamp to query
   * @param afterTs   - Exclude messages with ts <= this value (use to skip the user message)
   * @param botUserId - When set, only return messages from this user/bot
   * @returns Array of matching messages in chronological order
   */
  async fetchThreadReplies(
    threadTs: string,
    afterTs?: string,
    botUserId?: string,
  ): Promise<SlackMessage[]> {
    const result = await this.client.conversations.replies({
      channel: this.channelId,
      ts: threadTs,
      // `oldest` is inclusive in the Slack API; we do strict-greater filtering below
      oldest: afterTs,
      limit: 100,
      inclusive: false,
    });

    if (!result.ok) {
      throw new Error(
        `SlackUserClient.fetchThreadReplies failed: ${result.error}`,
      );
    }

    const messages = result.messages ?? [];

    return messages
      // Strip the parent message (Slack always includes it as the first item)
      .filter((m) => m.ts !== threadTs)
      // Strict-after filter (Slack `oldest` with `inclusive: false` still may
      // return the boundary message depending on the API version)
      .filter((m) => !afterTs || (m.ts !== undefined && m.ts > afterTs))
      // Bot-user filter: keep messages from the specified bot user, or any
      // bot message when botUserId is not set
      .filter((m) => {
        if (!botUserId) return true;
        // Bot messages can appear as user === botUserId or bot_id set
        const asBotMsg = m as { bot_id?: string; user?: string };
        return asBotMsg.user === botUserId || asBotMsg.bot_id !== undefined;
      })
      .map((m) => {
        const raw = m as {
          ts?: string;
          text?: string;
          user?: string;
          bot_id?: string;
          thread_ts?: string;
        };
        return {
          ts: raw.ts ?? "",
          text: raw.text ?? "",
          userId: raw.user,
          botId: raw.bot_id,
          threadTs: raw.thread_ts,
        };
      });
  }

  /**
   * Fetch recent top-level messages from the test channel.
   *
   * Useful for reading back the last known channel state before a test run
   * so that `afterTs` can be set correctly.
   *
   * @param afterTs - Only return messages posted after this timestamp
   * @param limit   - Maximum number of messages to return (default 20)
   * @returns Array of messages in reverse-chronological order (newest first, as Slack returns them)
   */
  async fetchChannelMessages(
    afterTs?: string,
    limit = 20,
  ): Promise<SlackMessage[]> {
    const result = await this.client.conversations.history({
      channel: this.channelId,
      oldest: afterTs,
      limit,
      inclusive: false,
    });

    if (!result.ok) {
      throw new Error(
        `SlackUserClient.fetchChannelMessages failed: ${result.error}`,
      );
    }

    const messages = result.messages ?? [];

    return messages
      .filter((m) => !afterTs || (m.ts !== undefined && m.ts > afterTs))
      .map((m) => {
        const raw = m as {
          ts?: string;
          text?: string;
          user?: string;
          bot_id?: string;
          thread_ts?: string;
        };
        return {
          ts: raw.ts ?? "",
          text: raw.text ?? "",
          userId: raw.user,
          botId: raw.bot_id,
          threadTs: raw.thread_ts,
        };
      });
  }

  /**
   * Return the latest message timestamp in the channel.
   * Useful for capturing a "baseline" ts before a test posts anything, so
   * subsequent polls only see messages produced by the test.
   *
   * Returns `"0"` when the channel has no messages.
   */
  async getLatestMessageTs(): Promise<string> {
    const result = await this.client.conversations.history({
      channel: this.channelId,
      limit: 1,
    });

    if (!result.ok) {
      throw new Error(
        `SlackUserClient.getLatestMessageTs failed: ${result.error}`,
      );
    }

    const messages = result.messages ?? [];
    if (messages.length === 0) return "0";

    const first = messages[0] as { ts?: string };
    return first.ts ?? "0";
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** The channel ID this client is configured for */
  getChannelId(): string {
    return this.channelId;
  }

  /** The underlying Slack WebClient (for advanced use cases) */
  getRawClient(): WebClient {
    return this.client;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
