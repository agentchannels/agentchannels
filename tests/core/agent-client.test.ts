import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentClient } from "../../src/core/agent-client.js";
import type { AgentStreamEvent } from "../../src/core/agent-client.js";

// Shared mock state accessible from tests
const mockBeta = {
  agents: {
    list: vi.fn(),
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  environments: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  sessions: {
    create: vi.fn(),
    events: {
      send: vi.fn(),
      stream: vi.fn(),
    },
  },
};

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    beta = mockBeta;
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic };
});

/** Helper: create an async iterable from an array of events */
function asyncIterableFrom<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) {
        yield item;
      }
    },
  };
}

describe("AgentClient", () => {
  let client: AgentClient;
  const mock = mockBeta;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AgentClient({
      apiKey: "test-api-key",
      agentId: "agent_test123",
      environmentId: "env_test456",
    });
  });

  describe("constructor", () => {
    it("throws if apiKey is empty", () => {
      expect(() => new AgentClient({ apiKey: "" })).toThrow(
        "ANTHROPIC_API_KEY is required",
      );
    });

    it("creates client with valid apiKey", () => {
      const c = new AgentClient({ apiKey: "sk-test" });
      expect(c).toBeInstanceOf(AgentClient);
    });

    it("stores agentId and environmentId", () => {
      expect(client.getAgentId()).toBe("agent_test123");
      expect(client.getEnvironmentId()).toBe("env_test456");
    });
  });

  describe("validateAuth", () => {
    it("succeeds when API call works", async () => {
      mock.agents.list.mockResolvedValue({ data: [] });
      await expect(client.validateAuth()).resolves.toBeUndefined();
      expect(mock.agents.list).toHaveBeenCalledWith({ limit: 1 });
    });

    it("throws on API failure", async () => {
      mock.agents.list.mockRejectedValue(new Error("Unauthorized"));
      await expect(client.validateAuth()).rejects.toThrow(
        "Anthropic API authentication failed: Unauthorized",
      );
    });
  });

  describe("createAgent", () => {
    it("creates an agent with default model", async () => {
      mock.agents.create.mockResolvedValue({
        id: "agent_new",
        name: "Test Agent",
        version: 1,
      });

      const result = await client.createAgent({ name: "Test Agent" });

      expect(result).toEqual({
        id: "agent_new",
        name: "Test Agent",
        version: 1,
      });
      expect(mock.agents.create).toHaveBeenCalledWith({
        name: "Test Agent",
        model: "claude-sonnet-4-6",
        description: undefined,
        system: undefined,
      });
    });

    it("creates an agent with custom model and system prompt", async () => {
      mock.agents.create.mockResolvedValue({
        id: "agent_custom",
        name: "Custom",
        version: 1,
      });

      await client.createAgent({
        name: "Custom",
        model: "claude-opus-4-6",
        description: "A custom agent",
        system: "You are helpful",
      });

      expect(mock.agents.create).toHaveBeenCalledWith({
        name: "Custom",
        model: "claude-opus-4-6",
        description: "A custom agent",
        system: "You are helpful",
      });
    });
  });

  describe("getAgent", () => {
    it("retrieves agent by configured ID", async () => {
      mock.agents.retrieve.mockResolvedValue({
        id: "agent_test123",
        name: "Existing Agent",
        version: 2,
      });

      const result = await client.getAgent();
      expect(result.id).toBe("agent_test123");
      expect(mock.agents.retrieve).toHaveBeenCalledWith("agent_test123");
    });

    it("retrieves agent by explicit ID", async () => {
      mock.agents.retrieve.mockResolvedValue({
        id: "agent_other",
        name: "Other",
        version: 1,
      });

      const result = await client.getAgent("agent_other");
      expect(result.id).toBe("agent_other");
    });

    it("throws if no agent ID provided or configured", async () => {
      const noAgentClient = new AgentClient({ apiKey: "test-key" });
      await expect(noAgentClient.getAgent()).rejects.toThrow("No agent ID provided");
    });
  });

  describe("createEnvironment", () => {
    it("creates an environment", async () => {
      mock.environments.create.mockResolvedValue({
        id: "env_new",
        name: "test-env",
      });

      const result = await client.createEnvironment({ name: "test-env" });
      expect(result).toEqual({ id: "env_new", name: "test-env" });
      expect(mock.environments.create).toHaveBeenCalledWith({
        name: "test-env",
        description: undefined,
      });
    });
  });

  describe("getEnvironment", () => {
    it("retrieves environment by configured ID", async () => {
      mock.environments.retrieve.mockResolvedValue({
        id: "env_test456",
        name: "existing-env",
      });

      const result = await client.getEnvironment();
      expect(result.id).toBe("env_test456");
    });

    it("throws if no environment ID provided or configured", async () => {
      const noEnvClient = new AgentClient({ apiKey: "test-key" });
      await expect(noEnvClient.getEnvironment()).rejects.toThrow(
        "No environment ID provided",
      );
    });
  });

  describe("createSession", () => {
    it("creates session with configured agent and environment", async () => {
      mock.sessions.create.mockResolvedValue({ id: "sesn_abc" });

      const sessionId = await client.createSession();
      expect(sessionId).toBe("sesn_abc");
      expect(mock.sessions.create).toHaveBeenCalledWith({
        agent: "agent_test123",
        environment_id: "env_test456",
        title: undefined,
        metadata: undefined,
      });
    });

    it("creates session with explicit IDs and metadata", async () => {
      mock.sessions.create.mockResolvedValue({ id: "sesn_xyz" });

      const sessionId = await client.createSession({
        agentId: "agent_override",
        environmentId: "env_override",
        title: "Support session",
        metadata: { user: "u123" },
      });

      expect(sessionId).toBe("sesn_xyz");
      expect(mock.sessions.create).toHaveBeenCalledWith({
        agent: "agent_override",
        environment_id: "env_override",
        title: "Support session",
        metadata: { user: "u123" },
      });
    });

    it("throws if no agent ID available", async () => {
      const noIdClient = new AgentClient({ apiKey: "test-key" });
      await expect(noIdClient.createSession()).rejects.toThrow(
        "No agent ID configured",
      );
    });

    it("throws if no environment ID available", async () => {
      const noEnvClient = new AgentClient({
        apiKey: "test-key",
        agentId: "agent_x",
      });
      await expect(noEnvClient.createSession()).rejects.toThrow(
        "No environment ID configured",
      );
    });
  });

  describe("sendMessage", () => {
    it("sends user message and streams agent response via full messages", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "session.status_running" },
          {
            type: "agent.message",
            content: [{ type: "text", text: "Hello! " }],
          },
          {
            type: "agent.message",
            content: [{ type: "text", text: "How can I help?" }],
          },
          {
            type: "session.status_idle",
            stop_reason: { type: "end_turn" },
          },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hello")) {
        events.push(event);
      }

      // Verify send was called correctly
      expect(mock.sessions.events.send).toHaveBeenCalledWith("sesn_test", {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      });

      // Verify events received
      // session.status_idle causes a break in the stream loop, so the final
      // "done" event is emitted by the generator's end-of-stream logic (no stopReason).
      expect(events).toEqual([
        { type: "status", status: "running" },
        { type: "text_delta", text: "Hello! " },
        { type: "text_delta", text: "How can I help?" },
        { type: "done", stopReason: "end_turn" },
      ]);
    });

    it("handles incremental content_block_delta text events (SSE streaming)", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "message_start" },
          { type: "content_block_start", content_block: { type: "text" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
          { type: "content_block_stop" },
          { type: "message_stop" },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
        { type: "done", stopReason: "end_turn" },
      ]);
    });

    it("handles content_block_delta thinking events", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Let me consider..." },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "The answer is 42." },
          },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Think")) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: "thinking", text: "Let me consider..." },
        { type: "text_delta", text: "The answer is 42." },
        { type: "done", stopReason: "end_turn" },
      ]);
    });

    it("handles content_block_start with tool_use", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          {
            type: "content_block_start",
            content_block: { type: "tool_use", name: "calculator", input: { expr: "2+2" } },
          },
          { type: "content_block_stop" },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Calculate")) {
        events.push(event);
      }

      expect(events[0]).toEqual({
        type: "tool_use",
        name: "calculator",
        input: { expr: "2+2" },
      });
    });

    it("handles tool_use events (legacy format)", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          {
            type: "agent.tool_use",
            name: "web_search",
            input: { query: "test" },
          },
          {
            type: "session.status_idle",
            stop_reason: { type: "end_turn" },
          },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Search")) {
        events.push(event);
      }

      expect(events[0]).toEqual({
        type: "tool_use",
        name: "web_search",
        input: { query: "test" },
      });
    });

    it("handles agent.thinking events with text", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "agent.thinking", text: "Reasoning about the problem..." },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events[0]).toEqual({ type: "thinking", text: "Reasoning about the problem..." });
    });

    it("handles session errors", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          {
            type: "session.error",
            error: { message: "Rate limited" },
          },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "error", error: "Rate limited" }]);
    });

    it("handles session termination", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([{ type: "session.status_terminated" }]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "done", stopReason: "terminated" }]);
    });

    it("handles session.deleted events", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([{ type: "session.deleted" }]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "done", stopReason: "deleted" }]);
    });

    it("handles thrown exceptions", async () => {
      mock.sessions.events.send.mockRejectedValue(
        new Error("Network error"),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "error", error: "Network error" }]);
    });

    it("ignores unknown event types", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "telemetry.ping", data: {} },
          { type: "agent.message", content: [{ type: "text", text: "Hi" }] },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      // Unknown event should be silently ignored
      expect(events).toEqual([
        { type: "text_delta", text: "Hi" },
        { type: "done", stopReason: "end_turn" },
      ]);
    });

    it("ignores events without type field", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { data: "no type" },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi")) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "done", stopReason: "end_turn" }]);
    });
  });

  describe("sendMessage with emitRawEvents", () => {
    it("emits raw events alongside parsed events when enabled", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hello", { emitRawEvents: true })) {
        events.push(event);
      }

      // Raw + parsed for both events
      expect(events).toEqual([
        {
          type: "raw",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        },
        { type: "text_delta", text: "Hi" },
        {
          type: "raw",
          event: { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        },
        { type: "done", stopReason: "end_turn" },
      ]);
    });

    it("does not emit raw events by default", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hello")) {
        events.push(event);
      }

      const rawEvents = events.filter((e) => e.type === "raw");
      expect(rawEvents).toHaveLength(0);
    });
  });

  describe("sendMessage with AbortSignal", () => {
    it("yields error when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi", { signal: controller.signal })) {
        events.push(event);
      }

      expect(events).toEqual([{ type: "error", error: "Stream aborted before starting" }]);
      // Should not have called send or stream
      expect(mock.sessions.events.send).not.toHaveBeenCalled();
    });

    it("yields abort error when signal fires mid-stream", async () => {
      const controller = new AbortController();

      mock.sessions.events.send.mockResolvedValue({});

      // Create a stream that yields one event, then we abort, then yields more
      let yieldCount = 0;
      mock.sessions.events.stream.mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "First" } };
          yieldCount++;
          // Abort after first event
          controller.abort();
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "Second" } };
          yieldCount++;
        },
      });

      const events: AgentStreamEvent[] = [];
      for await (const event of client.sendMessage("sesn_test", "Hi", { signal: controller.signal })) {
        events.push(event);
      }

      // Should get first text delta, then abort error (no second delta)
      expect(events).toEqual([
        { type: "text_delta", text: "First" },
        { type: "error", error: "Stream aborted" },
      ]);
    });
  });

  describe("sendMessageAndCollect", () => {
    it("collects full text response from incremental deltas", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          { type: "content_block_delta", delta: { type: "text_delta", text: "Part 1. " } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Part 2." } },
          { type: "session.status_idle", stop_reason: { type: "end_turn" } },
        ]),
      );

      const result = await client.sendMessageAndCollect("sesn_test", "Hello");
      expect(result).toBe("Part 1. Part 2.");
    });

    it("collects full text response from full messages", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          {
            type: "agent.message",
            content: [{ type: "text", text: "Part 1. " }],
          },
          {
            type: "agent.message",
            content: [{ type: "text", text: "Part 2." }],
          },
          {
            type: "session.status_idle",
            stop_reason: { type: "end_turn" },
          },
        ]),
      );

      const result = await client.sendMessageAndCollect("sesn_test", "Hello");
      expect(result).toBe("Part 1. Part 2.");
    });

    it("throws on error events", async () => {
      mock.sessions.events.send.mockResolvedValue({});
      mock.sessions.events.stream.mockResolvedValue(
        asyncIterableFrom([
          {
            type: "session.error",
            error: { message: "Something went wrong" },
          },
        ]),
      );

      await expect(
        client.sendMessageAndCollect("sesn_test", "Hello"),
      ).rejects.toThrow("Something went wrong");
    });
  });

  describe("getRawClient", () => {
    it("returns the underlying Anthropic client", () => {
      const raw = client.getRawClient();
      expect(raw).toBeDefined();
      expect(raw.beta).toBeDefined();
    });
  });
});
