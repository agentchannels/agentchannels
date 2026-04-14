import { input, confirm } from '@inquirer/prompts';
import { writeEnvFile } from '../../config/env.js';

/**
 * Result of the Discord init wizard
 */
export interface DiscordInitResult {
  botToken: string;
  applicationId?: string;
  publicKey?: string;
  envWritten: boolean;
}

/**
 * Options for controlling the init flow (useful for testing)
 */
export interface DiscordInitOptions {
  /** Skip writing to .env file */
  skipEnvWrite?: boolean;
  /** Working directory for .env file */
  cwd?: string;
  /**
   * Override the Discord REST API token validator.
   * In production, defaults to a live call to Discord's /api/v10/users/@me.
   * Pass a mock in tests to avoid real network calls.
   */
  discordApiValidator?: (
    token: string,
  ) => Promise<{ valid: boolean; username?: string; error?: string }>;
}

/**
 * Validate a Discord bot token structurally (no API call).
 *
 * Discord bot tokens have three dot-separated parts:
 *   <base64 user id>.<timestamp>.<hmac>
 * We do a lightweight structural check without hitting the API.
 */
export function validateDiscordBotToken(token: string): true | string {
  if (!token.trim()) return 'Bot token cannot be empty';
  if (token.length < 50)
    return 'Token appears too short — paste the full token from the Discord Developer Portal';

  const parts = token.split('.');
  if (parts.length !== 3) {
    return 'Token format looks wrong — a Discord bot token has three dot-separated segments';
  }
  return true;
}

/**
 * Validate a Discord application (client) ID.
 * Discord application IDs are numeric snowflake IDs (17–20 digits).
 * Returns true when the value is empty (field is optional).
 */
export function validateDiscordApplicationId(id: string): true | string {
  if (!id.trim()) return true; // optional — empty = skip
  if (!/^\d{17,20}$/.test(id.trim())) {
    return 'Application ID should be a numeric snowflake ID (17–20 digits)';
  }
  return true;
}

/**
 * Validate a Discord public key.
 * Public keys are 64-character lowercase hex strings found on the
 * Application's "General Information" page in the Discord Developer Portal.
 * Returns true when the value is empty (field is optional).
 */
export function validateDiscordPublicKey(key: string): true | string {
  if (!key.trim()) return true; // optional — empty = skip
  if (!/^[0-9a-fA-F]{64}$/.test(key.trim())) {
    return 'Public key should be a 64-character hex string — find it on the "General Information" page';
  }
  return true;
}

/**
 * Validate a Discord bot token by calling the Discord REST API.
 *
 * Makes a GET request to https://discord.com/api/v10/users/@me with the
 * provided bot token.  A 200 response means the token is valid; a 401
 * means the token is wrong.
 *
 * @param token - The raw bot token (without the "Bot " prefix).
 * @returns { valid: true, username } on success, or { valid: false, error } on failure.
 */
export async function validateDiscordBotTokenViaApi(
  token: string,
): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'agentchannels/1 (https://github.com/agentchannels/agentchannels)',
      },
    });

    if (response.ok) {
      const data = (await response.json()) as { username?: string };
      return { valid: true, username: data.username };
    }

    if (response.status === 401) {
      return { valid: false, error: 'Invalid token — Discord returned 401 Unauthorized' };
    }

    return { valid: false, error: `Discord API returned HTTP ${response.status}` };
  } catch (err) {
    return {
      valid: false,
      error: `Could not reach Discord API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Interactive prompt flow for `ach init discord`.
 *
 * Guides the user through:
 * 1. Creating a Discord application and bot in the Developer Portal
 * 2. Enabling the required Gateway Intents
 * 3. Copying the bot token and validating it via the Discord REST API
 * 4. Collecting the Application ID and Public Key
 * 5. Generating an invite link and adding the bot to the server
 * 6. Writing DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY to .env
 *
 * This is a guided-only wizard for v1 — no automated bot creation via API.
 */
export async function initDiscord(options: DiscordInitOptions = {}): Promise<DiscordInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const apiValidator = options.discordApiValidator ?? validateDiscordBotTokenViaApi;

  console.log('\n🔧 Agent Channels — Discord Setup\n');
  console.log('This wizard will help you configure a Discord bot for use with Claude Managed Agents.');
  console.log('You will need a Discord account and access to a server where you can add the bot.\n');

  // ── Step 1: Create the application ──────────────────────────────────────────
  console.log('📋 Step 1 — Create a Discord Application\n');
  console.log('   1. Go to https://discord.com/developers/applications');
  console.log('   2. Click "New Application" in the top-right corner');
  console.log('   3. Give it a name (e.g. "Agent Channels")');
  console.log('   4. Accept the Developer Terms of Service and click "Create"\n');

  await confirm({
    message: 'Application created — ready to add a bot?',
    default: true,
  });

  // ── Step 2: Add a bot ────────────────────────────────────────────────────────
  console.log('\n📋 Step 2 — Add a Bot to the Application\n');
  console.log('   1. In the left sidebar, click "Bot"');
  console.log('   2. Click "Add Bot" then confirm with "Yes, do it!"');
  console.log('   3. Optionally set a username and profile picture for your bot\n');

  // ── Step 3: Enable intents ───────────────────────────────────────────────────
  console.log('📋 Step 3 — Enable Privileged Gateway Intents\n');
  console.log('   Still on the Bot page, scroll down to "Privileged Gateway Intents" and enable:');
  console.log('');
  console.log('   ✅ MESSAGE CONTENT INTENT  ← required to read message text');
  console.log('   ✅ SERVER MEMBERS INTENT   ← recommended for DM trigger support');
  console.log('   ✅ PRESENCE INTENT         ← optional, can leave off if not needed');
  console.log('');
  console.log('   Click "Save Changes" after enabling the intents.\n');

  await confirm({
    message: 'Intents enabled and saved — ready to copy the bot token?',
    default: true,
  });

  // ── Step 4: Copy bot token and validate ─────────────────────────────────────
  console.log('\n📋 Step 4 — Copy the Bot Token\n');
  console.log('   1. On the Bot page, click "Reset Token" (or "Copy" if shown)');
  console.log('   2. Confirm the reset if prompted');
  console.log('   3. Copy the token — you will only see it once!\n');
  console.log('   ⚠️  Keep this token secret. Anyone with the token can control your bot.\n');

  const botToken = await input({
    message: 'Paste your Discord Bot Token:',
    validate: validateDiscordBotToken,
  });

  // Validate token against the Discord REST API
  console.log('\n⏳ Validating token with the Discord API...');
  const apiResult = await apiValidator(botToken);
  if (apiResult.valid) {
    console.log(
      `   ✅ Token valid — connected as ${apiResult.username ?? 'bot'}`,
    );
  } else {
    console.log(`   ⚠️  Token validation warning: ${apiResult.error ?? 'unknown error'}`);
    console.log('   You can continue, but double-check the token was copied correctly.\n');
  }

  // ── Step 5: Collect Application ID and Public Key ────────────────────────────
  console.log('\n📋 Step 5 — Copy your Application ID and Public Key\n');
  console.log('   1. In the left sidebar, click "General Information"');
  console.log('   2. Copy the "Application ID" — a numeric snowflake (e.g. 9123456789…)');
  console.log('   3. Copy the "Public Key" — a 64-character hex string below the App ID\n');

  const applicationIdRaw = await input({
    message: 'Paste your Discord Application ID (or press Enter to skip):',
    validate: validateDiscordApplicationId,
  });
  const applicationId = applicationIdRaw.trim() || undefined;

  const publicKeyRaw = await input({
    message: 'Paste your Discord Public Key (or press Enter to skip):',
    validate: validateDiscordPublicKey,
  });
  const publicKey = publicKeyRaw.trim() || undefined;

  // ── Step 6: Invite the bot ───────────────────────────────────────────────────
  console.log('\n📋 Step 6 — Invite the Bot to Your Server\n');

  if (applicationId) {
    const permissions =
      '274878024768'; // READ_MESSAGES | SEND_MESSAGES | CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY
    const inviteUrl =
      `https://discord.com/api/oauth2/authorize` +
      `?client_id=${applicationId}` +
      `&permissions=${permissions}` +
      `&scope=bot`;
    console.log('   Open this URL in your browser to invite the bot:\n');
    console.log(`   ${inviteUrl}\n`);
  } else {
    console.log('   Generate an invite link at:');
    console.log('   https://discord.com/developers/applications → OAuth2 → URL Generator');
    console.log('');
    console.log('   Required bot permissions:');
    console.log('   ✅ Read Messages / View Channels');
    console.log('   ✅ Send Messages');
    console.log('   ✅ Create Public Threads');
    console.log('   ✅ Send Messages in Threads');
    console.log('   ✅ Read Message History\n');
  }

  await confirm({
    message: 'Bot invited to your server — ready to save credentials?',
    default: true,
  });

  // ── Step 7: Write to .env ────────────────────────────────────────────────────
  let envWritten = false;

  if (!options.skipEnvWrite) {
    const shouldWrite = await confirm({
      message: 'Save these credentials to .env file?',
      default: true,
    });

    if (shouldWrite) {
      const envVars: Record<string, string> = {
        DISCORD_BOT_TOKEN: botToken,
      };
      if (applicationId) {
        envVars.DISCORD_APPLICATION_ID = applicationId;
      }
      if (publicKey) {
        envVars.DISCORD_PUBLIC_KEY = publicKey;
      }
      writeEnvFile(envVars, cwd);
      envWritten = true;
      console.log('\n✅ Discord credentials saved to .env');
      console.log('   DISCORD_BOT_TOKEN — bot token');
      if (applicationId) {
        console.log('   DISCORD_APPLICATION_ID — application ID');
      }
      if (publicKey) {
        console.log('   DISCORD_PUBLIC_KEY — public key');
      }
    } else {
      console.log('\n⚠️  Credentials not saved. You can set them as environment variables:');
      console.log(`   DISCORD_BOT_TOKEN=${botToken}`);
      if (applicationId) {
        console.log(`   DISCORD_APPLICATION_ID=${applicationId}`);
      }
      if (publicKey) {
        console.log(`   DISCORD_PUBLIC_KEY=${publicKey}`);
      }
    }
  }

  console.log('\n✅ Discord setup complete!');
  console.log('\n💡 Next steps:');
  console.log('   • Run `ach init agent` to configure your Claude agent (if not done yet)');
  console.log('   • Run `ach serve discord` to start the bot\n');

  return {
    botToken,
    applicationId,
    publicKey,
    envWritten,
  };
}
