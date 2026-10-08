import { errorChain } from "../error-chain.ts";
import { AgentChannelsError, isAgentChannelsError } from "../errors.ts";
import { redactSensitiveText } from "../security/redact.ts";
import { createTerminalFormatter, type TerminalFormatter } from "./format.ts";

/** Commander reports argument problems in prose; make them one short sentence. */
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

/** Commander is the one external library allowed to classify its own failures. */
function commanderMessage(error: unknown): string | undefined {
  for (const candidate of errorChain(error)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const code = (candidate as { code?: unknown }).code;
    const message = (candidate as { message?: unknown }).message;
    if (typeof code === "string" && code.startsWith("commander."))
      return typeof message === "string" ? message : "Invalid arguments.";
  }
  return undefined;
}

/**
 * Resolve any thrown value to a classified failure.
 *
 * Classification is a lookup, not an inspection of message text: a failure is
 * whatever its thrower declared it to be. Anything arriving here unclassified is
 * a defect in this program rather than an operator mistake, and says so.
 */
export function classifyError(
  error: unknown,
  options: { command?: string } = {},
): AgentChannelsError {
  const declared = errorChain(error).find(isAgentChannelsError);
  if (declared !== undefined) return declared;

  const usage = commanderMessage(error);
  if (usage !== undefined)
    return new AgentChannelsError(
      "USAGE_ERROR",
      conciseUsageMessage(usage),
      [
        options.command === undefined
          ? "Run agentchannels --help to see commands and examples."
          : `Run agentchannels ${options.command} --help to see usage and examples.`,
      ],
      { cause: error },
    );

  return new AgentChannelsError(
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
    const detail = redactSensitiveText(item.stack ?? item.message).trim();
    if (detail.length > 0) diagnostics.push(detail);
  }
  return diagnostics.length === 0
    ? undefined
    : diagnostics.join("\nCaused by: ");
}

export function renderError(
  error: AgentChannelsError,
  options: {
    json: boolean;
    debug: boolean;
    cause?: unknown;
    formatter?: TerminalFormatter;
  },
): string {
  const message = redactSensitiveText(error.message);
  const nextSteps =
    error.code === "CANCELLED"
      ? []
      : error.nextSteps.slice(0, 1).map(redactSensitiveText);
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
