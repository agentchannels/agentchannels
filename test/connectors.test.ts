import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { SlackConnector } from "../src/connectors/slack.ts";
import { LinearConnector } from "../src/connectors/linear.ts";
import type { InboundRequest } from "../src/model.ts";

function request(
  body: string,
  headers: Record<string, string>,
): InboundRequest {
  return {
    bindingId: "binding",
    deliveryId: "relay-delivery",
    timestamp: new Date(),
    rawBody: Buffer.from(body),
    headers,
  };
}

function slackRequest(
  body: string,
  secret = "slack-secret",
  contentType = "application/json",
): InboundRequest {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return request(body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
    "content-type": contentType,
  });
}

function linearRequest(body: string, secret = "linear-secret"): InboundRequest {
  const timestamp = Date.now().toString();
  return request(body, {
    "linear-timestamp": timestamp,
    "linear-delivery": "linear-delivery",
    "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
  });
}

describe("Slack connector", () => {
  it("verifies the exact body and maps app mentions and URL verification", () => {
    const connector = new SlackConnector();
    const mention = connector.verifyAndParse(
      slackRequest(
        JSON.stringify({
          event_id: "Ev1",
          event: {
            type: "app_mention",
            user: "U1",
            ts: "1.2",
            text: "<@B1> do it",
          },
        }),
      ),
      { signingSecret: "slack-secret" },
    );
    expect(mention).toMatchObject({
      ok: true,
      command: {
        type: "message",
        deliveryId: "Ev1",
        remoteConversationId: "1.2",
        text: "do it",
        allowNewSession: true,
      },
    });

    const unrelatedThread = connector.verifyAndParse(
      slackRequest(
        JSON.stringify({
          event_id: "Ev-thread",
          event: {
            type: "message",
            user: "U1",
            channel: "C1",
            thread_ts: "1.2",
            ts: "1.3",
            text: "ls",
            channel_type: "channel",
          },
        }),
      ),
      { signingSecret: "slack-secret" },
    );
    expect(unrelatedThread).toMatchObject({
      ok: true,
      command: {
        type: "message",
        remoteConversationId: "C1:1.2",
        allowNewSession: false,
      },
    });

    const challenge = connector.verifyAndParse(
      slackRequest(
        JSON.stringify({ type: "url_verification", challenge: "nonce" }),
      ),
      { signingSecret: "slack-secret" },
    );
    expect(challenge).toMatchObject({
      ok: true,
      response: { status: 200, body: "nonce" },
    });
    const signed = slackRequest('{"event": {"type":"app_mention"}}');
    expect(
      connector.verifyAndParse(
        { ...signed, rawBody: Buffer.from('{"event": {"type":"message"}}') },
        { signingSecret: "slack-secret" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("maps form-encoded stop interactions and paginates users", async () => {
    const pages = [
      {
        ok: true,
        members: [
          {
            id: "U1",
            real_name: "Alice",
            profile: { email: "alice@example.com" },
          },
        ],
        response_metadata: { next_cursor: "next" },
      },
      {
        ok: true,
        members: [
          { id: "U2", real_name: "Bob", profile: { email: "bob@example.com" } },
        ],
        response_metadata: { next_cursor: "" },
      },
    ];
    const fetcher = vi.fn((input: string | URL): Promise<Response> => {
      if (String(input).includes("users.list"))
        return Promise.resolve(
          new Response(
            JSON.stringify(
              pages[String(input).includes("cursor=next") ? 1 : 0],
            ),
            { status: 200 },
          ),
        );
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    });
    const connector = new SlackConnector({ fetch: fetcher });
    const body =
      "payload=" +
      encodeURIComponent(
        JSON.stringify({
          type: "block_actions",
          user: { id: "U1" },
          channel: { id: "C1" },
          message: { ts: "2.3" },
          actions: [{ action_id: "agentchannels_stop", value: "stop" }],
        }),
      );
    const parsed = connector.verifyAndParse(
      slackRequest(body, "slack-secret", "application/x-www-form-urlencoded"),
      { signingSecret: "slack-secret" },
    );
    expect(parsed).toMatchObject({
      ok: true,
      command: { type: "stop", remoteConversationId: "C1:2.3" },
    });
    const users = await connector.searchUsers("alice", {
      botToken: "xoxb-token",
    });
    expect(users).toEqual([
      { id: "U1", name: "Alice", email: "alice@example.com" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Linear connector", () => {
  it("verifies raw-body signatures and maps created, prompted, and stop events", () => {
    const connector = new LinearConnector();
    const created = connector.verifyAndParse(
      linearRequest(
        JSON.stringify({
          action: "created",
          agentSession: { id: "S1", issue: { title: "Fix it" } },
          actor: { id: "U1" },
        }),
      ),
      { webhookSecret: "linear-secret" },
    );
    expect(created).toMatchObject({
      ok: true,
      command: { type: "message", remoteConversationId: "S1", text: "Fix it" },
    });
    const stopped = connector.verifyAndParse(
      linearRequest(
        JSON.stringify({
          action: "prompted",
          agentSession: { id: "S1" },
          agentActivity: { body: "stop", signal: "stop", actor: { id: "U1" } },
        }),
      ),
      { webhookSecret: "linear-secret" },
    );
    expect(stopped).toMatchObject({
      ok: true,
      command: { type: "stop", remoteConversationId: "S1" },
    });
  });

  it("delivers through GraphQL and reports API failures", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(
      (_input: string | URL, init?: RequestInit): Promise<Response> => {
        requestInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                agentActivityCreate: {
                  success: true,
                  agentActivity: { id: "A1" },
                },
              },
            }),
            { status: 200 },
          ),
        );
      },
    );
    const connector = new LinearConnector({ fetch: fetcher });
    await connector.deliver(
      { kind: "final", remoteConversationId: "S1", body: "done" },
      { apiToken: "lin-token" },
    );
    if (typeof requestInit?.body !== "string")
      throw new Error("expected JSON request body");
    expect(JSON.parse(requestInit.body)).toMatchObject({
      variables: {
        input: {
          agentSessionId: "S1",
          content: { type: "response", body: "done" },
        },
      },
    });
  });
});

describe("onboarding artifacts", () => {
  it("returns manifests and admin action URLs without creating apps", () => {
    const slackArtifact = new SlackConnector().createOnboardingArtifact({
      agentName: "Runbear",
      relayOrigin: "https://relay.example",
      webhookUrl: "https://relay.example/hooks",
    });
    const slackManifest = JSON.parse(slackArtifact.content) as {
      settings: { socket_mode_enabled: boolean };
    };
    expect(slackManifest.settings.socket_mode_enabled).toBe(false);
    expect(slackArtifact.actionUrl).toContain("manifest_json=");
    const linearArtifact = new LinearConnector().createOnboardingArtifact({
      agentName: "Runbear",
      relayOrigin: "https://relay.example",
      webhookUrl: "https://relay.example/hooks",
    });
    const linearManifest = JSON.parse(linearArtifact.content) as {
      webhook: { resourceTypes: string[] };
    };
    expect(linearManifest.webhook.resourceTypes).toEqual(["AgentSessionEvent"]);
    expect(linearArtifact.actionUrl).toContain("manifest=");
  });
});
