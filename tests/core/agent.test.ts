import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isValidAgentIdFormat,
  assertValidAgentIdFormat,
  validateAgent,
  createAgent,
  resolveAgent,
  listAgents,
  defaultAgentName,
  defaultAgentDescription,
} from "../../src/core/agent.js";
import { AgentClient } from "../../src/core/agent-client.js";

// Shared mock state
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

describe("agent utilities", () => {
  let client: AgentClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AgentClient({ apiKey: "test-api-key" });
  });

  describe("isValidAgentIdFormat", () => {
    it("returns true for valid agent IDs", () => {
      expect(isValidAgentIdFormat("agent_abc123")).toBe(true);
      expect(isValidAgentIdFormat("agent-123")).toBe(true);
      expect(isValidAgentIdFormat("a")).toBe(true);
    });

    it("returns false for empty string", () => {
      expect(isValidAgentIdFormat("")).toBe(false);
    });

    it("returns false for whitespace-only string", () => {
      expect(isValidAgentIdFormat("   ")).toBe(false);
    });

    it("returns false for string with leading/trailing whitespace", () => {
      expect(isValidAgentIdFormat(" agent_123")).toBe(false);
      expect(isValidAgentIdFormat("agent_123 ")).toBe(false);
    });

    it("returns false for string with internal whitespace", () => {
      expect(isValidAgentIdFormat("agent 123")).toBe(false);
    });

    it("returns false for string with control characters", () => {
      expect(isValidAgentIdFormat("agent\t123")).toBe(false);
      expect(isValidAgentIdFormat("agent\n123")).toBe(false);
    });

    it("returns false for non-string values", () => {
      expect(isValidAgentIdFormat(null as any)).toBe(false);
      expect(isValidAgentIdFormat(undefined as any)).toBe(false);
    });
  });

  describe("assertValidAgentIdFormat", () => {
    it("does not throw for valid IDs", () => {
      expect(() => assertValidAgentIdFormat("agent_abc123")).not.toThrow();
    });

    it("throws for invalid IDs with descriptive message", () => {
      expect(() => assertValidAgentIdFormat("")).toThrow("Invalid agent ID format");
      expect(() => assertValidAgentIdFormat("agent 123")).toThrow(
        "Agent IDs must be non-empty strings without whitespace",
      );
    });
  });

  describe("validateAgent", () => {
    it("returns agent info when agent exists", async () => {
      mockBeta.agents.retrieve.mockResolvedValue({
        id: "agent_123",
        name: "Test Agent",
        version: 2,
      });

      const result = await validateAgent(client, "agent_123");
      expect(result).toEqual({ id: "agent_123", name: "Test Agent", version: 2 });
      expect(mockBeta.agents.retrieve).toHaveBeenCalledWith("agent_123");
    });

    it("throws when agent not found", async () => {
      mockBeta.agents.retrieve.mockRejectedValue(new Error("Not found"));

      await expect(validateAgent(client, "agent_bad")).rejects.toThrow(
        'Agent "agent_bad" not found or inaccessible: Not found',
      );
    });

    it("throws for invalid ID format without API call", async () => {
      await expect(validateAgent(client, "")).rejects.toThrow("Invalid agent ID format");
      expect(mockBeta.agents.retrieve).not.toHaveBeenCalled();
    });

    it("throws for ID with whitespace without API call", async () => {
      await expect(validateAgent(client, "agent 123")).rejects.toThrow(
        "Invalid agent ID format",
      );
      expect(mockBeta.agents.retrieve).not.toHaveBeenCalled();
    });
  });

  describe("createAgent", () => {
    it("creates agent with all params", async () => {
      mockBeta.agents.create.mockResolvedValue({
        id: "agent_new",
        name: "my-bot",
        version: 1,
      });

      const result = await createAgent(client, {
        name: "my-bot",
        model: "claude-sonnet-4-6",
        description: "A test bot",
        system: "Be helpful",
      });

      expect(result).toEqual({ id: "agent_new", name: "my-bot", version: 1 });
      expect(mockBeta.agents.create).toHaveBeenCalledWith({
        name: "my-bot",
        model: "claude-sonnet-4-6",
        description: "A test bot",
        system: "Be helpful",
      });
    });

    it("trims agent name", async () => {
      mockBeta.agents.create.mockResolvedValue({
        id: "agent_new",
        name: "my-bot",
        version: 1,
      });

      await createAgent(client, { name: "  my-bot  " });
      expect(mockBeta.agents.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "my-bot" }),
      );
    });

    it("throws if name is empty", async () => {
      await expect(createAgent(client, { name: "" })).rejects.toThrow(
        "Agent name is required and cannot be empty",
      );
      expect(mockBeta.agents.create).not.toHaveBeenCalled();
    });

    it("throws if name is whitespace-only", async () => {
      await expect(createAgent(client, { name: "   " })).rejects.toThrow(
        "Agent name is required and cannot be empty",
      );
    });

    it("propagates API errors", async () => {
      mockBeta.agents.create.mockRejectedValue(new Error("Rate limit exceeded"));

      await expect(
        createAgent(client, { name: "my-bot" }),
      ).rejects.toThrow("Rate limit exceeded");
    });
  });

  describe("resolveAgent", () => {
    it("creates a new agent when mode is 'create'", async () => {
      mockBeta.agents.create.mockResolvedValue({
        id: "agent_created",
        name: "new-bot",
        version: 1,
      });

      const result = await resolveAgent(client, {
        mode: "create",
        name: "new-bot",
        model: "claude-sonnet-4-6",
        description: "A new bot",
        system: "Be concise",
      });

      expect(result).toEqual({
        id: "agent_created",
        name: "new-bot",
        version: 1,
        created: true,
      });
      expect(mockBeta.agents.create).toHaveBeenCalledWith({
        name: "new-bot",
        model: "claude-sonnet-4-6",
        description: "A new bot",
        system: "Be concise",
      });
    });

    it("validates an existing agent when mode is 'existing'", async () => {
      mockBeta.agents.retrieve.mockResolvedValue({
        id: "agent_existing",
        name: "Existing Bot",
        version: 3,
      });

      const result = await resolveAgent(client, {
        mode: "existing",
        agentId: "agent_existing",
      });

      expect(result).toEqual({
        id: "agent_existing",
        name: "Existing Bot",
        version: 3,
        created: false,
      });
      expect(mockBeta.agents.retrieve).toHaveBeenCalledWith("agent_existing");
    });

    it("sets created=true for new agents", async () => {
      mockBeta.agents.create.mockResolvedValue({
        id: "agent_x",
        name: "x",
        version: 1,
      });

      const result = await resolveAgent(client, { mode: "create", name: "x" });
      expect(result.created).toBe(true);
    });

    it("sets created=false for existing agents", async () => {
      mockBeta.agents.retrieve.mockResolvedValue({
        id: "agent_x",
        name: "x",
        version: 1,
      });

      const result = await resolveAgent(client, {
        mode: "existing",
        agentId: "agent_x",
      });
      expect(result.created).toBe(false);
    });

    it("propagates create errors", async () => {
      mockBeta.agents.create.mockRejectedValue(new Error("Quota exceeded"));

      await expect(
        resolveAgent(client, { mode: "create", name: "bot" }),
      ).rejects.toThrow("Quota exceeded");
    });

    it("propagates validation errors for nonexistent agents", async () => {
      mockBeta.agents.retrieve.mockRejectedValue(new Error("404"));

      await expect(
        resolveAgent(client, { mode: "existing", agentId: "agent_gone" }),
      ).rejects.toThrow("not found or inaccessible");
    });

    it("rejects invalid agent ID format in existing mode", async () => {
      await expect(
        resolveAgent(client, { mode: "existing", agentId: "" }),
      ).rejects.toThrow("Invalid agent ID format");
      expect(mockBeta.agents.retrieve).not.toHaveBeenCalled();
    });
  });

  describe("listAgents", () => {
    it("returns list of agents", async () => {
      mockBeta.agents.list.mockResolvedValue({
        data: [
          { id: "agent_1", name: "Bot 1", version: 1 },
          { id: "agent_2", name: "Bot 2", version: 2 },
        ],
      });

      const result = await listAgents(client);
      expect(result).toEqual([
        { id: "agent_1", name: "Bot 1", version: 1 },
        { id: "agent_2", name: "Bot 2", version: 2 },
      ]);
      expect(mockBeta.agents.list).toHaveBeenCalledWith({ limit: 20 });
    });

    it("uses custom limit", async () => {
      mockBeta.agents.list.mockResolvedValue({ data: [] });

      await listAgents(client, { limit: 5 });
      expect(mockBeta.agents.list).toHaveBeenCalledWith({ limit: 5 });
    });

    it("returns empty array when no agents exist", async () => {
      mockBeta.agents.list.mockResolvedValue({ data: [] });

      const result = await listAgents(client);
      expect(result).toEqual([]);
    });

    it("handles non-array response gracefully", async () => {
      mockBeta.agents.list.mockResolvedValue({});

      const result = await listAgents(client);
      expect(result).toEqual([]);
    });

    it("defaults version to 1 when missing", async () => {
      mockBeta.agents.list.mockResolvedValue({
        data: [{ id: "agent_1", name: "Bot 1" }],
      });

      const result = await listAgents(client);
      expect(result[0].version).toBe(1);
    });

    it("propagates API errors", async () => {
      mockBeta.agents.list.mockRejectedValue(new Error("Network error"));

      await expect(listAgents(client)).rejects.toThrow(
        "Failed to list agents: Network error",
      );
    });
  });

  describe("defaultAgentName", () => {
    it("returns the default agent name", () => {
      expect(defaultAgentName()).toBe("agentchannels-bot");
    });
  });

  describe("defaultAgentDescription", () => {
    it("returns the default agent description", () => {
      expect(defaultAgentDescription()).toBe(
        "AgentChannels Slack bot powered by Claude",
      );
    });
  });
});
