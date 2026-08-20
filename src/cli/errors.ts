import { createTerminalFormatter, type TerminalFormatter } from "./format.js";
import {
  MalformedConnectorCredentialsError,
  ProviderRejectedError,
} from "../connectors/connector.js";
import {
  PrivilegedServiceError,
  ServiceManagerError,
  UnsupportedServicePlatformError,
} from "../service/guards.js";

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

function redactCredentialAssignments(value: string): string {
  const key = `(?:access[ _-]?token|api[ _-]?key|authorization|bearer[ _-]?token|bot[ _-]?token|client[ _-]?(?:id|secret)|cookie|credential|enrollment(?:[ _-]?(?:token|authorization))?|password|private[ _-]?key|refresh[ _-]?token|secret|signing[ _-]?secret|token|webhook[ _-]?secret)`;
  const json = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*:\s*)"(?:\\.|[^"\\])*"`,
    "gi",
  );
  const assignment = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*(?:=>|[:=]|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`,
    "gi",
  );
  return value
    .replace(json, '$1"[redacted]"')
    .replace(assignment, "$1[redacted]");
}

function redactRawBodies(value: string): string {
  const key = `(?:channel[ _-]?body|raw[ _-]?(?:channel|request)?[ _-]?body|request[ _-]?body)`;
  const object = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*(?:[:=]|\bis\b)\s*)\{(?:[^{}]|\{[^{}]*\})*\}`,
    "gi",
  );
  const json = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*:\s*)"(?:\\.|[^"\\])*"`,
    "gi",
  );
  const assignment = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*(?:[:=]|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`,
    "gi",
  );
  return value
    .replace(object, "$1[redacted raw body]")
    .replace(json, '$1"[redacted]"')
    .replace(assignment, "$1[redacted]");
}

function redactSerializedCredentialObjects(value: string): string {
  const object =
    /((?:serialized\s+)?credentials?\s*(?:[:=]|\bis\b)\s*)(\{(?:[^{}]|\{[^{}]*\})*\})/gi;
  return value.replace(object, "$1[redacted credentials]");
}

function conciseUsageMessage(value: string): string {
  const message = value.replace(/^error:\s*/i, "").trim();
  const missingArgument = /^missing required argument '([^']+)'$/i.exec(
    message,
  );
  if (missingArgument?.[1] !== undefined)
    return `Missing required argument: ${missingArgument[1]}.`;
  const missingOption = /^required option '([^']+)' not specified$/i.exec(
    message,
  );
  if (missingOption?.[1] !== undefined)
    return `Missing required option: ${missingOption[1]}.`;
  const normalized = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

/** Redact provider credentials and request material before any output path. */
export function redactSecrets(value: string): string {
  return redactRawBodies(
    redactCredentialAssignments(redactSerializedCredentialObjects(value)),
  )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted private key]",
    )
    .replace(/(?:xox[baprs]|xapp|xoxe)-[A-Za-z0-9-]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/(bearer\s+)[^\s,;}]+/gi, "$1[redacted]")
    .replace(
      /((?:"|')?(?:token|secret|authorization)(?:"|')?[ _-]*(?:query|parameter)?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    );
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly nextSteps: readonly string[];

  constructor(
    readonly code: CliErrorCode,
    message: string,
    nextSteps: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      redactSecrets(message).split(/\r?\n/, 1)[0]?.trim() ||
        "AgentChannels failed.",
      options,
    );
    this.name = "CliError";
    this.exitCode = exitCodes[code];
    this.nextSteps = nextSteps.map(redactSecrets);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { name?: unknown }).name;
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (typeof error === "string") return redactSecrets(error);
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return redactSecrets(message);
  }
  try {
    return redactSecrets(String(error));
  } catch {
    return "Unknown failure";
  }
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { cause?: unknown }).cause;
}

function errorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = errorCause(current);
  }
  return chain;
}

function findTypedError(error: unknown): unknown {
  return errorChain(error).find((candidate) => {
    const code = errorCode(candidate);
    const name = errorName(candidate);
    return (
      candidate instanceof MalformedConnectorCredentialsError ||
      candidate instanceof ProviderRejectedError ||
      candidate instanceof ServiceManagerError ||
      candidate instanceof UnsupportedServicePlatformError ||
      candidate instanceof PrivilegedServiceError ||
      code === "SERVICE_MANAGER_FAILED" ||
      code === "UNSUPPORTED_SERVICE_PLATFORM" ||
      code === "PRIVILEGED_SERVICE_OPERATION" ||
      name === "MalformedConnectorCredentialsError" ||
      name === "ProviderRejectedError" ||
      name === "ServiceManagerError" ||
      name === "UnsupportedServicePlatformError" ||
      name === "PrivilegedServiceError"
    );
  });
}

function isUsageMessage(message: string): boolean {
  return /(?:unknown (?:command|option)|missing required argument|required option|too many arguments|argument missing|invalid argument)/i.test(
    message,
  );
}

function isProviderRejectionMessage(message: string): boolean {
  return /\b(?:Slack|Linear|provider)\b[^\n]*(?:reject(?:ed|s)?|den(?:y|ied|ies)|unauthori[sz]ed|forbidden|invalid credentials?|rate limit)/i.test(
    message,
  );
}

function serviceNextStep(error: unknown): string {
  const code = errorCode(error);
  const name = errorName(error);
  if (
    code === "UNSUPPORTED_SERVICE_PLATFORM" ||
    name === "UnsupportedServicePlatformError"
  )
    return "Run agentchannels daemon in the foreground.";
  if (
    code === "PRIVILEGED_SERVICE_OPERATION" ||
    name === "PrivilegedServiceError"
  )
    return "Run agentchannels daemon install as the current user, without sudo.";
  return "Run agentchannels daemon install --debug to retry with diagnostics.";
}

export function normalizeCliError(
  error: unknown,
  options: { command?: string } = {},
): CliError {
  if (error instanceof CliError) return error;
  const message = errorMessage(error);
  const typed = findTypedError(error);
  const commanderCode =
    errorCode(error) ??
    errorChain(error)
      .map(errorCode)
      .find((value) => value);
  if (
    typed instanceof MalformedConnectorCredentialsError ||
    errorName(typed) === "MalformedConnectorCredentialsError"
  )
    return new CliError(
      "MALFORMED_CREDENTIALS",
      errorMessage(typed),
      ["Rerun agentchannels init and enter the provider-issued credentials."],
      { cause: error },
    );
  if (
    typed instanceof ProviderRejectedError ||
    errorName(typed) === "ProviderRejectedError"
  )
    return new CliError(
      "PROVIDER_REJECTED",
      errorMessage(typed),
      ["Run agentchannels init to retry this setup."],
      { cause: error },
    );
  if (typed !== undefined) {
    return new CliError(
      "SERVICE_MANAGER_FAILED",
      errorMessage(typed),
      [serviceNextStep(typed)],
      { cause: error },
    );
  }
  if (
    commanderCode?.startsWith("commander.") === true ||
    isUsageMessage(message)
  )
    return new CliError("USAGE_ERROR", conciseUsageMessage(message), [
      options.command === undefined
        ? "Run agentchannels --help to see commands and examples."
        : `Run agentchannels ${options.command} --help to see usage and examples.`,
    ]);
  if (/Git repository with a current HEAD|current HEAD/i.test(message))
    return new CliError(
      "MISSING_GIT_HEAD",
      message,
      [
        "Create the repository's first commit, then run agentchannels init again.",
      ],
      { cause: error },
    );
  if (
    /No Agents|not initialized|Agent .*not found|uniquely identify an Agent|more than one Agent|ambiguous Agent/i.test(
      message,
    )
  )
    return new CliError(
      "MISSING_AGENT",
      message,
      [
        "Run agentchannels init in the repository or pass --agent for a machine command.",
      ],
      { cause: error },
    );
  if (
    /launchctl|systemctl|service manager|background service|unsupported.*Windows|root|sudo|privileged/i.test(
      message,
    )
  )
    return new CliError(
      "SERVICE_MANAGER_FAILED",
      message,
      [
        "Fix the user service manager issue and rerun agentchannels daemon install.",
      ],
      { cause: error },
    );
  if (/Relay|enrollment|WebSocket/i.test(message))
    return new CliError(
      "RELAY_UNAVAILABLE",
      message,
      ["Retry later, then rerun agentchannels init to resume."],
      { cause: error },
    );
  if (
    /credential|bot token|signing secret|client (?:id|secret)|webhook secret|invalid JSON/i.test(
      message,
    )
  )
    return new CliError(
      "MALFORMED_CREDENTIALS",
      message,
      ["Retry the same setup and enter the provider-issued credentials."],
      { cause: error },
    );
  if (isProviderRejectionMessage(message))
    return new CliError(
      "PROVIDER_REJECTED",
      message,
      [
        "Correct the provider configuration, then rerun agentchannels init to resume.",
      ],
      { cause: error },
    );
  if (/EOF|readline was closed|input stream/i.test(message))
    return new CliError(
      "INPUT_EOF",
      "Required input ended before setup completed.",
      ["Rerun agentchannels init in a terminal to resume."],
      { cause: error },
    );
  return new CliError(
    "INTERNAL_ERROR",
    "AgentChannels hit an unexpected internal error.",
    ["Rerun with --debug for diagnostic details."],
    { cause: error },
  );
}

function renderDiagnostics(cause: unknown): string | undefined {
  const diagnostics: string[] = [];
  for (const item of errorChain(cause)) {
    if (!(item instanceof Error)) continue;
    const detail = redactSecrets(item.stack ?? item.message).trim();
    if (detail.length > 0) diagnostics.push(detail);
  }
  return diagnostics.length === 0
    ? undefined
    : diagnostics.join("\nCaused by: ");
}

export function renderCliError(
  error: CliError,
  options: {
    json: boolean;
    debug: boolean;
    cause?: unknown;
    formatter?: TerminalFormatter;
  },
): string {
  const message = redactSecrets(error.message);
  const nextSteps =
    error.code === "CANCELLED"
      ? []
      : error.nextSteps.slice(0, 1).map(redactSecrets);
  if (options.json) {
    const diagnostics = options.debug
      ? renderDiagnostics(options.cause ?? error.cause)
      : undefined;
    return `${JSON.stringify(
      {
        status: "error",
        actionRequired: true,
        nextSteps,
        error: {
          code: error.code,
          message,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        },
      },
      null,
      2,
    )}\n`;
  }
  if (error.code === "CANCELLED") return "Cancelled.\n";
  const formatter =
    options.formatter ?? createTerminalFormatter({ isTTY: false });
  const lines = [formatter.error(message)];
  if (nextSteps[0] !== undefined) lines.push(nextSteps[0]);
  if (options.debug) {
    const diagnostics = renderDiagnostics(options.cause ?? error.cause);
    if (diagnostics !== undefined) lines.push(diagnostics);
  }
  return `${lines.join("\n")}\n`;
}
