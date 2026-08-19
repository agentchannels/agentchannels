import { join } from "node:path";
import type { ServiceCommand, ServiceDefinition } from "./types.js";
import { SERVICE_NAME, SERVICE_VERSION_ENV } from "./types.js";

export function serviceName(): string {
  return SERVICE_NAME;
}

export function commandEnvironment(
  command: ServiceCommand,
  version: string,
): Record<string, string> {
  return {
    ...(command.environment ?? {}),
    [SERVICE_VERSION_ENV]: version,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function logDirectory(
  definition: ServiceDefinition,
): string | undefined {
  const home = definition.command.environment?.AGENTCHANNELS_HOME;
  return home === undefined ? undefined : join(home, "logs");
}
