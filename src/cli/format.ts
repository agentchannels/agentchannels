export type TerminalFormatterContext = Readonly<{
  /** Whether output is going to an interactive terminal. */
  isTTY: boolean;
  /** Machine-readable output never contains terminal control sequences. */
  json?: boolean;
  /** The presence of NO_COLOR disables terminal control sequences. */
  noColor?: boolean;
  /** TERM=dumb disables terminal control sequences. */
  term?: string;
}>;

export type TerminalFormatter = Readonly<{
  colorEnabled: boolean;
  success(value: string): string;
  pending(value: string): string;
  error(value: string): string;
  dim(value: string): string;
}>;

const ANSI = {
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
} as const;

function wrap(enabled: boolean, code: string, value: string): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

/**
 * Build the one terminal formatter used by human CLI renderers.
 *
 * Keeping the decision here means JSON, logs, and injected non-TTY tests can
 * never accidentally inherit ANSI sequences from an individual command.
 */
export function createTerminalFormatter(
  context: TerminalFormatterContext,
): TerminalFormatter {
  const colorEnabled =
    context.isTTY &&
    context.json !== true &&
    context.noColor !== true &&
    context.term !== "dumb";
  return {
    colorEnabled,
    success: (value) => `${wrap(colorEnabled, ANSI.green, "✓")} ${value}`,
    pending: (value) => `${wrap(colorEnabled, ANSI.yellow, "!")} ${value}`,
    error: (value) => wrap(colorEnabled, ANSI.red, `Error: ${value}`),
    dim: (value) => wrap(colorEnabled, ANSI.dim, value),
  };
}

export const plainTerminalFormatter = createTerminalFormatter({
  isTTY: false,
});
