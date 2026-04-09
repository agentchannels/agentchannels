import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  resolvePartialConfig,
  resolveRawConfig,
  validateAnthropicKey,
  ConfigValidationError,
  ENV_VAR_MAP,
  type ResolveOptions,
} from "../../src/core/config.js";

/**
 * Helper: build a full valid set of .env entries keyed by env-var names.
 */
function fullDotEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "sk-ant-dotenv",
    CLAUDE_AGENT_ID: "agent-dotenv",
    CLAUDE_ENVIRONMENT_ID: "env-dotenv",
    SLACK_BOT_TOKEN: "xoxb-dotenv",
    SLACK_APP_TOKEN: "xapp-dotenv",
    SLACK_SIGNING_SECRET: "secret-dotenv",
    ...overrides,
  };
}

/**
 * Helper: build a full valid set of env vars keyed by env-var names.
 */
function fullEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "sk-ant-env",
    CLAUDE_AGENT_ID: "agent-env",
    CLAUDE_ENVIRONMENT_ID: "env-env",
    SLACK_BOT_TOKEN: "xoxb-env",
    SLACK_APP_TOKEN: "xapp-env",
    SLACK_SIGNING_SECRET: "secret-env",
    ...overrides,
  };
}

/**
 * Helper: build a full valid set of CLI overrides.
 */
function fullOverrides(overrides: Record<string, string> = {}) {
  return {
    anthropicApiKey: "sk-ant-cli",
    agentId: "agent-cli",
    environmentId: "env-cli",
    slackBotToken: "xoxb-cli",
    slackAppToken: "xapp-cli",
    slackSigningSecret: "secret-cli",
    ...overrides,
  };
}

// ─── resolveRawConfig ─────────────────────────────────────────────────────

describe("resolveRawConfig", () => {
  it("returns undefined for all fields when no sources provided", () => {
    const raw = resolveRawConfig({ env: {}, dotEnv: {} });
    for (const key of Object.keys(ENV_VAR_MAP)) {
      expect(raw[key]).toBeUndefined();
    }
  });

  it("reads values from .env file (dotEnv)", () => {
    const raw = resolveRawConfig({ env: {}, dotEnv: fullDotEnv() });
    expect(raw.anthropicApiKey).toBe("sk-ant-dotenv");
    expect(raw.agentId).toBe("agent-dotenv");
  });

  it("reads values from env vars", () => {
    const raw = resolveRawConfig({ env: fullEnv(), dotEnv: {} });
    expect(raw.anthropicApiKey).toBe("sk-ant-env");
    expect(raw.slackBotToken).toBe("xoxb-env");
  });

  it("reads values from CLI overrides", () => {
    const raw = resolveRawConfig({ overrides: fullOverrides(), env: {}, dotEnv: {} });
    expect(raw.anthropicApiKey).toBe("sk-ant-cli");
    expect(raw.agentId).toBe("agent-cli");
  });
});

// ─── Precedence ────────────────────────────────────────────────────────────

describe("three-source precedence", () => {
  it("CLI flags override env vars", () => {
    const raw = resolveRawConfig({
      overrides: { anthropicApiKey: "sk-ant-cli" },
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: {},
    });
    expect(raw.anthropicApiKey).toBe("sk-ant-cli");
  });

  it("env vars override .env file", () => {
    const raw = resolveRawConfig({
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: { ANTHROPIC_API_KEY: "sk-ant-dotenv" },
    });
    expect(raw.anthropicApiKey).toBe("sk-ant-env");
  });

  it("CLI flags override both env vars and .env file", () => {
    const raw = resolveRawConfig({
      overrides: { anthropicApiKey: "sk-ant-cli" },
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: { ANTHROPIC_API_KEY: "sk-ant-dotenv" },
    });
    expect(raw.anthropicApiKey).toBe("sk-ant-cli");
  });

  it("falls through to .env when higher sources are empty", () => {
    const raw = resolveRawConfig({
      overrides: {},
      env: {},
      dotEnv: { SLACK_BOT_TOKEN: "xoxb-dotenv" },
    });
    expect(raw.slackBotToken).toBe("xoxb-dotenv");
  });

  it("treats empty string overrides as unset (falls through)", () => {
    const raw = resolveRawConfig({
      overrides: { anthropicApiKey: "" },
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: {},
    });
    expect(raw.anthropicApiKey).toBe("sk-ant-env");
  });

  it("treats empty string env vars as unset (falls through to dotEnv)", () => {
    const raw = resolveRawConfig({
      env: { ANTHROPIC_API_KEY: "" },
      dotEnv: { ANTHROPIC_API_KEY: "sk-ant-dotenv" },
    });
    expect(raw.anthropicApiKey).toBe("sk-ant-dotenv");
  });

  it("applies precedence independently per field", () => {
    const raw = resolveRawConfig({
      overrides: { anthropicApiKey: "sk-ant-cli" },
      env: { SLACK_BOT_TOKEN: "xoxb-env" },
      dotEnv: { CLAUDE_AGENT_ID: "agent-dotenv" },
    });
    expect(raw.anthropicApiKey).toBe("sk-ant-cli");
    expect(raw.slackBotToken).toBe("xoxb-env");
    expect(raw.agentId).toBe("agent-dotenv");
  });
});

// ─── resolveConfig (full validation) ──────────────────────────────────────

describe("resolveConfig", () => {
  it("returns validated config from .env", () => {
    const config = resolveConfig({ env: {}, dotEnv: fullDotEnv() });
    expect(config.anthropicApiKey).toBe("sk-ant-dotenv");
    expect(config.agentId).toBe("agent-dotenv");
    expect(config.slackBotToken).toBe("xoxb-dotenv");
  });

  it("returns validated config from env vars", () => {
    const config = resolveConfig({ env: fullEnv(), dotEnv: {} });
    expect(config.anthropicApiKey).toBe("sk-ant-env");
  });

  it("returns validated config with CLI overrides", () => {
    const config = resolveConfig({
      overrides: fullOverrides(),
      env: {},
      dotEnv: {},
    });
    expect(config.anthropicApiKey).toBe("sk-ant-cli");
  });

  it("throws ConfigValidationError when required fields are missing", () => {
    expect(() => resolveConfig({ env: {}, dotEnv: {} })).toThrow(ConfigValidationError);
  });

  it("error message lists missing fields", () => {
    try {
      resolveConfig({ env: {}, dotEnv: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const validationErr = err as ConfigValidationError;
      expect(validationErr.message).toContain("ANTHROPIC_API_KEY");
      expect(validationErr.issues.length).toBeGreaterThan(0);
    }
  });

  it("slackSigningSecret is optional", () => {
    const dotEnv = fullDotEnv();
    delete (dotEnv as Record<string, string>)["SLACK_SIGNING_SECRET"];
    const config = resolveConfig({ env: {}, dotEnv });
    expect(config.slackSigningSecret).toBeUndefined();
  });

  // Legacy API: passing ConfigOverrides directly
  it("supports legacy API with ConfigOverrides directly", () => {
    const config = resolveConfig({
      overrides: fullOverrides(),
      env: {},
      dotEnv: {},
    });
    expect(config.anthropicApiKey).toBe("sk-ant-cli");
  });
});

// ─── resolvePartialConfig ──────────────────────────────────────────────────

describe("resolvePartialConfig", () => {
  it("returns only fields that are set", () => {
    const partial = resolvePartialConfig({
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: {},
    });
    expect(partial.anthropicApiKey).toBe("sk-ant-env");
    expect(partial.slackBotToken).toBeUndefined();
  });

  it("does not throw on missing fields", () => {
    expect(() => resolvePartialConfig({ env: {}, dotEnv: {} })).not.toThrow();
  });

  it("applies precedence correctly", () => {
    const partial = resolvePartialConfig({
      overrides: { anthropicApiKey: "sk-ant-cli" },
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: {},
    });
    expect(partial.anthropicApiKey).toBe("sk-ant-cli");
  });

  it("returns all fields when all sources provide values", () => {
    const partial = resolvePartialConfig({
      overrides: fullOverrides(),
      env: {},
      dotEnv: {},
    });
    expect(Object.keys(partial).length).toBe(6);
  });
});

// ─── validateAnthropicKey ──────────────────────────────────────────────────

describe("validateAnthropicKey", () => {
  it("returns key from CLI override", () => {
    const key = validateAnthropicKey({
      overrides: { anthropicApiKey: "sk-ant-cli" },
      env: {},
      dotEnv: {},
    });
    expect(key).toBe("sk-ant-cli");
  });

  it("returns key from env var", () => {
    const key = validateAnthropicKey({
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: {},
    });
    expect(key).toBe("sk-ant-env");
  });

  it("returns key from .env file", () => {
    const key = validateAnthropicKey({
      env: {},
      dotEnv: { ANTHROPIC_API_KEY: "sk-ant-dotenv" },
    });
    expect(key).toBe("sk-ant-dotenv");
  });

  it("throws when key is not set anywhere", () => {
    expect(() => validateAnthropicKey({ env: {}, dotEnv: {} })).toThrow(
      "ANTHROPIC_API_KEY is required",
    );
  });

  it("respects precedence (CLI > env > dotEnv)", () => {
    const key = validateAnthropicKey({
      overrides: { anthropicApiKey: "sk-ant-cli" },
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
      dotEnv: { ANTHROPIC_API_KEY: "sk-ant-dotenv" },
    });
    expect(key).toBe("sk-ant-cli");
  });
});

// ─── ENV_VAR_MAP ───────────────────────────────────────────────────────────

describe("ENV_VAR_MAP", () => {
  it("maps all config fields to SCREAMING_SNAKE_CASE env var names", () => {
    expect(ENV_VAR_MAP.anthropicApiKey).toBe("ANTHROPIC_API_KEY");
    expect(ENV_VAR_MAP.agentId).toBe("CLAUDE_AGENT_ID");
    expect(ENV_VAR_MAP.environmentId).toBe("CLAUDE_ENVIRONMENT_ID");
    expect(ENV_VAR_MAP.slackBotToken).toBe("SLACK_BOT_TOKEN");
    expect(ENV_VAR_MAP.slackAppToken).toBe("SLACK_APP_TOKEN");
    expect(ENV_VAR_MAP.slackSigningSecret).toBe("SLACK_SIGNING_SECRET");
  });
});
