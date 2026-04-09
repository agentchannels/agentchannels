import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SlackApiClient,
  SlackApiRequestError,
  type CreateAppResult,
  type AppLevelTokenResult,
  type SlackApiError,
} from '../../../src/channels/slack/api.js';

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
 * for each successive call.
 */
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

const VALID_CREATE_RESPONSE: CreateAppResult = {
  ok: true,
  app_id: 'A01TEST',
  credentials: {
    client_id: 'cid',
    client_secret: 'csec',
    signing_secret: 'ssec',
    verification_token: 'vt',
  },
  oauth_authorize_url: 'https://slack.com/oauth/test',
};

const VALID_TOKEN_RESPONSE: AppLevelTokenResult = {
  ok: true,
  token: 'xapp-1-test-token',
  type: 'app_token',
  expires_in: 0,
};


// ────────────────────────── Tests ──────────────────────────

describe('SlackApiClient', () => {
  const CONFIG_TOKEN = 'xoxe-test-config-token-123';
  let client: SlackApiClient;

  beforeEach(() => {
    client = new SlackApiClient({ accessToken: CONFIG_TOKEN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────── Constructor / Token Validation ────────────

  describe('constructor and token validation', () => {
    it('throws if configuration token is empty string', () => {
      expect(() => new SlackApiClient({ accessToken: '' })).toThrow(
        'Access token is required',
      );
    });

    it('creates client with valid token', () => {
      const c = new SlackApiClient({ accessToken: 'xoxe-valid-token' });
      expect(c).toBeInstanceOf(SlackApiClient);
    });

    it('uses default API base when not provided', async () => {
      const fetchMock = mockFetch(VALID_CREATE_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      await client.createAppFromManifest({});

      expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/slack\.com\/api\//);
    });

    it('uses custom API base URL when provided', async () => {
      const customClient = new SlackApiClient({
        accessToken: CONFIG_TOKEN,
        apiBase: 'https://custom.slack.test/api',
      });

      const fetchMock = mockFetch(VALID_CREATE_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      await customClient.createAppFromManifest({});

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://custom.slack.test/api/apps.manifest.create',
      );
    });
  });

  // ──────────── HTTP request details ────────────

  describe('HTTP request details', () => {
    it('sends Authorization header with Bearer token', async () => {
      const fetchMock = mockFetch(VALID_CREATE_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      await client.createAppFromManifest({});

      const options = fetchMock.mock.calls[0][1];
      expect(options.headers.Authorization).toBe(`Bearer ${CONFIG_TOKEN}`);
    });

    it('sends Content-Type as application/x-www-form-urlencoded', async () => {
      const fetchMock = mockFetch(VALID_CREATE_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      await client.createAppFromManifest({});

      const options = fetchMock.mock.calls[0][1];
      expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('sends POST method for all API calls', async () => {
      const fetchMock = mockFetchSequence([
        { body: VALID_CREATE_RESPONSE },
        { body: VALID_TOKEN_RESPONSE },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      await client.createAppFromManifest({});
      await client.generateAppLevelToken('A01TEST');

      for (const call of fetchMock.mock.calls) {
        expect(call[1].method).toBe('POST');
      }
    });
  });

  // ──────────── createAppFromManifest ────────────

  describe('createAppFromManifest', () => {
    it('sends manifest as JSON string to apps.manifest.create', async () => {
      const manifest = { display_information: { name: 'Test' } };
      const fetchMock = mockFetch(VALID_CREATE_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      const result = await client.createAppFromManifest(manifest);

      expect(result.ok).toBe(true);
      expect(result.app_id).toBe('A01TEST');
      expect(result.credentials.signing_secret).toBe('ssec');

      // Verify URL
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://slack.com/api/apps.manifest.create');

      // Verify manifest is serialized
      const body = new URLSearchParams(options.body);
      expect(JSON.parse(body.get('manifest')!)).toEqual(manifest);
    });

    it('returns full credentials from response', async () => {
      vi.stubGlobal('fetch', mockFetch(VALID_CREATE_RESPONSE));

      const result = await client.createAppFromManifest({});

      expect(result.credentials).toEqual({
        client_id: 'cid',
        client_secret: 'csec',
        signing_secret: 'ssec',
        verification_token: 'vt',
      });
      expect(result.oauth_authorize_url).toBe('https://slack.com/oauth/test');
    });

    it('throws SlackApiRequestError on Slack API error response', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ ok: false, error: 'invalid_manifest' }),
      );

      await expect(
        client.createAppFromManifest({ bad: true }),
      ).rejects.toThrow(SlackApiRequestError);

      await expect(
        client.createAppFromManifest({ bad: true }),
      ).rejects.toThrow('invalid_manifest');
    });

    it('includes response_metadata in thrown error', async () => {
      const errorResponse: SlackApiError = {
        ok: false,
        error: 'invalid_manifest',
        response_metadata: {
          messages: ['invalid field: name is too long', 'missing required field: bot_events'],
        },
      };
      vi.stubGlobal('fetch', mockFetch(errorResponse));

      try {
        await client.createAppFromManifest({});
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SlackApiRequestError);
        const apiErr = err as SlackApiRequestError;
        expect(apiErr.method).toBe('apps.manifest.create');
        expect(apiErr.slackError?.error).toBe('invalid_manifest');
        expect(apiErr.slackError?.response_metadata?.messages).toHaveLength(2);
        expect(apiErr.slackError?.response_metadata?.messages?.[0]).toContain('name is too long');
      }
    });

    it('throws on HTTP-level failure (e.g. 500)', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 500));

      await expect(
        client.createAppFromManifest({}),
      ).rejects.toThrow('Slack API HTTP error');
    });

    it('throws on HTTP 403 (forbidden)', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 403));

      await expect(
        client.createAppFromManifest({}),
      ).rejects.toThrow('Slack API HTTP error');
    });

    it('propagates network errors from fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      await expect(
        client.createAppFromManifest({}),
      ).rejects.toThrow('fetch failed');
    });
  });

  // ──────────── generateAppLevelToken ────────────

  describe('generateAppLevelToken', () => {
    it('creates an app-level token with default scopes', async () => {
      const fetchMock = mockFetch(VALID_TOKEN_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      const result = await client.generateAppLevelToken('A01TEST');

      expect(result.ok).toBe(true);
      expect(result.token).toBe('xapp-1-test-token');
      expect(result.type).toBe('app_token');
      expect(result.expires_in).toBe(0);

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(body.get('app_id')).toBe('A01TEST');
      expect(body.get('scopes')).toBe('connections:write');
      expect(body.get('name')).toBe('agentchannels-socket');
    });

    it('calls the correct API endpoint', async () => {
      const fetchMock = mockFetch(VALID_TOKEN_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      await client.generateAppLevelToken('A01TEST');

      expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/apps.token.create');
    });

    it('accepts custom token name and scopes', async () => {
      const fetchMock = mockFetch({
        ok: true,
        token: 'xapp-custom',
        type: 'app_token',
        expires_in: 3600,
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await client.generateAppLevelToken(
        'A01TEST',
        'my-custom-token',
        ['connections:write', 'authorizations:read'],
      );

      expect(result.expires_in).toBe(3600);

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(body.get('name')).toBe('my-custom-token');
      expect(body.get('scopes')).toBe('connections:write,authorizations:read');
    });

    it('throws SlackApiRequestError when token creation fails', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ ok: false, error: 'app_not_found' }),
      );

      try {
        await client.generateAppLevelToken('INVALID');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SlackApiRequestError);
        const apiErr = err as SlackApiRequestError;
        expect(apiErr.method).toBe('apps.token.create');
        expect(apiErr.slackError?.error).toBe('app_not_found');
      }
    });

    it('throws on HTTP-level failure', async () => {
      vi.stubGlobal('fetch', mockFetch({}, 401));

      await expect(
        client.generateAppLevelToken('A01TEST'),
      ).rejects.toThrow('Slack API HTTP error');
    });

    it('propagates network errors from fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      await expect(
        client.generateAppLevelToken('A01TEST'),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  // ──────────── Full creation flow (end-to-end sequence) ────────────

  describe('full creation flow', () => {
    it('chains create → token generation successfully', async () => {
      const fetchMock = mockFetchSequence([
        { body: VALID_CREATE_RESPONSE },
        { body: VALID_TOKEN_RESPONSE },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const createResult = await client.createAppFromManifest({
        display_information: { name: 'FlowTest' },
      });
      expect(createResult.app_id).toBe('A01TEST');

      const tokenResult = await client.generateAppLevelToken(createResult.app_id);
      expect(tokenResult.token).toBe('xapp-1-test-token');

      for (const call of fetchMock.mock.calls) {
        expect(call[1].headers.Authorization).toBe(`Bearer ${CONFIG_TOKEN}`);
      }

      expect(fetchMock.mock.calls[0][0]).toContain('apps.manifest.create');
      expect(fetchMock.mock.calls[1][0]).toContain('apps.token.create');
    });

    it('stops flow if app creation fails', async () => {
      const fetchMock = mockFetch({ ok: false, error: 'invalid_manifest' });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        client.createAppFromManifest({}),
      ).rejects.toThrow(SlackApiRequestError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops flow if token generation fails after creation', async () => {
      const fetchMock = mockFetchSequence([
        { body: VALID_CREATE_RESPONSE },
        { body: { ok: false, error: 'token_limit_reached' } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const createResult = await client.createAppFromManifest({});
      await expect(
        client.generateAppLevelToken(createResult.app_id),
      ).rejects.toThrow(SlackApiRequestError);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

// ────────────────────────── SlackApiRequestError ──────────────────────────

describe('SlackApiRequestError', () => {
  it('is an instance of Error', () => {
    const err = new SlackApiRequestError('test', 'method');
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name property', () => {
    const err = new SlackApiRequestError('test', 'method');
    expect(err.name).toBe('SlackApiRequestError');
  });

  it('stores the method name', () => {
    const err = new SlackApiRequestError('msg', 'apps.manifest.create');
    expect(err.method).toBe('apps.manifest.create');
  });

  it('stores the slack error response when provided', () => {
    const slackError: SlackApiError = {
      ok: false,
      error: 'invalid_token',
      response_metadata: { messages: ['token expired'] },
    };
    const err = new SlackApiRequestError('msg', 'method', slackError);

    expect(err.slackError).toBeDefined();
    expect(err.slackError?.error).toBe('invalid_token');
    expect(err.slackError?.response_metadata?.messages).toEqual(['token expired']);
  });

  it('has undefined slackError when not provided', () => {
    const err = new SlackApiRequestError('msg', 'method');
    expect(err.slackError).toBeUndefined();
  });

  it('preserves error message', () => {
    const err = new SlackApiRequestError('Something went wrong', 'apps.token.create');
    expect(err.message).toBe('Something went wrong');
  });

  it('has a proper stack trace', () => {
    const err = new SlackApiRequestError('test', 'method');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('SlackApiRequestError');
  });
});
