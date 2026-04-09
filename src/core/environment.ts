import { AgentClient, CreateEnvironmentResult } from "./agent-client.js";

/**
 * Environment configuration for creation.
 */
export interface EnvironmentCreateParams {
  name: string;
  description?: string;
}

/**
 * Validated environment info returned from the API.
 */
export interface EnvironmentInfo {
  id: string;
  name: string;
}

/**
 * Options for resolving an environment (create or reuse).
 */
export type EnvironmentResolveOptions =
  | { mode: "create"; name: string; description?: string }
  | { mode: "existing"; environmentId: string };

/**
 * Result of resolving an environment.
 */
export interface EnvironmentResolveResult {
  id: string;
  name: string;
  created: boolean;
}

/**
 * Validate environment ID format before making API calls.
 * Environment IDs from the Anthropic API follow specific patterns.
 * Returns true if the format is plausible; doesn't guarantee existence.
 */
export function isValidEnvironmentIdFormat(environmentId: string): boolean {
  if (!environmentId || typeof environmentId !== "string") {
    return false;
  }
  // Environment IDs should be non-empty strings, trimmed, no whitespace
  const trimmed = environmentId.trim();
  if (trimmed.length === 0 || trimmed !== environmentId) {
    return false;
  }
  // Reject strings with whitespace or control characters
  if (/[\s\x00-\x1f]/.test(environmentId)) {
    return false;
  }
  return true;
}

/**
 * Validate that an environment ID format is correct,
 * throwing a descriptive error if not.
 */
export function assertValidEnvironmentIdFormat(environmentId: string): void {
  if (!isValidEnvironmentIdFormat(environmentId)) {
    throw new Error(
      `Invalid environment ID format: "${environmentId}". ` +
        "Environment IDs must be non-empty strings without whitespace.",
    );
  }
}

/**
 * Validate that an environment exists by retrieving it from the API.
 * Performs format validation first, then API validation.
 */
export async function validateEnvironment(
  client: AgentClient,
  environmentId: string,
): Promise<EnvironmentInfo> {
  assertValidEnvironmentIdFormat(environmentId);

  try {
    const env = await client.getEnvironment(environmentId);
    return { id: env.id, name: env.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Environment "${environmentId}" not found or inaccessible: ${message}`,
    );
  }
}

/**
 * Create a new managed environment via the API.
 * Validates the name before creating.
 */
export async function createEnvironment(
  client: AgentClient,
  params: EnvironmentCreateParams,
): Promise<EnvironmentInfo> {
  if (!params.name || params.name.trim().length === 0) {
    throw new Error("Environment name is required and cannot be empty.");
  }

  const result = await client.createEnvironment({
    name: params.name.trim(),
    description: params.description,
  });

  return { id: result.id, name: result.name };
}

/**
 * List available environments from the API.
 * Returns an array of environment info objects.
 */
export async function listEnvironments(
  client: AgentClient,
  options?: { limit?: number },
): Promise<EnvironmentInfo[]> {
  const rawClient = client.getRawClient();

  try {
    const response = await rawClient.beta.environments.list({
      limit: options?.limit ?? 20,
    });

    const data = (response as any).data ?? response;
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((env: any) => ({
      id: env.id,
      name: env.name,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list environments: ${message}`);
  }
}

/**
 * Resolve an environment — either create a new one or validate an existing one.
 * This is the primary high-level utility for environment setup flows.
 */
export async function resolveEnvironment(
  client: AgentClient,
  options: EnvironmentResolveOptions,
): Promise<EnvironmentResolveResult> {
  if (options.mode === "existing") {
    const env = await validateEnvironment(client, options.environmentId);
    return { ...env, created: false };
  }

  const env = await createEnvironment(client, {
    name: options.name,
    description: options.description,
  });
  return { ...env, created: true };
}

/**
 * Generate a default environment name based on an agent name.
 */
export function defaultEnvironmentName(agentName: string): string {
  return `${agentName}-env`;
}
