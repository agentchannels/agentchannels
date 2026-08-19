import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorModule,
  OnboardingArtifact,
  OnboardingContext,
  VerifiedConnectorCredentials,
} from "../src/connectors/connector.js";
import type {
  ConnectorType,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../src/core/types.js";
import { ensureProductPaths, resolveProductPaths } from "../src/core/paths.js";
import { Persistence } from "../src/persistence/store.js";
import { parseRelayOrigin } from "../src/relay/origin.js";
import type { CredentialStore } from "../src/security/credentials.js";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../src/security/identity.js";
import { CliError } from "../src/cli/errors.js";
import type { ExternalActions, PromptIO } from "../src/cli/io.js";
import { runInitWizard } from "../src/cli/wizard.js";

const directories: string[] = [];

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, string>();
  readonly set = vi.fn(async (key: string, value: string) => {
    this.values.set(key, value);
  });
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class TestConnector implements ConnectorModule {
  readonly label: string;
  readonly credentialFields: readonly { key: string; label: string }[];
  readonly verifyCredentials = vi.fn(
    async (
      credentials: Readonly<Record<string, string>>,
    ): Promise<VerifiedConnectorCredentials> => ({
      credentials: { ...credentials, verified: "true" },
      externalInstallationId: `${this.type}-workspace`,
      externalInstallationName: `${this.label} Workspace`,
    }),
  );

  constructor(readonly type: ConnectorType) {
    this.label = type === "slack" ? "Slack" : "Linear";
    this.credentialFields =
      type === "slack"
        ? [
            { key: "botToken", label: "Slack Bot User OAuth Token" },
            { key: "signingSecret", label: "Slack Signing Secret" },
          ]
        : [
            { key: "clientId", label: "Linear Client ID" },
            { key: "clientSecret", label: "Linear Client Secret" },
            { key: "webhookSecret", label: "Linear Webhook Signing Secret" },
          ];
  }

  createOnboardingArtifact(context: OnboardingContext): OnboardingArtifact {
    return {
      filename: `${this.type}.json`,
      content: JSON.stringify({
        connector: this.type,
        webhook: context.webhookUrl,
      }),
      copyToClipboard: this.type === "slack",
      actionUrl: `https://provider.example/${this.type}/new`,
      instructions: [`Create ${this.label}`],
    };
  }

  verifyAndParse(_request: InboundRequest) {
    return { ok: true as const, response: { status: 200 } };
  }
  async deliver(_message: DeliveryMessage): Promise<void> {}
  async searchUsers(
    query: string,
    _credentials: Readonly<Record<string, string>>,
  ): Promise<RemoteUser[]> {
    return [
      {
        id: `${this.type}-operator`,
        name: query,
        email: `${query}@example.com`,
      },
    ];
  }
}

function scriptedPrompt(values: string[]): PromptIO & { labels: string[] } {
  const labels: string[] = [];
  const next = async (label: string): Promise<string> => {
    labels.push(label);
    const value = values.shift();
    if (value === undefined) throw new Error(`Unexpected prompt: ${label}`);
    return value;
  };
  return {
    labels,
    input: next,
    secret: next,
    async confirm(label) {
      return (await next(label)) === "yes";
    },
  };
}

function fixture(
  options: { interactive: boolean; prompt?: PromptIO } = { interactive: false },
) {
  const directory = mkdtempSync(join(tmpdir(), "agentchannels-onboarding-"));
  directories.push(directory);
  const paths = resolveProductPaths({
    AGENTCHANNELS_HOME: join(directory, "home"),
  });
  ensureProductPaths(paths);
  const store = new Persistence(paths.database, {
    backupDirectory: paths.backups,
  });
  const credentialStore = new MemoryCredentials();
  const slack = new TestConnector("slack");
  const linear = new TestConnector("linear");
  const connectors = new Map<ConnectorType, ConnectorModule>([
    [slack.type, slack],
    [linear.type, linear],
  ]);
  const calls = {
    written: [] as string[],
    opened: [] as string[],
    copied: [] as string[],
    output: "",
  };
  const external: ExternalActions = {
    async writeArtifact(path, content) {
      calls.written.push(`${path}:${content}`);
    },
    async openUrl(url) {
      calls.opened.push(url);
      return false;
    },
    async copyText(text) {
      calls.copied.push(text);
      return false;
    },
  };
  const endpoints = parseRelayOrigin("https://relay.agentchannels.io");
  const relay = {
    ensureHosted: vi.fn(async () => endpoints),
  };
  const dependencies = {
    store,
    paths,
    connectors,
    relay: relay as never,
    identity: new InstallationIdentityService(credentialStore),
    credentials: new BindingCredentialService(credentialStore),
    prompt: options.prompt ?? scriptedPrompt([]),
    external,
    interactive: options.interactive,
    write(message: string) {
      calls.output += message;
    },
  };
  return {
    directory,
    store,
    paths,
    credentialStore,
    slack,
    linear,
    relay,
    calls,
    dependencies,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("resumable first-run onboarding", () => {
  it("creates one Agent, durable independent setups, and browserless artifacts without prompting in machine mode", async () => {
    const f = fixture();
    const first = await runInitWizard(f.dependencies, {
      cwd: f.directory,
      connectorTypes: ["slack", "linear"],
    });
    expect(first.status).toBe("action_required");
    expect(f.store.listAgents()).toHaveLength(1);
    expect(f.store.listAllBindingSetups().map((setup) => setup.step)).toEqual([
      "admin_action",
      "admin_action",
    ]);
    expect(f.calls.written).toHaveLength(2);
    expect(f.calls.opened).toEqual([]);
    expect(f.calls.copied).toEqual([]);

    await runInitWizard(f.dependencies, { cwd: f.directory });
    expect(f.store.listAgents()).toHaveLength(1);
    expect(f.store.listAllBindingSetups()).toHaveLength(2);
    expect(f.relay.ensureHosted).toHaveBeenCalledTimes(2);
    f.store.close();
  });

  it("continues the second provider after the first rejects credentials and persists nothing unverified", async () => {
    const f = fixture();
    await runInitWizard(f.dependencies, {
      cwd: f.directory,
      connectorTypes: ["slack", "linear"],
    });

    const prompt = scriptedPrompt([
      "",
      "bad-token",
      "bad-secret",
      "",
      "linear-client",
      "linear-secret",
      "linear-webhook",
      "snow",
    ]);
    f.slack.verifyCredentials.mockRejectedValueOnce(
      new Error("Slack rejected malformed_auth"),
    );
    const interactive = { ...f.dependencies, prompt, interactive: true };
    const result = await runInitWizard(interactive, { cwd: f.directory });
    expect(result.status).toBe("degraded");
    expect(
      f.store.listAllBindings().map((binding) => binding.connector),
    ).toEqual(["linear"]);
    const slackSetup = f.store
      .listAllBindingSetups()
      .find((candidate) => candidate.connector === "slack");
    expect(slackSetup?.step).toBe("credentials");
    expect(f.credentialStore.set).toHaveBeenCalledTimes(1);
    expect([...f.credentialStore.values.keys()]).toEqual([
      expect.stringMatching(/^binding:bd_/),
    ]);
    expect(prompt.labels.join(" ")).not.toMatch(
      /Agent ID|Binding ID|workspace ID|webhook URL|Session ID/i,
    );
    expect(f.calls.output).toContain("Browser unavailable");
    expect(f.calls.output).toContain("Clipboard unavailable");
    f.store.close();
  });

  it("records the browser boundary before cancellation and resumes the same setup", async () => {
    const cancellingPrompt: PromptIO = {
      async input() {
        throw new CliError("CANCELLED", "Cancelled.", [
          "Rerun agentchannels init.",
        ]);
      },
      async secret() {
        throw new Error("secret prompt must not be reached");
      },
      async confirm() {
        return false;
      },
    };
    const f = fixture({ interactive: true, prompt: cancellingPrompt });
    await expect(
      runInitWizard(f.dependencies, {
        cwd: f.directory,
        name: "Runbear",
        connectorTypes: ["linear"],
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", exitCode: 130 });
    const [pending] = f.store.listAllBindingSetups();
    expect(pending).toMatchObject({
      connector: "linear",
      step: "admin_action",
    });
    expect(pending?.artifactPath).toContain("linear.json");
    expect(f.store.listAgents()).toHaveLength(1);
    f.store.close();
  });
});
