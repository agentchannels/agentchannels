/**
 * AC 13: ach init slack --non-interactive with CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID,
 * and optionally CLAUDE_VAULT_IDS set in env or flags validates silently and skips all prompts.
 *
 * This test exercises the full combined non-interactive path:
 *   ANTHROPIC_API_KEY → CLAUDE_AGENT_ID → CLAUDE_ENVIRONMENT_ID → CLAUDE_VAULT_IDS → Slack
 *
 * Key assertions:
 *   1. All three resource IDs validate silently via beta API (no prompts)
 *   2. IDs supplied via options (simulating CLI flags) take precedence over env vars
 *   3. CLAUDE_VAULT_IDS is optional — omitting it skips vault validation entirely
 *   4. Stale CLAUDE_AGENT_ID throws before environment/vault/Slack validation (fail fast)
 *   5. Stale CLAUDE_ENVIRONMENT_ID throws before vault/Slack validation (fail fast)
 *   6. All validated IDs are written to .env in a single pass
 *   7. No interactive prompts are invoked at any point
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive } from '../../../src/channels/slack/init.js';

// ────────────────────────── SDK Mock ──────────────────────────
// Covers agents, environments, and vaults — the three resources validated in AC 13.

const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockEnvironmentsRetrieve = vi.fn();
const mockVaultsRetrieve = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      agents: {
        list: mockAgentsList,
        retrieve: mockAgentsRetrieve,
        create: vi.fn(),
      },
      environments: {
        retrieve: mockEnvironmentsRetrieve,
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn(),
      },
      vaults: {
        retrieve: mockVaultsRetrieve,
      },
    };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

// ────────────────────────── Other Mocks ──────────────────────────

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
}));

vi.mock('../../../src/channels/slack/oauth.js', () => ({
  addRedirectUrl: vi.fn(),
  runOAuthInstall: vi.fn(),
}));

vi.mock('../../../src/channels/slack/api.js', () => ({
  SlackApiClient: vi.fn(),
  SlackApiRequestError: class SlackApiRequestError extends Error {},
}));

// ────────────────────────── Fixtures ──────────────────────────

const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';
const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';

const VALID_AGENT_ID = 'agent_abc123def456';
const VALID_AGENT_NAME = 'my-test-agent';

const VALID_ENV_ID = 'env_abc123def456';
const VALID_ENV_NAME = 'my-test-environment';

const VAULT_A = 'vlt_aaaaaaaaaaaaaaaa';
const VAULT_B = 'vlt_bbbbbbbbbbbbbbbb';

const STALE_AGENT_ID = 'agent_stale_gone_999';
const STALE_ENV_ID = 'env_stale_gone_999';

// ────────────────────────── Helpers ──────────────────────────

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-ni-full-test-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function readEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return result;
}

/** Clear all relevant env vars so host environment cannot contaminate tests. */
function isolateEnv(): () => void {
  const keys = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID', 'CLAUDE_VAULT_IDS',
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_REFRESH_TOKEN',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Suite 1: All three IDs provided via options (simulating CLI flags)
// ────────────────────────────────────────────────────────────────────────────

describe('initSlackNonInteractive — CLAUDE_AGENT_ID + CLAUDE_ENVIRONMENT_ID + CLAUDE_VAULT_IDS via options', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // validateAuth succeeds by default (agents.list with limit:1)
    mockAgentsList.mockResolvedValue({ data: [] });
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('validates agent, environment, and vault IDs silently without any prompts', async () => {
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(password)).not.toHaveBeenCalled();
  });

  it('calls beta.agents.retrieve once with the provided agent ID', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('calls beta.environments.retrieve once with the provided environment ID', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
  });

  it('calls beta.vaults.retrieve once per vault ID', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockVaultsRetrieve).toHaveBeenCalledTimes(2);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_A);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_B);
  });

  it('returns all three validated IDs in the result', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([VAULT_A, VAULT_B]);
  });

  it('writes all three IDs to .env in a single pass', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
    expect(env.CLAUDE_VAULT_IDS).toBe(`${VAULT_A},${VAULT_B}`);
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
    expect(env.SLACK_APP_TOKEN).toBe(VALID_APP_TOKEN);
    expect(env.SLACK_SIGNING_SECRET).toBe(VALID_SIGNING_SECRET);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 2: All three IDs supplied via environment variables
// ────────────────────────────────────────────────────────────────────────────

describe('initSlackNonInteractive — all three IDs via environment variables', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('validates all three IDs from env vars without prompts', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    process.env.CLAUDE_ENVIRONMENT_ID = VALID_ENV_ID;
    process.env.CLAUDE_VAULT_IDS = VAULT_A;
    process.env.SLACK_BOT_TOKEN = VALID_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = VALID_APP_TOKEN;
    process.env.SLACK_SIGNING_SECRET = VALID_SIGNING_SECRET;

    const { input, confirm, select, password } = await import('@inquirer/prompts');

    const result = await initSlackNonInteractive({ cwd: tmpDir });

    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([VAULT_A]);

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(password)).not.toHaveBeenCalled();
  });

  it('calls the correct API endpoints for each env-var ID', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    process.env.CLAUDE_ENVIRONMENT_ID = VALID_ENV_ID;
    process.env.CLAUDE_VAULT_IDS = VAULT_A;
    process.env.SLACK_BOT_TOKEN = VALID_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = VALID_APP_TOKEN;
    process.env.SLACK_SIGNING_SECRET = VALID_SIGNING_SECRET;

    await initSlackNonInteractive({ cwd: tmpDir });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_A);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 3: CLAUDE_VAULT_IDS is optional
// ────────────────────────────────────────────────────────────────────────────

describe('initSlackNonInteractive — CLAUDE_VAULT_IDS is optional', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('succeeds with agent + environment but no vault IDs', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      // claudeVaultIds not provided
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([]);
  });

  it('skips vault API call when CLAUDE_VAULT_IDS is not set', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockVaultsRetrieve).not.toHaveBeenCalled();
  });

  it('does not write CLAUDE_VAULT_IDS to .env when not provided', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
    // But agent and environment should be written
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
  });

  it('no prompts are shown even when vault step is skipped', async () => {
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(password)).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 4: Fail-fast on stale IDs — validation order is agent → environment → vault → Slack
// ────────────────────────────────────────────────────────────────────────────

describe('initSlackNonInteractive — fail-fast on stale IDs', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('throws on stale CLAUDE_AGENT_ID before checking environment ID', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        claudeEnvironmentId: VALID_ENV_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale|invalid/i);

    // Environment retrieve must NOT have been called — agent check threw first
    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalled();
  });

  it('throws on stale CLAUDE_ENVIRONMENT_ID before checking vault IDs', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: VALID_AGENT_ID,
        claudeEnvironmentId: STALE_ENV_ID,
        claudeVaultIds: VAULT_A,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale/i);

    // Vault retrieve must NOT have been called — environment check threw first
    expect(mockVaultsRetrieve).not.toHaveBeenCalled();
  });

  it('stale agent error message mentions both the ID and CLAUDE_AGENT_ID', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(STALE_AGENT_ID);
  });

  it('stale environment error message mentions both the ID and CLAUDE_ENVIRONMENT_ID', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: VALID_AGENT_ID,
        claudeEnvironmentId: STALE_ENV_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(STALE_ENV_ID);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 5: initSlack with nonInteractive: true (public API passthrough)
// ────────────────────────────────────────────────────────────────────────────

describe('initSlack with nonInteractive: true — combined agent + environment + vault', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('validates all three IDs silently and writes them to .env', async () => {
    const result = await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([VAULT_A]);
    expect(result.envWritten).toBe(true);

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
    expect(env.CLAUDE_VAULT_IDS).toBe(VAULT_A);
  });

  it('invokes no prompts with all three IDs + Slack credentials supplied', async () => {
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(password)).not.toHaveBeenCalled();
  });

  it('succeeds with only agent + environment (no vault IDs)', async () => {
    const result = await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([]);
    expect(mockVaultsRetrieve).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 6: Three-source precedence — options beat env vars beat .env file
// ────────────────────────────────────────────────────────────────────────────

describe('initSlackNonInteractive — three-source precedence for all three IDs', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('option-level IDs override env-var-level IDs for all three resources', async () => {
    const OPTION_AGENT_ID = 'agent_from_option_wins';
    const OPTION_ENV_ID = 'env_from_option_wins';
    const OPTION_VAULT_ID = 'vlt_from_option_wins';

    process.env.CLAUDE_AGENT_ID = 'agent_from_env_should_lose';
    process.env.CLAUDE_ENVIRONMENT_ID = 'env_from_env_should_lose';
    process.env.CLAUDE_VAULT_IDS = 'vlt_from_env_should_lose';

    mockAgentsRetrieve.mockResolvedValue({ id: OPTION_AGENT_ID, name: 'option-agent', version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: OPTION_ENV_ID, name: 'option-env' });
    mockVaultsRetrieve.mockResolvedValue({ id: OPTION_VAULT_ID, name: 'option-vault' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: OPTION_AGENT_ID,
      claudeEnvironmentId: OPTION_ENV_ID,
      claudeVaultIds: OPTION_VAULT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    // Option values must be used — not the env var values
    expect(mockAgentsRetrieve).toHaveBeenCalledWith(OPTION_AGENT_ID);
    expect(mockAgentsRetrieve).not.toHaveBeenCalledWith('agent_from_env_should_lose');

    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(OPTION_ENV_ID);
    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalledWith('env_from_env_should_lose');

    expect(mockVaultsRetrieve).toHaveBeenCalledWith(OPTION_VAULT_ID);
    expect(mockVaultsRetrieve).not.toHaveBeenCalledWith('vlt_from_env_should_lose');

    expect(result.agentId).toBe(OPTION_AGENT_ID);
    expect(result.environmentId).toBe(OPTION_ENV_ID);
    expect(result.vaultIds).toEqual([OPTION_VAULT_ID]);
  });

  it('reads all three IDs from .env file when not provided via options or env vars', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        `ANTHROPIC_API_KEY=${VALID_API_KEY}`,
        `CLAUDE_AGENT_ID=${VALID_AGENT_ID}`,
        `CLAUDE_ENVIRONMENT_ID=${VALID_ENV_ID}`,
        `CLAUDE_VAULT_IDS=${VAULT_A}`,
        `SLACK_BOT_TOKEN=${VALID_BOT_TOKEN}`,
        `SLACK_APP_TOKEN=${VALID_APP_TOKEN}`,
        `SLACK_SIGNING_SECRET=${VALID_SIGNING_SECRET}`,
      ].join('\n') + '\n',
      'utf-8',
    );

    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({ cwd: tmpDir });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_A);

    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([VAULT_A]);
  });
});
