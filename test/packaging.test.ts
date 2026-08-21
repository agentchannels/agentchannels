import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const node = process.execPath;
const root = resolve(".");
const sourceEntry = resolve("src/cli.ts");

describe("source and package distribution", () => {
  it("runs the TypeScript entrypoint directly with no build step or build chatter", () => {
    const result = spawnSync(node, [sourceEntry, "--help"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Usage: agentchannels/m);
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
      ]),
    );
    // Packing runs the real packer over the whole tree and is slow under load.
  }, 90_000);
});
