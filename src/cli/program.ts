import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Command, Option } from "commander";

import {
  loadConnectorModules,
  type ConnectorModule,
} from "../connectors/connector.ts";
import type { ConnectorType } from "../model.ts";
import { ensureProductPaths, resolveProductPaths } from "../paths.ts";
import { SessionRetentionCleaner } from "../engine/retention.ts";
import { WorktreeManager } from "../engine/worktrees.ts";
import { Persistence } from "../store/store.ts";
import { RelayManager } from "../relay/enrollment.ts";
import {
  KeyringCredentialStore,
  type CredentialStore,
} from "../security/keyring.ts";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../security/identity.ts";
import { createServiceDefinition } from "../service/definition.ts";
import {
  createServiceManager,
  type ServiceManager,
} from "../service/manager.ts";
import { PRODUCT_VERSION } from "../version.ts";
import { AgentChannelsError, invalidState, notFound } from "../errors.ts";
import { createTerminalFormatter } from "./format.ts";
import { emit, ok, renderTable, type GlobalOptions } from "./output.ts";
export type { GlobalOptions } from "./output.ts";
import {
  systemExternalActions,
  terminalPromptIO,
  type ExternalActions,
  type PromptIO,
} from "./io.ts";
import { registerAccessCommands } from "./commands/access.ts";
import { registerDaemonCommands } from "./commands/daemon.ts";
import { registerRelayCommands } from "./commands/relay.ts";
import { registerUsersCommands } from "./commands/users.ts";
import type { CommandContext } from "./context.ts";
import {
  readStandardInput,
  resolveAgent,
  resolveBinding,
} from "./commands/shared.ts";
import { installationOverview, renderOverview } from "./status.ts";
import { runInitWizard } from "./wizard.ts";

const execFileAsync = promisify(execFile);

export type ProgramDependencies = Readonly<{
  prompt?: PromptIO;
  external?: ExternalActions;
  credentialStore?: CredentialStore;
  connectors?: ReadonlyMap<ConnectorType, ConnectorModule>;
  relayFetch?: typeof fetch;
  interactive?: boolean;
  serviceManager?: ServiceManager;
  serviceEntry?: string;
}>;

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
    throw new AgentChannelsError(
      "MISSING_GIT_HEAD",
      "AgentChannels requires a Git repository with a current HEAD.",
      ["Create the first commit, then run agentchannels init again."],
      { cause: error },
    );
  }
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

function overrideCommandExits(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) overrideCommandExits(child);
}

function stableNodeExecutable(): string {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, executableName);
    try {
      if (
        existsSync(candidate) &&
        realpathSync(candidate) === realpathSync(process.execPath)
      )
        return candidate;
    } catch {}
  }
  return process.execPath;
}

function serviceToolPath(): string {
  const systemDirectories =
    process.platform === "win32"
      ? []
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ];
  return [
    dirname(stableNodeExecutable()),
    ...(process.env.PATH ?? "").split(delimiter),
    ...systemDirectories,
  ]
    .filter((entry, index, entries) => {
      if (entry === "" || !existsSync(entry)) return false;
      return entries.indexOf(entry) === index;
    })
    .join(delimiter);
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const prompt = dependencies.prompt ?? terminalPromptIO;
  const external = dependencies.external ?? systemExternalActions;
  // Built on first use: --home is only known after the command line is parsed, and it
  // selects the keyring namespace as well as the state directory.
  let keyring: CredentialStore | undefined;
  const credentialStore = (): CredentialStore => {
    if (dependencies.credentialStore !== undefined)
      return dependencies.credentialStore;
    keyring ??= new KeyringCredentialStore(
      productPaths(program).keyringService,
    );
    return keyring;
  };
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
    .configureOutput({ writeErr: () => undefined })
    .addHelpText(
      "after",
      `
Get started:
  cd /path/to/repository
  agentchannels init

Common commands:
  agentchannels status          Show the installation overview
  agentchannels daemon status   Check background availability

Run agentchannels <command> --help for command-specific examples.`,
    );
  const interactive = (): boolean =>
    dependencies.interactive ??
    (program.opts<GlobalOptions>().json !== true &&
      process.stdin.isTTY === true);
  const formatter = () =>
    createTerminalFormatter({
      isTTY: interactive(),
      json: program.opts<GlobalOptions>().json === true,
      noColor: process.env.NO_COLOR !== undefined,
      ...(process.env.TERM === undefined ? {} : { term: process.env.TERM }),
    });
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
      executable: stableNodeExecutable(),
      args: [
        resolve(dependencies.serviceEntry ?? process.argv[1] ?? ""),
        "daemon",
      ],
      environment: {
        AGENTCHANNELS_HOME: productPaths(program).root,
        PATH: serviceToolPath(),
      },
    });
  const assertStableServiceEntry = (
    definition: ReturnType<typeof serviceDefinition>,
  ): void => {
    const entry = definition.command.args[0] ?? "";
    if (
      /(?:^|[\\/])(?:node_modules[\\/]\.bin|\.pnpm|_npx|dlx)(?:[\\/]|$)/i.test(
        entry,
      )
    )
      throw new AgentChannelsError(
        "SERVICE_MANAGER_FAILED",
        "Background daemon installation requires a persistent AgentChannels executable.",
        [
          "Install AgentChannels globally or run it from a persistent source checkout.",
        ],
      );
  };
  const offerDaemon = async (): Promise<void> => {
    const definition = serviceDefinition();
    assertStableServiceEntry(definition);
    const manager = serviceManager();
    const current = await manager.status(definition);
    if (!current.supported) return;
    if (current.installed) {
      const result = await manager.reconcile(definition);
      if (
        !program.opts<GlobalOptions>().json &&
        (result.operation === "started" || result.operation === "restarted")
      )
        process.stdout.write(
          `${formatter().success(result.operation === "restarted" ? "Background daemon restarted" : "Background daemon running")}\n`,
        );
      return;
    }
    if (!interactive()) return;
    if (
      await prompt.confirm(
        "Start AgentChannels automatically when you log in?",
        true,
      )
    ) {
      const result = await manager.reconcile(definition);
      if (!program.opts<GlobalOptions>().json)
        process.stdout.write(
          `${formatter().success(result.operation === "restarted" ? "Background daemon restarted" : "Background daemon running")}\n`,
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
      emit(program, value, renderOverview(value, formatter()));
    } finally {
      store?.close();
    }
  };
  program.action(() => showOverview());

  const init = program
    .command("init")
    .description("Set up or resume AgentChannels for a Git repository")
    .option("--name <name>", "Agent display name (defaults to repository name)")
    .option(
      "--cwd <path>",
      "repository to configure (defaults to current directory)",
    )
    .option(
      "--additional-directory <path...>",
      "additional runtime directories",
    )
    .option("--connect <connectors>", "machine input: slack, linear, or both")
    .addHelpText(
      "after",
      `
Interactive flow:
  Detect the repository, choose Slack and/or Linear, verify credentials,
  select the Operator, and reconcile the background daemon.

Examples:
  agentchannels init
  agentchannels init --connect slack
  agentchannels init --connect slack,linear --json`,
    );
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
        const identity = new InstallationIdentityService(credentialStore());
        const result = await runInitWizard(
          {
            store,
            paths,
            connectors: await connectorModules,
            relay: relayManager(
              store,
              credentialStore(),
              dependencies.relayFetch,
            ),
            identity,
            credentials: new BindingCredentialService(credentialStore()),
            prompt,
            external,
            interactive: interactive(),
            write: (message) => {
              if (!program.opts<GlobalOptions>().json)
                process.stdout.write(message);
            },
            formatter: formatter(),
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
        emit(
          program,
          result,
          result.status === "ready"
            ? formatter().success("Onboarding complete")
            : `${formatter().pending("Onboarding paused")}\n${result.nextSteps[0] ?? ""}`,
        );
        if (result.status === "degraded") process.exitCode = 6;
      } finally {
        store.close();
      }
    },
  );

  const connect = program
    .command("connect")
    .description("Add or resume Slack or Linear for an existing Agent")
    .argument("<connector>", "channel provider: slack or linear")
    .option("--agent <id>", "target Agent ID when CWD is not unique")
    .addHelpText(
      "after",
      `
Most people should use agentchannels init, which owns the complete human setup.
Use connect when an Agent already exists and you are adding one provider.

Examples:
  agentchannels connect slack
  agentchannels connect linear --agent ag_...

Discover Agent IDs with: agentchannels agent list`,
    );
  connect.addOption(new Option("--linear-client-url <url>").hideHelp());
  connect.addOption(new Option("--linear-redirect-url <url>").hideHelp());
  connect.action(async (connector: string, options: { agent?: string }) => {
    const store = openExistingStore(program);
    if (store === undefined)
      throw new AgentChannelsError(
        "MISSING_AGENT",
        "No Agents are configured.",
        ["Run agentchannels init in a Git repository."],
      );
    try {
      const agent = await resolveAgent(
        store,
        options.agent,
        interactive(),
        prompt,
      );
      const paths = productPaths(program);
      const identity = new InstallationIdentityService(credentialStore());
      const result = await runInitWizard(
        {
          store,
          paths,
          connectors: await connectorModules,
          relay: relayManager(
            store,
            credentialStore(),
            dependencies.relayFetch,
          ),
          identity,
          credentials: new BindingCredentialService(credentialStore()),
          prompt,
          external,
          interactive: interactive(),
          write: (message) => {
            if (!program.opts<GlobalOptions>().json)
              process.stdout.write(message);
          },
          formatter: formatter(),
          offerDaemon,
          pendingIngressAvailable: async () =>
            (await serviceManager().status(serviceDefinition())).running,
        },
        { cwd: agent.cwd, connectorTypes: [connector] },
      );
      emit(
        program,
        result,
        result.status === "ready"
          ? formatter().success("Connection ready")
          : `${formatter().pending("Connection setup paused")}\n${result.nextSteps[0] ?? ""}`,
      );
      if (result.status === "degraded") process.exitCode = 6;
    } finally {
      store.close();
    }
  });

  program
    .command("status")
    .description(
      "Show Agents, provider Bindings, pending setup, Sessions, and daemon state",
    )
    .option("--agent <id>", "show one Agent when CWD is not unique")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels status
  agentchannels status --agent ag_...

Without --agent, status uses CWD only when it identifies exactly one Agent.`,
    )
    .action((options: { agent?: string }) => showOverview(options.agent));

  const agent = program
    .command("agent")
    .description("Manage configured repository Agents")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels agent list
  agentchannels agent delete --agent ag_...`,
    );
  const listAgents = (): void => {
    const store = openExistingStore(program);
    try {
      const agents = store?.listAgents() ?? [];
      emit(
        program,
        ok({ agents }),
        renderTable(
          agents.map((item) => [
            { header: "NAME", value: item.name },
            { header: "ID", value: item.id },
            { header: "REPOSITORY", value: item.cwd },
          ]),
          "No Agents",
          formatter(),
        ),
      );
    } finally {
      store?.close();
    }
  };
  agent.action(listAgents);
  agent
    .command("list")
    .description("List configured Agents and their repository paths")
    .addHelpText(
      "after",
      `
This is global discovery and does not require the current directory to be an
Agent repository.

Examples:
  agentchannels agent list
  agentchannels agent list --json`,
    )
    .action(listAgents);
  agent
    .command("delete")
    .description(
      "Remove an Agent configuration; repository files are untouched",
    )
    .requiredOption("--agent <id>", "Agent ID from agentchannels agent list")
    .addHelpText(
      "after",
      `
Deleting an Agent removes its local configuration only; it does not delete
the repository or provider applications.

Example:
  agentchannels agent delete --agent ag_...`,
    )
    .action(async (options: { agent: string }) => {
      const store = openStore(program);
      try {
        const selected = store.getAgent(options.agent);
        if (selected === undefined)
          throw notFound("Agent", options.agent, [
            "Run agentchannels agent list and use an existing Agent ID.",
          ]);
        const pendingCredentialIds = store
          .listBindingSetups(selected.id)
          .map((setup) => setup.id);
        for (const setupId of pendingCredentialIds)
          await credentialStore().delete(`binding:${setupId}`);
        if (!store.deleteAgent(selected.id))
          throw notFound("Agent", selected.id, [
            "Run agentchannels agent list and use an existing Agent ID.",
          ]);
        emit(program, ok({ deleted: true }), `Deleted Agent ${selected.name}`);
      } finally {
        store.close();
      }
    });

  const binding = program
    .command("binding")
    .description("Manage Slack and Linear connections for an Agent")
    .addHelpText(
      "after",
      `
Normal setup uses agentchannels init or agentchannels connect.

Examples:
  agentchannels binding list
  agentchannels binding remove --binding bd_...`,
    );
  const listBindings = (options: { agent?: string } = {}): void => {
    const store = openExistingStore(program);
    try {
      const bindings = (store?.listAllBindings() ?? []).filter(
        (item) => options.agent === undefined || item.agentId === options.agent,
      );
      emit(
        program,
        ok({ bindings }),
        renderTable(
          bindings.map((item) => [
            { header: "CHANNEL", value: item.connector },
            { header: "ID", value: item.id },
            { header: "WORKSPACE", value: item.externalInstallationId },
          ]),
          "No Bindings",
          formatter(),
        ),
      );
    } finally {
      store?.close();
    }
  };
  binding.action(() => listBindings());
  binding
    .command("list")
    .description("List configured Slack and Linear Bindings")
    .option("--agent <id>", "filter by Agent ID")
    .addHelpText(
      "after",
      `
Use the Binding ID printed here with access, users, or binding remove.

Examples:
  agentchannels binding list
  agentchannels binding list --agent ag_... --json`,
    )
    .action(listBindings);
  binding
    .command("complete")
    .description("Complete prepared provider setup from automation (advanced)")
    .requiredOption("--setup <id>", "pending setup ID")
    .requiredOption("--operator-user <id>", "stable provider Operator user ID")
    .requiredOption(
      "--external-installation <id>",
      "verified provider workspace or organization ID",
    )
    .addOption(
      new Option("--credentials-file <path>").conflicts("credentialsStdin"),
    )
    .option("--credentials-stdin", "read the credential JSON object from stdin")
    .addHelpText(
      "after",
      `
Use this only after init or connect has created a pending setup. Credentials
are read from a file or stdin and are never written to SQLite or output.

Example:
  agentchannels binding complete \\
    --setup bd_... \\
    --operator-user PLATFORM_USER_ID \\
    --external-installation PLATFORM_WORKSPACE_ID \\
    --credentials-stdin < credentials.json`,
    )
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
          throw new AgentChannelsError(
            "USAGE_ERROR",
            "Connector credentials are required.",
            ["Pass --credentials-file or --credentials-stdin."],
          );
        const encoded =
          options.credentialsFile === undefined
            ? await readStandardInput(true)
            : await readFile(resolve(options.credentialsFile), "utf8");
        let credentials: Record<string, string>;
        try {
          credentials = JSON.parse(encoded) as Record<string, string>;
        } catch (error) {
          throw new AgentChannelsError(
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
            throw notFound("Binding setup", options.setup, [
              "Run agentchannels init to create a pending setup first.",
            ]);
          const connector = (await connectorModules).get(setup.connector);
          if (connector === undefined)
            throw invalidState(`Connector ${setup.connector} is unavailable.`, [
              "Reinstall AgentChannels with the connector this setup uses.",
            ]);
          const verified = await connector.verifyCredentials(credentials);
          if (verified.externalInstallationId !== options.externalInstallation)
            throw new AgentChannelsError(
              "PROVIDER_REJECTED",
              "Provider credentials belong to a different workspace.",
              ["Use credentials issued by the workspace you named."],
            );
          const credentialService = new BindingCredentialService(
            credentialStore(),
          );
          await credentialService.set(setup.id, verified.credentials);
          try {
            const completed = store.completeBindingSetup(setup.id, {
              operatorUserId: options.operatorUser,
              externalInstallationId: options.externalInstallation,
            });
            emit(
              program,
              ok({ binding: completed }),
              `Connected ${completed.connector}`,
            );
          } catch (error) {
            await credentialStore().delete(`binding:${setup.id}`);
            throw error;
          }
        } finally {
          store.close();
        }
      },
    );
  binding
    .command("remove")
    .description("Remove a Binding and its stored credentials")
    .requiredOption(
      "--binding <id>",
      "Binding ID from agentchannels binding list",
    )
    .option("--agent <id>", "target Agent ID when CWD is not unique")
    .addHelpText(
      "after",
      `
Removing a Binding also removes its locally stored credentials. Provider apps
and workspaces are not deleted.

Example:
  agentchannels binding remove --binding bd_... --agent ag_...`,
    )
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
          throw notFound("Binding", selected.id, [
            "Run agentchannels binding list and use an existing Binding ID.",
          ]);
        await credentialStore().delete(`binding:${selected.id}`);
        emit(
          program,
          ok({ removed: true }),
          `Removed ${selected.connector} Binding`,
        );
      } finally {
        store.close();
      }
    });

  const sessions = program
    .command("sessions")
    .description("Inspect isolated Claude Sessions and their worktrees")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels sessions list
  agentchannels sessions retire --session ss_...`,
    );
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
      const allBindings = store?.listAllBindings() ?? [];
      const connectorOf = (bindingId: string): string =>
        allBindings.find((item) => item.id === bindingId)?.connector ?? "-";
      const values = (store?.listSessions() ?? []).filter((item) =>
        allowed.has(item.bindingId),
      );
      emit(
        program,
        ok({ sessions: values }),
        renderTable(
          values.map((item) => [
            { header: "STATUS", value: item.status },
            { header: "CHANNEL", value: connectorOf(item.bindingId) },
            { header: "UPDATED", value: item.updatedAt },
            { header: "ID", value: item.id },
          ]),
          "No Sessions",
          formatter(),
        ),
      );
    } finally {
      store?.close();
    }
  };
  sessions.action(() => listSessions());
  sessions
    .command("list")
    .description("List Sessions for all Agents or one selected Agent")
    .option("--agent <id>", "filter by Agent ID")
    .addHelpText(
      "after",
      `
Retained and interrupted Sessions remain visible so they can be intentionally
resumed or retired.

Examples:
  agentchannels sessions list
  agentchannels sessions list --agent ag_... --json`,
    )
    .action(listSessions);
  sessions
    .command("prune")
    .description("Retire every expired Session with a clean owned worktree")
    .addHelpText(
      "after",
      `
Retention normally runs inside the background daemon. This sweeps the same
expired Sessions on demand, which matters when the daemon has not been running.
Dirty or unowned worktrees are preserved and reported, never removed.

Examples:
  agentchannels sessions prune
  agentchannels sessions prune --json`,
    )
    .action(async () => {
      const store = openStore(program);
      try {
        const cleaner = new SessionRetentionCleaner(
          store,
          productPaths(program).worktrees,
        );
        const result = await cleaner.clean();
        const summary =
          result.removed === 0 && result.preservedDirty === 0
            ? "No expired Sessions to prune"
            : `Retired ${String(result.removed)} Session(s)` +
              (result.preservedDirty === 0
                ? ""
                : `; preserved ${String(result.preservedDirty)} dirty worktree(s)`);
        emit(program, ok(result), formatter().success(summary));
      } finally {
        store.close();
      }
    });

  sessions
    .command("retire")
    .description("Retire a Session and remove its clean owned worktree")
    .requiredOption("--session <id>", "retained Session ID")
    .option("--agent <id>", "target Agent ID when CWD is not unique")
    .addHelpText(
      "after",
      `
Only a clean worktree owned by AgentChannels is removed. Dirty or unowned
worktrees are preserved and the Session is not retired.

Example:
  agentchannels sessions retire --session ss_... --agent ag_...`,
    )
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
          throw notFound("Session", options.session, [
            "Run agentchannels sessions list and use an existing Session ID.",
          ]);
        const sessionBinding = store.getBinding(session.bindingId);
        if (sessionBinding?.agentId !== selectedAgent.id)
          throw invalidState("Session does not belong to the selected Agent.", [
            "Pass --agent for the Agent that owns this Session.",
          ]);
        const worktrees = new WorktreeManager({
          repositoryPath: selectedAgent.cwd,
          worktreeRoot: resolve(
            productPaths(program).worktrees,
            selectedAgent.id,
          ),
        });
        if ((await worktrees.remove(session.worktreePath)) === "preserved")
          throw invalidState("Session worktree is dirty and was preserved.", [
            "Commit or discard the worktree changes, then retire the Session.",
          ]);
        store.retireSessionNow(session.id);
        emit(program, ok({ retired: true }), `Retired Session ${session.id}`);
      } finally {
        store.close();
      }
    });

  const context: CommandContext = {
    program,
    paths: () => productPaths(program),
    openStore: () => openStore(program),
    openExistingStore: () => openExistingStore(program),
    credentials: credentialStore,
    connectors: async () => connectorModules,
    relay: (store) =>
      relayManager(store, credentialStore(), dependencies.relayFetch),
    prompt,
    external,
    interactive,
    formatter,
    services: serviceManager,
    serviceDefinition,
    assertStableServiceEntry,
    offerDaemon,
    daemonStatus: async () => serviceManager().status(serviceDefinition()),
  };
  registerAccessCommands(context);
  registerUsersCommands(context);
  registerRelayCommands(context);
  registerDaemonCommands(context);

  overrideCommandExits(program);
  return program;
}
