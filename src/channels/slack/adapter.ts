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

    const result = await client.chat.startStream({
      token: tok,
      channel: channelId,
      thread_ts: threadId,
      task_display_mode: "plan",
      ...(this.teamId ? { recipient_team_id: this.teamId } : {}),
      ...(userId ? { recipient_user_id: userId } : {}),
    });
    const messageTs = result.ts!;

    return {
      append: async (delta: string) => {
        if (!delta) return;
        await client.chat.appendStream({
          token: tok,
          channel: channelId,
          ts: messageTs,
          chunks: [{ type: "markdown_text", text: delta }],
        });
      },
      appendTasks: async (tasks: StreamTask[]) => {
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
      },
      finish: async (finalText?: string) => {
        await client.chat.stopStream({
          token: tok,
          channel: channelId,
          ts: messageTs,
          ...(finalText
            ? { chunks: [{ type: "markdown_text" as const, text: finalText }] }
            : {}),
        });
      },
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
