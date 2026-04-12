import { input, select, confirm } from "@inquirer/prompts";
import { AgentClient } from "../core/agent-client.js";
import { validateAnthropicKey, resolvePartialConfig } from "../core/config.js";
import type { ConfigOverrides } from "../core/config.js";
import { writeEnvFile } from "../config/env.js";
import {
  validateEnvironment,
  createEnvironment,
  defaultEnvironmentName,
} from "../core/environment.js";
import {
  resolveAgent,
  validateAgent,
  defaultAgentName,
  defaultAgentDescription,
} from "../core/agent.js";

export interface InitAgentOptions {
  anthropicApiKey?: string;
  agentId?: string;
  environmentId?: string;
  nonInteractive?: boolean;
}

export interface InitAgentResult {
  agentId: string;
  agentName: string;
  environmentId: string;
  environmentName: string;
  created: { agent: boolean; environment: boolean };
}

/**
 * Validate that an agent ID exists by retrieving it from the API.
 * Returns the agent info or throws with a descriptive error.
 * Delegates to the centralized agent utility.
 */
export async function validateAgentId(
  client: AgentClient,
  agentId: string,
): Promise<{ id: string; name: string }> {
  return validateAgent(client, agentId);
}

/**
 * Validate that an environment ID exists by retrieving it from the API.
 * Returns the environment info or throws with a descriptive error.
 * Delegates to the centralized environment utility.
 */
export async function validateEnvironmentId(
  client: AgentClient,
  environmentId: string,
): Promise<{ id: string; name: string }> {
  return validateEnvironment(client, environmentId);
}

/**
 * Core logic for agent initialization, separated from interactive prompts
 * for testability.
 */
export async function initAgentCore(
  client: AgentClient,
  options: {
    mode: "create" | "existing";
    agentId?: string;
    environmentId?: string;
    agentName?: string;
    agentDescription?: string;
    agentModel?: string;
    agentSystemPrompt?: string;
    environmentName?: string;
    environmentDescription?: string;
    envMode?: "create" | "existing";
  },
): Promise<InitAgentResult> {
  let createdEnv = false;

  // --- Agent (create or validate via resolveAgent) ---
  if (options.mode === "existing" && !options.agentId) {
    throw new Error("Agent ID is required when using existing agent");
  }
  if (options.mode === "create" && !options.agentName) {
    throw new Error("Agent name is required when creating a new agent");
  }

  const agentResult = await resolveAgent(
    client,
    options.mode === "existing"
      ? { mode: "existing", agentId: options.agentId! }
      : {
          mode: "create",
          name: options.agentName!,
          model: options.agentModel,
          description: options.agentDescription,
          system: options.agentSystemPrompt,
        },
  );
  const agentId = agentResult.id;
  const agentName = agentResult.name;
  const createdAgent = agentResult.created;

  // --- Environment ---
  let environmentId: string;
  let environmentName: string;

  const envMode = options.envMode ?? (options.environmentId ? "existing" : "create");

  if (envMode === "existing") {
    if (!options.environmentId) {
      throw new Error("Environment ID is required when using existing environment");
    }
    const env = await validateEnvironment(client, options.environmentId);
    environmentId = env.id;
    environmentName = env.name;
  } else {
    const envName = options.environmentName ?? defaultEnvironmentName(agentName);
    const env = await createEnvironment(client, {
      name: envName,
      description: options.environmentDescription,
    });
    environmentId = env.id;
    environmentName = env.name;
    createdEnv = true;
  }

  return {
    agentId,
    agentName,
    environmentId,
    environmentName,
    created: { agent: createdAgent, environment: createdEnv },
  };
}

/**
 * Interactive wizard for `ach init agent`.
 * Creates or validates a Claude Managed Agent and Environment,
 * then writes IDs to .env.
 */
export async function initAgent(options: InitAgentOptions = {}): Promise<void> {
  console.log("\n🤖 Claude Managed Agent Setup\n");

  // Step 1: Resolve config from CLI flags > env vars > .env file
  const overrides: ConfigOverrides = {
    anthropicApiKey: options.anthropicApiKey,
    agentId: options.agentId,
    environmentId: options.environmentId,
  };
  const partialConfig = resolvePartialConfig({ overrides });

  // Validate API key (resolved from any of the three sources)
  const apiKey = partialConfig.anthropicApiKey ?? validateAnthropicKey({ overrides });
  const client = new AgentClient({ apiKey });

  console.log("🔑 Validating Anthropic API key...");
  await client.validateAuth();
  console.log("✅ API key is valid.\n");

  // Step 2: Use resolved config for existing IDs (already resolved from CLI flags > env vars > .env)
  const existingAgentId = partialConfig.agentId;
  const existingEnvId = partialConfig.environmentId;

  // Step 3: Agent setup
  let mode: "create" | "existing";
  let coreOptions: Parameters<typeof initAgentCore>[1];

  if (options.nonInteractive) {
    // Non-interactive mode: use existing IDs or create with defaults
    if (existingAgentId && existingEnvId) {
      mode = "existing";
      coreOptions = {
        mode: "existing",
        agentId: existingAgentId,
        environmentId: existingEnvId,
        envMode: "existing",
      };
    } else if (existingAgentId) {
      mode = "existing";
      coreOptions = {
        mode: "existing",
        agentId: existingAgentId,
        envMode: "create",
        environmentName: "agentchannels-env",
      };
    } else {
      mode = "create";
      coreOptions = {
        mode: "create",
        agentName: "agentchannels-bot",
        agentDescription: "Agent Channels Slack bot",
        envMode: existingEnvId ? "existing" : "create",
        environmentId: existingEnvId,
        environmentName: "agentchannels-env",
      };
    }
  } else {
    // Interactive mode
    if (existingAgentId) {
      console.log(`📋 Found existing CLAUDE_AGENT_ID: ${existingAgentId}`);
      const useExisting = await confirm({
        message: "Use this existing agent?",
        default: true,
      });

      if (useExisting) {
        mode = "existing";
      } else {
        mode = await select({
          message: "What would you like to do?",
          choices: [
            { name: "Create a new agent", value: "create" as const },
            { name: "Enter a different agent ID", value: "existing" as const },
          ],
        });
      }
    } else {
      mode = await select({
        message: "How would you like to set up the Claude agent?",
        choices: [
          { name: "Create a new agent", value: "create" as const },
          { name: "Use an existing agent ID", value: "existing" as const },
        ],
      });
    }

    if (mode === "existing") {
      const agentId =
        existingAgentId && (await confirm({ message: "Use this existing agent?", default: true }).catch(() => false))
          ? existingAgentId
          : await input({
              message: "Enter your Claude Agent ID:",
              default: existingAgentId,
              validate: (v) => (v.trim().length > 0 ? true : "Agent ID is required"),
            });

      // Environment setup for existing agent
      const envSetup = await promptEnvironmentSetup(existingEnvId);
      coreOptions = {
        mode: "existing",
        agentId,
        ...envSetup,
      };
    } else {
      // Create new agent
      const agentName = await input({
        message: "Agent name:",
        default: "agentchannels-bot",
      });

      const agentDescription = await input({
        message: "Agent description (optional):",
        default: "Agent Channels bot",
      });

      const agentModel = await select({
        message: "Model:",
        choices: [
          { name: "Claude Sonnet 4 (recommended)", value: "claude-sonnet-4-6" },
          { name: "Claude Opus 4", value: "claude-opus-4-6" },
          { name: "Claude Haiku 3.5", value: "claude-haiku-4-6" },
        ],
        default: "claude-sonnet-4-6",
      });

      const customizeSystem = await confirm({
        message: "Customize system prompt?",
        default: false,
      });

      let agentSystemPrompt: string | undefined;
      if (customizeSystem) {
        agentSystemPrompt = await input({
          message: "System prompt:",
          default:
            "You are a helpful assistant connected to a Slack workspace. Be concise and helpful.",
        });
      }

      // Environment setup for new agent
      const envSetup = await promptEnvironmentSetup(existingEnvId);
      coreOptions = {
        mode: "create",
        agentName,
        agentDescription,
        agentModel,
        agentSystemPrompt,
        ...envSetup,
      };
    }
  }

  // Step 4: Execute (with retry on failure)
  console.log("\n⏳ Setting up agent and environment...");
  let result: InitAgentResult;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      result = await initAgentCore(client, coreOptions);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Failed: ${message}\n`);

      const retry = await confirm({
        message: "Would you like to retry?",
        default: true,
      });

      if (!retry) {
        throw error;
      }
    }
  }

  // Step 5: Write to .env
  const envValues: Record<string, string> = {
    CLAUDE_AGENT_ID: result.agentId,
    CLAUDE_ENVIRONMENT_ID: result.environmentId,
  };

  // Persist API key to .env if not already present there
  // (readEnvFile is intentional here — we check the .env file specifically for persistence)
  const { readEnvFile } = await import("../config/env.js");
  if (!readEnvFile().ANTHROPIC_API_KEY) {
    envValues.ANTHROPIC_API_KEY = apiKey;
  }

  writeEnvFile(envValues);

  // Step 6: Summary
  console.log("\n✅ Agent setup complete!\n");
  console.log(`  Agent:       ${result.agentName} (${result.agentId})`);
  console.log(
    `               ${result.created.agent ? "← newly created" : "← validated existing"}`,
  );
  console.log(
    `  Environment: ${result.environmentName} (${result.environmentId})`,
  );
  console.log(
    `               ${result.created.environment ? "← newly created" : "← validated existing"}`,
  );
  console.log("\n  Written to .env: CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID");
  console.log("\n  Next step: run `ach serve` to start the bot.\n");
}

/**
 * Prompt for environment setup interactively.
 */
async function promptEnvironmentSetup(existingEnvId?: string): Promise<{
  envMode: "create" | "existing";
  environmentId?: string;
  environmentName?: string;
  environmentDescription?: string;
}> {
  if (existingEnvId) {
    console.log(`\n📋 Found existing CLAUDE_ENVIRONMENT_ID: ${existingEnvId}`);
    const useExisting = await confirm({
      message: "Use this existing environment?",
      default: true,
    });

    if (useExisting) {
      return { envMode: "existing", environmentId: existingEnvId };
    }
  }

  const envMode = await select({
    message: "How would you like to set up the environment?",
    choices: [
      { name: "Create a new environment", value: "create" as const },
      { name: "Use an existing environment ID", value: "existing" as const },
    ],
  });

  if (envMode === "existing") {
    const environmentId = await input({
      message: "Enter your Environment ID:",
      validate: (v) => (v.trim().length > 0 ? true : "Environment ID is required"),
    });
    return { envMode: "existing", environmentId };
  }

  const environmentName = await input({
    message: "Environment name:",
    default: "agentchannels-env",
  });

  return { envMode: "create", environmentName };
}
