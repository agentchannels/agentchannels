import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error("pnpm executable path is unavailable");

const build = spawnSync(process.execPath, [packageManager, "build"], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const cli = spawnSync(
  process.execPath,
  [resolve(import.meta.dirname, "../dist/cli.js"), ...args],
  {
    stdio: "inherit",
  },
);
if (cli.signal) process.kill(process.pid, cli.signal);
process.exit(cli.status ?? 1);
