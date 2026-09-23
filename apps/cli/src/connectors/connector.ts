import { AgentChannelsError } from "../errors.ts";
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
