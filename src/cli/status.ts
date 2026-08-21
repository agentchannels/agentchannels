import type { Persistence } from "../store/store.ts";
import { HOSTED_RELAY_ORIGIN } from "../relay/origin.ts";
import { type ServiceStatus } from "../service/types.ts";
import { redactSensitiveText } from "../security/redact.ts";
import { plainTerminalFormatter, type TerminalFormatter } from "./format.ts";
import { notFound } from "../errors.ts";

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

function safePersistedError(value: string | null): string | null {
  if (value === null) return null;
  return redactSensitiveText(value).split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function oneNextStep(value: readonly string[]): readonly string[] {
  const first = value[0];
  return first === undefined ? [] : [redactSensitiveText(first)];
}

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
    throw notFound("Agent", options.agentId, [
      "Run agentchannels agent list and use an existing Agent ID.",
    ]);
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
    .filter((setup) => selectedIds?.has(setup.agentId) ?? true)
    .map((setup) => ({
      ...setup,
      lastError: safePersistedError(setup.lastError),
    }));
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const sessions = store
    .listSessions()
    .filter((session) => bindingIds.has(session.bindingId));
  const installation = store.getInstallationState();
  const failures = pendingSetups.filter(
    (setup) => setup.lastError !== null && setup.lastError.trim().length > 0,
  );
  const relayActionRequired =
    bindings.length > 0 && installation?.relayOrigin == null;
  const daemonActionRequired =
    daemon !== undefined && bindings.length > 0 && !daemon.running;
  const actionRequired =
    agents.length === 0 ||
    pendingSetups.length > 0 ||
    relayActionRequired ||
    daemonActionRequired;
  const nextSteps: readonly string[] =
    agents.length === 0
      ? ["Run agentchannels init in a Git repository."]
      : failures.length > 0
        ? [
            "Correct the reported provider error, then rerun agentchannels init.",
          ]
        : pendingSetups.length > 0
          ? ["Rerun agentchannels init to resume provider setup."]
          : relayActionRequired
            ? ["Run agentchannels init to finish Relay setup."]
            : daemonActionRequired
              ? [
                  daemon.installed
                    ? "Run agentchannels daemon start."
                    : daemon.supported
                      ? "Run agentchannels daemon install."
                      : "Run agentchannels daemon in the foreground.",
                ]
              : [];
  return {
    status:
      failures.length > 0
        ? "degraded"
        : actionRequired
          ? "action_required"
          : "ready",
    actionRequired,
    nextSteps: oneNextStep(nextSteps),
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

export function renderOverview(
  value: InstallationOverview,
  formatter: TerminalFormatter = plainTerminalFormatter,
): string {
  const lines = ["AgentChannels", "", "Configured:"];
  if (value.agents.length === 0)
    lines.push(formatter.pending("No Agents configured"));
  else {
    for (const agent of value.agents) {
      const bindings = value.bindings.filter(
        (binding) => binding.agentId === agent.id,
      );
      const connectors = bindings
        .map((binding) => binding.connector)
        .join(", ");
      const description =
        bindings.length === 0
          ? "no connections"
          : `${bindings.length.toString()} connection(s)${connectors.length === 0 ? "" : `: ${connectors}`}`;
      lines.push(
        `${formatter.success(agent.name)} ${formatter.dim(`(${description})`)}`,
      );
    }
  }
  if (value.pendingSetups.length > 0) {
    lines.push("", "Waiting or failed:");
    for (const setup of value.pendingSetups) {
      lines.push(
        `- ${setup.connector}: ${redactSensitiveText(setup.lastError?.trim() ? setup.lastError : setup.step)}`,
      );
    }
  }
  if (value.relay.status === "uninitialized" && value.bindings.length > 0)
    lines.push("", formatter.pending("Relay not configured"));
  else if (value.relay.mode === "self_hosted")
    lines.push("", "Relay: self-hosted");
  if (value.daemon !== undefined) {
    lines.push(
      "",
      value.daemon.running
        ? formatter.success("Daemon running")
        : formatter.pending(
            `Daemon ${value.daemon.installed ? "stopped" : value.daemon.supported ? "not installed" : "unsupported"}`,
          ),
    );
    // The Relay does not queue events for an offline installation, so this is a
    // silent loss window unless it is stated here.
    if (!value.daemon.running && value.bindings.length > 0)
      lines.push(
        "Messages sent to a connected channel while the daemon is stopped are not delivered later.",
      );
  }
  if (value.sessions.length > 0) {
    lines.push("", "Sessions:");
    for (const session of value.sessions)
      lines.push(`- ${redactSensitiveText(session.status)}`);
  }
  if (value.actionRequired && value.nextSteps[0] !== undefined)
    lines.push("", formatter.pending(redactSensitiveText(value.nextSteps[0])));
  return lines.join("\n");
}
