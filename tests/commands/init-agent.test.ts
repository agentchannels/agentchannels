import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateAgentId,
  validateEnvironmentId,
  initAgentCore,
} from "../../src/commands/init-agent.js";
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

describe("init-agent utilities", () => {
  let client: AgentClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AgentClient({ apiKey: "test-api-key" });
  });

  describe("validateAgentId", () => {
    it("returns agent info when agent exists", async () => {
      mockBeta.agents.retrieve.mockResolvedValue({
        id: "agent_123",
        name: "Test Agent",
        version: 1,
      });

      const result = await validateAgentId(client, "agent_123");
      expect(result.id).toBe("agent_123");
      expect(result.name).toBe("Test Agent");
      expect(mockBeta.agents.retrieve).toHaveBeenCalledWith("agent_123");
    });

    it("throws descriptive error when agent not found", async () => {
      mockBeta.agents.retrieve.mockRejectedValue(new Error("Not found"));

      await expect(validateAgentId(client, "agent_bad")).rejects.toThrow(
        'Agent "agent_bad" not found or inaccessible: Not found',
      );
    });
  });

  describe("validateEnvironmentId", () => {
    it("returns environment info when environment exists", async () => {
      mockBeta.environments.retrieve.mockResolvedValue({
        id: "env_456",
        name: "Test Env",
      });

      const result = await validateEnvironmentId(client, "env_456");
      expect(result).toEqual({ id: "env_456", name: "Test Env" });
      expect(mockBeta.environments.retrieve).toHaveBeenCalledWith("env_456");
    });

    it("throws descriptive error when environment not found", async () => {
      mockBeta.environments.retrieve.mockRejectedValue(new Error("Not found"));

      await expect(
        validateEnvironmentId(client, "env_bad"),
      ).rejects.toThrow(
        'Environment "env_bad" not found or inaccessible: Not found',
      );
    });
  });

  describe("initAgentCore", () => {
    describe("create mode", () => {
      it("creates a new agent and new environment", async () => {
        mockBeta.agents.create.mockResolvedValue({
          id: "agent_new",
          name: "my-bot",
          version: 1,
        });
        mockBeta.environments.create.mockResolvedValue({
          id: "env_new",
          name: "my-bot-env",
        });

        const result = await initAgentCore(client, {
          mode: "create",
          agentName: "my-bot",
          agentDescription: "A test bot",
          agentModel: "claude-sonnet-4-6",
          agentSystemPrompt: "Be helpful",
          envMode: "create",
          environmentName: "my-bot-env",
          environmentDescription: "Test environment",
        });

        expect(result).toEqual({
          agentId: "agent_new",
          agentName: "my-bot",
          environmentId: "env_new",
          environmentName: "my-bot-env",
          created: { agent: true, environment: true },
        });

        expect(mockBeta.agents.create).toHaveBeenCalledWith({
          name: "my-bot",
          model: "claude-sonnet-4-6",
          description: "A test bot",
          system: "Be helpful",
        });
        expect(mockBeta.environments.create).toHaveBeenCalledWith({
          name: "my-bot-env",
          description: "Test environment",
        });
      });

      it("creates agent with default env name derived from agent name", async () => {
        mockBeta.agents.create.mockResolvedValue({
          id: "agent_new",
          name: "slack-bot",
          version: 1,
        });
        mockBeta.environments.create.mockResolvedValue({
          id: "env_new",
          name: "slack-bot-env",
        });

        const result = await initAgentCore(client, {
          mode: "create",
          agentName: "slack-bot",
          envMode: "create",
        });

        // Environment name defaults to "{agentName}-env"
        expect(mockBeta.environments.create).toHaveBeenCalledWith({
          name: "slack-bot-env",
          description: undefined,
        });
        expect(result.created).toEqual({ agent: true, environment: true });
      });

      it("throws if agent name missing in create mode", async () => {
        await expect(
          initAgentCore(client, { mode: "create" }),
        ).rejects.toThrow("Agent name is required when creating a new agent");
      });
    });

    describe("existing mode", () => {
      it("validates existing agent and existing environment", async () => {
        mockBeta.agents.retrieve.mockResolvedValue({
          id: "agent_existing",
          name: "Existing Bot",
          version: 3,
        });
        mockBeta.environments.retrieve.mockResolvedValue({
          id: "env_existing",
          name: "Existing Env",
        });

        const result = await initAgentCore(client, {
          mode: "existing",
          agentId: "agent_existing",
          envMode: "existing",
          environmentId: "env_existing",
        });

        expect(result).toEqual({
          agentId: "agent_existing",
          agentName: "Existing Bot",
          environmentId: "env_existing",
          environmentName: "Existing Env",
          created: { agent: false, environment: false },
        });
      });

      it("validates existing agent and creates new environment", async () => {
        mockBeta.agents.retrieve.mockResolvedValue({
          id: "agent_existing",
          name: "Existing Bot",
          version: 2,
        });
        mockBeta.environments.create.mockResolvedValue({
          id: "env_new",
          name: "new-env",
        });

        const result = await initAgentCore(client, {
          mode: "existing",
          agentId: "agent_existing",
          envMode: "create",
          environmentName: "new-env",
        });

        expect(result.created).toEqual({ agent: false, environment: true });
        expect(result.agentId).toBe("agent_existing");
        expect(result.environmentId).toBe("env_new");
      });

      it("throws if agent ID missing in existing mode", async () => {
        await expect(
          initAgentCore(client, { mode: "existing" }),
        ).rejects.toThrow("Agent ID is required when using existing agent");
      });

      it("throws if environment ID missing when envMode is existing", async () => {
        mockBeta.agents.retrieve.mockResolvedValue({
          id: "agent_existing",
          name: "Bot",
          version: 1,
        });

        await expect(
          initAgentCore(client, {
            mode: "existing",
            agentId: "agent_existing",
            envMode: "existing",
          }),
        ).rejects.toThrow(
          "Environment ID is required when using existing environment",
        );
      });
    });

    describe("mixed modes", () => {
      it("creates agent but uses existing environment", async () => {
        mockBeta.agents.create.mockResolvedValue({
          id: "agent_new",
          name: "New Bot",
          version: 1,
        });
        mockBeta.environments.retrieve.mockResolvedValue({
          id: "env_existing",
          name: "Shared Env",
        });

        const result = await initAgentCore(client, {
          mode: "create",
          agentName: "New Bot",
          envMode: "existing",
          environmentId: "env_existing",
        });

        expect(result.created).toEqual({ agent: true, environment: false });
        expect(result.agentId).toBe("agent_new");
        expect(result.environmentId).toBe("env_existing");
      });

      it("infers envMode from environmentId presence", async () => {
        mockBeta.agents.retrieve.mockResolvedValue({
          id: "agent_x",
          name: "X",
          version: 1,
        });
        mockBeta.environments.retrieve.mockResolvedValue({
          id: "env_x",
          name: "X Env",
        });

        // No explicit envMode, but environmentId is provided → should use existing
        const result = await initAgentCore(client, {
          mode: "existing",
          agentId: "agent_x",
          environmentId: "env_x",
        });

        expect(result.created.environment).toBe(false);
        expect(mockBeta.environments.retrieve).toHaveBeenCalledWith("env_x");
      });

      it("infers envMode as create when no environmentId", async () => {
        mockBeta.agents.retrieve.mockResolvedValue({
          id: "agent_x",
          name: "X",
          version: 1,
        });
        mockBeta.environments.create.mockResolvedValue({
          id: "env_auto",
          name: "X-env",
        });

        // No envMode, no environmentId → should create
        const result = await initAgentCore(client, {
          mode: "existing",
          agentId: "agent_x",
        });

        expect(result.created.environment).toBe(true);
      });
    });

    describe("API error propagation", () => {
      it("propagates agent creation errors", async () => {
        mockBeta.agents.create.mockRejectedValue(
          new Error("Rate limit exceeded"),
        );

        await expect(
          initAgentCore(client, { mode: "create", agentName: "bot" }),
        ).rejects.toThrow("Rate limit exceeded");
      });

      it("propagates environment creation errors", async () => {
        mockBeta.agents.create.mockResolvedValue({
          id: "agent_ok",
          name: "bot",
          version: 1,
        });
        mockBeta.environments.create.mockRejectedValue(
          new Error("Quota exceeded"),
        );

        await expect(
          initAgentCore(client, {
            mode: "create",
            agentName: "bot",
            envMode: "create",
          }),
        ).rejects.toThrow("Quota exceeded");
      });

      it("propagates agent validation errors", async () => {
        mockBeta.agents.retrieve.mockRejectedValue(new Error("404 Not Found"));

        await expect(
          initAgentCore(client, {
            mode: "existing",
            agentId: "agent_gone",
            envMode: "create",
          }),
        ).rejects.toThrow("not found or inaccessible");
      });
    });
  });
});
