/**
 * Tests for AC 5: CLAUDE_AGENT_ID detection, validation, and keep-or-change flow.
 *
 * AC 5: Existing CLAUDE_AGENT_ID in .env is detected, validated via
 * beta.agents.retrieve, and user is asked to keep (default) or change.
 * If validation fails the user is warned explicitly and forced to re-select —
 * never silently drop the stale value.
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

// Shared SDK mock
//   agents.list     — used by validateAuth() and listAgents()
//   agents.retrieve — used by validateAgent() → AgentClient.getAgent()
//   agents.create   — used by createAgent()  → AgentClient.createAgent()
//   vaults.retrieve — used by collectAndValidateVaultIds() → AgentClient.getVault()
const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsCreate = vi.fn();
const mockVaultsRetrieve = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      agents: {
        list: mockAgentsList,
        retrieve: mockAgentsRetrieve,
        create: mockAgentsCreate,
      },
      vaults: {
        retrieve: mockVaultsRetrieve,
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
const VALID_AGENT_ID = 'agent-test-abc123def456';
const STALE_AGENT_ID = 'agent-stale-xyz789012345';

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-agent-selection-test-'));
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

/** Isolate credential env vars to prevent host environment leakage */
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

// ────────────────────────── Non-interactive: CLAUDE_AGENT_ID validation ──────────────────────────

describe('initSlackNonInteractive — CLAUDE_AGENT_ID detection and validation (AC 5)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // validateAuth() (list limit:1) and listAgents() (list limit:20) succeed by default
    mockAgentsList.mockResolvedValue({ data: [] });
    // Agent retrieve returns a valid agent by default
    mockAgentsRetrieve.mockResolvedValue({
      id: VALID_AGENT_ID,
      name: 'Test Agent',
      version: 1,
    });
    // Agent create returns a new agent by default
    mockAgentsCreate.mockResolvedValue({
      id: 'agent-newly-created',
      name: 'agentchannels-bot',
      version: 1,
    });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('skips agent validation when CLAUDE_AGENT_ID is absent — agentId is undefined in result', async () => {
    // No CLAUDE_AGENT_ID in options, env var, or .env file
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBeUndefined();
    expect(mockAgentsRetrieve).not.toHaveBeenCalled();
  });

  it('validates CLAUDE_AGENT_ID via beta.agents.retrieve when present in env var', async () => {
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('returns validated agentId in result when CLAUDE_AGENT_ID is valid', async () => {
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
  });

  it('reads CLAUDE_AGENT_ID from .env file and validates it', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [`ANTHROPIC_API_KEY=${VALID_API_KEY}`, `CLAUDE_AGENT_ID=${VALID_AGENT_ID}`].join('\n') + '\n',
      'utf-8',
    );

    await initSlackNonInteractive({
      cwd: tmpDir,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('claudeAgentId option takes precedence over CLAUDE_AGENT_ID env var (three-source precedence)', async () => {
    const overrideAgentId = 'agent-option-override-111';
    mockAgentsRetrieve.mockResolvedValue({ id: overrideAgentId, name: 'Override Agent', version: 1 });

    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID; // env var — should be overridden

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: overrideAgentId, // option wins
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(overrideAgentId);
    expect(mockAgentsRetrieve).not.toHaveBeenCalledWith(VALID_AGENT_ID);
    expect(result.agentId).toBe(overrideAgentId);
  });

  it('throws when CLAUDE_AGENT_ID fails validation (stale/not found)', async () => {
    process.env.CLAUDE_AGENT_ID = STALE_AGENT_ID;
    mockAgentsRetrieve.mockRejectedValue(new Error('Agent not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow();
  });

  it('error message for stale ID contains the stale agent ID (transparent_stale_state_handling)', async () => {
    process.env.CLAUDE_AGENT_ID = STALE_AGENT_ID;
    mockAgentsRetrieve.mockRejectedValue(new Error('Agent not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(new RegExp(STALE_AGENT_ID));
  });

  it('error message for stale ID uses "stale", "invalid", or "not found" language', async () => {
    process.env.CLAUDE_AGENT_ID = STALE_AGENT_ID;
    mockAgentsRetrieve.mockRejectedValue(new Error('Agent not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale|invalid|not found/i);
  });

  it('writes CLAUDE_AGENT_ID to .env when the agent is valid', async () => {
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
  });

  it('does not write CLAUDE_AGENT_ID to .env when no agent is configured', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBeUndefined();
  });

  it('does not invoke interactive prompts during agent validation', async () => {
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
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
});

// ────────────────────────── Interactive: keep-or-change flow ──────────────────────────

describe('initSlack (interactive) — CLAUDE_AGENT_ID keep-or-change flow (AC 5)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // validateAuth and listAgents both succeed with empty list
    mockAgentsList.mockResolvedValue({ data: [] });
    // Retrieve returns a valid agent by default
    mockAgentsRetrieve.mockResolvedValue({
      id: VALID_AGENT_ID,
      name: 'Existing Agent',
      version: 1,
    });
    // Create returns a new agent
    mockAgentsCreate.mockResolvedValue({
      id: 'agent-newly-created',
      name: 'agentchannels-bot',
      version: 1,
    });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Set up prompt mocks for the full interactive manual path when CLAUDE_AGENT_ID
   * exists and the user chooses to keep it.
   *
   * Expected prompt sequence when agent step is active:
   *   select: keep/change (agent) → 'keep'
   *   input:  app name → 'Test Bot'
   *   input:  description → 'A test bot'
   *   select: setup method → 'manual'
   *   input:  bot token, app token, signing secret
   *   confirm: save to .env → true
   */
  async function setupPromptsKeepExistingAgent() {
    const { input: mockInput, confirm: mockConfirm, select: mockSelect } =
      await import('@inquirer/prompts');

    // Agent keep-or-change: keep
    vi.mocked(mockSelect).mockResolvedValueOnce('keep' as 'keep' | 'change');
    // App name, description
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot');
    // Setup method
    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    // Slack credentials
    vi.mocked(mockInput)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    // Save to .env
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);

    return { mockInput, mockConfirm, mockSelect };
  }

  /**
   * Set up prompt mocks when CLAUDE_AGENT_ID is absent (agent step skipped entirely).
   *
   * Expected prompt sequence (no agent step):
   *   input:  app name → 'Test Bot'
   *   input:  description → 'A test bot'
   *   select: setup method → 'manual'
   *   input:  bot token, app token, signing secret
   *   confirm: save to .env → true
   */
  async function setupPromptsNoExistingAgent() {
    const { input: mockInput, confirm: mockConfirm, select: mockSelect } =
      await import('@inquirer/prompts');

    // App name, description
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot');
    // Setup method (only select — no agent keep/change select)
    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    // Slack credentials
    vi.mocked(mockInput)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    // Save to .env
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);

    return { mockInput, mockConfirm, mockSelect };
  }

  it('validates existing CLAUDE_AGENT_ID via beta.agents.retrieve', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    await setupPromptsKeepExistingAgent();

    await initSlack({ cwd: tmpDir });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('presents keep-or-change select when existing CLAUDE_AGENT_ID is valid', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    const { mockSelect } = await setupPromptsKeepExistingAgent();

    await initSlack({ cwd: tmpDir });

    // First select call must offer 'keep' and 'change' as choices
    const firstSelectArg = vi.mocked(mockSelect).mock.calls[0][0] as {
      message: string;
      choices: Array<{ value: string }>;
    };
    const choiceValues = firstSelectArg.choices.map((c) => c.value);
    expect(choiceValues).toContain('keep');
    expect(choiceValues).toContain('change');
  });

  it('"keep" action returns the existing agent ID in the result', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    await setupPromptsKeepExistingAgent();

    const result = await initSlack({ cwd: tmpDir });

    expect(result.agentId).toBe(VALID_AGENT_ID);
  });

  it('"keep" action writes the existing agent ID to .env', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    await setupPromptsKeepExistingAgent();

    await initSlack({ cwd: tmpDir });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
  });

  it('does NOT call beta.agents.retrieve when CLAUDE_AGENT_ID is absent (step skipped)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    // No CLAUDE_AGENT_ID
    await setupPromptsNoExistingAgent();

    await initSlack({ cwd: tmpDir });

    expect(mockAgentsRetrieve).not.toHaveBeenCalled();
  });

  it('agentId is undefined in result when CLAUDE_AGENT_ID is not configured', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    await setupPromptsNoExistingAgent();

    const result = await initSlack({ cwd: tmpDir });

    expect(result.agentId).toBeUndefined();
  });

  it('no keep/change select is shown when CLAUDE_AGENT_ID is absent', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    const { mockSelect } = await setupPromptsNoExistingAgent();

    await initSlack({ cwd: tmpDir });

    // Only one select call (setup method); none about agent keep/change
    const allSelectMessages = vi.mocked(mockSelect).mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(allSelectMessages.length).toBe(1);
    for (const msg of allSelectMessages) {
      expect(msg.toLowerCase()).not.toMatch(/keep|agent/);
    }
  });

  it('warns when CLAUDE_AGENT_ID fails validation (stale/not found)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = STALE_AGENT_ID;
    mockAgentsRetrieve.mockRejectedValue(new Error('Agent not found'));

    // After stale detection: listAgents (empty) → auto-jump to createAgentInteractive
    const { input: mockInput, confirm: mockConfirm, select: mockSelect } =
      await import('@inquirer/prompts');
    vi.mocked(mockInput).mockResolvedValueOnce('New Bot');      // agent name (creation)
    vi.mocked(mockInput).mockResolvedValueOnce('');             // agent description (optional)
    vi.mocked(mockSelect).mockResolvedValueOnce('claude-sonnet-4-6' as const); // model (creation)
    vi.mocked(mockInput).mockResolvedValueOnce('');             // agent system prompt (optional)
    vi.mocked(mockInput).mockResolvedValueOnce('Test Bot').mockResolvedValueOnce('A test bot');
    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    vi.mocked(mockInput)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await initSlack({ cwd: tmpDir });

    const warnMessages = warnSpy.mock.calls.map((c) => c.join(' '));
    const hasStaleWarning = warnMessages.some(
      (msg) =>
        msg.includes(STALE_AGENT_ID) ||
        msg.toLowerCase().includes('stale') ||
        msg.toLowerCase().includes('not found'),
    );
    expect(hasStaleWarning).toBe(true);
  });

  it('stale warning explicitly mentions the stale agent ID (transparent_stale_state_handling)', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = STALE_AGENT_ID;
    mockAgentsRetrieve.mockRejectedValue(new Error('Agent not found'));

    const { input: mockInput, confirm: mockConfirm, select: mockSelect } =
      await import('@inquirer/prompts');
    vi.mocked(mockInput).mockResolvedValueOnce('New Bot');             // agent name (creation)
    vi.mocked(mockInput).mockResolvedValueOnce('');                    // agent description (optional)
    vi.mocked(mockSelect).mockResolvedValueOnce('claude-sonnet-4-6' as const); // model (creation)
    vi.mocked(mockInput).mockResolvedValueOnce('');                    // agent system prompt (optional)
    vi.mocked(mockInput).mockResolvedValueOnce('Test Bot').mockResolvedValueOnce('A test bot');
    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    vi.mocked(mockInput)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await initSlack({ cwd: tmpDir });

    const warnMessages = warnSpy.mock.calls.map((c) => c.join(' '));
    const hasStaleIdInWarning = warnMessages.some((msg) => msg.includes(STALE_AGENT_ID));
    expect(hasStaleIdInWarning).toBe(true);
  });

  it('stale CLAUDE_AGENT_ID forces re-selection — stale ID is never returned in result', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    process.env.CLAUDE_AGENT_ID = STALE_AGENT_ID;
    mockAgentsRetrieve.mockRejectedValue(new Error('Agent not found'));

    const { input: mockInput, confirm: mockConfirm, select: mockSelect } =
      await import('@inquirer/prompts');
    vi.mocked(mockInput).mockResolvedValueOnce('New Bot');             // agent name (creation)
    vi.mocked(mockInput).mockResolvedValueOnce('');                    // agent description (optional)
    vi.mocked(mockSelect).mockResolvedValueOnce('claude-sonnet-4-6' as const); // model (creation)
    vi.mocked(mockInput).mockResolvedValueOnce('');                    // agent system prompt (optional)
    vi.mocked(mockInput).mockResolvedValueOnce('Test Bot').mockResolvedValueOnce('A test bot');
    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    vi.mocked(mockInput)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await initSlack({ cwd: tmpDir });

    // The stale ID must NOT appear in the result
    expect(result.agentId).not.toBe(STALE_AGENT_ID);
    // The newly-created agent ID must appear instead
    expect(result.agentId).toBe('agent-newly-created');
  });

  it('reads CLAUDE_AGENT_ID from .env file in interactive path', async () => {
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `CLAUDE_AGENT_ID=${VALID_AGENT_ID}\n`,
      'utf-8',
    );
    await setupPromptsKeepExistingAgent();

    await initSlack({ cwd: tmpDir });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });
});
