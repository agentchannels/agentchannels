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

export interface InstallAppResult {
  ok: true;
  app_id: string;
  /**
   * Bot token for the installed workspace.
   * Only available when using tooling tokens / test installs.
   */
  bot_token?: string;
}

export interface SlackApiClientOptions {
  /** Slack Configuration Token (xoxe-...) for app management APIs */
  configurationToken: string;
  /** Override API base URL (useful for testing) */
  apiBase?: string;
}

// ────────────────────────── Client ──────────────────────────

/**
 * Low-level Slack API client for managing Slack apps programmatically.
 *
 * All methods throw on HTTP-level errors and return the parsed Slack response
 * (which should be checked for `ok: true` / `ok: false`).
 */
export class SlackApiClient {
  private readonly configurationToken: string;
  private readonly apiBase: string;

  constructor(options: SlackApiClientOptions) {
    if (!options.configurationToken) {
      throw new Error('Slack Configuration Token is required');
    }
    this.configurationToken = options.configurationToken;
    this.apiBase = options.apiBase ?? SLACK_API_BASE;
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

  /**
   * Install (or request installation of) a Slack app to the workspace
   * associated with the configuration token.
   *
   * This uses the tooling-install endpoint which performs a "test install"
   * without requiring the full OAuth flow. The app must already be created.
   *
   * @param appId - The Slack app ID to install
   * @returns Install result including optional bot token
   * @throws {SlackApiRequestError} on HTTP or Slack API errors
   *
   * @see https://api.slack.com/methods/tooling.tokens.rotate
   */
  async installApp(
    appId: string,
  ): Promise<InstallAppResult> {
    const response = await this.post('tooling.tokens.rotate', {
      app_id: appId,
    }) as InstallAppResult | SlackApiError;

    if (!response.ok) {
      throw new SlackApiRequestError(
        `Failed to install app to workspace: ${(response as SlackApiError).error}`,
        'tooling.tokens.rotate',
        response as SlackApiError,
      );
    }

    return response as InstallAppResult;
  }

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
        Authorization: `Bearer ${this.configurationToken}`,
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
