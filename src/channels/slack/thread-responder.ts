/**
 * SlackThreadResponder — Coordinator that bridges Claude Managed Agent sessions
 * to Slack threads.
 *
 * Wires together:
 * - SessionOutputReader: reads streaming events from a Claude session
 * - SlackPoster: batches text deltas and rate-limits Slack API calls
 * - SessionManager: maps Slack threads to Claude session IDs
 *
 * ## Lifecycle
 *
 * ```
 *   const responder = new SlackThreadResponder(deps);
 *   await responder.handleMessage(channelMessage);
 *   // → creates or reuses a session
 *   // → streams agent output via SlackPoster
 *   // → handles errors with user-visible feedback
 * ```
 *
 * ## Thread-to-session mapping
 *
 * Each Slack thread (identified by channelId + thread_ts) maps to exactly one
 * Claude Managed Agent session. The first message in a thread creates a new
 * session; subsequent messages in the same thread reuse the existing session.
 *
 * ## Error handling
 *
 * - Session creation failures are reported to the Slack thread.
 * - Stream errors are caught and posted as error messages in the thread.
 * - The SlackPoster is always finalized (via `finish()`) to prevent resource leaks.
 */

import type { WebClient } from "@slack/web-api";
import type { ChannelMessage } from "../../core/channel-adapter.js";
import type { AgentClient } from "../../core/agent-client.js";
import { SessionOutputReader } from "../../core/session-output-reader.js";
import { SessionManager } from "../../core/session-manager.js";
import { SlackPoster } from "./slack-poster.js";
import type { SlackPosterOptions } from "./slack-poster.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackThreadResponderConfig {
  /** Slack WebClient for posting messages */
  client: WebClient;

  /** Claude agent client for session management */
  agentClient: AgentClient;

  /** Session manager for thread-to-session mapping */
  sessionManager: SessionManager;

  /**
   * Channel type identifier used in session manager keys.
   * @default "slack"
   */
  channelType?: string;

  /**
   * Options forwarded to each SlackPoster instance.
   * channelId and threadTs are set per-message; the rest can be configured here.
   */
  posterOptions?: Partial<Pick<SlackPosterOptions,
    "batchIntervalMs" | "batchMaxSize" | "rateLimitMaxTokens" | "rateLimitRefillRate"
  >>;

  /**
   * Maximum retries for the SessionOutputReader on transient errors.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay in ms between retries (doubled each attempt).
   * @default 1000
   */
  retryDelayMs?: number;

  /**
   * Custom error message formatter.
   * Receives the error string and returns the message to post in Slack.
   */
  formatError?: (error: string) => string;
}

/** Result of handling a single message */
export interface HandleMessageResult {
  /** Whether a new session was created (vs. reusing an existing one) */
  sessionCreated: boolean;

  /** The Claude session ID used */
  sessionId: string;

  /** Number of Slack messages posted for this response */
  messageCount: number;

  /** Whether the response completed successfully */
  success: boolean;

  /** Error message if success is false */
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHANNEL_TYPE = "slack";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** Default error formatter */
function defaultFormatError(error: string): string {
  return `⚠️ Sorry, I encountered an error processing your message.\n\n\`\`\`\n${error}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// SlackThreadResponder
// ---------------------------------------------------------------------------

/**
 * Coordinates Claude Managed Agent sessions with Slack threads.
 *
 * For each incoming message:
 * 1. Resolves or creates a Claude session for the thread
 * 2. Sends the user's text to the session
 * 3. Streams the response back to Slack via a rate-limited poster
 * 4. Handles errors with user-visible feedback
 */
export class SlackThreadResponder {
  private readonly client: WebClient;
  private readonly agentClient: AgentClient;
  private readonly sessionManager: SessionManager;
  private readonly channelType: string;
  private readonly posterOptions: SlackThreadResponderConfig["posterOptions"];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly formatError: (error: string) => string;

  /** Set of threadIds currently being processed (prevents concurrent handling) */
  private readonly activeThreads = new Set<string>();

  constructor(config: SlackThreadResponderConfig) {
    this.client = config.client;
    this.agentClient = config.agentClient;
    this.sessionManager = config.sessionManager;
    this.channelType = config.channelType ?? DEFAULT_CHANNEL_TYPE;
    this.posterOptions = config.posterOptions;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.formatError = config.formatError ?? defaultFormatError;
  }

  /**
   * Handle an incoming channel message by routing it to the appropriate
   * Claude session and streaming the response back to Slack.
   *
   * Thread safety: if a message arrives for a thread that's already being
   * processed, it is queued implicitly — the caller (SlackAdapter) should
   * await this method, and the next message handler invocation will wait.
   *
   * @param message - Normalized channel message from the SlackAdapter
   * @returns Result describing what happened
   */
  async handleMessage(message: ChannelMessage): Promise<HandleMessageResult> {
    const { channelId, threadId, text } = message;
    const threadKey = `${channelId}:${threadId}`;

    // Prevent concurrent handling of the same thread
    if (this.activeThreads.has(threadKey)) {
      // Queue by waiting — the caller will retry or the adapter serializes
      return {
        sessionCreated: false,
        sessionId: "",
        messageCount: 0,
        success: false,
        error: "Thread is already being processed",
      };
    }

    this.activeThreads.add(threadKey);

    try {
      return await this.processMessage(channelId, threadId, text);
    } finally {
      this.activeThreads.delete(threadKey);
    }
  }

  /**
   * Check if a thread is currently being processed.
   */
  isThreadActive(channelId: string, threadId: string): boolean {
    return this.activeThreads.has(`${channelId}:${threadId}`);
  }

  /**
   * Get the number of threads currently being processed.
   */
  get activeThreadCount(): number {
    return this.activeThreads.size;
  }

  // --- Internal ---

  private async processMessage(
    channelId: string,
    threadId: string,
    text: string,
  ): Promise<HandleMessageResult> {
    // Step 1: Resolve or create session
    let sessionId: string;
    let sessionCreated = false;

    try {
      const existing = this.sessionManager.getSession(
        this.channelType,
        channelId,
        threadId,
      );

      if (existing) {
        sessionId = existing;
      } else {
        sessionId = await this.agentClient.createSession();
        this.sessionManager.setSession(
          this.channelType,
          channelId,
          threadId,
          sessionId,
        );
        sessionCreated = true;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.postError(channelId, threadId, errorMsg);
      return {
        sessionCreated: false,
        sessionId: "",
        messageCount: 0,
        success: false,
        error: `Session creation failed: ${errorMsg}`,
      };
    }

    // Step 2: Create poster for this response
    const poster = new SlackPoster(this.client, {
      channelId,
      threadTs: threadId,
      ...this.posterOptions,
    });

    // Step 3: Stream agent response to Slack
    try {
      const reader = new SessionOutputReader(
        this.agentClient,
        sessionId,
        text,
        {
          maxRetries: this.maxRetries,
          retryDelayMs: this.retryDelayMs,
        },
      );

      let streamError: string | undefined;

      reader.on("text_delta", (event) => {
        poster.post(event.text);
      });

      reader.on("error", (event) => {
        streamError = event.error;
      });

      // Wait for the stream to complete
      await reader.start();

      // Finalize the poster (flushes remaining batched text)
      await poster.finish();

      if (streamError) {
        await this.postError(channelId, threadId, streamError);
        return {
          sessionCreated,
          sessionId,
          messageCount: poster.messageCount,
          success: false,
          error: streamError,
        };
      }

      return {
        sessionCreated,
        sessionId,
        messageCount: poster.messageCount,
        success: true,
      };
    } catch (err) {
      // Ensure poster is cleaned up even on unexpected errors
      await poster.finish().catch(() => {});

      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.postError(channelId, threadId, errorMsg);

      return {
        sessionCreated,
        sessionId,
        messageCount: poster.messageCount,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Post a formatted error message to a Slack thread.
   */
  private async postError(
    channelId: string,
    threadId: string,
    error: string,
  ): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadId,
        text: this.formatError(error),
      });
    } catch (postErr) {
      // If we can't even post the error, log it
      console.error(
        `[slack] Failed to post error to ${channelId}:${threadId}:`,
        postErr,
      );
    }
  }
}
