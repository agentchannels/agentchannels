/**
 * AC 14: If any required ID is missing or invalid in non-interactive mode,
 * command exits non-zero with a clear error message naming the missing or invalid field.
 *
 * This test file verifies that every non-interactive failure path produces an error
 * message that explicitly names the missing or invalid field — never a generic
 * "something went wrong" message. All cases:
 *
 *   1. Missing ANTHROPIC_API_KEY         → error names "ANTHROPIC_API_KEY"
 *   2. Stale CLAUDE_AGENT_ID             → error names "CLAUDE_AGENT_ID" + the bad ID value
 *   3. Stale CLAUDE_ENVIRONMENT_ID       → error names "CLAUDE_ENVIRONMENT_ID" + the bad ID value
 *   4. Only SLACK_BOT_TOKEN provided     → error names "SLACK_APP_TOKEN" and "SLACK_SIGNING_SECRET"
 *   5. Bot + app token, no secret        → error names "SLACK_SIGNING_SECRET"
 *   6. App token + secret, no bot token  → error names "SLACK_BOT_TOKEN"
 *   7. No Slack credentials at all       → error lists both valid paths
 *
 * The tests use initSlackNonInteractive directly (the public-facing initSlack with
 * nonInteractive: true delegates to the same function).
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
        retrieve: vi.fn(),
      },
    };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

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

const VALID_AGENT_ID = 'agent_valid123';
const VALID_ENV_ID = 'env_valid123';
const STALE_AGENT_ID = 'agent_stale_gone_999';
const STALE_ENV_ID = 'env_stale_gone_999';

// ────────────────────────── Helpers ──────────────────────────

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-ni-missing-test-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

/** Clear all relevant env vars so the host environment cannot contaminate tests. */
function isolateEnv(): () => void {
  const keys = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_AGENT_ID',
    'CLAUDE_ENVIRONMENT_ID',
    'CLAUDE_VAULT_IDS',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    'SLACK_REFRESH_TOKEN',
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

// ────────────────────────────────────────────────────────────────────────────
// Suite 1: Missing ANTHROPIC_API_KEY
// ────────────────────────────────────────────────────────────────────────────

describe('AC 14 — missing ANTHROPIC_API_KEY', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('error message explicitly names ANTHROPIC_API_KEY when the key is absent', async () => {
    // No API key in options, env, or .env file
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('error message is actionable — tells the user how to provide the API key', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/env var|\.env|flag/i);
  });

  it('names ANTHROPIC_API_KEY even when Slack credentials are also missing', async () => {
    // API key check happens first, so it should fail on API key before Slack creds
    await expect(
      initSlackNonInteractive({ cwd: tmpDir }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 2: Invalid (stale) CLAUDE_AGENT_ID
// ────────────────────────────────────────────────────────────────────────────

describe('AC 14 — invalid CLAUDE_AGENT_ID', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // API key validation (beta.agents.list) succeeds
    mockAgentsList.mockResolvedValue({ data: [] });
    // Agent ID validation fails — simulates a stale/deleted agent
    mockAgentsRetrieve.mockRejectedValue(new Error('agent not found'));
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('error message explicitly names CLAUDE_AGENT_ID when the agent is stale', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/CLAUDE_AGENT_ID/);
  });

  it('error message includes the exact stale agent ID value', async () => {
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

  it('error message tells the user how to remediate the stale agent ID', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/Remove|provide|valid/i);
  });

  it('stale agent ID error is thrown before environment or vault checks', async () => {
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
    ).rejects.toThrow(/CLAUDE_AGENT_ID/);

    // Environment ID check must NOT have been called — agent threw first
    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 3: Invalid (stale) CLAUDE_ENVIRONMENT_ID
// ────────────────────────────────────────────────────────────────────────────

describe('AC 14 — invalid CLAUDE_ENVIRONMENT_ID', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // API key validation succeeds
    mockAgentsList.mockResolvedValue({ data: [] });
    // Agent ID is valid (so we reach environment validation)
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: 'my-agent', version: 1 });
    // Environment ID validation fails — simulates a stale/deleted environment
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('environment not found'));
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('error message explicitly names CLAUDE_ENVIRONMENT_ID when the environment is stale', async () => {
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
    ).rejects.toThrow(/CLAUDE_ENVIRONMENT_ID/);
  });

  it('error message includes the exact stale environment ID value', async () => {
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

  it('error message tells the user how to remediate the stale environment ID', async () => {
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
    ).rejects.toThrow(/Remove|set|valid/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 4: Partial Slack credentials — names the specific missing fields
// ────────────────────────────────────────────────────────────────────────────

describe('AC 14 — partial Slack credentials name the specific missing fields', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // API key validation succeeds
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('names SLACK_APP_TOKEN and SLACK_SIGNING_SECRET when only SLACK_BOT_TOKEN is provided', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      // slackAppToken and slackSigningSecret are absent
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/SLACK_APP_TOKEN/);
    expect(err.message).toMatch(/SLACK_SIGNING_SECRET/);
  });

  it('does NOT mention SLACK_BOT_TOKEN when bot token is already provided', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    // The error should name the missing fields, not the provided one
    expect(err.message).not.toMatch(/SLACK_BOT_TOKEN/);
  });

  it('names only SLACK_SIGNING_SECRET when bot and app tokens are provided', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      // slackSigningSecret is absent
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/SLACK_SIGNING_SECRET/);
    expect(err.message).not.toMatch(/SLACK_BOT_TOKEN/);
    expect(err.message).not.toMatch(/SLACK_APP_TOKEN/);
  });

  it('names only SLACK_BOT_TOKEN when app token and signing secret are provided', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      // slackBotToken is absent
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/SLACK_BOT_TOKEN/);
    expect(err.message).not.toMatch(/SLACK_APP_TOKEN/);
    expect(err.message).not.toMatch(/SLACK_SIGNING_SECRET/);
  });

  it('partial credential error is actionable — tells user how to provide the missing field', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/env var|\.env|flag/i);
  });

  it('partial credential error uses "field" (singular) when exactly one field is missing', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      // only signingSecret missing — exactly one field
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    // Should say "field" not "fields" when only one is missing
    expect(err.message).toMatch(/missing required field:/);
    expect(err.message).not.toMatch(/missing required fields:/);
  });

  it('partial credential error uses "fields" (plural) when two fields are missing', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      // appToken and signingSecret missing — two fields
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/missing required fields:/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 5: No Slack credentials at all — generic path-listing error
// ────────────────────────────────────────────────────────────────────────────

describe('AC 14 — no Slack credentials at all', () => {
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

  it('throws when no Slack credentials are provided', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        // no Slack tokens at all
      }),
    ).rejects.toThrow();
  });

  it('error message lists both valid credential paths when none are provided', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
      }),
    ).rejects.toThrow(/Non-interactive mode requires/);
  });

  it('error mentions SLACK_REFRESH_TOKEN as one option when no credentials are provided', async () => {
    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
      }),
    ).rejects.toThrow(/SLACK_REFRESH_TOKEN/);
  });

  it('error mentions the manual path tokens when no credentials are provided', async () => {
    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
    }).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/SLACK_BOT_TOKEN/);
    expect(err.message).toMatch(/SLACK_APP_TOKEN/);
    expect(err.message).toMatch(/SLACK_SIGNING_SECRET/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 6: Error ordering — agent check before environment before vault before Slack
// ────────────────────────────────────────────────────────────────────────────

describe('AC 14 — validation order: API key → agent → environment → Slack', () => {
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

  it('API key error fires before agent validation', async () => {
    // No API key provided — error must mention ANTHROPIC_API_KEY not CLAUDE_AGENT_ID
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: 'agent', version: 1 });

    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      // anthropicApiKey absent — must fail here
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    }).catch((e: unknown) => e as Error);

    expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(err.message).not.toMatch(/CLAUDE_AGENT_ID/);
    // Agent retrieve must NOT be called when API key fails first
    expect(mockAgentsRetrieve).not.toHaveBeenCalled();
  });

  it('agent error fires before environment validation', async () => {
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
    ).rejects.toThrow(/CLAUDE_AGENT_ID/);

    expect(mockEnvironmentsRetrieve).not.toHaveBeenCalled();
  });

  it('environment error fires before Slack credential checks', async () => {
    mockAgentsRetrieve.mockResolvedValue({ id: VALID_AGENT_ID, name: 'agent', version: 1 });
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));

    const err = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      claudeEnvironmentId: STALE_ENV_ID,
      // Intentionally missing Slack creds — should never reach that check
    }).catch((e: unknown) => e as Error);

    // Error should be about CLAUDE_ENVIRONMENT_ID, not Slack tokens
    expect(err.message).toMatch(/CLAUDE_ENVIRONMENT_ID/);
    expect(err.message).not.toMatch(/SLACK_BOT_TOKEN/);
    expect(err.message).not.toMatch(/Non-interactive mode requires/);
  });
});
