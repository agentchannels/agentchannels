import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Persistence } from "../src/store/store.ts";
import { PRODUCT_VERSION } from "../src/version.ts";
import { cleanupFixtures, repositoryFixture } from "./helpers/fixtures.ts";

const node = process.execPath;
const cli = resolve("dist/cli.js");
const sourceRunner = resolve("src/cli.ts");

const repository = (withHead = true) =>
  repositoryFixture(withHead ? {} : { withHead: false });

function run(args: string[], cwd?: string, input?: string) {
  return spawnSync(node, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
    ...(input === undefined ? {} : { input }),
  });
}

function runSource(args: string[]) {
  return spawnSync(node, [sourceRunner, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
  });
}

afterEach(cleanupFixtures);

describe("CLI process boundary", () => {
  it("treats version and help display as successful output", () => {
    const version = run(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(PRODUCT_VERSION);
    expect(version.stderr).toBe("");

    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: agentchannels");
    expect(help.stdout).toContain("Get started:");
    expect(help.stdout).toContain("agentchannels init");
    expect(help.stdout).not.toContain("Rerun with --debug");
    expect(help.stderr).toBe("");

    const connectHelp = run(["connect", "--help"]);
    expect(connectHelp.status).toBe(0);
    expect(connectHelp.stdout).toContain("channel provider: slack or linear");
    expect(connectHelp.stdout).toContain(
      "Most people should use agentchannels init",
    );
    expect(connectHelp.stdout).toContain("agentchannels connect slack");

    const usersHelp = run(["users"]);
    expect(usersHelp.status).toBe(0);
    expect(usersHelp.stdout).toContain("Find provider users for access grants");
    expect(usersHelp.stdout).toContain(
      "agentchannels users search alice --binding bd_...",
    );
    expect(usersHelp.stderr).toBe("");

    const accessHelp = run(["access"]);
    expect(accessHelp.status).toBe(0);
    expect(accessHelp.stdout).toContain("Manage shared-user access");
    expect(accessHelp.stdout).toContain("agentchannels access add");
    expect(accessHelp.stderr).toBe("");
  }, 60_000);

  it("keeps every leaf command help actionable", () => {
    const helpCases: ReadonlyArray<readonly [string[], string]> = [
      [["init", "--help"], "agentchannels init --connect slack"],
      [["connect", "--help"], "agentchannels connect slack"],
      [["status", "--help"], "agentchannels status --agent ag_..."],
      [["agent", "list", "--help"], "agentchannels agent list --json"],
      [
        ["agent", "delete", "--help"],
        "agentchannels agent delete --agent ag_...",
      ],
      [
        ["binding", "list", "--help"],
        "agentchannels binding list --agent ag_... --json",
      ],
      [
        ["binding", "complete", "--help"],
        "--credentials-stdin < credentials.json",
      ],
      [
        ["binding", "remove", "--help"],
        "agentchannels binding remove --binding bd_...",
      ],
      [
        ["sessions", "list", "--help"],
        "agentchannels sessions list --agent ag_... --json",
      ],
      [
        ["sessions", "retire", "--help"],
        "agentchannels sessions retire --session ss_...",
      ],
      [["access", "add", "--help"], "agentchannels access add --agent ag_..."],
      [
        ["access", "list", "--help"],
        "agentchannels access list --binding bd_...",
      ],
      [
        ["access", "remove", "--help"],
        "agentchannels access remove --binding bd_...",
      ],
      [
        ["users", "search", "--help"],
        "agentchannels users search alice --binding bd_...",
      ],
      [["relay", "status", "--help"], "agentchannels relay status --json"],
      [
        ["relay", "use", "--help"],
        "--enrollment-token-stdin < enrollment-token",
      ],
      [["daemon", "install", "--help"], "agentchannels daemon install"],
      [["daemon", "start", "--help"], "agentchannels daemon start"],
      [["daemon", "restart", "--help"], "agentchannels daemon restart"],
      [["daemon", "stop", "--help"], "agentchannels daemon stop"],
      [["daemon", "status", "--help"], "agentchannels daemon status --json"],
      [["daemon", "uninstall", "--help"], "agentchannels daemon uninstall"],
    ];

    for (const [args, expected] of helpCases) {
      const result = run(args);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stderr, args.join(" ")).toBe("");
      expect(result.stdout, args.join(" ")).toContain(expected);
    }
  }, 120_000);

  it("supports clean local-only init, idempotent re-entry, global status, and noun lists", () => {
    const fixture = repository();
    const first = run([
      "--home",
      fixture.home,
      "--json",
      "init",
      "--cwd",
      fixture.cwd,
    ]);
    expect(first.status, first.stderr).toBe(0);
    const firstResult = JSON.parse(first.stdout) as {
      status: string;
      agent: { id: string; name: string };
    };
    expect(firstResult).toMatchObject({ status: "ready" });
    expect(firstResult.agent.name).toBe("repository");
    expect(first.stdout).not.toContain("relay.agentchannels.io");

    const second = run([
      "--home",
      fixture.home,
      "--json",
      "init",
      "--cwd",
      fixture.cwd,
    ]);
    expect(second.status, second.stderr).toBe(0);
    expect(
      (JSON.parse(second.stdout) as { agent: { id: string } }).agent.id,
    ).toBe(firstResult.agent.id);
    const store = new Persistence(join(fixture.home, "agentchannels.db"), {
      backupDirectory: join(fixture.home, "backups"),
    });
    expect(store.listAgents()).toHaveLength(1);
    expect(store.getInstallationState()).toBeUndefined();
    store.close();

    for (const command of [
      [],
      ["status"],
      ["agent"],
      ["binding"],
      ["sessions"],
    ]) {
      const result = run(["--home", fixture.home, ...command], fixture.cwd);
      expect(result.status, `${command.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(
        /AgentChannels|repository|No Bindings|No Sessions/,
      );
      expect(result.stdout).not.toContain("Next:");
      expect(result.stdout).toMatch(
        /No Agents|No Bindings|No Sessions|AgentChannels|repository/,
      );
    }

    const machine = run(
      ["--home", fixture.home, "--json", "status"],
      fixture.cwd,
    );
    expect(machine.status).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      status: "ready",
      actionRequired: false,
      nextSteps: [],
      currentAgentId: firstResult.agent.id,
    });
  }, 120_000);

  it("maps missing Git HEAD and usage failures to concise stable errors", () => {
    const fixture = repository(false);
    const missingHead = run([
      "--home",
      fixture.home,
      "init",
      "--cwd",
      fixture.cwd,
    ]);
    expect(missingHead.status).toBe(3);
    expect(missingHead.stderr).toContain("current HEAD");
    expect(missingHead.stderr).toContain("Error:");
    expect(missingHead.stderr).not.toMatch(/\n\s+at /);

    const usage = run(["--definitely-not-a-real-option"]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("Unknown option");
    expect(usage.stderr).not.toMatch(/\n\s+at /);

    const missingConnector = run(["connect"]);
    expect(missingConnector.status).toBe(2);
    expect(missingConnector.stderr).toContain(
      "Error: Missing required argument: connector.",
    );
    expect(missingConnector.stderr).toContain("agentchannels connect --help");
    expect(missingConnector.stderr).not.toMatch(/\n\s+at /);

    const missingBinding = run(["binding", "remove"]);
    expect(missingBinding.status).toBe(2);
    expect(missingBinding.stderr).toContain(
      "Error: Missing required option: --binding <id>.",
    );
    expect(missingBinding.stderr).toContain(
      "agentchannels binding remove --help",
    );

    const missingEnrollment = run(
      [
        "--home",
        join(fixture.root, "relay-home"),
        "relay",
        "use",
        "--url",
        "https://relay.example.com",
        "--enrollment-token-stdin",
      ],
      undefined,
      "",
    );
    expect(missingEnrollment.status).toBe(9);
    expect(missingEnrollment.stderr).toContain("Required input ended");

    const untouchedHome = join(fixture.root, "untouched-home");
    const invalidConnect = run([
      "--home",
      untouchedHome,
      "--json",
      "connect",
      "slack",
      "--agent",
      "ag_missing",
    ]);
    expect(invalidConnect.status).toBe(4);
    expect(existsSync(untouchedHome)).toBe(false);
    const invalidDaemon = run(["--home", untouchedHome, "daemon"]);
    expect(invalidDaemon.status).toBe(4);
    expect(existsSync(untouchedHome)).toBe(false);
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "prints Cancelled., exits 130, and leaves no Agent when interrupted at the first prompt",
    () => {
      const fixture = repository();
      const python = `
import os, pty, signal, sys
exe, cli, home, cwd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(exe, [exe, cli, "--home", home, "init", "--cwd", cwd])
output = b""
while b"Name" not in output:
    output += os.read(fd, 1024)
os.kill(pid, signal.SIGINT)
while True:
    try:
        chunk = os.read(fd, 1024)
        if not chunk:
            break
        output += chunk
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;
      const result = spawnSync(
        "python3",
        ["-c", python, node, cli, fixture.home, fixture.cwd],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(result.status, result.stderr).toBe(130);
      expect(result.stdout).toContain("Cancelled.");
      expect(result.stdout).not.toMatch(/\n\s+at /);
      expect(existsSync(join(fixture.home, "agentchannels.db"))).toBe(true);
      const store = new Persistence(join(fixture.home, "agentchannels.db"), {
        backupDirectory: join(fixture.home, "backups"),
      });
      expect(store.listAgents()).toEqual([]);
      store.close();
    },
  );

  it("sweeps expired Sessions without a running daemon", () => {
    // Retention only ran inside the daemon process, so an installation whose
    // daemon was stopped accumulated Session worktrees with no way to clear them.
    const fixture = repository();
    expect(
      run(["--home", fixture.home, "--json", "init", "--cwd", fixture.cwd])
        .status,
    ).toBe(0);

    const result = run(["--home", fixture.home, "--json", "sessions", "prune"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      removed: 0,
      preservedDirty: 0,
    });

    const human = run(["--home", fixture.home, "sessions", "prune"]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("No expired Sessions to prune");
  }, 60_000);

  it("reports a bad option value as a usage error, not an internal error", () => {
    // The value reached the coordinator and threw a plain Error, which no message
    // pattern matched, so an operator typo was reported as an internal defect.
    const fixture = repository();
    const result = run([
      "--home",
      fixture.home,
      "daemon",
      "--concurrency",
      "abc",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--concurrency");
    expect(result.stderr).not.toContain("unexpected internal error");
  });

  it.runIf(process.platform !== "win32")(
    "does not mistake an option value named daemon for the foreground command",
    () => {
      const fixture = repository();
      const python = `
import os, pty, signal, sys
exe, cli, home, cwd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(exe, [exe, cli, "--home", home, "init", "--cwd", cwd, "--name", "daemon"])
output = b""
while b"Connect a channel" not in output:
    output += os.read(fd, 1024)
os.kill(pid, signal.SIGINT)
while True:
    try:
        chunk = os.read(fd, 1024)
        if not chunk:
            break
        output += chunk
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;
      const result = spawnSync(
        "python3",
        ["-c", python, node, cli, fixture.home, fixture.cwd],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(result.status, result.stderr).toBe(130);
      expect(result.stdout).toContain("Cancelled.");
    },
    60_000,
  );

  it.runIf(process.platform !== "win32")(
    "reports required prompt EOF without hanging",
    () => {
      const fixture = repository();
      const python = `
import os, pty, sys
exe, cli, home, cwd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(exe, [exe, cli, "--home", home, "init", "--cwd", cwd])
output = b""
while b"Name" not in output:
    output += os.read(fd, 1024)
os.write(fd, b"\\r")
while b"Connect a channel" not in output:
    output += os.read(fd, 1024)
os.write(fd, b"\\x04")
while True:
    try:
        chunk = os.read(fd, 1024)
        if not chunk:
            break
        output += chunk
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;
      const result = spawnSync(
        "python3",
        ["-c", python, node, cli, fixture.home, fixture.cwd],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(result.status, result.stderr).toBe(9);
      expect(result.stdout).toContain("Error:");
      expect(result.stdout).toContain("Required input ended");
      expect(result.stdout).not.toMatch(/\n\s+at /);
    },
    60_000,
  );

  it("keeps source-checkout help and JSON init free of build chatter", () => {
    const help = runSource(["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: agentchannels");
    expect(help.stdout).not.toContain("CLI Building");

    const fixture = repository();
    const init = runSource([
      "--home",
      fixture.home,
      "--json",
      "init",
      "--cwd",
      fixture.cwd,
    ]);
    expect(init.status, init.stderr).toBe(0);
    expect(init.stderr).toBe("");
    expect(JSON.parse(init.stdout)).toMatchObject({
      status: "ready",
      agent: { name: "repository" },
    });
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "forwards source-checkout prompt cancellation with exit 130",
    () => {
      const fixture = repository();
      const python = `
import os, pty, signal, sys, time
exe, runner, home, cwd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(exe, [exe, runner, "--home", home, "init", "--cwd", cwd])
output = b""
deadline = time.time() + 45
while b"Name" not in output and time.time() < deadline:
    output += os.read(fd, 4096)
if b"Name" not in output:
    sys.stdout.buffer.write(output)
    sys.exit(124)
os.kill(pid, signal.SIGINT)
while True:
    try:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        output += chunk
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;
      const result = spawnSync(
        "python3",
        ["-c", python, node, sourceRunner, fixture.home, fixture.cwd],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(result.status, result.stderr).toBe(130);
      expect(result.stdout).toContain("Cancelled.");
      expect(result.stdout).not.toMatch(/\n\s+at /);
    },
    60_000,
  );
});
