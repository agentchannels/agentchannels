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

    // Phase 2: Set loading status and start stream eagerly
    this.emitPhase(threadKey, "stream_start");

    if (this.adapter.setStatus) {
      await this.adapter.setStatus(channelId, threadId, "Thinking...").catch((error) => {
        console.error(`[streaming-bridge] Failed to set status for ${channelId}:${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    let stream: StreamHandle | undefined;
    let fullText = "";
    let updateCount = 0;
    let streamError: string | undefined;

    try {
      stream = await this.adapter.startStream(channelId, threadId);
    } catch (err) {
      console.log(`[streaming-bridge] Failed to start stream for ${channelId}:${threadId}`);
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

      // Task tracking for plan-mode streams
      type TaskInfo = { id: string; text: string; status: "pending" | "in_progress" | "complete" | "error" };
      const tasks: TaskInfo[] = [];
      let taskCounter = 0;
      let thinkingId = 0;

      const sendTasks = async () => {
        if (!stream?.appendTasks || tasks.length === 0) return;
        await stream.appendTasks([...tasks]).catch(() => {});
      };

      const markAllComplete = () => {
        for (const t of tasks) {
          if (t.status !== "complete") t.status = "complete";
        }
      };

      // Add initial task right after stream starts
      tasks.push({ id: "init", text: "Initializing...", status: "in_progress" });
      await sendTasks();

      reader.on("error", (event) => {
        streamError = event.error;
      });

      reader.on("done", async () => {
        markAllComplete();
        await sendTasks();
        if (this.adapter.clearStatus) {
          await this.adapter.clearStatus(channelId, threadId).catch(() => {});
        }
      });

      reader.on("text_delta", async (event) => {
        console.log(`[streaming-bridge] Received text delta for ${channelId}:${threadId}: ${event.text.substring(0, 80)} (total chars: ${fullText.length})`);
        fullText += event.text;
        await stream!.append(event.text).catch(() => {});
        updateCount++;
      });

      reader.on("thinking", async (event) => {
        // Complete init task when thinking starts
        const initTask = tasks.find((t) => t.id === "init");
        if (initTask && initTask.status === "in_progress") {
          initTask.status = "complete";
        }
        for (const t of tasks) {
          if (t.id.startsWith("thinking_") && t.status === "in_progress") {
            t.status = "complete";
          }
        }
        const id = `thinking_${++thinkingId}`;
        const hasTools = tasks.some((t) => t.id.startsWith("tool_"));
        let label: string;
        if (event.text) {
          const preview = event.text.length > 80 ? event.text.slice(0, 77) + "..." : event.text;
          label = preview;
        } else if (hasTools) {
          label = "Processing results...";
        } else if (thinkingId === 1) {
          label = "Analyzing your request...";
        } else {
          label = "Thinking...";
        }
        tasks.push({ id, text: label, status: "in_progress" });
        await sendTasks();
      });

      reader.on("tool_use", async (event) => {
        for (const t of tasks) {
          if (t.id.startsWith("thinking_") && t.status === "in_progress") {
            t.status = "complete";
          }
        }
        const description = describeToolUse(event.name, event.input);
        const toolId = `tool_${++taskCounter}`;
        tasks.push({ id: toolId, text: description, status: "in_progress" });
        await sendTasks();
      });

      reader.on("tool_result", async (event) => {
        for (let i = tasks.length - 1; i >= 0; i--) {
          if (tasks[i].id.startsWith("tool_") && tasks[i].status === "in_progress") {
            if (event.name) {
              tasks[i].text = describeToolUse(event.name, {}) + " ✓";
            }
            tasks[i].status = "complete";
            break;
          }
        }
        await sendTasks();
      });

      try {
        await reader.start();
      } finally {
        console.log(`[streaming-bridge] Stream ended for ${channelId}:${threadId}. Total chars: ${fullText.length}, updates: ${updateCount}, error: ${streamError}`);
        if (this.adapter.clearStatus) {
          await this.adapter.clearStatus(channelId, threadId).catch((error) => { console.error(`[streaming-bridge] Failed to clear status for ${channelId}:${threadId}: ${error instanceof Error ? error.message : String(error)}`); });
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
      if (fullText.length > 0) {
        await stream.finish();
      } else {
        await stream.finish(this.emptyResponseText);
      }

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

      // Finalize the stream handle, or fall back to sendMessage
      if (stream) {
        await stream.finish(this.formatError(errorMsg)).catch(() => {});
      } else {
        await this.sendErrorMessage(channelId, threadId, errorMsg);
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
      console.log(`[streaming-bridge] Sending error message to ${channelId}:${threadId}: ${error}`);
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
