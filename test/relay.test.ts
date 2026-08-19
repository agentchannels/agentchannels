import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli/program.js";
import { Persistence } from "../src/persistence/store.js";
import { RelayManager } from "../src/relay/manager.js";
import { HOSTED_RELAY_ORIGIN, parseRelayOrigin } from "../src/relay/origin.js";
import type { CredentialStore } from "../src/security/credentials.js";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../src/security/identity.js";
import { PRODUCT_VERSION } from "../src/version.js";

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

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Relay origins", () => {
  it("normalizes origins and derives endpoints with URL semantics", () => {
    const https = parseRelayOrigin("https://relay.example.com/");
    expect(https.origin).toBe("https://relay.example.com");
    expect(https.installationUrl.toString()).toBe(
      "https://relay.example.com/v1/installations",
    );
    expect(https.websocketUrl.toString()).toBe(
      "wss://relay.example.com/v1/connect",
    );
    expect(https.webhookUrl("slack", "bd_1").toString()).toBe(
      "https://relay.example.com/v1/webhooks/slack/bd_1",
    );
    expect(
      parseRelayOrigin("http://localhost:8787").websocketUrl.protocol,
    ).toBe("ws:");
    expect(parseRelayOrigin("http://127.9.8.7:8787").origin).toBe(
      "http://127.9.8.7:8787",
    );
    expect(parseRelayOrigin("http://[::1]:8787").origin).toBe(
      "http://[::1]:8787",
    );
  });

  it.each([
    "http://relay.example.com",
    "http://localhost.example.com",
    "https://user:pass@relay.example.com",
    "https://relay.example.com/api",
    "https://relay.example.com?query=yes",
    "https://relay.example.com/#fragment",
    "ftp://relay.example.com",
  ])("rejects invalid origin %s", (origin) => {
    expect(() => parseRelayOrigin(origin)).toThrow();
  });
});

describe("Relay selection", () => {
  it("preflights affected Bindings without mutation, then enrolls before cutover", async () => {
    const store = new Persistence(":memory:");
    const credentials = new MemoryCredentials();
    const identityService = new InstallationIdentityService(credentials);
    const identity = await identityService.getOrCreate();
    store.createInstallation({
      id: identity.installationId,
      publicKey: identity.publicKeyBase64,
      relayOrigin: HOSTED_RELAY_ORIGIN,
      enrolledAt: "2026-01-01T00:00:00.000Z",
    });
    const agent = store.createAgent({ name: "Runbear", cwd: "/repo" });
    const binding = store.createBinding({
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "operator",
      externalInstallationId: "workspace",
    });
    store.createBindingSetup({ agentId: agent.id, connector: "linear" });
    store.grantAccess(binding.id, "alice");
    const session = store.createSession({
      bindingId: binding.id,
      remoteConversationId: "thread",
      cwd: "/worktree",
      worktreePath: "/worktree",
      baseCommit: "head",
    });
    await new BindingCredentialService(credentials).set(binding.id, {
      botToken: "synthetic",
    });
    const fetcher = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ installationId: identity.installationId }),
          ),
        ),
    );
    const manager = new RelayManager({
      store,
      identity: identityService,
      fetch: fetcher,
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    const preflight = await manager.use({
      origin: "https://relay.example.com",
      enrollmentToken: "not-persisted",
    });
    expect(preflight).toMatchObject({
      status: "action_required",
      action: "acknowledge_binding_reconfiguration",
      from: HOSTED_RELAY_ORIGIN,
      to: "https://relay.example.com",
    });
    expect(preflight.bindings).toHaveLength(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.getInstallation(identity.installationId)?.relayOrigin).toBe(
      HOSTED_RELAY_ORIGIN,
    );

    const result = await manager.use({
      origin: "https://relay.example.com/",
      enrollmentToken: "not-persisted",
      acknowledgeBindingReconfiguration: true,
    });
    expect(result).toMatchObject({
      status: "action_required",
      action: "restart_daemon",
      relayOrigin: "https://relay.example.com",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer not-persisted",
    );
    expect(store.getInstallation(identity.installationId)).toMatchObject({
      relayOrigin: "https://relay.example.com",
      enrolledAt: "2026-02-01T00:00:00.000Z",
    });
    expect(store.listAgents()).toHaveLength(1);
    expect(store.listAllBindings()).toHaveLength(1);
    expect(store.listAllBindingSetups()).toHaveLength(1);
    expect(store.listAccess(binding.id)).toHaveLength(1);
    expect(store.getSession(session.id)?.worktreePath).toBe("/worktree");
    expect(
      await new BindingCredentialService(credentials).require(binding.id),
    ).toEqual({
      botToken: "synthetic",
    });
    expect(JSON.stringify(store.db.serialize())).not.toContain("not-persisted");
    expect([...credentials.values.values()].join("\n")).not.toContain(
      "not-persisted",
    );

    fetcher.mockImplementationOnce(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );
    await expect(
      manager.use({
        origin: "https://other.example.com",
        enrollmentToken: "invalid",
        acknowledgeBindingReconfiguration: true,
      }),
    ).rejects.toThrow("HTTP 401");
    expect(store.getInstallation(identity.installationId)?.relayOrigin).toBe(
      "https://relay.example.com",
    );
    fetcher.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ installationId: "in_wrong" })),
      ),
    );
    await expect(
      manager.use({
        origin: "https://third.example.com",
        enrollmentToken: "synthetic-invalid",
        acknowledgeBindingReconfiguration: true,
      }),
    ).rejects.toThrow("different installation ID");
    expect(store.getInstallation(identity.installationId)?.relayOrigin).toBe(
      "https://relay.example.com",
    );
    store.close();
  });

  it("initializes hosted once and re-enrolls the same origin idempotently", async () => {
    const store = new Persistence(":memory:");
    const credentials = new MemoryCredentials();
    const identity = new InstallationIdentityService(credentials);
    const fetcher = vi.fn(() =>
      identity
        .getOrCreate()
        .then(
          (value) =>
            new Response(
              JSON.stringify({ installationId: value.installationId }),
            ),
        ),
    );
    const manager = new RelayManager({ store, identity, fetch: fetcher });
    await expect(manager.ensureHosted()).resolves.toMatchObject({
      origin: HOSTED_RELAY_ORIGIN,
    });
    expect((await manager.use({ origin: HOSTED_RELAY_ORIGIN })).action).toBe(
      "restart_daemon",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.getInstallationState()?.relayOrigin).toBe(HOSTED_RELAY_ORIGIN);
    store.close();
  });
});

describe("Relay CLI", () => {
  it("reads uninitialized status without creating local state and uses package version", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentchannels-relay-status-"));
    temporaryDirectories.push(home);
    rmSync(home, { recursive: true, force: true });
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const program = createProgram();
    expect(program.version()).toBe(PRODUCT_VERSION);
    await program.parseAsync(["--home", home, "--json", "relay", "status"], {
      from: "user",
    });
    expect(write).toHaveBeenCalledWith('{\n  "status": "uninitialized"\n}\n');
    expect(existsSync(home)).toBe(false);
    write.mockClear();
    await createProgram().parseAsync(
      ["--home", home, "relay", "status", "--json"],
      { from: "user" },
    );
    expect(write).toHaveBeenCalledWith('{\n  "status": "uninitialized"\n}\n');
    expect(existsSync(home)).toBe(false);
  });

  it("keeps connector-free init local and exposes no transient Relay flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentchannels-local-init-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const home = join(root, "home");
    execFileSync("git", ["init", "--initial-branch", "main", repository], {
      stdio: "ignore",
    });
    writeFileSync(join(repository, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=AgentChannels Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: repository, stdio: "ignore" },
    );
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const program = createProgram();
    await program.parseAsync(
      [
        "--home",
        home,
        "--json",
        "init",
        "--name",
        "Local",
        "--cwd",
        repository,
      ],
      { from: "user" },
    );
    const store = new Persistence(join(home, "agentchannels.db"), {
      backupDirectory: join(home, "backups"),
    });
    expect(store.getInstallationState()).toBeUndefined();
    store.close();
    expect(
      program.commands
        .flatMap((command) => command.options)
        .map((option) => option.long),
    ).not.toContain("--relay-public-url");
    expect(
      program.commands
        .flatMap((command) => command.options)
        .map((option) => option.long),
    ).not.toContain("--relay-url");
    write.mockRestore();
  });
});
