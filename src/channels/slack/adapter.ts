import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { AppMentionEvent } from "@slack/types";
import type { GenericMessageEvent } from "@slack/types";
import type {
  ChannelAdapter,
  ChannelMessage,
  MessageHandler,
  StreamHandle,
  StreamTask,
} from "../../core/channel-adapter.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
}

/**
 * Slack implementation of the ChannelAdapter interface.
 * Uses Socket Mode (no public URL required).
 */
export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack";
  private app: App;
  private handlers: MessageHandler[] = [];
  private botUserId: string | undefined;
  private teamId: string | undefined;

  constructor(private config: SlackAdapterConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret || "unused-in-socket-mode",
      socketMode: true,
    });

    this.setupListeners();
  }

  async connect(): Promise<void> {
    // Pre-flight check: verify the app token can open a Socket Mode connection.
    // Bolt's SocketModeClient treats missing_scope as recoverable and silently
    // retries forever, so we catch it early with a clear error message.
    await this.verifySocketModeAccess();

    await this.app.start();

    try {
      const authResult = await this.app.client.auth.test({ token: this.config.botToken });
      this.botUserId = authResult.user_id as string;
      this.teamId = authResult.team_id as string;
      console.log(`[slack] Connected as @${authResult.user} (${this.botUserId}) in team ${this.teamId}`);
    } catch (err) {
      console.warn("[slack] Could not resolve bot user ID:", err);
    }
  }

  /**
   * Verify that the app token has the required scope for Socket Mode
   * by calling `apps.connections.open` directly. This fails fast with
   * a clear message instead of letting Bolt retry silently forever.
   */
  private async verifySocketModeAccess(): Promise<void> {
    const resp = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const data = (await resp.json()) as { ok: boolean; error?: string };

    if (!data.ok && data.error === "missing_scope") {
      throw new Error(
        "[slack] Failed to connect: missing_scope.\n\n"
        + "This usually means Socket Mode is not enabled or the App-Level Token is missing the required scope.\n"
        + "To fix this:\n"
        + "  1. Enable Socket Mode: https://api.slack.com/apps → Settings → Socket Mode → toggle ON\n"
        + '  2. Ensure your App-Level Token (xapp-...) has the "connections:write" scope:\n'
        + "     Basic Information → App-Level Tokens → Generate Token and Scopes\n",
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.app.stop();
    console.log("[slack] Disconnected");
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendMessage(channelId: string, threadId: string, text: string): Promise<void> {
    await this.app.client.chat.postMessage({
      token: this.config.botToken,
      channel: channelId,
      thread_ts: threadId,
      text,
    });
  }

  async startStream(channelId: string, threadId: string, userId?: string): Promise<StreamHandle> {
    const client: WebClient = this.app.client;
    const tok = this.config.botToken;

    // Lazily resolve teamId when connect() has not been called (e.g. in E2E tests).
    // In production connect() always runs first, so this branch is a no-op there.
    if (!this.teamId) {
      try {
        const authResult = await client.auth.test({ token: tok });
        this.teamId = authResult.team_id as string;
        if (!this.botUserId) {
          this.botUserId = authResult.user_id as string;
        }
      } catch (err) {
        console.warn("[slack] Could not resolve team ID for streaming:", err);
      }
    }

    const result = await client.chat.startStream({
      token: tok,
      channel: channelId,
      thread_ts: threadId,
      task_display_mode: "plan",
      ...(this.teamId ? { recipient_team_id: this.teamId } : {}),
      ...(userId ? { recipient_user_id: userId } : {}),
    });
    const messageTs = result.ts!;

    // Serialize all calls on this streaming message onto a single chain.
    // Slack's `chat.appendStream` / `chat.stopStream` are not safe for
    // concurrent invocations against the same `ts`: `append` (text) and
    // `appendTasks` (plan-mode chunks) fired in parallel end up dropping one
    // (message loses either the body or a task_update), and a `stopStream`
    // racing a pending append freezes that chunk as an error in the rendered
    // plan. Every call goes through `enqueue` so Slack receives them in the
    // exact order we emit them.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = <T>(label: string, op: () => Promise<T>): Promise<T> => {
      const next = chain.then(
        () => op(),
        () => op(),
      );
      chain = next.then(
        () => undefined,
        (err) => {
          console.error(`[slack] stream op "${label}" failed:`, err);
        },
      );
      return next;
    };

    return {
      append: (delta: string) =>
        enqueue("append", async () => {
          if (!delta) return;
          await client.chat.appendStream({
            token: tok,
            channel: channelId,
            ts: messageTs,
            chunks: [{ type: "markdown_text", text: delta }],
          });
        }),
      appendTasks: (tasks: StreamTask[]) =>
        enqueue("appendTasks", async () => {
          if (tasks.length === 0) return;
          await client.chat.appendStream({
            token: tok,
            channel: channelId,
            ts: messageTs,
            chunks: tasks.map((t) => ({
              type: "task_update" as const,
              id: t.id,
              title: t.text,
              status: t.status,
            })),
          });
        }),
      finish: (finalText?: string, finalTasks?: StreamTask[]) =>
        enqueue("finish", async () => {
          // Bundle any final task_update chunks together with the closing
          // stopStream so they land atomically. Sending tasks via a separate
          // appendStream immediately before stopStream is not reliable —
          // Slack's backend can apply stopStream first and freeze any
          // still-in_progress task as "error" in the rendered plan block.
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
          await client.chat.stopStream({
            token: tok,
            channel: channelId,
            ts: messageTs,
            ...(chunks.length > 0 ? { chunks } : {}),
          });
        }),
    };
  }

  async setStatus(channelId: string, threadId: string, status: string): Promise<void> {
    await this.app.client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadId,
      status,
    });
  }

  async clearStatus(channelId: string, threadId: string): Promise<void> {
    await this.setStatus(channelId, threadId, "");
  }

  async setTitle(channelId: string, threadId: string, title: string): Promise<void> {
    await this.app.client.assistant.threads.setTitle({
      channel_id: channelId,
      thread_ts: threadId,
      title,
    });
  }

  private setupListeners(): void {
    this.app.event("app_mention", async ({ event }) => {
      const mention = event as AppMentionEvent;
      const message = this.toChannelMessage(mention, true, false);
      await this.dispatchMessage(message);
    });

    this.app.message(async ({ message: msg }) => {
      const event = msg as GenericMessageEvent;
      if (!event || event.subtype !== undefined) return;

      const isDM = event.channel_type === "im";
      if (!isDM) return;

      const message = this.toChannelMessage(event, false, true);
      await this.dispatchMessage(message);
    });
  }

  private toChannelMessage(
    event: AppMentionEvent | GenericMessageEvent,
    isMention: boolean,
    isDirectMessage: boolean,
  ): ChannelMessage {
    const threadId = event.thread_ts ?? event.ts;

    let text = event.text ?? "";
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "").trim();
    }

    return {
      id: event.ts ?? event.event_ts ?? "",
      channelId: event.channel,
      threadId,
      userId: event.user ?? "",
      text,
      isMention,
      isDirectMessage,
      raw: event,
    };
  }

  private async dispatchMessage(message: ChannelMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (err) {
        console.error("[slack] Error in message handler:", err);
      }
    }
  }
}
