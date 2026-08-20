#!/usr/bin/env node

import { normalizeCliError, renderCliError } from "./cli/errors.js";
import { createTerminalFormatter } from "./cli/format.js";
import { hasActivePrompt, requestPromptCancellation } from "./cli/io.js";
import { createProgram } from "./cli/program.js";

function requestedCommand(
  program: ReturnType<typeof createProgram>,
): string | undefined {
  const args = process.argv.slice(2);
  const names: string[] = [];
  let commands = program.commands;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--home") {
      index += 1;
      continue;
    }
    if (value === undefined || value.startsWith("-")) continue;
    const command = commands.find((candidate) => candidate.name() === value);
    if (command === undefined) break;
    names.push(command.name());
    commands = command.commands;
  }
  return names.length === 0 ? undefined : names.join(" ");
}
const program = createProgram().exitOverride();
const isForegroundDaemon = requestedCommand(program) === "daemon";
const cancel = (): void => {
  // Inquirer installs its own SIGINT exit path. Remove it at the boundary so
  // the active prompt can unwind and restore terminal state first.
  for (const listener of process.listeners("SIGINT")) {
    if (listener !== cancel) process.removeListener("SIGINT", listener);
  }
  if (hasActivePrompt()) requestPromptCancellation();
  else {
    process.off("SIGINT", cancel);
    process.kill(process.pid, "SIGINT");
  }
};
if (!isForegroundDaemon) process.prependListener("SIGINT", cancel);

try {
  await program.parseAsync(process.argv);
} catch (cause) {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "exitCode" in cause &&
    cause.exitCode === 0
  ) {
    process.exitCode = 0;
  } else {
    const command = requestedCommand(program);
    const error = normalizeCliError(
      cause,
      command === undefined ? {} : { command },
    );
    const json = process.argv.includes("--json");
    const rendered = renderCliError(error, {
      json,
      debug: process.argv.includes("--debug"),
      cause,
      formatter: createTerminalFormatter({
        isTTY: process.stderr.isTTY === true || process.stdout.isTTY === true,
        json,
        noColor: process.env.NO_COLOR !== undefined,
        ...(process.env.TERM === undefined ? {} : { term: process.env.TERM }),
      }),
    });
    (json ? process.stdout : process.stderr).write(rendered);
    process.exitCode = error.exitCode;
  }
} finally {
  if (!isForegroundDaemon) process.off("SIGINT", cancel);
}
