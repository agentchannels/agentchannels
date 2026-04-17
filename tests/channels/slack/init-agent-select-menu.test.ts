/**
 * Tests for Sub-AC 8a: Agent select menu with sentinel options.
 *
 * Verifies that `selectOrCreateAgent` (triggered via the initSlack wizard when
 * the user selects "change" from the keep-or-change prompt) presents:
 *   - Agent name/id pairs fetched via client.beta.agents.list (up to 20)
 *   - '+ Create a new agent' sentinel (__create__)
 *   - '✏️  Paste ID manually' sentinel (__manual__)
 *
 * Also verifies the 'Paste ID manually' sub-flow:
 *   - Prompts for an agent ID via input()
 *   - Validates via beta.agents.retrieve
 *   - Returns the agent ID on success
 *   - Re-prompts on validation failure (never hard-exits on first bad ID)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack } from '../../../src/channels/slack/init.js';

// ────────────────────────── SDK Mock ──────────────────────────

const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsCreate = vi.fn();
// No-op environment stubs (environment code paths must not crash)
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

const EXISTING_AGENT_ID = 'agent_existing_abc123';
const EXISTING_AGENT_NAME = 'existing-agent';

const LISTED_AGENT_ID = 'agent_listed_xyz789';
const LISTED_AGENT_NAME = 'listed-agent';

const PASTED_AGENT_ID = 'agent_pasted_manually_999';
const PASTED_AGENT_NAME = 'pasted-agent';

function makeAgentResponse(id: string, name: string) {
  return { id, name, version: 1, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-agent-select-menu-test-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

/** Clear all Anthropic and Slack env vars to prevent host leakage. */
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

/**
 * Wire the Slack manual-path prompts that come AFTER the agent select step.
 * Appends: appName, appDescription, botToken, appToken, signingSecret inputs
 * and the setup-method select and save-to-.env confirm.
 */
async function wireTrailingSlackPrompts() {
  const { input, confirm, select } = await import('@inquirer/prompts');
  vi.mocked(input)
    .mockResolvedValueOnce('Test Bot')            // appName
    .mockResolvedValueOnce('A test bot')          // appDescription
    .mockResolvedValueOnce(VALID_BOT_TOKEN)       // botToken
    .mockResolvedValueOnce(VALID_APP_TOKEN)       // appToken
    .mockResolvedValueOnce(VALID_SIGNING_SECRET); // signingSecret
  vi.mocked(select).mockResolvedValueOnce('manual' as never); // setupMethod
  vi.mocked(confirm).mockResolvedValueOnce(true);             // save to .env
}

// ══════════════════════════════════════════════════════════════════════════════
// Select menu structure
// ══════════════════════════════════════════════════════════════════════════════

describe('selectOrCreateAgent — menu structure (Sub-AC 8a)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // Default: auth validation returns empty list
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('shows agent name/id pairs fetched via client.beta.agents.list in the menu', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation (limit: 1)
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] }); // listing
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)        // keep/change → change
      .mockResolvedValueOnce(LISTED_AGENT_ID as never); // pick the listed agent
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // The second select call is the agent list menu
    const listMenuCall = vi.mocked(select).mock.calls[1][0] as {
      message: string;
      choices: Array<{ name: string; value: string }>;
    };
    const choiceValues = listMenuCall.choices.map((c) => c.value);
    expect(choiceValues).toContain(LISTED_AGENT_ID);

    const choiceNames = listMenuCall.choices.map((c) => c.name);
    const agentEntry = choiceNames.find((n) => n.includes(LISTED_AGENT_NAME));
    expect(agentEntry).toBeDefined();
    expect(agentEntry).toContain(LISTED_AGENT_ID);
  });

  it('fetches agents with limit: 20 via client.beta.agents.list', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    // First call: auth; second call: listAgents
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce(LISTED_AGENT_ID as never);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // Verify the second agents.list call used limit: 20
    const listCalls = vi.mocked(mockAgentsList).mock.calls;
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    const listingCall = listCalls[1][0] as { limit?: number };
    expect(listingCall?.limit).toBe(20);
  });

  it('menu includes "Create new agent" sentinel option', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce(LISTED_AGENT_ID as never);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const listMenuCall = vi.mocked(select).mock.calls[1][0] as {
      choices: Array<{ name: string; value: string }>;
    };
    const choiceValues = listMenuCall.choices.map((c) => c.value);
    expect(choiceValues).toContain('__create__');
  });

  it('menu includes "Paste ID manually" sentinel option', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce(LISTED_AGENT_ID as never);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const listMenuCall = vi.mocked(select).mock.calls[1][0] as {
      choices: Array<{ name: string; value: string }>;
    };
    const choiceValues = listMenuCall.choices.map((c) => c.value);
    expect(choiceValues).toContain('__manual__');
  });

  it('menu includes both Create new agent and Paste ID manually sentinel options together', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce(LISTED_AGENT_ID as never);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const listMenuCall = vi.mocked(select).mock.calls[1][0] as {
      choices: Array<{ name: string; value: string }>;
    };
    const choiceValues = listMenuCall.choices.map((c) => c.value);
    expect(choiceValues).toContain('__create__');
    expect(choiceValues).toContain('__manual__');
  });

  it('sentinel options appear after the agent entries in the menu', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce(LISTED_AGENT_ID as never);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const listMenuCall = vi.mocked(select).mock.calls[1][0] as {
      choices: Array<{ name: string; value: string }>;
    };
    const values = listMenuCall.choices.map((c) => c.value);
    const agentIdx = values.indexOf(LISTED_AGENT_ID);
    const createIdx = values.indexOf('__create__');
    const manualIdx = values.indexOf('__manual__');

    // Real agents must appear before sentinels
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(agentIdx);
    expect(manualIdx).toBeGreaterThan(agentIdx);
  });

  it('returns the selected existing agent ID directly from the menu', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce(LISTED_AGENT_ID as never); // select the listed agent
    await wireTrailingSlackPrompts();

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).toBe(LISTED_AGENT_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Paste ID manually sub-flow
// ══════════════════════════════════════════════════════════════════════════════

describe('selectOrCreateAgent — Paste ID manually sentinel (Sub-AC 8a)', () => {
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

  it('selecting __manual__ prompts the user for an agent ID via input()', async () => {
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME)) // keep/change validate
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));    // paste validate
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)   // keep/change → change
      .mockResolvedValueOnce('__manual__' as never); // select Paste ID manually
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_AGENT_ID)     // agent ID (paste sub-flow)
      .mockResolvedValueOnce('Test Bot')           // appName
      .mockResolvedValueOnce('A test bot')         // appDescription
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    const { confirm } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('manual' as never);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // input() must have been called — first call should be for the agent ID
    const inputCalls = vi.mocked(input).mock.calls;
    expect(inputCalls.length).toBeGreaterThanOrEqual(1);
    // The first input call (paste sub-flow) should ask for an agent ID
    const firstInputArg = inputCalls[0][0] as { message: string };
    expect(firstInputArg.message.toLowerCase()).toMatch(/agent.*id|id/i);
  });

  it('validates the pasted ID via beta.agents.retrieve', async () => {
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce('__manual__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_AGENT_ID)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // retrieve must have been called with the pasted ID
    expect(mockAgentsRetrieve).toHaveBeenCalledWith(PASTED_AGENT_ID);
  });

  it('returns the pasted agent ID when validation succeeds', async () => {
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce('__manual__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_AGENT_ID)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).toBe(PASTED_AGENT_ID);
  });

  it('writes the pasted agent ID to .env after successful validation', async () => {
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce('__manual__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(PASTED_AGENT_ID)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const envPath = path.join(tmpDir, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const envContent = fs.readFileSync(envPath, 'utf-8');
    expect(envContent).toContain(`CLAUDE_AGENT_ID=${PASTED_AGENT_ID}`);
  });

  it('re-prompts for agent ID when validation fails the first time (never hard-exits)', async () => {
    const SECOND_ATTEMPT_ID = 'agent_second_attempt_222';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME)) // keep/change validate
      .mockRejectedValueOnce(new Error('not found'))                                     // paste attempt 1 fails
      .mockResolvedValueOnce(makeAgentResponse(SECOND_ATTEMPT_ID, 'second-agent'));       // paste attempt 2 succeeds
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce('__manual__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('agent_bad_id_111')    // first paste attempt (will fail)
      .mockResolvedValueOnce(SECOND_ATTEMPT_ID)     // second paste attempt (succeeds)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // Second attempt ID is returned — not the failed first attempt
    expect(result.agentId).toBe(SECOND_ATTEMPT_ID);
    // retrieve was called twice for paste (once failing, once succeeding)
    const retrieveCalls = vi.mocked(mockAgentsRetrieve).mock.calls;
    // First call: validate existing ID; then two more for paste attempts
    expect(retrieveCalls.length).toBe(3);
  });

  it('warns when pasted ID is invalid (transparent_stale_state_handling)', async () => {
    const VALID_SECOND_ID = 'agent_valid_second_333';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404 not found'))
      .mockResolvedValueOnce(makeAgentResponse(VALID_SECOND_ID, 'valid-second'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input, confirm } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)
      .mockResolvedValueOnce('__manual__' as never)
      .mockResolvedValueOnce('manual' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('agent_invalid_000')  // first paste (invalid)
      .mockResolvedValueOnce(VALID_SECOND_ID)       // second paste (valid)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const warnings = warnSpy.mock.calls.map((c) => c.join(' '));
    const hasInvalidWarning = warnings.some(
      (msg) =>
        msg.toLowerCase().includes('not found') ||
        msg.toLowerCase().includes('inaccessible') ||
        msg.toLowerCase().includes('invalid'),
    );
    expect(hasInvalidWarning).toBe(true);
  });
});
