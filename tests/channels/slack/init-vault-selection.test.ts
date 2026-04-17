/**
 * Tests for AC 10: Vault selection via beta.vaults.list in the init-slack wizard.
 *
 * AC 10: Vault selection lists up to 20 via beta.vaults.list, user can
 * multi-select or paste comma-separated IDs or skip entirely (empty list is valid).
 *
 * When CLAUDE_VAULT_IDS is NOT configured in interactive mode, the wizard:
 *  1. Calls beta.vaults.list (up to 20)
 *  2. Displays a numbered list if vaults are available
 *  3. Prompts for selection: number(s), raw vault ID(s), or Enter to skip
 *  4. Returns [] immediately if the list is empty or the API call fails
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack } from '../../../src/channels/slack/init.js';

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

// SDK mock: beta.agents.list (for validateAuth) + beta.vaults.list + beta.vaults.retrieve
const mockAgentsList = vi.fn();
const mockVaultsList = vi.fn();
const mockVaultsRetrieve = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      agents: { list: mockAgentsList },
      vaults: {
        list: mockVaultsList,
        retrieve: mockVaultsRetrieve,
      },
    };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

// ────────────────────────── Fixtures ──────────────────────────

const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';
const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';

const VAULT_A = { id: 'vlt_aaaaaaaaaaaaaaaa', name: 'Vault Alpha' };
const VAULT_B = { id: 'vlt_bbbbbbbbbbbbbbbb', name: 'Vault Beta' };
const VAULT_C = { id: 'vlt_cccccccccccccccc', name: 'Vault Gamma' };

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-vault-sel-test-'));
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

/**
 * Wire the minimal @inquirer/prompts mocks for the interactive manual path.
 *
 * When vaults are returned by beta.vaults.list (no CLAUDE_VAULT_IDS configured),
 * selectVaultsInteractive fires BEFORE the app-name prompt (Step 0d).
 *
 * Prompt order (vault step active):
 *   input[0]: vault selection (Step 0d — only when vaults.list returns items)
 *   input[1]: appName
 *   input[2]: appDescription
 *   select[0]: setup method
 *   input[3]: botToken
 *   input[4]: appToken
 *   input[5]: signingSecret
 *   confirm[0]: save to .env
 */
async function setupPromptsWithVaultSelection(opts: {
  vaultSelectionInput: string;
  saveCredentials?: boolean;
}) {
  const { input: mockInput, confirm: mockConfirm, select: mockSelect, password: mockPassword } =
    await import('@inquirer/prompts');

  // No password prompt when ANTHROPIC_API_KEY is set in env
  vi.mocked(mockPassword).mockResolvedValue(VALID_API_KEY);

  vi.mocked(mockInput)
    .mockResolvedValueOnce(opts.vaultSelectionInput) // vault selection (Step 0d)
    .mockResolvedValueOnce('Test Bot')               // appName
    .mockResolvedValueOnce('A test bot')             // appDescription
    .mockResolvedValueOnce(VALID_BOT_TOKEN)          // botToken
    .mockResolvedValueOnce(VALID_APP_TOKEN)          // appToken
    .mockResolvedValueOnce(VALID_SIGNING_SECRET);    // signingSecret

  vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
  vi.mocked(mockConfirm).mockResolvedValueOnce(opts.saveCredentials ?? false);

  return { mockInput, mockConfirm, mockSelect, mockPassword };
}

/**
 * Wire prompts when vaults.list returns empty / throws — no vault step fires.
 * Prompt order is the same as the "no vault IDs" baseline.
 */
async function setupPromptsNoVaultStep(opts: { saveCredentials?: boolean } = {}) {
  const { input: mockInput, confirm: mockConfirm, select: mockSelect, password: mockPassword } =
    await import('@inquirer/prompts');

  vi.mocked(mockPassword).mockResolvedValue(VALID_API_KEY);
  vi.mocked(mockInput)
    .mockResolvedValueOnce('Test Bot')               // appName
    .mockResolvedValueOnce('A test bot')             // appDescription
    .mockResolvedValueOnce(VALID_BOT_TOKEN)          // botToken
    .mockResolvedValueOnce(VALID_APP_TOKEN)          // appToken
    .mockResolvedValueOnce(VALID_SIGNING_SECRET);    // signingSecret

  vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
  vi.mocked(mockConfirm).mockResolvedValueOnce(opts.saveCredentials ?? false);

  return { mockInput, mockConfirm, mockSelect, mockPassword };
}

// ────────────────────────── Tests ──────────────────────────

describe('initSlack (interactive) — vault selection via beta.vaults.list (AC 10)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    // resetAllMocks clears call history + once-queues + permanent implementations.
    // This prevents stale mockResolvedValueOnce values from accumulating across
    // tests that use skipEnvWrite:true (which never consume the confirm mock).
    vi.resetAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // Re-establish default behaviors after full reset
    mockAgentsList.mockResolvedValue({ data: [] });
    mockVaultsList.mockResolvedValue({ data: [] });
    mockVaultsRetrieve.mockResolvedValue({ id: 'vlt_test', name: 'Test Vault' });
    // Set API key in env so no password prompt fires in tests
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  // ── calls beta.vaults.list ────────────────────────────────────────────────

  it('calls beta.vaults.list (up to 20) when no CLAUDE_VAULT_IDS configured', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '' });

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(mockVaultsList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('does NOT call beta.vaults.list when CLAUDE_VAULT_IDS is already configured', async () => {
    process.env.CLAUDE_VAULT_IDS = VAULT_A.id;
    mockVaultsRetrieve.mockResolvedValue(VAULT_A);
    await setupPromptsNoVaultStep();

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(mockVaultsList).not.toHaveBeenCalled();
  });

  // ── skip silently when no vaults available ────────────────────────────────

  it('skips vault selection prompt when vaults.list returns empty list', async () => {
    mockVaultsList.mockResolvedValue({ data: [] });
    const { mockInput } = await setupPromptsNoVaultStep();

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts).toHaveLength(0);
    expect(result.vaultIds).toEqual([]);
  });

  it('skips vault selection prompt when vaults.list throws (API not available)', async () => {
    mockVaultsList.mockRejectedValue(new Error('not implemented'));
    const { mockInput } = await setupPromptsNoVaultStep();

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts).toHaveLength(0);
    expect(result.vaultIds).toEqual([]);
  });

  it('always returns a vaultIds array even when vault step is skipped (never undefined)', async () => {
    mockVaultsList.mockResolvedValue({ data: [] });
    await setupPromptsNoVaultStep();

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(Array.isArray(result.vaultIds)).toBe(true);
  });

  // ── shows selection prompt when vaults are available ─────────────────────

  it('shows vault selection prompt when vaults.list returns at least one vault', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A] });
    const { mockInput } = await setupPromptsWithVaultSelection({ vaultSelectionInput: '' });

    await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    const inputCalls = vi.mocked(mockInput).mock.calls.map((c) => c[0]?.message ?? '');
    const vaultPrompts = inputCalls.filter((m) => m.toLowerCase().includes('vault'));
    expect(vaultPrompts.length).toBeGreaterThanOrEqual(1);
  });

  // ── skip (empty input) ────────────────────────────────────────────────────

  it('returns empty vaultIds when user presses Enter (skips vault selection)', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '' });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([]);
  });

  // ── select by number ──────────────────────────────────────────────────────

  it('selects vault by number (1-based index)', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B, VAULT_C] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '2' }); // select VAULT_B

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([VAULT_B.id]);
  });

  it('selects first vault by entering "1"', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '1' });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([VAULT_A.id]);
  });

  it('multi-selects vaults by entering comma-separated numbers', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B, VAULT_C] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '1,3' }); // VAULT_A and VAULT_C

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([VAULT_A.id, VAULT_C.id]);
  });

  it('selects all three vaults when entering "1,2,3"', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B, VAULT_C] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '1,2,3' });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([VAULT_A.id, VAULT_B.id, VAULT_C.id]);
  });

  // ── select by raw ID (paste) ──────────────────────────────────────────────

  it('accepts a raw vault ID (not from the numbered list)', async () => {
    const RAW_ID = 'vlt_raw_paste_not_in_list_xyz';
    mockVaultsList.mockResolvedValue({ data: [VAULT_A] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: RAW_ID });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([RAW_ID]);
  });

  it('accepts comma-separated raw vault IDs (paste path)', async () => {
    const ID_1 = 'vlt_pasted_first_11111111111';
    const ID_2 = 'vlt_pasted_second_2222222222';
    mockVaultsList.mockResolvedValue({ data: [VAULT_A] });
    await setupPromptsWithVaultSelection({ vaultSelectionInput: `${ID_1},${ID_2}` });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toEqual([ID_1, ID_2]);
  });

  // ── mixed numbers and raw IDs ─────────────────────────────────────────────

  it('handles mixed number indices and raw vault IDs in the same input', async () => {
    const RAW_ID = 'vlt_raw_extra_xyz987654321';
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B] });
    // "1" → VAULT_A.id, RAW_ID → used as-is
    await setupPromptsWithVaultSelection({ vaultSelectionInput: `1,${RAW_ID}` });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    expect(result.vaultIds).toContain(VAULT_A.id);
    expect(result.vaultIds).toContain(RAW_ID);
  });

  // ── out-of-range number treated as raw ID ─────────────────────────────────

  it('treats an out-of-range number as a raw vault ID', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A] }); // only 1 vault
    // "99" is out of range (max index is 1) — treat as raw vault ID string
    await setupPromptsWithVaultSelection({ vaultSelectionInput: '99' });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });

    // "99" is treated as a raw ID, not a list index
    expect(result.vaultIds).toEqual(['99']);
    expect(result.vaultIds).not.toContain(VAULT_A.id);
  });

  // ── writes to .env ────────────────────────────────────────────────────────

  it('writes CLAUDE_VAULT_IDS to .env when vaults are selected', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B] });
    await setupPromptsWithVaultSelection({
      vaultSelectionInput: '1,2',
      saveCredentials: true,
    });

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBe(`${VAULT_A.id},${VAULT_B.id}`);
  });

  it('does NOT write CLAUDE_VAULT_IDS to .env when user skips vault selection', async () => {
    mockVaultsList.mockResolvedValue({ data: [VAULT_A, VAULT_B] });
    await setupPromptsWithVaultSelection({
      vaultSelectionInput: '', // skip
      saveCredentials: true,
    });

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });

  it('does NOT write CLAUDE_VAULT_IDS when vaults.list returns empty', async () => {
    mockVaultsList.mockResolvedValue({ data: [] });
    await setupPromptsNoVaultStep({ saveCredentials: true });

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_VAULT_IDS).toBeUndefined();
  });

  // ── non-interactive path uses validation (not selection) ──────────────────

  it('does not call beta.vaults.list in non-interactive mode (validation path only)', async () => {
    const result = await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    expect(mockVaultsList).not.toHaveBeenCalled();
    expect(result.vaultIds).toEqual([]);
  });
});
