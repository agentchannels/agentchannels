/**
 * Tests for Sub-AC 8b: 'Create new agent' branch in the init-slack wizard.
 *
 * The createAgentInteractive sub-flow is triggered when:
 *   - The user selects "+ Create a new agent" from the agent select menu, OR
 *   - listAgents() returns an empty list (auto-jump to create)
 *
 * This sub-flow must:
 *   1. Prompt for name (required, default: "agentchannels-bot")
 *   2. Prompt for description (optional)
 *   3. Present a model select from the predefined CLAUDE_AGENT_MODELS list
 *   4. Prompt for system prompt (optional)
 *   5. Call client.beta.agents.create with all provided fields
 *   6. Return the new agent ID
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
const CREATED_AGENT_ID = 'agent_newly_created_xyz';

function makeAgentResponse(id: string, name: string) {
  return { id, name, version: 1, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-init-agent-create-test-'));
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

/** Clear all credential env vars to prevent host environment leakage. */
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
 * Wire the trailing Slack manual-path prompts after the agent create step.
 * Adds: appName, appDescription, botToken, appToken, signingSecret inputs
 * and the setupMethod select and save-to-.env confirm.
 */
async function wireTrailingSlackPrompts() {
  const { input, confirm, select } = await import('@inquirer/prompts');
  vi.mocked(input)
    .mockResolvedValueOnce('Test Bot')            // appName
    .mockResolvedValueOnce('A test bot')          // appDescription
    .mockResolvedValueOnce(VALID_BOT_TOKEN)
    .mockResolvedValueOnce(VALID_APP_TOKEN)
    .mockResolvedValueOnce(VALID_SIGNING_SECRET);
  vi.mocked(select).mockResolvedValueOnce('manual' as never); // setupMethod
  vi.mocked(confirm).mockResolvedValueOnce(true);             // save to .env
}

// ══════════════════════════════════════════════════════════════════════════════
// Prompt sequence — all four fields are presented
// ══════════════════════════════════════════════════════════════════════════════

describe('createAgentInteractive — prompt sequence (Sub-AC 8b)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // Auth validation
    mockAgentsList.mockResolvedValue({ data: [] });
    // Existing agent: keep-or-change will offer 'change'
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    // agents.create returns the new agent
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'my-new-agent'));
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Helper: trigger createAgentInteractive via change → empty list → auto-jump.
   * Wires the four create-step prompts and the trailing Slack prompts.
   */
  async function triggerCreate(overrides: {
    name?: string;
    description?: string;
    model?: string;
    systemPrompt?: string;
  } = {}) {
    const { input, select } = await import('@inquirer/prompts');

    // keep-or-change → change; empty list → auto-jump to create
    vi.mocked(select).mockResolvedValueOnce('change' as never);

    // --- createAgentInteractive prompts ---
    vi.mocked(input).mockResolvedValueOnce(overrides.name ?? 'my-new-agent');       // name
    vi.mocked(input).mockResolvedValueOnce(overrides.description ?? '');            // description
    vi.mocked(select).mockResolvedValueOnce((overrides.model ?? 'claude-sonnet-4-6') as never); // model
    vi.mocked(input).mockResolvedValueOnce(overrides.systemPrompt ?? '');           // system prompt

    await wireTrailingSlackPrompts();

    return initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });
  }

  it('prompts for agent name (first prompt)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { input } = await import('@inquirer/prompts');

    await triggerCreate({ name: 'custom-name' });

    // The first input() call after the model select (keep/change) is the agent name
    const inputCalls = vi.mocked(input).mock.calls;
    const nameCall = inputCalls[0][0] as { message: string; default?: string };
    expect(nameCall.message.toLowerCase()).toMatch(/agent.*name|name/i);
  });

  it('prompts for description (second prompt, after name)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { input } = await import('@inquirer/prompts');

    await triggerCreate({ description: 'my agent description' });

    const inputCalls = vi.mocked(input).mock.calls;
    // Second input call (index 1) must mention description
    const descCall = inputCalls[1][0] as { message: string };
    expect(descCall.message.toLowerCase()).toMatch(/description/i);
  });

  it('presents model select (third step)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { select } = await import('@inquirer/prompts');

    await triggerCreate({ model: 'claude-opus-4-5' });

    // select calls: [0]=keep/change, [1]=model, [2]=setupMethod
    const selectCalls = vi.mocked(select).mock.calls;
    expect(selectCalls.length).toBeGreaterThanOrEqual(2);
    const modelCall = selectCalls[1][0] as { message: string; choices: Array<{ value: string }> };
    expect(modelCall.message.toLowerCase()).toMatch(/model/i);
  });

  it('model select offers claude-sonnet-4-6 as a choice', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { select } = await import('@inquirer/prompts');

    await triggerCreate();

    const selectCalls = vi.mocked(select).mock.calls;
    const modelCall = selectCalls[1][0] as { choices: Array<{ value: string }> };
    const values = modelCall.choices.map((c) => c.value);
    expect(values).toContain('claude-sonnet-4-6');
  });

  it('model select offers claude-opus-4-5 as a choice', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { select } = await import('@inquirer/prompts');

    await triggerCreate();

    const selectCalls = vi.mocked(select).mock.calls;
    const modelCall = selectCalls[1][0] as { choices: Array<{ value: string }> };
    const values = modelCall.choices.map((c) => c.value);
    expect(values).toContain('claude-opus-4-5');
  });

  it('model select offers claude-haiku-4-5 as a choice', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { select } = await import('@inquirer/prompts');

    await triggerCreate();

    const selectCalls = vi.mocked(select).mock.calls;
    const modelCall = selectCalls[1][0] as { choices: Array<{ value: string }> };
    const values = modelCall.choices.map((c) => c.value);
    expect(values).toContain('claude-haiku-4-5');
  });

  it('model select has at least three distinct model choices', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { select } = await import('@inquirer/prompts');

    await triggerCreate();

    const selectCalls = vi.mocked(select).mock.calls;
    const modelCall = selectCalls[1][0] as { choices: Array<{ value: string }> };
    expect(modelCall.choices.length).toBeGreaterThanOrEqual(3);
    const uniqueValues = new Set(modelCall.choices.map((c) => c.value));
    expect(uniqueValues.size).toBeGreaterThanOrEqual(3);
  });

  it('prompts for system prompt (fourth prompt, after model)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { input } = await import('@inquirer/prompts');

    await triggerCreate({ systemPrompt: 'You are a helpful assistant.' });

    // input calls: [0]=name, [1]=description, [2]=system prompt, then app wizard prompts
    const inputCalls = vi.mocked(input).mock.calls;
    const systemCall = inputCalls[2][0] as { message: string };
    expect(systemCall.message.toLowerCase()).toMatch(/system|prompt/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// beta.agents.create call — fields forwarded correctly
// ══════════════════════════════════════════════════════════════════════════════

describe('createAgentInteractive — beta.agents.create call (Sub-AC 8b)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'created-agent'));
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  async function runCreate(opts: {
    name: string;
    description: string;
    model: string;
    systemPrompt: string;
  }) {
    const { input, select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(input).mockResolvedValueOnce(opts.name);
    vi.mocked(input).mockResolvedValueOnce(opts.description);
    vi.mocked(select).mockResolvedValueOnce(opts.model as never);
    vi.mocked(input).mockResolvedValueOnce(opts.systemPrompt);
    await wireTrailingSlackPrompts();
    return initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });
  }

  it('calls beta.agents.create with the entered name', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: 'slack-bot', description: '', model: 'claude-sonnet-4-6', systemPrompt: '' });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'slack-bot' }),
    );
  });

  it('calls beta.agents.create with the selected model', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: 'bot', description: '', model: 'claude-opus-4-5', systemPrompt: '' });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-5' }),
    );
  });

  it('passes description to beta.agents.create when provided', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({
      name: 'bot',
      description: 'A helpful Slack bot',
      model: 'claude-sonnet-4-6',
      systemPrompt: '',
    });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'A helpful Slack bot' }),
    );
  });

  it('omits description from beta.agents.create when left blank', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: 'bot', description: '', model: 'claude-sonnet-4-6', systemPrompt: '' });

    const createCall = mockAgentsCreate.mock.calls[0][0] as Record<string, unknown>;
    // undefined means it should not have been set (or be falsy)
    expect(createCall.description == null || createCall.description === '').toBe(true);
  });

  it('passes system prompt to beta.agents.create when provided', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({
      name: 'bot',
      description: '',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'You are a helpful assistant.' }),
    );
  });

  it('omits system prompt from beta.agents.create when left blank', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: 'bot', description: '', model: 'claude-sonnet-4-6', systemPrompt: '' });

    const createCall = mockAgentsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(createCall.system == null || createCall.system === '').toBe(true);
  });

  it('trims whitespace from name before passing to beta.agents.create', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: '  padded-name  ', description: '', model: 'claude-sonnet-4-6', systemPrompt: '' });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'padded-name' }),
    );
  });

  it('trims whitespace from description before passing to beta.agents.create', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: 'bot', description: '  spaced desc  ', model: 'claude-sonnet-4-6', systemPrompt: '' });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'spaced desc' }),
    );
  });

  it('trims whitespace from system prompt before passing to beta.agents.create', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate({ name: 'bot', description: '', model: 'claude-sonnet-4-6', systemPrompt: '  You are a bot.  ' });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'You are a bot.' }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Return value and .env write
// ══════════════════════════════════════════════════════════════════════════════

describe('createAgentInteractive — return value and .env write (Sub-AC 8b)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList.mockResolvedValue({ data: [] });
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  async function runCreate() {
    const { input, select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(input).mockResolvedValueOnce('new-agent');
    vi.mocked(input).mockResolvedValueOnce('');
    vi.mocked(select).mockResolvedValueOnce('claude-sonnet-4-6' as never);
    vi.mocked(input).mockResolvedValueOnce('');
    await wireTrailingSlackPrompts();
    return initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });
  }

  it('returns the new agent ID in the wizard result', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const result = await runCreate();

    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });

  it('writes the new agent ID to .env', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate();

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(CREATED_AGENT_ID);
  });

  it('calls beta.agents.create exactly once', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    await runCreate();

    expect(mockAgentsCreate).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// __create__ sentinel — user picks "+ Create a new agent" from non-empty list
// ══════════════════════════════════════════════════════════════════════════════

describe('createAgentInteractive — triggered via __create__ sentinel (Sub-AC 8b)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'brand-new-agent'));
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('creates agent when user selects __create__ from the non-empty list', async () => {
    const LISTED_ID = 'agent_already_exists_111';
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })                                          // auth validation
      .mockResolvedValueOnce({ data: [makeAgentResponse(LISTED_ID, 'listed-agent')] }); // listing
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { input, select } = await import('@inquirer/prompts');
    vi.mocked(select)
      .mockResolvedValueOnce('change' as never)    // keep/change → change
      .mockResolvedValueOnce('__create__' as never); // select sentinel
    // createAgentInteractive prompts
    vi.mocked(input).mockResolvedValueOnce('brand-new-agent');
    vi.mocked(input).mockResolvedValueOnce('');
    vi.mocked(select).mockResolvedValueOnce('claude-haiku-4-5' as never);
    vi.mocked(input).mockResolvedValueOnce('Be concise.');
    await wireTrailingSlackPrompts();

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(mockAgentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'brand-new-agent',
        model: 'claude-haiku-4-5',
        system: 'Be concise.',
      }),
    );
    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });
});
