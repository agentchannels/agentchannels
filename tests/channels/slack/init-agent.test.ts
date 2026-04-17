/**
 * Tests for CLAUDE_AGENT_ID detect/validate/keep-or-change/warn-on-stale pattern
 * in the init-slack wizard.
 *
 * AC 5: Existing CLAUDE_AGENT_ID in .env is detected, validated via beta.agents.retrieve,
 *   and user is asked to keep (default) or change. If validation fails, user is warned
 *   and forced to re-select.
 *
 * Detection sources (three-source precedence, highest first):
 *   1. claudeAgentId option (CLI flag)
 *   2. CLAUDE_AGENT_ID env var
 *   3. CLAUDE_AGENT_ID from .env file
 *
 * Interactive path:
 *   - Valid ID  → show name/ID, "Keep or change?" (default: keep)
 *   - Stale ID  → explicit warning, fall through to select/create list
 *
 * Non-interactive path:
 *   - Valid ID  → silently validate and write
 *   - Stale ID  → throw immediately with descriptive error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive } from '../../../src/channels/slack/init.js';

// ────────────────────────── SDK Mock ──────────────────────────
// beta.agents.list  → used by validateAuth() AND by listAgents() in selectOrCreateAgent
// beta.agents.retrieve → used by validateAgent() in collectAndSelectAgent
// beta.agents.create  → used by createAgent() in createAgentInteractive
// beta.environments.* → stubbed as no-ops so environment code paths don't crash

const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsCreate = vi.fn();
// No-op environment stubs — agent tests don't exercise environment logic,
// but init.ts will call beta.environments.retrieve if CLAUDE_ENVIRONMENT_ID leaks in.
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

const VALID_AGENT_ID = 'agent_abc123def456';
const VALID_AGENT_NAME = 'my-test-agent';
const STALE_AGENT_ID = 'agent_stale_gone_999';

/** Minimal agent API response shape */
function makeAgentResponse(id: string, name: string) {
  return { id, name, version: 1, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-init-agent-test-'));
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

// ══════════════════════════════════════════════════════════════════════════════
// Non-interactive path
// ══════════════════════════════════════════════════════════════════════════════

describe('initSlackNonInteractive — CLAUDE_AGENT_ID: detect + validate', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // API key validation always succeeds by default
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  // ── skip when absent ──────────────────────────────────────────────────────

  it('skips agent validation when CLAUDE_AGENT_ID is absent', async () => {
    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).not.toHaveBeenCalled();
  });

  it('does not write CLAUDE_AGENT_ID to .env when absent', async () => {
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

  it('returns undefined agentId when no existing ID is configured', async () => {
    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBeUndefined();
  });

  // ── validate existing ID (valid) ──────────────────────────────────────────

  it('validates CLAUDE_AGENT_ID via beta.agents.retrieve when provided via option', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('validates CLAUDE_AGENT_ID from CLAUDE_AGENT_ID env var', async () => {
    process.env.CLAUDE_AGENT_ID = VALID_AGENT_ID;
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('validates CLAUDE_AGENT_ID from .env file when not provided via option or env', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${VALID_API_KEY}\nCLAUDE_AGENT_ID=${VALID_AGENT_ID}\n`,
      'utf-8',
    );
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
  });

  it('option overrides env var for CLAUDE_AGENT_ID (three-source precedence)', async () => {
    process.env.CLAUDE_AGENT_ID = 'agent_from_env_var_should_lose';
    const overrideId = 'agent_from_option_wins_123';
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(overrideId, 'option-agent'));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: overrideId,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    // The option-level ID (not the env var) must be retrieved
    expect(mockAgentsRetrieve).toHaveBeenCalledWith(overrideId);
    expect(mockAgentsRetrieve).not.toHaveBeenCalledWith('agent_from_env_var_should_lose');
  });

  it('returns validated agentId in result', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
  });

  it('writes CLAUDE_AGENT_ID to .env after successful validation', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
  });

  it('does not write CLAUDE_AGENT_ID when skipEnvWrite is true', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    const result = await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
      skipEnvWrite: true,
    });

    // Result still has the ID, but .env was not written
    expect(result.agentId).toBe(VALID_AGENT_ID);
    expect(result.envWritten).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
  });

  // ── stale ID → throw with explicit warning ────────────────────────────────

  it('throws when CLAUDE_AGENT_ID is stale (not found via API)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('404 Not Found'));

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

  it('stale error message contains "stale" or "invalid" to guide the user', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale|invalid/i);
  });

  it('stale error message tells the user how to fix it (mentions CLAUDE_AGENT_ID)', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));

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

  it('throws before Slack credential validation when agent ID is stale', async () => {
    // Stale agent should throw before any Slack credential checks
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlackNonInteractive({
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        // Intentionally omit Slack tokens — stale agent should throw first
      }),
    ).rejects.toThrow(/stale|invalid/i);
  });

  it('does not invoke any interactive prompts when agent ID is valid', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));
    const { input: mockInput, confirm: mockConfirm, select: mockSelect, password: mockPassword } =
      await import('@inquirer/prompts');

    await initSlackNonInteractive({
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(vi.mocked(mockInput)).not.toHaveBeenCalled();
    expect(vi.mocked(mockConfirm)).not.toHaveBeenCalled();
    expect(vi.mocked(mockSelect)).not.toHaveBeenCalled();
    expect(vi.mocked(mockPassword)).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Interactive path
// ══════════════════════════════════════════════════════════════════════════════

describe('initSlack (interactive) — CLAUDE_AGENT_ID: detect/validate/keep-or-change/warn-on-stale', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // API key validation always succeeds by default
    mockAgentsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  /**
   * Wire up the minimal manual-path interactive prompts so the wizard can
   * complete after the agent step. Returns the mocked prompt functions.
   */
  async function wireManualSlackPrompts() {
    const { input: mockInput, confirm: mockConfirm, select: mockSelect, password: mockPassword } =
      await import('@inquirer/prompts');

    // App name, description, botToken, appToken, signingSecret
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);
    // Setup method
    vi.mocked(mockSelect).mockResolvedValueOnce('manual' as const);
    // Save credentials
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);

    return { mockInput, mockConfirm, mockSelect, mockPassword };
  }

  // ── skip when absent ──────────────────────────────────────────────────────

  it('skips agent step when no CLAUDE_AGENT_ID is configured', async () => {
    const { mockPassword } = await wireManualSlackPrompts();
    vi.mocked(mockPassword).mockResolvedValueOnce(VALID_API_KEY);

    await initSlack({ cwd: tmpDir });

    expect(mockAgentsRetrieve).not.toHaveBeenCalled();
  });

  it('returns undefined agentId when no existing ID is configured', async () => {
    const { mockPassword } = await wireManualSlackPrompts();
    vi.mocked(mockPassword).mockResolvedValueOnce(VALID_API_KEY);

    const result = await initSlack({ cwd: tmpDir });

    expect(result.agentId).toBeUndefined();
  });

  // ── keep existing valid ID ────────────────────────────────────────────────

  it('validates existing CLAUDE_AGENT_ID via API and offers keep/change prompt', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select: mockSelect, confirm: mockConfirm, input: mockInput } = await import('@inquirer/prompts');
    vi.mocked(mockSelect)
      .mockResolvedValueOnce('keep' as const)    // agent: keep
      .mockResolvedValueOnce('manual' as const); // setup method
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: VALID_AGENT_ID });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(VALID_AGENT_ID);
    expect(result.agentId).toBe(VALID_AGENT_ID);
  });

  it('writes CLAUDE_AGENT_ID to .env when user keeps the existing agent', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select: mockSelect, confirm: mockConfirm, input: mockInput } = await import('@inquirer/prompts');
    vi.mocked(mockSelect)
      .mockResolvedValueOnce('keep' as const)
      .mockResolvedValueOnce('manual' as const);
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    await initSlack({ cwd: tmpDir, claudeAgentId: VALID_AGENT_ID });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
  });

  // ── change: user selects a different agent ────────────────────────────────

  it('lists agents after user selects "change"', async () => {
    const OTHER_AGENT_ID = 'agent_other_xyz789';
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));
    // First call = validateAuth, second call = listAgents (both use beta.agents.list)
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation
      .mockResolvedValueOnce({ data: [makeAgentResponse(OTHER_AGENT_ID, 'other-agent')] }); // list
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select: mockSelect, confirm: mockConfirm, input: mockInput } = await import('@inquirer/prompts');
    vi.mocked(mockSelect)
      .mockResolvedValueOnce('change' as const)   // agent: change
      .mockResolvedValueOnce(OTHER_AGENT_ID)       // select from list
      .mockResolvedValueOnce('manual' as const);   // setup method
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: VALID_AGENT_ID });

    // agents.list was called twice: once for auth, once for listing
    expect(mockAgentsList).toHaveBeenCalledTimes(2);
    expect(result.agentId).toBe(OTHER_AGENT_ID);
  });

  it('allows creating a new agent when user selects "change" then empty list auto-jumps to create', async () => {
    const CREATED_AGENT_ID = 'agent_brand_new_111';
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));
    // Empty list → auto-jump to create flow
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation
      .mockResolvedValueOnce({ data: [] }); // list (empty → auto-jump to create)
    mockAgentsCreate.mockResolvedValue(makeAgentResponse(CREATED_AGENT_ID, 'new-agent'));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select: mockSelect, confirm: mockConfirm, input: mockInput } = await import('@inquirer/prompts');
    vi.mocked(mockSelect)
      .mockResolvedValueOnce('change' as const)           // agent: change
      // empty list → auto-jumps to create, no select for agent needed
      .mockResolvedValueOnce('claude-sonnet-4-6' as const) // agent model (create step)
      .mockResolvedValueOnce('manual' as const);           // setup method
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.mocked(mockInput)
      .mockResolvedValueOnce('new-agent')         // agent name prompt
      .mockResolvedValueOnce('')                  // agent description (optional)
      .mockResolvedValueOnce('')                  // agent system prompt (optional)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: VALID_AGENT_ID });

    expect(mockAgentsCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'new-agent' }));
    expect(result.agentId).toBe(CREATED_AGENT_ID);
  });

  // ── stale ID → warn and fall through to select/create ────────────────────

  it('warns about stale CLAUDE_AGENT_ID and falls through to agent selection', async () => {
    const OTHER_AGENT_ID = 'agent_replacement_456';
    // Stale: retrieve throws
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    // Listing returns one replacement agent
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation
      .mockResolvedValueOnce({ data: [makeAgentResponse(OTHER_AGENT_ID, 'replacement-agent')] }); // list
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;

    const { select: mockSelect, confirm: mockConfirm, input: mockInput } = await import('@inquirer/prompts');
    vi.mocked(mockSelect)
      // No keep/change prompt for stale — falls straight to listing
      .mockResolvedValueOnce(OTHER_AGENT_ID)        // select replacement from list
      .mockResolvedValueOnce('manual' as const);    // setup method
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: STALE_AGENT_ID });

    // Stale ID must NOT appear in result — user selected a replacement
    expect(result.agentId).toBe(OTHER_AGENT_ID);
    expect(result.agentId).not.toBe(STALE_AGENT_ID);
    // List must have been called to show replacement options
    expect(mockAgentsList).toHaveBeenCalledTimes(2); // auth + list
  });

  it('proceeds even when the stale ID was in .env (no silent drop — warns user)', async () => {
    // Pre-seed .env with a stale agent ID
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      `ANTHROPIC_API_KEY=${VALID_API_KEY}\nCLAUDE_AGENT_ID=${STALE_AGENT_ID}\n`,
      'utf-8',
    );
    const REPLACEMENT_ID = 'agent_fresh_777';
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));
    mockAgentsList
      .mockResolvedValueOnce({ data: [] }) // auth validation
      .mockResolvedValueOnce({ data: [makeAgentResponse(REPLACEMENT_ID, 'fresh-agent')] }); // list

    const { select: mockSelect, confirm: mockConfirm, input: mockInput } = await import('@inquirer/prompts');
    vi.mocked(mockSelect)
      .mockResolvedValueOnce(REPLACEMENT_ID)       // select replacement
      .mockResolvedValueOnce('manual' as const);
    vi.mocked(mockConfirm).mockResolvedValueOnce(true);
    vi.mocked(mockInput)
      .mockResolvedValueOnce('Test Bot')
      .mockResolvedValueOnce('A test bot')
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APP_TOKEN)
      .mockResolvedValueOnce(VALID_SIGNING_SECRET);

    const result = await initSlack({ cwd: tmpDir });

    // Wizard completed with the replacement — stale ID was detected then replaced
    expect(mockAgentsRetrieve).toHaveBeenCalledWith(STALE_AGENT_ID);
    expect(result.agentId).toBe(REPLACEMENT_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// initSlack nonInteractive: true (delegates to initSlackNonInteractive)
// ══════════════════════════════════════════════════════════════════════════════

describe('initSlack with nonInteractive: true — CLAUDE_AGENT_ID', () => {
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

  it('validates and writes CLAUDE_AGENT_ID via the nonInteractive path', async () => {
    mockAgentsRetrieve.mockResolvedValue(makeAgentResponse(VALID_AGENT_ID, VALID_AGENT_NAME));

    const result = await initSlack({
      nonInteractive: true,
      cwd: tmpDir,
      anthropicApiKey: VALID_API_KEY,
      claudeAgentId: VALID_AGENT_ID,
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    expect(result.agentId).toBe(VALID_AGENT_ID);
    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(VALID_AGENT_ID);
  });

  it('throws for stale CLAUDE_AGENT_ID via the nonInteractive path', async () => {
    mockAgentsRetrieve.mockRejectedValue(new Error('not found'));

    await expect(
      initSlack({
        nonInteractive: true,
        cwd: tmpDir,
        anthropicApiKey: VALID_API_KEY,
        claudeAgentId: STALE_AGENT_ID,
        slackBotToken: VALID_BOT_TOKEN,
        slackAppToken: VALID_APP_TOKEN,
        slackSigningSecret: VALID_SIGNING_SECRET,
      }),
    ).rejects.toThrow(/stale|invalid/i);
  });
});
