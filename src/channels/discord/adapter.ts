import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
  type NewsChannel,
  type TextBasedChannel,
} from "discord.js";
import type {
  ChannelAdapter,
  ChannelMessage,
  MessageHandler,
  StreamHandle,
} from "../../core/channel-adapter.js";
import { DiscordRateLimitTracker } from "./rate-limit.js";
import { DiscordStreamer } from "./streamer.js";
import {
  DISCORD_MESSAGE_LIMIT,
  DM_GUILD_SENTINEL,
  THREAD_AUTO_ARCHIVE_MINUTES,
  THREAD_NAME_MAX_LENGTH,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DiscordAdapterConfig {
  /** Discord bot token (Bot token from Discord Developer Portal) */
  botToken: string;
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type SendableChannel = TextChannel | DMChannel | ThreadChannel | NewsChannel;

function isSendableChannel(ch: { type: ChannelType }): ch is SendableChannel {
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.DM ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === ChannelType.GuildVoice
  );
}

// ---------------------------------------------------------------------------
// DiscordAdapter
// ---------------------------------------------------------------------------

/**
 * Discord implementation of the ChannelAdapter interface.
 *
 * Supports:
 * - @mention triggers in guild (server) channels
 * - Direct Message (DM) triggers
 * - Edit-in-place streaming with ~1 s cadence (Discord rate-limit safe)
 * - 2 K character overflow: excess text posted as follow-up messages
 * - Inline agent activity indicators via task prefix lines
 *
 * ## Thread boundary management
 *
 * Session keys follow the format `discord:{guildId}:{threadId}`:
 *
 * - **First @mention in a guild text channel**: a public Discord thread is
 *   created on the triggering message. The thread's channel ID becomes
 *   `threadId`; `guildId` is the server ID.
 * - **Subsequent messages inside an existing thread**: the thread channel ID
 *   is reused directly — no new thread is created.
 * - **DMs**: `guildId` is set to the sentinel `"@dm"` (no real guild exists),
 *   and `threadId` is the DM channel ID.
 *
 * Because `ChannelMessage.channelId` = `guildId` and
 * `ChannelMessage.threadId` = Discord thread channel ID, the `StreamingBridge`
 * naturally derives the key `discord:{guildId}:{threadId}` when it calls
 * `SessionManager.getSession(adapter.name, channelId, threadId)`.
 *
 * The actual Discord channel fetched for sending/streaming is always
 * resolved from `threadId`, NOT `channelId` (which is the guildId).
 *
 * Required bot permissions:
 * - Read Messages / View Channels
 * - Send Messages
 * - Create Public Threads
 * - Send Messages in Threads
 * - Read Message History
 * - Manage Messages (for editing)
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";

  private client: Client;
  private handlers: MessageHandler[] = [];
  private botUserId: string | undefined;

  /**
   * Shared rate-limit tracker.  All `DiscordStreamHandle` instances created
   * by this adapter write 429 hits into this tracker so that
   * `isChannelRateLimited()` reflects the live per-channel state.
   */
  private readonly rateLimitTracker = new DiscordRateLimitTracker();

  constructor(private readonly config: DiscordAdapterConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // Partials are required to receive DM channel events before the channel
      // has been cached, and to handle partial message objects in DMs.
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupListeners();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to Discord by logging in the bot and waiting for the ready event.
   *
   * `client.login()` starts the WebSocket handshake but returns before the bot
   * is fully ready. We wait for the `ClientReady` event so that `this.client.user`
   * is populated before any message handling begins.
   */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.botUserId = readyClient.user.id;
        console.log(
          `[discord] Connected as @${readyClient.user.tag} (${this.botUserId})`,
        );
        resolve();
      });

      this.client.once(Events.Error, (err) => {
        reject(new Error(`[discord] Connection error: ${String(err)}`));
      });

      this.client.login(this.config.botToken).catch((err: unknown) => {
        reject(new Error(`[discord] Login failed: ${String(err)}`));
      });
    });
  }

  /**
   * Disconnect from Discord, destroying the WebSocket connection and
   * releasing all cached resources.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async disconnect(): Promise<void> {
    this.client.destroy();
    console.log("[discord] Disconnected");
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Send a complete (non-streaming) text message.
   *
   * @param _channelId - The guildId (used for session key derivation only).
   * @param threadId   - The actual Discord channel/thread ID to send to.
   * @param text       - Message content (truncated to 2 K if needed).
   */
  async sendMessage(_channelId: string, threadId: string, text: string): Promise<void> {
    const channel = await this.fetchTextChannel(threadId);
    const truncated = text.slice(0, DISCORD_MESSAGE_LIMIT);
    try {
      await channel.send({ content: truncated });
    } catch (err) {
      if (DiscordRateLimitTracker.isRateLimitError(err)) {
        const retryAfterMs = DiscordRateLimitTracker.extractRetryAfter(err);
        this.rateLimitTracker.recordHit(threadId, retryAfterMs);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Start an edit-in-place streaming response.
   *
   * Posts an initial placeholder message then progressively edits it as text
   * deltas arrive. Enforces a ~1 s edit cadence to respect Discord's
   * ~5 edits/5 s rate limit.
   *
   * When accumulated text exceeds `DISCORD_MESSAGE_LIMIT` (2 K), the current
   * message is finalized and a new follow-up message is posted to continue
   * the stream.
   *
   * @param _channelId - The guildId (used for session key derivation only).
   * @param threadId   - The actual Discord thread/channel ID to stream to.
   * @returns A `StreamHandle` for appending deltas and finalising the message.
   */
  async startStream(_channelId: string, threadId: string, _userId?: string): Promise<StreamHandle> {
    const channel = await this.fetchTextChannel(threadId);
    const streamer = new DiscordStreamer(channel, threadId, this.rateLimitTracker);
    return streamer.start();
  }

  // -------------------------------------------------------------------------
  // Rate-limit inspection
  // -------------------------------------------------------------------------

  /**
   * Return `true` if the given channel (or thread) is currently under a
   * Discord 429 rate-limit cooldown.
   *
   * The cooldown is recorded automatically whenever a `DiscordStreamHandle`
   * created by this adapter, or `sendMessage()`, receives a 429 response.
   *
   * @param channelId - The Discord channel/thread ID to check (i.e., `threadId`).
   */
  isChannelRateLimited(channelId: string): boolean {
    return this.rateLimitTracker.isRateLimited(channelId);
  }

  /**
   * Return the shared `DiscordRateLimitTracker` instance.
   *
   * Exposed primarily for testing and monitoring; most callers should use
   * `isChannelRateLimited()` instead.
   */
  getRateLimitTracker(): DiscordRateLimitTracker {
    return this.rateLimitTracker;
  }

  // -------------------------------------------------------------------------
  // Status (optional interface methods)
  // -------------------------------------------------------------------------

  /**
   * Indicate activity in a channel by triggering the typing indicator.
   *
   * Discord's typing indicator lasts ~10 seconds automatically and cannot
   * be set to custom text (unlike Slack's assistant.threads.setStatus).
   * This provides a visual cue that the bot is processing the request.
   *
   * @param _channelId - The guildId (unused for this call).
   * @param threadId   - The actual Discord thread/channel ID to trigger typing in.
   */
  async setStatus(_channelId: string, threadId: string, _status: string): Promise<void> {
    try {
      const channel = await this.fetchTextChannel(threadId);
      await channel.sendTyping();
    } catch (err) {
      console.warn("[discord] Could not send typing indicator:", err);
    }
  }

  /**
   * Clear the typing status.
   *
   * Discord typing indicators expire automatically after ~10 seconds,
   * so no explicit clear is required. This is a no-op.
   */
  async clearStatus(_channelId: string, _threadId: string): Promise<void> {
    // No-op: Discord typing indicators auto-expire.
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Set up Discord event listeners for @mentions and DMs.
   *
   * Called once during construction so handlers registered via `onMessage()`
   * before `connect()` are also reached.
   */
  private setupListeners(): void {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore messages from all bots (including ourselves) to prevent loops.
      if (message.author.bot) return;

      const isDM = message.channel.type === ChannelType.DM;

      // A mention is detected if the bot user is listed in message.mentions.
      const isMention = this.botUserId !== undefined
        ? message.mentions.has(this.botUserId)
        : false;

      // Only process DMs or explicit @mentions in guild channels.
      if (!isDM && !isMention) return;

      // Strip the bot @mention tag from the message text.
      let text = message.content;
      if (this.botUserId) {
        text = text
          .replace(new RegExp(`<@!?${this.botUserId}>\\s*`, "g"), "")
          .trim();
      }

      // Resolve thread context: may asynchronously create a Discord thread
      // for first-time @mentions in guild text channels.
      const { guildId, threadId } = await this.resolveThreadContext(message, isMention, text);

      const channelMessage = this.toChannelMessage(message, isMention, isDM, guildId, threadId, text);

      await this.dispatchMessage(channelMessage);
    });
  }

  /**
   * Normalize a raw Discord Message into the channel-agnostic `ChannelMessage`
   * shape consumed by `StreamingBridge`.
   *
   * This is the synchronous normalization step — all async work (thread
   * resolution, mention detection) has already been completed by the time
   * this method is called from `setupListeners()`.
   *
   * @param message        - The raw Discord Message object.
   * @param isMention      - Whether the bot was @mentioned in this message.
   * @param isDirectMessage - Whether this is a DM (no guild).
   * @param guildId        - The resolved guild ID (or `DM_GUILD_SENTINEL` for DMs).
   * @param threadId       - The actual Discord channel/thread ID to send replies to.
   * @param text           - Message content with bot @mention tag already stripped.
   * @returns Normalized `ChannelMessage` ready for handler dispatch.
   */
  private toChannelMessage(
    message: Message,
    isMention: boolean,
    isDirectMessage: boolean,
    guildId: string,
    threadId: string,
    text: string,
  ): ChannelMessage {
    return {
      id: message.id,
      // channelId carries the guildId so the SessionManager derives the key
      // "discord:{guildId}:{threadId}" — matching the per-thread session
      // boundary specified by the Discord adapter contract.
      channelId: guildId,
      // threadId is the actual Discord channel/thread ID used by
      // sendMessage() / startStream() / setStatus() for API calls.
      threadId,
      userId: message.author.id,
      text,
      isMention,
      isDirectMessage,
      raw: message,
    };
  }

  /**
   * Resolve the thread/session identifiers for an incoming message.
   *
   * This is the core of the thread boundary management:
   *
   * 1. **DM**: `guildId = "@dm"`, `threadId = dmChannelId`.
   *    Each DM channel maps to one persistent session per user.
   *
   * 2. **Existing Discord thread** (PublicThread / PrivateThread /
   *    AnnouncementThread): `guildId = message.guildId`,
   *    `threadId = thread channel ID`. Reuses the existing thread without
   *    creating a new one — all messages in the thread share a session.
   *
   * 3. **First @mention in a guild text channel**: creates a public Discord
   *    thread on the triggering message. `guildId = message.guildId`,
   *    `threadId = newly created thread channel ID`.
   *
   * The resulting `(guildId, threadId)` pair is placed in `ChannelMessage`
   * as `(channelId, threadId)` so `StreamingBridge` → `SessionManager`
   * generates the key `discord:{guildId}:{threadId}`.
   *
   * @param message   - The incoming Discord Message object.
   * @param isMention - Whether the bot was @mentioned.
   * @param strippedText - Message text with mention stripped (used for thread name).
   * @returns Resolved `{ guildId, threadId }`.
   */
  private async resolveThreadContext(
    message: Message,
    isMention: boolean,
    strippedText: string,
  ): Promise<{ guildId: string; threadId: string }> {
    const ch = message.channel;

    // ── Case 1: DM channel ──────────────────────────────────────────────────
    // DMs have no guild. Use the DM_GUILD_SENTINEL as a stable prefix so the
    // session key `discord:@dm:{dmChannelId}` can never collide with a real
    // guild ID.
    if (ch.type === ChannelType.DM) {
      return {
        guildId: DM_GUILD_SENTINEL,
        threadId: message.channelId,
      };
    }

    // ── Case 2: Already inside a Discord thread ─────────────────────────────
    // Reuse the existing thread — do NOT create a nested thread. All messages
    // sent inside the same thread share a single agent session.
    if (
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread ||
      ch.type === ChannelType.AnnouncementThread
    ) {
      return {
        guildId: message.guildId ?? "unknown",
        threadId: message.channelId,
      };
    }

    // ── Case 3: First @mention in a regular guild text channel ──────────────
    // Create a public thread on the triggering message. Subsequent replies
    // by the user inside that thread will hit Case 2 above and reuse it.
    if (isMention && message.guildId) {
      try {
        const threadName = this.buildThreadName(strippedText);
        const thread = await message.startThread({
          name: threadName,
          autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
          reason: "agentchannels: Claude agent conversation thread",
        });
        console.log(
          `[discord] Created thread "${thread.name}" (${thread.id}) on message ${message.id}`,
        );
        return {
          guildId: message.guildId,
          threadId: thread.id,
        };
      } catch (err) {
        // Thread creation can fail if the bot lacks CREATE_PUBLIC_THREADS
        // permission, or if the channel already has a thread on this message.
        // Fall back to using the message ID so the bot still responds.
        console.warn(
          `[discord] Could not create thread on message ${message.id}; `
          + `falling back to message-scoped session:`,
          err,
        );
        return {
          guildId: message.guildId,
          threadId: message.id,
        };
      }
    }

    // ── Fallback ─────────────────────────────────────────────────────────────
    // Should not normally be reached (we guard with !isDM && !isMention above),
    // but provide a safe default rather than throwing.
    return {
      guildId: message.guildId ?? "unknown",
      threadId: message.id,
    };
  }

  /**
   * Build a human-readable thread name from the stripped message text.
   *
   * Thread names are capped at `THREAD_NAME_MAX_LENGTH` (100) characters per
   * Discord's API limit. Falls back to a generic name if the text is empty.
   */
  private buildThreadName(strippedText: string): string {
    const trimmed = strippedText.trim();
    if (!trimmed) return "Agent conversation";
    if (trimmed.length <= THREAD_NAME_MAX_LENGTH) return trimmed;
    // Truncate at a word boundary where possible for readability.
    const truncated = trimmed.slice(0, THREAD_NAME_MAX_LENGTH - 1);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > THREAD_NAME_MAX_LENGTH / 2 ? truncated.slice(0, lastSpace) : truncated) + "…";
  }

  /**
   * Fetch a text-based channel by ID and assert it is sendable.
   *
   * Used with `threadId` (the actual Discord channel/thread ID), NOT with
   * the `channelId` (guildId) from `ChannelMessage`.
   *
   * @throws If the channel is not found or is not a text-based channel.
   */
  private async fetchTextChannel(channelId: string): Promise<SendableChannel> {
    const channel = await this.client.channels.fetch(channelId);

    if (!channel) {
      throw new Error(`[discord] Channel ${channelId} not found`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`[discord] Channel ${channelId} is not a text-based channel`);
    }

    if (!isSendableChannel(channel as TextBasedChannel)) {
      throw new Error(`[discord] Channel ${channelId} does not support sending messages`);
    }

    return channel as SendableChannel;
  }

  /**
   * Dispatch a normalized ChannelMessage to all registered handlers.
   * Errors in individual handlers are caught and logged so subsequent
   * handlers always run.
   */
  private async dispatchMessage(message: ChannelMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (err) {
        console.error("[discord] Error in message handler:", err);
      }
    }
  }
}
