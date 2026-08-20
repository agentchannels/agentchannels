import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const cliPath = join(projectRoot, "dist", "cli.js");
const buildLock = join(projectRoot, ".agentchannels-build.lock");

function newestMtime(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(
    stat.mtimeMs,
    ...readdirSync(path).map((entry) => newestMtime(join(path, entry))),
  );
}

function buildRequired() {
  if (!existsSync(cliPath)) return true;
  const outputMtime = statSync(cliPath).mtimeMs;
  return ["src", "tsup.config.ts", "package.json", "pnpm-lock.yaml"]
    .filter((path) => existsSync(join(projectRoot, path)))
    .some((path) => newestMtime(join(projectRoot, path)) > outputMtime);
}

function runBuild() {
  const packageManager = process.env.npm_execpath;
  const command = packageManager === undefined ? "pnpm" : process.execPath;
  const args =
    packageManager === undefined ? ["build"] : [packageManager, "build"];
  const build = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: ["inherit", "ignore", "ignore"],
  });
  if (build.status === 0) return 0;
  if (build.error) return 1;
  if (build.signal) {
    const signalNumber = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGQUIT: 3,
      SIGTERM: 15,
    }[build.signal];
    return signalNumber === undefined ? 1 : 128 + signalNumber;
  }
  return build.status ?? 1;
}

function ownerIsRunning() {
  try {
    const pid = Number.parseInt(
      readFileSync(join(buildLock, "pid"), "utf8"),
      10,
    );
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      try {
        return Date.now() - statSync(buildLock).mtimeMs < 5_000;
      } catch {
        return false;
      }
    }
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function acquireBuildLock() {
  while (true) {
    try {
      mkdirSync(buildLock);
      writeFileSync(join(buildLock, "pid"), String(process.pid));
      return true;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      if (!ownerIsRunning()) {
        rmSync(buildLock, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

if (existsSync(buildLock) && !ownerIsRunning())
  rmSync(buildLock, { recursive: true, force: true });

let buildExitCode = 0;
if (buildRequired()) {
  acquireBuildLock();
  try {
    if (buildRequired()) buildExitCode = runBuild();
  } finally {
    rmSync(buildLock, { recursive: true, force: true });
  }
}

if (buildExitCode !== 0) {
  process.stderr.write(
    "AgentChannels source build failed; run pnpm build for diagnostics.\n",
  );
  process.exit(buildExitCode);
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const cli = spawn(process.execPath, [cliPath, ...args], {
  cwd: projectRoot,
  stdio: "inherit",
});
let interrupted = false;
const forwardInterrupt = () => {
  interrupted = true;
  cli.kill("SIGINT");
};
process.once("SIGINT", forwardInterrupt);

cli.once("error", () => {
  process.off("SIGINT", forwardInterrupt);
  process.stderr.write("AgentChannels could not start the source CLI.\n");
  process.exitCode = 1;
});
cli.once("exit", (code, signal) => {
  process.off("SIGINT", forwardInterrupt);
  if (signal === "SIGINT" || interrupted) {
    process.exitCode = 130;
    return;
  }
  process.exitCode = code ?? 1;
});
