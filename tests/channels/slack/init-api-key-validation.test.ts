/**
 * Tests for ANTHROPIC_API_KEY validation in the init-slack wizard.
 *
 * AC 4: On invocation, wizard validates ANTHROPIC_API_KEY first.
 * Invalid or unreachable key triggers a re-prompt loop (interactive) or
 * throws immediately (non-interactive) — never hard-exits on first failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive } from '../../../src/channels/slack/init.js';

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

// Shared SDK mock state — tests control resolution/rejection
const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      agents: {
        list: mockAgentsList,
        retrieve: mockAgentsRetrieve,
        create: mockAgentsCreate,
      },
      environments: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        retrieve: vi.fn().mockRejectedValue(new Error('not found')),
      },
      vaults: {
        retrieve: vi.fn().mockRejectedValue(new Error('not found')),
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

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-api-key-test-'));
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

/** Save and clear credential env vars to prevent host leakage */
function isolateEnv(): () => void {
  const keys = [
    'ANTHROPIC_API_KEY',
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_REFRESH_TOKEN',
    'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID', 'CLAUDE_VAULT_IDS',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
  };
}

// ────────────────────────── Non-interactive: API key validation ──────────────────────────

describe('initSlackNonInteractive — ANTHROPIC_API_KEY validation', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks(); // reset call counts and return value queues between tests
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] }); // succeeds by default
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('throws when ANTHROPIC_API_KEY is completely absent', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        // No anthropicApiKey option, no env var, no .env file
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow('ANTHROPIC_API_KEY is required');
  });

  it('error message mentions env var, .env file, and flag alternatives', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/env var|\.env file|flag/i);
  });

  it('throws when API key is present but fails validation (network/auth error)', async () => {
    mockAgentsList.mockRejectedValue(new Error('Authentication failed: invalid x-api-key'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: 'sk-ant-invalid-key',
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow('Authentication failed');
  });

  it('succeeds and returns anthropicApiKey when key is valid', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.anthropicApiKey).toBe(VALID_API_KEY);
  });

  it('resolves key from ANTHROPIC_API_KEY env var when no option provided', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.anthropicApiKey).toBe(VALID_API_KEY);
  });

  it('resolves key from .env file when not provided via option or env', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${VALID_API_KEY}\n`,
      'utf-8',
    );

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.anthropicApiKey).toBe(VALID_API_KEY);
  });

  it('option takes precedence over env var (three-source precedence)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env-should-be-overridden';

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY, // option wins
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.anthropicApiKey).toBe(VALID_API_KEY);
  });

  it('writes ANTHROPIC_API_KEY to .env when not already present', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_API_KEY);
  });

  it('does NOT overwrite existing ANTHROPIC_API_KEY in .env', async () => {
    const existingKey = 'sk-ant-api03-already-present-key-12345678';
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${existingKey}\n`,
      'utf-8',
    );

    // Pass a different key as option — it validates but should NOT overwrite .env
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(existingKey);
  });

  it('does not call Slack credential prompts when API key validation fails', async () => {
    const { password: mockPassword, input: mockInput } = await import('@inquirer/prompts');

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        // No API key — will throw before any prompts
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow('ANTHROPIC_API_KEY is required');

    expect(vi.mocked(mockPassword)).not.toHaveBeenCalled();
    expect(vi.mocked(mockInput)).not.toHaveBeenCalled();
  });
});

// ────────────────────────── Interactive: API key re-prompt loop ──────────────────────────

describe('initSlack (interactive) — ANTHROPIC_API_KEY re-prompt loop', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks(); // reset call counts and return value queues between tests
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] }); // succeeds by default
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Helper to set up all prompts for the minimal interactive manual path.
   * Configures password (API key), input (appName, appDescription, botToken, appToken, signingSecret),
   * select (setupMethod=manual), confirm (saveCredentials).
   */
  async function setupManualPathPrompts(overrides: { passwordReturnValues?: string[] } = {}) {
    const { input: mockInput, confirm: mockConfirm, select: mockSelect, password: mockPassword } =
      await import('@inquirer/prompts');

    const passwordValues = overrides.passwordReturnValues ?? [VALID_API_KEY];
    for (const val of passwordValues) {
      vi.mocked(mockPassword).mockResolvedValueOnce(val);
    }
    // App name, description, botToken, appToken, signingSecret
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    vi.mocked(mockConfirm).mockResolvedValueOnce(true); // save credentials

    return { mockPassword, mockInput, mockConfirm, mockSelect };
  }

  it('does not prompt for API key when a valid key is already in env (validates silently)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { mockPassword, mockInput, mockConfirm, mockSelect } = await setupManualPathPrompts({
      passwordReturnValues: [], // no password calls expected
    });
    // No password calls expected — key is already set in env

    await initSlack({ cwd: tmpDir });

    expect(vi.mocked(mockPassword)).not.toHaveBeenCalled();
  });

  it('prompts for API key when none is configured', async () => {
    const { mockPassword } = await setupManualPathPrompts();

    await initSlack({ cwd: tmpDir });

    expect(vi.mocked(mockPassword)).toHaveBeenCalledTimes(1);
  });

  it('re-prompts on invalid key — does not hard-exit on first failure', async () => {
    // First call: invalid key (validation fails); second call: valid key (succeeds)
    mockAgentsList
      .mockRejectedValueOnce(new Error('Invalid API key'))
      .mockResolvedValueOnce({ data: [] });

    const { mockPassword } = await setupManualPathPrompts({
      passwordReturnValues: ['sk-ant-bad-key', VALID_API_KEY],
    });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: false });

    // password was prompted twice (once for bad key, once for valid key)
    expect(vi.mocked(mockPassword)).toHaveBeenCalledTimes(2);
    expect(result.anthropicApiKey).toBe(VALID_API_KEY);
  });

  it('re-prompts multiple times until a valid key is entered', async () => {
    // Three failures, then success on fourth
    mockAgentsList
      .mockRejectedValueOnce(new Error('Auth failed'))
      .mockRejectedValueOnce(new Error('Auth failed'))
      .mockRejectedValueOnce(new Error('Auth failed'))
      .mockResolvedValueOnce({ data: [] });

    const { mockPassword } = await setupManualPathPrompts({
      passwordReturnValues: ['bad1', 'bad2', 'bad3', VALID_API_KEY],
    });

    await initSlack({ cwd: tmpDir });

    expect(vi.mocked(mockPassword)).toHaveBeenCalledTimes(4);
  });

  it('uses the validated key from the re-prompt loop in the result', async () => {
    mockAgentsList
      .mockRejectedValueOnce(new Error('Invalid key'))
      .mockResolvedValueOnce({ data: [] });

    await setupManualPathPrompts({ passwordReturnValues: ['sk-ant-bad', VALID_API_KEY] });

    const result = await initSlack({ cwd: tmpDir, skipEnvWrite: true });
    expect(result.anthropicApiKey).toBe(VALID_API_KEY);
  });

  it('existing key silently validated — still proceeds to prompt for app name', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { mockInput } = await setupManualPathPrompts({ passwordReturnValues: [] });

    await initSlack({ cwd: tmpDir });

    // input was called for app name (first prompt after key validation)
    expect(vi.mocked(mockInput)).toHaveBeenCalled();
    const firstInputCall = vi.mocked(mockInput).mock.calls[0];
    expect(firstInputCall[0]).toMatchObject({ message: expect.stringContaining('bot') });
  });

  it('writes ANTHROPIC_API_KEY to .env when not already present (interactive path)', async () => {
    await setupManualPathPrompts();

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_API_KEY);
  });

  it('does NOT overwrite existing ANTHROPIC_API_KEY in .env (interactive path)', async () => {
    const existingKey = 'sk-ant-api03-already-saved-key-987654321';
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${existingKey}\n`,
      'utf-8',
    );

    // Key will be resolved from .env — no password prompt expected
    await setupManualPathPrompts({ passwordReturnValues: [] });

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(existingKey);
    expect(vi.mocked((await import('@inquirer/prompts')).password)).not.toHaveBeenCalled();
  });
});
