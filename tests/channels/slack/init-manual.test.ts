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

// ────────────────────────── Helpers ──────────────────────────

const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';

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

/** Save and wipe all Slack-related env vars to prevent host environment leakage */
function isolateSlackEnv(): () => void {
  const keys = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_REFRESH_TOKEN'];
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
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('writes all three tokens to .env when all are provided via options', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
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
    // Write a pre-existing .env
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
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
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('throws descriptive error when no credentials provided', async () => {
    await expect(
      initSlackNonInteractive({ cwd: tmpDir }),
    ).rejects.toThrow(/Non-interactive mode requires/);
  });

  it('throws when only bot token is provided (incomplete manual set)', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        slackBotToken: VALID_BOT_TOKEN,
      }),
    ).rejects.toThrow(/Non-interactive mode requires/);
  });

  it('throws when only bot and app tokens are provided (missing signing secret)', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
      }),
    ).rejects.toThrow(/Non-interactive mode requires/);
  });

  it('error message lists both manual and auto path credential requirements', async () => {
    await expect(
      initSlackNonInteractive({ cwd: tmpDir }),
    ).rejects.toThrow(/SLACK_BOT_TOKEN.*SLACK_APP_TOKEN.*SLACK_SIGNING_SECRET|SLACK_REFRESH_TOKEN/s);
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
