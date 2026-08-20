import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
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
import { createTerminalFormatter } from "./format.js";
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
  serviceEntry?: string;
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

async function readStandardInput(required = false): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin as AsyncIterable<string>)
    value += chunk;
  if (required && value.trim() === "")
    throw new CliError(
      "INPUT_EOF",
      "Required input ended before setup completed.",
      ["Provide the requested input and rerun the command."],
    );
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
    if (agent === undefined)
      throw new CliError("MISSING_AGENT", `Agent ${agentId} not found.`, [
        "Run agentchannels agent list and use an existing Agent ID.",
      ]);
    return agent;
  }
  const candidates = store.findAgentsByCwd(cwd);
  if (candidates.length === 1 && candidates[0] !== undefined)
    return candidates[0];
  if (!interactive)
    throw new CliError(
      "MISSING_AGENT",
      "Current directory does not uniquely identify an Agent; pass --agent ag_...",
      ["Pass --agent with an ID from agentchannels agent list."],
    );
  const selectable = candidates.length > 1 ? candidates : store.listAgents();
  if (selectable.length === 0)
    throw new CliError("MISSING_AGENT", "No Agents are configured.", [
      "Run agentchannels init in a Git repository.",
    ]);
  return prompt.select(
    "Agent",
    selectable.map((candidate) => ({
      value: candidate,
      label: candidate.name,
      description: candidate.cwd,
    })),
  );
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
      throw new CliError(
        "USAGE_ERROR",
        `Binding ${bindingId} does not belong to the selected Agent`,
        ["Run agentchannels binding list and use a Binding for this Agent."],
      );
    return binding;
  }
  const bindings = store.listBindings(agent.id);
  if (bindings.length === 1 && bindings[0] !== undefined) return bindings[0];
  if (!interactive)
    throw new CliError(
      "USAGE_ERROR",
      "Binding is ambiguous; pass --binding bd_...",
      ["Pass --binding with an ID from agentchannels binding list."],
    );
  if (bindings.length === 0)
    throw new CliError("USAGE_ERROR", "The Agent has no completed Bindings.", [
      "Run agentchannels init to connect a channel.",
    ]);
  return prompt.select(
    "Connection",
    bindings.map((candidate) => ({
      value: candidate,
      label: candidate.connector,
    })),
  );
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
      throw new CliError(
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
      output(program, value, renderOverview(value, formatter()));
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
        output(
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
      throw new CliError("MISSING_AGENT", "No Agents are configured.", [
        "Run agentchannels init in a Git repository.",
      ]);
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
          formatter: formatter(),
          offerDaemon,
          pendingIngressAvailable: async () =>
            (await serviceManager().status(serviceDefinition())).running,
        },
        { cwd: agent.cwd, connectorTypes: [connector] },
      );
      output(
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
      output(
        program,
        {
          status: "ready",
          actionRequired: false,
          nextSteps: [],
          agents,
        },
        agents
          .map((item) => `${item.name}\t${formatter().dim(item.cwd)}`)
          .join("\n") || "No Agents",
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
          throw new Error(`Agent ${options.agent} not found`);
        const pendingCredentialIds = store
          .listBindingSetups(selected.id)
          .map((setup) => setup.id);
        for (const setupId of pendingCredentialIds)
          await credentialStore.delete(`binding:${setupId}`);
        if (!store.deleteAgent(selected.id))
          throw new Error(`Agent ${selected.id} not found`);
        output(
          program,
          {
            status: "ready",
            actionRequired: false,
            nextSteps: [],
            deleted: true,
          },
          `Deleted Agent ${selected.name}`,
        );
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
      output(
        program,
        {
          status: "ready",
          actionRequired: false,
          nextSteps: [],
          bindings,
        },
        bindings
          .map((item) => `${item.connector}\t${formatter().dim(item.id)}`)
          .join("\n") || "No Bindings",
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
          throw new Error(
            "Pass connector credentials via --credentials-file or --credentials-stdin",
          );
        const encoded =
          options.credentialsFile === undefined
            ? await readStandardInput(true)
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
              {
                status: "ready",
                actionRequired: false,
                nextSteps: [],
                binding: completed,
              },
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
          throw new Error(`Binding ${selected.id} not found`);
        await credentialStore.delete(`binding:${selected.id}`);
        output(
          program,
          {
            status: "ready",
            actionRequired: false,
            nextSteps: [],
            removed: true,
          },
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
      const values = (store?.listSessions() ?? []).filter((item) =>
        allowed.has(item.bindingId),
      );
      output(
        program,
        {
          status: "ready",
          actionRequired: false,
          nextSteps: [],
          sessions: values,
        },
        values
          .map((item) => `${item.status}\t${formatter().dim(item.id)}`)
          .join("\n") || "No Sessions",
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
          {
            status: "ready",
            actionRequired: false,
            nextSteps: [],
            retired: true,
          },
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
    .description("Manage shared-user access for a Binding")
    .addHelpText(
      "after",
      `
Interactive mode selects the Agent, Binding, and provider user when omitted.

Examples:
  agentchannels access add
  agentchannels access list --binding bd_...
  agentchannels access remove --binding bd_... --user PLATFORM_USER_ID`,
    );
  access.action(() => access.outputHelp());
  access
    .command("add")
    .description("Grant a provider user access to a Binding")
    .option("--user <id>", "stable provider user ID for non-interactive use")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "target Binding ID")
    .addHelpText(
      "after",
      `
Human mode searches the provider when --user is omitted. Automation must pass
--agent, --binding, and --user.

Example:
  agentchannels access add --agent ag_... --binding bd_... --user U123...`,
    )
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
            if (results.length === 0)
              throw new Error("No matching users found");
            userId = await prompt.select(
              "User",
              results.map((user) => ({
                value: user.id,
                label: user.name,
                ...(user.email === null ? {} : { description: user.email }),
              })),
            );
          }
          const grant = store.grantAccess(selected.id, userId);
          output(
            program,
            { status: "ready", actionRequired: false, nextSteps: [], grant },
            `Granted access via ${selected.connector}`,
          );
        } finally {
          store.close();
        }
      },
    );
  access
    .command("list")
    .description("List users who can use a Binding")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "target Binding ID")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels access list --binding bd_...
  agentchannels access list --agent ag_... --binding bd_... --json`,
    )
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
          { status: "ready", actionRequired: false, nextSteps: [], grants },
          grants.map((item) => item.userId).join("\n") || "No shared users",
        );
      } finally {
        store.close();
      }
    });
  access
    .command("remove")
    .description("Revoke a provider user's Binding access")
    .requiredOption("--user <id>", "stable provider user ID")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "target Binding ID")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels access remove --binding bd_... --user U123...
  agentchannels access remove --agent ag_... --binding bd_... --user U123...`,
    )
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
            { status: "ready", actionRequired: false, nextSteps: [], removed },
            removed ? "Access removed" : "No matching grant",
          );
        } finally {
          store.close();
        }
      },
    );

  const users = program
    .command("users")
    .description("Find provider users for access grants")
    .addHelpText(
      "after",
      `
Search uses a configured Slack or Linear Binding and returns stable provider
user IDs for access grants.

Example:
  agentchannels users search alice --binding bd_...`,
    );
  users.action(() => users.outputHelp());
  users
    .command("search")
    .description("Search by name or email and print stable provider user IDs")
    .argument("<query>", "provider user name or email")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "provider Binding to search")
    .addHelpText(
      "after",
      `
Example:
  agentchannels users search alice --binding bd_...

Use the returned stable ID with agentchannels access add --user <id>.`,
    )
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
            {
              status: "ready",
              actionRequired: false,
              nextSteps: [],
              users: results,
            },
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
    .description("Select or inspect the installation-wide AgentChannels Relay")
    .addHelpText(
      "after",
      `
Hosted Relay is the default for normal agentchannels init.
Use relay use only for an explicit hosted/self-hosted installation cutover.

Examples:
  agentchannels relay status
  agentchannels relay use --hosted
  agentchannels relay use --url https://relay.example.com --enrollment-token-stdin`,
    );
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
          ? `${formatter().pending("Relay uninitialized")}\nRun agentchannels init to connect a channel.`
          : formatter().success("Relay configured"),
      );
    } finally {
      store?.close();
    }
  };
  relay.action(showRelayStatus);
  relay
    .command("status")
    .description("Show the selected Relay and enrollment state")
    .addHelpText(
      "after",
      `
The Relay is selected once for the local installation and shared by all
Agents and Bindings.

Examples:
  agentchannels relay status
  agentchannels relay status --json`,
    )
    .action(showRelayStatus);
  relay
    .command("use")
    .description("Select the hosted or a self-hosted Relay")
    .addOption(
      new Option("--hosted", "select the official hosted Relay").conflicts(
        "url",
      ),
    )
    .addOption(
      new Option("--url <origin>", "self-hosted HTTPS origin").conflicts(
        "hosted",
      ),
    )
    .addOption(
      new Option(
        "--enrollment-token-stdin",
        "read self-hosted enrollment authorization from stdin",
      ).conflicts("hosted"),
    )
    .option(
      "--acknowledge-binding-reconfiguration",
      "acknowledge provider webhook URL changes",
    )
    .addHelpText(
      "after",
      `
Hosted is the normal default. Use --url only for an explicit self-hosted
origin; self-hosted automation must provide enrollment authorization on stdin.
Changing Relay with existing Bindings requires
--acknowledge-binding-reconfiguration after reviewing the returned URLs.

Examples:
  agentchannels relay use --hosted
  agentchannels relay use --url https://relay.example.com \\
    --enrollment-token-stdin < enrollment-token`,
    )
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
              enrollmentToken = (await readStandardInput(true)).trim();
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
          if (result.action === "restart_daemon") {
            const service = serviceManager();
            const current = await service.status(serviceDefinition());
            if (current.installed) {
              const definition = serviceDefinition();
              assertStableServiceEntry(definition);
              await service.restart(definition);
            }
          }
          output(
            program,
            result,
            result.action === "restart_daemon"
              ? `${formatter().success("Relay selected")}\n${result.bindings.length > 0 ? "Update the listed provider webhooks." : ""}`
              : formatter().success("Relay selected"),
          );
        } finally {
          store.close();
        }
      },
    );

  const daemon = program
    .command("daemon")
    .description("Run in the foreground or manage the background daemon")
    .addHelpText(
      "after",
      `
Foreground:
  agentchannels daemon

Background lifecycle:
  agentchannels daemon install|start|restart|stop|status|uninstall

Background services are per-user LaunchAgents on macOS and systemd user
services on Linux. Do not run these commands with sudo.`,
    );
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
  const lifecycleOutput = (
    result: Awaited<ReturnType<ServiceManager["install"]>>,
    message: string,
  ): void => {
    output(
      program,
      {
        status: "ready",
        actionRequired: false,
        nextSteps: [],
        service: result,
      },
      formatter().success(message),
    );
  };
  daemon
    .command("install")
    .description("Install or reconcile the per-user background daemon")
    .addHelpText(
      "after",
      `
Installs and starts the per-user service. It does not require sudo.

Example:
  agentchannels daemon install`,
    )
    .action(async () => {
      const definition = serviceDefinition();
      assertStableServiceEntry(definition);
      const result = await serviceManager().reconcile(definition);
      if (result.operation === "unsupported")
        throw new CliError(
          "SERVICE_MANAGER_FAILED",
          `Background services are unsupported on ${result.platform}.`,
          ["Run agentchannels daemon in the foreground."],
        );
      lifecycleOutput(result, "Background daemon running");
    });
  daemon
    .command("start")
    .description("Start the installed background daemon")
    .addHelpText(
      "after",
      `
The daemon must already be installed.

Example:
  agentchannels daemon start`,
    )
    .action(async () => {
      const result = await serviceManager().start(serviceDefinition());
      lifecycleOutput(result, "Daemon running");
    });
  daemon
    .command("restart")
    .description("Restart the installed background daemon")
    .addHelpText(
      "after",
      `
Use this after changing the installation Relay or daemon configuration.

Example:
  agentchannels daemon restart`,
    )
    .action(async () => {
      const definition = serviceDefinition();
      assertStableServiceEntry(definition);
      const result = await serviceManager().restart(definition);
      lifecycleOutput(result, "Daemon restarted");
    });
  daemon
    .command("stop")
    .description("Stop the background daemon")
    .addHelpText(
      "after",
      `
Stopping the service leaves configured Agents and Bindings unchanged.

Example:
  agentchannels daemon stop`,
    )
    .action(async () => {
      const result = await serviceManager().stop(serviceDefinition());
      lifecycleOutput(result, "Daemon stopped");
    });
  daemon
    .command("status")
    .description("Show background daemon installation and running state")
    .addHelpText(
      "after",
      `
Use the next step in this output to install or start the service when needed.

Examples:
  agentchannels daemon status
  agentchannels daemon status --json`,
    )
    .action(async () => {
      const status = await serviceManager().status(serviceDefinition());
      const nextSteps = status.running
        ? []
        : [
            status.supported
              ? status.installed
                ? "Run agentchannels daemon start."
                : "Run agentchannels daemon install."
              : "Run agentchannels daemon in the foreground.",
          ];
      output(
        program,
        {
          status: status.running ? "ready" : "action_required",
          actionRequired: !status.running,
          nextSteps,
          service: status,
        },
        status.running
          ? formatter().success("Daemon running")
          : `${formatter().pending(`Daemon ${status.installed ? "stopped" : status.supported ? "not installed" : "unsupported"}`)}\n${nextSteps[0]}`,
      );
    });
  daemon
    .command("uninstall")
    .description("Remove the per-user background daemon")
    .addHelpText(
      "after",
      `
Uninstalling stops and removes the service definition; local AgentChannels
state and provider credentials remain available.

Example:
  agentchannels daemon uninstall`,
    )
    .action(async () => {
      const result = await serviceManager().uninstall(serviceDefinition());
      lifecycleOutput(result, "Daemon uninstalled");
    });

  overrideCommandExits(program);
  return program;
}
