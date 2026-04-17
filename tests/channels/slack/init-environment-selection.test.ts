/**
 * Tests for AC 9: Environment selection sub-flow in init-slack wizard.
 *
 * AC 9: Environment selection lists up to 20 via beta.environments.list,
 *   user can pick one, create (name + optional description), or paste a raw ID.
 *
 * These tests exercise the `selectOrCreateEnvironment` and related sub-flows
 * via the interactive `initSlack` path.  We trigger the selection sub-flow by
 * providing a stale CLAUDE_ENVIRONMENT_ID (so retrieve fails and we fall through
 * to selection) and then driving the subsequent prompts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack } from '../../../src/channels/slack/init.js';

// ────────────────────────── SDK Mock ──────────────────────────

const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockEnvironmentsRetrieve = vi.fn();
const mockEnvironmentsList = vi.fn();
const mockEnvironmentsCreate = vi.fn();

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
        list: mockEnvironmentsList,
        create: mockEnvironmentsCreate,
      },
    };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

// ────────────────────────── Prompt Mocks ──────────────────────────

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

const STALE_ENV_ID = 'env_stale_gone_999';
const ENV_A_ID = 'env_aaaaa_111111';
const ENV_A_NAME = 'production-env';
const ENV_B_ID = 'env_bbbbb_222222';
const ENV_B_NAME = 'staging-env';

function makeEnvResponse(id: string, name: string) {
  return { id, name, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-env-sel-test-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function readEnvFile(dir: string): Record<string, string> {
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

// ────────────────────────── Helpers ──────────────────────────

/**
 * Wire the minimum set of @inquirer/prompts responses for the Slack setup steps
 * that come AFTER the environment selection step.
 *
 * No CLAUDE_AGENT_ID is set, so the agent step is skipped.
 * Prompt order after environment selection:
 *   input[0]: appName
 *   input[1]: appDescription
 *   select[n]: 'manual' (setup method)
 *   input[2..4]: botToken, appToken, signingSecret
 *   confirm[0]: true (save credentials)
 */
async function wireSlackManualPrompts() {
  const { input, confirm, select } = await import('@inquirer/prompts');
  vi.mocked(input)
    .mockResolvedValueOnce('Test Bot')           // appName
    .mockResolvedValueOnce('A test bot')         // appDescription
    .mockResolvedValueOnce(VALID_BOT_TOKEN)      // botToken
    .mockResolvedValueOnce(VALID_APP_TOKEN)      // appToken
    .mockResolvedValueOnce(VALID_SIGNING_SECRET); // signingSecret
  vi.mocked(select).mockResolvedValueOnce('manual' as never);
  vi.mocked(confirm).mockResolvedValueOnce(true);
}

// ══════════════════════════════════════════════════════════════════════════════
// Listing environments: limit:20, picking from list
// ══════════════════════════════════════════════════════════════════════════════

describe('selectOrCreateEnvironment — list up to 20, pick from list', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // validateAuth always succeeds
    mockAgentsList.mockResolvedValue({ data: [] });
    // Default: stale retrieve so we fall through to selection sub-flow
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('calls beta.environments.list when entering the selection sub-flow', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never); // pick env
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockEnvironmentsList).toHaveBeenCalled();
  });

  it('calls beta.environments.list with limit:20', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never);
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockEnvironmentsList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('presents all listed environments as choices in the select prompt', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME), makeEnvResponse(ENV_B_ID, ENV_B_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never);
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    // The first select call is the environment selection
    const firstSelectArgs = vi.mocked(select).mock.calls[0][0] as {
      choices: Array<{ value: string }>;
    };
    const choiceValues = firstSelectArgs.choices.map((c) => c.value);
    expect(choiceValues).toContain(ENV_A_ID);
    expect(choiceValues).toContain(ENV_B_ID);
  });

  it('includes "+ Create a new environment" in the choices', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never);
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    const firstSelectArgs = vi.mocked(select).mock.calls[0][0] as {
      choices: Array<{ value: string; name: string }>;
    };
    const createChoice = firstSelectArgs.choices.find((c) => c.value === '__create__');
    expect(createChoice).toBeDefined();
  });

  it('includes "Paste an environment ID" in the choices', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never);
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    const firstSelectArgs = vi.mocked(select).mock.calls[0][0] as {
      choices: Array<{ value: string; name: string }>;
    };
    const pasteChoice = firstSelectArgs.choices.find((c) => c.value === '__paste__');
    expect(pasteChoice).toBeDefined();
  });

  it('returns the picked environment ID when user selects one from the list', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME), makeEnvResponse(ENV_B_ID, ENV_B_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_B_ID as never); // pick ENV_B
    await wireSlackManualPrompts();

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(ENV_B_ID);
  });

  it('writes the picked environment ID to .env', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never);
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    const env = readEnvFile(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(ENV_A_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Create new environment: name + description prompts
// ══════════════════════════════════════════════════════════════════════════════

describe('selectOrCreateEnvironment — create new environment (name + description)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  const CREATED_ENV_ID = 'env_newly_created_333';
  const CREATED_ENV_NAME = 'my-new-env';

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('prompts for name when creating a new environment', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsCreate.mockResolvedValue(
      makeEnvResponse(CREATED_ENV_ID, CREATED_ENV_NAME),
    );
    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__create__' as never) // environment: create
      .mockResolvedValueOnce('manual' as never);    // setup method
    vi.mocked(input)
      .mockResolvedValueOnce(CREATED_ENV_NAME)      // env name
      .mockResolvedValueOnce('')                    // env description (empty → skip)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    // The name prompt must have been shown
    const nameCalls = vi.mocked(input).mock.calls.filter(
      (call) => (call[0] as { message: string }).message.toLowerCase().includes('name'),
    );
    expect(nameCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('prompts for description when creating a new environment', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsCreate.mockResolvedValue(
      makeEnvResponse(CREATED_ENV_ID, CREATED_ENV_NAME),
    );
    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__create__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(CREATED_ENV_NAME)
      .mockResolvedValueOnce('A staging environment') // non-empty description
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    // A description prompt must have been shown
    const descCalls = vi.mocked(input).mock.calls.filter(
      (call) => (call[0] as { message: string }).message.toLowerCase().includes('description'),
    );
    expect(descCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('passes the description to beta.environments.create', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsCreate.mockResolvedValue(
      makeEnvResponse(CREATED_ENV_ID, CREATED_ENV_NAME),
    );
    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__create__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(CREATED_ENV_NAME)
      .mockResolvedValueOnce('My staging environment')
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockEnvironmentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: CREATED_ENV_NAME,
        description: 'My staging environment',
      }),
    );
  });

  it('omits description from API call when user leaves it empty', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsCreate.mockResolvedValue(
      makeEnvResponse(CREATED_ENV_ID, CREATED_ENV_NAME),
    );
    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__create__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(CREATED_ENV_NAME)
      .mockResolvedValueOnce('')  // empty description → should be omitted
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockEnvironmentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: CREATED_ENV_NAME }),
    );
    // description must not be present (or be undefined) when user left it blank
    const createCall = mockEnvironmentsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.description).toBeFalsy();
  });

  it('returns the newly created environment ID', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsCreate.mockResolvedValue(
      makeEnvResponse(CREATED_ENV_ID, CREATED_ENV_NAME),
    );
    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__create__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(CREATED_ENV_NAME)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(CREATED_ENV_ID);
  });

  // ── Auto-jump to create when list is empty ────────────────────────────────

  it('auto-jumps to create without showing the selection prompt when the list is empty', async () => {
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(
      makeEnvResponse(CREATED_ENV_ID, CREATED_ENV_NAME),
    );
    const { select, input, confirm } = await import('@inquirer/prompts');
    // No selection prompt for environment — goes straight to name/description inputs
    vi.mocked(select).mockResolvedValueOnce('manual' as never); // only setup method select
    vi.mocked(input)
      .mockResolvedValueOnce(CREATED_ENV_NAME)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: CREATED_ENV_NAME }),
    );
    expect(result.environmentId).toBe(CREATED_ENV_ID);
    // Only one select call: the setup method — no environment pick select
    expect(vi.mocked(select).mock.calls.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Paste an environment ID
// ══════════════════════════════════════════════════════════════════════════════

describe('selectOrCreateEnvironment — paste an environment ID', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  const PASTED_ENV_ID = 'env_pasted_from_clipboard_444';
  const PASTED_ENV_NAME = 'clipboard-env';

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('offers a "Paste an environment ID" choice in the selection prompt', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    const { select } = await import('@inquirer/prompts');
    // Pick any valid env to complete the flow
    vi.mocked(select).mockResolvedValueOnce(ENV_A_ID as never);
    await wireSlackManualPrompts();

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    const firstSelectArgs = vi.mocked(select).mock.calls[0][0] as {
      choices: Array<{ value: string; name: string }>;
    };
    const pasteChoice = firstSelectArgs.choices.find((c) => c.value === '__paste__');
    expect(pasteChoice).toBeDefined();
    // Label should mention pasting
    expect(pasteChoice!.name.toLowerCase()).toMatch(/paste|id/i);
  });

  it('validates the pasted ID via beta.environments.retrieve', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    // Second retrieve call (for the pasted ID) succeeds
    mockEnvironmentsRetrieve
      .mockRejectedValueOnce(new Error('stale'))   // 1st call: existing ID stale
      .mockResolvedValueOnce(makeEnvResponse(PASTED_ENV_ID, PASTED_ENV_NAME)); // 2nd: pasted valid

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__paste__' as never) // choose paste
      .mockResolvedValueOnce('manual' as never);   // setup method
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_ENV_ID)        // pasted ID
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    // retrieve is called once for the stale existing ID, then once for the pasted ID
    expect(mockEnvironmentsRetrieve).toHaveBeenCalledWith(PASTED_ENV_ID);
  });

  it('returns the pasted (validated) environment ID', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsRetrieve
      .mockRejectedValueOnce(new Error('stale'))
      .mockResolvedValueOnce(makeEnvResponse(PASTED_ENV_ID, PASTED_ENV_NAME));

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__paste__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_ENV_ID)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(PASTED_ENV_ID);
  });

  it('writes the pasted environment ID to .env', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsRetrieve
      .mockRejectedValueOnce(new Error('stale'))
      .mockResolvedValueOnce(makeEnvResponse(PASTED_ENV_ID, PASTED_ENV_NAME));

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__paste__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_ENV_ID)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeEnvironmentId: STALE_ENV_ID, anthropicApiKey: VALID_API_KEY });

    const env = readEnvFile(tmpDir);
    expect(env.CLAUDE_ENVIRONMENT_ID).toBe(PASTED_ENV_ID);
  });

  it('re-prompts when pasted ID fails validation and succeeds on second attempt', async () => {
    mockEnvironmentsList.mockResolvedValue({
      data: [makeEnvResponse(ENV_A_ID, ENV_A_NAME)],
    });
    mockEnvironmentsRetrieve
      .mockRejectedValueOnce(new Error('stale'))           // existing ID stale
      .mockRejectedValueOnce(new Error('not found'))       // 1st paste attempt invalid
      .mockResolvedValueOnce(makeEnvResponse(PASTED_ENV_ID, PASTED_ENV_NAME)); // 2nd valid

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('__paste__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('env_invalid_first_try')  // 1st paste — fails validation
      .mockResolvedValueOnce(PASTED_ENV_ID)             // 2nd paste — succeeds
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(PASTED_ENV_ID);
  });
});
