import type { Persistence } from "../persistence/store.js";
import { HOSTED_RELAY_ORIGIN } from "../relay/origin.js";
import type { ServiceStatus } from "../service/index.js";

export type InstallationOverview = Readonly<{
  status: "uninitialized" | "ready" | "action_required" | "degraded";
  actionRequired: boolean;
  nextSteps: readonly string[];
  currentAgentId: string | null;
  relay: Readonly<{
    status: "uninitialized" | "configured";
    mode?: "hosted" | "self_hosted";
  }>;
  agents: ReturnType<Persistence["listAgents"]>;
  bindings: ReturnType<Persistence["listAllBindings"]>;
  pendingSetups: ReturnType<Persistence["listAllBindingSetups"]>;
  sessions: ReturnType<Persistence["listSessions"]>;
  daemon?: ServiceStatus;
}>;

export function installationOverview(
  store: Persistence | undefined,
  options: { cwd: string; agentId?: string },
  daemon?: ServiceStatus,
): InstallationOverview {
  if (store === undefined) {
    return {
      status: "uninitialized",
      actionRequired: true,
      nextSteps: ["Run agentchannels init in a Git repository."],
      currentAgentId: null,
      relay: { status: "uninitialized" },
      agents: [],
      bindings: [],
      pendingSetups: [],
      sessions: [],
      ...(daemon === undefined ? {} : { daemon }),
    };
  }
  const agents = store.listAgents();
  const explicit =
    options.agentId === undefined ? undefined : store.getAgent(options.agentId);
  if (options.agentId !== undefined && explicit === undefined)
    throw new Error(`Agent ${options.agentId} not found`);
  const cwdCandidates = store.findAgentsByCwd(options.cwd);
  const contextual =
    explicit ?? (cwdCandidates.length === 1 ? cwdCandidates[0] : undefined);
  const selectedIds =
    contextual === undefined ? undefined : new Set([contextual.id]);
  const bindings = store
    .listAllBindings()
    .filter((binding) => selectedIds?.has(binding.agentId) ?? true);
  const pendingSetups = store
    .listAllBindingSetups()
    .filter((setup) => selectedIds?.has(setup.agentId) ?? true);
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const sessions = store
    .listSessions()
    .filter((session) => bindingIds.has(session.bindingId));
  const installation = store.getInstallationState();
  const failures = pendingSetups.filter((setup) => setup.lastError !== null);
  const actionRequired = agents.length === 0 || pendingSetups.length > 0;
  const nextSteps =
    agents.length === 0
      ? ["Run agentchannels init in a Git repository."]
      : failures.length > 0
        ? [
            "Correct the reported provider error, then rerun agentchannels init.",
          ]
        : pendingSetups.length > 0
          ? ["Rerun agentchannels init to resume provider setup."]
          : bindings.length === 0
            ? [
                "Run agentchannels init --connect <connector> to add a connection.",
              ]
            : [
                "Run agentchannels daemon status to verify background availability.",
              ];
  return {
    status:
      failures.length > 0
        ? "degraded"
        : actionRequired
          ? "action_required"
          : "ready",
    actionRequired,
    nextSteps,
    currentAgentId: contextual?.id ?? null,
    relay:
      installation?.relayOrigin == null
        ? { status: "uninitialized" }
        : {
            status: "configured",
            mode:
              installation.relayOrigin === HOSTED_RELAY_ORIGIN
                ? "hosted"
                : "self_hosted",
          },
    agents: contextual === undefined ? agents : [contextual],
    bindings,
    pendingSetups,
    sessions,
    ...(daemon === undefined ? {} : { daemon }),
  };
}

export function renderOverview(value: InstallationOverview): string {
  const lines = ["AgentChannels", "", "Configured:"];
  if (value.agents.length === 0) lines.push("- No Agents");
  else {
    for (const agent of value.agents) {
      const bindings = value.bindings.filter(
        (binding) => binding.agentId === agent.id,
      );
      lines.push(
        `- ${agent.name}: ${bindings.length.toString()} connection(s)`,
      );
    }
  }
  lines.push("", "Waiting or failed:");
  if (value.pendingSetups.length === 0) lines.push("- Nothing pending");
  else {
    for (const setup of value.pendingSetups) {
      lines.push(`- ${setup.connector}: ${setup.lastError ?? setup.step}`);
    }
  }
  if (value.daemon !== undefined) {
    lines.push(
      "",
      `Daemon: ${value.daemon.running ? "running" : value.daemon.installed ? "stopped" : value.daemon.supported ? "not installed" : "unsupported"}`,
    );
  }
  lines.push("", `Next: ${value.nextSteps[0] ?? "No action required."}`);
  return lines.join("\n");
}
