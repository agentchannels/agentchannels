import { readFileSync } from "node:fs";

import { trimTrailingAsciiWhitespace } from "./token.ts";

export type EnrollmentPolicy =
  | Readonly<{ type: "token"; token: Buffer }>
  | Readonly<{ type: "open" }>;

export type RelayConfig = Readonly<{
  hostname: string;
  port: number;
  databasePath: string;
  enrollment: EnrollmentPolicy;
  responseBudgetMs: number;
  authenticationBudgetMs: number;
  maxRequestBodyBytes: number;
}>;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

type Environment = Readonly<Record<string, string | undefined>>;

function parseBind(value: string): { hostname: string; port: number } {
  const separator = value.lastIndexOf(":");
  const hostname = value.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  const port = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ConfigurationError(
      `AGENTCHANNELS_RELAY_BIND must be host:port, got ${value}.`,
    );
  return { hostname, port };
}

function enrollmentPolicy(environment: Environment): EnrollmentPolicy {
  const direct = environment.AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN;
  const file = environment.AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN_FILE;
  const open = environment.AGENTCHANNELS_RELAY_ALLOW_OPEN_ENROLLMENT;
  if (open !== undefined && open !== "true")
    throw new ConfigurationError(
      "AGENTCHANNELS_RELAY_ALLOW_OPEN_ENROLLMENT must be true when set.",
    );
  const configured = [direct, file, open].filter(
    (value) => value !== undefined,
  ).length;
  if (configured !== 1)
    throw new ConfigurationError(
      "Exactly one enrollment policy must be configured.",
    );
  if (open !== undefined) return { type: "open" };

  const token =
    direct === undefined
      ? trimTrailingAsciiWhitespace(readTokenFile(file ?? ""))
      : Buffer.from(direct, "utf8");
  if (token.length === 0)
    throw new ConfigurationError("The enrollment token is empty.");
  return { type: "token", token };
}

function readTokenFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ConfigurationError("The enrollment token file is unreadable.");
  }
}

export function configFromEnvironment(environment: Environment): RelayConfig {
  return {
    ...parseBind(environment.AGENTCHANNELS_RELAY_BIND ?? "127.0.0.1:8787"),
    databasePath:
      environment.AGENTCHANNELS_RELAY_DATABASE ?? "agentchannels-relay.db",
    enrollment: enrollmentPolicy(environment),
    responseBudgetMs: 2_500,
    authenticationBudgetMs: 10_000,
    maxRequestBodyBytes: 2 * 1024 * 1024,
  };
}
