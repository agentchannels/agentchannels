/**
 * Shared plumbing for provider connectors: HTTP, header lookup, and defensive
 * reading of untrusted JSON. A connector file should contain only what is
 * specific to its provider's protocol.
 */

export type JsonObject = Readonly<Record<string, unknown>>;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Provider headers arrive with unpredictable casing. */
export function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === wanted,
  )?.[1];
}

/** A non-empty string, or undefined for anything else. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A plain object, or undefined for arrays, null, and primitives. */
export function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Parse a raw request body as a JSON object; malformed input is not an object. */
export function jsonObjectBody(rawBody: Buffer): JsonObject | undefined {
  try {
    return objectValue(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return undefined;
  }
}

/** Read a provider response as JSON, treating any non-object as empty. */
export async function parseJsonResponse(
  response: Response,
): Promise<JsonObject> {
  const text = await response.text();
  try {
    return objectValue(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

/**
 * Describe a provider failure for delivery retry decisions and operator logs,
 * preserving `Retry-After` because providers use it to signal rate limits.
 */
export function providerFailure(
  operation: string,
  response: Response,
  detail: string | undefined,
): string {
  const reason = detail ?? `HTTP ${String(response.status)}`;
  const retryAfter = response.headers.get("retry-after");
  return `${operation} failed: ${reason}${
    retryAfter === null ? "" : ` (retry after ${retryAfter}s)`
  }`;
}
