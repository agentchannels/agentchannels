/**
 * Sub-AC 2: Unit tests for environment empty-list auto-create.
 *
 * When `client.beta.environments.list()` returns an empty array, the wizard
 * must automatically route to the environment creation flow — no
 * "Select an environment" prompt is ever rendered.
 *
 * Core assertion in every test:
 *   mockEnvironmentsList returns { data: [] }  →  mockEnvironmentsCreate IS called
 *
 * Two entry points into selectOrCreateEnvironment are exercised so the assertion
 * holds regardless of which upstream path brought us here:
 *
 *   A) "change" path  — valid existing env ID → user picks "change"
 *   B) "stale" path   — existing env ID fails validation → auto-falls through
 *
 * These are the only paths that reach selectOrCreateEnvironment in the current
 * implementation (environment selection is only activated when an existing
 * CLAUDE_ENVIRONMENT_ID is present in config).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack } from '../../../src/channels/slack/init.js';

// ─────────────────────────── SDK mock ────────────────────────────────────────

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

// ─────────────────────────── Prompt / OAuth mocks ────────────────────────────

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

// ─────────────────────────── Test fixtures ────────────────────────────────────

const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';
const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';

const EXISTING_ENV_ID = 'env_existing_abc123';
const EXISTING_ENV_NAME = 'existing-env';
const STALE_ENV_ID = 'env_stale_zzz999';
const CREATED_ENV_ID = 'env_auto_created_001';

function makeEnv(id: string, name: string) {
  return { id, name, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-env-empty-ac2-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

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

/**
 * Wire the minimal prompts needed for the environment create sub-flow followed
 * by a manual Slack setup, so initSlack() completes successfully.
 *
 * create-flow prompts: name, description (skip)
 * slack prompts: appName, appDescription, botToken, appToken, signingSecret + setupMethod + confirm
 */
async function wireCreateThenSlack(envName = 'auto-created-env') {
  const { input, confirm, select } = await import('@inquirer/prompts');
  vi.mocked(input)
    .mockResolvedValueOnce(envName)             // environment name
    .mockResolvedValueOnce('')                  // environment description (skip)
    .mockResolvedValueOnce('Test Bot')          // Slack app name
    .mockResolvedValueOnce('A test bot')        // Slack app description
    .mockResolvedValueOnce(VALID_BOT_TOKEN)
    .mockResolvedValueOnce(VALID_APP_TOKEN)
    .mockResolvedValueOnce(VALID_SIGNING_SECRET);
  vi.mocked(select).mockResolvedValueOnce('manual' as never); // setup method
  vi.mocked(confirm).mockResolvedValueOnce(true);             // save to .env
}

// ═════════════════════════════════════════════════════════════════════════════
// Entry point A: "change" path
//   valid existing env ID → user picks "change" → list empty → auto-create
// ═════════════════════════════════════════════════════════════════════════════

describe('Sub-AC 2 — environments.list() empty → environments.create() called (via "change" path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // Auth validation uses agents.list internally
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('calls beta.environments.create when environments.list returns empty array', async () => {
    // Arrange
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnv(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] }); // empty → triggers auto-create
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never); // keep/change → change
    await wireCreateThenSlack();

    // Act
    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    // Assert: create IS called because list returned empty
    expect(mockEnvironmentsCreate).toHaveBeenCalled();
  });

  it('passes the user-entered name to beta.environments.create', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnv(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'my-test-env'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack('my-test-env');

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-test-env' }),
    );
  });

  it('result.environmentId is the ID returned by beta.environments.create', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnv(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack();

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(CREATED_ENV_ID);
  });

  it('beta.environments.create is called exactly once per invocation (change path)', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnv(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalledTimes(1);
  });

  it('does NOT render "Select an environment" when environments.list is empty (change path)', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnv(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const selectMessages = vi.mocked(select).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(selectMessages.some((m) =>
      m.toLowerCase().includes('select an environment'),
    )).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Entry point B: "stale" path
//   stale existing env ID → retrieve throws → list empty → auto-create
// ═════════════════════════════════════════════════════════════════════════════

describe('Sub-AC 2 — environments.list() empty → environments.create() called (via stale-ID path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Wire prompts for the stale path: no keep/change prompt (validation fails first),
   * then the create sub-flow + manual Slack setup.
   */
  async function wireStaleCreate(envName = 'auto-created-env') {
    // Stale path: no keep/change select, goes straight to create
    await wireCreateThenSlack(envName);
  }

  it('calls beta.environments.create when environments.list returns empty array (stale path)', async () => {
    // Arrange: retrieve throws (stale), list returns empty
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] }); // empty → auto-create
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));
    await wireStaleCreate();

    // Act
    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    // Assert
    expect(mockEnvironmentsCreate).toHaveBeenCalled();
  });

  it('passes the user-entered name to beta.environments.create (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'fresh-env'));
    await wireStaleCreate('fresh-env');

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fresh-env' }),
    );
  });

  it('result.environmentId is the ID returned by beta.environments.create (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));
    await wireStaleCreate();

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(CREATED_ENV_ID);
  });

  it('beta.environments.create is called exactly once per invocation (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));
    await wireStaleCreate();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalledTimes(1);
  });

  it('does NOT render "Select an environment" when environments.list is empty (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnv(CREATED_ENV_ID, 'auto-created-env'));
    await wireStaleCreate();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const { select } = await import('@inquirer/prompts');
    const selectMessages = vi.mocked(select).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(selectMessages.some((m) =>
      m.toLowerCase().includes('select an environment'),
    )).toBe(false);
  });
});
