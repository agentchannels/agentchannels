import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorModule,
  OnboardingArtifact,
  OnboardingContext,
  VerifiedConnectorCredentials,
} from "../src/connectors/connector.ts";
import type {
  ConnectorType,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../src/model.ts";
import { ensureProductPaths, resolveProductPaths } from "../src/paths.ts";
import { Persistence } from "../src/store/store.ts";
import { parseRelayOrigin } from "../src/relay/origin.ts";
import type { CredentialStore } from "../src/security/keyring.ts";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../src/security/identity.ts";
import { AgentChannelsError } from "../src/errors.ts";
import type { ExternalActions, PromptIO } from "../src/cli/io.ts";
import { runInitWizard } from "../src/cli/wizard.ts";

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
  operatorUsers: RemoteUser[] = [];
  readonly verifyCredentials = vi.fn(
    async (
      credentials: Readonly<Record<string, string>>,
    ): Promise<VerifiedConnectorCredentials> => ({
      credentials: { ...credentials, verified: "true" },
      externalInstallationId: `${this.type}-workspace`,
      externalInstallationName: `${this.label} Workspace`,
    }),
  );

  readonly type: ConnectorType;

  constructor(type: ConnectorType) {
    this.type = type;
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
    if (this.operatorUsers.length > 0) return this.operatorUsers;
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
    async select<Value>(label: string, choices: readonly { value: Value }[]) {
      labels.push(label);
      const selected = values.shift();
      if (selected === undefined)
        throw new Error(`Unexpected prompt: ${label}`);
      const choice = choices.find(({ value }) => {
        if (String(value) === selected) return true;
        return (
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          String((value as { id: unknown }).id) === selected
        );
      });
      if (choice === undefined) throw new Error(`Invalid choice: ${selected}`);
      return choice.value;
    },
    async multiSelect<Value>(
      label: string,
      choices: readonly { value: Value }[],
    ) {
      labels.push(label);
      const selected = values.shift();
      if (selected === undefined)
        throw new Error(`Unexpected prompt: ${label}`);
      const wanted = new Set(selected.split(",").map((value) => value.trim()));
      return choices
        .filter(({ value }) => wanted.has(String(value)))
        .map(({ value }) => value);
    },
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
  it("keeps an interactive Skip local-only without Relay mutation", async () => {
    const prompt = scriptedPrompt(["Local", "__local_only__"]);
    const f = fixture({ interactive: true, prompt });
    const result = await runInitWizard(f.dependencies, { cwd: f.directory });
    expect(result).toMatchObject({ status: "ready", nextSteps: [] });
    expect(f.store.listAgents()).toHaveLength(1);
    expect(f.store.listAllBindingSetups()).toEqual([]);
    expect(f.relay.ensureHosted).not.toHaveBeenCalled();
    f.store.close();
  });

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

  it("uses the injected select abstraction for multiple Operators", async () => {
    const f = fixture();
    f.slack.operatorUsers = [
      { id: "slack-first", name: "First", email: "first@example.com" },
      { id: "slack-second", name: "Second", email: "second@example.com" },
    ];
    await runInitWizard(f.dependencies, {
      cwd: f.directory,
      connectorTypes: ["slack"],
    });
    const prompt = scriptedPrompt([
      "",
      "bot-token",
      "signing-secret",
      "snow",
      "slack-second",
    ]);
    const result = await runInitWizard(
      { ...f.dependencies, prompt, interactive: true },
      { cwd: f.directory },
    );
    expect(result.status).toBe("ready");
    expect(f.store.listAllBindings()).toMatchObject([
      { connector: "slack", operatorUserId: "slack-second" },
    ]);
    expect(prompt.labels).toContain("Operator");
    f.store.close();
  });

  it("removes verified credentials when Binding activation fails", async () => {
    const f = fixture();
    await runInitWizard(f.dependencies, {
      cwd: f.directory,
      connectorTypes: ["slack"],
    });
    vi.spyOn(f.store, "completeBindingSetup").mockImplementation(() => {
      throw new Error("Binding activation failed");
    });
    const prompt = scriptedPrompt(["", "bot-token", "signing-secret", "snow"]);
    const result = await runInitWizard(
      { ...f.dependencies, prompt, interactive: true },
      { cwd: f.directory },
    );
    expect(result.status).toBe("degraded");
    expect(f.store.listAllBindings()).toHaveLength(0);
    expect([...f.credentialStore.values.keys()]).toHaveLength(0);
    f.store.close();
  });

  it("records the browser boundary before cancellation and resumes the same setup", async () => {
    const cancellingPrompt: PromptIO = {
      async input() {
        throw new AgentChannelsError("CANCELLED", "Cancelled.", [
          "Rerun agentchannels init.",
        ]);
      },
      async secret() {
        throw new Error("secret prompt must not be reached");
      },
      async select() {
        throw new Error("select prompt must not be reached");
      },
      async multiSelect() {
        throw new Error("multiSelect prompt must not be reached");
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
