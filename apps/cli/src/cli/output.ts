import type { Command } from "commander";

import { redactSensitiveText } from "../security/redact.ts";
import type { TerminalFormatter } from "./format.ts";

export type GlobalOptions = {
  json?: boolean;
  debug?: boolean;
  home?: string;
};

/**
 * The shape every command returns under `--json`.
 *
 * It was previously written out by hand at each call site, which is why the
 * schema existed nowhere in particular and drifted between commands.
 */
export type CommandResult = {
  status: "ready" | "action_required";
  actionRequired: boolean;
  nextSteps: readonly string[];
};

/** A command that completed and needs nothing from the operator. */
export function ok<Payload extends object>(
  payload: Payload,
): CommandResult & Payload {
  return { status: "ready", actionRequired: false, nextSteps: [], ...payload };
}

/** A command that completed but leaves the operator with one thing to do. */
export function needsAction<Payload extends object>(
  nextStep: string,
  payload: Payload,
): CommandResult & Payload {
  return {
    status: "action_required",
    actionRequired: true,
    nextSteps: [redactSensitiveText(nextStep)],
    ...payload,
  };
}

/** Write the machine-readable value or the human rendering, never both. */
export function emit(program: Command, value: unknown, human: string): void {
  process.stdout.write(
    program.opts<GlobalOptions>().json
      ? `${JSON.stringify(value, null, 2)}\n`
      : `${human}\n`,
  );
}

export type Column = Readonly<{ header: string; value: string }>;

/**
 * Render rows as aligned columns.
 *
 * Human listings used to be tab-joined strings, which line up only when every
 * value happens to be the same width. Width is computed from the visible text so
 * colour sequences do not skew the padding.
 */
export function renderTable(
  rows: readonly (readonly Column[])[],
  empty: string,
  formatter: TerminalFormatter,
): string {
  if (rows.length === 0) return empty;
  const headers = rows[0]?.map((column) => column.header) ?? [];
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[index]?.value ?? "").length),
    ),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        index === cells.length - 1
          ? cell
          : cell.padEnd(widths[index] ?? cell.length),
      )
      .join("  ")
      .trimEnd();
  return [
    formatter.dim(line(headers)),
    ...rows.map((row) => line(row.map((column) => column.value))),
  ].join("\n");
}
