/**
 * AC 12: After selection, writes CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID, and
 * CLAUDE_VAULT_IDS (comma-joined, only if non-empty) to .env via writeEnvFile
 * preserving existing keys and backup behavior.
 *
 * This file focuses specifically on the .env write contract:
 *   1. CLAUDE_VAULT_IDS is comma-joined when multiple IDs are validated
 *   2. CLAUDE_VAULT_IDS is NOT written when the validated list is empty
 *   3. Existing unrelated .env keys are preserved (never clobbered)
 *   4. .env.backup is created when overwriting an existing CLAUDE_AGENT_ID
 *   5. .env.backup is created when overwriting an existing CLAUDE_ENVIRONMENT_ID
 *   6. .env.backup is created when overwriting an existing CLAUDE_VAULT_IDS
 *   7. All three IDs + Slack tokens are written in a single atomic pass
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlackNonInteractive } from '../../../src/channels/slack/init.js';

// ────────────────────────── SDK Mock ──────────────────────────

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

// ────────────────────────── Helpers ──────────────────────────

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-env-write-test-'));
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

function isolateEnv(): () => void {
  const keys = [
    'ANTHROPIC_API_KEY', 'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID', 'CLAUDE_VAULT_IDS',
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

/** Minimal Slack options for non-interactive manual path. */
const SLACK_OPTIONS = {
  anthropicApiKey: VALID_API_KEY,
  slackBotToken: VALID_BOT_TOKEN,
  slackAppToken: VALID_APP_TOKEN,
  slackSigningSecret: VALID_SIGNING_SECRET,
};

// ────────────────────────────────────────────────────────────────────────────
// Suite 1: CLAUDE_VAULT_IDS comma-joining
// ────────────────────────────────────────────────────────────────────────────

describe('AC 12 — CLAUDE_VAULT_IDS comma-joining', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] }); // validateAuth
    // Default: vaults retrieve always succeeds (any ID accepted)
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('writes CLAUDE_VAULT_IDS as comma-joined string for two vault IDs', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBe(`${VAULT_A},${VAULT_B}`);
  });

  it('trims whitespace from each vault ID before writing', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeVaultIds: ` ${VAULT_A} , ${VAULT_B} `, // intentional surrounding spaces
    });

    const env = readEnv(tmpDir);
    // parseVaultIds trims each segment; the write should be clean
    expect(env.CLAUDE_VAULT_IDS).toBe(`${VAULT_A},${VAULT_B}`);
  });

  it('writes a single vault ID without a trailing comma', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeVaultIds: VAULT_A,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBe(VAULT_A);
    expect(env.CLAUDE_VAULT_IDS).not.toContain(','); // no trailing comma
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 2: CLAUDE_VAULT_IDS not written when empty
// ────────────────────────────────────────────────────────────────────────────

describe('AC 12 — CLAUDE_VAULT_IDS omitted when empty', () => {
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

  it('does NOT write CLAUDE_VAULT_IDS when no vault IDs are provided', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      // claudeVaultIds not set
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });

  it('does NOT write CLAUDE_VAULT_IDS when all vault IDs fail validation and are dropped', async () => {
    // Both vaults fail API validation → dropped from list
    mockVaultsRetrieve.mockRejectedValue(new Error('not found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
    });

    const env = readEnv(tmpDir);
    // All IDs invalid → none written
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });

  it('does NOT write CLAUDE_VAULT_IDS when claudeVaultIds is an empty string', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeVaultIds: '',
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 3: Preserves existing .env keys (no clobbering)
// ────────────────────────────────────────────────────────────────────────────

describe('AC 12 — preserves existing .env keys', () => {
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

  it('preserves an existing custom key when writing CLAUDE_AGENT_ID', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      ['CUSTOM_KEY=my-custom-value', `ANTHROPIC_API_KEY=${VALID_API_KEY}`].join('\n') + '\n',
      'utf-8',
    );
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID,
    });

    const env = readEnv(tmpDir);
    expect(env.CUSTOM_KEY).toBe('my-custom-value');     // preserved
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);  // new key added
  });

  it('preserves an existing custom key when writing CLAUDE_ENVIRONMENT_ID', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      ['RAILWAY_TOKEN=rw-existing-token', `ANTHROPIC_API_KEY=${VALID_API_KEY}`].join('\n') + '\n',
      'utf-8',
    );
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeEnvironmentId: VALID_ENV_ID,
    });

    const env = readEnv(tmpDir);
    expect(env.RAILWAY_TOKEN).toBe('rw-existing-token');         // preserved
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);       // new key added
  });

  it('preserves all existing keys when writing all three IDs and Slack tokens together', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      ['EXISTING_ONE=val-one', 'EXISTING_TWO=val-two'].join('\n') + '\n',
      'utf-8',
    );
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
    });

    const env = readEnv(tmpDir);
    // Pre-existing keys must survive
    expect(env.EXISTING_ONE).toBe('val-one');
    expect(env.EXISTING_TWO).toBe('val-two');
    // New keys must be written
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
    expect(env.CLAUDE_VAULT_IDS).toBe(VAULT_A);
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
    expect(env.SLACK_APP_TOKEN).toBe(VALID_APP_TOKEN);
    expect(env.SLACK_SIGNING_SECRET).toBe(VALID_SIGNING_SECRET);
  });

  it('does not overwrite an existing ANTHROPIC_API_KEY already in .env', async () => {
    const EXISTING_API_KEY = 'sk-ant-api03-already-in-env-key-99999999';
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${EXISTING_API_KEY}\n`,
      'utf-8',
    );

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS, // SLACK_OPTIONS.anthropicApiKey differs from EXISTING_API_KEY
    });

    const env = readEnv(tmpDir);
    // The existing ANTHROPIC_API_KEY should not be replaced
    expect(env.ANTHROPIC_API_KEY).toBe(EXISTING_API_KEY);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 4: .env.backup creation on overwrite
// ────────────────────────────────────────────────────────────────────────────

describe('AC 12 — .env.backup created when existing IDs are overwritten', () => {
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

  it('creates .env.backup when CLAUDE_AGENT_ID is overwritten with a different value', async () => {
    const OLD_AGENT_ID = 'agent_old_overwritten_value';
    // Pre-seed .env with existing Slack tokens (same values) plus old agent ID
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        `ANTHROPIC_API_KEY=${VALID_API_KEY}`,
        `CLAUDE_AGENT_ID=${OLD_AGENT_ID}`,
        `SLACK_BOT_TOKEN=${VALID_BOT_TOKEN}`,
        `SLACK_APP_TOKEN=${VALID_APP_TOKEN}`,
        `SLACK_SIGNING_SECRET=${VALID_SIGNING_SECRET}`,
      ].join('\n') + '\n',
      'utf-8',
    );
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID, // new, different from OLD_AGENT_ID
    });

    const backupPath = path.join(tmpDir, '.env.backup');
    expect(fs.existsSync(backupPath)).toBe(true);
    // Backup contains the old agent ID
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    expect(backupContent).toContain(OLD_AGENT_ID);
    // New .env has the updated agent ID
    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
  });

  it('creates .env.backup when CLAUDE_ENVIRONMENT_ID is overwritten with a different value', async () => {
    const OLD_ENV_ID = 'env_old_overwritten_value';
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        `ANTHROPIC_API_KEY=${VALID_API_KEY}`,
        `CLAUDE_ENVIRONMENT_ID=${OLD_ENV_ID}`,
        `SLACK_BOT_TOKEN=${VALID_BOT_TOKEN}`,
        `SLACK_APP_TOKEN=${VALID_APP_TOKEN}`,
        `SLACK_SIGNING_SECRET=${VALID_SIGNING_SECRET}`,
      ].join('\n') + '\n',
      'utf-8',
    );
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeEnvironmentId: VALID_ENV_ID, // new, different from OLD_ENV_ID
    });

    const backupPath = path.join(tmpDir, '.env.backup');
    expect(fs.existsSync(backupPath)).toBe(true);
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    expect(backupContent).toContain(OLD_ENV_ID);
    const env = readEnv(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
  });

  it('creates .env.backup when CLAUDE_VAULT_IDS is overwritten with a different value', async () => {
    const OLD_VAULT = 'vlt_old_vault_being_replaced';
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        `ANTHROPIC_API_KEY=${VALID_API_KEY}`,
        `CLAUDE_VAULT_IDS=${OLD_VAULT}`,
        `SLACK_BOT_TOKEN=${VALID_BOT_TOKEN}`,
        `SLACK_APP_TOKEN=${VALID_APP_TOKEN}`,
        `SLACK_SIGNING_SECRET=${VALID_SIGNING_SECRET}`,
      ].join('\n') + '\n',
      'utf-8',
    );
    // New vault ID validates successfully
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeVaultIds: VAULT_A, // new vault ID, different from OLD_VAULT
    });

    const backupPath = path.join(tmpDir, '.env.backup');
    expect(fs.existsSync(backupPath)).toBe(true);
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    expect(backupContent).toContain(OLD_VAULT);
    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBe(VAULT_A);
  });

  it('does NOT create .env.backup when no existing .env file is present', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });

    await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID,
    });

    // .env was created from scratch — no previous file to back up
    const backupPath = path.join(tmpDir, '.env.backup');
    expect(fs.existsSync(backupPath)).toBe(false);
    // But .env itself must have been written
    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 5: Atomic single-pass write
// ────────────────────────────────────────────────────────────────────────────

describe('AC 12 — all IDs written in a single atomic pass', () => {
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

  it('writes CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID, CLAUDE_VAULT_IDS, and all Slack tokens to one .env', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
    });

    expect(result.envWritten).toBe(true);

    // One .env file must exist with ALL expected keys
    const envPath = path.join(tmpDir, '.env');
    expect(fs.existsSync(envPath)).toBe(true);

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_API_KEY);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(VALID_ENV_ID);
    expect(env.CLAUDE_VAULT_IDS).toBe(`${VAULT_A},${VAULT_B}`);
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
    expect(env.SLACK_APP_TOKEN).toBe(VALID_APP_TOKEN);
    expect(env.SLACK_SIGNING_SECRET).toBe(VALID_SIGNING_SECRET);
  });

  it('writes only Slack tokens (no agent/env/vault keys) when no resource IDs are configured', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      // No claudeAgentId, claudeEnvironmentId, or claudeVaultIds
    });

    expect(result.envWritten).toBe(true);

    const env = readEnv(tmpDir);
    // Slack credentials present
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
    expect(env.SLACK_APP_TOKEN).toBe(VALID_APP_TOKEN);
    expect(env.SLACK_SIGNING_SECRET).toBe(VALID_SIGNING_SECRET);
    // Resource IDs absent (not written)
    expect(env.CLAUDE_AGENT_ID).toBeUndefined();
    expect(env.CLAUDE_ENVIRONMENT_ID).toBeUndefined();
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });

  it('result reflects the IDs that were written to .env', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
    });

    // Returned result matches what was written
    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([VAULT_A, VAULT_B]);

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(result.agentId);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(result.environmentId);
    expect(env.CLAUDE_VAULT_IDS).toBe(result.vaultIds.join(','));
  });

  it('does not write any .env when skipEnvWrite is true, even with valid IDs', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: VALID_AGENT_NAME, version: 1 });
    mockEnvironmentsRetrieve.mockResolvedValue({ id: VALID_ENV_ID, name: VALID_ENV_NAME });
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      ...SLACK_OPTIONS,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: VALID_ENV_ID,
      claudeVaultIds: VAULT_A,
      skipEnvWrite: true,
    });

    expect(result.envWritten).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
    // But result still has the validated IDs
    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.environmentId).toBe(VALID_ENV_ID);
    expect(result.vaultIds).toEqual([VAULT_A]);
  });
});
