import { describe, it, expect, vi } from "vitest";
import type {
  ChannelAdapter,
  ChannelMessage,
  MessageHandler,
  StreamHandle,
  AdapterStatus,
  BaseAdapterConfig,
  ChannelAdapterFactory,
} from "../../src/core/channel-adapter.js";

/**
 * Tests for the channel adapter interface contract.
 *
 * These tests verify the type system and contract semantics —
 * they don't test a specific implementation but ensure that any
 * implementation conforming to the interface behaves correctly.
 */

/** Minimal mock adapter that satisfies the ChannelAdapter interface */
function createMockAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  const handlers: MessageHandler[] = [];

  return {
    name: "mock",
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
    sendMessage: vi.fn(async () => {}),
    startStream: vi.fn(async (): Promise<StreamHandle> => ({
      append: vi.fn(async () => {}),
      finish: vi.fn(async () => {}),
    })),
    ...overrides,
  };
}

describe("ChannelAdapter interface contract", () => {
  describe("name property", () => {
    it("exposes a readonly name string", () => {
      const adapter = createMockAdapter({ name: "test-channel" });
      expect(adapter.name).toBe("test-channel");
      expect(typeof adapter.name).toBe("string");
    });
  });

  describe("connect()", () => {
    it("returns a Promise<void>", async () => {
      const adapter = createMockAdapter();
      const result = adapter.connect();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it("can be called once to establish connection", async () => {
      const adapter = createMockAdapter();
      await adapter.connect();
      expect(adapter.connect).toHaveBeenCalledOnce();
    });
  });

  describe("disconnect()", () => {
    it("returns a Promise<void>", async () => {
      const adapter = createMockAdapter();
      const result = adapter.disconnect();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it("can be called after connect", async () => {
      const adapter = createMockAdapter();
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe("onMessage()", () => {
    it("accepts a MessageHandler callback", () => {
      const adapter = createMockAdapter();
      const handler: MessageHandler = async () => {};
      adapter.onMessage(handler);
      expect(adapter.onMessage).toHaveBeenCalledWith(handler);
    });

    it("allows registering multiple handlers", () => {
      const handlers: MessageHandler[] = [];
      const adapter = createMockAdapter({
        onMessage: vi.fn((handler: MessageHandler) => {
          handlers.push(handler);
        }),
      });

      const h1: MessageHandler = async () => {};
      const h2: MessageHandler = async () => {};
      adapter.onMessage(h1);
      adapter.onMessage(h2);

      expect(handlers).toHaveLength(2);
      expect(handlers[0]).toBe(h1);
      expect(handlers[1]).toBe(h2);
    });
  });

  describe("sendMessage()", () => {
    it("accepts channelId, threadId, and text", async () => {
      const adapter = createMockAdapter();
      await adapter.sendMessage("C123", "T456", "Hello, world!");
      expect(adapter.sendMessage).toHaveBeenCalledWith("C123", "T456", "Hello, world!");
    });

    it("returns a Promise<void>", async () => {
      const adapter = createMockAdapter();
      const result = adapter.sendMessage("C123", "T456", "text");
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe("startStream()", () => {
    it("returns a StreamHandle with append() and finish()", async () => {
      const adapter = createMockAdapter();
      const handle = await adapter.startStream("C123", "T456");

      expect(handle).toBeDefined();
      expect(typeof handle.append).toBe("function");
      expect(typeof handle.finish).toBe("function");
    });

    it("StreamHandle.append() accepts text deltas", async () => {
      const mockAppend = vi.fn(async () => {});
      const adapter = createMockAdapter({
        startStream: vi.fn(async () => ({
          append: mockAppend,
          finish: vi.fn(async () => {}),
        })),
      });

      const handle = await adapter.startStream("C123", "T456");
      await handle.append("Partial ");
      await handle.append("response...");

      expect(mockAppend).toHaveBeenCalledTimes(2);
      expect(mockAppend).toHaveBeenCalledWith("Partial ");
      expect(mockAppend).toHaveBeenCalledWith("response...");
    });

    it("StreamHandle.finish() finalizes with an optional final delta", async () => {
      const mockFinish = vi.fn(async () => {});
      const adapter = createMockAdapter({
        startStream: vi.fn(async () => ({
          append: vi.fn(async () => {}),
          finish: mockFinish,
        })),
      });

      const handle = await adapter.startStream("C123", "T456");
      await handle.finish("final delta.");

      expect(mockFinish).toHaveBeenCalledWith("final delta.");
    });

    it("StreamHandle.finish() can be called without arguments", async () => {
      const mockFinish = vi.fn(async () => {});
      const adapter = createMockAdapter({
        startStream: vi.fn(async () => ({
          append: vi.fn(async () => {}),
          finish: mockFinish,
        })),
      });

      const handle = await adapter.startStream("C123", "T456");
      await handle.finish();

      expect(mockFinish).toHaveBeenCalledTimes(1);
    });
  });

});

describe("ChannelMessage type", () => {
  it("has all required fields", () => {
    const message: ChannelMessage = {
      id: "msg-1",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      text: "Hello",
      isMention: true,
      isDirectMessage: false,
    };

    expect(message.id).toBe("msg-1");
    expect(message.channelId).toBe("C123");
    expect(message.threadId).toBe("T456");
    expect(message.userId).toBe("U789");
    expect(message.text).toBe("Hello");
    expect(message.isMention).toBe(true);
    expect(message.isDirectMessage).toBe(false);
  });

  it("supports optional raw field", () => {
    const message: ChannelMessage = {
      id: "msg-1",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      text: "Hello",
      isMention: false,
      isDirectMessage: true,
      raw: { platform: "slack", extra: "data" },
    };

    expect(message.raw).toEqual({ platform: "slack", extra: "data" });
  });

  it("raw field defaults to undefined", () => {
    const message: ChannelMessage = {
      id: "msg-1",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      text: "Hello",
      isMention: false,
      isDirectMessage: false,
    };

    expect(message.raw).toBeUndefined();
  });
});

describe("AdapterStatus type", () => {
  it("supports all expected states", () => {
    const states: AdapterStatus[] = ["disconnected", "connecting", "connected", "error"];
    expect(states).toHaveLength(4);
    expect(states).toContain("disconnected");
    expect(states).toContain("connecting");
    expect(states).toContain("connected");
    expect(states).toContain("error");
  });
});

describe("ChannelAdapterFactory type", () => {
  it("creates an adapter from config", () => {
    const factory: ChannelAdapterFactory = (config) => {
      return createMockAdapter({ name: (config as any).name ?? "from-factory" });
    };

    const adapter = factory({ name: "test" });
    expect(adapter.name).toBe("test");
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendMessage).toBe("function");
    expect(typeof adapter.startStream).toBe("function");
  });
});

describe("ChannelMessage edge cases", () => {
  it("allows empty string for text", () => {
    const message: ChannelMessage = {
      id: "msg-1",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      text: "",
      isMention: false,
      isDirectMessage: false,
    };
    expect(message.text).toBe("");
  });

  it("preserves special characters in text", () => {
    const message: ChannelMessage = {
      id: "msg-1",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      text: "Hello <world> & \"quotes\" 'single' `code`",
      isMention: false,
      isDirectMessage: false,
    };
    expect(message.text).toBe("Hello <world> & \"quotes\" 'single' `code`");
  });

  it("can have both isMention and isDirectMessage true", () => {
    const message: ChannelMessage = {
      id: "msg-1",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      text: "test",
      isMention: true,
      isDirectMessage: true,
    };
    expect(message.isMention).toBe(true);
    expect(message.isDirectMessage).toBe(true);
  });

  it("threadId and id can be the same (thread root)", () => {
    const ts = "1234567890.123456";
    const message: ChannelMessage = {
      id: ts,
      channelId: "C123",
      threadId: ts,
      userId: "U789",
      text: "root message",
      isMention: false,
      isDirectMessage: false,
    };
    expect(message.id).toBe(message.threadId);
  });
});

describe("ChannelAdapter contract compliance (mock adapter)", () => {
  it("mock adapter satisfies all required interface methods", () => {
    const adapter = createMockAdapter();
    const requiredMethods: (keyof ChannelAdapter)[] = [
      "connect",
      "disconnect",
      "onMessage",
      "sendMessage",
      "startStream",
    ];
    for (const method of requiredMethods) {
      expect(adapter[method]).toBeDefined();
      expect(typeof adapter[method]).toBe("function");
    }
    expect(typeof adapter.name).toBe("string");
    expect(adapter.name.length).toBeGreaterThan(0);
  });

  it("handlers registered before connect are preserved", async () => {
    const messages: ChannelMessage[] = [];
    const handlers: MessageHandler[] = [];
    const adapter = createMockAdapter({
      onMessage: vi.fn((handler: MessageHandler) => {
        handlers.push(handler);
      }),
    });

    // Register before connect
    adapter.onMessage(async (msg) => messages.push(msg));
    expect(handlers).toHaveLength(1);

    await adapter.connect();

    // Handler should still be registered
    expect(handlers).toHaveLength(1);
  });

  it("disconnect can be called multiple times safely", async () => {
    const adapter = createMockAdapter();
    await adapter.connect();
    await adapter.disconnect();
    await adapter.disconnect(); // second call should not throw
    expect(adapter.disconnect).toHaveBeenCalledTimes(2);
  });
});

describe("StreamHandle streaming lifecycle", () => {
  it("supports the typical append-then-finish flow", async () => {
    const calls: string[] = [];

    const handle: StreamHandle = {
      append: async (delta: string) => {
        calls.push(`append:${delta}`);
      },
      finish: async (finalDelta?: string) => {
        calls.push(`finish:${finalDelta ?? ""}`);
      },
    };

    // Simulate streaming: several appends with deltas, then finish with remaining
    await handle.append("Hello");
    await handle.append(", world");
    await handle.append("! How are");
    await handle.finish(" you?");

    expect(calls).toEqual([
      "append:Hello",
      "append:, world",
      "append:! How are",
      "finish: you?",
    ]);
  });

  it("supports immediate finish with full text (non-streaming fallback)", async () => {
    const calls: string[] = [];

    const handle: StreamHandle = {
      append: async (delta: string) => {
        calls.push(`append:${delta}`);
      },
      finish: async (finalDelta?: string) => {
        calls.push(`finish:${finalDelta ?? ""}`);
      },
    };

    await handle.finish("Complete response in one shot.");

    expect(calls).toEqual(["finish:Complete response in one shot."]);
  });

  it("supports finish without arguments when all text was already appended", async () => {
    const calls: string[] = [];

    const handle: StreamHandle = {
      append: async (delta: string) => {
        calls.push(`append:${delta}`);
      },
      finish: async (finalDelta?: string) => {
        calls.push(`finish:${finalDelta ?? ""}`);
      },
    };

    await handle.append("All text sent.");
    await handle.finish();

    expect(calls).toEqual([
      "append:All text sent.",
      "finish:",
    ]);
  });
});
