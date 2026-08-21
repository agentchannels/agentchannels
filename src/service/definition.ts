import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type {
  ServiceCommand,
  ServiceDefinition,
  StableServiceCommand,
} from "./types.ts";
import { SERVICE_NAME, SERVICE_VERSION_ENV } from "./types.ts";

export function serviceName(): string {
  return SERVICE_NAME;
}

export function scopedServiceName(
  productHome: string,
  homeDirectory: string,
): string {
  if (resolve(productHome) === resolve(homeDirectory, ".agentchannels"))
    return SERVICE_NAME;
  const scope = createHash("sha256")
    .update(resolve(productHome))
    .digest("hex")
    .slice(0, 12);
  return `${SERVICE_NAME}-${scope}`;
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

/**
 * The command a service definition persists.
 *
 * launchd and systemd bake this into a unit file that outlives the process that
 * wrote it, so it must name an executable that is still there after an upgrade.
 */
export function createStableServiceCommand(
  options: {
    executable?: string;
    args?: string[];
    environment?: Record<string, string>;
  } = {},
): StableServiceCommand {
  return {
    executable: options.executable ?? "agentchannels",
    args: options.args ?? ["daemon"],
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  };
}

export function createServiceDefinition(options: {
  version: string;
  executable?: string;
  args?: string[];
  environment?: Record<string, string>;
}): ServiceDefinition {
  return {
    version: options.version,
    command: createStableServiceCommand(options),
  };
}
