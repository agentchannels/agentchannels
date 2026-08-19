import {
  createLinearOwnedManifest as createOwnedLinearManifest,
  type LinearAppManifest,
} from "./linear.js";
import { createSlackAppManifest, type SlackAppManifest } from "./slack.js";

export type ActionRequired = Readonly<{
  status: "action_required";
  action: "open_url";
  url: string;
  reason: "workspace_admin_approval";
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

/** Compatibility wrapper for callers that still construct manifests directly. */
export function createLinearAppManifest(
  options: LinearManifestOptions,
): LinearAppManifest {
  const owned = createOwnedLinearManifest({
    agentName: options.agentName,
    relayOrigin: new URL(options.relayWebhookUrl).origin,
    relayWebhookUrl: options.relayWebhookUrl,
  });
  return {
    ...owned,
    developer: { name: options.developerName ?? owned.developer.name },
    oauth: {
      ...owned.oauth,
      client_uri: options.clientUri,
      redirect_uris: [options.redirectUri],
    },
  };
}

export function createSlackOnboarding(
  options: SlackManifestOptions,
): OnboardingConfiguration {
  const manifest = createSlackAppManifest(options);
  return {
    manifest,
    actionRequired: {
      status: "action_required",
      action: "open_url",
      url: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
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
export type { LinearAppManifest, SlackAppManifest };
