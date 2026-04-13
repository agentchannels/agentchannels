import { input, confirm, select, password } from '@inquirer/prompts';
import { writeEnvFile } from '../../config/env.js';
import { resolvePartialConfig } from '../../core/config.js';
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

  console.log('\n🔧 AgentChannels — Slack Setup\n');
  console.log('This wizard will help you configure a Slack bot for use with Claude Managed Agents.\n');

  // Step 1: App configuration preferences
  const appName = await input({
    message: 'What should your Slack bot be called?',
    default: 'AgentChannels Bot',
    validate: (value) => {
      if (!value.trim()) return 'App name cannot be empty';
      if (value.length > 35) return 'App name must be 35 characters or less';
      return true;
    },
  });

  const appDescription = await input({
    message: 'Short description for the app:',
    default: 'Claude AI agent connected to Slack via AgentChannels',
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
        name: 'Automatic — Create the app via Slack API (requires a Configuration Token)',
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

  if (setupMethod === 'automatic') {
    const credentials = await automaticSetup(appName, appDescription);
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
  console.log('   Next step: run `ach init agent` to configure your Claude agent.\n');

  return {
    appName,
    appDescription,
    botToken,
    appToken,
    signingSecret,
    envWritten,
  };
}

// ────────────────────────── Automatic Setup ──────────────────────────

/**
 * Credentials returned by the automatic setup flow.
 */
interface AutomaticSetupCredentials {
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
 * Requires a Slack Configuration Token which can be generated at:
 * https://api.slack.com/apps → Your Apps → Configuration tokens
 *
 * Steps:
 * 1. Prompt for the configuration token
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
  console.log('This method uses the Slack Configuration Token API to create your app automatically.');
  console.log('You can generate a Configuration Token at:');
  console.log('  https://api.slack.com/apps → Your Apps → Configuration tokens\n');

  const refreshToken = await password({
    message: 'Slack Configuration Refresh Token (xoxe-...):',
    validate: (value) => {
      if (!value.trim()) return 'Refresh token is required';
      if (!value.startsWith('xoxe-')) return 'Refresh token must start with xoxe-';
      if (value.length < 20) return 'Token appears too short';
      return true;
    },
  });

  // Step 0: Exchange refresh token for access token
  console.log('\n⏳ Rotating configuration token...');
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
    botToken,
    appToken,
    signingSecret,
    newRefreshToken: rotationResult.refresh_token,
  };
}
