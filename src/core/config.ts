import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { z } from "zod";

// ─── Env-var name mapping ──────────────────────────────────────────────────
/**
 * Maps config field names to their corresponding environment variable names.
 */
export const ENV_VAR_MAP = {
  anthropicApiKey: "ANTHROPIC_API_KEY",
  agentId: "CLAUDE_AGENT_ID",
  environmentId: "CLAUDE_ENVIRONMENT_ID",
  vaultIds: "CLAUDE_VAULT_IDS",
  slackBotToken: "SLACK_BOT_TOKEN",
  slackAppToken: "SLACK_APP_TOKEN",
  slackSigningSecret: "SLACK_SIGNING_SECRET",
  discordBotToken: "DISCORD_BOT_TOKEN",
  discordApplicationId: "DISCORD_APPLICATION_ID",
  discordPublicKey: "DISCORD_PUBLIC_KEY",
} as const;

export type ConfigKey = keyof typeof ENV_VAR_MAP;

// ─── Schemas ───────────────────────────────────────────────────────────────
/**
 * Schema for full serve-time configuration.
 */
const ConfigSchema = z.object({
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  agentId: z.string().min(1, "CLAUDE_AGENT_ID is required"),
  environmentId: z.string().min(1, "CLAUDE_ENVIRONMENT_ID is required"),
  vaultIds: z.string().optional(),
  slackBotToken: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  slackAppToken: z.string().min(1, "SLACK_APP_TOKEN is required"),
  slackSigningSecret: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PartialConfig = Partial<Config>;

/**
 * Schema for Discord serve-time configuration.
 * Validates the fields required to run `ach serve discord`.
 */
const DiscordServeConfigSchema = z.object({
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  agentId: z.string().min(1, "CLAUDE_AGENT_ID is required"),
  environmentId: z.string().min(1, "CLAUDE_ENVIRONMENT_ID is required"),
  vaultIds: z.string().optional(),
  discordBotToken: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  discordApplicationId: z.string().optional(),
  discordPublicKey: z.string().optional(),
});

export type DiscordServeConfig = z.infer<typeof DiscordServeConfigSchema>;

/**
 * CLI flag overrides — all fields are optional since flags may not be provided.
 */
export interface ConfigOverrides {
  anthropicApiKey?: string;
  agentId?: string;
  environmentId?: string;
  vaultIds?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  discordBotToken?: string;
  discordApplicationId?: string;
  discordPublicKey?: string;
}

// ─── .env file reader ──────────────────────────────────────────────────────
/**
 * Parse a .env file without mutating process.env.
 * Returns a Record<string, string> of key-value pairs, or empty object if file
 * doesn't exist.
 */
export function parseDotEnvFile(cwd: string = process.cwd()): Record<string, string> {
  const envPath = path.resolve(cwd, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return dotenv.parse(fs.readFileSync(envPath, "utf-8"));
}

// ─── Core resolution logic ─────────────────────────────────────────────────
/**
 * Resolution options controlling where and how config is loaded.
 */
export interface ResolveOptions {
  /** CLI flag overrides (highest precedence) */
  overrides?: ConfigOverrides;
  /** Working directory for locating .env file (default: process.cwd()) */
  cwd?: string;
  /**
   * Override for process.env — primarily for testing.
   * If not provided, process.env is used.
   */
  env?: Record<string, string | undefined>;
  /**
   * Override for .env file contents — primarily for testing.
   * If not provided, the .env file is read from `cwd`.
   */
  dotEnv?: Record<string, string>;
}

/**
 * Resolves a single config field value using three-source precedence:
 *   1. CLI flags (overrides)  — highest priority
 *   2. Environment variables  — medium priority
 *   3. .env file values       — lowest priority
 *
 * Returns undefined if the field is not set in any source.
 */
function resolveField(
  fieldName: ConfigKey,
  overrides: ConfigOverrides,
  envVars: Record<string, string | undefined>,
  dotEnvVars: Record<string, string>,
): string | undefined {
  const envVarName = ENV_VAR_MAP[fieldName];

  // 1. CLI flag override (highest precedence)
  const cliValue = overrides[fieldName];
  if (cliValue !== undefined && cliValue !== "") {
    return cliValue;
  }

  // 2. Environment variable (medium precedence)
  const envValue = envVars[envVarName];
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }

  // 3. .env file value (lowest precedence)
  const dotEnvValue = dotEnvVars[envVarName];
  if (dotEnvValue !== undefined && dotEnvValue !== "") {
    return dotEnvValue;
  }

  return undefined;
}

/**
 * Build the raw (unvalidated) config object by resolving each field
 * from the three sources.
 */
export function resolveRawConfig(options: ResolveOptions = {}): Record<string, string | undefined> {
  const overrides = options.overrides ?? {};
  const envVars = options.env ?? process.env;
  const dotEnvVars = options.dotEnv ?? parseDotEnvFile(options.cwd);

  const raw: Record<string, string | undefined> = {};
  for (const fieldName of Object.keys(ENV_VAR_MAP) as ConfigKey[]) {
    raw[fieldName] = resolveField(fieldName, overrides, envVars, dotEnvVars);
  }
  return raw;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Resolves and validates full configuration from three sources:
 *   1. CLI flags (overrides)  — highest priority
 *   2. Environment variables  — medium priority
 *   3. .env file values       — lowest priority
 *
 * Throws a descriptive error if required fields are missing.
 */
export function resolveConfig(overridesOrOptions?: ConfigOverrides | ResolveOptions): Config {
  // Support both legacy `resolveConfig(overrides)` and new `resolveConfig({ overrides, cwd })`
  const options = normalizeOptions(overridesOrOptions);
  const raw = resolveRawConfig(options);

  // Replace undefined with empty string for required fields;
  // leave truly optional fields as undefined so Zod .optional() works correctly.
  const optionalFields = new Set<string>(["vaultIds", "slackSigningSecret"]);
  const forValidation: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (optionalFields.has(key)) {
      forValidation[key] = value || undefined;
    } else {
      forValidation[key] = value ?? "";
    }
  }

  const result = ConfigSchema.safeParse(forValidation);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new ConfigValidationError(
      `Configuration validation failed:\n${issues}`,
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * Resolves and validates Discord serve configuration from three sources:
 *   1. CLI flags (overrides)  — highest priority
 *   2. Environment variables  — medium priority
 *   3. .env file values       — lowest priority
 *
 * Validates only the fields required for `ach serve discord`.
 * Does NOT require Slack tokens.
 *
 * Throws a descriptive error if required fields are missing.
 */
export function resolveDiscordConfig(overridesOrOptions?: ConfigOverrides | ResolveOptions): DiscordServeConfig {
  const options = normalizeOptions(overridesOrOptions);
  const raw = resolveRawConfig(options);

  // Replace undefined with empty string for required fields;
  // leave truly optional fields as undefined so Zod .optional() works correctly.
  const optionalFields = new Set<string>(["vaultIds", "discordApplicationId", "discordPublicKey"]);
  const forValidation: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (optionalFields.has(key)) {
      forValidation[key] = value || undefined;
    } else {
      forValidation[key] = value ?? "";
    }
  }

  const result = DiscordServeConfigSchema.safeParse(forValidation);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new ConfigValidationError(
      `Discord configuration validation failed:\n${issues}`,
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * Resolve partial config — returns whatever fields are available without
 * requiring all fields to be present. Useful for init commands.
 */
export function resolvePartialConfig(overridesOrOptions?: ConfigOverrides | ResolveOptions): PartialConfig {
  const options = normalizeOptions(overridesOrOptions);
  const raw = resolveRawConfig(options);

  const result: PartialConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== "") {
      (result as Record<string, string>)[key] = value;
    }
  }
  return result;
}

/**
 * Validates only that the Anthropic API key is present.
 * Used by commands that don't need full config (e.g., init agent).
 */
export function validateAnthropicKey(overridesOrOptions?: ConfigOverrides | ResolveOptions): string {
  const options = normalizeOptions(overridesOrOptions);
  const raw = resolveRawConfig(options);
  const key = raw.anthropicApiKey;

  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set it via env var, .env file, or --anthropic-api-key flag.",
    );
  }
  return key;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize the overloaded argument into ResolveOptions.
 * Supports both `resolveConfig({ anthropicApiKey: "..." })` (legacy)
 * and `resolveConfig({ overrides: { ... }, cwd: "/path" })` (new).
 */
function normalizeOptions(input?: ConfigOverrides | ResolveOptions): ResolveOptions {
  if (!input) return {};

  // If it has ResolveOptions-specific keys, treat as ResolveOptions
  if ("overrides" in input || "cwd" in input || "env" in input || "dotEnv" in input) {
    return input as ResolveOptions;
  }

  // Otherwise treat as legacy ConfigOverrides
  return { overrides: input as ConfigOverrides };
}

/**
 * Structured validation error with access to individual issues.
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ message: string; path?: PropertyKey[] }>,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}
