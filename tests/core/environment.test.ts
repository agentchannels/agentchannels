import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isValidEnvironmentIdFormat,
  assertValidEnvironmentIdFormat,
  validateEnvironment,
  createEnvironment,
  listEnvironments,
  resolveEnvironment,
  defaultEnvironmentName,
} from "../../src/core/environment.js";
import { AgentClient } from "../../src/core/agent-client.js";

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
    list: vi.fn(),
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

describe("Environment utilities", () => {
  let client: AgentClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AgentClient({ apiKey: "test-api-key" });
  });

  describe("isValidEnvironmentIdFormat", () => {
    it("accepts valid environment IDs", () => {
      expect(isValidEnvironmentIdFormat("env_abc123")).toBe(true);
      expect(isValidEnvironmentIdFormat("my-environment-id")).toBe(true);
      expect(isValidEnvironmentIdFormat("env_12345678-abcd-efgh")).toBe(true);
      expect(isValidEnvironmentIdFormat("a")).toBe(true);
    });

    it("rejects empty strings", () => {
      expect(isValidEnvironmentIdFormat("")).toBe(false);
    });

    it("rejects strings with only whitespace", () => {
      expect(isValidEnvironmentIdFormat("   ")).toBe(false);
    });

    it("rejects strings with leading/trailing whitespace", () => {
      expect(isValidEnvironmentIdFormat(" env_123")).toBe(false);
      expect(isValidEnvironmentIdFormat("env_123 ")).toBe(false);
    });

    it("rejects strings with internal whitespace", () => {
      expect(isValidEnvironmentIdFormat("env 123")).toBe(false);
      expect(isValidEnvironmentIdFormat("env\t123")).toBe(false);
      expect(isValidEnvironmentIdFormat("env\n123")).toBe(false);
    });

    it("rejects non-string values", () => {
      expect(isValidEnvironmentIdFormat(null as any)).toBe(false);
      expect(isValidEnvironmentIdFormat(undefined as any)).toBe(false);
      expect(isValidEnvironmentIdFormat(123 as any)).toBe(false);
    });

    it("rejects strings with control characters", () => {
      expect(isValidEnvironmentIdFormat("env\x00123")).toBe(false);
      expect(isValidEnvironmentIdFormat("env\x1f123")).toBe(false);
    });
  });

  describe("assertValidEnvironmentIdFormat", () => {
    it("does not throw for valid IDs", () => {
      expect(() => assertValidEnvironmentIdFormat("env_abc123")).not.toThrow();
    });

    it("throws descriptive error for invalid IDs", () => {
      expect(() => assertValidEnvironmentIdFormat("")).toThrow(
        'Invalid environment ID format: ""',
      );
      expect(() => assertValidEnvironmentIdFormat("env 123")).toThrow(
        "without whitespace",
      );
    });
  });

  describe("validateEnvironment", () => {
    it("returns environment info when environment exists", async () => {
      mockBeta.environments.retrieve.mockResolvedValue({
        id: "env_456",
        name: "Production Env",
      });

      const result = await validateEnvironment(client, "env_456");
      expect(result).toEqual({ id: "env_456", name: "Production Env" });
    });

    it("throws on invalid ID format before API call", async () => {
      await expect(validateEnvironment(client, "")).rejects.toThrow(
        "Invalid environment ID format",
      );
      // Should not have called the API
      expect(mockBeta.environments.retrieve).not.toHaveBeenCalled();
    });

    it("throws descriptive error when environment not found", async () => {
      mockBeta.environments.retrieve.mockRejectedValue(
        new Error("404 Not Found"),
      );

      await expect(
        validateEnvironment(client, "env_gone"),
      ).rejects.toThrow(
        'Environment "env_gone" not found or inaccessible: 404 Not Found',
      );
    });

    it("throws descriptive error on network failure", async () => {
      mockBeta.environments.retrieve.mockRejectedValue(
        new Error("Network timeout"),
      );

      await expect(
        validateEnvironment(client, "env_valid"),
      ).rejects.toThrow("not found or inaccessible: Network timeout");
    });
  });

  describe("createEnvironment", () => {
    it("creates an environment with name and description", async () => {
      mockBeta.environments.create.mockResolvedValue({
        id: "env_new",
        name: "my-env",
      });

      const result = await createEnvironment(client, {
        name: "my-env",
        description: "A test environment",
      });

      expect(result).toEqual({ id: "env_new", name: "my-env" });
      expect(mockBeta.environments.create).toHaveBeenCalledWith({
        name: "my-env",
        description: "A test environment",
      });
    });

    it("creates an environment with name only", async () => {
      mockBeta.environments.create.mockResolvedValue({
        id: "env_minimal",
        name: "minimal",
      });

      const result = await createEnvironment(client, { name: "minimal" });
      expect(result).toEqual({ id: "env_minimal", name: "minimal" });
      expect(mockBeta.environments.create).toHaveBeenCalledWith({
        name: "minimal",
        description: undefined,
      });
    });

    it("trims whitespace from name", async () => {
      mockBeta.environments.create.mockResolvedValue({
        id: "env_trimmed",
        name: "trimmed-name",
      });

      await createEnvironment(client, { name: "  trimmed-name  " });
      expect(mockBeta.environments.create).toHaveBeenCalledWith({
        name: "trimmed-name",
        description: undefined,
      });
    });

    it("throws if name is empty", async () => {
      await expect(
        createEnvironment(client, { name: "" }),
      ).rejects.toThrow("Environment name is required and cannot be empty");
    });

    it("throws if name is only whitespace", async () => {
      await expect(
        createEnvironment(client, { name: "   " }),
      ).rejects.toThrow("Environment name is required and cannot be empty");
    });

    it("propagates API errors", async () => {
      mockBeta.environments.create.mockRejectedValue(
        new Error("Quota exceeded"),
      );

      await expect(
        createEnvironment(client, { name: "will-fail" }),
      ).rejects.toThrow("Quota exceeded");
    });
  });

  describe("listEnvironments", () => {
    it("returns list of environments", async () => {
      mockBeta.environments.list.mockResolvedValue({
        data: [
          { id: "env_1", name: "env-one" },
          { id: "env_2", name: "env-two" },
        ],
      });

      const result = await listEnvironments(client);
      expect(result).toEqual([
        { id: "env_1", name: "env-one" },
        { id: "env_2", name: "env-two" },
      ]);
    });

    it("uses default limit of 20", async () => {
      mockBeta.environments.list.mockResolvedValue({ data: [] });

      await listEnvironments(client);
      expect(mockBeta.environments.list).toHaveBeenCalledWith({ limit: 20 });
    });

    it("respects custom limit", async () => {
      mockBeta.environments.list.mockResolvedValue({ data: [] });

      await listEnvironments(client, { limit: 5 });
      expect(mockBeta.environments.list).toHaveBeenCalledWith({ limit: 5 });
    });

    it("returns empty array when no environments exist", async () => {
      mockBeta.environments.list.mockResolvedValue({ data: [] });

      const result = await listEnvironments(client);
      expect(result).toEqual([]);
    });

    it("handles response without data wrapper", async () => {
      // Some API shapes return array directly
      mockBeta.environments.list.mockResolvedValue([
        { id: "env_direct", name: "direct" },
      ]);

      const result = await listEnvironments(client);
      expect(result).toEqual([{ id: "env_direct", name: "direct" }]);
    });

    it("throws descriptive error on API failure", async () => {
      mockBeta.environments.list.mockRejectedValue(
        new Error("Unauthorized"),
      );

      await expect(listEnvironments(client)).rejects.toThrow(
        "Failed to list environments: Unauthorized",
      );
    });
  });

  describe("resolveEnvironment", () => {
    it("validates existing environment in 'existing' mode", async () => {
      mockBeta.environments.retrieve.mockResolvedValue({
        id: "env_existing",
        name: "Existing Env",
      });

      const result = await resolveEnvironment(client, {
        mode: "existing",
        environmentId: "env_existing",
      });

      expect(result).toEqual({
        id: "env_existing",
        name: "Existing Env",
        created: false,
      });
    });

    it("creates new environment in 'create' mode", async () => {
      mockBeta.environments.create.mockResolvedValue({
        id: "env_new",
        name: "new-env",
      });

      const result = await resolveEnvironment(client, {
        mode: "create",
        name: "new-env",
        description: "Fresh environment",
      });

      expect(result).toEqual({
        id: "env_new",
        name: "new-env",
        created: true,
      });
    });

    it("propagates validation errors in existing mode", async () => {
      await expect(
        resolveEnvironment(client, {
          mode: "existing",
          environmentId: "",
        }),
      ).rejects.toThrow("Invalid environment ID format");
    });

    it("propagates creation errors in create mode", async () => {
      mockBeta.environments.create.mockRejectedValue(
        new Error("Service unavailable"),
      );

      await expect(
        resolveEnvironment(client, {
          mode: "create",
          name: "will-fail",
        }),
      ).rejects.toThrow("Service unavailable");
    });
  });

  describe("defaultEnvironmentName", () => {
    it("appends -env suffix to agent name", () => {
      expect(defaultEnvironmentName("my-bot")).toBe("my-bot-env");
      expect(defaultEnvironmentName("agentchannels")).toBe("agentchannels-env");
    });

    it("handles empty agent name", () => {
      expect(defaultEnvironmentName("")).toBe("-env");
    });
  });
});
