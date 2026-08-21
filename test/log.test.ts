import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../src/log.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentchannels-log-"));
  roots.push(directory);
  return directory;
}

class Captured {
  readonly lines: string[] = [];
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
}

describe("daemon log", () => {
  it("timestamps and levels every line", () => {
    const stream = new Captured();
    const log = createLogger({
      stream: stream as unknown as NodeJS.WritableStream,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    log.info("Relay connected.");
    log.error("Delivery worker failed.");
    expect(stream.lines).toEqual([
      "2026-01-01T00:00:00.000Z info Relay connected.\n",
      "2026-01-01T00:00:00.000Z error Delivery worker failed.\n",
    ]);
  });

  it("redacts, because a log file is an output path like any other", () => {
    const stream = new Captured();
    const log = createLogger({
      stream: stream as unknown as NodeJS.WritableStream,
    });
    log.error('provider rejected botToken="xoxb-should-not-appear"');
    expect(stream.lines.join("")).not.toContain("xoxb-should-not-appear");
  });

  it("rotates instead of growing without bound", () => {
    // The service definitions redirect output with `append`, which never
    // truncates, so an installation that stays up accumulates forever.
    const directory = root();
    const file = join(directory, "daemon.log");
    writeFileSync(file, "x".repeat(200));
    const log = createLogger({
      file,
      stream: new Captured() as unknown as NodeJS.WritableStream,
      maxBytes: 100,
      keep: 2,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    log.info("after rotation");
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(200));
    expect(readFileSync(file, "utf8")).toBe(
      "2026-01-01T00:00:00.000Z info after rotation\n",
    );
  });
});
