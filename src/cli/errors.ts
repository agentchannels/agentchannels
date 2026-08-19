export type CliErrorCode =
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

const exitCodes: Readonly<Record<CliErrorCode, number>> = {
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

export class CliError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly nextSteps: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
    this.exitCode = exitCodes[code];
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /((?:client|signing|webhook|enrollment)[ _-]?(?:secret|token)["'=:\s]+)[^\s,;}]+/gi,
      "$1[redacted]",
    );
}

export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
  );
  if (
    /commander\.|unknown (?:command|option)|required option|too many arguments/i.test(
      message,
    )
  )
    return new CliError("USAGE_ERROR", message, ["Run agentchannels --help."]);
  if (/Git repository with a current HEAD|current HEAD/i.test(message))
    return new CliError("MISSING_GIT_HEAD", message, [
      "Create the repository's first commit, then run agentchannels init again.",
    ]);
  if (
    /No Agents|not initialized|Agent .*not found|uniquely identify an Agent/i.test(
      message,
    )
  )
    return new CliError("MISSING_AGENT", message, [
      "Run agentchannels init in the repository or pass --agent for a machine command.",
    ]);
  if (
    /credential|Bot Token|Signing Secret|Client ID|Client Secret|JSON/i.test(
      message,
    )
  )
    return new CliError("MALFORMED_CREDENTIALS", message, [
      "Retry the same setup and enter the provider-issued credentials.",
    ]);
  if (/Slack|Linear|provider/i.test(message))
    return new CliError("PROVIDER_REJECTED", message, [
      "Correct the provider configuration, then rerun agentchannels init to resume.",
    ]);
  if (/Relay|enrollment|WebSocket/i.test(message))
    return new CliError("RELAY_UNAVAILABLE", message, [
      "Retry later, or explicitly select a self-hosted Relay with agentchannels relay use.",
    ]);
  if (
    /launchctl|systemctl|service manager|background service|unsupported.*Windows/i.test(
      message,
    )
  )
    return new CliError("SERVICE_MANAGER_FAILED", message, [
      "Fix the user service manager issue and rerun agentchannels daemon install.",
    ]);
  if (/EOF|readline was closed|input stream/i.test(message))
    return new CliError(
      "INPUT_EOF",
      "Required input ended before setup completed.",
      ["Rerun agentchannels init in a terminal to resume."],
    );
  return new CliError(
    "INTERNAL_ERROR",
    message,
    ["Rerun with --debug for diagnostic details."],
    { cause: error },
  );
}

export function renderCliError(
  error: CliError,
  options: { json: boolean; debug: boolean; cause?: unknown },
): string {
  if (options.json) {
    return `${JSON.stringify(
      {
        status: "error",
        actionRequired: true,
        nextSteps: error.nextSteps,
        error: { code: error.code, message: error.message },
      },
      null,
      2,
    )}\n`;
  }
  const lines = [`${error.message}`, `Next: ${error.nextSteps[0] ?? "Retry."}`];
  if (options.debug && options.cause instanceof Error) {
    lines.push(redactSecrets(options.cause.stack ?? options.cause.message));
  }
  return `${lines.join("\n")}\n`;
}
