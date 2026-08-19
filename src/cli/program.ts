import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { Command, Option } from "commander";

import {
  createLinearOnboarding,
  createSlackOnboarding,
} from "../connectors/onboarding.js";
import { LinearConnector } from "../connectors/linear.js";
import { SlackConnector } from "../connectors/slack.js";
import type { Agent, Binding, ConnectorType } from "../core/types.js";
import { ensureProductPaths, resolveProductPaths } from "../core/paths.js";
import { WorktreeManager } from "../core/worktrees.js";
import { Persistence } from "../persistence/store.js";
import { KeyringCredentialStore } from "../security/credentials.js";
import {
  BindingCredentialService,
  issueLinearClientCredentials,
} from "../security/identity.js";
import { startDaemon } from "../daemon/daemon.js";

const execFileAsync = promisify(execFile);

type GlobalOptions = { json?: boolean; home?: string };

function output(program: Command, value: unknown, human: string): void {
  const options = program.opts<GlobalOptions>();
  process.stdout.write(
    options.json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`,
  );
}

function openStore(program: Command): Persistence {
  const global = program.opts<GlobalOptions>();
  const paths = resolveProductPaths(
    global.home === undefined
      ? process.env
      : { ...process.env, AGENTCHANNELS_HOME: global.home },
  );
  ensureProductPaths(paths);
  return new Persistence(paths.database);
}

async function prompt(label: string): Promise<string> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await terminal.question(`${label}\n> `)).trim();
  } finally {
    terminal.close();
  }
}

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin as AsyncIterable<string>)
    value += chunk;
  return value;
}

async function resolveAgent(
  store: Persistence,
  agentId: string | undefined,
  interactive: boolean,
  cwd = process.cwd(),
): Promise<Agent> {
  if (agentId !== undefined) {
    const agent = store.getAgent(agentId);
    if (agent === undefined) throw new Error(`Agent ${agentId} was not found`);
    return agent;
  }
  const candidates = store.findAgentsByCwd(cwd);
  const onlyCandidate = candidates[0];
  if (candidates.length === 1 && onlyCandidate !== undefined)
    return onlyCandidate;
  if (!interactive) {
    throw new Error(
      "Current directory does not uniquely identify an Agent; pass --agent ag_...",
    );
  }
  const selectable = candidates.length > 1 ? candidates : store.listAgents();
  if (selectable.length === 0)
    throw new Error("No Agents are configured; run agentchannels init");
  process.stdout.write(
    `${selectable.map((agent, index) => `${String(index + 1)}. ${agent.name} (${agent.id}) — ${agent.cwd}`).join("\n")}\n`,
  );
  const selected = Number.parseInt(await prompt("Agent:"), 10) - 1;
  const agent = selectable[selected];
  if (agent === undefined) throw new Error("Agent selection was invalid");
  return agent;
}

async function resolveBinding(
  store: Persistence,
  agent: Agent,
  bindingId: string | undefined,
  interactive: boolean,
): Promise<Binding> {
  if (bindingId !== undefined) {
    const binding = store.getBinding(bindingId);
    if (binding === undefined || binding.agentId !== agent.id) {
      throw new Error(
        `Binding ${bindingId} does not belong to Agent ${agent.id}`,
      );
    }
    return binding;
  }
  const bindings = store.listBindings(agent.id);
  if (bindings.length === 1) {
    const binding = bindings[0];
    if (binding !== undefined) return binding;
  }
  if (!interactive)
    throw new Error("Binding is ambiguous; pass --binding bd_...");
  if (bindings.length === 0)
    throw new Error(`Agent ${agent.id} has no completed Bindings`);
  process.stdout.write(
    `${bindings.map((binding, index) => `${String(index + 1)}. ${binding.connector} (${binding.id})`).join("\n")}\n`,
  );
  const selected = Number.parseInt(await prompt("Connection:"), 10) - 1;
  const binding = bindings[selected];
  if (binding === undefined) throw new Error("Binding selection was invalid");
  return binding;
}

async function assertGitHead(cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
  } catch {
    throw new Error(
      "AgentChannels v1 requires the Agent CWD to belong to a Git repository with a current HEAD",
    );
  }
}

async function verifyBindingCredentials(
  connector: ConnectorType,
  credentials: Record<string, string>,
  externalInstallationId: string,
): Promise<Record<string, string>> {
  if (connector === "slack") {
    const response = await fetch("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${credentials.botToken ?? ""}` },
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      team_id?: string;
      user_id?: string;
    };
    if (!response.ok || result.ok !== true || result.user_id === undefined) {
      throw new Error(
        `Slack credentials could not be verified: ${result.error ?? `HTTP ${String(response.status)}`}`,
      );
    }
    if (
      result.team_id !== undefined &&
      result.team_id !== externalInstallationId
    ) {
      throw new Error(
        "Slack bot token belongs to a different workspace than --external-installation",
      );
    }
    return { ...credentials, botUserId: result.user_id };
  }

  if (
    credentials.apiToken === undefined &&
    credentials.clientId !== undefined &&
    credentials.clientSecret !== undefined
  ) {
    Object.assign(
      credentials,
      await issueLinearClientCredentials(
        credentials.clientId,
        credentials.clientSecret,
      ),
      { oauthProvider: "linear-client-credentials" },
    );
  }
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.apiToken ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: "query BindingIdentity { viewer { id app organization { id } } }",
    }),
  });
  const result = (await response.json()) as {
    data?: { viewer?: { app?: boolean; organization?: { id?: string } } };
    errors?: { message?: string }[];
  };
  const viewer = result.data?.viewer;
  if (!response.ok || viewer === undefined || result.errors?.length) {
    throw new Error(
      `Linear credentials could not be verified: ${result.errors?.[0]?.message ?? `HTTP ${String(response.status)}`}`,
    );
  }
  if (viewer.app !== true) {
    throw new Error(
      "Linear token is not an app actor token; authorize the application with actor=app",
    );
  }
  if (
    viewer.organization?.id !== undefined &&
    viewer.organization.id !== externalInstallationId
  ) {
    throw new Error(
      "Linear token belongs to a different workspace than --external-installation",
    );
  }
  return credentials;
}

function parseConnectors(value: string): ConnectorType[] {
  const connectors = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const connector of connectors) {
    if (connector !== "slack" && connector !== "linear")
      throw new Error(`Unsupported connector ${connector}`);
  }
  return [...new Set(connectors)] as ConnectorType[];
}

async function searchRemoteUsers(binding: Binding, query: string) {
  const connector =
    binding.connector === "slack"
      ? new SlackConnector()
      : new LinearConnector();
  const credentials = await new BindingCredentialService(
    new KeyringCredentialStore(),
  ).require(binding.id);
  return connector.searchUsers(query, credentials);
}

function setupBinding(
  store: Persistence,
  agent: Agent,
  connector: ConnectorType,
  publicRelayUrl: string,
  linearClientUrl: string,
  linearRedirectUrl: string,
): unknown {
  const setup =
    store
      .listBindingSetups(agent.id)
      .find((candidate) => candidate.connector === connector) ??
    store.createBindingSetup({ agentId: agent.id, connector });
  const webhook = `${publicRelayUrl.replace(/\/$/, "")}/v1/webhooks/${connector}/${setup.id}`;
  const onboarding =
    connector === "slack"
      ? createSlackOnboarding({
          agentName: agent.name,
          relayWebhookUrl: webhook,
        })
      : createLinearOnboarding({
          agentName: agent.name,
          relayWebhookUrl: webhook,
          clientUri: linearClientUrl,
          redirectUri: linearRedirectUrl,
        });
  return {
    bindingSetupId: setup.id,
    connector,
    webhookUrl: webhook,
    ...onboarding,
  };
}

export function createProgram(): Command {
  const program = new Command()
    .name("agentchannels")
    .description("Use a local Claude Code environment from Slack and Linear")
    .version("1.0.0")
    .option("--json", "emit machine-readable JSON")
    .option("--home <path>", "override ~/.agentchannels for this invocation");
  const interactive = (): boolean =>
    program.opts<GlobalOptions>().json !== true && process.stdin.isTTY;

  program
    .command("init")
    .description("Create an Agent for the current local environment")
    .option("--name <name>")
    .option("--cwd <path>")
    .option("--additional-directory <path...>")
    .option("--connect <connectors>", "comma-separated slack,linear")
    .option("--relay-public-url <url>")
    .option(
      "--linear-client-url <url>",
      "public client URL for Linear's app manifest",
    )
    .option(
      "--linear-redirect-url <url>",
      "OAuth redirect URL for Linear's app manifest",
    )
    .action(
      async (options: {
        name?: string;
        cwd?: string;
        additionalDirectory?: string[];
        connect?: string;
        relayPublicUrl?: string;
        linearClientUrl?: string;
        linearRedirectUrl?: string;
      }) => {
        const global = program.opts<GlobalOptions>();
        const interactive = global.json !== true && process.stdin.isTTY;
        const cwd = realpathSync(resolve(options.cwd ?? process.cwd()));
        await assertGitHead(cwd);
        const name =
          options.name ?? (interactive ? await prompt("Name:") : undefined);
        if (!name)
          throw new Error("--name is required in non-interactive mode");
        const requested =
          options.connect === undefined
            ? interactive
              ? parseConnectors(
                  await prompt("Connect now? (slack,linear or blank)"),
                )
              : []
            : parseConnectors(options.connect);
        if (requested.length > 0 && options.relayPublicUrl === undefined) {
          throw new Error(
            "--relay-public-url is required when creating connector manifests",
          );
        }
        if (
          requested.includes("linear") &&
          (options.linearClientUrl === undefined ||
            options.linearRedirectUrl === undefined)
        ) {
          throw new Error(
            "--linear-client-url and --linear-redirect-url are required for Linear onboarding",
          );
        }
        const store = openStore(program);
        try {
          const { agent, setups } = store.transaction(() => {
            const agent = store.createAgent({
              name,
              cwd,
              additionalDirectories: (options.additionalDirectory ?? []).map(
                (directory) => resolve(directory),
              ),
            });
            const setups = requested.map((connector) => {
              const relayPublicUrl = options.relayPublicUrl;
              if (relayPublicUrl === undefined)
                throw new Error("Relay public URL is missing");
              return setupBinding(
                store,
                agent,
                connector,
                relayPublicUrl,
                options.linearClientUrl ?? relayPublicUrl,
                options.linearRedirectUrl ?? relayPublicUrl,
              );
            });
            return { agent, setups };
          });
          output(
            program,
            { agent, setups },
            `Created Agent ${agent.name} (${agent.id})${setups.length ? "\nExternal approval is required to complete the selected connections." : ""}`,
          );
        } finally {
          store.close();
        }
      },
    );

  program
    .command("connect")
    .description("Prepare a Slack or Linear application manifest")
    .argument("<connector>")
    .option("--agent <id>")
    .requiredOption("--relay-public-url <url>")
    .option("--linear-client-url <url>")
    .option("--linear-redirect-url <url>")
    .action(
      async (
        connectorValue: string,
        options: {
          agent?: string;
          relayPublicUrl: string;
          linearClientUrl?: string;
          linearRedirectUrl?: string;
        },
      ) => {
        const [connector] = parseConnectors(connectorValue);
        if (connector === undefined) throw new Error("A connector is required");
        if (
          connector === "linear" &&
          (options.linearClientUrl === undefined ||
            options.linearRedirectUrl === undefined)
        ) {
          throw new Error(
            "Linear requires --linear-client-url and --linear-redirect-url",
          );
        }
        const store = openStore(program);
        try {
          const agent = await resolveAgent(store, options.agent, interactive());
          const setup = setupBinding(
            store,
            agent,
            connector,
            options.relayPublicUrl,
            options.linearClientUrl ?? options.relayPublicUrl,
            options.linearRedirectUrl ?? options.relayPublicUrl,
          );
          output(
            program,
            setup,
            `Prepared ${connector} setup. Workspace administrator approval is required.`,
          );
        } finally {
          store.close();
        }
      },
    );

  const binding = program
    .command("binding")
    .description("Complete connector binding setup");
  binding
    .command("complete")
    .requiredOption("--setup <id>")
    .requiredOption("--operator-user <id>")
    .requiredOption("--external-installation <id>")
    .addOption(
      new Option("--credentials-file <path>").conflicts("credentialsStdin"),
    )
    .option("--credentials-stdin")
    .action(
      async (options: {
        setup: string;
        operatorUser: string;
        externalInstallation: string;
        credentialsFile?: string;
        credentialsStdin?: boolean;
      }) => {
        if (
          options.credentialsFile === undefined &&
          options.credentialsStdin !== true
        ) {
          throw new Error(
            "Pass connector credentials via --credentials-file or --credentials-stdin; secrets are never accepted as command arguments",
          );
        }
        const encoded =
          options.credentialsFile === undefined
            ? await readStandardInput()
            : await readFile(resolve(options.credentialsFile), "utf8");
        let credentials = JSON.parse(encoded) as Record<string, string>;
        const store = openStore(program);
        try {
          const setup = store.getBindingSetup(options.setup);
          if (setup === undefined)
            throw new Error(`Binding setup ${options.setup} was not found`);
          const required =
            setup.connector === "slack"
              ? ["signingSecret", "botToken"]
              : ["webhookSecret"];
          for (const key of required) {
            if (
              typeof credentials[key] !== "string" ||
              credentials[key] === ""
            ) {
              throw new Error(
                `${setup.connector} credential ${key} is required`,
              );
            }
          }
          if (
            setup.connector === "linear" &&
            credentials.apiToken === undefined &&
            (credentials.clientId === undefined ||
              credentials.clientSecret === undefined)
          ) {
            throw new Error(
              "Linear requires apiToken or both clientId and clientSecret",
            );
          }
          credentials = await verifyBindingCredentials(
            setup.connector,
            credentials,
            options.externalInstallation,
          );
          if (
            setup.connector === "linear" &&
            credentials.refreshToken !== undefined
          ) {
            credentials.oauthProvider = "linear";
          }
          const secretStore = new BindingCredentialService(
            new KeyringCredentialStore(),
          );
          await secretStore.set(setup.id, credentials);
          try {
            const completed = store.completeBindingSetup(setup.id, {
              operatorUserId: options.operatorUser,
              externalInstallationId: options.externalInstallation,
            });
            output(
              program,
              completed,
              `Connected ${completed.connector} binding ${completed.id}`,
            );
          } catch (error) {
            await new KeyringCredentialStore().delete(`binding:${setup.id}`);
            throw error;
          }
        } finally {
          store.close();
        }
      },
    );
  binding
    .command("remove")
    .requiredOption("--binding <id>")
    .option("--agent <id>")
    .action(async (options: { binding: string; agent?: string }) => {
      const store = openStore(program);
      try {
        const agent = await resolveAgent(store, options.agent, interactive());
        const selected = await resolveBinding(
          store,
          agent,
          options.binding,
          interactive(),
        );
        if (!store.deleteBinding(selected.id))
          throw new Error(`Binding ${selected.id} was not found`);
        await new KeyringCredentialStore().delete(`binding:${selected.id}`);
        output(
          program,
          { removed: true, bindingId: selected.id },
          `Removed Binding ${selected.id}`,
        );
      } finally {
        store.close();
      }
    });

  program
    .command("status")
    .option("--agent <id>")
    .action(async (options: { agent?: string }) => {
      const store = openStore(program);
      try {
        const agent = await resolveAgent(store, options.agent, interactive());
        const value = {
          agent,
          bindings: store.listBindings(agent.id),
          pendingBindingSetups: store.listBindingSetups(agent.id),
          sessions: store.listSessions().filter((session) => {
            const sessionBinding = store.getBinding(session.bindingId);
            return sessionBinding?.agentId === agent.id;
          }),
        };
        output(
          program,
          value,
          `${agent.name}\n${value.bindings.length.toString()} binding(s), ${value.pendingBindingSetups.length.toString()} pending setup(s), ${value.sessions.length.toString()} Session(s)`,
        );
      } finally {
        store.close();
      }
    });

  const sessions = program
    .command("sessions")
    .description("Inspect or retire retained Sessions");
  sessions
    .command("retire")
    .requiredOption("--session <id>")
    .option("--agent <id>")
    .action(async (options: { session: string; agent?: string }) => {
      const store = openStore(program);
      try {
        const agent = await resolveAgent(store, options.agent, interactive());
        const session = store.getSession(options.session);
        if (session === undefined)
          throw new Error(`Session ${options.session} was not found`);
        const sessionBinding = store.getBinding(session.bindingId);
        if (sessionBinding?.agentId !== agent.id)
          throw new Error(
            `Session ${session.id} does not belong to Agent ${agent.id}`,
          );
        const paths = resolveProductPaths(
          program.opts<GlobalOptions>().home === undefined
            ? process.env
            : {
                ...process.env,
                AGENTCHANNELS_HOME: program.opts<GlobalOptions>().home,
              },
        );
        const worktrees = new WorktreeManager({
          repositoryPath: agent.cwd,
          worktreeRoot: resolve(paths.worktrees, agent.id),
        });
        const result = await worktrees.remove(session.worktreePath);
        if (result === "preserved") {
          throw new Error(
            "Session worktree is dirty and was preserved; commit or move its changes before retiring",
          );
        }
        store.retireSessionNow(session.id);
        output(
          program,
          { retired: true, sessionId: session.id },
          `Retired Session ${session.id}`,
        );
      } finally {
        store.close();
      }
    });

  const agents = program.command("agent").description("Manage local Agents");
  agents
    .command("delete")
    .requiredOption("--agent <id>")
    .action(async (options: { agent: string }) => {
      const store = openStore(program);
      try {
        const agent = await resolveAgent(store, options.agent, interactive());
        if (!store.deleteAgent(agent.id))
          throw new Error(`Agent ${agent.id} was not found`);
        output(
          program,
          { deleted: true, agentId: agent.id },
          `Deleted Agent ${agent.name}`,
        );
      } finally {
        store.close();
      }
    });

  const access = program
    .command("access")
    .description("Manage per-Binding access");
  access
    .command("add")
    .option("--user <id>")
    .option("--agent <id>")
    .option("--binding <id>")
    .action(
      async (options: { user?: string; agent?: string; binding?: string }) => {
        const store = openStore(program);
        try {
          const agent = await resolveAgent(store, options.agent, interactive());
          const selected = await resolveBinding(
            store,
            agent,
            options.binding,
            interactive(),
          );
          let userId = options.user;
          if (userId === undefined) {
            if (!interactive())
              throw new Error("--user is required in non-interactive mode");
            const results = await searchRemoteUsers(
              selected,
              await prompt("Search:"),
            );
            if (results.length === 0)
              throw new Error("No matching users were found");
            process.stdout.write(
              `${results.map((user, index) => `${String(index + 1)}. ${user.name} ${user.email ?? ""} (${user.id})`).join("\n")}\n`,
            );
            const index = Number.parseInt(await prompt("User:"), 10) - 1;
            userId = results[index]?.id;
            if (userId === undefined)
              throw new Error("User selection was invalid");
          }
          const grant = store.grantAccess(selected.id, userId);
          output(
            program,
            grant,
            `Granted ${userId} access to ${agent.name} via ${selected.connector}`,
          );
        } finally {
          store.close();
        }
      },
    );
  access
    .command("list")
    .option("--agent <id>")
    .option("--binding <id>")
    .action(async (options: { agent?: string; binding?: string }) => {
      const store = openStore(program);
      try {
        const agent = await resolveAgent(store, options.agent, interactive());
        const selected = await resolveBinding(
          store,
          agent,
          options.binding,
          interactive(),
        );
        const grants = store.listAccess(selected.id);
        output(
          program,
          grants,
          grants.map((grant) => grant.userId).join("\n") || "No shared users",
        );
      } finally {
        store.close();
      }
    });
  access
    .command("remove")
    .option("--user <id>")
    .option("--agent <id>")
    .option("--binding <id>")
    .action(
      async (options: { user?: string; agent?: string; binding?: string }) => {
        const store = openStore(program);
        try {
          const agent = await resolveAgent(store, options.agent, interactive());
          const selected = await resolveBinding(
            store,
            agent,
            options.binding,
            interactive(),
          );
          let userId = options.user;
          if (userId === undefined) {
            if (!interactive())
              throw new Error("--user is required in non-interactive mode");
            const grants = store.listAccess(selected.id);
            if (grants.length === 0)
              throw new Error("This Binding has no shared users");
            process.stdout.write(
              `${grants.map((grant, index) => `${String(index + 1)}. ${grant.userId}`).join("\n")}\n`,
            );
            const index = Number.parseInt(await prompt("User:"), 10) - 1;
            userId = grants[index]?.userId;
            if (userId === undefined)
              throw new Error("User selection was invalid");
          }
          const removed = store.revokeAccess(selected.id, userId);
          output(
            program,
            { removed },
            removed ? `Removed ${userId}` : `${userId} had no grant`,
          );
        } finally {
          store.close();
        }
      },
    );

  const users = program
    .command("users")
    .description("Look up stable platform user IDs");
  users
    .command("search")
    .argument("<query>")
    .option("--agent <id>")
    .option("--binding <id>")
    .action(
      async (query: string, options: { agent?: string; binding?: string }) => {
        const store = openStore(program);
        try {
          const agent = await resolveAgent(store, options.agent, interactive());
          const selected = await resolveBinding(
            store,
            agent,
            options.binding,
            interactive(),
          );
          const results = await searchRemoteUsers(selected, query);
          output(
            program,
            results,
            results
              .map(
                (user) =>
                  `${user.id.padEnd(20)} ${user.name} ${user.email ?? ""}`,
              )
              .join("\n") || "No users found",
          );
        } finally {
          store.close();
        }
      },
    );

  program
    .command("daemon")
    .description("Run the local AgentChannels daemon")
    .requiredOption("--relay-url <ws-url>")
    .option("--concurrency <count>", "maximum simultaneous runtime turns", "2")
    .action(async (options: { relayUrl: string; concurrency: string }) => {
      await startDaemon({
        relayUrl: options.relayUrl,
        concurrency: Number.parseInt(options.concurrency, 10),
        ...(program.opts<GlobalOptions>().home === undefined
          ? {}
          : { home: program.opts<GlobalOptions>().home }),
      });
    });

  return program;
}
