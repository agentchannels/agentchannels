import { Database } from "bun:sqlite";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  MIGRATIONS,
  migrate,
  type Migration,
  SchemaError,
} from "../src/database.ts";
import { cleanupDirectories, temporaryDirectory } from "./harness.ts";

afterEach(cleanupDirectories);

const addNotes: Migration = (db) =>
  db.run("CREATE TABLE notes (value TEXT NOT NULL)");

function versionOf(db: Database): number {
  return (
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0
  );
}

function databaseAtFirstSchema() {
  const directory = temporaryDirectory();
  const path = join(directory, "relay.sqlite3");
  const db = new Database(path, { create: true });
  migrate(db, path);
  db.run(
    "INSERT INTO installations (installation_id, public_key, created_at) VALUES ('in_keep', zeroblob(32), '2026-01-01T00:00:00.000Z')",
  );
  return { directory, path, db };
}

describe("migrate", () => {
  it("creates a fresh database without a backup", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "relay.sqlite3");
    const db = new Database(path, { create: true });
    migrate(db, path);
    expect(versionOf(db)).toBe(MIGRATIONS.length);
    expect(readdirSync(directory)).toEqual(["relay.sqlite3"]);
    db.close();
  });

  it("backs up an existing database before migrating it", () => {
    const { directory, path, db } = databaseAtFirstSchema();
    migrate(
      db,
      path,
      [...MIGRATIONS, addNotes],
      () => new Date("2026-03-04T05:06:07.000Z"),
    );
    expect(versionOf(db)).toBe(MIGRATIONS.length + 1);

    const backups = join(directory, "backups");
    const [name] = readdirSync(backups);
    expect(name).toMatch(
      /^agentchannels-relay-v.+-schema-1-20260304T050607Z\.sqlite3$/,
    );
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    const backupFile = join(backups, name ?? "");
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);

    const backup = new Database(backupFile, { readonly: true });
    expect(versionOf(backup)).toBe(1);
    expect(
      backup.query("SELECT installation_id FROM installations").all(),
    ).toEqual([{ installation_id: "in_keep" }]);
    backup.close();
    db.close();
  });

  it("does not migrate when the backup cannot be written", () => {
    const { directory, path, db } = databaseAtFirstSchema();
    writeFileSync(join(directory, "backups"), "not a directory");
    expect(() => migrate(db, path, [...MIGRATIONS, addNotes])).toThrow();
    expect(versionOf(db)).toBe(1);
    db.close();
  });

  it("refuses a schema newer than it knows", () => {
    const { path, db } = databaseAtFirstSchema();
    db.run("PRAGMA user_version = 9");
    expect(() => migrate(db, path)).toThrow(SchemaError);
    expect(versionOf(db)).toBe(9);
    db.close();
  });
});
