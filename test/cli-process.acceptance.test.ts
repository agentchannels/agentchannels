import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Persistence } from "../src/persistence/store.js";

const roots: string[] = [];
const node = process.execPath;
const cli = resolve("dist/cli.js");

beforeAll(() => {
  execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

function repository(withHead = true) {
  const root = mkdtempSync(join(tmpdir(), "agentchannels-cli-process-"));
  roots.push(root);
  const cwd = join(root, "repository");
  const home = join(root, "home");
  execFileSync("git", ["init", "--initial-branch", "main", cwd], {
    stdio: "ignore",
  });
  if (withHead) {
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
  }
  return { root, cwd, home };
}

function run(args: string[], cwd?: string) {
  return spawnSync(node, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("CLI process boundary", () => {
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
      expect(result.stdout).toMatch(/Next:|No Bindings|No Sessions/);
    }

    const machine = run(
      ["--home", fixture.home, "--json", "status"],
      fixture.cwd,
    );
    expect(machine.status).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      status: "ready",
      actionRequired: false,
      currentAgentId: firstResult.agent.id,
    });
  });

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
    expect(missingHead.stderr).toContain("Next:");
    expect(missingHead.stderr).not.toMatch(/\n\s+at /);

    const usage = run(["--definitely-not-a-real-option"]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("unknown option");
    expect(usage.stderr).not.toMatch(/\n\s+at /);

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
  });

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
while b"Name [" not in output:
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
});
