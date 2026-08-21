import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  MalformedConnectorCredentialsError,
  ProviderRejectedError,
} from "./connector.ts";
import {
  header,
  jsonObjectBody,
  objectValue,
  parseJsonResponse,
  providerFailure,
  stringValue,
  type FetchLike,
  type JsonObject,
} from "./http.ts";
import type {
  Connector,
  ConnectorCredentials,
  ConnectorModule,
  OnboardingArtifact,
  OnboardingContext,
  VerifiedConnectorCredentials,
  VerificationResult,
} from "./connector.ts";
import type {
  ConnectorCommand,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../model.ts";

export type LinearConnectorOptions = Readonly<{
  fetch?: FetchLike;
  apiUrl?: string;
  oauthTokenUrl?: string;
  replayWindowMilliseconds?: number;
}>;

const DEFAULT_API_URL = "https://api.linear.app/graphql";
const DEFAULT_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const DEFAULT_REPLAY_WINDOW_MS = 60_000;

function isPrivateLinearWebhookHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "linear.app" ||
    host.endsWith(".linear.app")
  )
    return true;
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return (
    version === 6 &&
    (host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb"))
  );
}

export type LinearAppManifest = Readonly<{
  $schema: "https://linear.app/.well-known/oauth-app-manifest.schema.json";
  schemaVersion: "1.0.0";
  distribution: "private";
  display: Readonly<{ description: string }>;
  developer: Readonly<{ name: string }>;
  oauth: Readonly<{
    client_name: string;
    client_uri: string;
    redirect_uris: readonly string[];
    grant_types: readonly ["authorization_code", "client_credentials"];
  }>;
  webhook: Readonly<{
    enabled: true;
    url: string;
    resourceTypes: readonly ["AgentSessionEvent"];
  }>;
}>;

export function createLinearOwnedManifest(options: {
  agentName: string;
  relayOrigin: string;
  relayWebhookUrl: string;
}): LinearAppManifest {
  const agentName = options.agentName.trim();
  if (agentName.length < 2)
    throw new MalformedConnectorCredentialsError(
      "Linear Agent name must contain at least two characters.",
    );
  if (/linear/i.test(agentName))
    throw new MalformedConnectorCredentialsError(
      "Linear application names must not contain “Linear”.",
    );
  const origin = new URL(options.relayOrigin).origin;
  const webhook = new URL(options.relayWebhookUrl);
  if (webhook.protocol !== "https:")
    throw new MalformedConnectorCredentialsError(
      "Linear webhook URL must use HTTPS.",
    );
  if (isPrivateLinearWebhookHost(webhook.hostname))
    throw new MalformedConnectorCredentialsError(
      "Linear webhook URL must use a publicly reachable non-Linear host.",
    );
  return {
    $schema: "https://linear.app/.well-known/oauth-app-manifest.schema.json",
    schemaVersion: "1.0.0",
    distribution: "private",
    display: { description: `${agentName} local coding agent` },
    developer: { name: "AgentChannels" },
    oauth: {
      client_name: agentName,
      client_uri: "https://github.com/agentchannels/agentchannels",
      redirect_uris: [new URL("/v1/oauth/linear/callback", origin).toString()],
      grant_types: ["authorization_code", "client_credentials"],
    },
    webhook: {
      enabled: true,
      url: webhook.toString(),
      resourceTypes: ["AgentSessionEvent"],
    },
  };
}

function hmacMatches(
  secret: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function eventSession(body: JsonObject): JsonObject | undefined {
  return objectValue(body.agentSession) ?? objectValue(body.agent_session);
}

function eventActor(
  body: JsonObject,
  activity: JsonObject | undefined,
  session: JsonObject | undefined,
): string | undefined {
  return (
    stringValue(objectValue(activity?.actor)?.id) ??
    stringValue(objectValue(activity?.user)?.id) ??
    stringValue(activity?.userId) ??
    stringValue(activity?.creatorId) ??
    stringValue(objectValue(body.actor)?.id) ??
    stringValue(session?.creatorId) ??
    stringValue(objectValue(session?.user)?.id) ??
    stringValue(objectValue(session?.creator)?.id)
  );
}

function promptText(
  body: JsonObject,
  action: string,
  activity: JsonObject | undefined,
  session: JsonObject | undefined,
): string | undefined {
  if (action === "prompted")
    return (
      stringValue(activity?.body) ??
      stringValue(objectValue(activity?.content)?.body) ??
      stringValue(activity?.content)
    );
  return (
    stringValue(body.promptContext) ??
    stringValue(body.prompt_context) ??
    stringValue(objectValue(session?.comment)?.body) ??
    stringValue(objectValue(session?.issue)?.description) ??
    stringValue(objectValue(session?.issue)?.title)
  );
}

function agentCommand(
  body: JsonObject,
  deliveryId: string,
): ConnectorCommand | undefined {
  const action = (stringValue(body.action) ?? "").toLowerCase();
  if (action !== "created" && action !== "prompted") return undefined;
  const session = eventSession(body);
  const activity =
    objectValue(body.agentActivity) ?? objectValue(body.agent_activity);
  const remoteConversationId =
    stringValue(session?.id) ??
    stringValue(body.agentSessionId) ??
    stringValue(body.agent_session_id);
  const remoteUserId = eventActor(body, activity, session);
  if (!remoteConversationId || !remoteUserId) return undefined;

  const signal = stringValue(activity?.signal)?.toLowerCase();
  if (action === "prompted" && signal === "stop") {
    return { type: "stop", deliveryId, remoteConversationId, remoteUserId };
  }
  const text = promptText(body, action, activity, session);
  if (!text) return undefined;
  return {
    type: "message",
    deliveryId,
    remoteConversationId,
    remoteUserId,
    text,
  };
}

function contentFor(message: DeliveryMessage): JsonObject {
  const metadata = objectValue(message.metadata);
  const type =
    message.kind === "final" || message.kind === "stopped"
      ? "response"
      : message.kind === "error"
        ? "error"
        : message.kind === "question" ||
            message.kind === "permission" ||
            message.kind === "plan"
          ? "elicitation"
          : "thought";
  return {
    type,
    body: message.body,
    ...(metadata?.action ? { action: metadata.action } : {}),
  };
}

export class LinearConnector implements Connector, ConnectorModule {
  readonly type = "linear" as const;
  readonly label = "Linear";
  readonly credentialFields = [
    { key: "clientId", label: "Linear Client ID" },
    { key: "clientSecret", label: "Linear Client Secret" },
    { key: "webhookSecret", label: "Linear Webhook Signing Secret" },
  ] as const;
  private readonly fetcher: FetchLike;
  private readonly apiUrl: string;
  private readonly oauthTokenUrl: string;
  private readonly replayWindowMilliseconds: number;

  constructor(options: LinearConnectorOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.oauthTokenUrl = options.oauthTokenUrl ?? DEFAULT_OAUTH_TOKEN_URL;
    this.replayWindowMilliseconds =
      options.replayWindowMilliseconds ?? DEFAULT_REPLAY_WINDOW_MS;
  }

  createOnboardingArtifact(context: OnboardingContext): OnboardingArtifact {
    const manifest = createLinearOwnedManifest({
      agentName: context.agentName,
      relayOrigin: context.relayOrigin,
      relayWebhookUrl: context.webhookUrl,
    });
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    return {
      filename: "linear-oauth-app-manifest.json",
      content,
      copyToClipboard: false,
      actionUrl: `https://linear.app/settings/api/applications/new?manifest=${encodeURIComponent(JSON.stringify(manifest))}`,
      instructions: [
        "Create the prefilled private OAuth application as a Linear workspace administrator.",
        "Keep Client credentials tokens enabled; the manifest requests authorization_code because Linear requires it and client_credentials for the app-actor token.",
        "Enable the Agent session events webhook shown in the manifest.",
        "Then copy the Client ID, Client Secret, and Webhook Signing Secret from the application settings.",
      ],
    };
  }

  async verifyCredentials(
    credentials: Readonly<Record<string, string>>,
  ): Promise<VerifiedConnectorCredentials> {
    const clientId = credentials.clientId;
    const clientSecret = credentials.clientSecret;
    const webhookSecret = credentials.webhookSecret;
    if (!webhookSecret)
      throw new MalformedConnectorCredentialsError(
        "Linear Webhook Signing Secret is required",
      );
    let apiToken = credentials.apiToken;
    let expiresAt = credentials.expiresAt;
    let oauthProvider = credentials.oauthProvider;
    if (!apiToken) {
      if (!clientId || !clientSecret)
        throw new MalformedConnectorCredentialsError(
          "Linear Client ID and Client Secret are required when no app-actor token is supplied",
        );
      const tokenResponse = await this.fetcher(this.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "read,write,app:mentionable,app:assignable",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const tokenResult = await parseJsonResponse(tokenResponse);
      apiToken = stringValue(tokenResult.access_token);
      if (!tokenResponse.ok || !apiToken) {
        throw new ProviderRejectedError(
          `Linear rejected the client credentials: ${stringValue(tokenResult.error_description) ?? stringValue(tokenResult.error) ?? `HTTP ${String(tokenResponse.status)}`}`,
        );
      }
      const expiresIn =
        typeof tokenResult.expires_in === "number"
          ? tokenResult.expires_in
          : 30 * 24 * 60 * 60;
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      oauthProvider = "linear-client-credentials";
    }
    const data = await this.graphql(
      `query BindingIdentity {
        viewer { id app organization { id name } }
      }`,
      {},
      apiToken,
    );
    const viewer = objectValue(data.viewer);
    const organization = objectValue(viewer?.organization);
    const organizationId = stringValue(organization?.id);
    if (viewer?.app !== true || !organizationId) {
      throw new ProviderRejectedError(
        "Linear did not return an app actor and organization for these credentials",
      );
    }
    return {
      credentials: {
        ...credentials,
        apiToken,
        ...(oauthProvider === undefined ? {} : { oauthProvider }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
      externalInstallationId: organizationId,
      externalInstallationName:
        stringValue(organization?.name) ?? organizationId,
    };
  }

  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult {
    const secret = credentials.webhookSecret;
    if (!secret)
      return {
        ok: false,
        status: 500,
        reason: "missing Linear webhook secret",
      };
    const signature = header(request.headers, "linear-signature");
    if (!signature || !hmacMatches(secret, request.rawBody, signature)) {
      return { ok: false, status: 401, reason: "invalid Linear signature" };
    }
    const body = jsonObjectBody(request.rawBody);
    if (!body)
      return { ok: false, status: 400, reason: "invalid Linear payload" };
    const timestampValue = body.webhookTimestamp;
    const timestampRaw =
      header(request.headers, "linear-timestamp") ??
      (typeof timestampValue === "number" || typeof timestampValue === "string"
        ? String(timestampValue)
        : "");
    const timestamp = Number(timestampRaw);
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() - timestamp) > this.replayWindowMilliseconds
    ) {
      return { ok: false, status: 401, reason: "stale Linear webhook" };
    }
    const deliveryId =
      header(request.headers, "linear-delivery") ??
      stringValue(body.id) ??
      request.deliveryId;
    const command = agentCommand(body, deliveryId);
    return {
      ok: true,
      response: { status: 200 },
      ...(command ? { command } : {}),
    };
  }

  async deliver(
    message: DeliveryMessage,
    credentials: ConnectorCredentials,
  ): Promise<void> {
    const token = credentials.apiToken;
    if (!token)
      throw new MalformedConnectorCredentialsError(
        "Linear API token is missing.",
      );
    const metadata = objectValue(message.metadata);
    const content = contentFor(message);
    const input: Record<string, unknown> = {
      agentSessionId: message.remoteConversationId,
      content,
    };
    const signal = stringValue(metadata?.signal);
    if (signal) input.signal = signal;
    if (metadata?.signalMetadata !== undefined)
      input.signalMetadata = metadata.signalMetadata;
    const result = await this.graphql(
      `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success agentActivity { id } }
      }`,
      { input },
      token,
    );
    const operation = objectValue(result.agentActivityCreate);
    if (operation?.success !== true)
      throw new ProviderRejectedError("Linear agentActivityCreate failed.");
  }

  async searchUsers(
    query: string,
    credentials: ConnectorCredentials,
  ): Promise<RemoteUser[]> {
    const token = credentials.apiToken;
    if (!token)
      throw new MalformedConnectorCredentialsError(
        "Linear API token is missing.",
      );
    const normalized = query.trim().toLocaleLowerCase();
    const users: RemoteUser[] = [];
    let after: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const result = await this.graphql(
        `query Users($after: String) {
          users(first: 100, after: $after) {
            nodes { id name email }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
        token,
      );
      const connection = objectValue(result.users);
      const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
      for (const node of nodes) {
        const user = objectValue(node);
        const id = stringValue(user?.id);
        if (!id) continue;
        const name =
          stringValue(user?.name) ?? stringValue(user?.displayName) ?? id;
        const email = stringValue(user?.email) ?? null;
        if (
          !normalized ||
          `${name} ${email ?? ""}`.toLocaleLowerCase().includes(normalized)
        )
          users.push({ id, name, email });
      }
      const pageInfo = objectValue(connection?.pageInfo);
      const next = stringValue(pageInfo?.endCursor);
      if (pageInfo?.hasNextPage !== true || !next || seenCursors.has(next))
        after = null;
      else {
        seenCursors.add(next);
        after = next;
      }
    } while (after !== null);
    return users;
  }

  private async graphql(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    token: string,
  ): Promise<JsonObject> {
    const response = await this.fetcher(this.apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const parsed = await parseJsonResponse(response);
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    if (!response.ok || errors.length > 0) {
      throw new ProviderRejectedError(
        providerFailure(
          "Linear GraphQL request",
          response,
          stringValue(objectValue(errors[0])?.message),
        ),
      );
    }
    return objectValue(parsed.data) ?? {};
  }
}

export default new LinearConnector() satisfies ConnectorModule;
