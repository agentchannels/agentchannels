import { describe, expect, it } from "vitest";

import {
  PrivilegedServiceError,
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
    expect(fileSystem.files.get(path)).toContain("1.2.4");

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

  it("uses the LaunchAgent lifecycle without touching the real launchd service", async () => {
    const fileSystem = new MemoryFileSystem();
    const calls: string[][] = [];
    let running = false;
    const run = async (
      executable: string,
      args: string[],
    ): Promise<ServiceCommandResult> => {
      calls.push([executable, ...args]);
      if (args[0] === "kickstart") running = true;
      if (args[0] === "kill" || args[0] === "bootout") running = false;
      if (args[0] === "print" && !running)
        return { exitCode: 1, stdout: "", stderr: "stopped" };
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
    expect((await manager.status(definition)).running).toBe(true);
    await manager.stop(definition);
    expect((await manager.status(definition)).running).toBe(false);
    await manager.uninstall(definition);
    expect(fileSystem.files.size).toBe(0);
    expect(
      calls.some((call) => call[0] === "launchctl" && call[1] === "bootstrap"),
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

  it("uses a registry factory so a platform adapter is independently replaceable", async () => {
    let installed = false;
    const registry: ServicePlatformRegistry = {
      get: () => () => ({
        platform: "test",
        definitionPath: "/virtual/test.service",
        install: async () => {
          installed = true;
        },
        start: async () => undefined,
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
          nextAction: installed ? "No action required" : "Install",
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
