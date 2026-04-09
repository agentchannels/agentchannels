/**
 * SessionOutputReader orchestrates the SSE connection and chunk parser
 * for a Claude Managed Agent session, exposing both an async iterable
 * and an EventEmitter interface with error handling and reconnection logic.
 *
 * Usage (async iterable):
 *   const reader = new SessionOutputReader(client, sessionId, "Hello");
 *   for await (const event of reader) {
 *     if (event.type === "text_delta") process.stdout.write(event.text);
 *   }
 *
 * Usage (EventEmitter):
 *   const reader = new SessionOutputReader(client, sessionId, "Hello");
 *   reader.on("text_delta", (e) => process.stdout.write(e.text));
 *   reader.on("done", () => console.log("Complete"));
 *   reader.on("error", (e) => console.error(e.error));
 *   await reader.start();
 */

import { EventEmitter } from "node:events";
import type { AgentClient } from "./agent-client.js";
import type { AgentStreamEvent } from "./chunk-parser.js";

export interface SessionOutputReaderOptions {
  /** Maximum number of reconnection attempts on transient errors (default: 3) */
  maxRetries?: number;
  /** Base delay in ms between retries, doubled each attempt (default: 1000) */
  retryDelayMs?: number;
  /** If true, emit raw events alongside parsed events (default: false) */
  emitRawEvents?: boolean;
  /** AbortSignal to cancel the stream */
  signal?: AbortSignal;
}

/** Events emitted by SessionOutputReader */
export interface SessionOutputReaderEvents {
  text_delta: [AgentStreamEvent & { type: "text_delta" }];
  tool_use: [AgentStreamEvent & { type: "tool_use" }];
  thinking: [AgentStreamEvent & { type: "thinking" }];
  status: [AgentStreamEvent & { type: "status" }];
  done: [AgentStreamEvent & { type: "done" }];
  error: [AgentStreamEvent & { type: "error" }];
  raw: [AgentStreamEvent & { type: "raw" }];
  retry: [{ attempt: number; maxRetries: number; delayMs: number }];
}

/**
 * Determines whether an error is transient (network issue, 5xx, overloaded)
 * and therefore worth retrying, vs. permanent (4xx auth/validation).
 */
export function isTransientError(error: string): boolean {
  const transientPatterns = [
    /network/i,
    /timeout/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /socket hang up/i,
    /503/,
    /502/,
    /504/,
    /529/,
    /overloaded/i,
    /rate limit/i,
    /stream (aborted|ended|terminated)/i,
  ];
  return transientPatterns.some((p) => p.test(error));
}

/**
 * Orchestrates an SSE connection to a Claude Managed Agent session,
 * parses chunks via the AgentClient's sendMessage generator, and
 * exposes results through both async iteration and EventEmitter patterns.
 */
export class SessionOutputReader extends EventEmitter {
  private readonly client: AgentClient;
  private readonly sessionId: string;
  private readonly text: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly emitRawEvents: boolean;
  private readonly signal?: AbortSignal;

  private _started = false;
  private _completed = false;
  private _aborted = false;
  private _attempts = 0;

  constructor(
    client: AgentClient,
    sessionId: string,
    text: string,
    options?: SessionOutputReaderOptions,
  ) {
    super();
    this.client = client;
    this.sessionId = sessionId;
    this.text = text;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
    this.emitRawEvents = options?.emitRawEvents ?? false;
    this.signal = options?.signal;

    // Wire up abort signal (check both current state and future events)
    if (this.signal) {
      if (this.signal.aborted) {
        this._aborted = true;
      } else {
        this.signal.addEventListener("abort", () => {
          this._aborted = true;
        }, { once: true });
      }
    }
  }

  /** Whether the reader has completed (done or terminal error) */
  get completed(): boolean {
    return this._completed;
  }

  /** Number of attempts made (initial + retries) */
  get attempts(): number {
    return this._attempts;
  }

  /**
   * Start reading the stream, emitting events.
   * Handles reconnection on transient errors up to maxRetries.
   * Resolves when the stream completes or all retries are exhausted.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("SessionOutputReader has already been started");
    }
    this._started = true;

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this._attempts = attempt + 1;

      if (this._aborted) {
        const errorEvent: AgentStreamEvent = { type: "error", error: "Stream aborted" };
        this.emit("error", errorEvent);
        this._completed = true;
        return;
      }

      // Emit retry event for attempts after the first
      if (attempt > 0) {
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        this.emit("retry", { attempt, maxRetries: this.maxRetries, delayMs: delay });
        await this._delay(delay);

        if (this._aborted) {
          const errorEvent: AgentStreamEvent = { type: "error", error: "Stream aborted" };
          this.emit("error", errorEvent);
          this._completed = true;
          return;
        }
      }

      try {
        const stream = this.client.sendMessage(this.sessionId, this.text, {
          emitRawEvents: this.emitRawEvents,
          signal: this.signal,
        });

        for await (const event of stream) {
          this.emit(event.type, event);

          // Terminal events end the stream
          if (event.type === "done") {
            this._completed = true;
            return;
          }

          if (event.type === "error") {
            const errorMsg = (event as AgentStreamEvent & { type: "error" }).error;

            // Abort errors are not retryable
            if (this._aborted || errorMsg.includes("aborted")) {
              this._completed = true;
              return;
            }

            // Check if error is transient and retryable
            if (isTransientError(errorMsg)) {
              lastError = errorMsg;
              break; // break inner loop to retry (or exhaust retries)
            }

            // Permanent error - give up
            this._completed = true;
            return;
          }
        }

        // If we got here without a done/error event, stream ended normally
        // (sendMessage yields a final { type: "done" } so this shouldn't happen,
        // but handle it defensively)
        if (!lastError) {
          this._completed = true;
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (isTransientError(msg) && attempt < this.maxRetries) {
          lastError = msg;
          continue;
        }

        // Emit non-retryable exception as error event
        const errorEvent: AgentStreamEvent = { type: "error", error: msg };
        this.emit("error", errorEvent);
        this._completed = true;
        return;
      }
    }

    // All retries exhausted
    const errorEvent: AgentStreamEvent = {
      type: "error",
      error: `Max retries (${this.maxRetries}) exceeded. Last error: ${lastError ?? "unknown"}`,
    };
    this.emit("error", errorEvent);
    this._completed = true;
  }

  /**
   * Async iterable interface.
   * Collects events from the EventEmitter into an async generator.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<AgentStreamEvent> {
    // Buffer events and yield them through an async queue
    const buffer: AgentStreamEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const enqueue = (event: AgentStreamEvent) => {
      buffer.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const eventTypes = [
      "text_delta", "tool_use", "thinking", "status", "done", "error", "raw",
    ] as const;

    for (const type of eventTypes) {
      this.on(type, enqueue);
    }

    // Also listen for retry events (not yielded, but triggers wake)
    this.on("retry", () => {
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Start the stream in the background
    const startPromise = this.start().then(() => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    try {
      while (true) {
        // Yield all buffered events
        while (buffer.length > 0) {
          const event = buffer.shift()!;
          yield event;

          // Terminal events end iteration
          if (event.type === "done" || event.type === "error") {
            return;
          }
        }

        // If stream is done and buffer is empty, we're finished
        if (done) return;

        // Wait for next event
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      // Clean up listeners
      for (const type of eventTypes) {
        this.removeListener(type, enqueue);
      }
      // Ensure start() completes
      await startPromise.catch(() => {});
    }
  }

  /** Delay helper that respects abort signal */
  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this._aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);

      if (this.signal) {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        this.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}
