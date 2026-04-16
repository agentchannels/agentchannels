#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerServeCommand } from "../commands/serve.js";
import { initSlack } from "../channels/slack/init.js";
import { deployRailway } from "../deploy/railway.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("ach")
  .description("agentchannels — Connect Claude Managed Agents to messaging channels")
  .version(pkg.version);

// Register commands
registerServeCommand(program);

// Init subcommands
const initCmd = program
  .command("init")
  .description("Initialize channel configuration");

initCmd
  .command("slack")
  .description("Set up Slack app and credentials (also validates Anthropic API key)")
  .option("--non-interactive", "Run without prompts (infers path from provided credentials)")
  .option("--anthropic-api-key <key>", "Anthropic API key — validated before Slack setup begins")
  .option("--claude-agent-id <id>", "Claude Managed Agent ID — validated silently, written to .env")
  .option("--claude-environment-id <id>", "Claude Environment ID — validated silently, written to .env")
  .option("--claude-vault-ids <ids>", "Comma-separated Claude Vault IDs — each validated, invalid IDs are dropped with a warning")
  .option("--slack-bot-token <token>", "Slack Bot Token (xoxb-...)")
  .option("--slack-app-token <token>", "Slack App-Level Token (xapp-...)")
  .option("--slack-signing-secret <secret>", "Slack Signing Secret")
  .option("--slack-refresh-token <token>", "Slack Refresh Token for automatic setup (xoxe-...)")
  .option("--app-name <name>", "Slack app name for non-interactive mode (default: General Agent)")
  .option("--app-description <desc>", "Slack app description for non-interactive mode")
  .action(async (opts) => {
    try {
      await initSlack({
        nonInteractive: opts.nonInteractive,
        anthropicApiKey: opts.anthropicApiKey,
        claudeAgentId: opts.claudeAgentId,
        claudeEnvironmentId: opts.claudeEnvironmentId,
        claudeVaultIds: opts.claudeVaultIds,
        slackBotToken: opts.slackBotToken,
        slackAppToken: opts.slackAppToken,
        slackSigningSecret: opts.slackSigningSecret,
        slackRefreshToken: opts.slackRefreshToken,
        appName: opts.appName,
        appDescription: opts.appDescription,
      });
    } catch (error) {
      if ((error as Error).name === "ExitPromptError") {
        console.log("\n👋 Setup cancelled.");
        process.exit(0);
      }
      console.error("\n❌ Slack setup failed:", (error as Error).message);
      process.exit(1);
    }
  });

// Deploy subcommands
const deployCmd = program
  .command("deploy")
  .description("Deploy agentchannels to a cloud platform");

deployCmd
  .command("railway")
  .description("Deploy to Railway")
  .action(async () => {
    try {
      await deployRailway();
    } catch (error) {
      if ((error as Error).name === "ExitPromptError") {
        console.log("\n Setup cancelled.");
        process.exit(0);
      }
      console.error("\n Deploy failed:", (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
