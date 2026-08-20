import type { OnboardingArtifact } from "./connector.js";

export type ActionRequired = Readonly<{
  status: "action_required";
  action: "open_url";
  url: string;
  reason: "workspace_admin_approval";
}>;

export type OnboardingConfiguration = Readonly<{
  artifact: OnboardingArtifact;
  actionRequired: ActionRequired;
}>;

export function createOnboardingConfiguration(
  artifact: OnboardingArtifact,
): OnboardingConfiguration {
  return {
    artifact,
    actionRequired: {
      status: "action_required",
      action: "open_url",
      url: artifact.actionUrl,
      reason: "workspace_admin_approval",
    },
  };
}
