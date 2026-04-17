/**
 * Sub-AC 3: Unit tests for stale agent ID warning.
 *
 * Core scenario:
 *   .env file contains CLAUDE_AGENT_ID=<stale-id>
 *   client.beta.agents.list() response does NOT contain the stale agent
 *   client.beta.agents.retrieve(<stale-id>) throws (agent deleted / inaccessible)
 *   → wizard must display an explicit warning — never silently drop the stale value.
 *
 * Paths covered:
 *   A) Interactive  — console.warn is called; warning contains the stale ID and
 *                     "stale"/"invalid" language; wizard completes with a replacement
 *   B) Non-interactive — Error is thrown; error message contains the stale ID,
 *                        "stale"/"invalid" language, and CLAUDE_AGENT_ID guidance
 *
 * Principle: transparent_stale_state_handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initSlack, initSlackNonInteractive } from '../../../src/channels/slack/init.js';

// ── SDK mock ──────────────────────────────────────────────────────────────────

const mockAgentsList = vi.fn();
const mockAgentsRetrieve = vi.fn();
const mockAgentsCreate = vi.fn();
const mockEnvironmentsRetrieve = vi.fn();
const mockEnvironmentsList = vi.fn();

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_API_KEY = 'sk-ant-api03-valid-key-12345678901234567890';
/** Agent ID that exists in .env but is absent from the API list / retrieve response */
const STALE_AGENT_ID = 'agent_stale_gone_999';
/** Agent ID returned by beta.agents.list() — a valid replacement, NOT the stale one */
const REPLACEMENT_AGENT_ID = 'agent_fresh_replacement_001';
const REPLACEMENT_AGENT_NAME = 'Fresh Replacement Agent';

const VALID_BOT_TOKEN = 'xoxb-test-bot-token-1234567890';
const VALID_APP_TOKEN = 'xapp-1-test-app-token-9876543210';
const VALID_SIGNING_SECRET = 'abc123def456ghi789jkl012';

function makeTmpDir(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-stale-warn-test-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

/**
 * Write a .env file containing a stale CLAUDE_AGENT_ID.
 * ANTHROPIC_API_KEY is included so the wizard reads it from file without prompting.
 * No CLAUDE_ENVIRONMENT_ID — environment step is skipped entirely.
 */
function seedEnvWithStaleAgent(dir: string): void {
  const lines = [
    `ANTHROPIC_API_KEY=${VALID_API_KEY}`,
    `CLAUDE_AGENT_ID=${STALE_AGENT_ID}`,
  ];
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n', 'utf-8');
}

function isolateEnv(): () => void {
  const keys = [
    'ANTHROPIC_API_KEY', 'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID', 'CLAUDE_VAULT_IDS',
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
// Interactive path: warning via console.warn
// ══════════════════════════════════════════════════════════════════════════════

describe(
  'initSlack (interactive) — stale CLAUDE_AGENT_ID from .env absent in beta.agents.list() (Sub-AC 3)',
  () => {
    let tmpDir: string;
    let cleanup: () => void;
    let restoreEnv: () => void;

    beforeEach(() => {
      vi.clearAllMocks();
      ({ tmpDir, cleanup } = makeTmpDir());
      restoreEnv = isolateEnv();

      // First beta.agents.list call: auth validation — succeeds, returns empty list
      mockAgentsList.mockResolvedValueOnce({ data: [] });

      // Stale agent: retrieve throws — agent no longer exists in API
      mockAgentsRetrieve.mockRejectedValue(new Error('404 Not Found'));

      // Second beta.agents.list call (after stale detection): replacement agents returned.
      // Critically, STALE_AGENT_ID is NOT in this list — it is absent.
      mockAgentsList.mockResolvedValueOnce({
        data: [{ id: REPLACEMENT_AGENT_ID, name: REPLACEMENT_AGENT_NAME, version: 1 }],
      });
    });

    afterEach(() => {
      cleanup();
      restoreEnv();
      vi.restoreAllMocks();
    });

    /**
     * Wire the minimum prompts needed after stale detection to complete the wizard.
     *
     * Post-stale prompt sequence:
     *   select → REPLACEMENT_AGENT_ID  (pick from replacement list)
     *   input  → 'Test Bot'            (Slack app name)
     *   input  → 'A test bot'          (Slack app description)
     *   select → 'manual'              (setup method)
     *   input  → VALID_BOT_TOKEN, VALID_APP_TOKEN, VALID_SIGNING_SECRET
     *   confirm → true                 (save to .env)
     *
     * No password prompt: ANTHROPIC_API_KEY is already in the seeded .env file.
     */
    async function wirePostStalePrompts() {
      const { input, confirm, select } = await import('@inquirer/prompts');
      vi.mocked(select)
        .mockResolvedValueOnce(REPLACEMENT_AGENT_ID as never)   // agent: pick replacement
        .mockResolvedValueOnce('manual' as never);              // Slack setup method
      vi.mocked(input)
        .mockResolvedValueOnce('Test Bot')           // Slack app name
        .mockResolvedValueOnce('A test bot')         // Slack app description
        .mockResolvedValueOnce(VALID_BOT_TOKEN)      // bot token
        .mockResolvedValueOnce(VALID_APP_TOKEN)      // app token
        .mockResolvedValueOnce(VALID_SIGNING_SECRET);// signing secret
      vi.mocked(confirm).mockResolvedValueOnce(true);// save to .env
    }

    it('displays console.warn when .env CLAUDE_AGENT_ID is absent from beta.agents.list() response', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      expect(warnSpy).toHaveBeenCalled();
    });

    it('warning message contains the stale agent ID read from .env', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      const allWarnings = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(allWarnings).toContain(STALE_AGENT_ID);
    });

    it('warning message uses "stale" or "invalid" language', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      const allWarnings = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(allWarnings).toMatch(/stale|invalid/i);
    });

    it('warning message instructs the user to select a different agent', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      const allWarnings = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(allWarnings).toMatch(/select|different|new one/i);
    });

    it('beta.agents.retrieve is called with the stale ID read from .env', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      expect(mockAgentsRetrieve).toHaveBeenCalledWith(STALE_AGENT_ID);
    });

    it('beta.agents.list() is called to provide replacement options after the stale warning', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      // Call 1: auth validation; call 2: listing agents for re-selection
      expect(mockAgentsList).toHaveBeenCalledTimes(2);
    });

    it('replacement list from beta.agents.list() does NOT include the stale agent ID', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      // Inspect the second list call's resolved data
      const secondListResult = await mockAgentsList.mock.results[1].value;
      const ids = (secondListResult.data as Array<{ id: string }>).map((a) => a.id);
      expect(ids).not.toContain(STALE_AGENT_ID);
    });

    it('wizard completes successfully with the replacement agent ID', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await initSlack({ cwd: tmpDir });

      expect(result.agentId).toBe(REPLACEMENT_AGENT_ID);
    });

    it('stale agent ID is NOT returned in wizard result', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await initSlack({ cwd: tmpDir });

      expect(result.agentId).not.toBe(STALE_AGENT_ID);
    });

    it('replacement agent ID is written to .env — stale ID is overwritten', async () => {
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      const envContents = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
      expect(envContents).toContain(REPLACEMENT_AGENT_ID);
      expect(envContents).not.toContain(STALE_AGENT_ID);
    });

    it('CLAUDE_AGENT_ID is read from .env file, not from env var or option', async () => {
      // Verify: env var is not set, option is not passed — only .env is the source
      expect(process.env.CLAUDE_AGENT_ID).toBeUndefined();
      seedEnvWithStaleAgent(tmpDir);
      await wirePostStalePrompts();
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await initSlack({ cwd: tmpDir });

      // The stale ID from .env must have been the one attempted
      expect(mockAgentsRetrieve).toHaveBeenCalledWith(STALE_AGENT_ID);
      expect(mockAgentsRetrieve).not.toHaveBeenCalledWith(REPLACEMENT_AGENT_ID);
    });
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// Non-interactive path: warning surfaced as thrown Error
// ══════════════════════════════════════════════════════════════════════════════

describe(
  'initSlackNonInteractive — stale CLAUDE_AGENT_ID from .env absent in beta.agents.list() (Sub-AC 3)',
  () => {
    let tmpDir: string;
    let cleanup: () => void;
    let restoreEnv: () => void;

    beforeEach(() => {
      vi.clearAllMocks();
      ({ tmpDir, cleanup } = makeTmpDir());
      restoreEnv = isolateEnv();

      // Auth validation succeeds
      mockAgentsList.mockResolvedValue({ data: [] });
      // Stale agent: retrieve throws — absent from API
      mockAgentsRetrieve.mockRejectedValue(new Error('404 Not Found'));
    });

    afterEach(() => {
      cleanup();
      restoreEnv();
      vi.restoreAllMocks();
    });

    it('throws when .env CLAUDE_AGENT_ID is absent from beta.agents.list() / API', async () => {
      seedEnvWithStaleAgent(tmpDir);

      await expect(
        initSlackNonInteractive({
          cwd: tmpDir,
          slackBotToken: VALID_BOT_TOKEN,
          slackAppToken: VALID_APP_TOKEN,
          slackSigningSecret: VALID_SIGNING_SECRET,
        }),
      ).rejects.toThrow();
    });

    it('error message contains the stale agent ID from .env', async () => {
      seedEnvWithStaleAgent(tmpDir);

      await expect(
        initSlackNonInteractive({
          cwd: tmpDir,
          slackBotToken: VALID_BOT_TOKEN,
          slackAppToken: VALID_APP_TOKEN,
          slackSigningSecret: VALID_SIGNING_SECRET,
        }),
      ).rejects.toThrow(new RegExp(STALE_AGENT_ID));
    });

    it('error message uses "stale" or "invalid" language', async () => {
      seedEnvWithStaleAgent(tmpDir);

      await expect(
        initSlackNonInteractive({
          cwd: tmpDir,
          slackBotToken: VALID_BOT_TOKEN,
          slackAppToken: VALID_APP_TOKEN,
          slackSigningSecret: VALID_SIGNING_SECRET,
        }),
      ).rejects.toThrow(/stale|invalid/i);
    });

    it('error message mentions CLAUDE_AGENT_ID to guide the user toward a fix', async () => {
      seedEnvWithStaleAgent(tmpDir);

      await expect(
        initSlackNonInteractive({
          cwd: tmpDir,
          slackBotToken: VALID_BOT_TOKEN,
          slackAppToken: VALID_APP_TOKEN,
          slackSigningSecret: VALID_SIGNING_SECRET,
        }),
      ).rejects.toThrow(/CLAUDE_AGENT_ID/);
    });

    it('reads CLAUDE_AGENT_ID from .env file (neither env var nor option is set)', async () => {
      // Confirm no env var leakage
      expect(process.env.CLAUDE_AGENT_ID).toBeUndefined();
      seedEnvWithStaleAgent(tmpDir);

      let thrown: Error | undefined;
      try {
        await initSlackNonInteractive({
          cwd: tmpDir,
          slackBotToken: VALID_BOT_TOKEN,
          slackAppToken: VALID_APP_TOKEN,
          slackSigningSecret: VALID_SIGNING_SECRET,
          // claudeAgentId not passed as option
        });
      } catch (e) {
        thrown = e as Error;
      }

      // Error was raised and retrieve was called with the .env-sourced ID
      expect(thrown).toBeDefined();
      expect(thrown?.message).toContain(STALE_AGENT_ID);
      expect(mockAgentsRetrieve).toHaveBeenCalledWith(STALE_AGENT_ID);
    });

    it('beta.agents.retrieve is called with the stale ID from .env', async () => {
      seedEnvWithStaleAgent(tmpDir);

      await expect(
        initSlackNonInteractive({
          cwd: tmpDir,
          slackBotToken: VALID_BOT_TOKEN,
          slackAppToken: VALID_APP_TOKEN,
          slackSigningSecret: VALID_SIGNING_SECRET,
        }),
      ).rejects.toThrow();

      expect(mockAgentsRetrieve).toHaveBeenCalledWith(STALE_AGENT_ID);
    });

    it('throws before Slack credential validation (fail-fast on stale agent)', async () => {
      // No Slack tokens provided — stale agent detection must fire first
      seedEnvWithStaleAgent(tmpDir);

      await expect(
        initSlackNonInteractive({ cwd: tmpDir }),
      ).rejects.toThrow(/stale|invalid/i);
    });
  },
);
