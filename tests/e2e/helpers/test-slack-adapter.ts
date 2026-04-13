/**
 * TestSlackAdapter — in-process Slack adapter for e2e tests.
 *
 * Uses @slack/web-api's WebClient directly (no Bolt App, no Socket Mode).
 * The connect() / disconnect() / onMessage() lifecycle methods are no-ops since
 * e2e tests wire messages manually via bridge.handleMessage() rather than waiting
 * for real Slack events.
 *
 * All send-side methods (startStream, sendMessage, setStatus) make live Slack API
 * calls, satisfying the "Slack round-trip is always live" constraint.
 */

import { WebClient } from "@slack/web-api";
import type {
  ChannelAdapter,
  MessageHandler,
  StreamHandle,
  StreamTask,
} from "../../../src/core/channel-adapter.js";

export class TestSlackAdapter implements ChannelAdapter {
  readonly name = "slack";
  private readonly client: WebClient;
  private teamId: string | undefined;

  /**
   * All task snapshots captured from appendTasks() calls, in chronological order.
   * Each entry is a deep copy of the tasks array at the moment appendTasks was called.
   * Useful for asserting the task progression sequence in AC 4 tests.
   */
  private _taskSnapshots: StreamTask[][] = [];

  constructor(private readonly botToken: string) {
    this.client = new WebClient(botToken);
  }

  /**
   * Resolve team ID from auth.test so it can be included in chat.startStream.
   * Called from beforeAll in the test; safe to call multiple times.
   */
  async connect(): Promise<void> {
    try {
      const auth = await this.client.auth.test({ token: this.botToken });
      this.teamId = auth.team_id as string;
    } catch (err) {
      // Non-fatal: teamId is optional in startStream
      console.warn("[TestSlackAdapter] auth.test failed:", err);
    }
  }

  /** No-op: no persistent connection to close */
  async disconnect(): Promise<void> {}

  /** No-op: messages are injected manually via bridge.handleMessage() */
  onMessage(_handler: MessageHandler): void {}

  /** Post a plain text message to a thread (used for error fallbacks) */
  async sendMessage(channelId: string, threadId: string, text: string): Promise<void> {
    await this.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      thread_ts: threadId,
      text,
    });
  }

  /**
   * Open a streaming response in the thread.
   * Returns a StreamHandle backed by chat.appendStream / chat.stopStream.
   */
  async startStream(
    channelId: string,
    threadId: string,
    userId?: string,
  ): Promise<StreamHandle> {
    // chat.startStream / appendStream / stopStream are in @slack/web-api ≥ 7
    // Cast through any to handle TypeScript definitions that may lag the API.
    const chatAny = this.client.chat as unknown as Record<
      string,
      (params: Record<string, unknown>) => Promise<Record<string, unknown>>
    >;

    const result = await chatAny["startStream"]({
      token: this.botToken,
      channel: channelId,
      thread_ts: threadId,
      task_display_mode: "plan",
      ...(this.teamId ? { recipient_team_id: this.teamId } : {}),
      ...(userId ? { recipient_user_id: userId } : {}),
    });

    const messageTs = result["ts"] as string;

    return {
      append: async (delta: string) => {
        if (!delta) return;
        await chatAny["appendStream"]({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          chunks: [{ type: "markdown_text", text: delta }],
        });
      },

      appendTasks: async (tasks: StreamTask[]) => {
        if (tasks.length === 0) return;
        // Deep-copy snapshot so later mutations to task objects don't corrupt history.
        this._taskSnapshots.push(tasks.map((t) => ({ ...t })));
        await chatAny["appendStream"]({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          chunks: tasks.map((t) => ({
            type: "task_update",
            id: t.id,
            title: t.text,
            status: t.status,
          })),
        });
      },

      finish: async (finalText?: string, finalTasks?: StreamTask[]) => {
        // Record the final task snapshot so assertion helpers that read
        // `finalTaskState` / `taskSnapshots` see the terminal state even
        // though it was delivered via stopStream (not appendTasks).
        if (finalTasks && finalTasks.length > 0) {
          this._taskSnapshots.push(finalTasks.map((t) => ({ ...t })));
        }
        const chunks: Array<
          | { type: "markdown_text"; text: string }
          | { type: "task_update"; id: string; title: string; status: StreamTask["status"] }
        > = [];
        if (finalTasks && finalTasks.length > 0) {
          for (const t of finalTasks) {
            chunks.push({
              type: "task_update",
              id: t.id,
              title: t.text,
              status: t.status,
            });
          }
        }
        if (finalText) {
          chunks.push({ type: "markdown_text", text: finalText });
        }
        await chatAny["stopStream"]({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          ...(chunks.length > 0 ? { chunks } : {}),
        });
      },
    };
  }

  /** Set assistant thread status (best-effort; errors are caught by StreamingBridge) */
  async setStatus(channelId: string, threadId: string, status: string): Promise<void> {
    const assistantAny = this.client.assistant as unknown as {
      threads: {
        setStatus: (params: Record<string, unknown>) => Promise<void>;
      };
    };
    await assistantAny.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadId,
      status,
    });
  }

  /** Clear assistant thread status */
  async clearStatus(channelId: string, threadId: string): Promise<void> {
    await this.setStatus(channelId, threadId, "");
  }

  /**
   * Fetch all thread replies (used in AC 3 Slack thread assertions).
   * Returns the messages array from conversations.replies.
   */
  async fetchThreadReplies(
    channelId: string,
    threadTs: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.client.conversations.replies({
      token: this.botToken,
      channel: channelId,
      ts: threadTs,
    });
    return (result.messages ?? []) as Array<Record<string, unknown>>;
  }

  // ── Plan-mode task capture (AC 4) ─────────────────────────────────────────

  /**
   * All task snapshots emitted via appendTasks(), in chronological order.
   * Each entry is a deep copy of the tasks array at the moment appendTasks()
   * was called, so earlier snapshots are not affected by later mutations.
   *
   * Useful for asserting the full task progression sequence.
   * Resets on each new startStream() invocation (new adapter per test run).
   */
  get taskSnapshots(): ReadonlyArray<ReadonlyArray<StreamTask>> {
    return this._taskSnapshots;
  }

  /**
   * The final task state as emitted in the last appendTasks() call.
   * This represents the terminal state of all plan-mode tasks after streaming.
   * All tasks should have status "complete" if the stream finished normally.
   *
   * Returns an empty array if appendTasks() was never called.
   */
  get finalTaskState(): StreamTask[] {
    const last = this._taskSnapshots[this._taskSnapshots.length - 1];
    return last ? [...last] : [];
  }
}
