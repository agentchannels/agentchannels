import type { ConnectorModule } from "../../connectors/connector.ts";
import { AgentChannelsError, invalidState } from "../../errors.ts";
import type { Agent, Binding, ConnectorType } from "../../model.ts";
import type { Persistence } from "../../store/store.ts";
import type { CredentialStore } from "../../security/keyring.ts";
import { BindingCredentialService } from "../../security/identity.ts";
import type { PromptIO } from "../io.ts";

/**
 * Resolution and input helpers shared by more than one command group.
 *
 * A command belongs in its own file; the way commands agree on *which* Agent or
 * Binding they are acting on belongs here, so that agreement stays one rule.
 */

export async function readStandardInput(required = false): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin as AsyncIterable<string>)
    value += chunk;
  if (required && value.trim() === "")
    throw new AgentChannelsError(
      "INPUT_EOF",
      "Required input ended before setup completed.",
      ["Provide the requested input and rerun the command."],
    );
  return value;
}
export async function resolveAgent(
  store: Persistence,
  agentId: string | undefined,
  interactive: boolean,
  prompt: PromptIO,
  cwd = process.cwd(),
): Promise<Agent> {
  if (agentId !== undefined) {
    const agent = store.getAgent(agentId);
    if (agent === undefined)
      throw new AgentChannelsError(
        "MISSING_AGENT",
        `Agent ${agentId} not found.`,
        ["Run agentchannels agent list and use an existing Agent ID."],
      );
    return agent;
  }
  const candidates = store.findAgentsByCwd(cwd);
  if (candidates.length === 1 && candidates[0] !== undefined)
    return candidates[0];
  if (!interactive)
    throw new AgentChannelsError(
      "MISSING_AGENT",
      "Current directory does not uniquely identify an Agent; pass --agent ag_...",
      ["Pass --agent with an ID from agentchannels agent list."],
    );
  const selectable = candidates.length > 1 ? candidates : store.listAgents();
  if (selectable.length === 0)
    throw new AgentChannelsError("MISSING_AGENT", "No Agents are configured.", [
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
export async function resolveBinding(
  store: Persistence,
  agent: Agent,
  bindingId: string | undefined,
  interactive: boolean,
  prompt: PromptIO,
): Promise<Binding> {
  if (bindingId !== undefined) {
    const binding = store.getBinding(bindingId);
    if (binding === undefined || binding.agentId !== agent.id)
      throw new AgentChannelsError(
        "USAGE_ERROR",
        `Binding ${bindingId} does not belong to the selected Agent`,
        ["Run agentchannels binding list and use a Binding for this Agent."],
      );
    return binding;
  }
  const bindings = store.listBindings(agent.id);
  if (bindings.length === 1 && bindings[0] !== undefined) return bindings[0];
  if (!interactive)
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Binding is ambiguous; pass --binding bd_...",
      ["Pass --binding with an ID from agentchannels binding list."],
    );
  if (bindings.length === 0)
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "The Agent has no completed Bindings.",
      ["Run agentchannels init to connect a channel."],
    );
  return prompt.select(
    "Connection",
    bindings.map((candidate) => ({
      value: candidate,
      label: candidate.connector,
    })),
  );
}
/** Option values arrive as strings; a bad one is the operator's mistake, not ours. */
export function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new AgentChannelsError(
      "USAGE_ERROR",
      `${option} must be a positive whole number.`,
      [`Pass ${option} with a value of 1 or more.`],
    );
  return parsed;
}

/** Look up provider users through a Binding's stored credentials. */
export async function searchUsers(
  binding: Binding,
  query: string,
  connectors: ReadonlyMap<ConnectorType, ConnectorModule>,
  credentials: CredentialStore,
) {
  const connector = connectors.get(binding.connector);
  if (connector === undefined)
    throw invalidState(`Connector ${binding.connector} is unavailable.`, [
      "Reinstall AgentChannels with the connector this Binding uses.",
    ]);
  const stored = await new BindingCredentialService(credentials).require(
    binding.id,
  );
  return connector.searchUsers(query, stored);
}
