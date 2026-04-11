/**
 * Channel Adapter Interface
 *
 * This module defines the core contract that all messaging channel adapters must implement.
 * Adding a new channel (e.g., Discord, Teams) requires only:
 *   1. Implementing the `ChannelAdapter` interface
 *   2. Adding a new directory under `src/channels/<channel>/`
 *
 * The adapter pattern decouples the core agent-bridging logic from any specific
 * messaging platform, allowing the same session management and streaming logic
 * to work across all supported channels.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/**
 * A normalized incoming message from any messaging channel.
 *
 * Channel adapters translate platform-specific events into this common shape
 * so that the core message handler can work identically across Slack, Discord, etc.
 */
export interface ChannelMessage {
  /** Channel-specific unique ID for the message (e.g., Slack's `ts`) */
  id: string;

  /** Channel ID or conversation ID where the message was sent */
  channelId: string;

  /**
   * Thread/conversation ID for grouping messages.
   * Each unique threadId maps to one Claude Managed Agent session.
   * For Slack: `thread_ts` (or the message `ts` if it's a thread root).
   */
  threadId: string;

  /** The user who sent the message (platform-specific user ID) */
  userId: string;

  /** The message text content (with bot mentions stripped) */
  text: string;

  /** Whether this message is a direct @mention of the bot */
  isMention: boolean;

  /** Whether this message is a direct/private message */
  isDirectMessage: boolean;

  /**
   * Raw channel-specific event data for advanced use cases.
   * Consumers should not depend on the shape of this object
   * as it varies per channel implementation.
   */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

/**
 * Callback invoked when the adapter receives an incoming message.
 * Multiple handlers can be registered; they are called sequentially.
 * If a handler throws, the adapter logs the error and continues to the next.
 */
export type MessageHandler = (message: ChannelMessage) => Promise<void>;

// ---------------------------------------------------------------------------
// Streaming types
// ---------------------------------------------------------------------------

/**
 * Handle returned by `startStream()` to control a streaming response.
 *
 * The typical lifecycle is:
 *   1. `startStream()` — creates the placeholder message / stream
 *   2. `update(text)` — called repeatedly as text deltas arrive
 *   3. `finish(text)` — finalizes the message with the complete response
 *
 * If an error occurs mid-stream, call `finish()` with the error message
 * to ensure the user sees feedback rather than a stale "Thinking..." message.
 */
export interface StreamHandle {
  /**
   * Append a text delta to the streaming message.
   *
   * @param delta - New text to append (NOT the full accumulated text)
   */
  append(delta: string): Promise<void>;

  /**
   * Finalize the streaming message. Optionally append a final delta.
   * After calling `finish()`, no further calls to `append()` should be made.
   *
   * @param finalDelta - Optional remaining text to append before closing
   */
  finish(finalDelta?: string): Promise<void>;

}

// ---------------------------------------------------------------------------
// Adapter status
// ---------------------------------------------------------------------------

/**
 * Connection status of a channel adapter.
 */
export type AdapterStatus = "disconnected" | "connecting" | "connected" | "error";

// ---------------------------------------------------------------------------
// Core adapter interface
// ---------------------------------------------------------------------------

/**
 * Channel adapter interface that all messaging channels must implement.
 *
 * ## Lifecycle
 *
 * ```
 *   new Adapter(config)   →   connect()   →   onMessage(handler)   →   disconnect()
 *        ↑ constructor         ↑ starts         ↑ registers              ↑ cleans up
 *          sets up               platform         callback(s)              platform
 *          internal              connection        for incoming             connection
 *          state                                   messages
 * ```
 *
 * ## Implementation requirements
 *
 * - `connect()` must establish the connection (e.g., Socket Mode for Slack).
 * - `onMessage()` handlers registered before or after `connect()` must work.
 * - `sendMessage()` and `startStream()` may only be called after `connect()`.
 * - `disconnect()` must gracefully close the connection and release resources.
 * - The adapter must handle its own reconnection logic (or delegate to the SDK).
 * - Errors in message handlers must be caught and logged — never crash the adapter.
 *
 * ## Thread-to-session mapping
 *
 * The adapter provides `threadId` on every `ChannelMessage`. The core server
 * uses this to map each thread to a unique Claude Managed Agent session.
 * The adapter itself does NOT manage sessions — it only provides the thread identity.
 */
export interface ChannelAdapter {
  /**
   * Human-readable name identifying the channel type.
   * Used as a key in session mapping (e.g., "slack", "discord").
   * Must be lowercase, alphanumeric, and unique per adapter type.
   */
  readonly name: string;

  /**
   * Connect to the messaging platform.
   *
   * This method should:
   * - Establish the WebSocket / API connection
   * - Authenticate and resolve bot identity
   * - Start listening for incoming events
   *
   * @throws If the connection fails (invalid credentials, network error, etc.)
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the messaging platform.
   *
   * This method should:
   * - Gracefully close the connection
   * - Stop event listeners
   * - Release any held resources
   *
   * It is safe to call `disconnect()` multiple times.
   */
  disconnect(): Promise<void>;

  /**
   * Register a handler for incoming messages.
   *
   * Multiple handlers can be registered by calling this method multiple times.
   * Handlers are invoked sequentially in registration order.
   * If a handler throws, the error is logged and subsequent handlers still run.
   *
   * @param handler - Async callback invoked for each incoming message
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Send a complete text message to a channel/thread.
   *
   * Use this for non-streaming responses (e.g., error messages, confirmations).
   * For streaming agent responses, use `startStream()` instead.
   *
   * @param channelId - The channel or conversation to send to
   * @param threadId - The thread to reply in (maintains conversation context)
   * @param text - The message text to send
   */
  sendMessage(channelId: string, threadId: string, text: string): Promise<void>;

  /**
   * Start a streaming response in a channel/thread.
   *
   * Returns a `StreamHandle` that the caller uses to progressively update
   * the message as text deltas arrive from the Claude agent.
   *
   * Implementations should:
   * - Use native streaming APIs if available (e.g., Slack's chat.startStream)
   * - Fall back to posting a placeholder and updating it via edit
   * - Handle rate limiting internally or document throttling requirements
   *
   * @param channelId - The channel or conversation to stream in
   * @param threadId - The thread to reply in
   * @returns A StreamHandle for updating and finalizing the message
   */
  startStream(channelId: string, threadId: string): Promise<StreamHandle>;

  /**
   * Set a loading/processing status in the thread (e.g., "thinking...").
   * Platform-specific: Slack uses assistant.threads.setStatus.
   *
   * @param channelId - The channel or conversation
   * @param threadId - The thread context
   * @param status - Status text to display
   */
  setStatus?(channelId: string, threadId: string, status: string): Promise<void>;

  /**
   * Clear the loading status in the thread.
   *
   * @param channelId - The channel or conversation
   * @param threadId - The thread context
   */
  clearStatus?(channelId: string, threadId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory type for channel registration
// ---------------------------------------------------------------------------

/**
 * Configuration required by all channel adapters.
 * Each adapter extends this with platform-specific fields.
 */
export interface BaseAdapterConfig {
  [key: string]: unknown;
}

/**
 * Factory function type for creating channel adapters.
 *
 * Used by the channel registry to instantiate adapters from config.
 * Each channel module exports a factory matching this signature.
 *
 * @example
 * ```ts
 * // In src/channels/slack/index.ts
 * export const createAdapter: ChannelAdapterFactory = (config) => {
 *   return new SlackAdapter(config as SlackAdapterConfig);
 * };
 * ```
 */
export type ChannelAdapterFactory<TConfig extends BaseAdapterConfig = BaseAdapterConfig> = (
  config: TConfig,
) => ChannelAdapter;
