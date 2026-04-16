/**
 * Tests for CLAUDE_ENVIRONMENT_ID detect/validate/keep-or-change/warn-on-stale pattern
 * in the init-slack wizard.
 *
 * AC 6: Existing CLAUDE_ENVIRONMENT_ID follows the same pattern as CLAUDE_AGENT_ID —
 *   1. Detect  — read from options > env var > .env file
 *   2. Validate — call beta.environments.retrieve
 *   3. Keep-or-change — if valid, ask the user (interactive) or keep silently (non-interactive)
 *   4. Warn-on-stale — if not found, warn explicitly; interactive falls through to
 *      select/create, non-interactive throws
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive } from '../../../src/channels/slack/init.js';

// ────────────────────────── SDK Mock ──────────────────────────

const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsCreate = vi.fn();
const mockEnvironmentsRetrieve = vi.fn();
const mockEnvironmentsList = vi.fn();
const mockEnvironmentsCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      agents: {
        list: mockAgentsList,
        retrieve: mockAgentsRetrieve,
        create: mockAgentsCreate,
      },
      environments: {
        retrieve: mockEnvironmentsRetrieve,
        list: mockEnvironmentsList,
        create: mockEnvironmentsCreate,
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

const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';
const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';

const VALID_ENV_ID = 'env_abc123def456';
const VALID_ENV_NAME = 'my-test-environment';

const STALE_ENV_ID = 'env_stale_gone_999';

/** Minimal environment API response shape */
function makeEnvResponse(id: string, name: string) {
  return { id, name, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-init-env-test-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function readEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return result;
}

/**
 * Clear all Anthropic, agent, environment, and Slack env vars to prevent
 * host environment leakage into tests.
 */
function isolateEnv(): () => void {
  const keys = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_AGENT_ID',
    'CLAUDE_ENVIRONMENT_ID',
    'CLAUDE_VAULT_IDS',
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

// ══════════════════════════════════════════════════════════════════════════════
// Non-interactive path
// ══════════════════════════════════════════════════════════════════════════════

describe('initSlackNonInteractive — CLAUDE_ENVIRONMENT_ID: detect + validate', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // API key validation always succeeds
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  // ── skip when absent ──────────────────────────────────────────────────────

  it('skips environment validation when CLAUDE_ENVIRONMENT_ID is absent', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalled();
  });

  it('does not write CLAUDE_ENVIRONMENT_ID to .env when absent', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBeUndefined();
  });

  it('returns undefined environmentId when no existing ID is configured', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.environmentId).toBeUndefined();
  });

  // ── validate existing ID (valid) ──────────────────────────────────────────

  it('validates CLAUDE_ENVIRONMENT_ID via beta.environments.retrieve when provided via option', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
  });

  it('validates CLAUDE_ENVIRONMENT_ID from CLAUDE_ENVIRONMENT_ID env var', async () => {
    process.env.CLAUDE_ENVIRONMENT_ID = VALID_ENV_ID;
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
  });

  it('validates CLAUDE_ENVIRONMENT_ID from .env file when not provided via option or env', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${VALID_API_KEY}\nCLAUDE_ENVIRONMENT_ID=${VALID_ENV_ID}\n`,
      'utf-8',
    );
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
  });

  it('option overrides env var for CLAUDE_ENVIRONMENT_ID (three-source precedence)', async () => {
    process.env.CLAUDE_ENVIRONMENT_ID = 'env_from_env_var_should_lose';
    const overrideId = 'env_from_option_wins_123';
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(overrideId, 'option-env'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: overrideId,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    // The option-level ID (not the env var) must be retrieved
    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(overrideId);
    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalledWith('env_from_env_var_should_lose');
  });

  it('returns validated environmentId in result', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.environmentId).toBe(VALID_ENV_ID);
  });

  it('writes CLAUDE_ENVIRONMENT_ID to .env after successful validation', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
  });

  it('does not write CLAUDE_ENVIRONMENT_ID when skipEnvWrite is true', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    // Result still has the ID, but .env was not written
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.envWritten).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
  });

  // ── stale ID → throw with explicit warning ────────────────────────────────

  it('throws when CLAUDE_ENVIRONMENT_ID is stale (not found via API)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('404 Not Found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeEnvironmentId: STALE_ENV_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(STALE_ENV_ID);
  });

  it('stale error message contains "stale" to guide the user', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeEnvironmentId: STALE_ENV_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale/i);
  });

  it('stale error message mentions CLAUDE_ENVIRONMENT_ID to guide the user', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeEnvironmentId: STALE_ENV_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/CLAUDE_ENVIRONMENT_ID/);
  });

  it('throws before Slack credential validation when environment ID is stale', async () => {
    // Stale env ID should throw before any Slack credential checks
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeEnvironmentId: STALE_ENV_ID,
        // Intentionally omit Slack tokens — stale env should throw first
      }),
    ).rejects.toThrow(/stale/i);
  });

  it('does not call environments.list in non-interactive mode (no listing prompt)', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    // Non-interactive never lists environments — only validates
    expect(mockEnvironmentsList).not.toHaveBeenCalled();
  });

  it('does not invoke any interactive prompts when environment ID is valid', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
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

// ══════════════════════════════════════════════════════════════════════════════
// Interactive path
// ══════════════════════════════════════════════════════════════════════════════

describe('initSlack (interactive) — CLAUDE_ENVIRONMENT_ID: detect/validate/keep-or-change/warn-on-stale', () => {
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

  /**
   * Wire the minimal set of @inquirer/prompts responses for the Slack setup
   * steps that follow the environment step.
   *
   * No CLAUDE_AGENT_ID is set (isolateEnv clears it) so the agent step is
   * skipped entirely. Prompt call order after the environment step:
   *   input[0..1]: appName, appDescription
   *   select[next]: 'manual' (setup method)
   *   input[2..4]: botToken, appToken, signingSecret
   *   confirm[0]: true (save credentials)
   */
  async function wireSlackManualPrompts(opts: { prependSelectValues?: string[] } = {}) {
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    // API key from env — no password prompt needed

    // Optional leading select values (e.g. for the environment step)
    for (const v of opts.prependSelectValues ?? []) {
      vi.mocked(select).mockResolvedValueOnce(v as never);
    }

    // Slack setup prompts
    vi.mocked(input)
      .mockResolvedValueOnce('Test Bot')          // appName
      .mockResolvedValueOnce('A test bot')        // appDescription
      .mockResolvedValueOnce(VALID_BOT_TOKEN)     // botToken
      .mockResolvedValueOnce(VALID_APP_TOKEN)     // appToken
      .mockResolvedValueOnce(VALID_SIGNING_SECRET); // signingSecret
    vi.mocked(select).mockResolvedValueOnce('manual' as never); // setup method
    vi.mocked(confirm).mockResolvedValueOnce(true);             // save credentials

    return { input, confirm, select, password };
  }

  // ── skip when absent ──────────────────────────────────────────────────────

  it('skips environment step when no CLAUDE_ENVIRONMENT_ID is configured', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir });

    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalled();
    expect(mockEnvironmentsList).not.toHaveBeenCalled();
  });

  it('returns undefined environmentId when no existing ID is configured', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    await wireSlackManualPrompts();

    const result = await initSlack({ cwd: tmpDir });

    expect(result.environmentId).toBeUndefined();
  });

  // ── keep existing valid ID ────────────────────────────────────────────────

  it('validates existing CLAUDE_ENVIRONMENT_ID via beta.environments.retrieve', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    // Environment keep/change select comes before the setup-method select
    await wireSlackManualPrompts({ prependSelectValues: ['keep'] });

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: VALID_ENV_ID });

    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(VALID_ENV_ID);
  });

  it('returns the kept environment ID when user selects "keep"', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    await wireSlackManualPrompts({ prependSelectValues: ['keep'] });

    const result = await initSlack({ cwd: tmpDir, claudeEnvironmentId: VALID_ENV_ID });

    expect(result.environmentId).toBe(VALID_ENV_ID);
  });

  it('writes CLAUDE_ENVIRONMENT_ID to .env when user keeps the existing environment', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    await wireSlackManualPrompts({ prependSelectValues: ['keep'] });

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: VALID_ENV_ID });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
  });

  // ── change: user chooses a different environment ──────────────────────────

  it('lists environments after user selects "change"', async () => {
    const OTHER_ENV_ID = 'env_other_xyz789';
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(OTHER_ENV_ID, 'other-env')],
    });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    // change → select replacement from list → setup method
    await wireSlackManualPrompts({ prependSelectValues: ['change', OTHER_ENV_ID] });

    const result = await initSlack({ cwd: tmpDir, claudeEnvironmentId: VALID_ENV_ID });

    expect(mockEnvironmentsList).toHaveBeenCalled();
    expect(result.environmentId).toBe(OTHER_ENV_ID);
  });

  it('allows creating a new environment when the list is empty after "change"', async () => {
    const CREATED_ENV_ID = 'env_brand_new_111';
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));
    // Empty list → auto-jumps to create (no extra select needed)
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { input, confirm, select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)   // environment: change
      .mockResolvedValueOnce('manual' as never);  // setup method
    vi.mocked(input)
      .mockResolvedValueOnce('new-env')            // environment name (create prompt)
      .mockResolvedValueOnce('')                   // environment description (optional, skip)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({ cwd: tmpDir, claudeEnvironmentId: VALID_ENV_ID });

    expect(mockEnvironmentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-env' }),
    );
    expect(result.environmentId).toBe(CREATED_ENV_ID);
  });

  // ── stale ID → warn and fall through to select/create ────────────────────

  it('warns about stale CLAUDE_ENVIRONMENT_ID and falls through to environment listing', async () => {
    const REPLACEMENT_ID = 'env_replacement_456';
    // Stale: retrieve throws
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(REPLACEMENT_ID, 'replacement-env')],
    });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    // Stale path skips keep/change — goes straight to listing select
    await wireSlackManualPrompts({ prependSelectValues: [REPLACEMENT_ID] });

    const result = await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID });

    expect(mockEnvironmentsList).toHaveBeenCalled();
    // Stale ID must NOT appear in result
    expect(result.environmentId).toBe(REPLACEMENT_ID);
    expect(result.environmentId).not.toBe(STALE_ENV_ID);
  });

  it('detects stale ID from .env and replaces it without silent drop', async () => {
    // Pre-seed .env with a stale environment ID
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${VALID_API_KEY}\nCLAUDE_ENVIRONMENT_ID=${STALE_ENV_ID}\n`,
      'utf-8',
    );
    const REPLACEMENT_ID = 'env_fresh_777';
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(REPLACEMENT_ID, 'fresh-env')],
    });
    // Stale → falls to listing → select replacement
    await wireSlackManualPrompts({ prependSelectValues: [REPLACEMENT_ID] });

    const result = await initSlack({ cwd: tmpDir });

    // retrieve was called with the stale ID from .env
    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(STALE_ENV_ID);
    // Result has the replacement, not the stale value
    expect(result.environmentId).toBe(REPLACEMENT_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// initSlack nonInteractive: true (delegates to initSlackNonInteractive)
// ══════════════════════════════════════════════════════════════════════════════

describe('initSlack with nonInteractive: true — CLAUDE_ENVIRONMENT_ID', () => {
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

  it('validates and writes CLAUDE_ENVIRONMENT_ID via the nonInteractive path', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(VALID_ENV_ID, VALID_ENV_NAME));

    const result = await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeEnvironmentId: VALID_ENV_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.environmentId).toBe(VALID_ENV_ID);
    const env = readEnv(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
  });

  it('throws for stale CLAUDE_ENVIRONMENT_ID via the nonInteractive path', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlack({
        nonInteractive: true,
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeEnvironmentId: STALE_ENV_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale/i);
  });
});
