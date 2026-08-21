import { redactSensitiveText } from "./security/redact.ts";

/**
 * The failure categories AgentChannels distinguishes, and the process exit code
 * each one produces.
 *
 * Classification happens where a failure is raised, never by matching on message
 * text later. Anything that reaches the boundary without a code is an internal
 * error by definition, which is what makes `INTERNAL_ERROR` meaningful.
 */
export type ErrorCode =
  | "USAGE_ERROR"
  | "MISSING_GIT_HEAD"
  | "MISSING_AGENT"
  | "MALFORMED_CREDENTIALS"
  | "PROVIDER_REJECTED"
  | "RELAY_UNAVAILABLE"
  | "SERVICE_MANAGER_FAILED"
  | "INPUT_EOF"
  | "CANCELLED"
  | "INTERNAL_ERROR";

/** Exit codes are a public compatibility surface; do not renumber them. */
const exitCodes: Readonly<Record<ErrorCode, number>> = {
  USAGE_ERROR: 2,
  MISSING_GIT_HEAD: 3,
  MISSING_AGENT: 4,
  MALFORMED_CREDENTIALS: 5,
  PROVIDER_REJECTED: 6,
  RELAY_UNAVAILABLE: 7,
  SERVICE_MANAGER_FAILED: 8,
  INPUT_EOF: 9,
  CANCELLED: 130,
  INTERNAL_ERROR: 1,
};

export function exitCodeFor(code: ErrorCode): number {
  return exitCodes[code];
}

/**
 * A failure that already knows what it is.
 *
 * The message is redacted and reduced to one line on construction, because it
 * reaches operators through several paths - terminal output, `--json`, daemon
 * logs, and persisted setup state - and each of them would otherwise have to
 * remember to sanitise it.
 */
export class AgentChannelsError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly nextSteps: readonly string[];

  constructor(
    code: ErrorCode,
    message: string,
    nextSteps: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(
      redactSensitiveText(message).split(/\r?\n/, 1)[0]?.trim() ||
        "AgentChannels failed.",
      options,
    );
    this.name = "AgentChannelsError";
    this.code = code;
    this.exitCode = exitCodes[code];
    this.nextSteps = nextSteps.map(redactSensitiveText);
  }
}

export function isAgentChannelsError(
  value: unknown,
): value is AgentChannelsError {
  return value instanceof AgentChannelsError;
}

/** The Agent, Binding, Session, or setup a command names does not exist. */
export function notFound(
  kind: "Agent" | "Binding" | "Binding setup" | "Session" | "Connector",
  id: string,
  nextSteps: readonly string[],
): AgentChannelsError {
  return new AgentChannelsError(
    kind === "Agent" ? "MISSING_AGENT" : "USAGE_ERROR",
    `${kind} ${id} not found.`,
    nextSteps,
  );
}

/**
 * The caller asked for something the current state cannot satisfy. Distinct from
 * a not-found: the object exists, the request does not apply to it.
 */
export function invalidState(
  message: string,
  nextSteps: readonly string[] = [],
  options?: ErrorOptions,
): AgentChannelsError {
  return new AgentChannelsError("USAGE_ERROR", message, nextSteps, options);
}

/**
 * An invariant this code is supposed to maintain was violated. These are bugs,
 * not operator mistakes, and surface as `INTERNAL_ERROR`.
 */
export function internalError(
  message: string,
  options?: ErrorOptions,
): AgentChannelsError {
  return new AgentChannelsError(
    "INTERNAL_ERROR",
    message,
    ["Rerun with --debug for diagnostic details."],
    options,
  );
}
