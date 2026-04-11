import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelMessage, MessageHandler } from "../../../src/core/channel-adapter.js";

// Capture listener registrations from @slack/bolt
type EventCallback = (args: any) => Promise<void>;
const eventListeners: Record<string, EventCallback> = {};
const messageListeners: EventCallback[] = [];

const mockClient = {
  auth: {
    test: vi.fn(),
  },
  chat: {
    postMessage: vi.fn(),
    update: vi.fn(),
    startStream: vi.fn(),
    appendStream: vi.fn(),
    stopStream: vi.fn(),
  },
  apiCall: vi.fn(),
};

vi.mock("@slack/bolt", () => {
  class MockApp {
    client = mockClient;

    constructor(_opts?: any) {}

    event(eventName: string, callback: EventCallback) {
      eventListeners[eventName] = callback;
    }

    message(callback: EventCallback) {
      messageListeners.push(callback);
    }

    async start() {}
    async stop() {}
  }

  return { App: MockApp };
});

// Import after mocks are set up
import { SlackAdapter } from "../../../src/channels/slack/adapter.js";

describe("SlackAdapter event listeners", () => {
  let adapter: SlackAdapter;
  let receivedMessages: ChannelMessage[];
  let handler: MessageHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear captured listeners
    for (const key of Object.keys(eventListeners)) delete eventListeners[key];
    messageListeners.length = 0;

    receivedMessages = [];
    handler = async (msg: ChannelMessage) => {
      receivedMessages.push(msg);
    };

    adapter = new SlackAdapter({
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
    });

    adapter.onMessage(handler);
  });

  describe("app_mention events", () => {
    it("registers an app_mention listener", () => {
      expect(eventListeners["app_mention"]).toBeDefined();
    });

    it("routes @mention messages to handlers with isMention=true", async () => {
      const mentionEvent = {
        ts: "1234567890.123456",
        channel: "C123CHANNEL",
        user: "U123USER",
        text: "<@UBOTID> hello there",
        thread_ts: undefined,
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0];
      expect(msg.isMention).toBe(true);
      expect(msg.isDirectMessage).toBe(false);
      expect(msg.channelId).toBe("C123CHANNEL");
      expect(msg.userId).toBe("U123USER");
    });

    it("uses message ts as threadId when not in a thread", async () => {
      const mentionEvent = {
        ts: "1234567890.123456",
        channel: "C123",
        user: "U123",
        text: "hello",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].threadId).toBe("1234567890.123456");
    });

    it("uses thread_ts as threadId when replying in a thread", async () => {
      const mentionEvent = {
        ts: "1234567890.999999",
        thread_ts: "1234567890.000001",
        channel: "C123",
        user: "U123",
        text: "hello",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].threadId).toBe("1234567890.000001");
    });

    it("strips bot mention from text after connect resolves botUserId", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });

      await adapter.connect();

      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "<@UBOTID> what is the weather?",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("what is the weather?");
    });

    it("preserves text when bot mention is not present", async () => {
      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "just a message",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("just a message");
    });

    it("strips multiple bot mentions from text", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });
      await adapter.connect();

      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "<@UBOTID> hello <@UBOTID> again",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("hello again");
    });

    it("strips bot mention at end of text", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });
      await adapter.connect();

      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "hey <@UBOTID>",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("hey");
    });

    it("handles empty text field gracefully", async () => {
      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("");
    });

    it("handles missing text field gracefully", async () => {
      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("");
    });

    it("does not strip mentions of other users", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });
      await adapter.connect();

      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "<@UBOTID> please help <@UOTHER> with this",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("please help <@UOTHER> with this");
    });

    it("handles text that is only a bot mention", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });
      await adapter.connect();

      const mentionEvent = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "<@UBOTID>",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].text).toBe("");
    });
  });

  describe("direct message events", () => {
    it("registers a message listener", () => {
      expect(messageListeners.length).toBeGreaterThan(0);
    });

    it("routes DM messages to handlers with isDirectMessage=true", async () => {
      const dmEvent = {
        ts: "9876543210.654321",
        channel: "D123DMCHANNEL",
        channel_type: "im",
        user: "U456USER",
        text: "hello from DM",
      };

      await messageListeners[0]({ message: dmEvent });

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0];
      expect(msg.isDirectMessage).toBe(true);
      expect(msg.isMention).toBe(false);
      expect(msg.channelId).toBe("D123DMCHANNEL");
      expect(msg.userId).toBe("U456USER");
      expect(msg.text).toBe("hello from DM");
    });

    it("ignores messages with subtypes (edits, joins, etc.)", async () => {
      const editEvent = {
        ts: "123.456",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "edited text",
        subtype: "message_changed",
      };

      await messageListeners[0]({ message: editEvent });

      expect(receivedMessages).toHaveLength(0);
    });

    it("ignores channel messages (non-DM)", async () => {
      const channelMsg = {
        ts: "123.456",
        channel: "C123",
        channel_type: "channel",
        user: "U123",
        text: "channel message",
      };

      await messageListeners[0]({ message: channelMsg });

      expect(receivedMessages).toHaveLength(0);
    });

    it("ignores null/undefined messages", async () => {
      await messageListeners[0]({ message: null });
      await messageListeners[0]({ message: undefined });

      expect(receivedMessages).toHaveLength(0);
    });
  });

  describe("message dispatch", () => {
    it("dispatches to multiple handlers", async () => {
      const secondMessages: ChannelMessage[] = [];
      adapter.onMessage(async (msg) => {
        secondMessages.push(msg);
      });

      const event = {
        ts: "123.456",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "hello",
      };

      await messageListeners[0]({ message: event });

      expect(receivedMessages).toHaveLength(1);
      expect(secondMessages).toHaveLength(1);
      expect(receivedMessages[0].text).toBe(secondMessages[0].text);
    });

    it("continues dispatching even if one handler throws", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const secondMessages: ChannelMessage[] = [];

      // Replace handler list: first throws, second collects
      // We need a new adapter for this
      const adapter2 = new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
      });

      adapter2.onMessage(async () => {
        throw new Error("Handler failed");
      });
      adapter2.onMessage(async (msg) => {
        secondMessages.push(msg);
      });

      const event = {
        ts: "123.456",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "hello",
      };

      // Use the latest message listener (from adapter2)
      const latestListener = messageListeners[messageListeners.length - 1];
      await latestListener({ message: event });

      expect(secondMessages).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[slack] Error in message handler:",
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it("includes raw event data in the ChannelMessage", async () => {
      const event = {
        ts: "123.456",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "hello",
        extra_field: "extra_value",
      };

      await messageListeners[0]({ message: event });

      expect(receivedMessages[0].raw).toBe(event);
    });

    it("sets message id from ts", async () => {
      const event = {
        ts: "1234567890.123456",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "hi",
      };

      await messageListeners[0]({ message: event });

      expect(receivedMessages[0].id).toBe("1234567890.123456");
    });

    it("falls back to event_ts for message id", async () => {
      const mentionEvent = {
        event_ts: "1234567890.999999",
        channel: "C123",
        user: "U123",
        text: "hello",
      };

      await eventListeners["app_mention"]({ event: mentionEvent });

      expect(receivedMessages[0].id).toBe("1234567890.999999");
    });
  });

  describe("connect / disconnect", () => {
    it("resolves botUserId on connect", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });

      await adapter.connect();

      // Verify mention stripping works after connect
      const event = {
        ts: "123.456",
        channel: "C123",
        user: "U123",
        text: "<@UBOTID> help me",
      };

      await eventListeners["app_mention"]({ event });
      expect(receivedMessages[0].text).toBe("help me");
    });

    it("handles auth.test failure gracefully", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockClient.auth.test.mockRejectedValue(new Error("Auth failed"));

      // Should not throw
      await adapter.connect();

      expect(warnSpy).toHaveBeenCalledWith(
        "[slack] Could not resolve bot user ID:",
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe("sendMessage()", () => {
    it("posts a message to the correct channel and thread", async () => {
      mockClient.chat.postMessage.mockResolvedValue({ ok: true });

      await adapter.sendMessage("C123CHANNEL", "1234567890.000001", "Hello!");

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        channel: "C123CHANNEL",
        thread_ts: "1234567890.000001",
        text: "Hello!",
      });
    });
  });

  describe("startStream()", () => {
    it("starts a stream, appends deltas with chunks format, and stops", async () => {
      mockClient.chat.startStream.mockResolvedValue({ ok: true, ts: "1234567890.111111" });
      mockClient.chat.appendStream.mockResolvedValue({ ok: true });
      mockClient.chat.stopStream.mockResolvedValue({ ok: true });

      const handle = await adapter.startStream("C123", "1234567890.000001");

      expect(mockClient.chat.startStream).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        channel: "C123",
        thread_ts: "1234567890.000001",
        task_display_mode: "plan",
      });

      await handle.append("Partial");
      expect(mockClient.chat.appendStream).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        channel: "C123",
        ts: "1234567890.111111",
        chunks: [{ type: "markdown_text", text: "Partial" }],
      });

      await handle.finish("Final text");
      expect(mockClient.chat.stopStream).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        channel: "C123",
        ts: "1234567890.111111",
        chunks: [{ type: "markdown_text", text: "Final text" }],
      });
    });

    it("calls stopStream without markdown_text when finish() has no final delta", async () => {
      mockClient.chat.startStream.mockResolvedValue({ ok: true, ts: "1234567890.111111" });
      mockClient.chat.stopStream.mockResolvedValue({ ok: true });

      const handle = await adapter.startStream("C123", "1234567890.000001");

      await handle.finish();
      expect(mockClient.chat.stopStream).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        channel: "C123",
        ts: "1234567890.111111",
      });
    });

    it("skips appendStream when delta is empty", async () => {
      mockClient.chat.startStream.mockResolvedValue({ ok: true, ts: "1234567890.111111" });

      const handle = await adapter.startStream("C123", "1234567890.000001");

      await handle.append("");
      expect(mockClient.chat.appendStream).not.toHaveBeenCalled();
    });
  });

  describe("adapter metadata", () => {
    it("has name 'slack'", () => {
      expect(adapter.name).toBe("slack");
    });

    it("name is lowercase and alphanumeric", () => {
      expect(adapter.name).toMatch(/^[a-z0-9]+$/);
    });

    it("implements the ChannelAdapter interface", () => {
      // Verify all required methods exist
      expect(typeof adapter.connect).toBe("function");
      expect(typeof adapter.disconnect).toBe("function");
      expect(typeof adapter.onMessage).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.startStream).toBe("function");
    });
  });


  describe("message normalization edge cases", () => {
    it("normalizes DM thread correctly (uses ts as threadId for root DMs)", async () => {
      const dmEvent = {
        ts: "111.222",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "root DM message",
      };

      await messageListeners[0]({ message: dmEvent });

      expect(receivedMessages[0].threadId).toBe("111.222");
      expect(receivedMessages[0].id).toBe("111.222");
    });

    it("normalizes DM reply in thread (uses thread_ts as threadId)", async () => {
      const dmEvent = {
        ts: "111.333",
        thread_ts: "111.222",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "reply in DM thread",
      };

      await messageListeners[0]({ message: dmEvent });

      expect(receivedMessages[0].threadId).toBe("111.222");
      expect(receivedMessages[0].id).toBe("111.333");
    });

    it("strips bot mention from DM messages too", async () => {
      mockClient.auth.test.mockResolvedValue({
        user: "testbot",
        user_id: "UBOTID",
      });
      await adapter.connect();

      const dmEvent = {
        ts: "111.222",
        channel: "D123",
        channel_type: "im",
        user: "U123",
        text: "<@UBOTID> help me in DM",
      };

      await messageListeners[0]({ message: dmEvent });

      expect(receivedMessages[0].text).toBe("help me in DM");
    });
  });
});
