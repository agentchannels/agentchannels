import { describe, expect, it } from "vitest";

import {
  PrivilegedServiceError,
  ServiceCommandError,
  ServiceManagerError,
  UnsupportedServicePlatformError,
  createServiceDefinition,
  createServiceManager,
  renderLaunchAgent,
  renderSystemdUnit,
} from "../src/service/index.js";
import type {
  ServiceCommandResult,
  ServiceFileSystem,
  ServicePlatformRegistry,
} from "../src/service/index.js";

class MemoryFileSystem implements ServiceFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }
  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

function commandDouble() {
  const calls: { executable: string; args: string[] }[] = [];
  let running = false;
  const run = async (
    executable: string,
    args: string[],
  ): Promise<ServiceCommandResult> => {
    calls.push({ executable, args });
    if (executable === "systemctl") {
      if (args.includes("start")) running = true;
      if (args.includes("restart")) running = true;
      if (args.includes("stop") || args.includes("disable")) running = false;
      if (args.includes("is-active"))
        return { exitCode: running ? 0 : 3, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("service manager", () => {
  const definition = createServiceDefinition({
    version: "1.2.3",
    executable: "/opt/bin/agentchannels",
    args: ["daemon"],
    environment: { AGENTCHANNELS_HOME: "/tmp/agentchannels-test" },
  });

  it("installs, refreshes, and uninstalls a Linux user service through injected boundaries", async () => {
    const fileSystem = new MemoryFileSystem();
    const commands = commandDouble();
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: commands.run,
    });

    const installed = await manager.install(definition);
    expect(installed).toMatchObject({
      supported: true,
      installed: true,
      running: true,
      definitionMatches: true,
      operation: "installed",
    });
    expect(await manager.status()).toMatchObject({
      command: definition.command,
      version: "1.2.3",
    });
    const path = "/home/tester/.config/systemd/user/agentchannels.service";
    expect(fileSystem.files.get(path)).toContain("/opt/bin/agentchannels");
    expect(fileSystem.files.get(path)).toContain(
      "AGENTCHANNELS_SERVICE_VERSION",
    );
    expect(fileSystem.directories.has("/tmp/agentchannels-test/logs")).toBe(
      true,
    );

    const refreshed = await manager.install({
      ...definition,
      version: "1.2.4",
    });
    expect(refreshed.version).toBe("1.2.4");
    expect(refreshed.operation).toBe("restarted");
    expect(fileSystem.files.get(path)).toContain("1.2.4");
    expect(
      commands.calls.some(
        ({ executable, args }) =>
          executable === "systemctl" && args.includes("restart"),
      ),
    ).toBe(true);

    await manager.stop(definition);
    expect((await manager.status(definition)).running).toBe(false);
    await manager.uninstall(definition);
    expect(fileSystem.files.has(path)).toBe(false);
    expect(
      commands.calls.some(({ args }) => args.includes("daemon-reload")),
    ).toBe(true);
  });

  it("renders a LaunchAgent with an update-stable executable and user environment", () => {
    const plist = renderLaunchAgent(definition);
    expect(plist).toContain("<string>/opt/bin/agentchannels</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>1.2.3</string>");
    expect(plist).not.toContain("node_modules/.pnpm");
    expect(renderSystemdUnit(definition)).toContain(
      "ExecStart='/opt/bin/agentchannels' 'daemon'",
    );
  });

  it("isolates custom AGENTCHANNELS_HOME services from the default user service", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: { AGENTCHANNELS_HOME: "/tmp/agentchannels-e2e" },
      fileSystem,
      runCommand: async (executable, args) => {
        calls.push([executable, ...args]);
        return { exitCode: 113, stdout: "", stderr: "not loaded" };
      },
    });
    const status = await manager.status(definition);
    expect(status.definitionPath).toMatch(
      /^\/Users\/tester\/Library\/LaunchAgents\/agentchannels-[a-f0-9]{12}\.plist$/,
    );
    expect(status.definitionPath).not.toBe(
      "/Users/tester/Library/LaunchAgents/agentchannels.plist",
    );
    expect(calls.some((call) => call.includes("gui/501/agentchannels"))).toBe(
      false,
    );
  });

  it("leaves a matching running Linux service untouched during reconcile", async () => {
    const fileSystem = new MemoryFileSystem();
    const commands = commandDouble();
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: commands.run,
    });
    await manager.install(definition);
    const before = commands.calls.length;
    await expect(manager.reconcile(definition)).resolves.toMatchObject({
      operation: "unchanged",
      running: true,
    });
    const lifecycleCalls = commands.calls.slice(before);
    expect(
      lifecycleCalls.some(({ args }) =>
        args.some((value) => value === "start" || value === "restart"),
      ),
    ).toBe(false);
  });

  it("starts a stopped Linux service after replacing a changed definition", async () => {
    const fileSystem = new MemoryFileSystem();
    const commands = commandDouble();
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: commands.run,
    });
    await manager.install(definition);
    await manager.stop(definition);
    const before = commands.calls.length;
    const result = await manager.reconcile({ ...definition, version: "2.0.0" });
    expect(result).toMatchObject({ operation: "started", running: true });
    const lifecycleCalls = commands.calls.slice(before);
    expect(lifecycleCalls.some(({ args }) => args.includes("start"))).toBe(
      true,
    );
    expect(lifecycleCalls.some(({ args }) => args.includes("restart"))).toBe(
      false,
    );
    expect(
      fileSystem.files.get(
        "/home/tester/.config/systemd/user/agentchannels.service",
      ),
    ).toContain("2.0.0");
  });

  it("reloads before restarting a changed running Linux service", async () => {
    const fileSystem = new MemoryFileSystem();
    const commands = commandDouble();
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: commands.run,
    });
    await manager.install(definition);
    const before = commands.calls.length;
    await expect(
      manager.reconcile({ ...definition, version: "2.0.0" }),
    ).resolves.toMatchObject({ operation: "restarted", running: true });
    const lifecycleCalls = commands.calls.slice(before);
    const reload = lifecycleCalls.findIndex(({ args }) =>
      args.includes("daemon-reload"),
    );
    const restart = lifecycleCalls.findIndex(({ args }) =>
      args.includes("restart"),
    );
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(reload);
  });

  it("uses the LaunchAgent lifecycle without touching the real launchd service", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    let running = false;
    const run = async (
      executable: string,
      args: string[],
    ): Promise<ServiceCommandResult> => {
      calls.push([executable, ...args]);
      if (args[0] === "kickstart" || args[0] === "bootstrap") running = true;
      if (args[0] === "kill" || args[0] === "bootout") running = false;
      if (args[0] === "print" && !running)
        return { exitCode: 113, stdout: "", stderr: "stopped" };
      if (args[0] === "print")
        return { exitCode: 0, stdout: "state = running\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: {},
      fileSystem,
      runCommand: run,
    });
    await expect(manager.install(definition)).resolves.toMatchObject({
      operation: "installed",
      running: true,
    });
    expect((await manager.status(definition)).running).toBe(true);
    await manager.stop(definition);
    expect((await manager.status(definition)).running).toBe(false);
    await manager.uninstall(definition);
    expect(fileSystem.files.size).toBe(0);
    expect(
      calls.some((call) => call[0] === "launchctl" && call[1] === "bootstrap"),
    ).toBe(true);
  });

  it("reloads a changed running LaunchAgent and does nothing for an unchanged one", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    let running = false;
    const run = async (
      executable: string,
      args: string[],
    ): Promise<ServiceCommandResult> => {
      calls.push([executable, ...args]);
      if (args[0] === "kickstart" || args[0] === "bootstrap") running = true;
      if (args[0] === "kill" || args[0] === "bootout") running = false;
      if (args[0] === "print" && !running)
        return { exitCode: 113, stdout: "", stderr: "stopped" };
      if (args[0] === "print")
        return { exitCode: 0, stdout: "state = running\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: {},
      fileSystem,
      runCommand: run,
    });
    await manager.install(definition);
    const unchangedStart = calls.length;
    await expect(manager.reconcile(definition)).resolves.toMatchObject({
      operation: "unchanged",
    });
    expect(
      calls.slice(unchangedStart).some((call) => call[1] === "bootout"),
    ).toBe(false);
    const changedStart = calls.length;
    await expect(
      manager.reconcile({ ...definition, version: "2.0.0" }),
    ).resolves.toMatchObject({ operation: "restarted", running: true });
    const changedCalls = calls.slice(changedStart);
    expect(changedCalls.some((call) => call[1] === "bootout")).toBe(true);
    expect(changedCalls.some((call) => call[1] === "bootstrap")).toBe(true);
  });

  it("replaces a stopped LaunchAgent before starting the new definition", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    let running = false;
    const run = async (
      executable: string,
      args: string[],
    ): Promise<ServiceCommandResult> => {
      calls.push([executable, ...args]);
      if (args[0] === "bootstrap" || args[0] === "kickstart") running = true;
      if (args[0] === "kill" || args[0] === "bootout") running = false;
      if (args[0] === "print")
        return {
          exitCode: running ? 0 : 113,
          stdout: running ? "state = running\n" : "",
          stderr: "stopped",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: {},
      fileSystem,
      runCommand: run,
    });
    await manager.install(definition);
    await manager.stop(definition);
    const before = calls.length;
    await expect(
      manager.reconcile({ ...definition, version: "2.0.0" }),
    ).resolves.toMatchObject({ operation: "started", running: true });
    const lifecycleCalls = calls.slice(before);
    const bootout = lifecycleCalls.findIndex((call) => call[1] === "bootout");
    const bootstrap = lifecycleCalls.findIndex(
      (call) => call[1] === "bootstrap",
    );
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(bootout);
    expect(lifecycleCalls.some((call) => call[1] === "kickstart")).toBe(false);
  });

  it("bootstraps an installed plist that is not loaded in the user domain", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    let loaded = false;
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: {},
      fileSystem,
      runCommand: async (executable, args) => {
        calls.push([executable, ...args]);
        if (args[0] === "print")
          return {
            exitCode: loaded ? 0 : 113,
            stdout: loaded ? "state = running\n" : "",
            stderr: loaded ? "" : "not loaded",
          };
        if (args[0] === "bootstrap") loaded = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    fileSystem.files.set(
      "/Users/tester/Library/LaunchAgents/agentchannels.plist",
      renderLaunchAgent(definition),
    );
    await expect(manager.reconcile(definition)).resolves.toMatchObject({
      operation: "started",
      installed: true,
      running: true,
    });
    expect(calls.some((call) => call[1] === "bootstrap")).toBe(true);
    expect(calls.some((call) => call[1] === "kickstart")).toBe(false);
  });

  it("restarts an unloaded LaunchAgent by bootstrapping its installed plist", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    let loaded = false;
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: {},
      fileSystem,
      runCommand: async (executable, args) => {
        calls.push([executable, ...args]);
        if (args[0] === "print")
          return {
            exitCode: loaded ? 0 : 113,
            stdout: loaded ? "state = running\n" : "",
            stderr: loaded ? "" : "not loaded",
          };
        if (args[0] === "bootstrap") loaded = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    fileSystem.files.set(
      "/Users/tester/Library/LaunchAgents/agentchannels.plist",
      renderLaunchAgent(definition),
    );
    await expect(manager.restart(definition)).resolves.toMatchObject({
      operation: "restarted",
      running: true,
    });
    expect(calls.some((call) => call[1] === "bootstrap")).toBe(true);
    expect(
      calls.some((call) => call[1] === "kickstart" && call.includes("-k")),
    ).toBe(false);
  });

  it("does not call a loaded-but-scheduled LaunchAgent running", async () => {
    const fileSystem = new MemoryFileSystem();
    const manager = createServiceManager({
      platform: "darwin",
      uid: 501,
      homeDirectory: "/Users/tester",
      environment: {},
      fileSystem,
      runCommand: async (_executable, args) => ({
        exitCode: 0,
        stdout: args[0] === "print" ? "state = spawn scheduled\n" : "",
        stderr: "",
      }),
    });
    fileSystem.files.set(
      "/Users/tester/Library/LaunchAgents/agentchannels.plist",
      renderLaunchAgent(definition),
    );
    await expect(manager.status(definition)).resolves.toMatchObject({
      installed: true,
      running: false,
    });
  });

  it("keeps explicit restart distinct from reconcile", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    const run = async (
      executable: string,
      args: string[],
    ): Promise<ServiceCommandResult> => {
      calls.push([executable, ...args]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: run,
    });
    await manager.install(definition);
    const before = calls.length;
    await expect(manager.restart(definition)).resolves.toMatchObject({
      operation: "restarted",
    });
    expect(
      calls
        .slice(before)
        .some((call) => call[0] === "systemctl" && call.includes("restart")),
    ).toBe(true);
  });

  it("rejects Windows before any filesystem or command mutation", async () => {
    const fileSystem = new MemoryFileSystem();
    const commands = commandDouble();
    const manager = createServiceManager({
      platform: "win32",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: commands.run,
    });
    await expect(manager.install(definition)).rejects.toBeInstanceOf(
      UnsupportedServicePlatformError,
    );
    expect(fileSystem.files.size).toBe(0);
    expect(fileSystem.directories.size).toBe(0);
    expect(commands.calls).toHaveLength(0);
    await expect(manager.status(definition)).resolves.toMatchObject({
      supported: false,
      installed: false,
      running: false,
    });
  });

  it("rejects root and sudo mutations before touching injected boundaries", async () => {
    const fileSystem = new MemoryFileSystem();
    const commands = commandDouble();
    const manager = createServiceManager({
      platform: "linux",
      uid: 0,
      homeDirectory: "/root",
      environment: { SUDO_USER: "tester" },
      fileSystem,
      runCommand: commands.run,
    });
    await expect(manager.install(definition)).rejects.toBeInstanceOf(
      PrivilegedServiceError,
    );
    expect(fileSystem.files.size).toBe(0);
    expect(commands.calls).toHaveLength(0);
  });

  it("wraps raw service command failures in a concise typed error", async () => {
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem: new MemoryFileSystem(),
      runCommand: async () => {
        throw new Error(
          "Command failed: systemctl --user daemon-reload\nraw service manager diagnostics",
        );
      },
    });
    const failure = await manager.reconcile(definition).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceManagerError);
    expect(failure).toMatchObject({
      code: "SERVICE_MANAGER_FAILED",
      message: "Could not update or start the background daemon.",
    });
    expect(String(failure)).not.toContain("systemctl");
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it("preserves command diagnostics when a manager reports an unexpected exit", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set(
      "/home/tester/.config/systemd/user/agentchannels.service",
      renderSystemdUnit(definition),
    );
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: async () => ({
        exitCode: 1,
        stdout: "status output",
        stderr: "systemctl is unavailable",
      }),
    });
    const failure = await manager.status(definition).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceManagerError);
    expect((failure as ServiceManagerError).cause).toBeInstanceOf(
      ServiceCommandError,
    );
    expect((failure as ServiceManagerError).cause).toMatchObject({
      executable: "systemctl",
      exitCode: 1,
      stdout: "status output",
      stderr: "systemctl is unavailable",
    });
  });

  it("wraps a post-mutation status failure instead of leaking a raw error", async () => {
    const fileSystem = new MemoryFileSystem();
    let failStatus = false;
    const manager = createServiceManager({
      platform: "linux",
      uid: 501,
      homeDirectory: "/home/tester",
      environment: {},
      fileSystem,
      runCommand: async (_executable, args) => {
        if (failStatus && args.includes("is-active"))
          return { exitCode: 1, stdout: "", stderr: "status failed" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await manager.install(definition);
    failStatus = true;
    const failure = await manager.start(definition).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceManagerError);
    expect(failure).toMatchObject({
      message: "Could not inspect the background daemon after start.",
    });
    expect((failure as ServiceManagerError).cause).toBeInstanceOf(
      ServiceCommandError,
    );
    expect(fileSystem.files.size).toBe(1);
  });

  it("uses a registry factory so a platform adapter is independently replaceable", async () => {
    let installed = false;
    const registry: ServicePlatformRegistry = {
      get: () => () => ({
        platform: "test",
        definitionPath: "/virtual/test.service",
        install: async () => {
          installed = true;
        },
        reconcile: async () => {
          installed = true;
          return {
            platform: "test",
            supported: true,
            installed,
            running: installed,
            definitionMatches: installed,
            definitionPath: "/virtual/test.service",
            operation: installed ? "installed" : "unsupported",
          };
        },
        start: async () => undefined,
        restart: async () => undefined,
        stop: async () => undefined,
        uninstall: async () => {
          installed = false;
        },
        status: async () => ({
          platform: "test",
          supported: true,
          installed,
          running: installed,
          definitionMatches: installed,
          definitionPath: "/virtual/test.service",
        }),
      }),
    };
    const manager = createServiceManager({
      platform: "test",
      registry,
      uid: 501,
      environment: {},
    });
    await manager.install(definition);
    expect((await manager.status()).installed).toBe(true);
    await manager.uninstall();
    expect((await manager.status()).installed).toBe(false);
  });
});
