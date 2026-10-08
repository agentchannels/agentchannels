import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import manifest from "../package.json" with { type: "json" };

export type Migration = (db: Database) => void;

export const MIGRATIONS: readonly Migration[] = [
  (db) =>
    db.run(`
      CREATE TABLE installations (
        installation_id TEXT PRIMARY KEY,
        public_key BLOB NOT NULL CHECK (length(public_key) = 32),
        created_at TEXT NOT NULL,
        last_connected_at TEXT
      );
      CREATE TABLE bindings (
        binding_id TEXT PRIMARY KEY,
        connector TEXT NOT NULL,
        installation_id TEXT NOT NULL
          REFERENCES installations(installation_id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX bindings_installation_idx ON bindings(installation_id);
    `),
];

export class SchemaError extends Error {
  override readonly name = "SchemaError";
}

const IN_MEMORY = ":memory:";

function schemaVersion(db: Database): number {
  return (
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0
  );
}

function timestamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function backupPath(
  databasePath: string,
  schema: number,
  at: Date,
): string {
  return join(
    dirname(databasePath),
    "backups",
    `agentchannels-relay-v${manifest.version}-schema-${String(schema)}-${timestamp(at)}.sqlite3`,
  );
}

function backUp(db: Database, destination: string): void {
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  db.run("VACUUM INTO ?", [destination]);
  chmodSync(destination, 0o600);
}

export function migrate(
  db: Database,
  databasePath: string,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): void {
  const current = schemaVersion(db);
  const target = migrations.length;
  if (current > target)
    throw new SchemaError(
      `Database schema ${String(current)} is newer than supported schema ${String(target)}.`,
    );
  if (current === target) return;
  if (current > 0 && databasePath !== IN_MEMORY)
    backUp(db, backupPath(databasePath, current, now()));
  for (let version = current + 1; version <= target; version += 1) {
    const migration = migrations[version - 1];
    if (migration === undefined)
      throw new SchemaError(`Migration ${String(version)} is missing.`);
    db.transaction(() => {
      migration(db);
      db.run(`PRAGMA user_version = ${String(version)}`);
    })();
  }
}

export function openDatabase(databasePath: string): Database {
  if (databasePath !== IN_MEMORY)
    mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true, strict: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  try {
    migrate(db, databasePath);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
