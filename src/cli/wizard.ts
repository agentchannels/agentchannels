import { basename, join } from "node:path";

import type { ConnectorModule } from "../connectors/connector.ts";
import type { Agent, ConnectorType, RemoteUser } from "../model.ts";
import { RelayClient } from "../relay/client.ts";
import type { ProductPaths } from "../paths.ts";
import type { BindingSetup, Persistence } from "../store/store.ts";
import type { RelayManager } from "../relay/enrollment.ts";
import type { RelayEndpoints } from "../relay/origin.ts";
import type {
  BindingCredentialService,
  InstallationIdentityService,
} from "../security/identity.ts";
import { redactSensitiveText } from "../security/redact.ts";
import { AgentChannelsError, invalidState } from "../errors.ts";
import { classifyError } from "./errors.ts";
import { plainTerminalFormatter, type TerminalFormatter } from "./format.ts";
import type { ExternalActions, PromptIO } from "./io.ts";

export type WizardDependencies = Readonly<{
  store: Persistence;
  paths: ProductPaths;
  connectors: ReadonlyMap<ConnectorType, ConnectorModule>;
  relay: RelayManager;
  identity: InstallationIdentityService;
  credentials: BindingCredentialService;
  prompt: PromptIO;
  external: ExternalActions;
  interactive: boolean;
  write(message: string): void;
  formatter?: TerminalFormatter;
  offerDaemon?(): Promise<void>;
  pendingIngressAvailable?(): Promise<boolean>;
}>;

export type InitInput = Readonly<{
  cwd: string;
  name?: string;
  connectorTypes?: readonly string[];
  additionalDirectories?: readonly string[];
}>;

export type SetupAction = Readonly<{
  connector: string;
  status: "pending" | "ready" | "failed";
  step: string;
  actionUrl?: string;
  artifactPath?: string;
  workspace?: string;
  error?: string;
}>;

export type InitResult = Readonly<{
  status: "ready" | "action_required" | "degraded";
  actionRequired: boolean;
  nextSteps: readonly string[];
  agent: Agent;
  setups: readonly SetupAction[];
  error?: Readonly<{ code: string; message: string }>;
}>;

function selectedConnectors(
  value: string,
  connectors: ReadonlyMap<ConnectorType, ConnectorModule>,
): ConnectorType[] {
  const requested = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const selected: ConnectorType[] = [];
  for (const item of requested) {
    const connector = [...connectors.values()].find(
      (candidate) =>
        candidate.type.toLowerCase() === item.toLowerCase() ||
        candidate.label.toLowerCase() === item.toLowerCase(),
    );
    if (connector === undefined)
      throw new AgentChannelsError(
        "USAGE_ERROR",
        `Unknown connector ${item}.`,
        [
          `Choose one of: ${[...connectors.values()].map((candidate) => candidate.type).join(", ")}.`,
        ],
      );
    if (!selected.includes(connector.type)) selected.push(connector.type);
  }
  return selected;
}

/** A persisted setup may name a connector this build no longer ships. */
function assertConnectorsExist(
  connectors: ReadonlyMap<ConnectorType, ConnectorModule>,
  selected: readonly ConnectorType[],
): void {
  for (const type of selected) {
    if (!connectors.has(type))
      throw new AgentChannelsError(
        "USAGE_ERROR",
        `Unknown connector ${type}.`,
        ["Choose a connector offered by this installation."],
      );
  }
}

async function chooseConnectors(
  dependencies: WizardDependencies,
): Promise<ConnectorType[]> {
  const skip = "__local_only__";
  const values = await dependencies.prompt.multiSelect("Connect a channel", [
    ...[...dependencies.connectors.values()].map((connector) => ({
      value: connector.type,
      label: connector.label,
    })),
    { value: skip, label: "Skip", description: "Initialize local-only" },
  ]);
  if (values.includes(skip) && values.length > 1)
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Skip cannot be combined with a connector.",
      ["Choose Skip for local-only setup, or select one or more connectors."],
    );
  return values.filter((value): value is ConnectorType => value !== skip);
}

function setupArtifactPath(
  paths: ProductPaths,
  setup: BindingSetup,
  filename: string,
): string {
  return join(paths.onboarding, setup.agentId, setup.id, filename);
}

async function chooseOperator(
  dependencies: WizardDependencies,
  connector: ConnectorModule,
  credentials: Readonly<Record<string, string>>,
): Promise<RemoteUser> {
  const query = await dependencies.prompt.input(
    `Search for the ${connector.label} Operator by name or email`,
  );
  if (!query)
    throw new AgentChannelsError(
      "INPUT_EOF",
      "An Operator search is required.",
      ["Rerun agentchannels init and search by your name or email."],
    );
  const users = await connector.searchUsers(query, credentials);
  if (users.length === 0)
    throw new AgentChannelsError(
      "PROVIDER_REJECTED",
      `${connector.label} returned no matching Operator.`,
      ["Search again with the name or email of a workspace member."],
    );
  if (users.length === 1 && users[0] !== undefined) return users[0];
  return dependencies.prompt.select(
    "Operator",
    users.map((user) => ({
      value: user,
      label: user.name,
      ...(user.email === null ? {} : { description: user.email }),
    })),
  );
}

async function waitWithPendingIngress(
  dependencies: WizardDependencies,
  endpoints: RelayEndpoints,
  connector: ConnectorModule,
  waitForAdministrator: () => Promise<void>,
): Promise<void> {
  if (connector.handlePendingWebhook === undefined) {
    await waitForAdministrator();
    return;
  }
  if (await dependencies.pendingIngressAvailable?.()) {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await waitForAdministrator();
    return;
  }
  let connectedResolve!: () => void;
  let connectedReject!: (error: unknown) => void;
  const connected = new Promise<void>((resolve, reject) => {
    connectedResolve = resolve;
    connectedReject = reject;
  });
  const relay = new RelayClient({
    endpoints,
    identity: dependencies.identity,
    listBindings: () => [
      ...dependencies.store.listAllBindings(),
      ...dependencies.store.listAllBindingSetups(),
    ],
    handleWebhook: async (message) => {
      const pending = dependencies.store.getBindingSetup(message.bindingId);
      if (pending === undefined || pending.connector !== message.connector)
        return { status: 404, body: "Unknown binding" };
      const module = dependencies.connectors.get(pending.connector);
      return (
        module?.handlePendingWebhook?.(message) ?? {
          status: 404,
          body: "Unknown binding",
        }
      );
    },
    onStateChange: (isConnected) => {
      if (isConnected) connectedResolve();
    },
  });
  const run = relay.run().catch((error: unknown) => {
    connectedReject(error);
    throw error;
  });
  try {
    await Promise.race([
      connected,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error("Relay connection timed out during provider setup"),
            ),
          15_000,
        ),
      ),
    ]);
    await waitForAdministrator();
  } finally {
    relay.stop();
    await run.catch(() => undefined);
  }
}

async function processSetup(
  dependencies: WizardDependencies,
  agent: Agent,
  initial: BindingSetup,
  endpoints: RelayEndpoints,
): Promise<SetupAction> {
  const connector = dependencies.connectors.get(initial.connector);
  if (connector === undefined)
    throw invalidState(`Connector ${initial.connector} is unavailable.`, [
      "Reinstall AgentChannels with the connector this setup uses.",
    ]);
  let setup = dependencies.store.getBindingSetup(initial.id) ?? initial;
  const artifact = connector.createOnboardingArtifact({
    agentName: agent.name,
    relayOrigin: endpoints.origin,
    webhookUrl: endpoints.webhookUrl(connector.type, setup.id).toString(),
  });
  const artifactPath = setupArtifactPath(
    dependencies.paths,
    setup,
    artifact.filename,
  );

  if (setup.step === "selected") {
    await dependencies.external.writeArtifact(artifactPath, artifact.content);
    setup = dependencies.store.updateBindingSetup(setup.id, {
      step: "admin_action",
      artifactPath,
      lastError: null,
    });
  }

  if (!dependencies.interactive) {
    return {
      connector: connector.type,
      status: "pending",
      step: setup.step,
      actionUrl: artifact.actionUrl,
      artifactPath,
    };
  }

  if (setup.step === "admin_action") {
    const formatter = dependencies.formatter ?? plainTerminalFormatter;
    dependencies.write(
      `\n${formatter.pending(`${connector.label} setup paused`)}\nArtifact: ${formatter.dim(artifactPath)}\nOpen: ${artifact.actionUrl}\n${artifact.instructions.map((line) => `- ${line}`).join("\n")}\n`,
    );
    if (artifact.copyToClipboard) {
      const copied = await dependencies.external.copyText(artifact.content);
      dependencies.write(
        copied
          ? `${formatter.success("Manifest copied to the clipboard")}\n`
          : "Clipboard unavailable; use the manifest artifact above.\n",
      );
    }
    const opened = await dependencies.external.openUrl(artifact.actionUrl);
    if (!opened)
      dependencies.write(
        "Browser unavailable; open the printed URL after reading the artifact.\n",
      );
    await waitWithPendingIngress(
      dependencies,
      endpoints,
      connector,
      async () => {
        await dependencies.prompt.input(
          `Press Enter after the ${connector.label} app is created and installed`,
        );
      },
    );
    setup = dependencies.store.updateBindingSetup(setup.id, {
      step: "credentials",
      lastError: null,
    });
  }

  let verifiedCredentials: Readonly<Record<string, string>> | undefined;
  if (setup.step === "credentials") {
    const entered: Record<string, string> = {};
    for (const field of connector.credentialFields) {
      const value = await dependencies.prompt.secret(field.label);
      if (!value)
        throw new AgentChannelsError(
          "MALFORMED_CREDENTIALS",
          `${field.label} is required.`,
          ["Rerun agentchannels init to resume credential entry."],
        );
      entered[field.key] = value;
    }
    const verified = await connector.verifyCredentials(entered);
    verifiedCredentials = verified.credentials;
    await dependencies.credentials.set(setup.id, verified.credentials);
    setup = dependencies.store.updateBindingSetup(setup.id, {
      step: "operator",
      externalInstallationId: verified.externalInstallationId,
      externalInstallationName: verified.externalInstallationName,
      lastError: null,
    });
  }

  if (setup.step === "operator") {
    if (verifiedCredentials === undefined) {
      const stored = await dependencies.credentials.get(setup.id);
      if (stored === null) {
        setup = dependencies.store.updateBindingSetup(setup.id, {
          step: "credentials",
        });
        return processSetup(dependencies, agent, setup, endpoints);
      }
      verifiedCredentials = JSON.parse(stored) as Record<string, string>;
    }
    const operator = await chooseOperator(
      dependencies,
      connector,
      verifiedCredentials,
    );
    const externalInstallationId = setup.externalInstallationId;
    if (!externalInstallationId)
      throw invalidState(
        `${connector.label} workspace discovery is incomplete.`,
        ["Rerun agentchannels init to re-enter provider credentials."],
      );
    try {
      dependencies.store.completeBindingSetup(setup.id, {
        operatorUserId: operator.id,
        externalInstallationId,
      });
    } catch (error) {
      await dependencies.credentials.delete(setup.id).catch(() => undefined);
      throw error;
    }
    dependencies.write(
      `${(dependencies.formatter ?? plainTerminalFormatter).success(`${connector.label} connected to ${setup.externalInstallationName ?? externalInstallationId}`)}\n`,
    );
    return {
      connector: connector.type,
      status: "ready",
      step: "ready",
      workspace: setup.externalInstallationName ?? externalInstallationId,
    };
  }

  return {
    connector: connector.type,
    status: "pending",
    step: setup.step,
    actionUrl: artifact.actionUrl,
    artifactPath,
  };
}

export async function runInitWizard(
  dependencies: WizardDependencies,
  input: InitInput,
): Promise<InitResult> {
  let agent = dependencies.store.findAgentByExactCwd(input.cwd);
  let requested: ConnectorType[] = [];
  if (agent === undefined) {
    const defaultName = basename(input.cwd);
    const name =
      input.name ??
      (dependencies.interactive
        ? await dependencies.prompt.input("Name", defaultName)
        : defaultName);
    requested =
      input.connectorTypes === undefined
        ? dependencies.interactive
          ? await chooseConnectors(dependencies)
          : []
        : input.connectorTypes.flatMap((value) =>
            selectedConnectors(value, dependencies.connectors),
          );
    assertConnectorsExist(dependencies.connectors, requested);
    agent = dependencies.store.transaction(() => {
      const created = dependencies.store.createAgent({
        name,
        cwd: input.cwd,
        ...(input.additionalDirectories === undefined
          ? {}
          : { additionalDirectories: input.additionalDirectories }),
      });
      for (const connector of requested)
        dependencies.store.createBindingSetup({
          agentId: created.id,
          connector,
        });
      return created;
    });
  } else if (input.connectorTypes !== undefined) {
    requested = input.connectorTypes.flatMap((value) =>
      selectedConnectors(value, dependencies.connectors),
    );
    assertConnectorsExist(dependencies.connectors, requested);
    const completed = new Set(
      dependencies.store
        .listBindings(agent.id)
        .map((binding) => binding.connector),
    );
    const pending = new Set(
      dependencies.store
        .listBindingSetups(agent.id)
        .map((setup) => setup.connector),
    );
    for (const connector of requested) {
      if (!completed.has(connector) && !pending.has(connector))
        dependencies.store.createBindingSetup({ agentId: agent.id, connector });
    }
  }

  const connectorOrder = [...dependencies.connectors.keys()];
  const pending = dependencies.store
    .listBindingSetups(agent.id)
    .sort(
      (left, right) =>
        connectorOrder.indexOf(left.connector) -
        connectorOrder.indexOf(right.connector),
    );
  assertConnectorsExist(
    dependencies.connectors,
    pending.map((setup) => setup.connector),
  );
  const formatter = dependencies.formatter ?? plainTerminalFormatter;
  dependencies.write(
    `${formatter.success(`Agent ${agent.name} configured`)}\n`,
  );
  if (pending.length === 0) {
    if (dependencies.store.listBindings(agent.id).length > 0)
      await dependencies.offerDaemon?.();
    return {
      status: "ready",
      actionRequired: false,
      nextSteps: [],
      agent,
      setups: [],
    };
  }

  let endpoints: RelayEndpoints;
  try {
    endpoints = await dependencies.relay.ensureHosted();
  } catch (error) {
    throw new AgentChannelsError(
      "RELAY_UNAVAILABLE",
      `Relay enrollment failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
      ["Retry agentchannels init after the hosted Relay is available."],
      { cause: error },
    );
  }

  const actions: SetupAction[] = [];
  const failures: { connector: ConnectorType; error: AgentChannelsError }[] =
    [];
  for (const setup of pending) {
    try {
      actions.push(await processSetup(dependencies, agent, setup, endpoints));
    } catch (error) {
      const normalized = classifyError(error);
      if (normalized.code === "INPUT_EOF" || normalized.code === "CANCELLED")
        throw normalized;
      dependencies.store.updateBindingSetup(setup.id, {
        lastError: normalized.message,
      });
      failures.push({ connector: setup.connector, error: normalized });
      actions.push({
        connector: setup.connector,
        status: "failed",
        step: dependencies.store.getBindingSetup(setup.id)?.step ?? setup.step,
        error: normalized.message,
      });
    }
  }

  const remaining = dependencies.store.listBindingSetups(agent.id);
  if (
    remaining.length === 0 &&
    dependencies.store.listBindings(agent.id).length > 0
  ) {
    await dependencies.offerDaemon?.();
  }
  const actionRequired = remaining.length > 0 || failures.length > 0;
  return {
    status:
      failures.length > 0
        ? "degraded"
        : actionRequired
          ? "action_required"
          : "ready",
    actionRequired,
    nextSteps: actionRequired
      ? [
          `Rerun agentchannels init to ${failures[0] === undefined ? "resume" : "retry"} ${failures[0]?.connector ?? remaining[0]?.connector ?? "provider"} setup.`,
        ]
      : [],
    agent,
    setups: actions,
    ...(failures[0] === undefined
      ? {}
      : {
          error: {
            code: failures[0].error.code,
            message: failures[0].error.message,
          },
        }),
  };
}
