import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { automaticSetupNonInteractive, initSlack } from '../../../src/channels/slack/init.js';
import { SlackApiRequestError } from '../../../src/channels/slack/api.js';
import * as os from 'node:os';

// ────────────────────────── Mocks ──────────────────────────

vi.mock('../../../src/channels/slack/oauth.js', () => ({
  addRedirectUrl: vi.fn().mockResolvedValue(undefined),
  runOAuthInstall: vi.fn().mockResolvedValue({
    botToken: 'xoxb-oauth-bot-token-1234567890',
    teamName: 'Test Workspace',
    teamId: 'T01TEST',
    botUserId: 'U01BOT',
  }),
}));

// Mock writeEnvFile so tests don't write to disk
vi.mock('../../../src/config/env.js', () => ({
  writeEnvFile: vi.fn(),
}));

import { addRedirectUrl, runOAuthInstall } from '../../../src/channels/slack/oauth.js';

// ────────────────────────── Fixtures ──────────────────────────

const REFRESH_TOKEN = 'xoxe-test-refresh-token-12345678901234567890';

const MOCK_ROTATE_RESULT = {
  ok: true,
  token: 'xoxe-access-token-short-lived-abc123',
  refresh_token: 'xoxe-new-refresh-token-99999',
  exp: 1700000000,
  team: { id: 'T01TEST', name: 'Test Workspace' },
};

const MOCK_CREATE_RESULT = {
  ok: true,
  app_id: 'A01AUTOTEST',
  credentials: {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    signing_secret: 'auto-signing-secret-abc123',
    verification_token: 'test-vt',
  },
  oauth_authorize_url: 'https://slack.com/oauth/test',
};

const MOCK_APP_TOKEN_RESULT = {
  ok: true,
  token: 'xapp-1-auto-generated-token-9876543210',
  type: 'app_token',
  expires_in: 0,
};

/**
 * Returns a sequential fetch mock:
 *  1. tooling.tokens.rotate  → MOCK_ROTATE_RESULT
 *  2. apps.manifest.create   → MOCK_CREATE_RESULT
 *  3. apps.token.create      → MOCK_APP_TOKEN_RESULT
 */
function mockFullSequence(overrides: {
  rotate?: object;
  create?: object;
  appToken?: object;
} = {}) {
  const mockFn = vi.fn();
  const responses = [
    overrides.rotate ?? MOCK_ROTATE_RESULT,
    overrides.create ?? MOCK_CREATE_RESULT,
    overrides.appToken ?? MOCK_APP_TOKEN_RESULT,
  ];
  for (const body of responses) {
    mockFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    });
  }
  return mockFn;
}

// ────────────────────────── automaticSetupNonInteractive tests ──────────────────────────

describe('automaticSetupNonInteractive', () => {
  beforeEach(() => {
    vi.mocked(addRedirectUrl).mockResolvedValue(undefined);
    vi.mocked(runOAuthInstall).mockResolvedValue({
      botToken: 'xoxb-oauth-bot-token-1234567890',
      teamName: 'Test Workspace',
      teamId: 'T01TEST',
      botUserId: 'U01BOT',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates token, creates app, installs via OAuth, and generates app-level token via API', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await automaticSetupNonInteractive('TestBot', 'A test bot', REFRESH_TOKEN);

    expect(result.appId).toBe('A01AUTOTEST');
    expect(result.signingSecret).toBe('auto-signing-secret-abc123');
    expect(result.botToken).toBe('xoxb-oauth-bot-token-1234567890');
    expect(result.appToken).toBe('xapp-1-auto-generated-token-9876543210');
    expect(result.newRefreshToken).toBe('xoxe-new-refresh-token-99999');
  });

  it('uses the provided refresh token (no prompt) to rotate tokens', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN);

    const rotateCall = fetchMock.mock.calls[0];
    expect(rotateCall[0]).toBe('https://slack.com/api/tooling.tokens.rotate');

    // No Authorization header — token is sent as form body
    expect(rotateCall[1].headers?.Authorization).toBeUndefined();

    const bodyStr =
      rotateCall[1].body instanceof URLSearchParams
        ? rotateCall[1].body.toString()
        : String(rotateCall[1].body);
    expect(bodyStr).toContain(`refresh_token=${encodeURIComponent(REFRESH_TOKEN)}`);
  });

  it('uses the rotated access token (not the refresh token) for app creation', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN);

    const createCall = fetchMock.mock.calls[1];
    expect(createCall[1].headers.Authorization).toBe(
      `Bearer ${MOCK_ROTATE_RESULT.token}`,
    );
  });

  it('sends the manifest with correct app name and description', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetupNonInteractive('MyAgent', 'Agent description', REFRESH_TOKEN);

    const createBody = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    const manifest = JSON.parse(createBody.get('manifest')!);
    expect(manifest.display_information.name).toBe('MyAgent');
    expect(manifest.display_information.description).toBe('Agent description');
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });

  it('adds redirect URL and runs OAuth install for browser-based workspace auth', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN);

    expect(addRedirectUrl).toHaveBeenCalledWith(
      MOCK_ROTATE_RESULT.token,
      'A01AUTOTEST',
      'http://localhost:3333/oauth/callback',
    );

    expect(runOAuthInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'A01AUTOTEST',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        scopes: expect.arrayContaining(['app_mentions:read', 'chat:write', 'im:history']),
        port: 3333,
      }),
    );
  });

  it('generates app-level token via API — no manual Slack UI step', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN);

    // Third fetch call → apps.token.create
    const tokenCall = fetchMock.mock.calls[2];
    expect(tokenCall[0]).toBe('https://slack.com/api/apps.token.create');

    const tokenBody = new URLSearchParams(tokenCall[1].body);
    expect(tokenBody.get('app_id')).toBe('A01AUTOTEST');
    expect(tokenBody.get('scopes')).toContain('connections:write');
  });

  it('throws immediately on token rotation failure (no retry prompt)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'invalid_refresh_token' }),
    }));

    await expect(
      automaticSetupNonInteractive('TestBot', 'desc', 'xoxe-bad-token-123'),
    ).rejects.toThrow(SlackApiRequestError);
  });

  it('throws immediately on app creation failure (no retry prompt)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => MOCK_ROTATE_RESULT,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: false, error: 'invalid_manifest' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN),
    ).rejects.toThrow(SlackApiRequestError);
  });

  it('throws when OAuth install times out (propagated from runOAuthInstall)', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    vi.mocked(runOAuthInstall).mockRejectedValue(
      new Error('OAuth flow timed out after 5 minutes. Please try again.'),
    );

    await expect(
      automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN),
    ).rejects.toThrow('timed out after 5 minutes');
  });

  it('throws when app-level token generation fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => MOCK_ROTATE_RESULT,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => MOCK_CREATE_RESULT,
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: false, error: 'token_limit_reached' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN),
    ).rejects.toThrow(SlackApiRequestError);
  });

  it('returns the new refresh token (old one is invalidated after rotation)', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await automaticSetupNonInteractive('TestBot', 'desc', REFRESH_TOKEN);

    expect(result.newRefreshToken).toBe(MOCK_ROTATE_RESULT.refresh_token);
    expect(result.newRefreshToken).not.toBe(REFRESH_TOKEN);
  });
});

// ────────────────────────── Integration: initSlack non-interactive auto path ──────────────────────────

describe('initSlack non-interactive auto path (via SLACK_REFRESH_TOKEN)', () => {
  // Use os.tmpdir() as cwd so resolvePartialConfig finds no .env file with Slack tokens
  const isolatedCwd = os.tmpdir();

  beforeEach(() => {
    vi.mocked(addRedirectUrl).mockResolvedValue(undefined);
    vi.mocked(runOAuthInstall).mockResolvedValue({
      botToken: 'xoxb-oauth-bot-token-1234567890',
      teamName: 'Test Workspace',
      teamId: 'T01TEST',
    });

    // Clear any Slack env vars so they don't pollute path detection
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_REFRESH_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses SLACK_REFRESH_TOKEN env var when slackRefreshToken option is not set', async () => {
    process.env.SLACK_REFRESH_TOKEN = REFRESH_TOKEN;

    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
    });

    expect(result.botToken).toBe('xoxb-oauth-bot-token-1234567890');
    expect(result.appToken).toBe('xapp-1-auto-generated-token-9876543210');
    expect(result.signingSecret).toBe('auto-signing-secret-abc123');
  });

  it('prefers slackRefreshToken option over SLACK_REFRESH_TOKEN env var', async () => {
    process.env.SLACK_REFRESH_TOKEN = 'xoxe-env-token-should-not-be-used';

    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
      slackRefreshToken: REFRESH_TOKEN,
    });

    // Verify the option token (not the env token) was used in the rotate call
    const rotateBody =
      fetchMock.mock.calls[0][1].body instanceof URLSearchParams
        ? fetchMock.mock.calls[0][1].body.toString()
        : String(fetchMock.mock.calls[0][1].body);

    expect(rotateBody).toContain(encodeURIComponent(REFRESH_TOKEN));
    expect(rotateBody).not.toContain('xoxe-env-token-should-not-be-used');
  });

  it('uses custom appName and appDescription when provided', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
      slackRefreshToken: REFRESH_TOKEN,
      appName: 'Custom Agent',
      appDescription: 'My custom description',
    });

    expect(result.appName).toBe('Custom Agent');
    expect(result.appDescription).toBe('My custom description');

    const createBody = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    const manifest = JSON.parse(createBody.get('manifest')!);
    expect(manifest.display_information.name).toBe('Custom Agent');
  });

  it('falls back to default appName "General Agent" when not specified', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
      slackRefreshToken: REFRESH_TOKEN,
    });

    expect(result.appName).toBe('General Agent');
  });

  it('throws when no credentials provided at all', async () => {
    await expect(
      initSlack({ nonInteractive: true, cwd: isolatedCwd }),
    ).rejects.toThrow(/Non-interactive mode requires/);
  });
});

// ────────────────────────── AC 6: Refresh token precedence ──────────────────────────

describe('initSlack non-interactive — refresh token takes precedence over manual tokens', () => {
  // Use os.tmpdir() as cwd so resolvePartialConfig finds no .env file
  const isolatedCwd = os.tmpdir();

  const VALID_BOT_TOKEN = 'xoxb-manual-bot-token-1234567890';
  const VALID_APP_TOKEN = 'xapp-1-manual-app-token-9876543210';
  const VALID_SIGNING_SECRET = 'manual-signing-secret-abc123def456';

  beforeEach(() => {
    vi.mocked(addRedirectUrl).mockResolvedValue(undefined);
    vi.mocked(runOAuthInstall).mockResolvedValue({
      botToken: 'xoxb-oauth-bot-token-1234567890',
      teamName: 'Test Workspace',
      teamId: 'T01TEST',
      botUserId: 'U01BOT',
    });

    // Clear any Slack env vars
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_REFRESH_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses auto path (token rotation) when refresh token and manual tokens are all provided via options', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
      // Auto path credentials
      slackRefreshToken: REFRESH_TOKEN,
      // Manual path credentials — all three present, but should be ignored
      slackBotToken: VALID_BOT_TOKEN,
      slackAppToken: VALID_APP_TOKEN,
      slackSigningSecret: VALID_SIGNING_SECRET,
    });

    // Result should come from the auto path (OAuth install), not manual tokens
    expect(result.botToken).toBe('xoxb-oauth-bot-token-1234567890');
    expect(result.appToken).toBe('xapp-1-auto-generated-token-9876543210');
    expect(result.signingSecret).toBe('auto-signing-secret-abc123');

    // Manual tokens must NOT appear in the result
    expect(result.botToken).not.toBe(VALID_BOT_TOKEN);
    expect(result.appToken).not.toBe(VALID_APP_TOKEN);
    expect(result.signingSecret).not.toBe(VALID_SIGNING_SECRET);
  });

  it('invokes token rotation (not manual write) when refresh token env var is set alongside manual token env vars', async () => {
    process.env.SLACK_REFRESH_TOKEN = REFRESH_TOKEN;
    process.env.SLACK_BOT_TOKEN = VALID_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = VALID_APP_TOKEN;
    process.env.SLACK_SIGNING_SECRET = VALID_SIGNING_SECRET;

    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
    });

    // Auto path ran: token rotation was called
    const rotateCall = fetchMock.mock.calls[0];
    expect(rotateCall[0]).toBe('https://slack.com/api/tooling.tokens.rotate');

    // Result is from the auto path, not the manual env vars
    expect(result.botToken).toBe('xoxb-oauth-bot-token-1234567890');
    expect(result.botToken).not.toBe(VALID_BOT_TOKEN);
  });

  it('option-level refresh token beats env-level manual tokens', async () => {
    // Env has manual tokens
    process.env.SLACK_BOT_TOKEN = VALID_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = VALID_APP_TOKEN;
    process.env.SLACK_SIGNING_SECRET = VALID_SIGNING_SECRET;

    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    // But option provides refresh token
    const result = await initSlack({
      nonInteractive: true,
      skipEnvWrite: true,
      cwd: isolatedCwd,
      slackRefreshToken: REFRESH_TOKEN,
    });

    // Auto path wins
    expect(result.botToken).toBe('xoxb-oauth-bot-token-1234567890');
    expect(result.botToken).not.toBe(VALID_BOT_TOKEN);

    // Token rotation was called
    const rotateCall = fetchMock.mock.calls[0];
    expect(rotateCall[0]).toBe('https://slack.com/api/tooling.tokens.rotate');
  });
});
