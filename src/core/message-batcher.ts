/**
 * Message batcher that accumulates incoming text chunks and flushes
 * them as a single combined message after a configurable time window
 * or size threshold.
 *
 * This is essential for bridging Claude's streaming text deltas to
 * messaging platforms like Slack that have rate limits on message
 * updates. Instead of sending every tiny chunk, the batcher collects
 * chunks and flushes them at sensible intervals.
 *
 * ## Flush triggers
 *
 * A flush occurs when ANY of these conditions is met:
 * 1. The accumulated text reaches the `maxSize` threshold (bytes)
 * 2. The `flushIntervalMs` timer fires since the first un-flushed chunk
 * 3. `flush()` is called manually (e.g., on stream completion)
 *
 * ## Lifecycle
 *
 * ```
 *   new MessageBatcher(options)
 *     → add(text) repeatedly
 *     → flush() when done
 *     → dispose() to clean up timers
 * ```
 */

/**
 * Configuration options for the MessageBatcher.
 */
export interface MessageBatcherOptions {
  /**
   * Maximum time in milliseconds to wait before flushing accumulated chunks.
   * The timer starts when the first chunk arrives after the previous flush.
   * @default 300
   */
  flushIntervalMs?: number;

  /**
   * Maximum accumulated text size (in characters) before triggering an immediate flush.
   * Set to `Infinity` to disable size-based flushing.
   * @default 2000
   */
  maxSize?: number;

  /**
   * Callback invoked on each flush with the accumulated text.
   * If the callback returns a Promise, the batcher awaits it before resetting.
   */
  onFlush: (text: string) => void | Promise<void>;
}

/** Default flush interval: 300ms balances responsiveness vs. rate limits */
const DEFAULT_FLUSH_INTERVAL_MS = 300;

/** Default max size: 2000 chars — well within Slack's message limits */
const DEFAULT_MAX_SIZE = 2000;

/**
 * Accumulates text chunks and flushes them as a single combined message
 * based on configurable time and size thresholds.
 */
export class MessageBatcher {
  private readonly flushIntervalMs: number;
  private readonly maxSize: number;
  private readonly onFlush: (text: string) => void | Promise<void>;

  /** Accumulated text chunks waiting to be flushed */
  private chunks: string[] = [];
  /** Current accumulated size in characters */
  private currentSize = 0;
  /** Timer handle for interval-based flushing */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the batcher has been disposed */
  private disposed = false;
  /** Lock to prevent concurrent flushes */
  private flushing = false;
  /** Queue of pending flush promises for orderly shutdown */
  private flushPromise: Promise<void> = Promise.resolve();

  constructor(options: MessageBatcherOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.onFlush = options.onFlush;
  }

  /**
   * Add a text chunk to the batch.
   *
   * If the accumulated size reaches `maxSize`, triggers an immediate flush.
   * If this is the first chunk since the last flush, starts the flush timer.
   *
   * @param text - The text chunk to accumulate
   */
  add(text: string): void {
    if (this.disposed) return;
    if (text.length === 0) return;

    this.chunks.push(text);
    this.currentSize += text.length;

    // Start timer on first chunk after a flush
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.scheduleFlush();
      }, this.flushIntervalMs);
    }

    // Immediate flush if size threshold exceeded
    if (this.currentSize >= this.maxSize) {
      this.scheduleFlush();
    }
  }

  /**
   * Manually flush any accumulated chunks immediately.
   *
   * Call this when the stream completes to ensure no text is left buffered.
   * Safe to call even if there's nothing to flush.
   *
   * @returns Promise that resolves when the flush callback completes
   */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.doFlush();
    // Wait for any in-flight flush to complete
    await this.flushPromise;
  }

  /**
   * Dispose the batcher, clearing timers and preventing further operations.
   *
   * Flushes any remaining chunks before disposing.
   * After disposal, calls to `add()` are silently ignored.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.flush();
    this.disposed = true;
  }

  /**
   * Returns the number of characters currently buffered.
   */
  get bufferedSize(): number {
    return this.currentSize;
  }

  /**
   * Returns the number of chunks currently buffered.
   */
  get bufferedChunks(): number {
    return this.chunks.length;
  }

  /**
   * Returns whether the batcher has been disposed.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  // --- Internal helpers ---

  private scheduleFlush(): void {
    this.clearTimer();
    this.flushPromise = this.flushPromise.then(() => this.doFlush());
  }

  private async doFlush(): Promise<void> {
    if (this.flushing || this.chunks.length === 0) return;

    this.flushing = true;
    const text = this.chunks.join("");
    this.chunks = [];
    this.currentSize = 0;

    try {
      await this.onFlush(text);
    } finally {
      this.flushing = false;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
