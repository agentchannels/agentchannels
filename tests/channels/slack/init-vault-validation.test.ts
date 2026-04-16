/**
 * Tests for AC 7: CLAUDE_VAULT_IDS per-ID validation in the init-slack wizard.
 *
 * AC 7: Existing CLAUDE_VAULT_IDS (comma-separated) are validated per-ID via
 * beta.vaults.retrieve, invalid IDs are warned about and dropped, user is
 * re-prompted only for the dropped slots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive, parseVaultIds } from '../../../src/channels/slack/init.js';

// ────────────────────────── Mocks ──────────────────────────

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

vi.mock('../../../src/core/environment.js', () => ({
  validateEnvironment: vi.fn(),
  listEnvironments: vi.fn().mockResolvedValue([]),
  createEnvironment: vi.fn(),
}));

vi.mock('../../../src/core/agent.js', () => ({
  validateAgent: vi.fn(),
  listAgents: vi.fn().mockResolvedValue([]),
  createAgent: vi.fn(),
}));

// SDK mock: beta.agents.list (for auth validation) + beta.vaults.retrieve
const mockAgentsList = vi.fn();
const mockVaultsRetrieve = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      agents: { list: mockAgentsList },
      vaults: { retrieve: mockVaultsRetrieve },
    };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

// ────────────────────────── Helpers ──────────────────────────

const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';
const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';

const VAULT_A = 'vlt_aaaaaaaaaaaaaaaa';
const VAULT_B = 'vlt_bbbbbbbbbbbbbbbb';
const VAULT_C = 'vlt_cccccccccccccccc';
const VAULT_BAD = 'vlt_bad000000000000';

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-vault-test-'));
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

// ────────────────────────── parseVaultIds unit tests ──────────────────────────

describe('parseVaultIds', () => {
  it('returns [] for undefined input', () => {
    expect(parseVaultIds(undefined)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parseVaultIds('')).toEqual([]);
  });

  it('parses a single vault ID', () => {
    expect(parseVaultIds('vlt_abc')).toEqual(['vlt_abc']);
  });

  it('splits comma-separated vault IDs', () => {
    expect(parseVaultIds('vlt_a,vlt_b,vlt_c')).toEqual(['vlt_a', 'vlt_b', 'vlt_c']);
  });

  it('trims whitespace around IDs', () => {
    expect(parseVaultIds('  vlt_a , vlt_b  ')).toEqual(['vlt_a', 'vlt_b']);
  });

  it('drops empty slots from double commas', () => {
    expect(parseVaultIds('vlt_a,,vlt_b')).toEqual(['vlt_a', 'vlt_b']);
  });
});

// ────────────────────────── Non-interactive vault validation ──────────────────────────

describe('initSlackNonInteractive — CLAUDE_VAULT_IDS validation', () => {
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

  it('skips vault validation when CLAUDE_VAULT_IDS is not set', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    expect(mockVaultsRetrieve).not.toHaveBeenCalled();
    expect(result.vaultIds).toEqual([]);
  });

  it('returns all vault IDs when all are valid', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      skipEnvWrite: true,
    });

    expect(mockVaultsRetrieve).toHaveBeenCalledTimes(2);
    expect(result.vaultIds).toEqual([VAULT_A, VAULT_B]);
  });

  it('calls beta.vaults.retrieve once per vault ID', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B},${VAULT_C}`,
      skipEnvWrite: true,
    });

    expect(mockVaultsRetrieve).toHaveBeenCalledTimes(3);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_A);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_B);
    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_C);
  });

  it('drops invalid vault IDs and keeps valid ones', async () => {
    mockVaultsRetrieve
      .mockResolvedValueOnce({ id: VAULT_A, name: 'Vault A' })   // VAULT_A valid
      .mockRejectedValueOnce(new Error('not_found'))               // VAULT_BAD invalid
      .mockResolvedValueOnce({ id: VAULT_C, name: 'Vault C' });   // VAULT_C valid

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_BAD},${VAULT_C}`,
      skipEnvWrite: true,
    });

    expect(result.vaultIds).toEqual([VAULT_A, VAULT_C]);
    expect(result.vaultIds).not.toContain(VAULT_BAD);
  });

  it('returns empty array when all vault IDs are invalid', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      skipEnvWrite: true,
    });

    expect(result.vaultIds).toEqual([]);
  });

  it('does NOT throw when vault IDs are invalid — warns and drops only', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
        claudeVaultIds: VAULT_BAD,
        skipEnvWrite: true,
      }),
    ).resolves.not.toThrow();
  });

  it('does not invoke interactive prompts for dropped vault IDs (non-interactive)', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));
    const { input: mockInput } = await import('@inquirer/prompts');

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: VAULT_BAD,
      skipEnvWrite: true,
    });

    expect(vi.mocked(mockInput)).not.toHaveBeenCalled();
  });

  it('writes CLAUDE_VAULT_IDS to .env when vault IDs are valid', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBe(`${VAULT_A},${VAULT_B}`);
  });

  it('does NOT write CLAUDE_VAULT_IDS to .env when no vault IDs pass validation', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: VAULT_BAD,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });

  it('writes only valid IDs to .env when some are invalid', async () => {
    mockVaultsRetrieve
      .mockResolvedValueOnce({ id: VAULT_A, name: 'Vault A' })
      .mockRejectedValueOnce(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_BAD}`,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBe(VAULT_A);
    expect(env.CLAUDE_VAULT_IDS).not.toContain(VAULT_BAD);
  });

  it('reads CLAUDE_VAULT_IDS from env var when claudeVaultIds option not provided', async () => {
    process.env.CLAUDE_VAULT_IDS = `${VAULT_A},${VAULT_B}`;
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    expect(mockVaultsRetrieve).toHaveBeenCalledTimes(2);
    expect(result.vaultIds).toEqual([VAULT_A, VAULT_B]);
  });

  it('claudeVaultIds option takes precedence over CLAUDE_VAULT_IDS env var', async () => {
    process.env.CLAUDE_VAULT_IDS = 'vlt_from_env_should_be_ignored';
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: VAULT_A,   // option wins
      skipEnvWrite: true,
    });

    expect(mockVaultsRetrieve).toHaveBeenCalledWith(VAULT_A);
    expect(mockVaultsRetrieve).not.toHaveBeenCalledWith('vlt_from_env_should_be_ignored');
    expect(result.vaultIds).toEqual([VAULT_A]);
  });
});

// ────────────────────────── Interactive vault validation ──────────────────────────

describe('initSlack (interactive) — CLAUDE_VAULT_IDS re-prompt for dropped slots', () => {
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
   * Set up all prompts for the minimal interactive manual path.
   */
  async function setupManualPathPrompts(overrides: {
    inputValues?: string[];
    confirmValue?: boolean;
  } = {}) {
    const { input: mockInput, confirm: mockConfirm, select: mockSelect, password: mockPassword } =
      await import('@inquirer/prompts');

    vi.mocked(mockPassword).mockResolvedValue(VALID_API_KEY);
    vi.mocked(mockSelect).mockResolvedValue('manual' as const);
    vi.mocked(mockConfirm).mockResolvedValue(overrides.confirmValue ?? false);

    const inputValues = overrides.inputValues ?? [
      'Test Bot',         // appName
      'A test bot',       // appDescription
      VALID_BOT_TOKEN,    // botToken
      VALID_APP_TOKEN,    // appToken
      VALID_SIGNING_SECRET, // signingSecret
    ];
    for (const val of inputValues) {
      vi.mocked(mockInput).mockResolvedValueOnce(val);
    }

    return { mockPassword, mockInput, mockConfirm, mockSelect };
  }

  it('skips vault prompt when CLAUDE_VAULT_IDS is not configured', async () => {
    const { mockInput } = await setupManualPathPrompts();

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(mockVaultsRetrieve).not.toHaveBeenCalled();
    // input called only for app name/description + 3 Slack tokens = 5 times
    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts).toHaveLength(0);
  });

  it('does not prompt for replacement when all vault IDs are valid', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_VAULT_IDS = `${VAULT_A},${VAULT_B}`;

    const { mockInput } = await setupManualPathPrompts({
      inputValues: ['Test Bot', 'A test bot', VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET],
    });

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts).toHaveLength(0);
  });

  it('prompts once per dropped vault ID slot', async () => {
    // VAULT_A valid, VAULT_BAD invalid → 1 replacement prompt
    mockVaultsRetrieve
      .mockResolvedValueOnce({ id: VAULT_A, name: 'Vault A' })
      .mockRejectedValueOnce(new Error('not_found'));

    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_VAULT_IDS = `${VAULT_A},${VAULT_BAD}`;

    const { mockInput } = await setupManualPathPrompts({
      inputValues: [
        'Test Bot', 'A test bot',  // app config
        '',                         // replacement vault (skipped)
        VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET,
      ],
    });

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts).toHaveLength(1);
  });

  it('prompts twice when two vault IDs are dropped', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found')); // all invalid

    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_VAULT_IDS = `${VAULT_A},${VAULT_B}`;

    const { mockInput } = await setupManualPathPrompts({
      inputValues: [
        'Test Bot', 'A test bot',  // app config
        '',                         // replacement for slot 1 (skipped)
        '',                         // replacement for slot 2 (skipped)
        VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET,
      ],
    });

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts).toHaveLength(2);
  });

  it('accepts a valid replacement vault ID entered during re-prompt', async () => {
    // Original vault is invalid; replacement is valid
    mockVaultsRetrieve
      .mockRejectedValueOnce(new Error('not_found'))              // VAULT_BAD invalid
      .mockResolvedValueOnce({ id: VAULT_C, name: 'Vault C' });  // VAULT_C valid replacement

    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_VAULT_IDS = VAULT_BAD;

    const { mockInput } = await setupManualPathPrompts({
      inputValues: [
        VAULT_C,                   // replacement vault — valid (vault step is Step 0d, before Slack setup)
        'Test Bot', 'A test bot',  // app config
        VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET,
      ],
    });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([VAULT_C]);
    expect(result.vaultIds).not.toContain(VAULT_BAD);
  });

  it('skips an invalid replacement vault ID with a warning (does not throw)', async () => {
    // Both original and replacement are invalid
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_VAULT_IDS = VAULT_BAD;

    await setupManualPathPrompts({
      inputValues: [
        'Test Bot', 'A test bot',
        VAULT_C,                   // replacement — also invalid
        VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET,
      ],
    });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([]);
  });

  it('returns empty vaultIds array when user skips all replacement prompts', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_VAULT_IDS = `${VAULT_A},${VAULT_B}`;

    await setupManualPathPrompts({
      inputValues: [
        'Test Bot', 'A test bot',
        '',   // skip replacement 1
        '',   // skip replacement 2
        VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET,
      ],
    });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([]);
  });

  it('always returns vaultIds array (not undefined) even when no vaults configured', async () => {
    await setupManualPathPrompts();

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(Array.isArray(result.vaultIds)).toBe(true);
    expect(result.vaultIds).toEqual([]);
  });
});

// ────────────────────────── Stale vault drop — warning output (Sub-AC 1) ──────────────────────────

/**
 * Sub-AC 1: Unit tests for stale vault drop warning output.
 *
 * When CLAUDE_VAULT_IDS contains IDs no longer valid:
 *  - Each stale ID is dropped with console.warn containing the specific ID
 *  - Valid IDs do NOT trigger any vault warning
 *  - Non-interactive mode emits a summary warning after the per-ID warnings
 *  - The filtered vault list excludes all stale IDs
 *
 * These tests spy on console.warn to assert both the content of warning messages
 * and that the correct number of warnings are emitted per dropped ID.
 */
describe('stale vault drop — warning output assertions (Sub-AC 1)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    // Suppress console.warn output in tests while capturing calls
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ── Warning contains the specific stale ID ────────────────────────────────

  it('logs a warning containing the exact stale vault ID', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: VAULT_BAD,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes(VAULT_BAD))).toBe(true);
  });

  it('warning message indicates the ID was not found or inaccessible', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: VAULT_BAD,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    const dropMsg = warnMessages.find((msg) => msg.includes(VAULT_BAD));
    expect(dropMsg).toBeDefined();
    // The message should clearly communicate the vault was dropped
    expect(dropMsg).toMatch(/not found|inaccessible|dropping/i);
  });

  // ── One warning per dropped ID ────────────────────────────────────────────

  it('logs a separate warning for each stale vault ID when multiple are dropped', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found')); // all invalid

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B},${VAULT_BAD}`,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    // Each dropped ID should be mentioned in at least one warning
    expect(warnMessages.some((msg) => msg.includes(VAULT_A))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes(VAULT_B))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes(VAULT_BAD))).toBe(true);
  });

  it('emits exactly one per-ID warning for one stale vault ID', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: VAULT_BAD,
      skipEnvWrite: true,
    });

    // Exactly one warn call mentioning the stale ID (the per-ID warn)
    const idWarnings = warnSpy.mock.calls.filter((args) => String(args[0]).includes(VAULT_BAD));
    expect(idWarnings).toHaveLength(1);
  });

  // ── Valid IDs do not produce warnings ─────────────────────────────────────

  it('does not log any vault warning when all vault IDs are valid', async () => {
    mockVaultsRetrieve.mockResolvedValue({ id: VAULT_A, name: 'Vault A' });

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      skipEnvWrite: true,
    });

    const vaultWarnMessages = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => msg.toLowerCase().includes('vault'));
    expect(vaultWarnMessages).toHaveLength(0);
  });

  it('does not warn about a valid ID when mixed with a stale one', async () => {
    // VAULT_A is valid, VAULT_BAD is stale
    mockVaultsRetrieve
      .mockResolvedValueOnce({ id: VAULT_A, name: 'Vault A' })
      .mockRejectedValueOnce(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_BAD}`,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    // Stale ID should be warned about
    expect(warnMessages.some((msg) => msg.includes(VAULT_BAD))).toBe(true);
    // Valid ID should NOT appear in any warning
    expect(warnMessages.some((msg) => msg.includes(VAULT_A))).toBe(false);
  });

  it('does not log vault warnings when no CLAUDE_VAULT_IDS is configured', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    expect(mockVaultsRetrieve).not.toHaveBeenCalled();
    const vaultWarnMessages = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => msg.toLowerCase().includes('vault'));
    expect(vaultWarnMessages).toHaveLength(0);
  });

  // ── Summary warning in non-interactive mode ───────────────────────────────

  it('logs a summary warning after dropping IDs in non-interactive mode', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B}`,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    // A summary message indicating IDs were dropped should be present
    expect(warnMessages.some((msg) => msg.includes('dropped'))).toBe(true);
  });

  it('summary warning mentions the count of dropped IDs', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B},${VAULT_BAD}`,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    // The summary should mention "3" dropped IDs
    const summaryMsg = warnMessages.find((msg) => msg.includes('dropped'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toMatch(/3/);
  });

  // ── Filtered vault list ───────────────────────────────────────────────────

  it('filtered vault list excludes all stale IDs', async () => {
    mockVaultsRetrieve
      .mockResolvedValueOnce({ id: VAULT_A, name: 'Vault A' }) // valid
      .mockRejectedValueOnce(new Error('not_found'))             // VAULT_BAD stale
      .mockResolvedValueOnce({ id: VAULT_C, name: 'Vault C' }); // valid

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_BAD},${VAULT_C}`,
      skipEnvWrite: true,
    });

    // Stale ID must not be present
    expect(result.vaultIds).not.toContain(VAULT_BAD);
    // Valid IDs must be retained
    expect(result.vaultIds).toContain(VAULT_A);
    expect(result.vaultIds).toContain(VAULT_C);
    // Length matches only the valid IDs
    expect(result.vaultIds).toHaveLength(2);
  });

  it('filtered vault list is empty when all IDs are stale', async () => {
    mockVaultsRetrieve.mockRejectedValue(new Error('not_found'));

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B},${VAULT_BAD}`,
      skipEnvWrite: true,
    });

    expect(result.vaultIds).toEqual([]);
    // But a warning should still have been logged for each dropped ID
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes(VAULT_A))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes(VAULT_B))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes(VAULT_BAD))).toBe(true);
  });

  it('warning and filtered list are consistent — warned IDs match dropped IDs', async () => {
    // Two stale, one valid
    mockVaultsRetrieve
      .mockRejectedValueOnce(new Error('not_found'))             // VAULT_A stale
      .mockResolvedValueOnce({ id: VAULT_B, name: 'Vault B' }) // VAULT_B valid
      .mockRejectedValueOnce(new Error('not_found'));            // VAULT_BAD stale

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      claudeVaultIds: `${VAULT_A},${VAULT_B},${VAULT_BAD}`,
      skipEnvWrite: true,
    });

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));

    // IDs warned about should not be in the result
    if (warnMessages.some((msg) => msg.includes(VAULT_A))) {
      expect(result.vaultIds).not.toContain(VAULT_A);
    }
    if (warnMessages.some((msg) => msg.includes(VAULT_BAD))) {
      expect(result.vaultIds).not.toContain(VAULT_BAD);
    }
    // The one valid ID should remain
    expect(result.vaultIds).toContain(VAULT_B);
    expect(result.vaultIds).toHaveLength(1);
  });
});
