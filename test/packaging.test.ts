import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const node = process.execPath;
const root = resolve(".");
const sourceRunner = resolve("scripts/start.mjs");
const buildLock = resolve(".agentchannels-build.lock");

beforeAll(() => {
  execFileSync(node, [sourceRunner, "--version"], {
    cwd: root,
    stdio: "ignore",
  });
}, 60_000);

describe("source and package distribution", () => {
  it("recovers a stale source-build lock without polluting CLI output", () => {
    rmSync(buildLock, { recursive: true, force: true });
    mkdirSync(buildLock);
    writeFileSync(join(buildLock, "pid"), "0");

    try {
      const result = spawnSync(node, [sourceRunner, "--help"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^Usage: agentchannels/m);
      expect(result.stdout).not.toMatch(/CLI Building|ESM Build|DTS Build/);
      expect(existsSync(buildLock)).toBe(false);
    } finally {
      rmSync(buildLock, { recursive: true, force: true });
    }
  });

  it("publishes only the built CLI, public entrypoint, and restore helper", () => {
    const result = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout) as {
      files: { path: string }[];
    };
    const paths = manifest.files.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "dist/cli.js",
        "dist/index.js",
        "scripts/restore-database.mjs",
      ]),
    );
    expect(paths).not.toEqual(
      expect.arrayContaining([
        "src/cli.ts",
        "test/cli-process.acceptance.test.ts",
        ".agentchannels-build.lock",
      ]),
    );
  });
});
