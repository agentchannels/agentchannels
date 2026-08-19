import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("usage: first-run-smoke.mjs <agentchannels-binary>");
const root = mkdtempSync(join(tmpdir(), "agentchannels-tarball-smoke-"));

function run(args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `agentchannels ${args.join(" ")} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function createRepository(path) {
  execFileSync("git", ["init", "--initial-branch", "main", path], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=AgentChannels Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: path, stdio: "ignore" },
  );
}

try {
  const repository = join(root, "repository");
  const home = join(root, "home");
  createRepository(repository);
  const first = JSON.parse(
    run(["--home", home, "--json", "init", "--cwd", repository]).stdout,
  );
  const second = JSON.parse(
    run(["--home", home, "--json", "init", "--cwd", repository]).stdout,
  );
  if (first.agent.id !== second.agent.id)
    throw new Error("idempotent init created a duplicate Agent");
  const status = JSON.parse(
    run(["--home", home, "--json", "status"], { cwd: repository }).stdout,
  );
  if (status.status !== "ready" || status.currentAgentId !== first.agent.id)
    throw new Error("global status did not reflect the initialized Agent");

  if (process.platform !== "win32") {
    const cancelledRepository = join(root, "cancelled-repository");
    const cancelledHome = join(root, "cancelled-home");
    createRepository(cancelledRepository);
    const python = `
import os, pty, signal, sys
binary, home, cwd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(binary, [binary, "--home", home, "init", "--cwd", cwd])
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
    const cancelled = spawnSync(
      "python3",
      ["-c", python, binary, cancelledHome, cancelledRepository],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (cancelled.status !== 130 || !cancelled.stdout.includes("Cancelled."))
      throw new Error(
        `cancellation contract failed (${String(cancelled.status)}): ${cancelled.stdout} ${cancelled.stderr}`,
      );
    const cancelledStatus = JSON.parse(
      run(["--home", cancelledHome, "--json", "status"]).stdout,
    );
    if (cancelledStatus.agents.length !== 0)
      throw new Error("cancelled init persisted an Agent before confirmation");
  }
  process.stdout.write("first-run tarball smoke passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
