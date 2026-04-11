import { App } from "@slack/bolt";
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

    // Resolve bot user ID for mention detection
    try {
      const authResult = await this.app.client.auth.test({ token: this.config.botToken });
      this.botUserId = authResult.user_id as string;
      console.log(`[slack] Connected as @${authResult.user} (${this.botUserId})`);
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

  async startStream(channelId: string, threadId: string): Promise<StreamHandle> {
    const client = this.app.client as any;
    const tok = this.config.botToken;

    // Slack Agent SDK streaming with plan mode for task indicators
    const result = await client.chat.startStream({
      token: tok,
      channel: channelId,
      thread_ts: threadId,
      task_display_mode: "plan",
    });
    const messageTs = result.ts;

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
            type: "task_update",
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
            ? { chunks: [{ type: "markdown_text", text: finalText }] }
            : {}),
        });
      },
    };
  }

  /**
   * Set the agent loading status in the thread.
   * Shows a status indicator with rotating loading messages.
   */
  async setStatus(channelId: string, threadId: string, status: string): Promise<void> {
    const client = this.app.client as any;
    await client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadId,
      status: status,
    });
  }

  /**
   * Clear the agent loading status.
   */
  async clearStatus(channelId: string, threadId: string): Promise<void> {
    await this.setStatus(channelId, threadId, "");
  }

  /**
   * Set the thread title (shown in the agent thread UI).
   */
  async setTitle(channelId: string, threadId: string, title: string): Promise<void> {
    const client = this.app.client as any;
    await client.assistant.threads.setTitle({
      channel_id: channelId,
      thread_ts: threadId,
      title,
    });
  }

  private setupListeners(): void {
    // Listen for @mentions in channels
    this.app.event("app_mention", async ({ event }: { event: any }) => {
      const message = this.toChannelMessage(event, true, false);
      await this.dispatchMessage(message);
    });

    // Listen for DMs
    this.app.message(async ({ message: msg }: { message: any }) => {
      // Only handle actual user messages (not bot messages, not edits)
      if (!msg || msg.subtype) return;
      const event = msg;

      // Check if this is a DM
      const isDM = event.channel_type === "im";
      if (!isDM) return; // Channel messages handled by app_mention

      const message = this.toChannelMessage(event, false, true);
      await this.dispatchMessage(message);
    });
  }

  private toChannelMessage(
    event: any,
    isMention: boolean,
    isDirectMessage: boolean,
  ): ChannelMessage {
    // Use thread_ts if replying in a thread, otherwise use the message ts as thread root
    const threadId = event.thread_ts ?? event.ts;

    // Strip bot mention from text if present
    let text = event.text ?? "";
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "").trim();
    }

    return {
      id: event.ts ?? event.event_ts ?? "",
      channelId: event.channel,
      threadId,
      userId: event.user,
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
