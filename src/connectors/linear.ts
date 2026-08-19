import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  Connector,
  ConnectorCredentials,
  VerificationResult,
} from "./connector.js";
import type {
  ConnectorCommand,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../core/types.js";

export type LinearFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LinearConnectorOptions = Readonly<{
  fetch?: LinearFetchLike;
  apiUrl?: string;
  replayWindowMilliseconds?: number;
}>;

type JsonObject = Readonly<Record<string, unknown>>;
const DEFAULT_API_URL = "https://api.linear.app/graphql";
const DEFAULT_REPLAY_WINDOW_MS = 60_000;

function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === wanted,
  )?.[1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseBody(rawBody: Buffer): JsonObject | undefined {
  try {
    return objectValue(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return undefined;
  }
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

export class LinearConnector implements Connector {
  readonly type = "linear" as const;
  private readonly fetcher: LinearFetchLike;
  private readonly apiUrl: string;
  private readonly replayWindowMilliseconds: number;

  constructor(options: LinearConnectorOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.replayWindowMilliseconds =
      options.replayWindowMilliseconds ?? DEFAULT_REPLAY_WINDOW_MS;
  }

  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult {
    const secret =
      credentials.webhookSecret ??
      credentials.linearWebhookSecret ??
      credentials.signingSecret;
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
    const body = parseBody(request.rawBody);
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
    const token =
      credentials.apiToken ??
      credentials.accessToken ??
      credentials.linearApiToken;
    if (!token) throw new Error("missing Linear API token");
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
      throw new Error("Linear agentActivityCreate failed");
  }

  async searchUsers(
    query: string,
    credentials: ConnectorCredentials,
  ): Promise<RemoteUser[]> {
    const token =
      credentials.apiToken ??
      credentials.accessToken ??
      credentials.linearApiToken;
    if (!token) throw new Error("missing Linear API token");
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
    const parsed = await parseResponse(response);
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    if (!response.ok || errors.length > 0) {
      const first = objectValue(errors[0]);
      const message =
        stringValue(first?.message) ?? `HTTP ${String(response.status)}`;
      const retryAfter = response.headers.get("retry-after");
      throw new Error(
        `Linear GraphQL request failed: ${message}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`,
      );
    }
    return objectValue(parsed.data) ?? {};
  }
}

async function parseResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();
  try {
    return objectValue(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

export const createLinearConnector = (
  options: LinearConnectorOptions = {},
): LinearConnector => new LinearConnector(options);
