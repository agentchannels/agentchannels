import { App } from "@slack/bolt";
import type {
  ChannelAdapter,
  ChannelMessage,
  MessageHandler,
  StreamHandle,
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
    // Use Slack's experimental chat.startStream API for real-time streaming
    // Falls back to regular post + update if unavailable
    try {
      const streamResult = await (this.app.client as any).chat.startStream({
        token: this.config.botToken,
        channel: channelId,
        thread_ts: threadId,
      });

      const streamId = streamResult.stream_id;

      return {
        update: async (text: string) => {
          await (this.app.client as any).chat.updateStream({
            token: this.config.botToken,
            stream_id: streamId,
            text,
          });
        },
        finish: async (text: string) => {
          await (this.app.client as any).chat.stopStream({
            token: this.config.botToken,
            stream_id: streamId,
            text,
          });
        },
      };
    } catch {
      // Fallback: post a placeholder and update it
      const result = await this.app.client.chat.postMessage({
        token: this.config.botToken,
        channel: channelId,
        thread_ts: threadId,
        text: "Thinking...",
      });

      const ts = result.ts!;

      return {
        update: async (text: string) => {
          await this.app.client.chat.update({
            token: this.config.botToken,
            channel: channelId,
            ts,
            text,
          });
        },
        finish: async (text: string) => {
          await this.app.client.chat.update({
            token: this.config.botToken,
            channel: channelId,
            ts,
            text,
          });
        },
      };
    }
  }

  async sendTypingIndicator(channelId: string, _threadId: string): Promise<void> {
    // Slack typing indicators are per-channel (not per-thread)
    // This uses the undocumented but widely-used indicator approach
    try {
      await this.app.client.apiCall("chat.meMessage", {
        token: this.config.botToken,
        channel: channelId,
        text: "_typing…_",
      });
    } catch {
      // Non-critical — silently ignore failures
    }
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
