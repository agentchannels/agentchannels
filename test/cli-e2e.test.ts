import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliError,
  normalizeCliError,
  renderCliError,
} from "../src/cli/errors.js";
import type { ExternalActions, PromptChoice, PromptIO } from "../src/cli/io.js";
import { createProgram, type ProgramDependencies } from "../src/cli/program.js";
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
import { Persistence } from "../src/persistence/store.js";
import type { CredentialStore } from "../src/security/credentials.js";
import type {
  ServiceDefinition,
  ServiceOperationResult,
  ServiceStatus,
} from "../src/service/index.js";
import type { ServiceManager } from "../src/service/manager.js";
import { ServiceManagerError } from "../src/service/guards.js";

const roots: string[] = [];

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

class StoryConnector implements ConnectorModule {
  readonly label: string;
  readonly credentialFields: readonly { key: string; label: string }[];

  constructor(readonly type: ConnectorType) {
    this.label = type === "slack" ? "Slack" : "Linear";
    this.credentialFields =
      type === "slack"
        ? [
            { key: "botToken", label: "Slack Bot Token" },
            { key: "signingSecret", label: "Slack Signing Secret" },
          ]
        : [
            { key: "clientId", label: "Linear Client ID" },
            { key: "clientSecret", label: "Linear Client Secret" },
            { key: "webhookSecret", label: "Linear Webhook Secret" },
          ];
  }

  createOnboardingArtifact(context: OnboardingContext): OnboardingArtifact {
    return {
      filename: `${this.type}-manifest.json`,
      content: `${JSON.stringify({ provider: this.type, webhook: context.webhookUrl })}\n`,
      copyToClipboard: this.type === "slack",
      actionUrl: `https://provider.example/${this.type}/new`,
      instructions: [`Create and install the ${this.label} application.`],
    };
  }

  async verifyCredentials(
    credentials: Readonly<Record<string, string>>,
  ): Promise<VerifiedConnectorCredentials> {
    return {
      credentials: { ...credentials, verified: "true" },
      externalInstallationId: `${this.type}-workspace`,
      externalInstallationName: `${this.label} Workspace`,
    };
  }

  verifyAndParse(_request: InboundRequest) {
    return { ok: true as const, response: { status: 200 } };
  }

  async deliver(_message: DeliveryMessage): Promise<void> {}

  async searchUsers(): Promise<RemoteUser[]> {
    return [
      { id: `${this.type}-alice`, name: "Alice", email: "alice@example.com" },
      {
        id: `${this.type}-operator`,
        name: "Operator",
        email: "operator@example.com",
      },
    ];
  }
}

class StoryPrompt implements PromptIO {
  readonly labels: string[] = [];

  constructor(
    private readonly inputs: Array<string | Error>,
    private readonly secrets: string[],
    private readonly multiSelections: string[][],
    private readonly confirmations: boolean[],
  ) {}

  async input(label: string, defaultValue?: string): Promise<string> {
    this.labels.push(label);
    const value = this.inputs.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Unexpected input prompt: ${label}`);
    }
    return value;
  }

  async secret(label: string): Promise<string> {
    this.labels.push(label);
    const value = this.secrets.shift();
    if (value === undefined)
      throw new Error(`Unexpected secret prompt: ${label}`);
    return value;
  }

  async confirm(label: string): Promise<boolean> {
    this.labels.push(label);
    const value = this.confirmations.shift();
    if (value === undefined)
      throw new Error(`Unexpected confirmation: ${label}`);
    return value;
  }

  async select<Value>(
    label: string,
    choices: readonly PromptChoice<Value>[],
  ): Promise<Value> {
    this.labels.push(label);
    const operator = choices.find((choice) => choice.label === "Operator");
    return (operator ?? choices[0] ?? fail(`No choices for ${label}`)).value;
  }

  async multiSelect<Value>(
    label: string,
    choices: readonly PromptChoice<Value>[],
  ): Promise<readonly Value[]> {
    this.labels.push(label);
    const selected = this.multiSelections.shift();
    if (selected === undefined)
      throw new Error(`Unexpected multi-selection: ${label}`);
    return choices
      .filter((choice) => selected.includes(String(choice.value)))
      .map((choice) => choice.value);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function stripAnsi(value: string): string {
  return value
    .split(String.fromCharCode(27))
    .map((segment, index) =>
      index === 0 ? segment : segment.replace(/^\[[0-9;]*m/, ""),
    )
    .join("");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentchannels-cli-e2e-"));
  roots.push(root);
  const repository = join(root, "repository");
  const home = join(root, "home");
  execFileSync("git", ["init", "--initial-branch", "main", repository], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=AgentChannels E2E",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repository, stdio: "ignore" },
  );
  return { home, repository: realpathSync(repository) };
}

function serviceDouble() {
  let status: ServiceStatus = {
    platform: "test",
    supported: true,
    installed: false,
    running: false,
    definitionMatches: false,
    definitionPath: "/virtual/agentchannels.service",
  };
  const operation = (
    name: ServiceOperationResult["operation"],
  ): ServiceOperationResult => ({ ...status, operation: name });
  const reconcile = vi.fn(async (_definition: ServiceDefinition) => {
    status = {
      ...status,
      installed: true,
      running: true,
      definitionMatches: true,
    };
    return operation("installed");
  });
  return {
    reconcile,
    manager: {
      status: async () => status,
      reconcile,
      install: reconcile,
      start: async () => operation("started"),
      restart: async () => operation("restarted"),
      stop: async () => operation("stopped"),
      uninstall: async () => operation("uninstalled"),
    } as unknown as ServiceManager,
  };
}

function dependencies(
  prompt: PromptIO,
  credentials: CredentialStore,
  serviceManager: ServiceManager,
  external: ExternalActions,
): ProgramDependencies {
  const connectors = new Map<ConnectorType, ConnectorModule>([
    ["slack", new StoryConnector("slack")],
    ["linear", new StoryConnector("linear")],
  ]);
  return {
    prompt,
    credentialStore: credentials,
    connectors,
    serviceManager,
    serviceEntry: "/opt/bin/agentchannels",
    external,
    interactive: true,
    relayFetch: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { installationId: string };
      return Response.json({ installationId: body.installationId });
    }) as typeof fetch,
  } as ProgramDependencies;
}

function externalActions(log: { artifacts: string[]; opened: string[] }) {
  return {
    async writeArtifact(path: string, content: string) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      log.artifacts.push(path);
    },
    async openUrl(url: string) {
      log.opened.push(url);
      return true;
    },
    async copyText() {
      return true;
    },
  } satisfies ExternalActions;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("CLI end-to-end stories", () => {
  it("completes dual-provider human onboarding through daemon reconcile", async () => {
    const f = fixture();
    const credentials = new MemoryCredentials();
    const service = serviceDouble();
    const prompt = new StoryPrompt(
      ["Project Agent", "", "operator", "", "operator"],
      [
        "slack-bot-token",
        "slack-signing-secret",
        "linear-client-id",
        "linear-client-secret",
        "linear-webhook-secret",
      ],
      [["slack", "linear"]],
      [true],
    );
    const externalLog = { artifacts: [] as string[], opened: [] as string[] };
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const deps = dependencies(
      prompt,
      credentials,
      service.manager,
      externalActions(externalLog),
    );

    await createProgram(deps).parseAsync(
      ["--home", f.home, "init", "--cwd", f.repository],
      { from: "user" },
    );
    const humanOutput = stripAnsi(
      write.mock.calls.map(([value]) => String(value)).join(""),
    );
    expect(humanOutput).toContain("✓ Slack connected to Slack Workspace");
    expect(humanOutput).toContain("✓ Linear connected to Linear Workspace");
    expect(humanOutput).toContain("✓ Background daemon running");
    expect(humanOutput).not.toContain("Next:");
    expect(externalLog.artifacts).toHaveLength(2);
    expect(externalLog.opened).toEqual([
      "https://provider.example/slack/new",
      "https://provider.example/linear/new",
    ]);
    expect(service.reconcile).toHaveBeenCalledOnce();

    const store = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    expect(store.listAgents()).toHaveLength(1);
    expect(
      store
        .listAllBindings()
        .map((binding) => binding.connector)
        .sort(),
    ).toEqual(["linear", "slack"]);
    expect(store.listAllBindingSetups()).toEqual([]);
    store.close();
    expect(
      [...credentials.values.keys()].filter((key) =>
        key.startsWith("binding:"),
      ),
    ).toHaveLength(2);

    const beforeStatus = write.mock.calls.length;
    await createProgram({ ...deps, interactive: false }).parseAsync(
      ["--home", f.home, "--json", "status"],
      { from: "user" },
    );
    const statusOutput = write.mock.calls
      .slice(beforeStatus)
      .map(([value]) => String(value))
      .join("");
    expect(JSON.parse(statusOutput)).toMatchObject({
      status: "ready",
      actionRequired: false,
      nextSteps: [],
      bindings: [
        { connector: expect.any(String) },
        { connector: expect.any(String) },
      ],
      daemon: { running: true },
    });
  });

  it("preserves the pending setup across cancellation and resumes it", async () => {
    const f = fixture();
    const credentials = new MemoryCredentials();
    const service = serviceDouble();
    const externalLog = { artifacts: [] as string[], opened: [] as string[] };
    const external = externalActions(externalLog);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const cancelled = new CliError("CANCELLED", "Cancelled.", []);

    await expect(
      createProgram(
        dependencies(
          new StoryPrompt(["Project Agent", cancelled], [], [["slack"]], []),
          credentials,
          service.manager,
          external,
        ),
      ).parseAsync(["--home", f.home, "init", "--cwd", f.repository], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", exitCode: 130 });

    const pendingStore = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    const [pending] = pendingStore.listAllBindingSetups();
    expect(pending).toMatchObject({ connector: "slack", step: "admin_action" });
    const setupId = pending?.id;
    pendingStore.close();

    await createProgram(
      dependencies(
        new StoryPrompt(
          ["", "operator"],
          ["slack-bot-token", "slack-signing-secret"],
          [],
          [false],
        ),
        credentials,
        service.manager,
        external,
      ),
    ).parseAsync(["--home", f.home, "init", "--cwd", f.repository], {
      from: "user",
    });

    const resumedStore = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    expect(resumedStore.listAgents()).toHaveLength(1);
    expect(resumedStore.listAllBindingSetups()).toEqual([]);
    expect(resumedStore.listAllBindings()).toMatchObject([
      { id: setupId, connector: "slack" },
    ]);
    resumedStore.close();
  });

  it("keeps a completed Binding when background installation fails", async () => {
    const f = fixture();
    const credentials = new MemoryCredentials();
    const externalLog = { artifacts: [] as string[], opened: [] as string[] };
    const external = externalActions(externalLog);
    const rawFailure = new Error(
      "Command failed: launchctl bootstrap\nBootstrap failed: 5: Input/output error",
    );
    const serviceFailure = new ServiceManagerError(
      "Could not update or start the background daemon.",
      rawFailure,
    );
    const serviceManager = {
      status: async () => ({
        platform: "darwin",
        supported: true,
        installed: false,
        running: false,
        definitionMatches: false,
        definitionPath: "/virtual/agentchannels.plist",
      }),
      reconcile: async () => Promise.reject(serviceFailure),
    } as unknown as ServiceManager;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      createProgram(
        dependencies(
          new StoryPrompt(
            ["Project Agent", "", "operator"],
            ["slack-bot-token", "slack-signing-secret"],
            [["slack"]],
            [true],
          ),
          credentials,
          serviceManager,
          external,
        ),
      ).parseAsync(["--home", f.home, "init", "--cwd", f.repository], {
        from: "user",
      }),
    ).rejects.toBe(serviceFailure);

    const stored = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    const [agent] = stored.listAgents();
    expect(stored.listAllBindings()).toHaveLength(1);
    expect(stored.listAllBindingSetups()).toEqual([]);
    stored.close();
    expect(externalLog.artifacts).toHaveLength(1);

    const normalError = renderCliError(normalizeCliError(serviceFailure), {
      json: false,
      debug: false,
      cause: serviceFailure,
    });
    expect(normalError).toBe(
      "Error: Could not update or start the background daemon.\nRun agentchannels daemon install --debug to retry with diagnostics.\n",
    );
    expect(normalError).not.toContain("launchctl");
    expect(normalError).not.toContain("Bootstrap failed");

    await expect(
      createProgram(
        dependencies(
          new StoryPrompt([], [], [], [true]),
          credentials,
          serviceManager,
          external,
        ),
      ).parseAsync(
        [
          "--home",
          f.home,
          "connect",
          "slack",
          "--agent",
          agent?.id ?? fail("Missing Agent after onboarding"),
        ],
        { from: "user" },
      ),
    ).rejects.toBe(serviceFailure);

    const rerun = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    expect(rerun.listAllBindings()).toHaveLength(1);
    expect(rerun.listAllBindingSetups()).toEqual([]);
    rerun.close();
    expect(externalLog.artifacts).toHaveLength(1);
  });

  it("deletes credentials owned by a pending setup with its Agent", async () => {
    const f = fixture();
    const credentials = new MemoryCredentials();
    mkdirSync(f.home, { recursive: true });
    const store = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    const agent = store.createAgent({ name: "Pending", cwd: f.repository });
    const setup = store.createBindingSetup({
      agentId: agent.id,
      connector: "slack",
    });
    store.close();
    await credentials.set(
      `binding:${setup.id}`,
      JSON.stringify({ botToken: "synthetic-secret" }),
    );
    const service = serviceDouble();
    const externalLog = { artifacts: [] as string[], opened: [] as string[] };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram(
      dependencies(
        new StoryPrompt([], [], [], []),
        credentials,
        service.manager,
        externalActions(externalLog),
      ),
    ).parseAsync(["--home", f.home, "agent", "delete", "--agent", agent.id], {
      from: "user",
    });

    expect(await credentials.get(`binding:${setup.id}`)).toBeNull();
    const deleted = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    expect(deleted.getAgent(agent.id)).toBeUndefined();
    expect(deleted.getBindingSetup(setup.id)).toBeUndefined();
    deleted.close();
  });
});
