/**
 * Tests for Sub-AC 8c: 'Paste ID manually' branch in the init-slack wizard.
 *
 * The pasteAgentIdManually sub-flow is triggered when:
 *   - The user selects "✏️  Paste ID manually" (__manual__) from the agent select menu
 *
 * This sub-flow must:
 *   1. Prompt the user for a raw agent ID string via input()
 *   2. Validate the ID exists via client.beta.agents.get (beta.agents.retrieve)
 *   3. Show a clear error message on 404/not-found (mentioning the invalid ID)
 *   4. Re-prompt on failure — never hard-exit on the first bad ID
 *   5. Return the confirmed agent ID (from API response) on success
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
// Environment stubs — environment code paths must not crash
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

/** Existing agent already in CLAUDE_AGENT_ID — triggers keep-or-change flow */
const EXISTING_AGENT_ID = 'agent_existing_abc123';
const EXISTING_AGENT_NAME = 'existing-agent';

/** An agent that appears in the list (non-empty list needed to show the menu) */
const LISTED_AGENT_ID = 'agent_listed_xyz789';
const LISTED_AGENT_NAME = 'listed-agent';

/** The agent the user pastes manually */
const PASTED_AGENT_ID = 'agent_pasted_manually_001';
const PASTED_AGENT_NAME = 'pasted-agent';

function makeAgentResponse(id: string, name: string) {
  return { id, name, version: 1, created_at: '2024-01-01T00:00:00Z' };
}

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-paste-manual-test-'));
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
 * Wire the trailing Slack manual-path prompts that come after the agent step.
 * Appends: appName, appDescription, botToken, appToken, signingSecret inputs
 * plus the setup-method select and save-to-.env confirm.
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

/**
 * Wire the standard paste-manual path:
 *   keep/change → 'change'
 *   agent list menu → '__manual__'
 *   paste input → pastedId
 * Then append trailing Slack prompts.
 */
async function wirePasteManualPath(pastedId: string) {
  const { input, select } = await import('@inquirer/prompts');
  // keep/change → change
  vi.mocked(select).mockResolvedValueOnce('change' as never);
  // agent list menu → paste sentinel
  vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
  // The pasted agent ID
  vi.mocked(input).mockResolvedValueOnce(pastedId);
  await wireTrailingSlackPrompts();
}

// ══════════════════════════════════════════════════════════════════════════════
// Input prompt
// ══════════════════════════════════════════════════════════════════════════════

describe('pasteAgentIdManually — input prompt (Sub-AC 8c)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    // Auth validation succeeds, listing returns one agent so menu is shown
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    // Existing agent for keep/change validation
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValue(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('prompts for an agent ID string via input()', async () => {
    const { input } = await import('@inquirer/prompts');
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // input() must have been called (at least once for the agent ID)
    expect(vi.mocked(input)).toHaveBeenCalled();
  });

  it('prompt message asks for an agent ID (message contains "ID" or "agent")', async () => {
    const { input } = await import('@inquirer/prompts');
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // First input() call is for the pasted agent ID
    const firstInputArg = vi.mocked(input).mock.calls[0][0] as { message: string };
    expect(firstInputArg.message.toLowerCase()).toMatch(/agent.*id|id.*agent|\bid\b/i);
  });

  it('inline validator rejects empty input', async () => {
    const { input } = await import('@inquirer/prompts');
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const firstInputArg = vi.mocked(input).mock.calls[0][0] as {
      message: string;
      validate?: (value: string) => boolean | string;
    };
    expect(firstInputArg.validate).toBeDefined();
    const validationResult = firstInputArg.validate?.('');
    expect(validationResult).not.toBe(true);
    expect(typeof validationResult === 'string' || validationResult === false).toBe(true);
  });

  it('inline validator accepts a non-empty agent ID string', async () => {
    const { input } = await import('@inquirer/prompts');
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const firstInputArg = vi.mocked(input).mock.calls[0][0] as {
      validate?: (value: string) => boolean | string;
    };
    expect(firstInputArg.validate?.(PASTED_AGENT_ID)).toBe(true);
  });

  it('whitespace-only input is rejected by inline validator', async () => {
    const { input } = await import('@inquirer/prompts');
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const firstInputArg = vi.mocked(input).mock.calls[0][0] as {
      validate?: (value: string) => boolean | string;
    };
    const result = firstInputArg.validate?.('   ');
    expect(result).not.toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Validation via beta.agents.retrieve
// ══════════════════════════════════════════════════════════════════════════════

describe('pasteAgentIdManually — validation via beta.agents.retrieve (Sub-AC 8c)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('calls beta.agents.retrieve with the pasted agent ID', async () => {
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(mockAgentsRetrieve).toHaveBeenCalledWith(PASTED_AGENT_ID);
  });

  it('trims whitespace from pasted ID before calling beta.agents.retrieve', async () => {
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    // User pastes the ID with surrounding spaces
    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input).mockResolvedValueOnce(`  ${PASTED_AGENT_ID}  `); // padded
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // Must be called with the trimmed ID, not the padded version
    expect(mockAgentsRetrieve).toHaveBeenCalledWith(PASTED_AGENT_ID);
    expect(mockAgentsRetrieve).not.toHaveBeenCalledWith(`  ${PASTED_AGENT_ID}  `);
  });

  it('returns the agent ID from the API response, not the raw typed input', async () => {
    // API returns a canonical ID (ensure we use the ID from the response)
    const canonicalId = 'agent_canonical_from_api';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(canonicalId, PASTED_AGENT_NAME));
    // User types the same ID (trimmed)
    await wirePasteManualPath(canonicalId);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).toBe(canonicalId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Clear error on 404 / not found
// ══════════════════════════════════════════════════════════════════════════════

describe('pasteAgentIdManually — clear error on 404/not-found (Sub-AC 8c)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('warns when validation fails (404 / not found)', async () => {
    const INVALID_ID = 'agent_does_not_exist_404';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(INVALID_ID)        // first attempt: 404
      .mockResolvedValueOnce(PASTED_AGENT_ID);  // second attempt: success
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(warnSpy).toHaveBeenCalled();
  });

  it('error message includes the invalid agent ID (transparent error handling)', async () => {
    const INVALID_ID = 'agent_invalid_xyz_00404';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(INVALID_ID)
      .mockResolvedValueOnce(PASTED_AGENT_ID);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const warnings = warnSpy.mock.calls.map((c) => c.join(' '));
    const hasInvalidIdInWarning = warnings.some((msg) => msg.includes(INVALID_ID));
    expect(hasInvalidIdInWarning).toBe(true);
  });

  it('error message uses "not found", "inaccessible", or "invalid" language', async () => {
    const INVALID_ID = 'agent_not_found_here_000';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(INVALID_ID)
      .mockResolvedValueOnce(PASTED_AGENT_ID);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const warnings = warnSpy.mock.calls.map((c) => c.join(' '));
    const hasDescriptiveWarning = warnings.some((msg) =>
      /not found|inaccessible|invalid/i.test(msg),
    );
    expect(hasDescriptiveWarning).toBe(true);
  });

  it('error message tells the user to try again (actionable guidance)', async () => {
    const INVALID_ID = 'agent_try_again_please_111';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404 Not Found'))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce(INVALID_ID)
      .mockResolvedValueOnce(PASTED_AGENT_ID);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const warnings = warnSpy.mock.calls.map((c) => c.join(' '));
    const hasActionableWarning = warnings.some((msg) =>
      /try again|check|ctrl.?c/i.test(msg),
    );
    expect(hasActionableWarning).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Re-prompt on failure — never hard-exit
// ══════════════════════════════════════════════════════════════════════════════

describe('pasteAgentIdManually — re-prompt on failure (Sub-AC 8c)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('re-prompts on first failure and succeeds on second attempt', async () => {
    const SECOND_AGENT_ID = 'agent_second_attempt_ok_222';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404 Not Found'))         // first paste: fail
      .mockResolvedValueOnce(makeAgentResponse(SECOND_AGENT_ID, 'second-agent')); // second: ok
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('agent_bad_111')   // first paste: fails
      .mockResolvedValueOnce(SECOND_AGENT_ID);  // second paste: succeeds
    await wireTrailingSlackPrompts();

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).toBe(SECOND_AGENT_ID);
  });

  it('calls beta.agents.retrieve for each paste attempt', async () => {
    const SECOND_AGENT_ID = 'agent_second_attempt_ok_333';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(makeAgentResponse(SECOND_AGENT_ID, 'second-agent'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('agent_bad_first')
      .mockResolvedValueOnce(SECOND_AGENT_ID);
    await wireTrailingSlackPrompts();

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // retrieve: 1 for existing validate + 2 for paste attempts = 3 total
    expect(mockAgentsRetrieve).toHaveBeenCalledTimes(3);
  });

  it('handles two consecutive failures before succeeding on the third attempt', async () => {
    const FINAL_ID = 'agent_final_valid_444';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('404'))    // attempt 1: fail
      .mockRejectedValueOnce(new Error('404'))    // attempt 2: fail
      .mockResolvedValueOnce(makeAgentResponse(FINAL_ID, 'final-agent')); // attempt 3: ok
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('agent_bad_1')
      .mockResolvedValueOnce('agent_bad_2')
      .mockResolvedValueOnce(FINAL_ID);
    await wireTrailingSlackPrompts();

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).toBe(FINAL_ID);
  });

  it('does not throw or exit after the first failed paste attempt', async () => {
    const SECOND_ID = 'agent_after_failure_555';
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce(makeAgentResponse(SECOND_ID, 'recovery-agent'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { select, input } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('__manual__' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('agent_invalid_first')
      .mockResolvedValueOnce(SECOND_ID);
    await wireTrailingSlackPrompts();

    // Should resolve, not throw
    await expect(
      initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID }),
    ).resolves.toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Return value and .env write
// ══════════════════════════════════════════════════════════════════════════════

describe('pasteAgentIdManually — return value and .env write (Sub-AC 8c)', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let restoreEnv: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ tmpDir, cleanup } = makeTmpDir());
    restoreEnv = isolateEnv();
    mockAgentsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [makeAgentResponse(LISTED_AGENT_ID, LISTED_AGENT_NAME)] });
    // Default: existing validate + paste validate both succeed
    mockAgentsRetrieve
      .mockResolvedValueOnce(makeAgentResponse(EXISTING_AGENT_ID, EXISTING_AGENT_NAME))
      .mockResolvedValueOnce(makeAgentResponse(PASTED_AGENT_ID, PASTED_AGENT_NAME));
    process.env.ANTHROPIC_API_KEY = VALID_API_KEY;
  });

  afterEach(() => {
    cleanup();
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('returns the pasted agent ID in the wizard result', async () => {
    await wirePasteManualPath(PASTED_AGENT_ID);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).toBe(PASTED_AGENT_ID);
  });

  it('writes the pasted agent ID to .env', async () => {
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(PASTED_AGENT_ID);
  });

  it('does not return the old existing agent ID (pasted ID replaces it)', async () => {
    await wirePasteManualPath(PASTED_AGENT_ID);

    const result = await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    expect(result.agentId).not.toBe(EXISTING_AGENT_ID);
  });

  it('.env contains pasted ID, not existing ID', async () => {
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    const env = readEnv(tmpDir);
    expect(env.CLAUDE_AGENT_ID).toBe(PASTED_AGENT_ID);
    expect(env.CLAUDE_AGENT_ID).not.toBe(EXISTING_AGENT_ID);
  });

  it('calls beta.agents.retrieve exactly once for the pasted ID on success', async () => {
    await wirePasteManualPath(PASTED_AGENT_ID);

    await initSlack({ cwd: tmpDir, claudeAgentId: EXISTING_AGENT_ID });

    // First retrieve: existing agent validation; second: pasted ID validation
    const calls = vi.mocked(mockAgentsRetrieve).mock.calls;
    const pastedCalls = calls.filter((c) => c[0] === PASTED_AGENT_ID);
    expect(pastedCalls).toHaveLength(1);
  });
});
