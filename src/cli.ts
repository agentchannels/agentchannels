#!/usr/bin/env node

import { normalizeCliError, renderCliError } from "./cli/errors.js";
import { createProgram } from "./cli/program.js";

const daemonIndex = process.argv.indexOf("daemon", 2);
const daemonOperation =
  daemonIndex < 0 ? undefined : process.argv[daemonIndex + 1];
const isForegroundDaemon =
  daemonIndex >= 2 &&
  !new Set(["install", "start", "stop", "status", "uninstall"]).has(
    daemonOperation ?? "",
  );
const cancel = (): void => {
  process.stdout.write("Cancelled.\n");
  process.exit(130);
};
if (!isForegroundDaemon) process.once("SIGINT", cancel);

try {
  await createProgram().exitOverride().parseAsync(process.argv);
} catch (cause) {
  const error = normalizeCliError(cause);
  const json = process.argv.includes("--json");
  const rendered = renderCliError(error, {
    json,
    debug: process.argv.includes("--debug"),
    cause,
  });
  (json ? process.stdout : process.stderr).write(rendered);
  process.exitCode = error.exitCode;
} finally {
  if (!isForegroundDaemon) process.off("SIGINT", cancel);
}
