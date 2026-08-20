import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/program.js";
import type { PromptChoice, PromptIO } from "../src/cli/io.js";
import { ensureProductPaths, resolveProductPaths } from "../src/core/paths.js";
import { Persistence } from "../src/persistence/store.js";
import { HOSTED_RELAY_ORIGIN } from "../src/relay/origin.js";
import type { CredentialStore } from "../src/security/credentials.js";
import { InstallationIdentityService } from "../src/security/identity.js";
import type {
  ServiceDefinition,
  ServiceOperationResult,
  ServiceStatus,
} from "../src/service/index.js";
import type { ServiceManager } from "../src/service/manager.js";

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

function repository() {
  const root = mkdtempSync(join(tmpdir(), "agentchannels-cli-daemon-"));
  roots.push(root);
  const cwd = join(root, "repository");
  const home = join(root, "home");
  execFileSync("git", ["init", "--initial-branch", "main", cwd], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=AgentChannels Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd, stdio: "ignore" },
  );
  return { cwd, home };
}

function serviceDouble(initial: Partial<ServiceStatus> = {}) {
  let status: ServiceStatus = {
    platform: "test",
    supported: true,
    installed: true,
    running: true,
    definitionMatches: true,
    definitionPath: "/virtual/agentchannels.service",
    ...initial,
  };
  const result = (operation: ServiceOperationResult["operation"]) => ({
    ...status,
    operation,
  });
  const calls = {
    reconcile: vi.fn(async (_definition: ServiceDefinition) => {
      const operation = status.running ? "unchanged" : "started";
      status = { ...status, installed: true, running: true };
      return result(operation);
    }),
    restart: vi.fn(async (_definition?: ServiceDefinition) =>
      result("restarted"),
    ),
  };
  const manager = {
    status: vi.fn(async () => status),
    reconcile: calls.reconcile,
    install: calls.reconcile,
    start: vi.fn(async () => result("started")),
    restart: calls.restart,
    stop: vi.fn(async () => result("stopped")),
    uninstall: vi.fn(async () => result("uninstalled")),
  } as unknown as ServiceManager;
  return { manager, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("CLI daemon orchestration", () => {
  it("supports the explicit daemon restart command without a follow-up action", async () => {
    const service = serviceDouble();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await createProgram({
      serviceManager: service.manager,
      serviceEntry: "/opt/bin/agentchannels",
    }).parseAsync(["--json", "daemon", "restart"], { from: "user" });
    expect(service.calls.restart).toHaveBeenCalledOnce();
    const definition = service.calls.restart.mock.calls[0]?.[0];
    expect(definition?.command.executable).not.toContain("node_modules/.pnpm");
    expect(definition?.command.args[0]).not.toContain("node_modules/.pnpm");
    expect(definition?.command.environment).toEqual({
      AGENTCHANNELS_HOME: expect.any(String),
      PATH: expect.any(String),
    });
    expect(definition?.command.environment?.PATH).toContain("/usr/bin");
    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "ready",
      actionRequired: false,
      nextSteps: [],
      service: { operation: "restarted" },
    });
  });

  it("refuses to persist a temporary package-runner shim in the service definition", async () => {
    const service = serviceDouble();
    await expect(
      createProgram({
        serviceManager: service.manager,
        serviceEntry: "/tmp/node_modules/.bin/agentchannels",
      }).parseAsync(["daemon", "install"], { from: "user" }),
    ).rejects.toMatchObject({
      code: "SERVICE_MANAGER_FAILED",
      message:
        "Background daemon installation requires a persistent AgentChannels executable.",
    });
    expect(service.calls.reconcile).not.toHaveBeenCalled();
  });

  it("automatically starts an installed stopped daemon on idempotent init", async () => {
    const fixture = repository();
    const paths = resolveProductPaths({ AGENTCHANNELS_HOME: fixture.home });
    ensureProductPaths(paths);
    const store = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    const agent = store.createAgent({
      name: "Repository",
      cwd: realpathSync(fixture.cwd),
    });
    store.createBinding({
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "U_OPERATOR",
      externalInstallationId: "T_WORKSPACE",
    });
    store.close();
    const service = serviceDouble({ running: false });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await createProgram({
      serviceManager: service.manager,
      interactive: false,
      serviceEntry: "/opt/bin/agentchannels",
    }).parseAsync(
      ["--home", fixture.home, "--json", "init", "--cwd", fixture.cwd],
      { from: "user" },
    );
    expect(service.calls.reconcile).toHaveBeenCalledOnce();
    expect(service.calls.restart).not.toHaveBeenCalled();
  });

  it("restarts an installed daemon after a Relay origin cutover", async () => {
    const fixture = repository();
    const paths = resolveProductPaths({ AGENTCHANNELS_HOME: fixture.home });
    ensureProductPaths(paths);
    const credentialStore = new MemoryCredentials();
    const identity = await new InstallationIdentityService(
      credentialStore,
    ).getOrCreate();
    const store = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    store.createInstallation({
      id: identity.installationId,
      publicKey: identity.publicKeyBase64,
      relayOrigin: "https://relay.example.com",
      enrolledAt: new Date().toISOString(),
    });
    const agent = store.createAgent({ name: "Repository", cwd: fixture.cwd });
    store.createBinding({
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "U_OPERATOR",
      externalInstallationId: "T_WORKSPACE",
    });
    store.close();
    const relayFetch = vi.fn(async () =>
      Response.json({ installationId: identity.installationId }),
    ) as typeof fetch;
    const service = serviceDouble();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await createProgram({
      credentialStore,
      relayFetch,
      serviceManager: service.manager,
      interactive: false,
      serviceEntry: "/opt/bin/agentchannels",
    }).parseAsync(
      [
        "--home",
        fixture.home,
        "--json",
        "relay",
        "use",
        "--hosted",
        "--acknowledge-binding-reconfiguration",
      ],
      { from: "user" },
    );
    expect(relayFetch).toHaveBeenCalledWith(
      new URL(`${HOSTED_RELAY_ORIGIN}/v1/installations`),
      expect.any(Object),
    );
    expect(service.calls.restart).toHaveBeenCalledOnce();
  });
});

describe("CLI target selection", () => {
  it("uses the shared select abstraction for Agent and Binding choices", async () => {
    const fixture = repository();
    const paths = resolveProductPaths({ AGENTCHANNELS_HOME: fixture.home });
    ensureProductPaths(paths);
    const store = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    store.createAgent({ name: "Agent One", cwd: "/agent-one" });
    const selectedAgent = store.createAgent({
      name: "Agent Two",
      cwd: "/agent-two",
    });
    store.createBinding({
      agentId: selectedAgent.id,
      connector: "slack",
      operatorUserId: "U_OPERATOR",
      externalInstallationId: "T_SLACK",
    });
    const selectedBinding = store.createBinding({
      agentId: selectedAgent.id,
      connector: "linear",
      operatorUserId: "U_OPERATOR",
      externalInstallationId: "ORG_LINEAR",
    });
    store.close();
    const labels: string[] = [];
    const prompt: PromptIO = {
      async input(label) {
        throw new Error(`Unexpected input prompt: ${label}`);
      },
      async secret(label) {
        throw new Error(`Unexpected secret prompt: ${label}`);
      },
      async confirm(label) {
        throw new Error(`Unexpected confirmation: ${label}`);
      },
      async multiSelect(label) {
        throw new Error(`Unexpected multi-selection: ${label}`);
      },
      async select<Value>(
        label: string,
        choices: readonly PromptChoice<Value>[],
      ) {
        labels.push(label);
        const choice = choices.find((candidate) =>
          label === "Agent"
            ? candidate.label === "Agent Two"
            : candidate.label === "linear",
        );
        if (choice === undefined) throw new Error(`Missing ${label} choice`);
        return choice.value as Value;
      },
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await createProgram({ prompt, interactive: true }).parseAsync(
      ["--home", fixture.home, "access", "add", "--user", "U_SHARED"],
      { from: "user" },
    );
    expect(labels).toEqual(["Agent", "Connection"]);
    const persisted = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    expect(persisted.listAccess(selectedBinding.id)).toMatchObject([
      { userId: "U_SHARED" },
    ]);
    persisted.close();
  });
});
