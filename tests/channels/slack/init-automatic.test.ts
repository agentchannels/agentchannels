import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { automaticSetup } from '../../../src/channels/slack/init.js';
import { SlackApiRequestError } from '../../../src/channels/slack/api.js';

// ────────────────────────── Mocks ──────────────────────────

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
}));

// We import after mocking so we get the mocked version
import { password } from '@inquirer/prompts';

// ────────────────────────── Helpers ──────────────────────────

function mockFetch(responseBody: object, httpStatus = 200) {
  return vi.fn().mockResolvedValue({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    statusText: httpStatus === 200 ? 'OK' : 'Bad Request',
    json: async () => responseBody,
  });
}

/**
 * Builds a sequential fetch mock that returns different responses
 * for each successive call (create app, install, generate token).
 */
function mockFetchSequence(responses: { body: object; status?: number }[]) {
  const mockFn = vi.fn();
  for (const [i, resp] of responses.entries()) {
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

const CONFIG_TOKEN = 'xoxe-test-config-token-12345678';

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

const MOCK_INSTALL_RESULT = {
  ok: true,
  app_id: 'A01AUTOTEST',
  bot_token: 'xoxb-auto-bot-token-1234567890',
};

const MOCK_TOKEN_RESULT = {
  ok: true,
  token: 'xapp-1-auto-app-token-9876543210',
  type: 'app_token',
  expires_in: 0,
};

// ────────────────────────── Tests ──────────────────────────

describe('automaticSetup', () => {
  beforeEach(() => {
    vi.mocked(password).mockResolvedValue(CONFIG_TOKEN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates app, installs, generates token, and returns all credentials', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: MOCK_INSTALL_RESULT },
      { body: MOCK_TOKEN_RESULT },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await automaticSetup('TestBot', 'A test bot');

    expect(result.signingSecret).toBe('auto-signing-secret-abc123');
    expect(result.botToken).toBe('xoxb-auto-bot-token-1234567890');
    expect(result.appToken).toBe('xapp-1-auto-app-token-9876543210');

    // Verify 3 API calls were made in order
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Call 1: apps.manifest.create
    const [createUrl] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('https://slack.com/api/apps.manifest.create');

    // Call 2: tooling.tokens.rotate (install)
    const [installUrl] = fetchMock.mock.calls[1];
    expect(installUrl).toBe('https://slack.com/api/tooling.tokens.rotate');

    // Call 3: apps.token.create (app-level token)
    const [tokenUrl] = fetchMock.mock.calls[2];
    expect(tokenUrl).toBe('https://slack.com/api/apps.token.create');
  });

  it('passes the manifest with correct app name and description', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: MOCK_INSTALL_RESULT },
      { body: MOCK_TOKEN_RESULT },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetup('MyAgent', 'Agent description');

    // Verify the manifest content
    const createBody = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    const manifest = JSON.parse(createBody.get('manifest')!);
    expect(manifest.display_information.name).toBe('MyAgent');
    expect(manifest.display_information.description).toBe('Agent description');
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });

  it('passes the app_id from create result to install and token generation', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: MOCK_INSTALL_RESULT },
      { body: MOCK_TOKEN_RESULT },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetup('TestBot', 'desc');

    // Install call should use the app_id
    const installBody = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    expect(installBody.get('app_id')).toBe('A01AUTOTEST');

    // Token generation should use the app_id
    const tokenBody = new URLSearchParams(fetchMock.mock.calls[2][1].body);
    expect(tokenBody.get('app_id')).toBe('A01AUTOTEST');
  });

  it('uses the configuration token from the prompt for auth', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: MOCK_INSTALL_RESULT },
      { body: MOCK_TOKEN_RESULT },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await automaticSetup('TestBot', 'desc');

    // All calls should use Bearer auth with the config token
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe(`Bearer ${CONFIG_TOKEN}`);
    }
  });

  it('throws SlackApiRequestError when app creation fails', async () => {
    const fetchMock = mockFetch({
      ok: false,
      error: 'invalid_manifest',
      response_metadata: { messages: ['bad field: name'] },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      automaticSetup('TestBot', 'desc'),
    ).rejects.toThrow(SlackApiRequestError);
  });

  it('throws SlackApiRequestError when install fails', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: { ok: false, error: 'not_allowed' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      automaticSetup('TestBot', 'desc'),
    ).rejects.toThrow(SlackApiRequestError);
  });

  it('throws when install succeeds but no bot token is returned', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: { ok: true, app_id: 'A01AUTOTEST' } }, // no bot_token
      { body: MOCK_TOKEN_RESULT },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      automaticSetup('TestBot', 'desc'),
    ).rejects.toThrow('no bot token was returned');
  });

  it('throws SlackApiRequestError when token generation fails', async () => {
    const fetchMock = mockFetchSequence([
      { body: MOCK_CREATE_RESULT },
      { body: MOCK_INSTALL_RESULT },
      { body: { ok: false, error: 'token_limit_reached' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      automaticSetup('TestBot', 'desc'),
    ).rejects.toThrow(SlackApiRequestError);
  });
});
