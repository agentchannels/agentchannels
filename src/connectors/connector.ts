import { readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentChannelsError, internalError } from "../errors.ts";
import type {
  ConnectorCommand,
  ConnectorType,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../model.ts";

export type VerificationResult =
  | {
      ok: true;
      response?: {
        status: number;
        headers?: Record<string, string>;
        body?: string;
      };
      command?: ConnectorCommand;
    }
  | { ok: false; status: number; reason: string };

export type ConnectorCredentials = Readonly<Record<string, string>>;

export class MalformedConnectorCredentialsError extends AgentChannelsError {
  constructor(message: string) {
    super("MALFORMED_CREDENTIALS", message, [
      "Rerun agentchannels init and enter the provider-issued credentials.",
    ]);
    this.name = "MalformedConnectorCredentialsError";
  }
}

export class ProviderRejectedError extends AgentChannelsError {
  constructor(message: string) {
    super("PROVIDER_REJECTED", message, [
      "Correct the provider configuration, then rerun agentchannels init to resume.",
    ]);
    this.name = "ProviderRejectedError";
  }
}

export type Connector = {
  readonly type: ConnectorType;
  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult;
  deliver(
    message: DeliveryMessage,
    credentials: ConnectorCredentials,
  ): Promise<void>;
  searchUsers(
    query: string,
    credentials: ConnectorCredentials,
  ): Promise<RemoteUser[]>;
  handlePendingWebhook?(
    request: PendingWebhook,
  ): PendingWebhookResponse | undefined;
};

export type CredentialField = Readonly<{ key: string; label: string }>;

export type OnboardingContext = Readonly<{
  agentName: string;
  relayOrigin: string;
  webhookUrl: string;
}>;

export type OnboardingArtifact = Readonly<{
  filename: string;
  content: string;
  copyToClipboard: boolean;
  actionUrl: string;
  instructions: readonly string[];
}>;

export type VerifiedConnectorCredentials = Readonly<{
  credentials: Readonly<Record<string, string>>;
  externalInstallationId: string;
  externalInstallationName: string;
}>;

export type PendingWebhook = Readonly<{
  connector: ConnectorType;
  rawBodyBase64: string;
}>;

export type PendingWebhookResponse = Readonly<{
  status: number;
  headers?: Record<string, string>;
  body?: string;
}>;

export type ConnectorModule = Connector & {
  readonly label: string;
  readonly credentialFields: readonly CredentialField[];
  createOnboardingArtifact(context: OnboardingContext): OnboardingArtifact;
  verifyCredentials(
    credentials: Readonly<Record<string, string>>,
  ): Promise<VerifiedConnectorCredentials>;
  handlePendingWebhook?(
    request: PendingWebhook,
  ): PendingWebhookResponse | undefined;
};

function isConnectorModule(value: unknown): value is ConnectorModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ConnectorModule>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.label === "string" &&
    Array.isArray(candidate.credentialFields) &&
    typeof candidate.createOnboardingArtifact === "function" &&
    typeof candidate.verifyCredentials === "function" &&
    typeof candidate.verifyAndParse === "function" &&
    typeof candidate.deliver === "function" &&
    typeof candidate.searchUsers === "function"
  );
}

/** Provider files default-export a module; discovery keeps shared flows connector-name neutral. */
export async function loadConnectorModules(): Promise<
  ReadonlyMap<ConnectorType, ConnectorModule>
> {
  const current = fileURLToPath(import.meta.url);
  const directory = dirname(current);
  const modules = new Map<ConnectorType, ConnectorModule>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name);
    if (extension !== ".js" && extension !== ".ts") continue;
    const path = join(directory, entry.name);
    if (path === current || entry.name.endsWith(".d.ts")) continue;
    const imported = (await import(pathToFileURL(path).href)) as {
      default?: unknown;
    };
    if (!isConnectorModule(imported.default)) continue;
    const connector = imported.default;
    if (modules.has(connector.type))
      throw internalError(`Duplicate connector module ${connector.type}.`);
    modules.set(connector.type, connector);
  }
  if (modules.size === 0)
    throw internalError("No connector modules are available.");
  return modules;
}
