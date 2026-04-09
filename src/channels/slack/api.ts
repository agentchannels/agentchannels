/**
 * Slack API client for programmatic app management.
 *
 * Wraps Slack's HTTP APIs for:
 * - Creating apps from a manifest (apps.manifest.create)
 * - Generating app-level tokens (apps.manifest.create + auth)
 * - Installing apps to a workspace
 *
 * These APIs require a **Configuration Token** (issued at
 * https://api.slack.com/apps → "Your Apps" → "Configuration tokens").
 *
 * @see https://api.slack.com/methods/apps.manifest.create
 * @see https://api.slack.com/methods/apps.connections.open
 */

const SLACK_API_BASE = 'https://slack.com/api';

// ────────────────────────── Types ──────────────────────────

export interface SlackApiError {
  ok: false;
  error: string;
  response_metadata?: {
    messages?: string[];
  };
}

export interface CreateAppResult {
  ok: true;
  app_id: string;
  /** OAuth credentials returned on creation */
  credentials: {
    client_id: string;
    client_secret: string;
    signing_secret: string;
    verification_token: string;
  };
  oauth_authorize_url: string;
}

export interface AppLevelTokenResult {
  ok: true;
  token: string;
  /** e.g. "app_token" */
  type: string;
  /** Token expiration in seconds, 0 means never */
  expires_in: number;
}

export interface TokenRotationResult {
  ok: true;
  /** Short-lived access token for API calls */
  token: string;
  /** New refresh token (old one is invalidated — must be saved) */
  refresh_token: string;
  /** Expiration time (unix timestamp) */
  exp: number;
  /** Team info (may be absent for org-level configuration tokens) */
  team?: { id: string; name: string };
  /** Bot user ID */
  bot_user_id?: string;
}

export interface SlackApiClientOptions {
  /** Short-lived access token obtained from tooling.tokens.rotate */
  accessToken: string;
  /** Override API base URL (useful for testing) */
  apiBase?: string;
}

// ────────────────────────── Client ──────────────────────────

/**
 * Low-level Slack API client for managing Slack apps programmatically.
 *
 * Requires an access token obtained by rotating a Configuration Refresh Token
 * via `SlackApiClient.rotateConfigToken()`.
 *
 * All methods throw on HTTP-level errors and return the parsed Slack response
 * (which should be checked for `ok: true` / `ok: false`).
 */
export class SlackApiClient {
  private readonly accessToken: string;
  private readonly apiBase: string;

  constructor(options: SlackApiClientOptions) {
    if (!options.accessToken) {
      throw new Error('Access token is required (obtain via SlackApiClient.rotateConfigToken())');
    }
    this.accessToken = options.accessToken;
    this.apiBase = options.apiBase ?? SLACK_API_BASE;
  }

  /**
   * Exchange a Configuration Refresh Token (xoxe-...) for a short-lived access token.
   *
   * IMPORTANT: Each refresh token is single-use. After calling this, the old
   * refresh token is invalidated. Save the new refresh_token from the response.
   *
   * @param refreshToken - The configuration refresh token (xoxe-...)
   * @param apiBase - Optional API base URL override
   * @returns Access token + new refresh token
   */
  static async rotateConfigToken(
    refreshToken: string,
    apiBase: string = SLACK_API_BASE,
  ): Promise<TokenRotationResult> {
    const url = `${apiBase}/tooling.tokens.rotate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      throw new SlackApiRequestError(
        `Slack API HTTP error: ${response.status} ${response.statusText}`,
        'tooling.tokens.rotate',
      );
    }

    const data = (await response.json()) as TokenRotationResult | SlackApiError;

    if (!data.ok) {
      throw new SlackApiRequestError(
        `Token rotation failed: ${(data as SlackApiError).error}`,
        'tooling.tokens.rotate',
        data as SlackApiError,
      );
    }

    return data as TokenRotationResult;
  }

  // ──────────── apps.manifest.create ────────────

  /**
   * Create a new Slack app from a JSON manifest.
   *
   * @param manifest - The Slack app manifest object
   *   (@see https://api.slack.com/reference/manifests)
   * @returns The created app's ID and OAuth credentials
   * @throws {SlackApiRequestError} on HTTP or Slack API errors
   */
  async createAppFromManifest(
    manifest: object,
  ): Promise<CreateAppResult> {
    const response = await this.post('apps.manifest.create', {
      manifest: JSON.stringify(manifest),
    }) as CreateAppResult | SlackApiError;

    if (!response.ok) {
      throw new SlackApiRequestError(
        `Failed to create app from manifest: ${(response as SlackApiError).error}`,
        'apps.manifest.create',
        response as SlackApiError,
      );
    }

    return response as CreateAppResult;
  }

  // ──────────── App-Level Token generation ────────────

  /**
   * Generate an app-level token for an existing Slack app.
   *
   * App-level tokens (xapp-...) are used for Socket Mode connections.
   * The token is created with the `connections:write` scope by default.
   *
   * @param appId - The Slack app ID (e.g. A01ABC23DEF)
   * @param tokenName - Human-readable name for the token
   * @param scopes - Token scopes (defaults to ['connections:write'])
   * @returns The generated app-level token
   * @throws {SlackApiRequestError} on HTTP or Slack API errors
   *
   * @see https://api.slack.com/methods/apps.token.create (undocumented but used by Slack UI)
   */
  async generateAppLevelToken(
    appId: string,
    tokenName: string = 'agentchannels-socket',
    scopes: string[] = ['connections:write'],
  ): Promise<AppLevelTokenResult> {
    const response = await this.post('apps.token.create', {
      app_id: appId,
      name: tokenName,
      scopes: scopes.join(','),
    }) as AppLevelTokenResult | SlackApiError;

    if (!response.ok) {
      throw new SlackApiRequestError(
        `Failed to generate app-level token: ${(response as SlackApiError).error}`,
        'apps.token.create',
        response as SlackApiError,
      );
    }

    return response as AppLevelTokenResult;
  }

  // ──────────── App Installation ────────────

  // Note: Slack app installation requires the full OAuth v2 flow
  // (redirect to slack.com/oauth/v2/authorize → user approves → redirect back with code).
  // This cannot be done via a simple API call. The CLI guides the user through
  // manual installation and collects the bot token interactively.

  // ──────────── Helper: POST to Slack API ────────────

  /**
   * Make an authenticated POST request to a Slack API method.
   */
  private async post(
    method: string,
    body: Record<string, string>,
  ): Promise<unknown> {
    const url = `${this.apiBase}/${method}`;

    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      formData.append(key, value);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new SlackApiRequestError(
        `Slack API HTTP error: ${response.status} ${response.statusText}`,
        method,
      );
    }

    return (await response.json()) as Record<string, unknown>;
  }
}

// ────────────────────────── Error ──────────────────────────

/**
 * Custom error for Slack API failures with structured metadata.
 */
export class SlackApiRequestError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly slackError?: SlackApiError,
  ) {
    super(message);
    this.name = 'SlackApiRequestError';
  }
}
