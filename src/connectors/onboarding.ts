export type ActionRequired = Readonly<{
  status: "action_required";
  action: "open_url";
  url: string;
  reason: "workspace_admin_approval";
}>;

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

export type OnboardingConfiguration = Readonly<{
  manifest: SlackAppManifest | LinearAppManifest;
  actionRequired: ActionRequired;
}>;

export type SlackManifestOptions = Readonly<{
  agentName: string;
  relayWebhookUrl: string;
}>;

export type LinearManifestOptions = Readonly<{
  agentName: string;
  clientUri: string;
  redirectUri: string;
  relayWebhookUrl: string;
  developerName?: string;
}>;

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2)
    throw new Error(`${label} must contain at least two characters`);
  return trimmed;
}

function requiredUrl(
  value: string,
  label: string,
  protocol: "https" | "http-or-https" = "https",
): string {
  const parsed = new URL(value);
  if (
    (protocol === "https" && parsed.protocol !== "https:") ||
    (protocol === "http-or-https" &&
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:")
  ) {
    throw new Error(
      `${label} must use ${protocol === "https" ? "HTTPS" : "HTTP or HTTPS"}`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export function createSlackAppManifest(
  options: SlackManifestOptions,
): SlackAppManifest {
  const agentName = requiredText(options.agentName, "agentName");
  const relayWebhookUrl = requiredUrl(
    options.relayWebhookUrl,
    "relayWebhookUrl",
  );
  return {
    display_information: { name: agentName },
    features: { bot_user: { display_name: agentName, always_online: false } },
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
        request_url: relayWebhookUrl,
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
        ],
      },
      interactivity: { is_enabled: true, request_url: relayWebhookUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function createLinearAppManifest(
  options: LinearManifestOptions,
): LinearAppManifest {
  const agentName = requiredText(options.agentName, "agentName");
  if (/linear/i.test(agentName))
    throw new Error("Linear application names must not contain “Linear”");
  const clientUri = requiredUrl(
    options.clientUri,
    "clientUri",
    "http-or-https",
  );
  const redirectUri = requiredUrl(
    options.redirectUri,
    "redirectUri",
    "http-or-https",
  );
  const relayWebhookUrl = requiredUrl(
    options.relayWebhookUrl,
    "relayWebhookUrl",
  );
  const developerName = requiredText(
    options.developerName ?? "AgentChannels",
    "developerName",
  );
  return {
    $schema: "https://linear.app/.well-known/oauth-app-manifest.schema.json",
    schemaVersion: "1.0.0",
    distribution: "private",
    display: { description: `${agentName} local coding agent` },
    developer: { name: developerName },
    oauth: {
      client_name: agentName,
      client_uri: clientUri,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "client_credentials"],
    },
    webhook: {
      enabled: true,
      url: relayWebhookUrl,
      resourceTypes: ["AgentSessionEvent"],
    },
  };
}

export function createSlackOnboarding(
  options: SlackManifestOptions,
): OnboardingConfiguration {
  return {
    manifest: createSlackAppManifest(options),
    actionRequired: {
      status: "action_required",
      action: "open_url",
      url: "https://api.slack.com/apps",
      reason: "workspace_admin_approval",
    },
  };
}

export function createLinearOnboarding(
  options: LinearManifestOptions,
): OnboardingConfiguration {
  const manifest = createLinearAppManifest(options);
  return {
    manifest,
    actionRequired: {
      status: "action_required",
      action: "open_url",
      url: `https://linear.app/settings/api/applications/new?manifest=${encodeURIComponent(JSON.stringify(manifest))}`,
      reason: "workspace_admin_approval",
    },
  };
}

export const buildSlackManifest = createSlackAppManifest;
export const buildLinearManifest = createLinearAppManifest;
