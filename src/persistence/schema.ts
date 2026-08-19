import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { PRODUCT_VERSION } from "../version.js";

export const CURRENT_SCHEMA_VERSION = 3;

export type MigrationOptions = {
  filename: string;
  backupDirectory?: string;
  componentVersion?: string;
  now?: () => Date;
  backupDatabase?: (source: string, destination: string) => void;
};

function schemaVersion(db: Database.Database): number {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (table === undefined) return 0;
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get() as {
      version: number;
    }
  ).version;
}

function timestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function backupWithSqliteApi(source: string, destination: string): void {
  closeSync(openSync(destination, "wx", 0o600));
  const betterSqlitePath = createRequire(import.meta.url).resolve(
    "better-sqlite3",
  );
  const worker = `
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    process.umask(0o077);
    const require = createRequire(pathToFileURL(process.argv[1]));
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true });
    try { await db.backup(process.argv[3]); } finally { db.close(); }
  `;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      worker,
      betterSqlitePath,
      source,
      destination,
    ],
    { stdio: "pipe" },
  );
}

function createBackup(
  sourceSchema: number,
  options: MigrationOptions,
): string | null {
  if (options.filename === ":memory:") return null;
  const databasePath = resolve(options.filename);
  const backupDirectory = resolve(
    options.backupDirectory ?? join(dirname(databasePath), "backups"),
  );
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const version = (options.componentVersion ?? PRODUCT_VERSION).replace(
    /[^0-9A-Za-z.-]/g,
    "_",
  );
  const backupPath = join(
    backupDirectory,
    `agentchannels-v${version}-schema-${String(sourceSchema)}-${timestamp((options.now ?? (() => new Date()))())}.db`,
  );
  (options.backupDatabase ?? backupWithSqliteApi)(databasePath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function migrateToV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
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

    CREATE TABLE installations (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      relay_url TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );

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

    CREATE TABLE binding_setups (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      connector TEXT NOT NULL CHECK (connector IN ('linear', 'slack')),
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, connector)
    );

    CREATE TABLE access_grants (
      binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL CHECK (length(user_id) > 0),
      granted_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, user_id)
    );

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
    CREATE INDEX sessions_status_idx ON sessions(status);
    CREATE INDEX sessions_retention_idx ON sessions(retention_expires_at);

    CREATE TABLE interactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('question', 'permission', 'plan')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'denied', 'cancelled')),
      request_json TEXT NOT NULL,
      response_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX interactions_session_idx ON interactions(session_id);

    CREATE TABLE followups (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      remote_user_id TEXT NOT NULL CHECK (length(remote_user_id) > 0),
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (session_id, sequence)
    );
    CREATE INDEX followups_queue_idx ON followups(session_id, status, sequence);

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

    CREATE TABLE ingress_events (
      binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL CHECK (length(event_id) > 0),
      received_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, event_id)
    );
  `);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
  ).run(new Date().toISOString());
}

function migrateToV2(db: Database.Database): void {
  db.exec(`
    ALTER TABLE installations RENAME COLUMN relay_url TO relay_origin;
    ALTER TABLE installations RENAME COLUMN last_seen_at TO last_connected_at;
    ALTER TABLE installations ADD COLUMN enrolled_at TEXT;
    UPDATE installations
      SET enrolled_at = created_at
      WHERE relay_origin IS NOT NULL AND enrolled_at IS NULL;
  `);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)",
  ).run(new Date().toISOString());
}

function migrateToV3(db: Database.Database): void {
  db.exec(`
    ALTER TABLE binding_setups ADD COLUMN step TEXT NOT NULL DEFAULT 'selected'
      CHECK (step IN ('selected','admin_action','credentials','operator'));
    ALTER TABLE binding_setups ADD COLUMN artifact_path TEXT;
    ALTER TABLE binding_setups ADD COLUMN external_installation_id TEXT;
    ALTER TABLE binding_setups ADD COLUMN external_installation_name TEXT;
    ALTER TABLE binding_setups ADD COLUMN updated_at TEXT;
    ALTER TABLE binding_setups ADD COLUMN last_error TEXT;
    UPDATE binding_setups SET updated_at=created_at WHERE updated_at IS NULL;
  `);
  db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)",
  ).run(new Date().toISOString());
}

const migrations: Readonly<Record<number, (db: Database.Database) => void>> = {
  1: migrateToV1,
  2: migrateToV2,
  3: migrateToV3,
};

export function migrate(
  db: Database.Database,
  options: MigrationOptions,
): void {
  const sourceSchema = schemaVersion(db);
  if (sourceSchema > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${String(sourceSchema)} is newer than supported schema ${String(CURRENT_SCHEMA_VERSION)}`,
    );
  }
  if (sourceSchema === CURRENT_SCHEMA_VERSION) return;
  createBackup(sourceSchema, options);
  for (
    let targetSchema = sourceSchema + 1;
    targetSchema <= CURRENT_SCHEMA_VERSION;
    targetSchema += 1
  ) {
    const migration = migrations[targetSchema];
    if (migration === undefined) {
      throw new Error(`Missing migration for schema ${String(targetSchema)}`);
    }
    db.transaction(() => migration(db))();
  }
}
