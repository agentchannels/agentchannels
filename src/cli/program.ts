import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { Command, Option } from "commander";

import {
  loadConnectorModules,
  type ConnectorModule,
} from "../connectors/connector.js";
import type { Agent, Binding, ConnectorType } from "../core/types.js";
import { ensureProductPaths, resolveProductPaths } from "../core/paths.js";
import { WorktreeManager } from "../core/worktrees.js";
import { startDaemon } from "../daemon/daemon.js";
import { Persistence } from "../persistence/store.js";
import { RelayManager } from "../relay/manager.js";
import { HOSTED_RELAY_ORIGIN, parseRelayOrigin } from "../relay/origin.js";
import {
  KeyringCredentialStore,
  type CredentialStore,
} from "../security/credentials.js";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../security/identity.js";
import {
  createServiceDefinition,
  createServiceManager,
  type ServiceManager,
} from "../service/index.js";
import { PRODUCT_VERSION } from "../version.js";
import { CliError } from "./errors.js";
import {
  systemExternalActions,
  terminalPromptIO,
  type ExternalActions,
  type PromptIO,
} from "./io.js";
import { installationOverview, renderOverview } from "./status.js";
import { runInitWizard } from "./wizard.js";

const execFileAsync = promisify(execFile);

export type GlobalOptions = {
  json?: boolean;
  debug?: boolean;
  home?: string;
};

export type ProgramDependencies = Readonly<{
  prompt?: PromptIO;
  external?: ExternalActions;
  credentialStore?: CredentialStore;
  connectors?: ReadonlyMap<ConnectorType, ConnectorModule>;
  relayFetch?: typeof fetch;
  interactive?: boolean;
  serviceManager?: ServiceManager;
}>;

function output(program: Command, value: unknown, human: string): void {
  process.stdout.write(
    program.opts<GlobalOptions>().json
      ? `${JSON.stringify(value, null, 2)}\n`
      : `${human}\n`,
  );
}

function productPaths(program: Command) {
  const global = program.opts<GlobalOptions>();
  return resolveProductPaths(
    global.home === undefined
      ? process.env
      : { ...process.env, AGENTCHANNELS_HOME: global.home },
  );
}

function openStore(program: Command): Persistence {
  const paths = productPaths(program);
  ensureProductPaths(paths);
  return new Persistence(paths.database, { backupDirectory: paths.backups });
}

function openExistingStore(program: Command): Persistence | undefined {
  const paths = productPaths(program);
  if (!existsSync(paths.database)) return undefined;
  return new Persistence(paths.database, { backupDirectory: paths.backups });
}

async function repositoryRoot(cwd: string): Promise<string> {
  try {
    const root = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return realpathSync(root.stdout.trim());
  } catch (error) {
    throw new CliError(
      "MISSING_GIT_HEAD",
      "AgentChannels requires a Git repository with a current HEAD.",
      ["Create the first commit, then run agentchannels init again."],
      { cause: error },
    );
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
  prompt: PromptIO,
  cwd = process.cwd(),
): Promise<Agent> {
  if (agentId !== undefined) {
    const agent = store.getAgent(agentId);
    if (agent === undefined) throw new Error(`Agent ${agentId} not found`);
    return agent;
  }
  const candidates = store.findAgentsByCwd(cwd);
  if (candidates.length === 1 && candidates[0] !== undefined)
    return candidates[0];
  if (!interactive)
    throw new Error(
      "Current directory does not uniquely identify an Agent; pass --agent ag_...",
    );
  const selectable = candidates.length > 1 ? candidates : store.listAgents();
  if (selectable.length === 0)
    throw new Error("No Agents are configured; run agentchannels init");
  process.stdout.write(
    `${selectable
      .map(
        (agent, index) => `${String(index + 1)}. ${agent.name} — ${agent.cwd}`,
      )
      .join("\n")}\n`,
  );
  const selected = Number.parseInt(await prompt.input("Agent"), 10) - 1;
  const agent = selectable[selected];
  if (agent === undefined) throw new Error("Agent selection was invalid");
  return agent;
}

async function resolveBinding(
  store: Persistence,
  agent: Agent,
  bindingId: string | undefined,
  interactive: boolean,
  prompt: PromptIO,
): Promise<Binding> {
  if (bindingId !== undefined) {
    const binding = store.getBinding(bindingId);
    if (binding === undefined || binding.agentId !== agent.id)
      throw new Error(
        `Binding ${bindingId} does not belong to the selected Agent`,
      );
    return binding;
  }
  const bindings = store.listBindings(agent.id);
  if (bindings.length === 1 && bindings[0] !== undefined) return bindings[0];
  if (!interactive)
    throw new Error("Binding is ambiguous; pass --binding bd_...");
  if (bindings.length === 0)
    throw new Error("The Agent has no completed Bindings");
  process.stdout.write(
    `${bindings
      .map((binding, index) => `${String(index + 1)}. ${binding.connector}`)
      .join("\n")}\n`,
  );
  const selected = Number.parseInt(await prompt.input("Connection"), 10) - 1;
  const binding = bindings[selected];
  if (binding === undefined) throw new Error("Binding selection was invalid");
  return binding;
}

function relayManager(
  store: Persistence,
  credentialStore: CredentialStore,
  relayFetch?: typeof fetch,
): RelayManager {
  return new RelayManager({
    store,
    identity: new InstallationIdentityService(credentialStore),
    ...(relayFetch === undefined ? {} : { fetch: relayFetch }),
  });
}

function parseConnectorFlag(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const prompt = dependencies.prompt ?? terminalPromptIO;
  const external = dependencies.external ?? systemExternalActions;
  const credentialStore =
    dependencies.credentialStore ?? new KeyringCredentialStore();
  const connectorModules =
    dependencies.connectors === undefined
      ? loadConnectorModules()
      : Promise.resolve(dependencies.connectors);
  const program = new Command()
    .name("agentchannels")
    .description("Use a local Claude Code environment from Slack and Linear")
    .version(PRODUCT_VERSION)
    .option("--json", "emit machine-readable JSON")
    .option("--debug", "include diagnostic stack traces")
    .option("--home <path>", "override ~/.agentchannels for this invocation")
    .configureOutput({ writeErr: () => undefined });
  const interactive = (): boolean =>
    dependencies.interactive ??
    (program.opts<GlobalOptions>().json !== true &&
      process.stdin.isTTY === true);
  const serviceEnvironment = (): NodeJS.ProcessEnv =>
    program.opts<GlobalOptions>().home === undefined
      ? process.env
      : {
          ...process.env,
          AGENTCHANNELS_HOME: productPaths(program).root,
        };
  const serviceManager = (): ServiceManager =>
    dependencies.serviceManager ??
    createServiceManager({ environment: serviceEnvironment() });
  const serviceDefinition = () =>
    createServiceDefinition({
      version: PRODUCT_VERSION,
      executable: "/usr/bin/env",
      args: ["agentchannels", "daemon"],
      environment: {
        AGENTCHANNELS_HOME: productPaths(program).root,
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      },
    });
  const offerDaemon = async (): Promise<void> => {
    if (
      await prompt.confirm(
        "Start AgentChannels automatically when you log in?",
        true,
      )
    ) {
      const status = await serviceManager().install(serviceDefinition());
      if (!program.opts<GlobalOptions>().json)
        process.stdout.write(
          `✓ Background daemon ${status.running ? "running" : "installed"}.\n`,
        );
    } else if (!program.opts<GlobalOptions>().json) {
      process.stdout.write(
        "Next: run agentchannels daemon in the foreground.\n",
      );
    }
  };

  const showOverview = async (agentId?: string): Promise<void> => {
    const store = openExistingStore(program);
    try {
      const daemonStatus = await serviceManager().status(serviceDefinition());
      const value = installationOverview(
        store,
        {
          cwd: process.cwd(),
          ...(agentId === undefined ? {} : { agentId }),
        },
        daemonStatus,
      );
      output(program, value, renderOverview(value));
    } finally {
      store?.close();
    }
  };
  program.action(() => showOverview());

  const init = program
    .command("init")
    .description("Create or resume Agent onboarding")
    .option("--name <name>")
    .option("--cwd <path>")
    .option("--additional-directory <path...>")
    .option("--connect <connectors>", "comma-separated connector names");
  init.addOption(new Option("--linear-client-url <url>").hideHelp());
  init.addOption(new Option("--linear-redirect-url <url>").hideHelp());
  init.action(
    async (options: {
      name?: string;
      cwd?: string;
      additionalDirectory?: string[];
      connect?: string;
    }) => {
      const root = await repositoryRoot(resolve(options.cwd ?? process.cwd()));
      const paths = productPaths(program);
      ensureProductPaths(paths);
      const store = new Persistence(paths.database, {
        backupDirectory: paths.backups,
      });
      try {
        const identity = new InstallationIdentityService(credentialStore);
        const result = await runInitWizard(
          {
            store,
            paths,
            connectors: await connectorModules,
            relay: relayManager(
              store,
              credentialStore,
              dependencies.relayFetch,
            ),
            identity,
            credentials: new BindingCredentialService(credentialStore),
            prompt,
            external,
            interactive: interactive(),
            write: (message) => {
              if (!program.opts<GlobalOptions>().json)
                process.stdout.write(message);
            },
            offerDaemon,
            pendingIngressAvailable: async () =>
              (await serviceManager().status(serviceDefinition())).running,
          },
          {
            cwd: root,
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.connect === undefined
              ? {}
              : { connectorTypes: parseConnectorFlag(options.connect) }),
            additionalDirectories: (options.additionalDirectory ?? []).map(
              (path) => resolve(path),
            ),
          },
        );
        output(
          program,
          result,
          `${result.status === "ready" ? "Onboarding complete." : "Onboarding saved."}\nNext: ${result.nextSteps[0] ?? "Run agentchannels status."}`,
        );
        if (result.status === "degraded") process.exitCode = 6;
      } finally {
        store.close();
      }
    },
  );

  const connect = program
    .command("connect")
    .description("Add or resume a connector for an Agent")
    .argument("<connector>")
    .option("--agent <id>");
  connect.addOption(new Option("--linear-client-url <url>").hideHelp());
  connect.addOption(new Option("--linear-redirect-url <url>").hideHelp());
  connect.action(async (connector: string, options: { agent?: string }) => {
    const store = openExistingStore(program);
    if (store === undefined)
      throw new Error("No Agents are configured; run agentchannels init");
    try {
      const agent = await resolveAgent(
        store,
        options.agent,
        interactive(),
        prompt,
      );
      const paths = productPaths(program);
      const identity = new InstallationIdentityService(credentialStore);
      const result = await runInitWizard(
        {
          store,
          paths,
          connectors: await connectorModules,
          relay: relayManager(store, credentialStore, dependencies.relayFetch),
          identity,
          credentials: new BindingCredentialService(credentialStore),
          prompt,
          external,
          interactive: interactive(),
          write: (message) => {
            if (!program.opts<GlobalOptions>().json)
              process.stdout.write(message);
          },
          offerDaemon,
          pendingIngressAvailable: async () =>
            (await serviceManager().status(serviceDefinition())).running,
        },
        { cwd: agent.cwd, connectorTypes: [connector] },
      );
      output(
        program,
        result,
        `Connection setup saved.\nNext: ${result.nextSteps[0]}`,
      );
      if (result.status === "degraded") process.exitCode = 6;
    } finally {
      store.close();
    }
  });

  program
    .command("status")
    .description("Show installation status")
    .option("--agent <id>")
    .action((options: { agent?: string }) => showOverview(options.agent));

  const agent = program.command("agent").description("Manage local Agents");
  const listAgents = (): void => {
    const store = openExistingStore(program);
    try {
      const agents = store?.listAgents() ?? [];
      output(
        program,
        {
          status: "ready",
          actionRequired: false,
          nextSteps: ["Run agentchannels status."],
          agents,
        },
        `${agents.map((item) => `${item.name}\t${item.cwd}`).join("\n") || "No Agents"}\nNext: run agentchannels status`,
      );
    } finally {
      store?.close();
    }
  };
  agent.action(listAgents);
  agent.command("list").action(listAgents);
  agent
    .command("delete")
    .requiredOption("--agent <id>")
    .action((options: { agent: string }) => {
      const store = openStore(program);
      try {
        const selected = store.getAgent(options.agent);
        if (selected === undefined)
          throw new Error(`Agent ${options.agent} not found`);
        if (!store.deleteAgent(selected.id))
          throw new Error(`Agent ${selected.id} not found`);
        output(
          program,
          { status: "ready", deleted: true },
          `Deleted Agent ${selected.name}`,
        );
      } finally {
        store.close();
      }
    });

  const binding = program.command("binding").description("Manage Bindings");
  const listBindings = (options: { agent?: string } = {}): void => {
    const store = openExistingStore(program);
    try {
      const bindings = (store?.listAllBindings() ?? []).filter(
        (item) => options.agent === undefined || item.agentId === options.agent,
      );
      output(
        program,
        {
          status: "ready",
          actionRequired: false,
          nextSteps: ["Run agentchannels status."],
          bindings,
        },
        `${bindings.map((item) => `${item.connector}\t${item.id}`).join("\n") || "No Bindings"}\nNext: run agentchannels status`,
      );
    } finally {
      store?.close();
    }
  };
  binding.action(() => listBindings());
  binding.command("list").option("--agent <id>").action(listBindings);
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
        )
          throw new Error(
            "Pass connector credentials via --credentials-file or --credentials-stdin",
          );
        const encoded =
          options.credentialsFile === undefined
            ? await readStandardInput()
            : await readFile(resolve(options.credentialsFile), "utf8");
        let credentials: Record<string, string>;
        try {
          credentials = JSON.parse(encoded) as Record<string, string>;
        } catch (error) {
          throw new CliError(
            "MALFORMED_CREDENTIALS",
            "Credentials must be valid JSON.",
            ["Correct the credential input and rerun binding complete."],
            { cause: error },
          );
        }
        const store = openStore(program);
        try {
          const setup = store.getBindingSetup(options.setup);
          if (setup === undefined)
            throw new Error(`Binding setup ${options.setup} not found`);
          const connector = (await connectorModules).get(setup.connector);
          if (connector === undefined)
            throw new Error(`Connector ${setup.connector} unavailable`);
          const verified = await connector.verifyCredentials(credentials);
          if (verified.externalInstallationId !== options.externalInstallation)
            throw new Error(
              "Provider credentials belong to a different workspace",
            );
          const credentialService = new BindingCredentialService(
            credentialStore,
          );
          await credentialService.set(setup.id, verified.credentials);
          try {
            const completed = store.completeBindingSetup(setup.id, {
              operatorUserId: options.operatorUser,
              externalInstallationId: options.externalInstallation,
            });
            output(
              program,
              { status: "ready", binding: completed },
              `Connected ${completed.connector}`,
            );
          } catch (error) {
            await credentialStore.delete(`binding:${setup.id}`);
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
        const selectedAgent = await resolveAgent(
          store,
          options.agent,
          interactive(),
          prompt,
        );
        const selected = await resolveBinding(
          store,
          selectedAgent,
          options.binding,
          interactive(),
          prompt,
        );
        if (!store.deleteBinding(selected.id))
          throw new Error(`Binding ${selected.id} not found`);
        await credentialStore.delete(`binding:${selected.id}`);
        output(
          program,
          { status: "ready", removed: true },
          `Removed ${selected.connector} Binding`,
        );
      } finally {
        store.close();
      }
    });

  const sessions = program.command("sessions").description("Inspect Sessions");
  const listSessions = (options: { agent?: string } = {}): void => {
    const store = openExistingStore(program);
    try {
      const allowed = new Set(
        (store?.listAllBindings() ?? [])
          .filter(
            (item) =>
              options.agent === undefined || item.agentId === options.agent,
          )
          .map((item) => item.id),
      );
      const values = (store?.listSessions() ?? []).filter((item) =>
        allowed.has(item.bindingId),
      );
      output(
        program,
        {
          status: "ready",
          actionRequired: false,
          nextSteps: ["Run agentchannels status."],
          sessions: values,
        },
        `${values.map((item) => `${item.status}\t${item.id}`).join("\n") || "No Sessions"}\nNext: run agentchannels status`,
      );
    } finally {
      store?.close();
    }
  };
  sessions.action(() => listSessions());
  sessions.command("list").option("--agent <id>").action(listSessions);
  sessions
    .command("retire")
    .requiredOption("--session <id>")
    .option("--agent <id>")
    .action(async (options: { session: string; agent?: string }) => {
      const store = openStore(program);
      try {
        const selectedAgent = await resolveAgent(
          store,
          options.agent,
          interactive(),
          prompt,
        );
        const session = store.getSession(options.session);
        if (session === undefined)
          throw new Error(`Session ${options.session} not found`);
        const sessionBinding = store.getBinding(session.bindingId);
        if (sessionBinding?.agentId !== selectedAgent.id)
          throw new Error("Session does not belong to the selected Agent");
        const worktrees = new WorktreeManager({
          repositoryPath: selectedAgent.cwd,
          worktreeRoot: resolve(
            productPaths(program).worktrees,
            selectedAgent.id,
          ),
        });
        if ((await worktrees.remove(session.worktreePath)) === "preserved")
          throw new Error("Session worktree is dirty and was preserved");
        store.retireSessionNow(session.id);
        output(
          program,
          { status: "ready", retired: true },
          `Retired Session ${session.id}`,
        );
      } finally {
        store.close();
      }
    });

  const searchUsers = async (binding: Binding, query: string) => {
    const connector = (await connectorModules).get(binding.connector);
    if (connector === undefined)
      throw new Error(`Connector ${binding.connector} unavailable`);
    const credentials = await new BindingCredentialService(
      credentialStore,
    ).require(binding.id);
    return connector.searchUsers(query, credentials);
  };
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
          const selectedAgent = await resolveAgent(
            store,
            options.agent,
            interactive(),
            prompt,
          );
          const selected = await resolveBinding(
            store,
            selectedAgent,
            options.binding,
            interactive(),
            prompt,
          );
          let userId = options.user;
          if (userId === undefined) {
            if (!interactive())
              throw new Error("--user is required in non-interactive mode");
            const results = await searchUsers(
              selected,
              await prompt.input("Search by name or email"),
            );
            process.stdout.write(
              `${results.map((user, index) => `${String(index + 1)}. ${user.name}${user.email ? ` — ${user.email}` : ""}`).join("\n")}\n`,
            );
            userId =
              results[Number.parseInt(await prompt.input("User"), 10) - 1]?.id;
            if (userId === undefined)
              throw new Error("User selection was invalid");
          }
          const grant = store.grantAccess(selected.id, userId);
          output(
            program,
            { status: "ready", grant },
            `Granted access via ${selected.connector}`,
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
        const selectedAgent = await resolveAgent(
          store,
          options.agent,
          interactive(),
          prompt,
        );
        const selected = await resolveBinding(
          store,
          selectedAgent,
          options.binding,
          interactive(),
          prompt,
        );
        const grants = store.listAccess(selected.id);
        output(
          program,
          { status: "ready", grants },
          grants.map((item) => item.userId).join("\n") || "No shared users",
        );
      } finally {
        store.close();
      }
    });
  access
    .command("remove")
    .requiredOption("--user <id>")
    .option("--agent <id>")
    .option("--binding <id>")
    .action(
      async (options: { user: string; agent?: string; binding?: string }) => {
        const store = openStore(program);
        try {
          const selectedAgent = await resolveAgent(
            store,
            options.agent,
            interactive(),
            prompt,
          );
          const selected = await resolveBinding(
            store,
            selectedAgent,
            options.binding,
            interactive(),
            prompt,
          );
          const removed = store.revokeAccess(selected.id, options.user);
          output(
            program,
            { status: "ready", removed },
            removed ? "Access removed" : "No matching grant",
          );
        } finally {
          store.close();
        }
      },
    );

  const users = program.command("users").description("Search provider users");
  users
    .command("search")
    .argument("<query>")
    .option("--agent <id>")
    .option("--binding <id>")
    .action(
      async (query: string, options: { agent?: string; binding?: string }) => {
        const store = openStore(program);
        try {
          const selectedAgent = await resolveAgent(
            store,
            options.agent,
            interactive(),
            prompt,
          );
          const selected = await resolveBinding(
            store,
            selectedAgent,
            options.binding,
            interactive(),
            prompt,
          );
          const results = await searchUsers(selected, query);
          output(
            program,
            { status: "ready", users: results },
            results
              .map((user) => `${user.name}\t${user.email ?? ""}\t${user.id}`)
              .join("\n") || "No users found",
          );
        } finally {
          store.close();
        }
      },
    );

  const relay = program
    .command("relay")
    .description("Select or inspect the Relay");
  const showRelayStatus = (): void => {
    const store = openExistingStore(program);
    try {
      const status =
        store === undefined
          ? { status: "uninitialized" as const }
          : relayManager(
              store,
              credentialStore,
              dependencies.relayFetch,
            ).status();
      output(
        program,
        status,
        status.status === "uninitialized"
          ? "Relay: uninitialized\nNext: run agentchannels init"
          : "Relay: configured",
      );
    } finally {
      store?.close();
    }
  };
  relay.action(showRelayStatus);
  relay.command("status").action(showRelayStatus);
  relay
    .command("use")
    .addOption(new Option("--hosted").conflicts("url"))
    .addOption(new Option("--url <origin>").conflicts("hosted"))
    .addOption(new Option("--enrollment-token-stdin").conflicts("hosted"))
    .option("--acknowledge-binding-reconfiguration")
    .action(
      async (options: {
        hosted?: boolean;
        url?: string;
        enrollmentTokenStdin?: boolean;
        acknowledgeBindingReconfiguration?: boolean;
      }) => {
        let origin = options.hosted ? HOSTED_RELAY_ORIGIN : options.url;
        if (origin === undefined) {
          if (!interactive())
            throw new Error("relay use requires --hosted or --url");
          origin = await prompt.input("Self-hosted Relay URL");
        }
        const normalized = parseRelayOrigin(origin).origin;
        const store = openStore(program);
        try {
          const manager = relayManager(
            store,
            credentialStore,
            dependencies.relayFetch,
          );
          const requirement = manager.preview(normalized);
          let acknowledged = options.acknowledgeBindingReconfiguration === true;
          if (requirement !== undefined && !acknowledged) {
            if (!interactive()) {
              output(
                program,
                requirement,
                JSON.stringify(requirement, null, 2),
              );
              return;
            }
            acknowledged = await prompt.confirm(
              "Update provider webhook URLs?",
              false,
            );
            if (!acknowledged) {
              output(program, { status: "unchanged" }, "Relay unchanged.");
              return;
            }
          }
          let enrollmentToken: string | undefined;
          if (normalized !== HOSTED_RELAY_ORIGIN) {
            if (options.enrollmentTokenStdin)
              enrollmentToken = (await readStandardInput()).trim();
            else if (!interactive())
              throw new Error(
                "Self-hosted Relay requires --enrollment-token-stdin",
              );
            else {
              const entered = await prompt.secret(
                "Enrollment token (blank for explicit open enrollment)",
              );
              enrollmentToken = entered || undefined;
            }
          }
          const result = await manager.use({
            origin: normalized,
            ...(enrollmentToken === undefined ? {} : { enrollmentToken }),
            ...(acknowledged
              ? { acknowledgeBindingReconfiguration: true }
              : {}),
          });
          output(
            program,
            result,
            `Relay selected.\nNext: restart the daemon and update the listed provider webhooks.`,
          );
        } finally {
          store.close();
        }
      },
    );

  const daemon = program
    .command("daemon")
    .description("Run or manage the daemon");
  daemon
    .option("--concurrency <count>", "maximum simultaneous runtime turns", "2")
    .action(async (options: { concurrency: string }) => {
      await startDaemon({
        concurrency: Number.parseInt(options.concurrency, 10),
        ...(program.opts<GlobalOptions>().home === undefined
          ? {}
          : { home: program.opts<GlobalOptions>().home }),
      });
    });
  daemon.command("install").action(async () => {
    const status = await serviceManager().install(serviceDefinition());
    output(
      program,
      {
        status: "ready",
        actionRequired: false,
        nextSteps: [status.nextAction],
        service: status,
      },
      `Daemon installed${status.running ? " and running" : ""}.\nNext: ${status.nextAction}`,
    );
  });
  daemon.command("start").action(async () => {
    const status = await serviceManager().start(serviceDefinition());
    output(
      program,
      {
        status: "ready",
        actionRequired: false,
        nextSteps: [status.nextAction],
        service: status,
      },
      `Daemon ${status.running ? "running" : "stopped"}.\nNext: ${status.nextAction}`,
    );
  });
  daemon.command("stop").action(async () => {
    const status = await serviceManager().stop(serviceDefinition());
    output(
      program,
      {
        status: "ready",
        actionRequired: false,
        nextSteps: [status.nextAction],
        service: status,
      },
      `Daemon stopped.\nNext: ${status.nextAction}`,
    );
  });
  daemon.command("status").action(async () => {
    const status = await serviceManager().status(serviceDefinition());
    output(
      program,
      {
        status: status.running ? "ready" : "action_required",
        actionRequired: !status.running,
        nextSteps: [status.nextAction],
        service: status,
      },
      `Daemon: ${status.running ? "running" : status.installed ? "stopped" : "not installed"}\nNext: ${status.nextAction}`,
    );
  });
  daemon.command("uninstall").action(async () => {
    const status = await serviceManager().uninstall(serviceDefinition());
    output(
      program,
      {
        status: "ready",
        actionRequired: false,
        nextSteps: [status.nextAction],
        service: status,
      },
      `Daemon uninstalled.\nNext: ${status.nextAction}`,
    );
  });

  return program;
}
