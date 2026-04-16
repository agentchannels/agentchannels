#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerServeCommand } from "../commands/serve.js";
import { initSlack } from "../channels/slack/init.js";
import { initDiscord } from "../channels/discord/init.js";
import { initAgent } from "../commands/init-agent.js";
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
  .description("Initialize channel or agent configuration");

initCmd
  .command("slack")
  .description("Set up Slack app and credentials")
  .action(async () => {
    try {
      await initSlack();
    } catch (error) {
      if ((error as Error).name === "ExitPromptError") {
        console.log("\n👋 Setup cancelled.");
        process.exit(0);
      }
      console.error("\n❌ Slack setup failed:", (error as Error).message);
      process.exit(1);
    }
  });

initCmd
  .command("discord")
  .description("Set up Discord bot and credentials")
  .action(async () => {
    try {
      await initDiscord();
    } catch (error) {
      if ((error as Error).name === "ExitPromptError") {
        console.log("\n👋 Setup cancelled.");
        process.exit(0);
      }
      console.error("\n❌ Discord setup failed:", (error as Error).message);
      process.exit(1);
    }
  });

initCmd
  .command("agent")
  .description("Create or validate a Claude Managed Agent and Environment")
  .option("--anthropic-api-key <key>", "Anthropic API key")
  .option("--agent-id <id>", "Existing Claude Agent ID to validate")
  .option("--environment-id <id>", "Existing Environment ID to validate")
  .option("--non-interactive", "Run without prompts (uses defaults or existing IDs)")
  .action(async (opts) => {
    try {
      await initAgent({
        anthropicApiKey: opts.anthropicApiKey,
        agentId: opts.agentId,
        environmentId: opts.environmentId,
        nonInteractive: opts.nonInteractive,
      });
    } catch (error) {
      if ((error as Error).name === "ExitPromptError") {
        console.log("\n👋 Setup cancelled.");
        process.exit(0);
      }
      console.error("\n❌ Agent setup failed:", (error as Error).message);
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
