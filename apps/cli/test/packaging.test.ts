import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

import { PRODUCT_VERSION } from "../src/version.ts";
import { compiledBinary } from "./helpers/fixtures.ts";

const outside = mkdtempSync(join(tmpdir(), "agentchannels-outside-"));
afterAll(() => rmSync(outside, { recursive: true, force: true }));

function execute(command: string, args: readonly string[]) {
  return spawnSync(command, args, {
    cwd: outside,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: outside, NO_COLOR: "1" },
    timeout: 60_000,
  });
}

describe("distribution", () => {
  it("runs the TypeScript entrypoint directly with no build step or chatter", () => {
    const result = execute(process.execPath, [resolve("src/cli.ts"), "--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Usage: agentchannels/m);
  });

  it("ships a self-contained binary that runs outside the source tree", () => {
    const binary = compiledBinary();
    const help = execute(binary, ["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toMatch(/^Usage: agentchannels/m);

    const version = execute(binary, ["--version"]);
    expect(version.stdout.trim()).toBe(PRODUCT_VERSION);
  }, 120_000);
});
