import { createHmac, timingSafeEqual } from "node:crypto";

import {
  MalformedConnectorCredentialsError,
  ProviderRejectedError,
} from "./connector.js";
import type {
  Connector,
  ConnectorCredentials,
  ConnectorModule,
  OnboardingArtifact,
  OnboardingContext,
  PendingWebhook,
  PendingWebhookResponse,
  VerifiedConnectorCredentials,
  VerificationResult,
} from "./connector.js";
import type {
  ConnectorCommand,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../core/types.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SlackConnectorOptions = Readonly<{
  fetch?: FetchLike;
  apiBaseUrl?: string;
  replayWindowSeconds?: number;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

const DEFAULT_API_URL = "https://slack.com/api";
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

export type SlackAppManifest = Readonly<{
  display_information: Readonly<{ name: string }>;
  features: Readonly<{
    bot_user: Readonly<{ display_name: string; always_online: boolean }>;
  }>;
  oauth_config: Readonly<{ scopes: Readonly<{ bot: readonly string[] }> }>;
  settings: Readonly<{
    event_subscriptions: Readonly<{
      request_url: string;
      bot_events: readonly string[];
    }>;
    interactivity: Readonly<{ is_enabled: boolean; request_url: string }>;
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  }>;
}>;

export function createSlackAppManifest(options: {
  agentName: string;
  relayWebhookUrl: string;
}): SlackAppManifest {
  const agentName = options.agentName.trim();
  if (agentName.length < 2)
    throw new Error("Slack Agent name must contain at least two characters");
  const webhook = new URL(options.relayWebhookUrl);
  if (webhook.protocol !== "https:")
    throw new Error("Slack webhook URL must use HTTPS");
  const requestUrl = webhook.toString();
  return {
    display_information: { name: agentName },
    features: {
      bot_user: { display_name: agentName, always_online: false },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "chat:write",
          "users:read",
          "users:read.email",
          "channels:history",
          "groups:history",
          "im:history",
          "mpim:history",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
        ],
      },
      interactivity: { is_enabled: true, request_url: requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

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

function jsonBody(rawBody: Buffer): JsonObject | undefined {
  try {
    return objectValue(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return undefined;
  }
}

function hmacMatches(secret: string, base: string, signature: string): boolean {
  if (!signature.startsWith("v0=") || signature.length !== 67) return false;
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function interactionConversation(payload: JsonObject): string | undefined {
  const container = objectValue(payload.container);
  const message = objectValue(payload.message);
  const channel = objectValue(payload.channel);
  const channelId =
    stringValue(channel?.id) ?? stringValue(container?.channel_id);
  const threadTs =
    stringValue(container?.thread_ts) ??
    stringValue(message?.thread_ts) ??
    stringValue(payload.thread_ts) ??
    stringValue(message?.ts);
  return channelId && threadTs
    ? `${channelId}:${threadTs}`
    : (channelId ?? threadTs);
}

function interactionUser(payload: JsonObject): string | undefined {
  return (
    stringValue(objectValue(payload.user)?.id) ?? stringValue(payload.user_id)
  );
}

function actionValue(payload: JsonObject): string | undefined {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = objectValue(actions[0]);
  return stringValue(action?.value) ?? stringValue(action?.selected_option);
}

function encodedActionValue(value: string | undefined): JsonObject | undefined {
  if (!value) return undefined;
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseInteraction(
  payload: JsonObject,
  deliveryId: string,
): ConnectorCommand | undefined {
  const remoteConversationId = interactionConversation(payload);
  const remoteUserId = interactionUser(payload);
  if (!remoteConversationId || !remoteUserId) return undefined;

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const firstAction = objectValue(actions[0]);
  const actionId = (
    stringValue(firstAction?.action_id) ??
    stringValue(payload.callback_id) ??
    ""
  ).toLowerCase();
  const value = actionValue(payload);
  const encoded = encodedActionValue(value);
  const selectedOptions = Array.isArray(firstAction?.selected_options)
    ? firstAction.selected_options
        .map((option) =>
          encodedActionValue(stringValue(objectValue(option)?.value)),
        )
        .filter((option): option is JsonObject => option !== undefined)
    : [];
  const normalizedValue = (value ?? "").toLowerCase();
  if (
    actionId === "stop" ||
    actionId === "agentchannels_stop" ||
    actionId === "stop_session" ||
    normalizedValue === "stop" ||
    normalizedValue === "agentchannels_stop"
  ) {
    return { type: "stop", deliveryId, remoteConversationId, remoteUserId };
  }

  const interactionId =
    stringValue(firstAction?.interaction_id) ??
    stringValue(firstAction?.block_id) ??
    stringValue(encoded?.interactionId) ??
    stringValue(selectedOptions[0]?.interactionId) ??
    stringValue(payload.interaction_id) ??
    stringValue(payload.callback_id);
  if (!interactionId) return undefined;

  const selectedOption = objectValue(firstAction?.selected_option);
  const response =
    (selectedOptions.length > 0
      ? {
          questionIndex: selectedOptions[0]?.questionIndex,
          answer: selectedOptions.map((option) => option.response),
        }
      : undefined) ??
    (encoded !== undefined
      ? typeof encoded.questionIndex === "number"
        ? { questionIndex: encoded.questionIndex, answer: encoded.response }
        : encoded.response
      : undefined) ??
    selectedOption ??
    stringValue(firstAction?.selected_date) ??
    stringValue(firstAction?.selected_time) ??
    stringValue(firstAction?.value) ??
    payload.state ??
    payload.view ??
    payload.submission ??
    payload;
  return {
    type: "interaction_response",
    deliveryId,
    remoteConversationId,
    remoteUserId,
    interactionId,
    response,
  };
}

function parseFormBody(rawBody: Buffer): JsonObject | undefined {
  const params = new URLSearchParams(rawBody.toString("utf8"));
  const payload = params.get("payload");
  if (payload === null) {
    const values: Record<string, string> = {};
    for (const [key, value] of params) values[key] = value;
    return values;
  }
  try {
    return objectValue(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

export class SlackConnector implements Connector, ConnectorModule {
  readonly type = "slack" as const;
  readonly label = "Slack";
  readonly credentialFields = [
    { key: "botToken", label: "Slack Bot User OAuth Token" },
    { key: "signingSecret", label: "Slack Signing Secret" },
  ] as const;
  private readonly fetcher: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly replayWindowSeconds: number;

  constructor(options: SlackConnectorOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_URL).replace(
      /\/$/,
      "",
    );
    this.replayWindowSeconds =
      options.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  }

  createOnboardingArtifact(context: OnboardingContext): OnboardingArtifact {
    const manifest = createSlackAppManifest({
      agentName: context.agentName,
      relayWebhookUrl: context.webhookUrl,
    });
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    return {
      filename: "slack-app-manifest.json",
      content,
      copyToClipboard: true,
      actionUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
      instructions: [
        "Choose the Slack workspace, review the manifest, and create the app.",
        "Install the app to the workspace and approve the requested bot scopes.",
        "Keep this command running while Slack verifies the HTTP Events request URL.",
        "Then open OAuth & Permissions for the Bot User OAuth Token and Basic Information for the Signing Secret.",
      ],
    };
  }

  async verifyCredentials(
    credentials: Readonly<Record<string, string>>,
  ): Promise<VerifiedConnectorCredentials> {
    const token = credentials.botToken;
    const signingSecret = credentials.signingSecret;
    if (!token || !signingSecret)
      throw new MalformedConnectorCredentialsError(
        "Slack Bot Token and Signing Secret are required",
      );
    const response = await this.fetcher(`${this.apiBaseUrl}/auth.test`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await parseResponse(response);
    const workspaceId = stringValue(result.team_id);
    const botUserId = stringValue(result.user_id);
    if (!response.ok || result.ok !== true || !workspaceId || !botUserId) {
      throw new ProviderRejectedError(
        `Slack rejected the Bot Token: ${stringValue(result.error) ?? `HTTP ${String(response.status)}`}`,
      );
    }
    return {
      credentials: { ...credentials, botUserId },
      externalInstallationId: workspaceId,
      externalInstallationName:
        stringValue(result.team) ?? stringValue(result.url) ?? workspaceId,
    };
  }

  handlePendingWebhook(
    request: PendingWebhook,
  ): PendingWebhookResponse | undefined {
    if (request.connector !== this.type) return undefined;
    const body = jsonBody(Buffer.from(request.rawBodyBase64, "base64"));
    if (body?.type !== "url_verification") return undefined;
    const challenge = stringValue(body.challenge);
    if (!challenge) return { status: 400, body: "Missing challenge" };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
    };
  }

  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult {
    const secret = credentials.signingSecret ?? credentials.slackSigningSecret;
    if (!secret)
      return { ok: false, status: 500, reason: "missing Slack signing secret" };

    const timestampHeader = header(
      request.headers,
      "x-slack-request-timestamp",
    );
    const signature = header(request.headers, "x-slack-signature");
    const timestamp =
      timestampHeader === undefined ? Number.NaN : Number(timestampHeader);
    if (!Number.isInteger(timestamp) || !signature)
      return {
        ok: false,
        status: 401,
        reason: "missing Slack signature headers",
      };
    if (Math.abs(Date.now() / 1000 - timestamp) > this.replayWindowSeconds) {
      return { ok: false, status: 401, reason: "stale Slack request" };
    }
    if (
      !hmacMatches(
        secret,
        `v0:${String(timestamp)}:${request.rawBody.toString("utf8")}`,
        signature,
      )
    ) {
      return { ok: false, status: 401, reason: "invalid Slack signature" };
    }

    const contentType = (
      header(request.headers, "content-type") ?? ""
    ).toLowerCase();
    const body = contentType.includes("application/x-www-form-urlencoded")
      ? parseFormBody(request.rawBody)
      : (jsonBody(request.rawBody) ?? parseFormBody(request.rawBody));
    if (!body)
      return { ok: false, status: 400, reason: "invalid Slack payload" };

    const type = stringValue(body.type);
    const event = objectValue(body.event);
    const deliveryId =
      stringValue(body.event_id) ??
      stringValue(body.trigger_id) ??
      request.deliveryId;

    if (type === "url_verification") {
      const challenge = stringValue(body.challenge);
      if (!challenge)
        return { ok: false, status: 400, reason: "missing Slack challenge" };
      return {
        ok: true,
        response: {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: challenge,
        },
      };
    }

    if (
      type === "block_actions" ||
      type === "view_submission" ||
      type === "message_action" ||
      type === "interactive_message"
    ) {
      const command = parseInteraction(body, deliveryId);
      return {
        ok: true,
        response: { status: 200 },
        ...(command ? { command } : {}),
      };
    }

    if (event && (event.type === "app_mention" || event.type === "message")) {
      const remoteUserId = stringValue(event.user);
      const channelId = stringValue(event.channel);
      const threadTs = stringValue(event.thread_ts) ?? stringValue(event.ts);
      const remoteConversationId =
        channelId && threadTs ? `${channelId}:${threadTs}` : threadTs;
      const text = stringValue(event.text);
      const isThreadFollowUp = stringValue(event.thread_ts) !== undefined;
      const isDirectMessage = event.channel_type === "im";
      if (
        !remoteUserId ||
        !remoteConversationId ||
        !text ||
        (event.type === "message" && !isThreadFollowUp && !isDirectMessage) ||
        (event.type === "message" && /<@[A-Z0-9]+>/.test(text)) ||
        event.subtype === "message_changed" ||
        event.bot_id
      ) {
        return { ok: true };
      }
      return {
        ok: true,
        command: {
          type: "message",
          deliveryId,
          remoteConversationId,
          remoteUserId,
          text: text.replace(/<@[A-Z0-9]+>/g, "").trim(),
          allowNewSession: event.type === "app_mention" || isDirectMessage,
        },
      };
    }

    return { ok: true };
  }

  async deliver(
    message: DeliveryMessage,
    credentials: ConnectorCredentials,
  ): Promise<void> {
    const token =
      credentials.botToken ??
      credentials.accessToken ??
      credentials.slackBotToken;
    if (!token) throw new Error("missing Slack bot token");
    const metadata = objectValue(message.metadata);
    const [channel, ...threadParts] = message.remoteConversationId.split(":");
    const body: Record<string, unknown> = {
      channel: channel ?? message.remoteConversationId,
      text: message.body,
    };
    const threadTs =
      stringValue(metadata?.threadTs) ?? stringValue(metadata?.thread_ts);
    if (threadTs ?? threadParts.length > 0)
      body.thread_ts = threadTs ?? threadParts.join(":");
    if (Array.isArray(metadata?.blocks)) body.blocks = metadata.blocks;
    else if (
      message.kind === "question" ||
      message.kind === "permission" ||
      message.kind === "plan"
    ) {
      const interactionId =
        stringValue(metadata?.interactionId) ??
        stringValue(metadata?.interaction_id) ??
        "interaction";
      const options = Array.isArray(metadata?.options) ? metadata.options : [];
      const optionButtons = options.map((option, index) => {
        const parsed = objectValue(option);
        const label =
          stringValue(parsed?.label) ??
          stringValue(parsed?.value) ??
          `Option ${(index + 1).toString()}`;
        const value = stringValue(parsed?.value) ?? label;
        return {
          type: "button",
          text: { type: "plain_text", text: label },
          action_id: "agentchannels_interaction",
          value: JSON.stringify({ interactionId, response: value }),
        };
      });
      const questions = Array.isArray(metadata?.questions)
        ? metadata.questions.map((question) => objectValue(question) ?? {})
        : [];
      const questionBlocks = questions.flatMap(
        (question, questionIndex): Record<string, unknown>[] => {
          const questionText =
            stringValue(question.question) ??
            `Question ${(questionIndex + 1).toString()}`;
          const questionOptions = Array.isArray(question.options)
            ? question.options.map((option) => objectValue(option) ?? {})
            : [];
          const descriptions = questionOptions
            .map((option) => {
              const label = stringValue(option.label) ?? "Option";
              const description = stringValue(option.description);
              return description === undefined
                ? `• ${label}`
                : `• *${label}* — ${description}`;
            })
            .join("\n");
          const section = {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${questionText}*${descriptions === "" ? "\nReply in this thread with your answer." : `\n${descriptions}`}`,
            },
          };
          if (questionOptions.length === 0) return [section];
          if (question.multiSelect === true) {
            return [
              section,
              {
                type: "actions",
                block_id: interactionId,
                elements: [
                  {
                    type: "multi_static_select",
                    action_id: "agentchannels_interaction",
                    placeholder: {
                      type: "plain_text",
                      text: "Select all that apply",
                    },
                    options: questionOptions.map((option, optionIndex) => {
                      const label =
                        stringValue(option.label) ??
                        `Option ${(optionIndex + 1).toString()}`;
                      return {
                        text: { type: "plain_text", text: label },
                        value: JSON.stringify({
                          interactionId,
                          questionIndex,
                          response: label,
                        }),
                      };
                    }),
                  },
                ],
              },
            ];
          }
          return [
            section,
            {
              type: "actions",
              block_id: interactionId,
              elements: questionOptions.map((option, optionIndex) => {
                const label =
                  stringValue(option.label) ??
                  `Option ${(optionIndex + 1).toString()}`;
                return {
                  type: "button",
                  text: { type: "plain_text", text: label },
                  action_id: "agentchannels_interaction",
                  value: JSON.stringify({
                    interactionId,
                    questionIndex,
                    response: label,
                  }),
                };
              }),
            },
          ];
        },
      );
      body.blocks = [
        { type: "section", text: { type: "mrkdwn", text: message.body } },
        ...questionBlocks,
        ...(questionBlocks.length === 0 && optionButtons.length > 0
          ? [
              {
                type: "actions",
                block_id: interactionId,
                elements: optionButtons,
              },
            ]
          : []),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Stop" },
              style: "danger",
              action_id: "agentchannels_stop",
              value: "stop",
            },
          ],
        },
      ];
    }
    if (Array.isArray(metadata?.attachments))
      body.attachments = metadata.attachments;

    const response = await this.fetcher(`${this.apiBaseUrl}/chat.postMessage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const parsed = await parseResponse(response);
    if (!response.ok || parsed.ok !== true) {
      const error =
        stringValue(parsed.error) ?? `HTTP ${response.status.toString()}`;
      const retryAfter = response.headers.get("retry-after");
      throw new Error(
        `Slack chat.postMessage failed: ${error}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`,
      );
    }
  }

  async searchUsers(
    query: string,
    credentials: ConnectorCredentials,
  ): Promise<RemoteUser[]> {
    const token =
      credentials.botToken ??
      credentials.accessToken ??
      credentials.slackBotToken;
    if (!token) throw new Error("missing Slack bot token");
    const normalized = query.trim().toLocaleLowerCase();
    const results: RemoteUser[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const response = await this.fetcher(
        `${this.apiBaseUrl}/users.list?${params.toString()}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const parsed = await parseResponse(response);
      if (!response.ok || parsed.ok !== true) {
        const error =
          stringValue(parsed.error) ?? `HTTP ${response.status.toString()}`;
        const retryAfter = response.headers.get("retry-after");
        throw new Error(
          `Slack users.list failed: ${error}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`,
        );
      }
      const members = Array.isArray(parsed.members) ? parsed.members : [];
      for (const member of members) {
        const user = objectValue(member);
        const id = stringValue(user?.id);
        if (
          !id ||
          user?.deleted === true ||
          user?.is_bot === true ||
          id === "USLACKBOT"
        )
          continue;
        const profile = objectValue(user?.profile);
        const name =
          stringValue(user?.real_name) ??
          stringValue(profile?.real_name) ??
          stringValue(user?.name) ??
          id;
        const email =
          stringValue(profile?.email) ?? stringValue(user?.email) ?? null;
        if (
          !normalized ||
          `${name} ${email ?? ""}`.toLocaleLowerCase().includes(normalized)
        ) {
          results.push({ id, name, email });
        }
      }
      const next = stringValue(
        objectValue(parsed.response_metadata)?.next_cursor,
      );
      if (!next || seenCursors.has(next)) cursor = undefined;
      else {
        seenCursors.add(next);
        cursor = next;
      }
    } while (cursor);
    return results;
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

export const createSlackConnector = (
  options: SlackConnectorOptions = {},
): SlackConnector => new SlackConnector(options);

export default new SlackConnector() satisfies ConnectorModule;
