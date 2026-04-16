import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelMessage, MessageHandler } from "../../../src/core/channel-adapter.js";

// ---------------------------------------------------------------------------
// Discord.js mock
//
// We capture the listeners registered via client.on() / client.once() so
// that individual tests can emit synthetic events and inspect results.
// ---------------------------------------------------------------------------

type Listener = (...args: any[]) => any;

/** Listeners registered with client.on() — persistent, keyed by event name */
const onListeners: Record<string, Listener[]> = {};
/** Listeners registered with client.once() — one-shot, keyed by event name */
const onceListeners: Record<string, Listener[]> = {};

/** Mock channels.fetch — returns a fake channel by default */
const mockChannelsFetch = vi.fn();
/** Mock channel.send — returns a fake sendable message */
const mockSend = vi.fn();
/** Mock message.edit */
const mockEdit = vi.fn();
/** Mock channel.sendTyping */
const mockSendTyping = vi.fn().mockResolvedValue(undefined);

/** Mock client.login */
const mockLogin = vi.fn().mockResolvedValue(undefined);
/** Mock client.destroy */
const mockDestroy = vi.fn();

/** Mock message.startThread — used for guild text channel @mentions */
const mockStartThread = vi.fn();

vi.mock("discord.js", () => {
  class Client {
    channels = { fetch: mockChannelsFetch };

    on(event: string, listener: Listener) {
      if (!onListeners[event]) onListeners[event] = [];
      onListeners[event].push(listener);
      return this;
    }

    once(event: string, listener: Listener) {
      if (!onceListeners[event]) onceListeners[event] = [];
      onceListeners[event].push(listener);
      return this;
    }

    login = mockLogin;
    destroy = mockDestroy;
  }

  return {
    Client,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 512,
      MessageContent: 32768,
      DirectMessages: 4096,
    },
    Partials: {
      Channel: "Channel",
      Message: "Message",
    },
    Events: {
      ClientReady: "ready",
      MessageCreate: "messageCreate",
      Error: "error",
    },
    // Inlined to avoid TDZ issue with vi.mock() hoisting.
    // These numeric values must match CHANNEL_TYPES below.
    ChannelType: {
      GuildText: 0,
      DM: 1,
      GuildVoice: 2,
      GuildAnnouncement: 5,
      AnnouncementThread: 10,
      PublicThread: 11,
      PrivateThread: 12,
    },
  };
});

// Matching numeric values used in test helper message factories.
// Must stay in sync with the ChannelType values inlined in the mock above.
const CHANNEL_TYPES = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
} as const;

// Import AFTER mocks are registered
import { DiscordAdapter } from "../../../src/channels/discord/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BOT_ID = "BOT_DISCORD_ID_9999";
const VALID_BOT_TOKEN = "NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g";

/** Default guild ID used in guild message factories */
const DEFAULT_GUILD_ID = "GUILD-TEST-001";
/** Default thread ID returned by the default startThread mock */
const DEFAULT_CREATED_THREAD_ID = "created-thread-id-001";

/**
 * Simulate Discord's ready event so that connect() resolves and botUserId is set.
 */
async function connectAdapter(adapter: DiscordAdapter, botId = BOT_ID): Promise<void> {
  const connectPromise = adapter.connect();

  // Emit the 'ready' event — this is what connect() awaits via once()
  const readyListeners = onceListeners["ready"] ?? [];
  for (const l of readyListeners) {
    l({ user: { id: botId, tag: "TestBot#0001" } });
  }

  await connectPromise;
}

/**
 * Emit a synthetic messageCreate event through the registered listener.
 */
async function emitMessageCreate(message: object): Promise<void> {
  const listeners = onListeners["messageCreate"] ?? [];
  for (const l of listeners) {
    await l(message);
  }
}

/**
 * Build a minimal mock Discord Message for a guild @mention.
 *
 * Includes `guildId` and a `startThread` spy so that the adapter's
 * thread-creation path (Sub-AC 3) works correctly in tests.
 */
function makeGuildMentionMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "msg001",
    channelId: "channel-guild-001",
    guildId: DEFAULT_GUILD_ID,
    content: `<@${BOT_ID}> hello world`,
    author: { id: "user-abc", bot: false },
    channel: { type: CHANNEL_TYPES.GuildText },
    mentions: { has: (id: string) => id === BOT_ID },
    startThread: mockStartThread,
    ...overrides,
  };
}

/**
 * Build a minimal mock Discord Message for a DM.
 */
function makeDMMessage(overrides: Record<string, unknown> = {}): object {
  return {
    id: "dm-msg-001",
    channelId: "dm-channel-001",
    guildId: null, // DMs have no guild
    content: "hello from DM",
    author: { id: "user-def", bot: false },
    channel: { type: CHANNEL_TYPES.DM },
    mentions: { has: (_id: string) => false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordAdapter @mention detection", () => {
  let adapter: DiscordAdapter;
  let receivedMessages: ChannelMessage[];
  let handler: MessageHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the startThread mock to return a default thread object
    mockStartThread.mockResolvedValue({
      id: DEFAULT_CREATED_THREAD_ID,
      name: "Agent conversation",
    });

    // Clear captured listener maps
    for (const key of Object.keys(onListeners)) delete onListeners[key];
    for (const key of Object.keys(onceListeners)) delete onceListeners[key];

    receivedMessages = [];
    handler = async (msg: ChannelMessage) => {
      receivedMessages.push(msg);
    };

    adapter = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
    adapter.onMessage(handler);

    // Default channel mock returns a sendable GuildText channel
    const fakeChannel = {
      type: CHANNEL_TYPES.GuildText,
      isTextBased: () => true,
      send: mockSend,
      sendTyping: mockSendTyping,
    };
    mockChannelsFetch.mockResolvedValue(fakeChannel);
    mockSend.mockResolvedValue({ id: "sent-msg-id", edit: mockEdit });
    mockEdit.mockResolvedValue({});
  });

  // -------------------------------------------------------------------------
  // Listener registration
  // -------------------------------------------------------------------------

  describe("listener registration", () => {
    it("registers a messageCreate listener during construction", () => {
      expect(onListeners["messageCreate"]).toBeDefined();
      expect(onListeners["messageCreate"].length).toBeGreaterThan(0);
    });

    it("registers ready and error listeners when connect() is called", async () => {
      void adapter.connect();

      expect(onceListeners["ready"]).toBeDefined();
      expect(onceListeners["error"]).toBeDefined();

      // Resolve the connect promise to avoid leaking
      const readyListeners = onceListeners["ready"] ?? [];
      for (const l of readyListeners) l({ user: { id: BOT_ID, tag: "TestBot#0001" } });
    });
  });

  // -------------------------------------------------------------------------
  // Guild @mention events
  // -------------------------------------------------------------------------

  describe("guild @mention events", () => {
    it("dispatches to handlers with isMention=true for guild @mentions", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage());

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0];
      expect(msg.isMention).toBe(true);
      expect(msg.isDirectMessage).toBe(false);
    });

    it("sets channelId to guildId and userId from message.author.id", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          channelId: "channel-guild-xyz",
          guildId: "GUILD-XYZ-SERVER",
          author: { id: "USER-123", bot: false },
        }),
      );

      const msg = receivedMessages[0];
      // channelId carries the guildId so SessionManager key = discord:{guildId}:{threadId}
      expect(msg.channelId).toBe("GUILD-XYZ-SERVER");
      expect(msg.userId).toBe("USER-123");
    });

    // ── Thread boundary management (Sub-AC 3) ───────────────────────────────

    it("creates a public thread on the triggering message for first guild @mention", async () => {
      await connectAdapter(adapter);

      const createdThread = { id: "new-thread-for-mention", name: "Agent conversation" };
      const startThreadSpy = vi.fn().mockResolvedValue(createdThread);

      await emitMessageCreate(
        makeGuildMentionMessage({
          id: "msg-unique-id-777",
          guildId: "GUILD-001",
          channel: { type: CHANNEL_TYPES.GuildText },
          startThread: startThreadSpy,
        }),
      );

      expect(startThreadSpy).toHaveBeenCalledOnce();
      // threadId is the created thread's channel ID (used for API calls)
      expect(receivedMessages[0].threadId).toBe("new-thread-for-mention");
      // channelId is the guildId (used for session key derivation)
      expect(receivedMessages[0].channelId).toBe("GUILD-001");
    });

    it("uses thread message content as thread name (truncated to 100 chars)", async () => {
      await connectAdapter(adapter);

      const startThreadSpy = vi.fn().mockResolvedValue({ id: "t1", name: "" });

      await emitMessageCreate(
        makeGuildMentionMessage({
          content: `<@${BOT_ID}> What is the capital of France?`,
          startThread: startThreadSpy,
          guildId: "GUILD-001",
        }),
      );

      expect(startThreadSpy).toHaveBeenCalledOnce();
      const callArgs = startThreadSpy.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe("What is the capital of France?");
    });

    it("uses 'Agent conversation' as thread name when message text is empty", async () => {
      await connectAdapter(adapter);

      const startThreadSpy = vi.fn().mockResolvedValue({ id: "t1", name: "" });

      await emitMessageCreate(
        makeGuildMentionMessage({
          content: `<@${BOT_ID}>`,
          startThread: startThreadSpy,
          guildId: "GUILD-001",
        }),
      );

      const callArgs = startThreadSpy.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe("Agent conversation");
    });

    it("falls back to message.id as threadId when startThread fails", async () => {
      await connectAdapter(adapter);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const failingStartThread = vi.fn().mockRejectedValue(new Error("Missing permissions"));

      await emitMessageCreate(
        makeGuildMentionMessage({
          id: "fallback-msg-id",
          guildId: "GUILD-001",
          startThread: failingStartThread,
          channel: { type: CHANNEL_TYPES.GuildText },
        }),
      );

      expect(receivedMessages).toHaveLength(1);
      // Falls back to message.id when thread creation fails
      expect(receivedMessages[0].threadId).toBe("fallback-msg-id");
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("reuses an existing PublicThread without creating a new one", async () => {
      await connectAdapter(adapter);

      const startThreadSpy = vi.fn();

      await emitMessageCreate(
        makeGuildMentionMessage({
          id: "msg-in-thread",
          channelId: "thread-channel-id",
          guildId: "GUILD-001",
          channel: { type: CHANNEL_TYPES.PublicThread },
          startThread: startThreadSpy,
        }),
      );

      // No new thread should be created — message is already in a thread
      expect(startThreadSpy).not.toHaveBeenCalled();
      expect(receivedMessages[0].threadId).toBe("thread-channel-id");
    });

    it("uses channelId as threadId for @mentions inside a PublicThread", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          id: "msg-in-thread",
          channelId: "thread-channel-id",
          channel: { type: CHANNEL_TYPES.PublicThread },
        }),
      );

      expect(receivedMessages[0].threadId).toBe("thread-channel-id");
    });

    it("uses channelId as threadId for @mentions inside a PrivateThread", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          id: "msg-in-private-thread",
          channelId: "private-thread-channel-id",
          channel: { type: CHANNEL_TYPES.PrivateThread },
        }),
      );

      expect(receivedMessages[0].threadId).toBe("private-thread-channel-id");
    });

    it("uses channelId as threadId for @mentions inside an AnnouncementThread", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          id: "msg-in-announcement-thread",
          channelId: "announcement-thread-id",
          channel: { type: CHANNEL_TYPES.AnnouncementThread },
        }),
      );

      expect(receivedMessages[0].threadId).toBe("announcement-thread-id");
    });

    it("does not call startThread for messages already in a thread", async () => {
      await connectAdapter(adapter);

      const startThreadSpy = vi.fn();

      for (const threadType of [
        CHANNEL_TYPES.PublicThread,
        CHANNEL_TYPES.PrivateThread,
        CHANNEL_TYPES.AnnouncementThread,
      ]) {
        startThreadSpy.mockClear();
        await emitMessageCreate(
          makeGuildMentionMessage({
            channel: { type: threadType },
            startThread: startThreadSpy,
          }),
        );
        expect(startThreadSpy).not.toHaveBeenCalled();
      }
    });

    it("sets the message id from message.id", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(makeGuildMentionMessage({ id: "msg-id-abc123" }));

      expect(receivedMessages[0].id).toBe("msg-id-abc123");
    });

    it("includes the raw Discord message object in the ChannelMessage", async () => {
      await connectAdapter(adapter);

      const rawMsg = makeGuildMentionMessage();
      await emitMessageCreate(rawMsg);

      expect(receivedMessages[0].raw).toBe(rawMsg);
    });

    // ── Session key derivation ───────────────────────────────────────────────

    it("session key components: channelId=guildId, threadId=createdThreadId", async () => {
      await connectAdapter(adapter);

      const threadId = "session-thread-abc";
      mockStartThread.mockResolvedValueOnce({ id: threadId, name: "test" });

      await emitMessageCreate(
        makeGuildMentionMessage({ guildId: "SESSION-GUILD-001" }),
      );

      const msg = receivedMessages[0];
      // StreamingBridge derives key as: `discord:${channelId}:${threadId}`
      // which should equal `discord:{guildId}:{threadId}`
      expect(msg.channelId).toBe("SESSION-GUILD-001"); // guildId
      expect(msg.threadId).toBe(threadId);             // created thread ID
    });
  });

  // -------------------------------------------------------------------------
  // Mention stripping
  // -------------------------------------------------------------------------

  describe("mention stripping", () => {
    it("strips <@BOT_ID> prefix from message content", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({ content: `<@${BOT_ID}> what is the weather?` }),
      );

      expect(receivedMessages[0].text).toBe("what is the weather?");
    });

    it("strips <@!BOT_ID> (nickname mention) prefix from message content", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({ content: `<@!${BOT_ID}> remind me at noon` }),
      );

      expect(receivedMessages[0].text).toBe("remind me at noon");
    });

    it("strips multiple bot mention occurrences", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          content: `<@${BOT_ID}> hello <@${BOT_ID}> world`,
        }),
      );

      expect(receivedMessages[0].text).toBe("hello world");
    });

    it("strips a bot mention at the end of the text", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({ content: `hey <@${BOT_ID}>` }),
      );

      expect(receivedMessages[0].text).toBe("hey");
    });

    it("handles text that is only a bot mention — produces empty string", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({ content: `<@${BOT_ID}>` }),
      );

      expect(receivedMessages[0].text).toBe("");
    });

    it("does not strip mentions of other users", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          content: `<@${BOT_ID}> please help <@OTHER_USER_ID> with this`,
        }),
      );

      expect(receivedMessages[0].text).toBe("please help <@OTHER_USER_ID> with this");
    });

    it("does not strip mentions when botUserId is unknown (before connect)", async () => {
      // Do NOT call connectAdapter — botUserId is undefined
      await emitMessageCreate(makeGuildMentionMessage({ content: `<@${BOT_ID}> hello` }));

      // isMention is false when botUserId unknown → message is filtered out
      expect(receivedMessages).toHaveLength(0);
    });

    it("preserves text when no bot mention is present", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          content: "plain text message",
          mentions: { has: (id: string) => id === BOT_ID },
        }),
      );

      expect(receivedMessages[0].text).toBe("plain text message");
    });

    it("handles empty content gracefully", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({
          content: `<@${BOT_ID}>`,
        }),
      );

      // After stripping, text is empty
      expect(receivedMessages[0].text).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // Filtering — messages that should NOT be dispatched
  // -------------------------------------------------------------------------

  describe("message filtering", () => {
    it("ignores messages from bots", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeGuildMentionMessage({ author: { id: "another-bot", bot: true } }),
      );

      expect(receivedMessages).toHaveLength(0);
    });

    it("ignores guild messages that do not @mention the bot", async () => {
      await connectAdapter(adapter);

      // mentions.has() returns false — not a mention, not a DM → filtered
      await emitMessageCreate({
        id: "msg-no-mention",
        channelId: "C-GUILD",
        guildId: "G-001",
        content: "just chatting",
        author: { id: "user-xyz", bot: false },
        channel: { type: CHANNEL_TYPES.GuildText },
        mentions: { has: (_id: string) => false },
      });

      expect(receivedMessages).toHaveLength(0);
    });

    it("ignores messages when isMention is false and isDM is false", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate({
        id: "msg-voice",
        channelId: "voice-channel",
        guildId: "G-001",
        content: "some message",
        author: { id: "user-123", bot: false },
        channel: { type: CHANNEL_TYPES.GuildVoice },
        mentions: { has: (_id: string) => false },
      });

      expect(receivedMessages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Direct Message (DM) events
  // -------------------------------------------------------------------------

  describe("direct message events", () => {
    it("dispatches DM messages with isDirectMessage=true and isMention=false", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(makeDMMessage());

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0];
      expect(msg.isDirectMessage).toBe(true);
      expect(msg.isMention).toBe(false);
    });

    it("uses channelId as threadId for DMs (stable per-user session key)", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeDMMessage({
          id: "dm-msg-unique",
          channelId: "dm-channel-stable",
        }),
      );

      expect(receivedMessages[0].threadId).toBe("dm-channel-stable");
    });

    it("sets channelId to '@dm' sentinel and threadId to DM channel ID", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeDMMessage({
          channelId: "DM-CH-999",
          author: { id: "DM-USER-888", bot: false },
        }),
      );

      const msg = receivedMessages[0];
      // DMs have no guild — channelId uses the "@dm" sentinel
      // so the session key is "discord:@dm:DM-CH-999"
      expect(msg.channelId).toBe("@dm");
      // threadId is the actual DM channel ID (used for API calls)
      expect(msg.threadId).toBe("DM-CH-999");
      expect(msg.userId).toBe("DM-USER-888");
    });

    it("passes DM content through without stripping non-bot mentions", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(makeDMMessage({ content: "help me please" }));

      expect(receivedMessages[0].text).toBe("help me please");
    });

    it("strips bot @mention from DM content if the user included it", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeDMMessage({
          content: `<@${BOT_ID}> help me in DM`,
          mentions: { has: (_id: string) => false }, // DMs don't require mention
        }),
      );

      expect(receivedMessages[0].text).toBe("help me in DM");
    });

    it("ignores bot messages in DMs", async () => {
      await connectAdapter(adapter);

      await emitMessageCreate(
        makeDMMessage({ author: { id: "another-bot", bot: true } }),
      );

      expect(receivedMessages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // ChannelMessage shape (normalization)
  // -------------------------------------------------------------------------

  describe("ChannelMessage normalization", () => {
    it("produces a ChannelMessage with all required fields for a guild @mention", async () => {
      await connectAdapter(adapter);

      const threadId = "normalize-created-thread";
      mockStartThread.mockResolvedValueOnce({ id: threadId, name: "test" });

      const raw = makeGuildMentionMessage({
        id: "normalize-msg-id",
        channelId: "normalize-channel-id",
        guildId: "normalize-guild-id",
        content: `<@${BOT_ID}> do something`,
        author: { id: "normalize-user-id", bot: false },
        channel: { type: CHANNEL_TYPES.GuildText },
      });

      await emitMessageCreate(raw);

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0];

      expect(msg).toMatchObject({
        id: "normalize-msg-id",
        // channelId = guildId (for session key "discord:{guildId}:{threadId}")
        channelId: "normalize-guild-id",
        // threadId = created thread's channel ID (for Discord API calls)
        threadId: "normalize-created-thread",
        userId: "normalize-user-id",
        text: "do something",
        isMention: true,
        isDirectMessage: false,
        raw,
      });
    });

    it("produces a ChannelMessage with all required fields for a DM", async () => {
      await connectAdapter(adapter);

      const raw = makeDMMessage({
        id: "dm-norm-msg-id",
        channelId: "dm-norm-channel-id",
        content: "DM content here",
        author: { id: "dm-norm-user-id", bot: false },
      });

      await emitMessageCreate(raw);

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0];

      expect(msg).toMatchObject({
        id: "dm-norm-msg-id",
        // channelId = "@dm" sentinel (DMs have no guild)
        channelId: "@dm",
        // threadId = DM channel ID (stable per-user session key)
        threadId: "dm-norm-channel-id",
        userId: "dm-norm-user-id",
        text: "DM content here",
        isMention: false,
        isDirectMessage: true,
        raw,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Message dispatch (handler management)
  // -------------------------------------------------------------------------

  describe("message dispatch", () => {
    it("dispatches to multiple registered handlers", async () => {
      await connectAdapter(adapter);

      const secondMessages: ChannelMessage[] = [];
      adapter.onMessage(async (msg) => {
        secondMessages.push(msg);
      });

      await emitMessageCreate(makeGuildMentionMessage());

      expect(receivedMessages).toHaveLength(1);
      expect(secondMessages).toHaveLength(1);
      expect(receivedMessages[0].id).toBe(secondMessages[0].id);
    });

    it("continues dispatching to subsequent handlers even if one throws", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const successMessages: ChannelMessage[] = [];

      // Re-create adapter with a throwing first handler + collecting second handler
      const adapter2 = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });

      // Need to grab the latest messageCreate listener (for adapter2)
      const latestListeners = onListeners["messageCreate"] ?? [];

      adapter2.onMessage(async () => {
        throw new Error("First handler exploded");
      });
      adapter2.onMessage(async (msg) => {
        successMessages.push(msg);
      });

      // Emit via the last registered listener (adapter2's)
      const lastListener = latestListeners[latestListeners.length - 1];

      // Connect adapter2 first (sets botUserId)
      const connectP = adapter2.connect();
      const readyL = onceListeners["ready"] ?? [];
      for (const l of readyL) l({ user: { id: BOT_ID, tag: "TestBot#0001" } });
      await connectP;

      await lastListener(makeGuildMentionMessage());

      expect(successMessages).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[discord] Error in message handler:",
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it("does not dispatch before any handlers are registered", async () => {
      const adapter3 = new DiscordAdapter({ botToken: VALID_BOT_TOKEN });
      // No onMessage() registered

      const connectP = adapter3.connect();
      const readyL = onceListeners["ready"] ?? [];
      for (const l of readyL) l({ user: { id: BOT_ID, tag: "Bot#0001" } });
      await connectP;

      // Grab adapter3's listener (last in map)
      const listeners = onListeners["messageCreate"] ?? [];
      const lastListener = listeners[listeners.length - 1];

      // Should not throw even with no handlers
      await expect(lastListener(makeGuildMentionMessage())).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // connect() / disconnect()
  // -------------------------------------------------------------------------

  describe("connect() / disconnect()", () => {
    it("resolves botUserId from the ready event", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await connectAdapter(adapter, "MY_BOT_ID_XYZ");

      // After connect, mention stripping should use the resolved botUserId
      await emitMessageCreate(
        makeGuildMentionMessage({
          content: "<@MY_BOT_ID_XYZ> help!",
          mentions: { has: (id: string) => id === "MY_BOT_ID_XYZ" },
        }),
      );

      expect(receivedMessages[0].text).toBe("help!");
      consoleSpy.mockRestore();
    });

    it("calls client.login() with the bot token during connect()", async () => {
      const connectP = adapter.connect();

      // Immediately emit ready to resolve
      const readyL = onceListeners["ready"] ?? [];
      for (const l of readyL) l({ user: { id: BOT_ID, tag: "TestBot#0001" } });
      await connectP;

      expect(mockLogin).toHaveBeenCalledWith(VALID_BOT_TOKEN);
    });

    it("rejects if login() throws", async () => {
      mockLogin.mockRejectedValueOnce(new Error("Invalid token"));

      await expect(adapter.connect()).rejects.toThrow("Login failed");
    });

    it("calls client.destroy() on disconnect()", async () => {
      await connectAdapter(adapter);
      await adapter.disconnect();

      expect(mockDestroy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Adapter metadata
  // -------------------------------------------------------------------------

  describe("adapter metadata", () => {
    it("has name 'discord'", () => {
      expect(adapter.name).toBe("discord");
    });

    it("name is lowercase and alphanumeric", () => {
      expect(adapter.name).toMatch(/^[a-z0-9]+$/);
    });

    it("implements required ChannelAdapter interface methods", () => {
      expect(typeof adapter.connect).toBe("function");
      expect(typeof adapter.disconnect).toBe("function");
      expect(typeof adapter.onMessage).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.startStream).toBe("function");
    });

    it("implements optional setStatus and clearStatus methods", () => {
      expect(typeof adapter.setStatus).toBe("function");
      expect(typeof adapter.clearStatus).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage()
  // -------------------------------------------------------------------------

  describe("sendMessage()", () => {
    it("fetches the thread channel by threadId and sends the text", async () => {
      await connectAdapter(adapter);

      // channelId is the guildId; threadId is the actual Discord channel to send to
      await adapter.sendMessage("GUILD-001", "THREAD-001", "Hello Discord!");

      expect(mockChannelsFetch).toHaveBeenCalledWith("THREAD-001");
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Hello Discord!" }),
      );
    });

    it("truncates text longer than 2000 characters", async () => {
      await connectAdapter(adapter);

      const longText = "x".repeat(3000);
      await adapter.sendMessage("G-001", "T-001", longText);

      const sentContent: string = mockSend.mock.calls[0][0].content;
      expect(sentContent.length).toBe(2000);
    });

    it("throws if the thread channel is not found", async () => {
      await connectAdapter(adapter);
      mockChannelsFetch.mockResolvedValueOnce(null);

      // The second argument (threadId) is the actual Discord channel to fetch
      await expect(adapter.sendMessage("GUILD", "MISSING-THREAD", "hi")).rejects.toThrow(
        "[discord] Channel MISSING-THREAD not found",
      );
    });
  });

  // -------------------------------------------------------------------------
  // startStream()
  // -------------------------------------------------------------------------

  describe("startStream()", () => {
    it("fetches the thread channel by threadId, not by channelId (guildId)", async () => {
      await connectAdapter(adapter);

      await adapter.startStream("GUILD-001", "THREAD-001");

      // The actual Discord channel/thread is identified by threadId
      expect(mockChannelsFetch).toHaveBeenCalledWith("THREAD-001");
      // The channelId (guildId) must NOT be used for the API call
      expect(mockChannelsFetch).not.toHaveBeenCalledWith("GUILD-001");
    });

    it("posts the initial ⏳ Thinking… placeholder message to the channel", async () => {
      await connectAdapter(adapter);

      await adapter.startStream("GUILD-001", "THREAD-001");

      expect(mockSend).toHaveBeenCalledWith({ content: "⏳ Thinking…" });
    });

    it("returns a StreamHandle with append, appendTasks, and finish methods", async () => {
      await connectAdapter(adapter);

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");

      expect(typeof handle.append).toBe("function");
      expect(typeof handle.appendTasks).toBe("function");
      expect(typeof handle.finish).toBe("function");
    });

    it("the returned handle is a DiscordStreamHandle — finish() edits the initial message", async () => {
      await connectAdapter(adapter);

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");

      // finish() directly edits the placeholder (not rate-limited like append())
      await handle.finish("Agent final response");

      expect(mockEdit).toHaveBeenCalledWith({ content: "Agent final response" });
    });

    it("finish() with no text writes '(no response)' to the placeholder message", async () => {
      await connectAdapter(adapter);

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");
      await handle.finish();

      expect(mockEdit).toHaveBeenCalledWith({ content: "(no response)" });
    });

    it("finish() with finalText argument appends it before flushing", async () => {
      await connectAdapter(adapter);

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");
      await handle.append("Base text");
      await handle.finish(" — final addition");

      const lastCallArgs = mockEdit.mock.calls[mockEdit.mock.calls.length - 1][0] as { content: string };
      expect(lastCallArgs.content).toContain("Base text");
      expect(lastCallArgs.content).toContain("— final addition");
    });

    it("throws if the thread channel is not found", async () => {
      await connectAdapter(adapter);
      mockChannelsFetch.mockResolvedValueOnce(null);

      await expect(adapter.startStream("GUILD", "MISSING-THREAD")).rejects.toThrow(
        "[discord] Channel MISSING-THREAD not found",
      );
    });

    it("throws if the fetched channel is not text-based", async () => {
      await connectAdapter(adapter);
      mockChannelsFetch.mockResolvedValueOnce({
        type: CHANNEL_TYPES.GuildVoice,
        isTextBased: () => false,
      });

      await expect(adapter.startStream("GUILD", "VOICE-CH")).rejects.toThrow(
        "[discord] Channel VOICE-CH is not a text-based channel",
      );
    });

    it("works for DM channels: '@dm' channelId is ignored, real DM channel ID is used", async () => {
      await connectAdapter(adapter);

      // DM channels use "@dm" as channelId (guildId sentinel) but real channel ID as threadId
      const handle = await adapter.startStream("@dm", "dm-channel-real-id");

      // Should fetch by the real DM channel ID
      expect(mockChannelsFetch).toHaveBeenCalledWith("dm-channel-real-id");
      // Should NOT try to fetch "@dm"
      expect(mockChannelsFetch).not.toHaveBeenCalledWith("@dm");
      // Placeholder should be posted to the DM channel
      expect(mockSend).toHaveBeenCalledWith({ content: "⏳ Thinking…" });
      expect(handle).toBeDefined();
    });

    it("ignores the optional userId parameter without error", async () => {
      await connectAdapter(adapter);

      // userId is accepted for interface compatibility but Discord doesn't use it
      const handle = await adapter.startStream("GUILD-001", "THREAD-001", "user-xyz");

      expect(handle).toBeDefined();
      expect(typeof handle.finish).toBe("function");
    });

    it("the placeholder message edit mock is wired — subsequent edits target the same message", async () => {
      await connectAdapter(adapter);

      // Verify that the returned handle targets the message returned by channel.send()
      const specificEditFn = vi.fn().mockResolvedValue({});
      const specificMessage = { id: "specific-msg-id", edit: specificEditFn };
      mockSend.mockResolvedValueOnce(specificMessage);

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");
      await handle.finish("Check target message");

      // edit should have been called on the specific message, not any other
      expect(specificEditFn).toHaveBeenCalledWith({ content: "Check target message" });
      // Default mockEdit should NOT have been called (different message instance)
      expect(mockEdit).not.toHaveBeenCalled();
    });

    // ── Enqueue serialization (Slack-pattern matching) ───────────────────────

    it("returns an enqueue-serialized StreamHandle — not a raw DiscordStreamHandle instance", async () => {
      await connectAdapter(adapter);

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");

      // The returned handle is an enqueue wrapper (plain object), not a raw
      // DiscordStreamHandle. DiscordStreamHandle exposes internal getters like
      // isRateLimited and inFallbackMode that are not part of the StreamHandle
      // interface. Their absence confirms the wrapper is in place.
      expect(handle).not.toHaveProperty("isRateLimited");
      expect(handle).not.toHaveProperty("inFallbackMode");

      // All StreamHandle interface methods must still be present on the wrapper
      expect(typeof handle.append).toBe("function");
      expect(typeof handle.appendTasks).toBe("function");
      expect(typeof handle.finish).toBe("function");
    });

    it("enqueue — finish() waits in the chain until a concurrent appendTasks() edit resolves", async () => {
      await connectAdapter(adapter);

      // Make edit() controllable: each call suspends until manually resolved,
      // so we can observe exactly which edit is in flight at each moment.
      const editContent: string[] = [];
      const editResolvers: Array<() => void> = [];
      mockEdit.mockImplementation(async ({ content }: { content: string }) => {
        editContent.push(content.slice(0, 40));
        await new Promise<void>((resolve) => editResolvers.push(resolve));
      });

      // Helper: macrotask yield — drains ALL currently-queued microtasks before
      // resuming.  Needed because the enqueue chain has multiple Promise.then()
      // hops (op adoption, chain-tail resolution) between one edit completing and
      // the next operation starting its own edit().
      const flushAllMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");

      // Kick off appendTasks and finish "concurrently" from the caller's perspective.
      // The enqueue chain must ensure they execute sequentially, never both editing
      // the Discord message at the same time.
      const tasks = [{ id: "t1", text: "Running tool", status: "in_progress" as const }];
      const p1 = handle.appendTasks!(tasks);
      const p2 = handle.finish("Final response");

      // Drain microtasks so appendTasks reaches its first edit() suspension point.
      await flushAllMicrotasks();

      // Only appendTasks should have called edit() — finish() is still queued.
      expect(editResolvers).toHaveLength(1);

      // Unblock appendTasks' edit, then drain so the enqueue chain can advance to finish().
      editResolvers[0]!();
      await flushAllMicrotasks();

      // finish() should now have started and its edit is suspended.
      expect(editResolvers).toHaveLength(2);
      // Verify execution order: appendTasks ran first.
      expect(editContent[0]).toContain("Running tool");

      // Unblock finish's edit and wait for both promises to settle.
      editResolvers[1]!();
      await p1;
      await p2;

      // Both edits completed in the correct serialized order.
      expect(editContent[1]).toBe("Final response");
      expect(editContent).toHaveLength(2);
    });

    it("enqueue — append() followed by finish() execute sequentially without concurrent edits", async () => {
      await connectAdapter(adapter);

      // Track which edits happen and when
      const editOrder: string[] = [];
      mockEdit.mockImplementation(async ({ content }: { content: string }) => {
        editOrder.push(content.slice(0, 20));
      });

      const handle = await adapter.startStream("GUILD-001", "THREAD-001");

      // Call append() then finish() sequentially via the enqueue chain
      await handle.append("streaming text");
      // Flush timer-based flush (if any) so we see all edits
      await Promise.resolve();
      await Promise.resolve();

      await handle.finish(" — done");

      // The last edit must contain both the appended text and the final suffix.
      const lastEdit = editOrder[editOrder.length - 1] ?? "";
      // finish() merges all accumulated content — the final edit has everything.
      expect(mockEdit.mock.calls.length).toBeGreaterThanOrEqual(1);
      const lastCallContent = (mockEdit.mock.calls[mockEdit.mock.calls.length - 1][0] as { content: string }).content;
      expect(lastCallContent).toContain("streaming text");
      expect(lastCallContent).toContain("done");
    });
  });

  // -------------------------------------------------------------------------
  // setStatus() / clearStatus()
  // -------------------------------------------------------------------------

  describe("setStatus() / clearStatus()", () => {
    it("sends a typing indicator to the thread channel (threadId)", async () => {
      await connectAdapter(adapter);

      // channelId = guildId, threadId = actual Discord channel
      await adapter.setStatus("GUILD-001", "THREAD-001", "Thinking...");

      expect(mockChannelsFetch).toHaveBeenCalledWith("THREAD-001");
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it("clearStatus() is a no-op and does not throw", async () => {
      await connectAdapter(adapter);

      await expect(adapter.clearStatus("G-001", "T-001")).resolves.toBeUndefined();
    });

    it("setStatus() swallows errors gracefully", async () => {
      await connectAdapter(adapter);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockChannelsFetch.mockRejectedValueOnce(new Error("Fetch failed"));

      // Should NOT throw
      await expect(adapter.setStatus("G-001", "T-001", "Thinking")).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        "[discord] Could not send typing indicator:",
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });
});
