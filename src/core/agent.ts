import { AgentClient, CreateAgentResult } from "./agent-client.js";

/**
 * Agent info returned from validation or creation.
 */
export interface AgentInfo {
  id: string;
  name: string;
  version: number;
}

/**
 * Parameters for creating a new agent.
 */
export interface AgentCreateParams {
  name: string;
  model?: string;
  description?: string;
  system?: string;
}

/**
 * Discriminated union for resolving an agent (create or reuse existing).
 */
export type AgentResolveOptions =
  | ({ mode: "create" } & AgentCreateParams)
  | { mode: "existing"; agentId: string };

/**
 * Result of resolving an agent.
 */
export interface AgentResolveResult {
  id: string;
  name: string;
  version: number;
  created: boolean;
}

/**
 * Validate agent ID format before making API calls.
 * Agent IDs should be non-empty strings without whitespace or control characters.
 * Returns true if the format is plausible; doesn't guarantee existence.
 */
export function isValidAgentIdFormat(agentId: string): boolean {
  if (!agentId || typeof agentId !== "string") {
    return false;
  }
  const trimmed = agentId.trim();
  if (trimmed.length === 0 || trimmed !== agentId) {
    return false;
  }
  // Reject strings with whitespace or control characters
  if (/[\s\x00-\x1f]/.test(agentId)) {
    return false;
  }
  return true;
}

/**
 * Validate that an agent ID format is correct,
 * throwing a descriptive error if not.
 */
export function assertValidAgentIdFormat(agentId: string): void {
  if (!isValidAgentIdFormat(agentId)) {
    throw new Error(
      `Invalid agent ID format: "${agentId}". ` +
        "Agent IDs must be non-empty strings without whitespace.",
    );
  }
}

/**
 * Validate that an agent exists by retrieving it from the API.
 * Performs format validation first, then API validation.
 */
export async function validateAgent(
  client: AgentClient,
  agentId: string,
): Promise<AgentInfo> {
  assertValidAgentIdFormat(agentId);

  try {
    const agent = await client.getAgent(agentId);
    return { id: agent.id, name: agent.name, version: agent.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Agent "${agentId}" not found or inaccessible: ${message}`,
    );
  }
}

/**
 * Create a new managed agent via the API.
 * Validates the name before creating.
 */
export async function createAgent(
  client: AgentClient,
  params: AgentCreateParams,
): Promise<AgentInfo> {
  if (!params.name || params.name.trim().length === 0) {
    throw new Error("Agent name is required and cannot be empty.");
  }

  const result = await client.createAgent({
    name: params.name.trim(),
    model: params.model,
    description: params.description,
    system: params.system,
  });

  return { id: result.id, name: result.name, version: result.version };
}

/**
 * Resolve an agent — either create a new one or validate an existing one.
 * This is the primary high-level utility for agent setup flows.
 *
 * Usage:
 *   // Create new agent
 *   const result = await resolveAgent(client, {
 *     mode: "create",
 *     name: "my-bot",
 *     model: "claude-sonnet-4-6",
 *     description: "A helpful bot",
 *   });
 *
 *   // Validate existing agent
 *   const result = await resolveAgent(client, {
 *     mode: "existing",
 *     agentId: "agent_abc123",
 *   });
 */
export async function resolveAgent(
  client: AgentClient,
  options: AgentResolveOptions,
): Promise<AgentResolveResult> {
  if (options.mode === "existing") {
    const agent = await validateAgent(client, options.agentId);
    return { ...agent, created: false };
  }

  const agent = await createAgent(client, {
    name: options.name,
    model: options.model,
    description: options.description,
    system: options.system,
  });
  return { ...agent, created: true };
}

/**
 * List available agents from the API.
 * Returns an array of agent info objects.
 */
export async function listAgents(
  client: AgentClient,
  options?: { limit?: number },
): Promise<AgentInfo[]> {
  const rawClient = client.getRawClient();

  try {
    const response = await rawClient.beta.agents.list({
      limit: options?.limit ?? 20,
    });

    const data = (response as any).data ?? response;
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((agent: any) => ({
      id: agent.id,
      name: agent.name,
      version: agent.version ?? 1,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list agents: ${message}`);
  }
}

/**
 * Generate a default agent name for agentchannels.
 */
export function defaultAgentName(): string {
  return "agentchannels-bot";
}

/**
 * Generate a default agent description.
 */
export function defaultAgentDescription(): string {
  return "AgentChannels Slack bot powered by Claude";
}
