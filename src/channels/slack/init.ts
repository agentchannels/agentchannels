import { input, confirm, select, password } from '@inquirer/prompts';
import { writeEnvFile } from '../../config/env.js';
import { resolvePartialConfig } from '../../core/config.js';
import type { ConfigOverrides } from '../../core/config.js';
import { buildSlackManifest } from './manifest.js';
import { SlackApiClient, SlackApiRequestError } from './api.js';
import { addRedirectUrl, runOAuthInstall } from './oauth.js';

/**
 * Result of the Slack init wizard
 */
export interface SlackInitResult {
  appName: string;
  appDescription: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
  envWritten: boolean;
}

/**
 * Options for controlling the init flow (useful for testing)
 */
export interface SlackInitOptions {
  /** Skip writing to .env file */
  skipEnvWrite?: boolean;
  /** Working directory for .env file */
  cwd?: string;
  /**
   * Run without interactive prompts.
   * Path is inferred from which credentials are provided:
   *   - Manual path: slackBotToken + slackAppToken + slackSigningSecret
   *   - Auto path:   slackRefreshToken
   */
  nonInteractive?: boolean;
  /** Slack Bot Token override (xoxb-...) — CLI flag or env var SLACK_BOT_TOKEN */
  slackBotToken?: string;
  /** Slack App-Level Token override (xapp-...) — CLI flag or env var SLACK_APP_TOKEN */
  slackAppToken?: string;
  /** Slack Signing Secret override — CLI flag or env var SLACK_SIGNING_SECRET */
  slackSigningSecret?: string;
  /** Slack Refresh Token for automatic setup (xoxe-...) — CLI flag or env var SLACK_REFRESH_TOKEN */
  slackRefreshToken?: string;
  /** App name for non-interactive automatic setup (default: "General Agent") */
  appName?: string;
  /** App description for non-interactive automatic setup */
  appDescription?: string;
}

/**
 * Setup method type for the init wizard
 */
export type SetupMethod = 'automatic' | 'guided' | 'manual';

/**
 * Interactive prompt flow for `ach init slack`.
 *
 * Guides the user through:
 * 1. Naming their Slack app
 * 2. Choosing setup method (automatic, guided, or manual)
 * 3. Collecting credentials (bot token, app token, signing secret)
 * 4. Writing credentials to .env
 */
export async function initSlack(options: SlackInitOptions = {}): Promise<SlackInitResult> {
  const cwd = options.cwd ?? process.cwd();

  // Non-interactive mode: infer path from provided credentials, skip all prompts
  if (options.nonInteractive) {
    return initSlackNonInteractive({ ...options, cwd });
  }

  console.log('\n🔧 Agent Channels — Slack Setup\n');
  console.log('This wizard will help you configure a Slack bot for use with Claude Managed Agents.\n');

  // Step 1: App configuration preferences
  const appName = await input({
    message: 'What should your Slack bot be called?',
    default: 'General Agent',
    validate: (value) => {
      if (!value.trim()) return 'App name cannot be empty';
      if (value.length > 35) return 'App name must be 35 characters or less';
      return true;
    },
  });

  const appDescription = await input({
    message: 'Short description for the app:',
    default: 'AI agent for your team — powered by agentchannels',
    validate: (value) => {
      if (value.length > 140) return 'Description must be 140 characters or less';
      return true;
    },
  });

  // Step 2: Setup method
  const setupMethod = await select<SetupMethod>({
    message: 'How would you like to set up the Slack app?',
    choices: [
      {
        name: 'Automatic — Create the app via Slack API (requires a Refresh Token)',
        value: 'automatic',
      },
      {
        name: 'Guided — I\'ll create the app on api.slack.com and paste tokens here',
        value: 'guided',
      },
      {
        name: 'Manual — I already have bot token, app token, and signing secret',
        value: 'manual',
      },
    ],
  });

  let botToken: string;
  let appToken: string;
  let signingSecret: string;

  let newRefreshToken: string | undefined;
  let appId: string | undefined;

  if (setupMethod === 'automatic') {
    const credentials = await automaticSetup(appName, appDescription);
    appId = credentials.appId;
    botToken = credentials.botToken;
    appToken = credentials.appToken;
    signingSecret = credentials.signingSecret;
    newRefreshToken = credentials.newRefreshToken;
  } else {
    if (setupMethod === 'guided') {
      console.log('\n📋 Follow these steps to create your Slack app:\n');

      // Generate and display manifest
      const manifest = buildSlackManifest({
        appName,
        appDescription,
        socketMode: true,
      });

      console.log('1. Go to https://api.slack.com/apps');
      console.log('2. Click "Create New App" → "From a manifest"');
      console.log('3. Select your workspace');
      console.log('4. Paste this manifest (JSON):\n');
      console.log('─'.repeat(60));
      console.log(JSON.stringify(manifest, null, 2));
      console.log('─'.repeat(60));
      console.log('\n5. Click "Create"');
      console.log('6. Go to "Basic Information" → copy the Signing Secret');
      console.log('7. Go to "OAuth & Permissions" → "Install to Workspace" → copy Bot Token');
      console.log('8. Go to "Basic Information" → "App-Level Tokens" → create a token');
      console.log('   with scope "connections:write" → copy the token\n');

      await confirm({
        message: 'Ready to enter your credentials?',
        default: true,
      });
    }

    // Collect credentials manually for both guided and manual flows
    // Resolve existing values from CLI flags > env vars > .env file
    const existing = resolvePartialConfig({ cwd });

    botToken = await input({
      message: 'Slack Bot Token (xoxb-...):',
      default: existing.slackBotToken || undefined,
      validate: (value) => {
        if (!value.startsWith('xoxb-')) return 'Bot token must start with xoxb-';
        if (value.length < 20) return 'Token appears too short';
        return true;
      },
    });

    if (setupMethod === 'manual') {
      console.log('\n💡 Before continuing, make sure your Slack app has:');
      console.log('   1. Socket Mode enabled: Settings → Socket Mode → Enable Socket Mode');
      console.log('   2. App-Level Token with "connections:write" scope:');
      console.log('      Basic Information → App-Level Tokens → Generate Token and Scopes\n');
    }

    appToken = await input({
      message: 'Slack App-Level Token (xapp-...):',
      default: existing.slackAppToken || undefined,
      validate: (value) => {
        if (!value.startsWith('xapp-')) return 'App token must start with xapp-';
        if (value.length < 20) return 'Token appears too short';
        return true;
      },
    });

    signingSecret = await input({
      message: 'Slack Signing Secret:',
      default: existing.slackSigningSecret || undefined,
      validate: (value) => {
        if (!value.trim()) return 'Signing secret is required';
        if (value.length < 10) return 'Signing secret appears too short';
        return true;
      },
    });
  }

  // Step 4: Write to .env
  let envWritten = false;

  if (!options.skipEnvWrite) {
    const shouldWrite = await confirm({
      message: 'Save these credentials to .env file?',
      default: true,
    });

    if (shouldWrite) {
      const envVars: Record<string, string> = {
        SLACK_BOT_TOKEN: botToken,
        SLACK_APP_TOKEN: appToken,
        SLACK_SIGNING_SECRET: signingSecret,
      };
      if (newRefreshToken) {
        envVars.SLACK_REFRESH_TOKEN = newRefreshToken;
      }
      writeEnvFile(envVars, cwd);
      envWritten = true;
      console.log('\n✅ Slack credentials saved to .env');
    } else {
      console.log('\n⚠️  Credentials not saved. You can set them as environment variables:');
      console.log(`   SLACK_BOT_TOKEN=${botToken}`);
      console.log(`   SLACK_APP_TOKEN=${appToken}`);
      console.log(`   SLACK_SIGNING_SECRET=${signingSecret}`);
    }
  }

  console.log('\n✅ Slack setup complete!');
  if (appId) {
    console.log(`\n💡 Want a custom logo? Upload one at:`);
    console.log(`   https://api.slack.com/apps/${appId}/general#edit`);
  } else {
    console.log(`\n💡 Want a custom logo? Upload one at:`);
    console.log(`   https://api.slack.com/apps → select your app → Basic Information`);
  }
  console.log('\n   Next step: run `ach init agent` to configure your Claude agent.\n');

  return {
    appName,
    appDescription,
    botToken,
    appToken,
    signingSecret,
    envWritten,
  };
}

// ────────────────────────── Non-Interactive Setup ──────────────────────────

/**
 * Non-interactive Slack init.  Infers which path to take from the supplied
 * credentials — no prompts are shown.
 *
 * Path selection (in priority order):
 *  1. Auto path    — SLACK_REFRESH_TOKEN present → token rotation + app
 *                    creation via Slack API (takes priority over manual tokens)
 *  2. Manual path  — SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_SIGNING_SECRET
 *                    all present → validate and write directly to .env
 *
 * When both SLACK_REFRESH_TOKEN and the full set of manual tokens are provided,
 * the auto path wins: a new Slack app is created via the API using the refresh
 * token, and the manual tokens are ignored.
 *
 * Credentials are resolved with three-source precedence:
 *   CLI flags (options.*) > process.env > .env file
 *
 * @throws {Error} if insufficient credentials are provided for either path
 */
export async function initSlackNonInteractive(
  options: SlackInitOptions & { cwd: string },
): Promise<SlackInitResult> {
  const { cwd, skipEnvWrite } = options;

  // Resolve three-source config for standard Slack tokens
  const overrides: ConfigOverrides = {
    slackBotToken: options.slackBotToken,
    slackAppToken: options.slackAppToken,
    slackSigningSecret: options.slackSigningSecret,
  };
  const config = resolvePartialConfig({ overrides, cwd });

  const botToken = config.slackBotToken;
  const appToken = config.slackAppToken;
  const signingSecret = config.slackSigningSecret;

  // SLACK_REFRESH_TOKEN is not in the standard config map — read directly
  const refreshToken =
    options.slackRefreshToken ??
    process.env.SLACK_REFRESH_TOKEN ??
    undefined;

  // ── Auto path takes priority: explicit refresh token → create new app ────
  // Checked first so that providing SLACK_REFRESH_TOKEN always triggers app
  // creation via the Slack API, even if manual tokens are also set in env.
  if (refreshToken) {
    const appName = options.appName ?? 'General Agent';
    const appDescription =
      options.appDescription ?? 'AI agent for your team — powered by agentchannels';

    console.log('\n🔧 Agent Channels — Slack Setup (non-interactive / automatic)\n');

    const credentials = await automaticSetupNonInteractive(appName, appDescription, refreshToken);

    let envWritten = false;
    if (!skipEnvWrite) {
      writeEnvFile(
        {
          SLACK_BOT_TOKEN: credentials.botToken,
          SLACK_APP_TOKEN: credentials.appToken,
          SLACK_SIGNING_SECRET: credentials.signingSecret,
          SLACK_REFRESH_TOKEN: credentials.newRefreshToken,
        },
        cwd,
      );
      envWritten = true;
      console.log('\n✅ Slack credentials saved to .env');
    }

    console.log('\n✅ Slack setup complete!');
    console.log(`\n💡 Want a custom logo? Upload one at:`);
    console.log(`   https://api.slack.com/apps/${credentials.appId}/general#edit`);
    console.log('\n   Next step: run `ach init agent` to configure your Claude agent.\n');

    return {
      appName,
      appDescription,
      botToken: credentials.botToken,
      appToken: credentials.appToken,
      signingSecret: credentials.signingSecret,
      envWritten,
    };
  }

  // ── Manual path: all three tokens provided directly ───────────────────
  if (botToken && appToken && signingSecret) {
    return initSlackManual({ botToken, appToken, signingSecret, cwd, skipEnvWrite });
  }

  // ── Neither path has enough credentials ────────────────────────────────
  throw new Error(
    'Non-interactive mode requires credentials for one of these paths:\n' +
      '  Manual path: SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_SIGNING_SECRET\n' +
      '  Auto path:   SLACK_REFRESH_TOKEN\n' +
      'Set these as environment variables, CLI flags, or in a .env file.',
  );
}

/**
 * Execute the manual path: validate provided tokens and write them to .env.
 * No prompts — all credentials must already be resolved.
 */
async function initSlackManual(options: {
  botToken: string;
  appToken: string;
  signingSecret: string;
  cwd: string;
  skipEnvWrite?: boolean;
}): Promise<SlackInitResult> {
  const { botToken, appToken, signingSecret, cwd, skipEnvWrite } = options;

  // Validate token formats
  if (!botToken.startsWith('xoxb-')) {
    throw new Error(
      'SLACK_BOT_TOKEN must start with "xoxb-". Got: ' + botToken.slice(0, 10) + '...',
    );
  }
  if (botToken.length < 20) {
    throw new Error('SLACK_BOT_TOKEN appears too short (minimum 20 characters)');
  }
  if (!appToken.startsWith('xapp-')) {
    throw new Error(
      'SLACK_APP_TOKEN must start with "xapp-". Got: ' + appToken.slice(0, 10) + '...',
    );
  }
  if (appToken.length < 20) {
    throw new Error('SLACK_APP_TOKEN appears too short (minimum 20 characters)');
  }
  if (!signingSecret.trim()) {
    throw new Error('SLACK_SIGNING_SECRET is required');
  }
  if (signingSecret.length < 10) {
    throw new Error('SLACK_SIGNING_SECRET appears too short (minimum 10 characters)');
  }

  console.log('\n🔧 Agent Channels — Slack Setup (non-interactive / manual)\n');
  console.log('All three credentials provided — writing directly to .env\n');

  let envWritten = false;
  if (!skipEnvWrite) {
    writeEnvFile(
      {
        SLACK_BOT_TOKEN: botToken,
        SLACK_APP_TOKEN: appToken,
        SLACK_SIGNING_SECRET: signingSecret,
      },
      cwd,
    );
    envWritten = true;
    console.log('✅ Slack credentials saved to .env');
  }

  console.log('\n✅ Slack setup complete!');
  console.log('\n   Next step: run `ach init agent` to configure your Claude agent.\n');

  return {
    appName: '',
    appDescription: '',
    botToken,
    appToken,
    signingSecret,
    envWritten,
  };
}

// ────────────────────────── Non-Interactive Automatic Setup ──────────────────────────

/**
 * Non-interactive automatic setup: takes the refresh token as a parameter
 * (no prompt), drives the full token-rotation → app-creation → OAuth-install
 * → app-level-token flow without any user interaction.
 *
 * Blocks up to 5 minutes waiting for the browser-based OAuth callback
 * (the timeout is enforced by `runOAuthInstall` in oauth.ts).
 *
 * Unlike the interactive `automaticSetup`, this function:
 *  - Receives the refresh token directly (not via a password prompt)
 *  - Does NOT retry on error — throws immediately so callers can handle it
 *  - Generates the app-level token via the Slack API (`apps.token.create`)
 *    instead of asking the user to create one manually in the Slack UI
 *
 * @throws {SlackApiRequestError} on any Slack API failure
 * @throws {Error} if the OAuth callback times out (> 5 minutes)
 */
export async function automaticSetupNonInteractive(
  appName: string,
  appDescription: string,
  refreshToken: string,
): Promise<AutomaticSetupCredentials> {
  console.log('\n🤖 Automatic Setup via Slack API\n');

  // Step 0: Rotate the refresh token → short-lived access token
  console.log('⏳ Rotating refresh token...');
  const rotationResult = await SlackApiClient.rotateConfigToken(refreshToken);
  console.log(
    `   ✅ Token rotated${rotationResult.team?.name ? ` (workspace: ${rotationResult.team.name})` : ''}`,
  );
  console.log('   ⚠️  Your old refresh token is now invalidated.');
  console.log(`   📝 New refresh token: ${rotationResult.refresh_token.slice(0, 20)}...`);

  const client = new SlackApiClient({ accessToken: rotationResult.token });

  // Step 1: Create app from manifest → signing secret
  console.log('\n⏳ Creating Slack app from manifest...');
  const manifest = buildSlackManifest({ appName, appDescription, socketMode: true });
  const createResult = await client.createAppFromManifest(manifest);
  const appId = createResult.app_id;
  const signingSecret = createResult.credentials.signing_secret;
  console.log(`   ✅ App created: ${appId}`);

  // Step 2: Install app to workspace via OAuth (local server + browser open)
  const scopes = [
    'app_mentions:read', 'channels:history', 'channels:read', 'chat:write',
    'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
    'mpim:history', 'mpim:read', 'users:read',
  ];

  console.log('⏳ Updating manifest with OAuth redirect URL...');
  const port = 3333;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  await addRedirectUrl(rotationResult.token, appId, redirectUri);

  console.log('⏳ Installing app to workspace via OAuth...');
  console.log('   A browser window will open for authorization.');
  console.log('   Waiting up to 5 minutes for browser callback...');

  const installResult = await runOAuthInstall({
    appId,
    clientId: createResult.credentials.client_id,
    clientSecret: createResult.credentials.client_secret,
    scopes,
    port,
  });

  const botToken = installResult.botToken;
  console.log(`   ✅ App installed to workspace: ${installResult.teamName}`);

  // Step 3: Generate app-level token via API (no manual step — uses apps.token.create)
  console.log('\n⏳ Generating app-level token...');
  const appTokenResult = await client.generateAppLevelToken(appId);
  const appToken = appTokenResult.token;
  console.log('   ✅ App-level token generated');

  console.log(`\n🎉 Slack app "${appName}" created and configured successfully!\n`);

  return {
    appId,
    botToken,
    appToken,
    signingSecret,
    newRefreshToken: rotationResult.refresh_token,
  };
}

// ────────────────────────── Automatic Setup ──────────────────────────

/**
 * Credentials returned by the automatic setup flow.
 */
interface AutomaticSetupCredentials {
  appId: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
  /** New refresh token from token rotation (old one is invalidated) */
  newRefreshToken: string;
}

/**
 * Automatic setup flow that uses the Slack Manifest API to create an app,
 * install it to the workspace, and generate all required tokens.
 *
 * Requires a Slack Refresh Token which can be generated at:
 * https://api.slack.com/apps → Your Apps → Refresh tokens
 *
 * Steps:
 * 1. Prompt for the refresh token
 * 2. Create the app from a manifest (→ signing secret)
 * 3. Install the app to the workspace (→ bot token)
 * 4. Generate an app-level token (→ app token for Socket Mode)
 *
 * @throws {SlackApiRequestError} if any Slack API call fails
 */
export async function automaticSetup(
  appName: string,
  appDescription: string,
): Promise<AutomaticSetupCredentials> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await _automaticSetupAttempt(appName, appDescription);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Slack setup failed: ${message}\n`);

      const retry = await confirm({
        message: 'Would you like to retry?',
        default: true,
      });

      if (!retry) {
        throw error;
      }
      console.log(''); // blank line before retry
    }
  }
}

async function _automaticSetupAttempt(
  appName: string,
  appDescription: string,
): Promise<AutomaticSetupCredentials> {
  console.log('\n🤖 Automatic Setup via Slack API\n');
  console.log('This method uses a Slack Refresh Token to create your app automatically.');
  console.log('You can generate a Refresh Token at:');
  console.log('  https://api.slack.com/apps → Your Apps → Refresh tokens\n');

  const refreshToken = await password({
    message: 'Slack Refresh Token (xoxe-...):',
    validate: (value) => {
      if (!value.trim()) return 'Refresh token is required';
      if (!value.startsWith('xoxe-')) return 'Refresh token must start with xoxe-';
      if (value.length < 20) return 'Token appears too short';
      return true;
    },
  });

  // Step 0: Exchange refresh token for access token
  console.log('\n⏳ Rotating refresh token...');
  const rotationResult = await SlackApiClient.rotateConfigToken(refreshToken);
  console.log(`   ✅ Token rotated${rotationResult.team?.name ? ` (workspace: ${rotationResult.team.name})` : ''}`);
  console.log('   ⚠️  Your old refresh token is now invalidated.');
  console.log(`   📝 New refresh token: ${rotationResult.refresh_token.slice(0, 20)}...`);

  const client = new SlackApiClient({ accessToken: rotationResult.token });

  // Step 1: Create app from manifest
  console.log('\n⏳ Creating Slack app from manifest...');
  const manifest = buildSlackManifest({
    appName,
    appDescription,
    socketMode: true,
  });

  const createResult = await client.createAppFromManifest(manifest);
  const appId = createResult.app_id;
  const signingSecret = createResult.credentials.signing_secret;
  console.log(`   ✅ App created: ${appId}`);

  // Step 2: Install app via OAuth flow (automated)
  const scopes = [
    'app_mentions:read', 'channels:history', 'channels:read', 'chat:write',
    'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
    'mpim:history', 'mpim:read', 'users:read',
  ];

  console.log('⏳ Updating manifest with OAuth redirect URL...');
  const port = 3333;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  await addRedirectUrl(rotationResult.token, appId, redirectUri);

  console.log('⏳ Installing app to workspace via OAuth...');
  console.log('   A browser window will open for authorization.');

  const installResult = await runOAuthInstall({
    appId,
    clientId: createResult.credentials.client_id,
    clientSecret: createResult.credentials.client_secret,
    scopes,
    port,
  });

  const botToken = installResult.botToken;
  console.log(`   ✅ App installed to workspace: ${installResult.teamName}`);

  // Step 3: App-level token (must be created manually in Slack UI)
  console.log('\n📋 One last step — create an App-Level Token:\n');
  console.log(`   1. Go to https://api.slack.com/apps/${appId}/general`);
  console.log('   2. Under "App-Level Tokens", click "Generate Token and Scopes"');
  console.log('   3. Name it (e.g. "socket"), add scope "connections:write", click "Generate"');
  console.log('   4. Copy the token (starts with xapp-)\n');

  const appToken = await input({
    message: 'Paste your App-Level Token (xapp-...):',
    validate: (value) => {
      if (!value.startsWith('xapp-')) return 'App-level token must start with xapp-';
      if (value.length < 20) return 'Token appears too short';
      return true;
    },
  });

  console.log(`\n🎉 Slack app "${appName}" created and configured successfully!\n`);

  return {
    appId,
    botToken,
    appToken,
    signingSecret,
    newRefreshToken: rotationResult.refresh_token,
  };
}
