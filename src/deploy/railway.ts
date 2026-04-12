/**
 * `ach deploy railway` — interactive wizard for deploying to Railway.
 *
 * Flow:
 * 1. Prompt for Railway API token
 * 2. Verify token and show user info
 * 3. Create project on Railway
 * 4. Read .env, show masked values, confirm
 * 5. Push env vars to Railway
 * 6. Connect GitHub repo and trigger deploy
 * 7. Wait for deployment, show URL
 */

import { input, confirm, password, select } from "@inquirer/prompts";
import { RailwayClient } from "./railway-client.js";
import { readEnvFile } from "../config/env.js";

/** Env vars that should be deployed */
const DEPLOY_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_AGENT_ID",
  "CLAUDE_ENVIRONMENT_ID",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_REFRESH_TOKEN",
];

function maskValue(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

export async function deployRailway(): Promise<void> {
  console.log("\n:railway_car: AgentChannels — Deploy to Railway\n");

  // Step 1: Get Railway API token
  console.log("You need a Railway API token to deploy.");
  console.log("Create one at: https://railway.com/account/tokens\n");

  const token = await password({
    message: "Railway API Token:",
    validate: (v) => (v.trim().length > 0 ? true : "Token is required"),
  });

  // Step 2: Verify token
  const client = new RailwayClient({ token });
  console.log("\nVerifying token...");

  let userName: string;
  let workspaceId: string;
  try {
    const user = await client.whoami();
    userName = user.name || user.email;
    console.log(`Authenticated as: ${userName}`);

    const workspaces = user.workspaces;
    if (!workspaces || workspaces.length === 0) {
      console.error("No workspaces found. Create one at railway.com first.");
      return;
    } else if (workspaces.length === 1) {
      workspaceId = workspaces[0].id;
      console.log(`Workspace: ${workspaces[0].name}\n`);
    } else {
      workspaceId = await select({
        message: "Select a workspace:",
        choices: workspaces.map((w) => ({ name: w.name, value: w.id })),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Authentication failed: ${msg}`);
    console.error("Check your token at https://railway.com/account/tokens");
    return;
  }

  // Step 4: Create project
  const projectName = await input({
    message: "Project name:",
    default: "agentchannels",
  });

  console.log(`\nCreating project "${projectName}"...`);
  let project;
  try {
    project = await client.createProject(projectName, workspaceId);
    console.log(`Project created: ${project.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create project: ${msg}`);
    return;
  }

  // Get the default environment
  const envEdge = project.environments.edges[0];
  if (!envEdge) {
    console.error("No environments found in the new project.");
    return;
  }
  const environmentId = envEdge.node.id;
  const environmentName = envEdge.node.name;
  console.log(`Environment: ${environmentName} (${environmentId})`);

  // Create a service
  console.log("Creating service...");
  let service;
  try {
    service = await client.createService(project.id, "agentchannels");
    console.log(`Service created: ${service.name} (${service.id})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create service: ${msg}`);
    return;
  }

  // Step 4: Read and confirm env vars
  const envFile = readEnvFile();
  const varsToSet: Record<string, string> = {};

  for (const key of DEPLOY_VARS) {
    const value = envFile[key] || process.env[key];
    if (value) {
      varsToSet[key] = value;
    }
  }

  if (Object.keys(varsToSet).length === 0) {
    console.log("\nNo environment variables found in .env or environment.");
    console.log("You can set them later in the Railway dashboard.");
  } else {
    console.log("\nEnvironment variables to deploy:\n");
    for (const [key, value] of Object.entries(varsToSet)) {
      console.log(`  ${key}=${maskValue(value)}`);
    }
    console.log(`\n  (${Object.keys(varsToSet).length} variables total)`);

    const shouldSet = await confirm({
      message: "Push these variables to Railway?",
      default: true,
    });

    if (shouldSet) {
      console.log("\nSetting environment variables...");
      try {
        await client.setVariables(project.id, environmentId, service.id, varsToSet);
        console.log("Environment variables set.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to set variables: ${msg}`);
        console.error("You can set them manually in the Railway dashboard.");
      }
    }
  }

  // Step 5: Connect repo and deploy
  // Check if the current directory has a git remote
  let repoUrl: string | undefined;
  try {
    const { execSync } = await import("node:child_process");
    const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    // Extract owner/repo from git URL
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) {
      repoUrl = match[1];
    }
  } catch {
    // No git remote
  }

  if (repoUrl) {
    console.log(`\nDetected GitHub repo: ${repoUrl}`);
    const connectRepo = await confirm({
      message: "Connect this repo for auto-deploy?",
      default: true,
    });

    if (connectRepo) {
      const branch = await input({
        message: "Branch to deploy:",
        default: "main",
      });

      console.log(`\nConnecting ${repoUrl} (${branch})...`);
      try {
        await client.connectRepo(service.id, repoUrl, branch);
        console.log("Repo connected.");

        // Trigger initial deployment
        console.log("Triggering deployment...");
        await client.triggerDeploy(project.id, environmentId, service.id);
        console.log("Deployment triggered. Railway is building your app.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to connect/deploy: ${msg}`);
        console.error("You can connect it manually in the Railway dashboard.");
      }
    }
  } else {
    console.log("\nNo GitHub remote detected. You can connect a repo in the Railway dashboard.");
  }

  // Step 6: Generate a public domain
  console.log("\nGenerating public domain...");
  try {
    const { domain } = await client.createDomain(service.id, environmentId);
    console.log(`Domain: https://${domain}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to generate domain: ${msg}`);
  }

  // Summary
  console.log("\n--- Deployment Summary ---\n");
  console.log(`  Project:     ${projectName}`);
  console.log(`  Environment: ${environmentName}`);
  console.log(`  Service:     ${service.name}`);
  console.log(`  Variables:   ${Object.keys(varsToSet).length} set`);
  if (repoUrl) {
    console.log(`  Repo:        ${repoUrl}`);
  }
  console.log(`\n  Dashboard:   https://railway.com/project/${project.id}`);
  console.log("\nDone! Your agentchannels server will be running on Railway.");
  console.log("The bot will connect to Slack via Socket Mode automatically.\n");
}
