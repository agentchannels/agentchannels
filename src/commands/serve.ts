import type { Command } from "commander";
import { resolveConfig, resolveDiscordConfig, type ConfigOverrides } from "../core/config.js";
import { SlackAdapter } from "../channels/slack/index.js";
import { DiscordAdapter } from "../channels/discord/index.js";
import { SessionManager } from "../core/session-manager.js";
import { AgentClient } from "../core/agent-client.js";
import { StreamingBridge } from "../core/streaming-bridge.js";
import type { ChannelAdapter, ChannelMessage } from "../core/channel-adapter.js";

/**
 * Register the `ach serve` command.
 *
 * Supports multiple modes:
 *   `ach serve`                    — Slack mode (default, backward compatible)
 *   `ach serve --channel slack`    — Slack mode (explicit)
 *   `ach serve --channel discord`  — Discord mode via flag
 *   `ach serve discord`            — Discord mode via subcommand (backward compatible)
 */
export function registerServeCommand(program: Command): void {
  const serve = program
    .command("serve")
    .description("Start the bot server (default: Slack)")
    .option(
      "--channel <channel>",
      "Channel adapter to use: slack or discord (default: slack)",
    )
    .option("--anthropic-api-key <key>", "Anthropic API key")
    .option("--agent-id <id>", "Claude Managed Agent ID")
    .option("--environment-id <id>", "Claude Environment ID")
    .option("--vault-ids <ids>", "Comma-separated vault IDs for MCP authentication")
    .option("--slack-bot-token <token>", "Slack Bot Token")
    .option("--slack-app-token <token>", "Slack App Token")
    .option("--slack-signing-secret <secret>", "Slack Signing Secret")
    .option("--discord-bot-token <token>", "Discord Bot Token")
    .action(async (opts) => {
      const channel = (opts.channel ?? "slack").toLowerCase();
      if (channel === "discord") {
        await runDiscordServe({
          anthropicApiKey: opts.anthropicApiKey,
          agentId: opts.agentId,
          environmentId: opts.environmentId,
          vaultIds: opts.vaultIds,
          discordBotToken: opts.discordBotToken,
        });
      } else {
        await runServe({
          anthropicApiKey: opts.anthropicApiKey,
          agentId: opts.agentId,
          environmentId: opts.environmentId,
          vaultIds: opts.vaultIds,
          slackBotToken: opts.slackBotToken,
          slackAppToken: opts.slackAppToken,
          slackSigningSecret: opts.slackSigningSecret,
        });
      }
    });

  // Discord subcommand: `ach serve discord` (kept for backward compatibility)
  serve
    .command("discord")
    .description("Start the Discord bot server bridging DMs and @mentions to Claude Managed Agents")
    .option("--anthropic-api-key <key>", "Anthropic API key")
    .option("--agent-id <id>", "Claude Managed Agent ID")
    .option("--environment-id <id>", "Claude Environment ID")
    .option("--vault-ids <ids>", "Comma-separated vault IDs for MCP authentication")
    .option("--discord-bot-token <token>", "Discord Bot Token")
    .action(async (opts) => {
      await runDiscordServe({
        anthropicApiKey: opts.anthropicApiKey,
        agentId: opts.agentId,
        environmentId: opts.environmentId,
        vaultIds: opts.vaultIds,
        discordBotToken: opts.discordBotToken,
      });
    });
}

/**
 * Main serve logic: resolve config, set up adapter + agent client, and start listening.
 */
export async function runServe(overrides: ConfigOverrides = {}): Promise<void> {
  // Resolve and validate all config
  const config = resolveConfig(overrides);

  console.log("[serve] Starting agentchannels server...");
  console.log(`[serve]   Agent:       ${config.agentId}`);
  console.log(`[serve]   Environment: ${config.environmentId}`);

  // Initialize the agent client
  const vaultIds = config.vaultIds
    ? config.vaultIds.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;
  if (vaultIds && vaultIds.length > 0) {
    console.log(`[serve]   Vaults:      ${vaultIds.join(", ")}`);
  }
  const agentClient = new AgentClient({
    apiKey: config.anthropicApiKey,
    agentId: config.agentId,
    environmentId: config.environmentId,
    vaultIds,
  });

  // Initialize session manager
  const sessionManager = new SessionManager();

  // Initialize the Slack adapter
  const adapter = new SlackAdapter({
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
  });

  // Initialize the streaming bridge coordinator
  const bridge = new StreamingBridge({
    adapter,
    agentClient,
    sessionManager,
  });

  // Log lifecycle phases for observability
  bridge.onPhaseChange((threadKey, phase, detail) => {
    const msg = detail ? `${phase}: ${detail}` : phase;
    console.log(`[serve] [${threadKey}] ${msg}`);
  });

  // Wire up message handling through the bridge
  adapter.onMessage(async (message: ChannelMessage) => {
    const { userId, channelId, threadId, text } = message;
    console.log(`[serve] Message from ${userId} in ${channelId}:${threadId}: ${text.substring(0, 80)}`);

    const result = await bridge.handleMessage(message);

    if (result.success) {
      console.log(
        `[serve] Response complete: session=${result.sessionId} chars=${result.totalChars} updates=${result.updateCount}`,
      );
    } else if (result.error !== "Empty message") {
      console.error(`[serve] Response failed: ${result.error}`);
    }
  });

  // Connect to Slack
  await adapter.connect();
  console.log("[serve] Bot is running. Press Ctrl+C to stop.");

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\n[serve] Shutting down...");
    const aborted = bridge.abortAll();
    if (aborted > 0) {
      console.log(`[serve] Aborted ${aborted} active thread(s)`);
    }
    await adapter.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Discord serve logic: resolve config, set up DiscordAdapter + agent client, and start listening.
 *
 * Handles both @mention triggers in guild channels and Direct Message (DM) triggers.
 * - Guild channels: creates a Discord thread on the triggering message for each conversation
 * - DMs: responds directly in the DM channel (session key: `discord:@dm:{dmChannelId}`)
 */
export async function runDiscordServe(overrides: ConfigOverrides = {}): Promise<void> {
  const config = resolveDiscordConfig(overrides);

  console.log("[serve] Starting agentchannels Discord server...");
  console.log(`[serve]   Agent:       ${config.agentId}`);
  console.log(`[serve]   Environment: ${config.environmentId}`);

  const vaultIds = config.vaultIds
    ? config.vaultIds.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;
  if (vaultIds && vaultIds.length > 0) {
    console.log(`[serve]   Vaults:      ${vaultIds.join(", ")}`);
  }

  const agentClient = new AgentClient({
    apiKey: config.anthropicApiKey,
    agentId: config.agentId,
    environmentId: config.environmentId,
    vaultIds,
  });

  const sessionManager = new SessionManager();

  const adapter = new DiscordAdapter({
    botToken: config.discordBotToken,
  });

  const bridge = new StreamingBridge({
    adapter,
    agentClient,
    sessionManager,
  });

  bridge.onPhaseChange((threadKey, phase, detail) => {
    const msg = detail ? `${phase}: ${detail}` : phase;
    console.log(`[serve] [${threadKey}] ${msg}`);
  });

  adapter.onMessage(async (message: ChannelMessage) => {
    const { userId, channelId, threadId, text } = message;
    console.log(`[serve] Message from ${userId} in ${channelId}:${threadId}: ${text.substring(0, 80)}`);

    const result = await bridge.handleMessage(message);

    if (result.success) {
      console.log(
        `[serve] Response complete: session=${result.sessionId} chars=${result.totalChars} updates=${result.updateCount}`,
      );
    } else if (result.error !== "Empty message") {
      console.error(`[serve] Response failed: ${result.error}`);
    }
  });

  // Connect to Discord (logs in bot via WebSocket gateway)
  await adapter.connect();
  console.log("[serve] Discord bot is running. Press Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\n[serve] Shutting down...");
    const aborted = bridge.abortAll();
    if (aborted > 0) {
      console.log(`[serve] Aborted ${aborted} active thread(s)`);
    }
    await adapter.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Minimum characters between streaming updates to avoid Slack rate limits */
const STREAM_UPDATE_INTERVAL = 100;

/**
 * Handle an incoming message: create or reuse a session, send to agent, stream response back.
 *
 * This is a standalone convenience function that creates a one-shot StreamingBridge
 * for backward compatibility and testing. The `runServe` function uses a persistent
 * StreamingBridge instance instead.
 *
 * @deprecated Prefer using StreamingBridge directly for new code.
 */
export async function handleMessage(
  adapter: ChannelAdapter,
  agentClient: AgentClient,
  sessionManager: SessionManager,
  message: ChannelMessage,
): Promise<void> {
  const bridge = new StreamingBridge({
    adapter,
    agentClient,
    sessionManager,
    updateThreshold: STREAM_UPDATE_INTERVAL,
  });

  await bridge.handleMessage(message);
}
