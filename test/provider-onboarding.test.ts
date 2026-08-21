import { describe, expect, it, vi } from "vitest";

import {
  LinearConnector,
  createLinearOwnedManifest,
} from "../src/connectors/linear.ts";
import {
  SlackConnector,
  createSlackAppManifest,
} from "../src/connectors/slack.ts";

describe("official provider onboarding contracts", () => {
  it.each([
    "https://localhost/v1/webhooks/linear/bd_setup",
    "https://127.0.0.1/v1/webhooks/linear/bd_setup",
    "https://10.0.0.8/v1/webhooks/linear/bd_setup",
    "https://linear.app/v1/webhooks/linear/bd_setup",
  ])("rejects a Linear webhook host the provider cannot reach: %s", (url) => {
    expect(() =>
      createLinearOwnedManifest({
        agentName: "Runbear",
        relayOrigin: new URL(url).origin,
        relayWebhookUrl: url,
      }),
    ).toThrow("publicly reachable");
  });

  it("builds Slack HTTP Events/Interactivity manifest and discovers the workspace through auth.test", async () => {
    const manifest = createSlackAppManifest({
      agentName: "Runbear",
      relayWebhookUrl:
        "https://relay.agentchannels.io/v1/webhooks/slack/bd_setup",
    });
    expect(manifest.settings).toMatchObject({
      socket_mode_enabled: false,
      event_subscriptions: {
        request_url:
          "https://relay.agentchannels.io/v1/webhooks/slack/bd_setup",
      },
      interactivity: {
        is_enabled: true,
        request_url:
          "https://relay.agentchannels.io/v1/webhooks/slack/bd_setup",
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_RUNBEAR",
            team: "Runbear",
            user_id: "U_BOT",
          }),
          { status: 200 },
        ),
    );
    const connector = new SlackConnector({ fetch: fetcher });
    const verified = await connector.verifyCredentials({
      botToken: "test-bot-token",
      signingSecret: "test-signing-secret",
    });
    expect(verified).toMatchObject({
      externalInstallationId: "T_RUNBEAR",
      externalInstallationName: "Runbear",
      credentials: { botUserId: "U_BOT" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses Linear's manifest schema and client-credentials app actor to discover the organization", async () => {
    const manifest = createLinearOwnedManifest({
      agentName: "Runbear",
      relayOrigin: "https://relay.agentchannels.io",
      relayWebhookUrl:
        "https://relay.agentchannels.io/v1/webhooks/linear/bd_setup",
    });
    expect(manifest).toMatchObject({
      schemaVersion: "1.0.0",
      distribution: "private",
      oauth: {
        grant_types: ["authorization_code", "client_credentials"],
        redirect_uris: [
          "https://relay.agentchannels.io/v1/oauth/linear/callback",
        ],
      },
      webhook: { resourceTypes: ["AgentSessionEvent"] },
    });
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/oauth/token")) {
          expect(String(init?.body)).toContain("grant_type=client_credentials");
          expect(String(init?.body)).toContain(
            "scope=read%2Cwrite%2Capp%3Amentionable%2Capp%3Aassignable",
          );
          return new Response(
            JSON.stringify({
              access_token: "app-actor-token",
              expires_in: 2591999,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: "APP_USER",
                app: true,
                organization: { id: "ORG_RUNBEAR", name: "Runbear" },
              },
            },
          }),
          { status: 200 },
        );
      },
    );
    const connector = new LinearConnector({ fetch: fetcher });
    const verified = await connector.verifyCredentials({
      clientId: "linear-client",
      clientSecret: "linear-secret",
      webhookSecret: "linear-webhook-secret",
    });
    expect(verified).toMatchObject({
      externalInstallationId: "ORG_RUNBEAR",
      externalInstallationName: "Runbear",
      credentials: {
        apiToken: "app-actor-token",
        oauthProvider: "linear-client-credentials",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
