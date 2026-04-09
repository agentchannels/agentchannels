import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { automaticSetup } from '../../../src/channels/slack/init.js';
import { SlackApiRequestError } from '../../../src/channels/slack/api.js';

// ────────────────────────── Mocks ──────────────────────────

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
}));

vi.mock('../../../src/channels/slack/oauth.js', () => ({
  addRedirectUrl: vi.fn().mockResolvedValue(undefined),
  runOAuthInstall: vi.fn().mockResolvedValue({
    botToken: 'xoxb-oauth-bot-token-1234567890',
    teamName: 'Test Workspace',
    teamId: 'T01TEST',
    botUserId: 'U01BOT',
  }),
}));

import { password, input } from '@inquirer/prompts';
import { addRedirectUrl, runOAuthInstall } from '../../../src/channels/slack/oauth.js';

// ────────────────────────── Helpers ──────────────────────────

function mockFetchSequence(responses: { body: object; status?: number }[]) {
  const mockFn = vi.fn();
  for (const resp of responses) {
    const status = resp.status ?? 200;
    mockFn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => resp.body,
    });
  }
  return mockFn;
}

const REFRESH_TOKEN = 'xoxe-test-refresh-token-12345678';
const MOCK_APP_TOKEN = 'xapp-1-auto-app-token-9876543210';

const MOCK_ROTATE_RESULT = {
  ok: true,
  token: 'xoxe-access-token-short-lived',
  refresh_token: 'xoxe-new-refresh-token-99999',
  exp: 1700000000,
  team_id: 'T01TEST',
  user_id: 'U01USER',
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

/** Standard 2-call sequence: rotate, create app */
function mockFullSequence() {
  return mockFetchSequence([
    { body: MOCK_ROTATE_RESULT },
    { body: MOCK_CREATE_RESULT },
  ]);
}

// ────────────────────────── Tests ──────────────────────────

describe('automaticSetup', () => {
  beforeEach(() => {
    vi.mocked(password).mockResolvedValue(REFRESH_TOKEN);
    vi.mocked(input).mockResolvedValue(MOCK_APP_TOKEN); // app-level token prompt
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates token, creates app, installs via OAuth, and collects app-level token', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await automaticSetup('TestBot', 'A test bot');

    expect(result.signingSecret).toBe('auto-signing-secret-abc123');
    expect(result.botToken).toBe('xoxb-oauth-bot-token-1234567890');
    expect(result.appToken).toBe(MOCK_APP_TOKEN);
    expect(result.newRefreshToken).toBe('xoxe-new-refresh-token-99999');

    // 2 fetch calls: rotate + create
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/tooling.tokens.rotate');
    expect(fetchMock.mock.calls[1][0]).toBe('https://slack.com/api/apps.manifest.create');

    // OAuth was used for install
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
      }),
    );

    // App-level token from user input
    expect(vi.mocked(input)).toHaveBeenCalled();
  });

  it('sends refresh_token as form body for rotation', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetup('TestBot', 'desc');

    const rotateOpts = fetchMock.mock.calls[0][1];
    expect(rotateOpts.headers?.Authorization).toBeUndefined();
    const bodyStr = rotateOpts.body instanceof URLSearchParams
      ? rotateOpts.body.toString()
      : String(rotateOpts.body);
    expect(bodyStr).toContain('refresh_token=');
  });

  it('uses the rotated access token for app creation', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetup('TestBot', 'desc');

    // Create call uses Bearer with access token
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${MOCK_ROTATE_RESULT.token}`,
    );
  });

  it('passes the manifest with correct app name and description', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetup('MyAgent', 'Agent description');

    const createBody = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    const manifest = JSON.parse(createBody.get('manifest')!);
    expect(manifest.display_information.name).toBe('MyAgent');
    expect(manifest.display_information.description).toBe('Agent description');
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });

  it('uses signing secret from create result', async () => {
    const fetchMock = mockFullSequence();
    vi.stubGlobal('fetch', fetchMock);

    const result = await automaticSetup('TestBot', 'desc');
    expect(result.signingSecret).toBe('auto-signing-secret-abc123');
  });

  it('throws when token rotation fails', async () => {
    const fetchMock = mockFetchSequence([
      { body: { ok: false, error: 'invalid_refresh_token' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(automaticSetup('TestBot', 'desc')).rejects.toThrow(SlackApiRequestError);
  });

  it('throws when app creation fails', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_ROTATE_RESULT },
      { body: { ok: false, error: 'invalid_manifest' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(automaticSetup('TestBot', 'desc')).rejects.toThrow(SlackApiRequestError);
  });
});
