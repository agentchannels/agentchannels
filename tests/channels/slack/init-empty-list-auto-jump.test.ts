/**
 * Tests for AC 11: When the agent or environment list returns zero items,
 * wizard auto-routes to the Create flow without rendering an empty selection prompt.
 *
 * "minimize_user_clicks: Empty lists auto-jump to create" principle.
 *
 * Four scenarios are covered:
 *   1. Agent list empty → auto-jump to create  (via "change" path)
 *   2. Agent list empty → auto-jump to create  (via stale-ID path)
 *   3. Environment list empty → auto-jump to create (via "change" path)
 *   4. Environment list empty → auto-jump to create (via stale-ID path)
 *
 * Key assertion in every scenario: the "Select a Claude Managed Agent" /
 * "Select an environment" prompt is NEVER rendered — `select()` is not called
 * with that message.  The test verifies both the absence of the prompt and the
 * presence of the create API call.
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
const CREATED_AGENT_ID = 'agent_brand_new_111';
const STALE_AGENT_ID = 'agent_stale_gone_999';

const EXISTING_ENV_ID = 'env_existing_abc123';
const EXISTING_ENV_NAME = 'existing-env';
const CREATED_ENV_ID = 'env_brand_new_222';
const STALE_ENV_ID = 'env_stale_gone_888';

function makeAgentResponse(id: string, name: string) {
  return { id, name, version: 1 };
}

function makeEnvResponse(id: string, name: string) {
  return { id, name, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-empty-list-test-'));
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
 * Extract the `message` field from all `select()` calls observed so far.
 * Used to assert that a particular selection prompt was NOT rendered.
 */
async function allSelectMessages(): Promise<string[]> {
  const { select } = await import('@inquirer/prompts');
  return vi.mocked(select).mock.calls.map(
    (call) => (call[0] as { message: string }).message,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 1: Agent list empty — via "change" path
//
// Flow: valid existing agent → keep/change select → 'change' →
//       listAgents returns [] → auto-jump to createAgentInteractive (no list select)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC 11 — agent list empty → auto-jump to create (via "change" path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // validateAuth() succeeds (uses agents.list internally)
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Wire prompts for: change agent → create (name + desc + model + system) → manual Slack setup.
   * Empty agent list → createAgentInteractive receives: name, description (optional), model, systemPrompt (optional).
   */
  async function wireChangePathPrompts() {
    const { input, confirm, select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)            // keep/change → change
      .mockResolvedValueOnce('claude-sonnet-4-6' as never) // model (create flow)
      .mockResolvedValueOnce('manual' as never);            // setup method
    vi.mocked(input)
      .mockResolvedValueOnce('new-agent')    // agent name
      .mockResolvedValueOnce('')             // agent description (optional, skip)
      .mockResolvedValueOnce('')             // agent system prompt (optional, skip)
      .mockResolvedValueOnce('Test Bot')     // Slack app name
      .mockResolvedValueOnce('A test bot')   // Slack app description
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);
  }

  it('does not render a "Select a Claude Managed Agent" prompt when list is empty', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation
      .mockResolvedValueOnce({ data: [] }); // listAgents → empty
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireChangePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const messages = await allSelectMessages();
    const hasAgentListPrompt = messages.some((m) =>
      m.toLowerCase().includes('select a claude managed agent'),
    );
    expect(hasAgentListPrompt).toBe(false);
  });

  it('calls beta.agents.create when agent list is empty (via change path)', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireChangePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockAgentsCreate).toHaveBeenCalled();
  });

  it('returns the newly created agent ID in the result (via change path)', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireChangePathPrompts();

    const result = await initSlack({
      cwd: tmpDir,
      claudeAgentId: EXISTING_AGENT_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });

  it('does NOT call beta.agents.list a third time (list called exactly twice: auth + listing)', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireChangePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    // Exactly 2 calls: one for validateAuth, one for listAgents in selectOrCreateAgent
    expect(mockAgentsList).toHaveBeenCalledTimes(2);
  });

  it('select() is called at most for keep/change, model, and setup method — not for agent list pick', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireChangePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const messages = await allSelectMessages();
    // Expected: keep/change, model select, setup method (3 calls total, none for agent list)
    expect(messages).toHaveLength(3);
    // None of them should be the agent list prompt
    const agentListMessages = messages.filter((m) =>
      m.toLowerCase().includes('select a claude managed agent'),
    );
    expect(agentListMessages).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Agent list empty — via stale-ID path
//
// Flow: stale agent ID → retrieve throws → warn user → selectOrCreateAgent called →
//       listAgents returns [] → auto-jump to createAgentInteractive (no list select)
// ══════════════════════════════════════════════════════════════════════════════

describe('AC 11 — agent list empty → auto-jump to create (via stale-ID path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Wire prompts for: stale agent → (no keep/change, jumps straight to create) →
   * create (name + desc + model + system) → manual Slack setup.
   */
  async function wireStalePathPrompts() {
    const { input, confirm, select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('claude-sonnet-4-6' as never) // model (create flow — no keep/change select)
      .mockResolvedValueOnce('manual' as never);            // setup method
    vi.mocked(input)
      .mockResolvedValueOnce('new-agent')    // agent name
      .mockResolvedValueOnce('')             // agent description (skip)
      .mockResolvedValueOnce('')             // agent system prompt (skip)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);
  }

  it('does not render a "Select a Claude Managed Agent" prompt when list is empty (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found')); // stale
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation
      .mockResolvedValueOnce({ data: [] }); // listAgents → empty
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireStalePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const messages = await allSelectMessages();
    const hasAgentListPrompt = messages.some((m) =>
      m.toLowerCase().includes('select a claude managed agent'),
    );
    expect(hasAgentListPrompt).toBe(false);
  });

  it('calls beta.agents.create when agent list is empty (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireStalePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockAgentsCreate).toHaveBeenCalled();
  });

  it('returns the newly created agent ID in the result (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireStalePathPrompts();

    const result = await initSlack({
      cwd: tmpDir,
      claudeAgentId: STALE_AGENT_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });

  it('no "keep/change" select prompt is shown for the stale agent (skips straight to create)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireStalePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const messages = await allSelectMessages();
    const hasKeepChangePrompt = messages.some((m) =>
      m.toLowerCase().includes('keep') && m.toLowerCase().includes('change'),
    );
    expect(hasKeepChangePrompt).toBe(false);
  });

  it('select() is called exactly for model and setup method only (no agent list or keep/change)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    await wireStalePathPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const messages = await allSelectMessages();
    // Stale path: model select + setup method (2 total — no keep/change, no agent list pick)
    expect(messages).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 3: Environment list empty — via "change" path
//
// Flow: valid existing env → keep/change select → 'change' →
//       listEnvironments returns [] → auto-jump to createEnvironmentInteractive
// ══════════════════════════════════════════════════════════════════════════════

describe('AC 11 — environment list empty → auto-jump to create (via "change" path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // validateAuth succeeds
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Wire prompts for:
   *   env keep/change → 'change' → create env (name + desc) → manual Slack setup.
   *
   * No claudeAgentId set, so agent step is skipped.
   * Vault step: listVaults throws (no vaults mock) → returns [] silently.
   */
  async function wireEnvChangePathPrompts() {
    const { input, confirm, select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never) // env keep/change → change
      .mockResolvedValueOnce('manual' as never); // setup method
    vi.mocked(input)
      .mockResolvedValueOnce('new-env')          // environment name
      .mockResolvedValueOnce('')                  // environment description (skip)
      .mockResolvedValueOnce('Test Bot')          // Slack app name
      .mockResolvedValueOnce('A test bot')        // Slack app description
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);
  }

  it('does not render a "Select an environment" prompt when env list is empty (change path)', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] }); // empty
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvChangePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const messages = await allSelectMessages();
    const hasEnvListPrompt = messages.some((m) =>
      m.toLowerCase().includes('select an environment'),
    );
    expect(hasEnvListPrompt).toBe(false);
  });

  it('calls beta.environments.create when env list is empty (change path)', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvChangePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalled();
  });

  it('returns the newly created environment ID in the result (change path)', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvChangePathPrompts();

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(CREATED_ENV_ID);
  });

  it('select() is called exactly for keep/change and setup method only — no env list pick', async () => {
    mockEnvironmentsRetrieve.mockResolvedValue(makeEnvResponse(EXISTING_ENV_ID, EXISTING_ENV_NAME));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvChangePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: EXISTING_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const messages = await allSelectMessages();
    // Expected: env keep/change + setup method (2 calls) — no env list pick
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.toLowerCase().includes('select an environment'))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 4: Environment list empty — via stale-ID path
//
// Flow: stale env ID → retrieve throws → warn user → selectOrCreateEnvironment called →
//       listEnvironments returns [] → auto-jump to createEnvironmentInteractive
// ══════════════════════════════════════════════════════════════════════════════

describe('AC 11 — environment list empty → auto-jump to create (via stale-ID path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Wire prompts for:
   *   stale env → (no keep/change, falls straight to create) →
   *   create env (name + desc) → manual Slack setup.
   */
  async function wireEnvStalePathPrompts() {
    const { input, confirm, select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('manual' as never); // setup method only (no env keep/change)
    vi.mocked(input)
      .mockResolvedValueOnce('new-env')          // environment name
      .mockResolvedValueOnce('')                  // environment description (skip)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(confirm).mockResolvedValueOnce(true);
  }

  it('does not render a "Select an environment" prompt when env list is empty (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found')); // stale
    mockEnvironmentsList.mockResolvedValue({ data: [] }); // empty
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvStalePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const messages = await allSelectMessages();
    const hasEnvListPrompt = messages.some((m) =>
      m.toLowerCase().includes('select an environment'),
    );
    expect(hasEnvListPrompt).toBe(false);
  });

  it('calls beta.environments.create when env list is empty (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvStalePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(mockEnvironmentsCreate).toHaveBeenCalled();
  });

  it('returns the newly created environment ID in the result (stale path)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvStalePathPrompts();

    const result = await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.environmentId).toBe(CREATED_ENV_ID);
  });

  it('no "keep/change" prompt is shown when the env ID is stale (skips to create directly)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvStalePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const messages = await allSelectMessages();
    const hasKeepChangePrompt = messages.some(
      (m) => m.toLowerCase().includes('keep') && m.toLowerCase().includes('change'),
    );
    expect(hasKeepChangePrompt).toBe(false);
  });

  it('select() is called exactly once for setup method only (stale env + empty list)', async () => {
    mockEnvironmentsRetrieve.mockRejectedValue(new Error('not found'));
    mockEnvironmentsList.mockResolvedValue({ data: [] });
    mockEnvironmentsCreate.mockResolvedValue(makeEnvResponse(CREATED_ENV_ID, 'new-env'));
    await wireEnvStalePathPrompts();

    await initSlack({
      cwd: tmpDir,
      claudeEnvironmentId: STALE_ENV_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    const messages = await allSelectMessages();
    // Only the setup method select — no keep/change, no env list pick
    expect(messages).toHaveLength(1);
    expect(messages[0].toLowerCase()).toContain('set up');
  });
});
