import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence } from "../src/store/store.ts";
import { PRODUCT_VERSION } from "../src/version.ts";

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
      CREATE TABLE binding_setups (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) > 0),
        cwd TEXT NOT NULL,
        additional_directories_json TEXT NOT NULL DEFAULT '[]',
        runtime TEXT NOT NULL CHECK (runtime = 'claude-code'),
        created_at TEXT NOT NULL
      );
      CREATE INDEX agents_cwd_idx ON agents(cwd);
      CREATE TABLE bindings (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        connector TEXT NOT NULL CHECK (connector IN ('linear', 'slack')),
        operator_user_id TEXT NOT NULL CHECK (length(operator_user_id) > 0),
        external_installation_id TEXT NOT NULL CHECK (length(external_installation_id) > 0),
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, connector, external_installation_id)
      );
      CREATE INDEX bindings_agent_id_idx ON bindings(agent_id);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        remote_conversation_id TEXT NOT NULL CHECK (length(remote_conversation_id) > 0),
        runtime_session_id TEXT,
        cwd TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'stopped')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        retention_expires_at TEXT,
        UNIQUE (binding_id, remote_conversation_id)
      );
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        connector TEXT NOT NULL CHECK (connector IN ('linear', 'slack')),
        remote_conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('progress', 'final', 'question', 'permission', 'plan', 'stopped', 'error')),
        body TEXT NOT NULL,
        metadata_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'retrying', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX deliveries_due_idx ON deliveries(status, next_attempt_at);
      CREATE INDEX deliveries_session_idx ON deliveries(session_id);
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
      readdirSync(root).some((name) =>
        name.includes(`.pre-restore-v${PRODUCT_VERSION}-`),
      ),
    ).toBe(true);
  });
});
