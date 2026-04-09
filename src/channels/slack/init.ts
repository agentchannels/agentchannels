import { input, confirm, select, password } from '@inquirer/prompts';
import { writeEnvFile } from '../../config/env.js';
import { resolvePartialConfig } from '../../core/config.js';
import { buildSlackManifest } from './manifest.js';
import { SlackApiClient, SlackApiRequestError } from './api.js';

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

  if (setupMethod === 'automatic') {
    const credentials = await automaticSetup(appName, appDescription);
    botToken = credentials.botToken;
    appToken = credentials.appToken;
    signingSecret = credentials.signingSecret;
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
      writeEnvFile(
        {
          SLACK_BOT_TOKEN: botToken,
          SLACK_APP_TOKEN: appToken,
          SLACK_SIGNING_SECRET: signingSecret,
        },
        cwd,
      );
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
  console.log('\n🤖 Automatic Setup via Slack API\n');
  console.log('This method uses the Slack Configuration Token API to create your app automatically.');
  console.log('You can generate a Configuration Token at:');
  console.log('  https://api.slack.com/apps → Your Apps → Configuration tokens\n');

  const configToken = await password({
    message: 'Slack Configuration Token (xoxe-...):',
    validate: (value) => {
      if (!value.trim()) return 'Configuration token is required';
      if (!value.startsWith('xoxe-')) return 'Configuration token must start with xoxe-';
      if (value.length < 20) return 'Token appears too short';
      return true;
    },
  });

  const client = new SlackApiClient({ configurationToken: configToken });

  // Step 1: Create app from manifest
  console.log('\n⏳ Creating Slack app from manifest...');
  const manifest = buildSlackManifest({
    appName,
    appDescription,
    socketMode: true,
  });

  let createResult;
  try {
    createResult = await client.createAppFromManifest(manifest);
  } catch (error) {
    if (error instanceof SlackApiRequestError) {
      console.error(`\n❌ Failed to create app: ${error.message}`);
      if (error.slackError?.response_metadata?.messages) {
        for (const msg of error.slackError.response_metadata.messages) {
          console.error(`   ${msg}`);
        }
      }
    }
    throw error;
  }

  const appId = createResult.app_id;
  const signingSecret = createResult.credentials.signing_secret;
  console.log(`   ✅ App created: ${appId}`);

  // Step 2: Install app to workspace
  console.log('⏳ Installing app to workspace...');
  let installResult;
  try {
    installResult = await client.installApp(appId);
  } catch (error) {
    if (error instanceof SlackApiRequestError) {
      console.error(`\n❌ Failed to install app: ${error.message}`);
    }
    throw error;
  }

  const botToken = installResult.bot_token;
  if (!botToken) {
    throw new Error(
      'App was installed but no bot token was returned. ' +
      'You may need to install it manually via OAuth at https://api.slack.com/apps/' + appId,
    );
  }
  console.log('   ✅ App installed to workspace');

  // Step 3: Generate app-level token for Socket Mode
  console.log('⏳ Generating app-level token for Socket Mode...');
  let tokenResult;
  try {
    tokenResult = await client.generateAppLevelToken(appId);
  } catch (error) {
    if (error instanceof SlackApiRequestError) {
      console.error(`\n❌ Failed to generate app-level token: ${error.message}`);
    }
    throw error;
  }

  const appToken = tokenResult.token;
  console.log('   ✅ App-level token generated');

  console.log(`\n🎉 Slack app "${appName}" created and configured successfully!\n`);

  return {
    botToken,
    appToken,
    signingSecret,
  };
}
