import { input, confirm, select, password } from '@inquirer/prompts';
import { writeEnvFile, readEnvFile } from '../../config/env.js';
import { resolvePartialConfig } from '../../core/config.js';
import type { ConfigOverrides } from '../../core/config.js';
import { AgentClient } from '../../core/agent-client.js';
import { validateAgent, listAgents, createAgent } from '../../core/agent.js';
import type { AgentInfo } from '../../core/agent.js';
import { validateEnvironment, listEnvironments, createEnvironment } from '../../core/environment.js';
import type { EnvironmentInfo } from '../../core/environment.js';
import { buildSlackManifest } from './manifest.js';
import { SlackApiClient, SlackApiRequestError } from './api.js';
import { addRedirectUrl, runOAuthInstall } from './oauth.js';

/**
 * Result of the Slack init wizard
 */
export interface SlackInitResult {
  appName: string;
  appDescription: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
  envWritten: boolean;
  /** The validated Anthropic API key used during this wizard run */
  anthropicApiKey: string;
  /**
   * The Claude Managed Agent ID selected/validated during this wizard run.
   * Undefined when no existing CLAUDE_AGENT_ID was detected (step is skipped when absent).
   */
  agentId?: string;
  /**
   * The validated environment ID written to .env.
   * Undefined when no existing CLAUDE_ENVIRONMENT_ID was detected/selected.
   */
  environmentId?: string;
  /** Vault IDs that passed per-ID validation and were written to .env */
  vaultIds: string[];
}

/**
 * Options for controlling the init flow (useful for testing)
 */
export interface SlackInitOptions {
  /** Skip writing to .env file */
  skipEnvWrite?: boolean;
  /** Working directory for .env file */
  cwd?: string;
  /**
   * Run without interactive prompts.
   * Path is inferred from which credentials are provided:
   *   - Manual path: slackBotToken + slackAppToken + slackSigningSecret
   *   - Auto path:   slackRefreshToken
   */
  nonInteractive?: boolean;
  /** Slack Bot Token override (xoxb-...) — CLI flag or env var SLACK_BOT_TOKEN */
  slackBotToken?: string;
  /** Slack App-Level Token override (xapp-...) — CLI flag or env var SLACK_APP_TOKEN */
  slackAppToken?: string;
  /** Slack Signing Secret override — CLI flag or env var SLACK_SIGNING_SECRET */
  slackSigningSecret?: string;
  /** Slack Refresh Token for automatic setup (xoxe-...) — CLI flag or env var SLACK_REFRESH_TOKEN */
  slackRefreshToken?: string;
  /** App name for non-interactive automatic setup (default: "General Agent") */
  appName?: string;
  /** App description for non-interactive automatic setup */
  appDescription?: string;
  /** Anthropic API Key override — CLI flag or env var ANTHROPIC_API_KEY */
  anthropicApiKey?: string;
  /** CLAUDE_AGENT_ID override — CLI flag or env var CLAUDE_AGENT_ID */
  claudeAgentId?: string;
  /** CLAUDE_ENVIRONMENT_ID override — CLI flag or env var CLAUDE_ENVIRONMENT_ID */
  claudeEnvironmentId?: string;
  /** CLAUDE_VAULT_IDS override (comma-separated) — env var CLAUDE_VAULT_IDS */
  claudeVaultIds?: string;
}

/**
 * Setup method type for the init wizard
 */
export type SetupMethod = 'automatic' | 'guided' | 'manual';

// ────────────────────────── API Key Validation ──────────────────────────

/**
 * Collect and validate the Anthropic API key interactively.
 *
 * - If an existing key is already configured (from env or .env file), validates
 *   it silently without prompting.
 * - On validation failure — or when no key is present — prompts the user for a
 *   key and retries. The loop never hard-exits on the first failure: users get
 *   another chance to enter a valid key on every attempt.
 */
async function collectAndValidateApiKey(options: {
  existingKey?: string;
}): Promise<string> {
  let currentKey: string | undefined = options.existingKey;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!currentKey) {
      currentKey = await password({
        message: 'Anthropic API Key:',
        validate: (value) => (value.trim() ? true : 'API key is required'),
      });
    }

    console.log('🔑 Validating Anthropic API key...');

    try {
      const client = new AgentClient({ apiKey: currentKey });
      await client.validateAuth();
      console.log('✅ API key validated.\n');
      return currentKey;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ ${message}`);
      console.log('Please enter a valid Anthropic API key to continue.\n');
      currentKey = undefined; // force re-prompt on next iteration
    }
  }
}

// ────────────────────────── Agent Model List ──────────────────────────

/**
 * Predefined list of Claude models available for new managed agents.
 * Presented to the user as a select menu when creating an agent.
 */
const CLAUDE_AGENT_MODELS: Array<{ name: string; value: string }> = [
  { name: 'claude-opus-4-5 — most capable, best for complex tasks', value: 'claude-opus-4-5' },
  { name: 'claude-sonnet-4-6 — balanced performance (recommended)', value: 'claude-sonnet-4-6' },
  { name: 'claude-haiku-4-5 — fastest, most efficient', value: 'claude-haiku-4-5' },
];

// ────────────────────────── Agent Selection ──────────────────────────

/**
 * Detect, validate, and keep-or-change an existing CLAUDE_AGENT_ID.
 *
 * Pattern:
 *  1. Validate the existing ID via `beta.agents.retrieve`
 *  2a. Valid   → show name/ID, ask "Keep or change?" (default: keep)
 *        keep   → return existing id
 *        change → fall through to selectOrCreateAgent
 *  2b. Invalid → warn explicitly ("stale"), force re-selection —
 *               never silently drop the value without telling the user
 *
 * Called only when an existing agent ID is present in the resolved config.
 * Returns undefined only if called with no existingId (no-op path).
 */
async function collectAndSelectAgent(
  client: AgentClient,
  existingId: string,
): Promise<string> {
  console.log(`\n🤖 Validating CLAUDE_AGENT_ID: ${existingId}...`);

  let agent: AgentInfo;
  try {
    agent = await validateAgent(client, existingId);
    console.log(`   ✅ Agent found: "${agent.name}" (${agent.id})\n`);
  } catch (_err) {
    // Stale ID — warn explicitly, never silently drop the information
    console.warn(
      `\n⚠️  CLAUDE_AGENT_ID "${existingId}" was not found via the Anthropic API (stale or invalid).` +
        '\n    You must select a different agent or create a new one.\n',
    );
    return selectOrCreateAgent(client);
  }

  // Keep (default) or change?
  const action = await select<'keep' | 'change'>({
    message: `Agent "${agent.name}" (${agent.id}) — keep or change?`,
    choices: [
      { name: `Keep: ${agent.name} (${agent.id})`, value: 'keep' as const },
      { name: 'Select or create a different agent', value: 'change' as const },
    ],
  });

  if (action === 'keep') {
    return agent.id;
  }

  return selectOrCreateAgent(client);
}

/**
 * Interactive sub-flow: list available agents and let the user pick one,
 * or create a new one.  Auto-jumps to creation when no agents exist
 * (satisfies "minimize_user_clicks: Empty lists auto-jump to create").
 */
async function selectOrCreateAgent(client: AgentClient): Promise<string> {
  console.log('⏳ Loading agents...');
  let agents: AgentInfo[] = [];
  try {
    agents = await listAgents(client);
  } catch (_err) {
    console.warn('⚠️  Could not list agents. You can create a new one.\n');
  }

  if (agents.length === 0) {
    console.log('ℹ️  No existing agents found — creating a new one.\n');
    return createAgentInteractive(client);
  }

  const choices: Array<{ name: string; value: string }> = [
    ...agents.map((a) => ({ name: `${a.name} (${a.id})`, value: a.id })),
    { name: '+ Create a new agent', value: '__create__' },
    { name: '✏️  Paste ID manually', value: '__manual__' },
  ];

  const selected = await select<string>({
    message: 'Select a Claude Managed Agent:',
    choices,
  });

  if (selected === '__create__') {
    return createAgentInteractive(client);
  }

  if (selected === '__manual__') {
    return pasteAgentIdManually(client);
  }

  const chosenAgent = agents.find((a) => a.id === selected);
  if (chosenAgent) {
    console.log(`✅ Selected agent: "${chosenAgent.name}" (${chosenAgent.id})\n`);
  }
  return selected;
}

/**
 * Interactive sub-flow: prompt the user to type or paste an agent ID manually,
 * then validate it via `beta.agents.retrieve`.
 *
 * Re-prompts on validation failure — never hard-exits on the first bad ID.
 * Useful when the target agent is not in the top-20 list returned by the API.
 */
async function pasteAgentIdManually(client: AgentClient): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const agentId = await input({
      message: 'Agent ID:',
      validate: (v) => (v.trim() ? true : 'Agent ID is required'),
    });

    const trimmedId = agentId.trim();
    console.log(`⏳ Validating agent "${trimmedId}"...`);

    try {
      const agent = await validateAgent(client, trimmedId);
      console.log(`✅ Agent found: "${agent.name}" (${agent.id})\n`);
      return agent.id;
    } catch (_err) {
      console.warn(
        `\n⚠️  Agent "${trimmedId}" not found or inaccessible via the API.` +
          '\n    Please check the ID and try again, or press Ctrl+C to exit.\n',
      );
      // Loop continues — user gets another chance
    }
  }
}

/**
 * Interactive sub-flow: prompt for name, description, model, and system prompt,
 * then create a new agent via the Anthropic beta API.
 *
 * Prompt order (Sub-AC 8b):
 *   1. Agent name          (required, default: "agentchannels-bot")
 *   2. Description         (optional, press Enter to skip)
 *   3. Model               (select from CLAUDE_AGENT_MODELS, default: claude-sonnet-4-6)
 *   4. System prompt       (optional, press Enter to skip)
 *
 * Calls `client.beta.agents.create` with all provided fields and returns the new agent ID.
 */
async function createAgentInteractive(client: AgentClient): Promise<string> {
  const name = await input({
    message: 'Agent name:',
    default: 'agentchannels-bot',
    validate: (v) => (v.trim() ? true : 'Agent name is required'),
  });

  const description = await input({
    message: 'Agent description (optional, press Enter to skip):',
    default: '',
  });

  const model = await select<string>({
    message: 'Model:',
    choices: CLAUDE_AGENT_MODELS,
  });

  const systemPrompt = await input({
    message: 'System prompt (optional, press Enter to skip):',
    default: '',
  });

  console.log(`⏳ Creating agent "${name.trim()}"...`);
  const newAgent = await createAgent(client, {
    name: name.trim(),
    description: description.trim() || undefined,
    model,
    system: systemPrompt.trim() || undefined,
  });
  console.log(`   ✅ Agent created: "${newAgent.name}" (${newAgent.id})\n`);
  return newAgent.id;
}

// ────────────────────────── Environment Selection ──────────────────────────

/**
 * Detect, validate, and keep-or-change an existing CLAUDE_ENVIRONMENT_ID.
 *
 * Pattern:
 *  1. Validate the existing ID via `beta.environments.retrieve`
 *  2a. Valid   → show name/ID, ask "Keep or change?"
 *        keep   → return existing id
 *        change → fall through to selectOrCreateEnvironment
 *  2b. Stale   → warn explicitly, fall through to selectOrCreateEnvironment
 *
 * Called only when an existing environment ID is present in the config.
 */
async function collectAndSelectEnvironment(
  client: AgentClient,
  existingId: string,
): Promise<string | undefined> {
  console.log(`🔍 Validating CLAUDE_ENVIRONMENT_ID: ${existingId}...`);

  let env: EnvironmentInfo;
  try {
    env = await validateEnvironment(client, existingId);
    console.log(`✅ Environment found: "${env.name}" (${env.id})\n`);
  } catch (_err) {
    // Stale ID — warn explicitly, never silently drop the information
    console.warn(
      `\n⚠️  CLAUDE_ENVIRONMENT_ID "${existingId}" was not found via the Anthropic API (stale).` +
        '\n    Please select a different environment or create a new one.\n',
    );
    return selectOrCreateEnvironment(client);
  }

  // Keep or change?
  const action = await select<'keep' | 'change'>({
    message: `Environment "${env.name}" (${env.id}) — keep or change?`,
    choices: [
      { name: `Keep: ${env.name} (${env.id})`, value: 'keep' as const },
      { name: 'Select or create a different environment', value: 'change' as const },
    ],
  });

  if (action === 'keep') {
    return env.id;
  }

  return selectOrCreateEnvironment(client);
}

/**
 * Interactive sub-flow: list available environments (up to 20) and let the user
 * pick one, create a new one (name + optional description), or paste a raw ID.
 * Auto-jumps to creation when no environments exist (minimize_user_clicks).
 */
async function selectOrCreateEnvironment(client: AgentClient): Promise<string | undefined> {
  console.log('⏳ Loading environments...');
  let envs: EnvironmentInfo[] = [];
  try {
    envs = await listEnvironments(client);
  } catch (_err) {
    console.warn('⚠️  Could not list environments. You can create a new one.\n');
  }

  if (envs.length === 0) {
    console.log('ℹ️  No existing environments found — creating a new one.\n');
    return createEnvironmentInteractive(client);
  }

  const choices: Array<{ name: string; value: string }> = [
    ...envs.map((e) => ({ name: `${e.name} (${e.id})`, value: e.id })),
    { name: '+ Create a new environment', value: '__create__' },
    { name: '↳ Paste an environment ID', value: '__paste__' },
  ];

  const selected = await select<string>({
    message: 'Select an environment:',
    choices,
  });

  if (selected === '__create__') {
    return createEnvironmentInteractive(client);
  }

  if (selected === '__paste__') {
    return pasteEnvironmentId(client);
  }

  const chosenEnv = envs.find((e) => e.id === selected)!;
  console.log(`✅ Selected environment: "${chosenEnv.name}" (${chosenEnv.id})\n`);
  return selected;
}

/**
 * Interactive sub-flow: prompt for a name and optional description, then create
 * a new environment via the API.
 */
async function createEnvironmentInteractive(client: AgentClient): Promise<string> {
  const name = await input({
    message: 'Environment name:',
    default: 'agentchannels-env',
    validate: (v) => (v.trim() ? true : 'Environment name is required'),
  });

  const description = await input({
    message: 'Environment description (optional, press Enter to skip):',
    default: '',
  });

  console.log(`⏳ Creating environment "${name}"...`);
  const newEnv = await createEnvironment(client, {
    name: name.trim(),
    description: description.trim() || undefined,
  });
  console.log(`✅ Environment created: "${newEnv.name}" (${newEnv.id})\n`);
  return newEnv.id;
}

/**
 * Interactive sub-flow: prompt the user to paste a raw environment ID, validate
 * it via beta.environments.retrieve, and re-prompt on failure until a valid ID
 * is supplied.
 */
async function pasteEnvironmentId(client: AgentClient): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rawId = await input({
      message: 'Environment ID:',
      validate: (v) => (v.trim() ? true : 'Environment ID is required'),
    });
    const trimmedId = rawId.trim();

    console.log(`⏳ Validating environment ID "${trimmedId}"...`);
    try {
      const env = await validateEnvironment(client, trimmedId);
      console.log(`✅ Environment found: "${env.name}" (${env.id})\n`);
      return env.id;
    } catch {
      console.warn(
        `⚠️  Environment ID "${trimmedId}" not found or inaccessible — please try again.\n`,
      );
    }
  }
}

// ────────────────────────── Vault Validation ──────────────────────────

/**
 * Parse a comma-separated CLAUDE_VAULT_IDS string into a trimmed, non-empty
 * array of individual vault IDs.  Returns [] for falsy/empty input.
 */
export function parseVaultIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Validate each vault ID via `beta.vaults.retrieve`.
 *
 * - Valid IDs are kept.
 * - Invalid/inaccessible IDs are warned about and dropped.
 * - In interactive mode, the user is re-prompted once per dropped slot so
 *   they can supply a replacement vault ID (or skip by pressing Enter).
 * - In non-interactive mode, dropped IDs produce a warning but no prompt.
 *
 * @returns Array of validated vault IDs (valid originals + accepted replacements)
 */
async function collectAndValidateVaultIds(options: {
  existingIds: string[];
  anthropicApiKey: string;
  nonInteractive?: boolean;
}): Promise<string[]> {
  const { existingIds, anthropicApiKey, nonInteractive } = options;

  if (existingIds.length === 0) return [];

  console.log(`\n🔐 Validating ${existingIds.length} existing vault ID(s)...`);

  const client = new AgentClient({ apiKey: anthropicApiKey });
  const validIds: string[] = [];
  let droppedCount = 0;

  for (const id of existingIds) {
    try {
      await client.getVault(id);
      validIds.push(id);
      console.log(`   ✅ ${id} — valid`);
    } catch {
      console.warn(`   ⚠️  Vault ID "${id}" not found or inaccessible — dropping`);
      droppedCount++;
    }
  }

  if (droppedCount === 0) {
    return validIds;
  }

  if (nonInteractive) {
    console.warn(
      `⚠️  ${droppedCount} vault ID(s) dropped. ` +
        `Update CLAUDE_VAULT_IDS with valid IDs before running \`ach serve\`.`,
    );
    return validIds;
  }

  // Interactive: re-prompt once per dropped slot
  console.log(
    `\n   ${droppedCount} slot(s) cleared. ` +
      `Enter a replacement Vault ID for each (or press Enter to skip).\n`,
  );

  for (let i = 0; i < droppedCount; i++) {
    const replacement = await input({
      message: `Replacement Vault ID (${i + 1}/${droppedCount}, Enter to skip):`,
      default: '',
    });

    const trimmed = replacement.trim();
    if (trimmed) {
      try {
        await client.getVault(trimmed);
        validIds.push(trimmed);
        console.log(`   ✅ Replacement "${trimmed}" — valid`);
      } catch {
        console.warn(`   ⚠️  Replacement "${trimmed}" is also invalid — skipping`);
      }
    }
  }

  return validIds;
}

// ────────────────────────── Vault Selection ──────────────────────────

/**
 * Interactive sub-flow: list available vaults (up to 20) via `beta.vaults.list`
 * and let the user pick from them, paste comma-separated IDs, or skip entirely.
 *
 * Behaviour:
 *  - If `beta.vaults.list` is not available or throws → skip silently (return [])
 *  - If 0 vaults returned → skip silently (nothing to select)
 *  - If vaults are available → display numbered list; prompt for input:
 *      • Numbers (1-based) → resolved to vault IDs from the displayed list
 *      • Raw vault IDs (any token not a valid index) → used as-is (paste IDs directly)
 *      • Empty / Enter → skip (empty list is valid)
 *
 * Called only from the interactive `initSlack` path when no `CLAUDE_VAULT_IDS` is
 * already configured — see Step 0d.
 */
async function selectVaultsInteractive(client: AgentClient): Promise<string[]> {
  let vaults: Array<{ id: string; name: string }> = [];
  try {
    console.log('⏳ Loading available vaults...');
    vaults = await client.listVaults({ limit: 20 });
  } catch (_err) {
    // beta.vaults.list not available or API error — skip vault step silently
    return [];
  }

  if (vaults.length === 0) {
    // No vaults configured in the account — nothing to select, skip silently
    return [];
  }

  // Display numbered list (up to 20, limited by the API call above)
  console.log('\n🔐 Available vaults:\n');
  vaults.forEach((v, i) => {
    console.log(`   ${i + 1}. ${v.name} (${v.id})`);
  });
  console.log('');

  const rawInput = await input({
    message: 'Select vaults by number or ID (comma-separated, Enter to skip):',
    default: '',
  });

  const trimmed = rawInput.trim();
  if (!trimmed) return [];

  // Parse each token: a valid 1-based index → resolve to vault ID; otherwise treat as raw ID
  const selectedIds: string[] = [];
  for (const token of trimmed.split(',').map((t) => t.trim()).filter(Boolean)) {
    const num = parseInt(token, 10);
    if (!isNaN(num) && num >= 1 && num <= vaults.length) {
      selectedIds.push(vaults[num - 1].id);
    } else {
      selectedIds.push(token);
    }
  }

  if (selectedIds.length > 0) {
    console.log(`✅ Selected ${selectedIds.length} vault(s): ${selectedIds.join(', ')}\n`);
  }

  return selectedIds;
}

/**
 * Interactive prompt flow for `ach init slack`.
 *
 * Guides the user through:
 * 1. Naming their Slack app
 * 2. Choosing setup method (automatic, guided, or manual)
 * 3. Collecting credentials (bot token, app token, signing secret)
 * 4. Writing credentials to .env
 */
export async function initSlack(options: SlackInitOptions = {}): Promise<SlackInitResult> {
  const cwd = options.cwd ?? process.cwd();

  // Non-interactive mode: infer path from provided credentials, skip all prompts
  if (options.nonInteractive) {
    return initSlackNonInteractive({ ...options, cwd });
  }

  console.log('\n🔧 Agent Channels — Slack Setup\n');
  console.log('This wizard will help you configure a Slack bot for use with Claude Managed Agents.\n');

  // Step 0: Validate Anthropic API key (re-prompts on failure, never hard-exits)
  const apiKeyOverrides: ConfigOverrides = { anthropicApiKey: options.anthropicApiKey };
  const partialConfig = resolvePartialConfig({ overrides: apiKeyOverrides, cwd });
  const anthropicApiKey = await collectAndValidateApiKey({
    existingKey: partialConfig.anthropicApiKey,
  });

  // Step 0b: Detect/validate/keep-or-change for existing CLAUDE_AGENT_ID.
  // Skipped when no agent ID is configured — avoids adding agent prompts to
  // setups that haven't set CLAUDE_AGENT_ID yet.
  const agentConfig = resolvePartialConfig({ overrides: { agentId: options.claudeAgentId }, cwd });
  const existingAgentId = agentConfig.agentId;
  let resolvedAgentId: string | undefined;
  if (existingAgentId) {
    const agentClient = new AgentClient({ apiKey: anthropicApiKey });
    resolvedAgentId = await collectAndSelectAgent(agentClient, existingAgentId);
  }

  // Step 0c: Detect/validate/keep-or-change/warn-on-stale for existing CLAUDE_ENVIRONMENT_ID
  const envConfig = resolvePartialConfig({ overrides: { environmentId: options.claudeEnvironmentId }, cwd });
  const existingEnvironmentId = envConfig.environmentId;
  let resolvedEnvironmentId: string | undefined;
  if (existingEnvironmentId) {
    const envClient = new AgentClient({ apiKey: anthropicApiKey });
    resolvedEnvironmentId = await collectAndSelectEnvironment(envClient, existingEnvironmentId);
  }

  // Step 0d: Vault selection / validation
  // - CLAUDE_VAULT_IDS configured → validate each ID per AC 7 (warn+drop invalid, re-prompt for slots)
  // - Not configured → offer interactive selection from beta.vaults.list (AC 10); user can skip
  const vaultConfig = resolvePartialConfig({ overrides: { vaultIds: options.claudeVaultIds }, cwd });
  const existingVaultIds = parseVaultIds(vaultConfig.vaultIds);
  let validatedVaultIds: string[];
  if (existingVaultIds.length > 0) {
    // Existing IDs configured — validate them (AC 7)
    validatedVaultIds = await collectAndValidateVaultIds({
      existingIds: existingVaultIds,
      anthropicApiKey,
      nonInteractive: false,
    });
  } else {
    // No IDs configured — offer selection from vault list (AC 10)
    const vaultClient = new AgentClient({ apiKey: anthropicApiKey });
    validatedVaultIds = await selectVaultsInteractive(vaultClient);
  }

  // Step 1: App configuration preferences
  const appName = await input({
    message: 'What should your Slack bot be called?',
    default: 'General Agent',
    validate: (value) => {
      if (!value.trim()) return 'App name cannot be empty';
      if (value.length > 35) return 'App name must be 35 characters or less';
      return true;
    },
  });

  const appDescription = await input({
    message: 'Short description for the app:',
    default: 'AI agent for your team — powered by agentchannels',
    validate: (value) => {
      if (value.length > 140) return 'Description must be 140 characters or less';
      return true;
    },
  });

  // Step 2: Setup method
  const setupMethod = await select<SetupMethod>({
    message: 'How would you like to set up the Slack app?',
    choices: [
      {
        name: 'Automatic — Create the app via Slack API (requires a Refresh Token)',
        value: 'automatic',
      },
      {
        name: 'Guided — I\'ll create the app on api.slack.com and paste tokens here',
        value: 'guided',
      },
      {
        name: 'Manual — I already have bot token, app token, and signing secret',
        value: 'manual',
      },
    ],
  });

  let botToken: string;
  let appToken: string;
  let signingSecret: string;

  let newRefreshToken: string | undefined;
  let appId: string | undefined;

  if (setupMethod === 'automatic') {
    const credentials = await automaticSetup(appName, appDescription);
    appId = credentials.appId;
    botToken = credentials.botToken;
    appToken = credentials.appToken;
    signingSecret = credentials.signingSecret;
    newRefreshToken = credentials.newRefreshToken;
  } else {
    if (setupMethod === 'guided') {
      console.log('\n📋 Follow these steps to create your Slack app:\n');

      // Generate and display manifest
      const manifest = buildSlackManifest({
        appName,
        appDescription,
        socketMode: true,
      });

      console.log('1. Go to https://api.slack.com/apps');
      console.log('2. Click "Create New App" → "From a manifest"');
      console.log('3. Select your workspace');
      console.log('4. Paste this manifest (JSON):\n');
      console.log('─'.repeat(60));
      console.log(JSON.stringify(manifest, null, 2));
      console.log('─'.repeat(60));
      console.log('\n5. Click "Create"');
      console.log('6. Go to "Basic Information" → copy the Signing Secret');
      console.log('7. Go to "OAuth & Permissions" → "Install to Workspace" → copy Bot Token');
      console.log('8. Go to "Basic Information" → "App-Level Tokens" → create a token');
      console.log('   with scope "connections:write" → copy the token\n');

      await confirm({
        message: 'Ready to enter your credentials?',
        default: true,
      });
    }

    // Collect credentials manually for both guided and manual flows
    // Resolve existing values from CLI flags > env vars > .env file
    const existing = resolvePartialConfig({ cwd });

    botToken = await input({
      message: 'Slack Bot Token (xoxb-...):',
      default: existing.slackBotToken || undefined,
      validate: (value) => {
        if (!value.startsWith('xoxb-')) return 'Bot token must start with xoxb-';
        if (value.length < 20) return 'Token appears too short';
        return true;
      },
    });

    if (setupMethod === 'manual') {
      console.log('\n💡 Before continuing, make sure your Slack app has:');
      console.log('   1. Socket Mode enabled: Settings → Socket Mode → Enable Socket Mode');
      console.log('   2. App-Level Token with "connections:write" scope:');
      console.log('      Basic Information → App-Level Tokens → Generate Token and Scopes\n');
    }

    appToken = await input({
      message: 'Slack App-Level Token (xapp-...):',
      default: existing.slackAppToken || undefined,
      validate: (value) => {
        if (!value.startsWith('xapp-')) return 'App token must start with xapp-';
        if (value.length < 20) return 'Token appears too short';
        return true;
      },
    });

    signingSecret = await input({
      message: 'Slack Signing Secret:',
      default: existing.slackSigningSecret || undefined,
      validate: (value) => {
        if (!value.trim()) return 'Signing secret is required';
        if (value.length < 10) return 'Signing secret appears too short';
        return true;
      },
    });
  }

  // Step 4: Write to .env
  let envWritten = false;

  if (!options.skipEnvWrite) {
    const shouldWrite = await confirm({
      message: 'Save these credentials to .env file?',
      default: true,
    });

    if (shouldWrite) {
      const envVars: Record<string, string> = {
        SLACK_BOT_TOKEN: botToken,
        SLACK_APP_TOKEN: appToken,
        SLACK_SIGNING_SECRET: signingSecret,
      };
      if (newRefreshToken) {
        envVars.SLACK_REFRESH_TOKEN = newRefreshToken;
      }
      // Write API key only if not already present in .env
      const existingEnv = readEnvFile(cwd);
      if (!existingEnv.ANTHROPIC_API_KEY) {
        envVars.ANTHROPIC_API_KEY = anthropicApiKey;
      }
      // Write CLAUDE_AGENT_ID if resolved during the wizard
      if (resolvedAgentId) {
        envVars.CLAUDE_AGENT_ID = resolvedAgentId;
      }
      // Write CLAUDE_ENVIRONMENT_ID if resolved during the wizard
      if (resolvedEnvironmentId) {
        envVars.CLAUDE_ENVIRONMENT_ID = resolvedEnvironmentId;
      }
      // Write CLAUDE_VAULT_IDS with only the validated IDs (replaces any stale value)
      if (validatedVaultIds.length > 0) {
        envVars.CLAUDE_VAULT_IDS = validatedVaultIds.join(',');
      }
      writeEnvFile(envVars, cwd);
      envWritten = true;
      console.log('\n✅ Slack credentials saved to .env');
    } else {
      console.log('\n⚠️  Credentials not saved. You can set them as environment variables:');
      console.log(`   SLACK_BOT_TOKEN=${botToken}`);
      console.log(`   SLACK_APP_TOKEN=${appToken}`);
      console.log(`   SLACK_SIGNING_SECRET=${signingSecret}`);
    }
  }

  console.log('\n✅ Slack setup complete!');
  if (appId) {
    console.log(`\n💡 Want a custom logo? Upload one at:`);
    console.log(`   https://api.slack.com/apps/${appId}/general#edit`);
  } else {
    console.log(`\n💡 Want a custom logo? Upload one at:`);
    console.log(`   https://api.slack.com/apps → select your app → Basic Information`);
  }
  console.log('\n   Next step: run `ach serve` to start the bridge (agent and environment are already configured).\n');

  return {
    appName,
    appDescription,
    botToken,
    appToken,
    signingSecret,
    envWritten,
    anthropicApiKey,
    agentId: resolvedAgentId,
    environmentId: resolvedEnvironmentId,
    vaultIds: validatedVaultIds,
  };
}

// ────────────────────────── Non-Interactive Setup ──────────────────────────

/**
 * Non-interactive Slack init.  Infers which path to take from the supplied
 * credentials — no prompts are shown.
 *
 * Path selection (in priority order):
 *  1. Auto path    — SLACK_REFRESH_TOKEN present → token rotation + app
 *                    creation via Slack API (takes priority over manual tokens)
 *  2. Manual path  — SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_SIGNING_SECRET
 *                    all present → validate and write directly to .env
 *
 * When both SLACK_REFRESH_TOKEN and the full set of manual tokens are provided,
 * the auto path wins: a new Slack app is created via the API using the refresh
 * token, and the manual tokens are ignored.
 *
 * Credentials are resolved with three-source precedence:
 *   CLI flags (options.*) > process.env > .env file
 *
 * @throws {Error} if insufficient credentials are provided for either path
 */
export async function initSlackNonInteractive(
  options: SlackInitOptions & { cwd: string },
): Promise<SlackInitResult> {
  const { cwd, skipEnvWrite } = options;

  // Step 0: Resolve and validate Anthropic API key (non-interactive: throws on failure)
  const apiKeyPartial = resolvePartialConfig({
    overrides: { anthropicApiKey: options.anthropicApiKey },
    cwd,
  });
  const rawApiKey = apiKeyPartial.anthropicApiKey;
  if (!rawApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required. Set it via env var, .env file, or --anthropic-api-key flag.',
    );
  }
  console.log('🔑 Validating Anthropic API key...');
  const apiKeyClient = new AgentClient({ apiKey: rawApiKey });
  await apiKeyClient.validateAuth();
  console.log('✅ API key validated.');
  const anthropicApiKey = rawApiKey;

  // Detect and validate existing CLAUDE_AGENT_ID (throws if stale; skips if absent).
  // Non-interactive: no UI to re-select — stale ID is a hard error.
  const agentNIConfig = resolvePartialConfig({ overrides: { agentId: options.claudeAgentId }, cwd });
  const existingAgentIdNI = agentNIConfig.agentId;
  let resolvedAgentId: string | undefined;
  if (existingAgentIdNI) {
    console.log(`\n🤖 Validating CLAUDE_AGENT_ID: ${existingAgentIdNI}...`);
    try {
      const agentNIClient = new AgentClient({ apiKey: anthropicApiKey });
      const validated = await validateAgent(agentNIClient, existingAgentIdNI);
      resolvedAgentId = validated.id;
      console.log(`   ✅ CLAUDE_AGENT_ID validated: "${validated.name}" (${validated.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `⚠️  CLAUDE_AGENT_ID "${existingAgentIdNI}" not found via Anthropic API (stale or invalid).\n` +
          `${msg}\n` +
          `Remove it from .env or provide a valid agent ID via CLAUDE_AGENT_ID env var.`,
      );
    }
  }

  // Detect and validate existing CLAUDE_ENVIRONMENT_ID (throws if stale; skips if absent)
  const envNIConfig = resolvePartialConfig({ overrides: { environmentId: options.claudeEnvironmentId }, cwd });
  const existingEnvId = envNIConfig.environmentId;
  let resolvedEnvironmentId: string | undefined;
  if (existingEnvId) {
    console.log(`🔍 Validating CLAUDE_ENVIRONMENT_ID: ${existingEnvId}...`);
    try {
      const envNIClient = new AgentClient({ apiKey: anthropicApiKey });
      const validated = await validateEnvironment(envNIClient, existingEnvId);
      resolvedEnvironmentId = validated.id;
      console.log(`✅ CLAUDE_ENVIRONMENT_ID validated: "${validated.name}" (${validated.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `⚠️  CLAUDE_ENVIRONMENT_ID "${existingEnvId}" not found via Anthropic API (stale).\n` +
          `${msg}\n` +
          `Remove it from .env or set a valid environment ID via CLAUDE_ENVIRONMENT_ID.`,
      );
    }
  }

  // Validate existing CLAUDE_VAULT_IDS — warn+drop invalid IDs (no re-prompt in non-interactive)
  const vaultNIConfig = resolvePartialConfig({ overrides: { vaultIds: options.claudeVaultIds }, cwd });
  const existingVaultIds = parseVaultIds(vaultNIConfig.vaultIds);
  const validatedVaultIds = await collectAndValidateVaultIds({
    existingIds: existingVaultIds,
    anthropicApiKey,
    nonInteractive: true,
  });

  // Resolve three-source config for standard Slack tokens
  const overrides: ConfigOverrides = {
    slackBotToken: options.slackBotToken,
    slackAppToken: options.slackAppToken,
    slackSigningSecret: options.slackSigningSecret,
  };
  const config = resolvePartialConfig({ overrides, cwd });

  const botToken = config.slackBotToken;
  const appToken = config.slackAppToken;
  const signingSecret = config.slackSigningSecret;

  // SLACK_REFRESH_TOKEN is not in the standard config map — read directly
  const refreshToken =
    options.slackRefreshToken ??
    process.env.SLACK_REFRESH_TOKEN ??
    undefined;

  // ── Auto path takes priority: explicit refresh token → create new app ────
  // Checked first so that providing SLACK_REFRESH_TOKEN always triggers app
  // creation via the Slack API, even if manual tokens are also set in env.
  if (refreshToken) {
    const appName = options.appName ?? 'General Agent';
    const appDescription =
      options.appDescription ?? 'AI agent for your team — powered by agentchannels';

    console.log('\n🔧 Agent Channels — Slack Setup (non-interactive / automatic)\n');

    const credentials = await automaticSetupNonInteractive(appName, appDescription, refreshToken);

    let envWritten = false;
    if (!skipEnvWrite) {
      const envVarsAuto: Record<string, string> = {
        SLACK_BOT_TOKEN: credentials.botToken,
        SLACK_APP_TOKEN: credentials.appToken,
        SLACK_SIGNING_SECRET: credentials.signingSecret,
        SLACK_REFRESH_TOKEN: credentials.newRefreshToken,
      };
      // Write API key only if not already present in .env
      const existingEnvAuto = readEnvFile(cwd);
      if (!existingEnvAuto.ANTHROPIC_API_KEY) {
        envVarsAuto.ANTHROPIC_API_KEY = anthropicApiKey;
      }
      // Write CLAUDE_AGENT_ID if validated
      if (resolvedAgentId) {
        envVarsAuto.CLAUDE_AGENT_ID = resolvedAgentId;
      }
      // Write CLAUDE_ENVIRONMENT_ID if validated
      if (resolvedEnvironmentId) {
        envVarsAuto.CLAUDE_ENVIRONMENT_ID = resolvedEnvironmentId;
      }
      // Write CLAUDE_VAULT_IDS with only the validated IDs (replaces any stale value)
      if (validatedVaultIds.length > 0) {
        envVarsAuto.CLAUDE_VAULT_IDS = validatedVaultIds.join(',');
      }
      writeEnvFile(envVarsAuto, cwd);
      envWritten = true;
      console.log('\n✅ Slack credentials saved to .env');
    }

    console.log('\n✅ Slack setup complete!');
    console.log(`\n💡 Want a custom logo? Upload one at:`);
    console.log(`   https://api.slack.com/apps/${credentials.appId}/general#edit`);
    console.log('\n   Next step: run `ach serve` to start the bot.\n');

    return {
      appName,
      appDescription,
      botToken: credentials.botToken,
      appToken: credentials.appToken,
      signingSecret: credentials.signingSecret,
      envWritten,
      anthropicApiKey,
      agentId: resolvedAgentId,
      environmentId: resolvedEnvironmentId,
      vaultIds: validatedVaultIds,
    };
  }

  // ── Manual path: all three tokens provided directly ───────────────────
  if (botToken && appToken && signingSecret) {
    return initSlackManual({
      botToken,
      appToken,
      signingSecret,
      cwd,
      skipEnvWrite,
      anthropicApiKey,
      agentId: resolvedAgentId,
      environmentId: resolvedEnvironmentId,
      vaultIds: validatedVaultIds,
    });
  }

  // ── Partial manual path: some tokens provided but not all ─────────────
  // Give a specific error naming each missing field (AC 14: clear error naming missing field)
  if (botToken || appToken || signingSecret) {
    const missing: string[] = [];
    if (!botToken) missing.push('SLACK_BOT_TOKEN');
    if (!appToken) missing.push('SLACK_APP_TOKEN');
    if (!signingSecret) missing.push('SLACK_SIGNING_SECRET');
    throw new Error(
      `Non-interactive mode is missing required ${missing.length > 1 ? 'fields' : 'field'}: ${missing.join(', ')}.\n` +
        'Set these as environment variables, CLI flags, or in a .env file.',
    );
  }

  // ── Neither path has enough credentials ────────────────────────────────
  throw new Error(
    'Non-interactive mode requires credentials for one of these paths:\n' +
      '  Manual path: SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_SIGNING_SECRET\n' +
      '  Auto path:   SLACK_REFRESH_TOKEN\n' +
      'Set these as environment variables, CLI flags, or in a .env file.',
  );
}

/**
 * Execute the manual path: validate provided tokens and write them to .env.
 * No prompts — all credentials must already be resolved.
 */
async function initSlackManual(options: {
  botToken: string;
  appToken: string;
  signingSecret: string;
  cwd: string;
  skipEnvWrite?: boolean;
  anthropicApiKey: string;
  /** Validated CLAUDE_AGENT_ID to write alongside Slack credentials */
  agentId?: string;
  /** Validated CLAUDE_ENVIRONMENT_ID to write alongside Slack credentials */
  environmentId?: string;
  /** Validated vault IDs to write as CLAUDE_VAULT_IDS */
  vaultIds?: string[];
}): Promise<SlackInitResult> {
  const { botToken, appToken, signingSecret, cwd, skipEnvWrite, anthropicApiKey } = options;
  const vaultIds = options.vaultIds ?? [];

  // Validate token formats
  if (!botToken.startsWith('xoxb-')) {
    throw new Error(
      'SLACK_BOT_TOKEN must start with "xoxb-". Got: ' + botToken.slice(0, 10) + '...',
    );
  }
  if (botToken.length < 20) {
    throw new Error('SLACK_BOT_TOKEN appears too short (minimum 20 characters)');
  }
  if (!appToken.startsWith('xapp-')) {
    throw new Error(
      'SLACK_APP_TOKEN must start with "xapp-". Got: ' + appToken.slice(0, 10) + '...',
    );
  }
  if (appToken.length < 20) {
    throw new Error('SLACK_APP_TOKEN appears too short (minimum 20 characters)');
  }
  if (!signingSecret.trim()) {
    throw new Error('SLACK_SIGNING_SECRET is required');
  }
  if (signingSecret.length < 10) {
    throw new Error('SLACK_SIGNING_SECRET appears too short (minimum 10 characters)');
  }

  console.log('\n🔧 Agent Channels — Slack Setup (non-interactive / manual)\n');
  console.log('All three credentials provided — writing directly to .env\n');

  let envWritten = false;
  if (!skipEnvWrite) {
    const envVarsManual: Record<string, string> = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
      SLACK_SIGNING_SECRET: signingSecret,
    };
    // Write API key only if not already present in .env
    const existingEnvManual = readEnvFile(cwd);
    if (!existingEnvManual.ANTHROPIC_API_KEY) {
      envVarsManual.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    // Write CLAUDE_AGENT_ID if validated
    if (options.agentId) {
      envVarsManual.CLAUDE_AGENT_ID = options.agentId;
    }
    // Write CLAUDE_ENVIRONMENT_ID if validated
    if (options.environmentId) {
      envVarsManual.CLAUDE_ENVIRONMENT_ID = options.environmentId;
    }
    // Write CLAUDE_VAULT_IDS if any passed validation
    if (vaultIds.length > 0) {
      envVarsManual.CLAUDE_VAULT_IDS = vaultIds.join(',');
    }
    writeEnvFile(envVarsManual, cwd);
    envWritten = true;
    console.log('✅ Slack credentials saved to .env');
  }

  console.log('\n✅ Slack setup complete!');
  console.log('\n   Next step: run `ach serve` to start the bot.\n');

  return {
    appName: '',
    appDescription: '',
    botToken,
    appToken,
    signingSecret,
    envWritten,
    anthropicApiKey,
    agentId: options.agentId,
    environmentId: options.environmentId,
    vaultIds,
  };
}

// ────────────────────────── Non-Interactive Automatic Setup ──────────────────────────

/**
 * Non-interactive automatic setup: takes the refresh token as a parameter
 * (no prompt), drives the full token-rotation → app-creation → OAuth-install
 * → app-level-token flow without any user interaction.
 *
 * Blocks up to 5 minutes waiting for the browser-based OAuth callback
 * (the timeout is enforced by `runOAuthInstall` in oauth.ts).
 *
 * Unlike the interactive `automaticSetup`, this function:
 *  - Receives the refresh token directly (not via a password prompt)
 *  - Does NOT retry on error — throws immediately so callers can handle it
 *  - Generates the app-level token via the Slack API (`apps.token.create`)
 *    instead of asking the user to create one manually in the Slack UI
 *
 * @throws {SlackApiRequestError} on any Slack API failure
 * @throws {Error} if the OAuth callback times out (> 5 minutes)
 */
export async function automaticSetupNonInteractive(
  appName: string,
  appDescription: string,
  refreshToken: string,
): Promise<AutomaticSetupCredentials> {
  console.log('\n🤖 Automatic Setup via Slack API\n');

  // Step 0: Rotate the refresh token → short-lived access token
  console.log('⏳ Rotating refresh token...');
  const rotationResult = await SlackApiClient.rotateConfigToken(refreshToken);
  console.log(
    `   ✅ Token rotated${rotationResult.team?.name ? ` (workspace: ${rotationResult.team.name})` : ''}`,
  );
  console.log('   ⚠️  Your old refresh token is now invalidated.');
  console.log(`   📝 New refresh token: ${rotationResult.refresh_token.slice(0, 20)}...`);

  const client = new SlackApiClient({ accessToken: rotationResult.token });

  // Step 1: Create app from manifest → signing secret
  console.log('\n⏳ Creating Slack app from manifest...');
  const manifest = buildSlackManifest({ appName, appDescription, socketMode: true });
  const createResult = await client.createAppFromManifest(manifest);
  const appId = createResult.app_id;
  const signingSecret = createResult.credentials.signing_secret;
  console.log(`   ✅ App created: ${appId}`);

  // Step 2: Install app to workspace via OAuth (local server + browser open)
  const scopes = [
    'app_mentions:read', 'channels:history', 'channels:read', 'chat:write',
    'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
    'mpim:history', 'mpim:read', 'users:read',
  ];

  console.log('⏳ Updating manifest with OAuth redirect URL...');
  const port = 3333;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  await addRedirectUrl(rotationResult.token, appId, redirectUri);

  console.log('⏳ Installing app to workspace via OAuth...');
  console.log('   A browser window will open for authorization.');
  console.log('   Waiting up to 5 minutes for browser callback...');

  const installResult = await runOAuthInstall({
    appId,
    clientId: createResult.credentials.client_id,
    clientSecret: createResult.credentials.client_secret,
    scopes,
    port,
  });

  const botToken = installResult.botToken;
  console.log(`   ✅ App installed to workspace: ${installResult.teamName}`);

  // Step 3: Generate app-level token via API (no manual step — uses apps.token.create)
  console.log('\n⏳ Generating app-level token...');
  const appTokenResult = await client.generateAppLevelToken(appId);
  const appToken = appTokenResult.token;
  console.log('   ✅ App-level token generated');

  console.log(`\n🎉 Slack app "${appName}" created and configured successfully!\n`);

  return {
    appId,
    botToken,
    appToken,
    signingSecret,
    newRefreshToken: rotationResult.refresh_token,
  };
}

// ────────────────────────── Automatic Setup ──────────────────────────

/**
 * Credentials returned by the automatic setup flow.
 */
interface AutomaticSetupCredentials {
  appId: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
  /** New refresh token from token rotation (old one is invalidated) */
  newRefreshToken: string;
}

/**
 * Automatic setup flow that uses the Slack Manifest API to create an app,
 * install it to the workspace, and generate all required tokens.
 *
 * Requires a Slack Refresh Token which can be generated at:
 * https://api.slack.com/apps → Your Apps → Refresh tokens
 *
 * Steps:
 * 1. Prompt for the refresh token
 * 2. Create the app from a manifest (→ signing secret)
 * 3. Install the app to the workspace (→ bot token)
 * 4. Generate an app-level token (→ app token for Socket Mode)
 *
 * @throws {SlackApiRequestError} if any Slack API call fails
 */
export async function automaticSetup(
  appName: string,
  appDescription: string,
): Promise<AutomaticSetupCredentials> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await _automaticSetupAttempt(appName, appDescription);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Slack setup failed: ${message}\n`);

      const retry = await confirm({
        message: 'Would you like to retry?',
        default: true,
      });

      if (!retry) {
        throw error;
      }
      console.log(''); // blank line before retry
    }
  }
}

async function _automaticSetupAttempt(
  appName: string,
  appDescription: string,
): Promise<AutomaticSetupCredentials> {
  console.log('\n🤖 Automatic Setup via Slack API\n');
  console.log('This method uses a Slack Refresh Token to create your app automatically.');
  console.log('You can generate a Refresh Token at:');
  console.log('  https://api.slack.com/apps → Your Apps → Refresh tokens\n');

  const refreshToken = await password({
    message: 'Slack Refresh Token (xoxe-...):',
    validate: (value) => {
      if (!value.trim()) return 'Refresh token is required';
      if (!value.startsWith('xoxe-')) return 'Refresh token must start with xoxe-';
      if (value.length < 20) return 'Token appears too short';
      return true;
    },
  });

  // Step 0: Exchange refresh token for access token
  console.log('\n⏳ Rotating refresh token...');
  const rotationResult = await SlackApiClient.rotateConfigToken(refreshToken);
  console.log(`   ✅ Token rotated${rotationResult.team?.name ? ` (workspace: ${rotationResult.team.name})` : ''}`);
  console.log('   ⚠️  Your old refresh token is now invalidated.');
  console.log(`   📝 New refresh token: ${rotationResult.refresh_token.slice(0, 20)}...`);

  const client = new SlackApiClient({ accessToken: rotationResult.token });

  // Step 1: Create app from manifest
  console.log('\n⏳ Creating Slack app from manifest...');
  const manifest = buildSlackManifest({
    appName,
    appDescription,
    socketMode: true,
  });

  const createResult = await client.createAppFromManifest(manifest);
  const appId = createResult.app_id;
  const signingSecret = createResult.credentials.signing_secret;
  console.log(`   ✅ App created: ${appId}`);

  // Step 2: Install app via OAuth flow (automated)
  const scopes = [
    'app_mentions:read', 'channels:history', 'channels:read', 'chat:write',
    'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
    'mpim:history', 'mpim:read', 'users:read',
  ];

  console.log('⏳ Updating manifest with OAuth redirect URL...');
  const port = 3333;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  await addRedirectUrl(rotationResult.token, appId, redirectUri);

  console.log('⏳ Installing app to workspace via OAuth...');
  console.log('   A browser window will open for authorization.');

  const installResult = await runOAuthInstall({
    appId,
    clientId: createResult.credentials.client_id,
    clientSecret: createResult.credentials.client_secret,
    scopes,
    port,
  });

  const botToken = installResult.botToken;
  console.log(`   ✅ App installed to workspace: ${installResult.teamName}`);

  // Step 3: App-level token (must be created manually in Slack UI)
  console.log('\n📋 One last step — create an App-Level Token:\n');
  console.log(`   1. Go to https://api.slack.com/apps/${appId}/general`);
  console.log('   2. Under "App-Level Tokens", click "Generate Token and Scopes"');
  console.log('   3. Name it (e.g. "socket"), add scope "connections:write", click "Generate"');
  console.log('   4. Copy the token (starts with xapp-)\n');

  const appToken = await input({
    message: 'Paste your App-Level Token (xapp-...):',
    validate: (value) => {
      if (!value.startsWith('xapp-')) return 'App-level token must start with xapp-';
      if (value.length < 20) return 'Token appears too short';
      return true;
    },
  });

  console.log(`\n🎉 Slack app "${appName}" created and configured successfully!\n`);

  return {
    appId,
    botToken,
    appToken,
    signingSecret,
    newRefreshToken: rotationResult.refresh_token,
  };
}
