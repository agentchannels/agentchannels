import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence } from "../src/persistence/store.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local database rollback", () => {
  it("requires acknowledgment, preserves the current database, and restores the migration backup", () => {
    const root = mkdtempSync(join(tmpdir(), "agentchannels-rollback-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "agentchannels.db");
    const backupDirectory = join(root, "backups");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00.000Z');
      CREATE TABLE installations (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL UNIQUE,
        relay_url TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      INSERT INTO installations VALUES (
        'in_keep', 'public-key', 'https://old.example.com',
        '2026-01-01T00:00:00.000Z', NULL
      );
    `);
    legacy.close();

    const migrated = new Persistence(databasePath, { backupDirectory });
    migrated.db
      .prepare("UPDATE installations SET relay_origin = ? WHERE id = ?")
      .run("https://new.example.com", "in_keep");
    migrated.close();
    const backupName = readdirSync(backupDirectory)[0];
    if (backupName === undefined)
      throw new Error("migration backup is missing");
    const backupPath = join(backupDirectory, backupName);

    const refused = spawnSync(
      process.execPath,
      [
        "scripts/restore-database.mjs",
        "--database",
        databasePath,
        "--backup",
        backupPath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(refused.status).not.toBe(0);
    const stillMigrated = new Database(databasePath, { readonly: true });
    expect(
      stillMigrated
        .prepare("SELECT relay_origin FROM installations WHERE id = ?")
        .pluck()
        .get("in_keep"),
    ).toBe("https://new.example.com");
    stillMigrated.close();

    execFileSync(
      process.execPath,
      [
        "scripts/restore-database.mjs",
        "--database",
        databasePath,
        "--backup",
        backupPath,
        "--acknowledge-post-backup-data-loss",
      ],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    const restored = new Database(databasePath, { readonly: true });
    expect(
      restored
        .prepare("SELECT relay_url FROM installations WHERE id = ?")
        .pluck()
        .get("in_keep"),
    ).toBe("https://old.example.com");
    restored.close();
    expect(
      readdirSync(root).some((name) => name.includes(".pre-restore-v1.0.0-")),
    ).toBe(true);
  });
});
