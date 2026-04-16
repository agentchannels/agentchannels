/**
 * Sub-AC 1: Unit tests for agent empty-list auto-create.
 *
 * When `client.beta.agents.list()` returns an empty array, the wizard must
 * automatically route to the agent creation flow — no "Select a Claude Managed
 * Agent" prompt is ever rendered.
 *
 * Core assertion in every test:
 *   mockAgentsList returns { data: [] }  →  mockAgentsCreate IS called
 *
 * Two entry points into selectOrCreateAgent are exercised so the assertion
 * holds regardless of which upstream path brought us here:
 *
 *   A) "change" path  — valid existing agent ID → user picks "change"
 *   B) "stale" path   — existing agent ID fails validation → auto-falls through
 *
 * These are the only paths that reach selectOrCreateAgent in the current
 * implementation (agent selection is only activated when an existing
 * CLAUDE_AGENT_ID is present in config).
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

const EXISTING_AGENT_ID = 'agent_existing_abc123';
const EXISTING_AGENT_NAME = 'existing-agent';
const STALE_AGENT_ID = 'agent_stale_zzz999';
const CREATED_AGENT_ID = 'agent_auto_created_001';

function makeAgent(id: string, name: string) {
  return { id, name, version: 1 };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-empty-list-ac1-'));
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
 * Wire the minimal prompts needed for the agent create sub-flow followed by
 * a manual Slack setup, so initSlack() completes successfully.
 *
 * create-flow prompts: name, description (skip), model, system prompt (skip)
 * slack prompts: appName, appDescription, botToken, appToken, signingSecret + setupMethod + confirm
 */
async function wireCreateThenSlack(agentName = 'auto-created-agent') {
  const { input, confirm, select } = await import('@inquirer/prompts');
  vi.mocked(input)
    .mockResolvedValueOnce(agentName)      // agent name
    .mockResolvedValueOnce('')             // agent description (skip)
    .mockResolvedValueOnce('')             // agent system prompt (skip)
    .mockResolvedValueOnce('Test Bot')     // Slack app name
    .mockResolvedValueOnce('A test bot')   // Slack app description
    .mockResolvedValueOnce(VALID_BOT_TOKEN)
    .mockResolvedValueOnce(VALID_APP_TOKEN)
    .mockResolvedValueOnce(VALID_SIGNING_SECRET);
  vi.mocked(select)
    .mockResolvedValueOnce('claude-sonnet-4-6' as never) // model
    .mockResolvedValueOnce('manual' as never);            // setup method
  vi.mocked(confirm).mockResolvedValueOnce(true);         // save to .env
}

// ═════════════════════════════════════════════════════════════════════════════
// Entry point A: "change" path
//   valid existing agent ID → user picks "change" → list empty → auto-create
// ═════════════════════════════════════════════════════════════════════════════

describe('Sub-AC 1 — agents.list() empty → agents.create() called (via "change" path)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // Auth validation (validateAuth uses agents.list internally)
    mockAgentsList.mockResolvedValue({ data: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('calls beta.agents.create when agents.list returns empty array', async () => {
    // Arrange
    mockAgentsRetrieve.mockResolvedValue(makeAgent(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // validateAuth
      .mockResolvedValueOnce({ data: [] }); // listAgents → empty → triggers auto-create
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never); // keep/change → change
    await wireCreateThenSlack();

    // Act
    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    // Assert: create IS called because list returned empty
    expect(mockAgentsCreate).toHaveBeenCalled();
  });

  it('passes the user-entered name to beta.agents.create', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgent(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'my-slack-bot'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack('my-slack-bot');

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-slack-bot' }),
    );
  });

  it('result.agentId is the ID returned by beta.agents.create', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgent(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack();

    const result = await initSlack({
      cwd: tmpDir,
      claudeAgentId: EXISTING_AGENT_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });

  it('does NOT render "Select a Claude Managed Agent" when list is empty', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgent(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    await wireCreateThenSlack();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const selectMessages = vi.mocked(select).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(selectMessages.some((m) =>
      m.toLowerCase().includes('select a claude managed agent'),
    )).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Entry point B: "stale" path
//   stale existing agent ID → retrieve throws → list empty → auto-create
// ═════════════════════════════════════════════════════════════════════════════

describe('Sub-AC 1 — agents.list() empty → agents.create() called (via stale-ID path)', () => {
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
  async function wireStaleCreate(agentName = 'auto-created-agent') {
    const { input, confirm, select } = await import('@inquirer/prompts');
    vi.mocked(input)
      .mockResolvedValueOnce(agentName)      // agent name
      .mockResolvedValueOnce('')             // description (skip)
      .mockResolvedValueOnce('')             // system prompt (skip)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(select)
      .mockResolvedValueOnce('claude-sonnet-4-6' as never) // model
      .mockResolvedValueOnce('manual' as never);            // setup method
    vi.mocked(confirm).mockResolvedValueOnce(true);
  }

  it('calls beta.agents.create when agents.list returns empty array (stale path)', async () => {
    // Arrange: retrieve throws (stale), list returns empty
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // validateAuth
      .mockResolvedValueOnce({ data: [] }); // listAgents → empty → auto-create
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));
    await wireStaleCreate();

    // Act
    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    // Assert
    expect(mockAgentsCreate).toHaveBeenCalled();
  });

  it('passes the user-entered name to beta.agents.create (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'fresh-bot'));
    await wireStaleCreate('fresh-bot');

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fresh-bot' }),
    );
  });

  it('result.agentId is the ID returned by beta.agents.create (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));
    await wireStaleCreate();

    const result = await initSlack({
      cwd: tmpDir,
      claudeAgentId: STALE_AGENT_ID,
      anthropicApiKey: VALID_API_KEY,
    });

    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });

  it('beta.agents.create is called exactly once per invocation (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));
    await wireStaleCreate();

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    expect(mockAgentsCreate).toHaveBeenCalledTimes(1);
  });

  it('does NOT render "Select a Claude Managed Agent" when list is empty (stale path)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockAgentsCreate.mockResolvedValue(makeAgent(CREATED_AGENT_ID, 'auto-created-agent'));
    await wireStaleCreate();

    await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID, anthropicApiKey: VALID_API_KEY });

    const { select } = await import('@inquirer/prompts');
    const selectMessages = vi.mocked(select).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(selectMessages.some((m) =>
      m.toLowerCase().includes('select a claude managed agent'),
    )).toBe(false);
  });
});
