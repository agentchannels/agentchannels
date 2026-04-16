import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive } from '../../../src/channels/slack/init.js';

// ────────────────────────── Mocks ──────────────────────────

// Mock @inquirer/prompts so the manual path tests don't accidentally block on prompts
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
}));

// Mock OAuth and Slack API modules (not used in manual path, but imported by init.ts)
vi.mock('../../../src/channels/slack/oauth.js', () => ({
  addRedirectUrl: vi.fn(),
  runOAuthInstall: vi.fn(),
}));

vi.mock('../../../src/channels/slack/api.js', () => ({
  SlackApiClient: vi.fn(),
  SlackApiRequestError: class SlackApiRequestError extends Error {},
}));

// Mock @anthropic-ai/sdk so API key validation doesn't make live network calls
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

// ────────────────────────── Helpers ──────────────────────────

const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';
const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';

/**
 * Creates a temporary directory and returns its path plus a cleanup function.
 */
function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-init-manual-test-'));
  return {
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Read the .env file from the given directory as key-value pairs.
 */
function readEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      result[match[1].trim()] = match[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return result;
}

// ────────────────────────── Tests: initSlackNonInteractive (manual path) ──────────────────────────

/** Save and wipe all Slack-related and Anthropic env vars to prevent host environment leakage */
function isolateSlackEnv(): () => void {
  const keys = [
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_REFRESH_TOKEN',
    'ANTHROPIC_API_KEY', 'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID', 'CLAUDE_VAULT_IDS',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  };
}

describe('initSlackNonInteractive — manual path', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateSlackEnv();
    // API key validation succeeds by default
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('writes all three tokens to .env when all are provided via options', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    expect(result.appToken).toBe(VALID_APP_TOKEN);
    expect(result.signingSecret).toBe(VALID_SIGNING_SECRET);
    expect(result.envWritten).toBe(true);

    const env = readEnv(tmpDir);
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
    expect(env.SLACK_APP_TOKEN).toBe(VALID_APP_TOKEN);
    expect(env.SLACK_SIGNING_SECRET).toBe(VALID_SIGNING_SECRET);
  });

  it('writes tokens to .env when credentials come from environment variables', async () => {
    // isolateSlackEnv cleared them; set the test values now
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.SLACK_BOT_TOKEN = VALID_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = VALID_APP_TOKEN;
    process.env.SLACK_SIGNING_SECRET = VALID_SIGNING_SECRET;

    const result = await initSlackNonInteractive({ cwd: tmpDir });

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    expect(result.appToken).toBe(VALID_APP_TOKEN);
    expect(result.signingSecret).toBe(VALID_SIGNING_SECRET);
    expect(result.envWritten).toBe(true);
  });

  it('reads tokens from existing .env file when not provided via options or env', async () => {
    // Write a pre-existing .env (including API key so non-interactive validation passes)
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        `ANTHROPIC_API_KEY=${VALID_API_KEY}`,
        `SLACK_BOT_TOKEN=${VALID_BOT_TOKEN}`,
        `SLACK_APP_TOKEN=${VALID_APP_TOKEN}`,
        `SLACK_SIGNING_SECRET=${VALID_SIGNING_SECRET}`,
      ].join('\n') + '\n',
      'utf-8',
    );

    const result = await initSlackNonInteractive({ cwd: tmpDir });

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    expect(result.appToken).toBe(VALID_APP_TOKEN);
    expect(result.signingSecret).toBe(VALID_SIGNING_SECRET);
    expect(result.envWritten).toBe(true);
  });

  it('CLI flag options override environment variables (three-source precedence)', async () => {
    // Set a different bot token in env — the option override should win
    process.env.SLACK_BOT_TOKEN = 'xoxb-env-token-should-be-overridden-1234';

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,  // CLI flag wins
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    const env = readEnv(tmpDir);
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
  });

  it('does not write .env when skipEnvWrite is true', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    expect(result.envWritten).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
  });

  it('does not invoke any interactive prompts', async () => {
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(vi.mocked(input)).not.toHaveBeenCalled();
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(password)).not.toHaveBeenCalled();
  });

  it('merges new tokens with existing .env keys (does not clobber unrelated keys)', async () => {
    // Pre-existing .env with an unrelated key
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'ANTHROPIC_API_KEY=sk-ant-existing-key\n',
      'utf-8',
    );

    await initSlackNonInteractive({
      cwd: tmpDir,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-existing-key');
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
  });
});

// ────────────────────────── Tests: token validation ──────────────────────────

describe('initSlackNonInteractive — token validation', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateSlackEnv();
    // API key validation succeeds so errors reach Slack token validation
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('throws when SLACK_BOT_TOKEN does not start with xoxb-', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: 'wrong-prefix-token-1234567890',
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow('xoxb-');
  });

  it('throws when SLACK_BOT_TOKEN is too short', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: 'xoxb-short',
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/too short/i);
  });

  it('throws when SLACK_APP_TOKEN does not start with xapp-', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: 'wrong-prefix-token-1234567890',
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow('xapp-');
  });

  it('throws when SLACK_APP_TOKEN is too short', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: 'xapp-short',
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/too short/i);
  });

  it('throws when SLACK_SIGNING_SECRET is empty', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: '   ',
      }),
    ).rejects.toThrow(/required/i);
  });

  it('throws when SLACK_SIGNING_SECRET is too short', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: 'short',
      }),
    ).rejects.toThrow(/too short/i);
  });
});

// ────────────────────────── Tests: insufficient credentials ──────────────────────────

describe('initSlackNonInteractive — insufficient credentials', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateSlackEnv();
    // API key validation succeeds so errors reach Slack credential checks
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('throws descriptive error when no Slack credentials provided', async () => {
    await expect(
      initSlackNonInteractive({ cwd: tmpDir, anthropicApiKey: VALID_API_KEY }),
    ).rejects.toThrow(/Non-interactive mode requires/);
  });

  it('throws when only bot token is provided (incomplete manual set)', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
      }),
    ).rejects.toThrow(/Non-interactive mode is missing required fields/);
  });

  it('throws when only bot and app tokens are provided (missing signing secret)', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
      }),
    ).rejects.toThrow(/Non-interactive mode is missing required field/);
  });

  it('error message lists both manual and auto path credential requirements', async () => {
    await expect(
      initSlackNonInteractive({ cwd: tmpDir, anthropicApiKey: VALID_API_KEY }),
    ).rejects.toThrow(/SLACK_BOT_TOKEN.*SLACK_APP_TOKEN.*SLACK_SIGNING_SECRET|SLACK_REFRESH_TOKEN/s);
  });

  it('throws ANTHROPIC_API_KEY required error when API key is absent', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
        // no anthropicApiKey
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is required/);
  });
});

// ────────────────────────── Tests: initSlack --non-interactive passthrough ──────────────────────────

describe('initSlack with nonInteractive: true', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateSlackEnv();
    // API key validation succeeds by default
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('delegates to non-interactive path when nonInteractive: true', async () => {
    const result = await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    expect(result.appToken).toBe(VALID_APP_TOKEN);
    expect(result.signingSecret).toBe(VALID_SIGNING_SECRET);
    expect(result.envWritten).toBe(true);
  });

  it('does not prompt when nonInteractive: true and all credentials provided', async () => {
    const { input, confirm, select, password } = await import('@inquirer/prompts');

    await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
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

// ────────────────────────── Interactive manual path helper ──────────────────────────

/**
 * Wire prompt mocks for the interactive wizard when user selects the 'manual'
 * Slack setup method (no CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID, or CLAUDE_VAULT_IDS).
 *
 * Prompt call order:
 *   input[0]   — app name
 *   input[1]   — app description
 *   select[0]  — setup method → 'manual'
 *   input[2]   — bot token (xoxb-...)
 *   input[3]   — app token (xapp-...)
 *   input[4]   — signing secret
 *   confirm[0] — save to .env?
 */
async function wireInteractiveManualPath(overrides: {
  appName?: string;
  appDescription?: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  confirmSave?: boolean;
} = {}) {
  const { input: mockInput, confirm: mockConfirm, select: mockSelect } =
    await import('@inquirer/prompts');
  vi.mocked(mockInput)
    .mockResolvedValueOnce(overrides.appName ?? 'Test Bot')
    .mockResolvedValueOnce(overrides.appDescription ?? 'A test bot')
    .mockResolvedValueOnce(overrides.botToken ?? VALID_BOT_TOKEN)
    .mockResolvedValueOnce(overrides.appToken ?? VALID_APP_TOKEN)
    .mockResolvedValueOnce(overrides.signingSecret ?? VALID_SIGNING_SECRET);
  vi.mocked(mockSelect).mockResolvedValueOnce('manual' as never);
  vi.mocked(mockConfirm).mockResolvedValueOnce(
    overrides.confirmSave !== undefined ? overrides.confirmSave : true,
  );
}

// ────────────────────────── Tests: initSlack interactive — manual setup method ──────────────────────────

describe('initSlack (interactive) — manual setup method', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateSlackEnv();
    // API key validation uses agents.list internally (validateAuth)
    mockAgentsList.mockResolvedValue({ data: [] });
    // API key in process.env so the password prompt is skipped
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  // ── Prompt sequence ──────────────────────────────────────────────────────────

  it('collects bot token, app token, and signing secret via exactly 5 input() calls', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    // appName, appDescription, botToken, appToken, signingSecret
    expect(vi.mocked(input)).toHaveBeenCalledTimes(5);
  });

  it('bot token prompt message contains "xoxb-"', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    // input[2] is the bot token prompt (0: appName, 1: appDesc, 2: botToken)
    const botTokenArg = vi.mocked(input).mock.calls[2][0] as { message: string };
    expect(botTokenArg.message).toMatch(/xoxb/);
  });

  it('app token prompt message contains "xapp-"', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    // input[3] is the app token prompt
    const appTokenArg = vi.mocked(input).mock.calls[3][0] as { message: string };
    expect(appTokenArg.message).toMatch(/xapp/);
  });

  it('signing secret prompt message asks for "Signing Secret"', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    // input[4] is the signing secret prompt
    const signingArg = vi.mocked(input).mock.calls[4][0] as { message: string };
    expect(signingArg.message.toLowerCase()).toMatch(/signing secret/);
  });

  it('select prompt includes manual, automatic, and guided as choices', async () => {
    const { select } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const setupMethodArg = vi.mocked(select).mock.calls[0][0] as {
      message: string;
      choices: Array<{ value: string }>;
    };
    const choiceValues = setupMethodArg.choices.map((c) => c.value);
    expect(choiceValues).toContain('manual');
    expect(choiceValues).toContain('automatic');
    expect(choiceValues).toContain('guided');
  });

  it('presents exactly one select prompt when no agent/environment IDs are configured', async () => {
    const { select } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    expect(vi.mocked(select)).toHaveBeenCalledTimes(1);
  });

  // ── No Slack API calls ───────────────────────────────────────────────────────

  it('does not instantiate SlackApiClient (no token rotation or API app creation)', async () => {
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const { SlackApiClient } = await import('../../../src/channels/slack/api.js');
    expect(vi.mocked(SlackApiClient)).not.toHaveBeenCalled();
  });

  it('does not call runOAuthInstall (no OAuth workspace-install flow)', async () => {
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const { runOAuthInstall } = await import('../../../src/channels/slack/oauth.js');
    expect(vi.mocked(runOAuthInstall)).not.toHaveBeenCalled();
  });

  it('does not call addRedirectUrl (no redirect URL registration needed)', async () => {
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const { addRedirectUrl } = await import('../../../src/channels/slack/oauth.js');
    expect(vi.mocked(addRedirectUrl)).not.toHaveBeenCalled();
  });

  // ── Result ───────────────────────────────────────────────────────────────────

  it('result contains the entered bot token, app token, and signing secret', async () => {
    await wireInteractiveManualPath();

    const result = await initSlack({ cwd: tmpDir });

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    expect(result.appToken).toBe(VALID_APP_TOKEN);
    expect(result.signingSecret).toBe(VALID_SIGNING_SECRET);
  });

  it('result contains the entered app name and description', async () => {
    await wireInteractiveManualPath({ appName: 'My Agent Bot', appDescription: 'Helpful agent' });

    const result = await initSlack({ cwd: tmpDir });

    expect(result.appName).toBe('My Agent Bot');
    expect(result.appDescription).toBe('Helpful agent');
  });

  it('result.envWritten is true when user confirms the save prompt', async () => {
    await wireInteractiveManualPath({ confirmSave: true });

    const result = await initSlack({ cwd: tmpDir });

    expect(result.envWritten).toBe(true);
  });

  it('result.envWritten is false when user declines the save prompt', async () => {
    await wireInteractiveManualPath({ confirmSave: false });

    const result = await initSlack({ cwd: tmpDir });

    expect(result.envWritten).toBe(false);
  });

  // ── .env output ──────────────────────────────────────────────────────────────

  it('writes SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET to .env', async () => {
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.SLACK_BOT_TOKEN).toBe(VALID_BOT_TOKEN);
    expect(env.SLACK_APP_TOKEN).toBe(VALID_APP_TOKEN);
    expect(env.SLACK_SIGNING_SECRET).toBe(VALID_SIGNING_SECRET);
  });

  it('does not create .env when user declines to save', async () => {
    await wireInteractiveManualPath({ confirmSave: false });

    await initSlack({ cwd: tmpDir });

    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
  });

  it('writes ANTHROPIC_API_KEY to .env when not already present in .env file', async () => {
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_API_KEY);
  });

  it('does not overwrite ANTHROPIC_API_KEY already present in .env file', async () => {
    const existingKey = 'sk-ant-already-in-dotenv-file-111';
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${existingKey}\n`,
      'utf-8',
    );
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.ANTHROPIC_API_KEY).toBe(existingKey);
  });

  // ── Inline validators ────────────────────────────────────────────────────────

  it('bot token validator rejects strings not starting with xoxb-', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const botTokenArg = vi.mocked(input).mock.calls[2][0] as {
      validate?: (v: string) => boolean | string;
    };
    expect(botTokenArg.validate?.('wrong-prefix-1234567890')).not.toBe(true);
  });

  it('bot token validator accepts valid xoxb- token', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const botTokenArg = vi.mocked(input).mock.calls[2][0] as {
      validate?: (v: string) => boolean | string;
    };
    expect(botTokenArg.validate?.(VALID_BOT_TOKEN)).toBe(true);
  });

  it('app token validator rejects strings not starting with xapp-', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const appTokenArg = vi.mocked(input).mock.calls[3][0] as {
      validate?: (v: string) => boolean | string;
    };
    expect(appTokenArg.validate?.('wrong-prefix-1234567890')).not.toBe(true);
  });

  it('app token validator accepts valid xapp- token', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const appTokenArg = vi.mocked(input).mock.calls[3][0] as {
      validate?: (v: string) => boolean | string;
    };
    expect(appTokenArg.validate?.(VALID_APP_TOKEN)).toBe(true);
  });

  it('signing secret validator rejects empty and whitespace-only strings', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const signingArg = vi.mocked(input).mock.calls[4][0] as {
      validate?: (v: string) => boolean | string;
    };
    expect(signingArg.validate?.('')).not.toBe(true);
    expect(signingArg.validate?.('   ')).not.toBe(true);
  });

  it('signing secret validator accepts a non-empty secret', async () => {
    const { input } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    const signingArg = vi.mocked(input).mock.calls[4][0] as {
      validate?: (v: string) => boolean | string;
    };
    expect(signingArg.validate?.(VALID_SIGNING_SECRET)).toBe(true);
  });

  // ── No password prompt ───────────────────────────────────────────────────────

  it('does not call password() when ANTHROPIC_API_KEY is already in process.env', async () => {
    const { password } = await import('@inquirer/prompts');
    await wireInteractiveManualPath();

    await initSlack({ cwd: tmpDir });

    expect(vi.mocked(password)).not.toHaveBeenCalled();
  });
});
