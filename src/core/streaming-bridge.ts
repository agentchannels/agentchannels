/**
 * StreamingBridge — Channel-agnostic coordinator that connects a
 * SessionOutputReader (Claude Managed Agent stream) to a ChannelAdapter's
 * streaming response, handling full lifecycle: start → stream → complete/error → cleanup.
 *
 * ## Architecture
 *
 * ```
 *   ChannelMessage
 *     ↓
 *   StreamingBridge.handleMessage()
 *     ├─ SessionManager: resolve or create session
 *     ├─ ChannelAdapter.startStream(): open streaming response
 *     ├─ SessionOutputReader: consume agent SSE events
 *     │    ├─ text_delta → throttled StreamHandle.update()
 *     │    ├─ error → StreamHandle.finish(errorText)
 *     │    └─ done → StreamHandle.finish(fullText)
 *     └─ Cleanup: always finalize StreamHandle, release AbortController
 * ```
 *
 * ## Key design decisions
 *
 * - **Channel-agnostic**: Works with any ChannelAdapter (Slack, Discord, etc.)
 * - **AbortController per message**: Each message gets its own signal for clean cancellation
 * - **Throttled updates**: Batches text deltas to avoid overwhelming platform APIs
 * - **Graceful cleanup**: StreamHandle.finish() is always called, even on errors
 * - **Thread concurrency guard**: Only one response per thread at a time
 */

import type { ChannelAdapter, ChannelMessage, StreamHandle } from "./channel-adapter.js";
import type { AgentClient } from "./agent-client.js";
import { SessionOutputReader } from "./session-output-reader.js";
import { SessionManager } from "./session-manager.js";
import { describeToolUse } from "./tool-descriptions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamingBridgeConfig {
  /** Channel adapter for sending responses */
  adapter: ChannelAdapter;

  /** Claude agent client for session management */
  agentClient: AgentClient;

  /** Session manager for thread-to-session mapping */
  sessionManager: SessionManager;

  /**
   * Minimum character delta between streaming updates.
   * Prevents overwhelming the messaging platform's API.
   * @default 100
   */
  updateThreshold?: number;

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
   * Fallback message when the agent produces no output.
   * @default "I received your message but had no response."
   */
  emptyResponseText?: string;

  /**
   * Custom error message formatter.
   * Receives the raw error string and returns user-visible text.
   */
  formatError?: (error: string) => string;
}

/** Result of handling a single message through the bridge */
export interface BridgeResult {
  /** Whether a new session was created (vs. reusing an existing one) */
  sessionCreated: boolean;

  /** The Claude session ID used */
  sessionId: string;

  /** Whether the response completed successfully */
  success: boolean;

  /** Total characters streamed */
  totalChars: number;

  /** Number of streaming updates sent */
  updateCount: number;

  /** Error message if success is false */
  error?: string;
}

/** Lifecycle phase for observability */
export type BridgePhase =
  | "idle"
  | "session_resolve"
  | "stream_start"
  | "streaming"
  | "completing"
  | "error"
  | "cleanup";

/** Callback for lifecycle phase changes (for logging/metrics) */
export type PhaseChangeCallback = (
  threadKey: string,
  phase: BridgePhase,
  detail?: string,
) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_THRESHOLD = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_EMPTY_RESPONSE = "I received your message but had no response.";

function defaultFormatError(error: string): string {
  return `⚠️ Sorry, I encountered an error: ${error}`;
}

// ---------------------------------------------------------------------------
// StreamingBridge
// ---------------------------------------------------------------------------

/**
 * Coordinates the full lifecycle of bridging a channel message to a
 * Claude Managed Agent session with streaming responses.
 *
 * Designed to be channel-agnostic — works with any ChannelAdapter implementation.
 */
export class StreamingBridge {
  private readonly adapter: ChannelAdapter;
  private readonly agentClient: AgentClient;
  private readonly sessionManager: SessionManager;
  private readonly updateThreshold: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly emptyResponseText: string;
  private readonly formatError: (error: string) => string;

  /** Active threads with their AbortControllers for cancellation */
  private readonly activeThreads = new Map<string, AbortController>();

  /** Optional lifecycle observer */
  private _onPhaseChange?: PhaseChangeCallback;

  constructor(config: StreamingBridgeConfig) {
    this.adapter = config.adapter;
    this.agentClient = config.agentClient;
    this.sessionManager = config.sessionManager;
    this.updateThreshold = config.updateThreshold ?? DEFAULT_UPDATE_THRESHOLD;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.emptyResponseText = config.emptyResponseText ?? DEFAULT_EMPTY_RESPONSE;
    this.formatError = config.formatError ?? defaultFormatError;
  }

  /**
   * Register a lifecycle phase change observer.
   * Useful for logging, metrics, or debugging.
   */
  onPhaseChange(callback: PhaseChangeCallback): void {
    this._onPhaseChange = callback;
  }

  /**
   * Handle an incoming channel message by routing it to the appropriate
   * Claude session and streaming the response back through the adapter.
   *
   * Thread safety: if a message arrives for a thread already being processed,
   * it is rejected immediately with an error result.
   */
  async handleMessage(message: ChannelMessage): Promise<BridgeResult> {
    const { channelId, threadId, text } = message;
    const threadKey = `${this.adapter.name}:${channelId}:${threadId}`;

    // Guard: skip empty messages
    if (!text.trim()) {
      return {
        sessionCreated: false,
        sessionId: "",
        success: false,
        totalChars: 0,
        updateCount: 0,
        error: "Empty message",
      };
    }

    // Guard: prevent concurrent processing of the same thread
    if (this.activeThreads.has(threadKey)) {
      return {
        sessionCreated: false,
        sessionId: "",
        success: false,
        totalChars: 0,
        updateCount: 0,
        error: "Thread is already being processed",
      };
    }

    // Create AbortController for this message's lifecycle
    const abortController = new AbortController();
    this.activeThreads.set(threadKey, abortController);

    try {
      return await this.processMessage(
        channelId,
        threadId,
        text,
        threadKey,
        abortController.signal,
      );
    } finally {
      // Cleanup phase: always remove from active threads
      this.emitPhase(threadKey, "cleanup");
      this.activeThreads.delete(threadKey);
    }
  }

  /**
   * Abort processing for a specific thread.
   * Useful for graceful shutdown or user-initiated cancellation.
   */
  abortThread(channelId: string, threadId: string): boolean {
    const threadKey = `${this.adapter.name}:${channelId}:${threadId}`;
    const controller = this.activeThreads.get(threadKey);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Abort all active threads.
   * Called during graceful shutdown.
   */
  abortAll(): number {
    let count = 0;
    for (const [, controller] of this.activeThreads) {
      controller.abort();
      count++;
    }
    return count;
  }

  /**
   * Check if a thread is currently being processed.
   */
  isThreadActive(channelId: string, threadId: string): boolean {
    const threadKey = `${this.adapter.name}:${channelId}:${threadId}`;
    return this.activeThreads.has(threadKey);
  }

  /**
   * Get the number of threads currently being processed.
   */
  get activeThreadCount(): number {
    return this.activeThreads.size;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async processMessage(
    channelId: string,
    threadId: string,
    text: string,
    threadKey: string,
    signal: AbortSignal,
  ): Promise<BridgeResult> {
    // Phase 1: Resolve or create session
    this.emitPhase(threadKey, "session_resolve");

    let sessionId: string;
    let sessionCreated = false;

    try {
      const existing = this.sessionManager.getSession(
        this.adapter.name,
        channelId,
        threadId,
      );

      if (existing) {
        sessionId = existing;
      } else {
        sessionId = await this.agentClient.createSession();
        this.sessionManager.setSession(
          this.adapter.name,
          channelId,
          threadId,
          sessionId,
        );
        sessionCreated = true;
      }
    } catch (err) {
      this.emitPhase(threadKey, "error", "session_creation_failed");
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.sendErrorMessage(channelId, threadId, errorMsg);
      return {
        sessionCreated: false,
        sessionId: "",
        success: false,
        totalChars: 0,
        updateCount: 0,
        error: `Session creation failed: ${errorMsg}`,
      };
    }

    // Phase 2: Start streaming response
    this.emitPhase(threadKey, "stream_start");

    let stream: StreamHandle | undefined;

    try {
      stream = await this.adapter.startStream(channelId, threadId);
    } catch (err) {
      this.emitPhase(threadKey, "error", "stream_start_failed");
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.sendErrorMessage(channelId, threadId, errorMsg);
      return {
        sessionCreated,
        sessionId,
        success: false,
        totalChars: 0,
        updateCount: 0,
        error: `Stream start failed: ${errorMsg}`,
      };
    }

    // Phase 3: Stream agent response
    this.emitPhase(threadKey, "streaming");

    let fullText = "";
    let lastUpdateLength = 0;
    let updateCount = 0;
    let streamError: string | undefined;

    try {
      const reader = new SessionOutputReader(
        this.agentClient,
        sessionId,
        text,
        {
          maxRetries: this.maxRetries,
          retryDelayMs: this.retryDelayMs,
          signal,
        },
      );

      // Status message tracking (for tool use / thinking indicators)
      let statusMessageId: string | undefined;
      let statusDeleted = false;
      let textStarted = false;

      const postOrUpdateStatus = async (text: string) => {
        if (statusDeleted || !this.adapter.postStatusMessage) return;
        try {
          if (!statusMessageId) {
            statusMessageId = await this.adapter.postStatusMessage(channelId, threadId, text);
          } else if (this.adapter.updateStatusMessage) {
            await this.adapter.updateStatusMessage(channelId, statusMessageId, text);
          }
        } catch {
          // Non-critical
        }
      };

      const deleteStatus = async () => {
        if (statusDeleted || !statusMessageId) return;
        statusDeleted = true;
        if (this.adapter.deleteMessage) {
          await this.adapter.deleteMessage(channelId, statusMessageId).catch(() => {});
        }
      };

      // Collect errors from the reader
      reader.on("error", (event) => {
        streamError = event.error;
      });

      // Process text deltas with throttled updates
      reader.on("text_delta", (event) => {
        fullText += event.text;
        // Delete status message when first text arrives
        if (!textStarted) {
          textStarted = true;
          deleteStatus();
        }
      });

      // Show tool use as a status message
      reader.on("tool_use", (event) => {
        if (!textStarted) {
          const description = describeToolUse(event.name, event.input);
          postOrUpdateStatus(`:hourglass_flowing_sand: Working on it...\n${description}`);
        }
      });

      // Show thinking indicator
      reader.on("thinking", () => {
        if (!textStarted && !statusMessageId) {
          postOrUpdateStatus(":thought_balloon: Thinking...");
        }
      });

      // Use a polling approach: start the reader and periodically flush updates
      // We attach a flush interval that sends accumulated text to the stream
      const flushInterval = setInterval(async () => {
        if (fullText.length - lastUpdateLength >= this.updateThreshold) {
          try {
            await stream!.update(fullText);
            updateCount++;
            lastUpdateLength = fullText.length;
          } catch {
            // Update failures are non-fatal; finish() will send final text
          }
        }
      }, 50);

      try {
        // Wait for the stream to complete
        await reader.start();
      } finally {
        clearInterval(flushInterval);
        await deleteStatus();
      }

      // Send any remaining un-flushed text as a final update before finishing
      if (fullText.length > lastUpdateLength) {
        try {
          await stream.update(fullText);
          updateCount++;
        } catch {
          // Non-fatal
        }
      }

      // Phase 4: Complete or error
      if (streamError) {
        this.emitPhase(threadKey, "error", streamError);
        await stream.finish(this.formatError(streamError));
        return {
          sessionCreated,
          sessionId,
          success: false,
          totalChars: fullText.length,
          updateCount,
          error: streamError,
        };
      }

      this.emitPhase(threadKey, "completing");
      await stream.finish(fullText || this.emptyResponseText);

      return {
        sessionCreated,
        sessionId,
        success: true,
        totalChars: fullText.length,
        updateCount,
      };
    } catch (err) {
      // Unexpected error during streaming
      this.emitPhase(threadKey, "error", "unexpected_stream_error");
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Always finalize the stream handle
      if (stream) {
        await stream.finish(this.formatError(errorMsg)).catch(() => {});
      }

      return {
        sessionCreated,
        sessionId,
        success: false,
        totalChars: fullText.length,
        updateCount,
        error: errorMsg,
      };
    }
  }

  /**
   * Send an error message to a channel thread (non-streaming fallback).
   */
  private async sendErrorMessage(
    channelId: string,
    threadId: string,
    error: string,
  ): Promise<void> {
    try {
      await this.adapter.sendMessage(
        channelId,
        threadId,
        this.formatError(error),
      );
    } catch (sendErr) {
      console.error(
        `[streaming-bridge] Failed to send error to ${channelId}:${threadId}:`,
        sendErr,
      );
    }
  }

  /**
   * Emit a lifecycle phase change event.
   */
  private emitPhase(threadKey: string, phase: BridgePhase, detail?: string): void {
    this._onPhaseChange?.(threadKey, phase, detail);
  }
}
