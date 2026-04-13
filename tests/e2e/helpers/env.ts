/**
 * E2E environment variable helpers.
 *
 * The e2e suite requires contributor-specific env vars for live Slack API access.
 * When any of these are absent the entire describe block is skipped gracefully,
 * so `pnpm test` remains green for contributors who haven't set them up.
 */

// ---------------------------------------------------------------------------
// Required env vars
// ---------------------------------------------------------------------------

const REQUIRED_SLACK_VARS = [
  "SLACK_TEST_USER_TOKEN", // xoxp- token for posting as a Slack user
  "SLACK_TEST_CHANNEL_ID", // ID of the dedicated test channel
  "SLACK_BOT_TOKEN",       // Bot token (xoxb-)
  "SLACK_APP_TOKEN",       // App-level token (xapp-)
] as const;

type RequiredSlackVar = (typeof REQUIRED_SLACK_VARS)[number];

/** Env vars for live Slack API access in e2e tests */
export interface E2EEnv {
  SLACK_TEST_USER_TOKEN: string;
  SLACK_TEST_CHANNEL_ID: string;
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of required e2e env vars that are currently missing.
 * An empty array means all vars are set and the suite may run.
 */
export function getMissingE2EVars(): string[] {
  return REQUIRED_SLACK_VARS.filter((v) => !process.env[v]);
}

/**
 * Returns the validated e2e env object, or undefined if any required vars
 * are missing. Call getMissingE2EVars() to get the specific missing names.
 */
export function getE2EEnv(): E2EEnv | undefined {
  if (getMissingE2EVars().length > 0) return undefined;
  return {
    SLACK_TEST_USER_TOKEN: process.env.SLACK_TEST_USER_TOKEN as string,
    SLACK_TEST_CHANNEL_ID: process.env.SLACK_TEST_CHANNEL_ID as string,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN as string,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN as string,
  };
}

/**
 * Returns true when all required e2e env vars are present.
 * Use this with `describe.skipIf(!isE2EEnabled)` at the top of the test.
 */
export const isE2EEnabled: boolean = getMissingE2EVars().length === 0;

/**
 * Parse the comma-separated `CLAUDE_VAULT_IDS` env var into a `string[]`.
 *
 * Mirrors the behaviour of `src/commands/serve.ts` so live recording mode
 * uses the same vaults the bot does in production. Returns `undefined` when
 * the var is unset or empty — the AgentClient then skips `vault_ids` on
 * session creation.
 */
export function parseVaultIds(): string[] | undefined {
  const raw = process.env.CLAUDE_VAULT_IDS;
  if (!raw) return undefined;
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}
