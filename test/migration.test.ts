import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/store/migrations.ts";
import { Persistence } from "../src/store/store.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { root: string; database: string; backups: string } {
  const root = mkdtempSync(join(tmpdir(), "agentchannels-migration-"));
  directories.push(root);
  return {
    root,
    database: join(root, "agentchannels.db"),
    backups: join(root, "backups"),
  };
}

function downgradeToV1(database: string): void {
  const db = new Database(database);
  db.exec(`
    ALTER TABLE binding_setups DROP COLUMN last_error;
    ALTER TABLE binding_setups DROP COLUMN updated_at;
    ALTER TABLE binding_setups DROP COLUMN external_installation_name;
    ALTER TABLE binding_setups DROP COLUMN external_installation_id;
    ALTER TABLE binding_setups DROP COLUMN artifact_path;
    ALTER TABLE binding_setups DROP COLUMN step;
    ALTER TABLE installations DROP COLUMN enrolled_at;
    ALTER TABLE installations RENAME COLUMN relay_origin TO relay_url;
    ALTER TABLE installations RENAME COLUMN last_connected_at TO last_seen_at;
    DROP TABLE agent_runtime_state;
    DELETE FROM schema_migrations WHERE version >= 2;
  `);
  db.close();
}

describe("local database migrations", () => {
  it("backs up schema 1 through SQLite before migrating and preserves state", () => {
    const paths = fixture();
    const initial = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    const agent = initial.createAgent({
      id: "ag_preserved",
      name: "Preserved",
      cwd: "/repository",
    });
    const binding = initial.createBinding({
      id: "bd_preserved",
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "operator",
      externalInstallationId: "workspace",
    });
    initial.createBindingSetup({
      id: "setup_preserved",
      agentId: agent.id,
      connector: "linear",
    });
    initial.grantAccess(binding.id, "alice");
    initial.createSession({
      id: "ses_preserved",
      bindingId: binding.id,
      remoteConversationId: "thread",
      cwd: "/repository",
      worktreePath: "/worktree/preserved",
      baseCommit: "0123456789abcdef",
    });
    initial.createInstallation({
      id: "in_preserved",
      publicKey: "public-key",
      relayOrigin: "https://relay.old.example",
      createdAt: "2026-01-01T00:00:00.000Z",
      enrolledAt: "2026-01-01T00:00:00.000Z",
    });
    initial.close();
    downgradeToV1(paths.database);
    rmSync(paths.backups, { recursive: true, force: true });

    const migrated = new Persistence(paths.database, {
      backupDirectory: paths.backups,
      componentVersion: "1.2.3",
      migrationNow: () => new Date("2026-08-19T12:34:56.000Z"),
    });
    const backupFiles = readdirSync(paths.backups);
    expect(backupFiles).toEqual([
      "agentchannels-v1.2.3-schema-1-20260819T123456Z.db",
    ]);
    const backupPath = join(paths.backups, backupFiles[0] as string);
    expect(statSync(paths.backups).mode & 0o777).toBe(0o700);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    expect(
      (
        backup
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version,
    ).toBe(1);
    expect(
      (
        backup.prepare("SELECT COUNT(*) AS count FROM agents").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    backup.close();
    expect(migrated.getInstallation("in_preserved")).toMatchObject({
      relayOrigin: "https://relay.old.example",
      enrolledAt: "2026-01-01T00:00:00.000Z",
    });
    expect(migrated.getAgent("ag_preserved")?.name).toBe("Preserved");
    expect(migrated.getBinding("bd_preserved")?.agentId).toBe("ag_preserved");
    expect(migrated.listAllBindingSetups()).toHaveLength(1);
    expect(migrated.listAccess("bd_preserved")).toHaveLength(1);
    expect(migrated.getSession("ses_preserved")?.worktreePath).toBe(
      "/worktree/preserved",
    );
    migrated.close();
  });

  it("keeps rows that a rebuilt parent table would cascade away", () => {
    // Migrations that rebuild a table DROP the original. With foreign key
    // enforcement left on, that fires ON DELETE CASCADE and silently deletes
    // every Session, grant, and delivery hanging off it.
    const paths = fixture();
    const initial = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    const agent = initial.createAgent({
      id: "ag_cascade",
      name: "Cascade",
      cwd: "/repository",
    });
    const binding = initial.createBinding({
      id: "bd_cascade",
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "operator",
      externalInstallationId: "workspace",
    });
    initial.grantAccess(binding.id, "alice");
    const session = initial.createSession({
      id: "ss_cascade",
      bindingId: binding.id,
      remoteConversationId: "thread",
      cwd: "/worktree",
      worktreePath: "/worktree",
      baseCommit: "head",
    });
    initial.enqueueDelivery({
      sessionId: session.id,
      connector: "slack",
      remoteConversationId: "thread",
      kind: "final",
      body: "done",
    });
    // Reopen at the current schema, forcing the rebuild migrations to run.
    initial.db.pragma("user_version = 0");
    initial.db.prepare("DELETE FROM schema_migrations WHERE version > 3").run();
    initial.db.exec("DROP TABLE agent_runtime_state;");
    initial.close();

    const migrated = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    try {
      expect(migrated.getAgent("ag_cascade")?.name).toBe("Cascade");
      expect(migrated.getBinding("bd_cascade")?.agentId).toBe("ag_cascade");
      expect(migrated.listAccess("bd_cascade")).toHaveLength(1);
      expect(migrated.getSession("ss_cascade")?.worktreePath).toBe("/worktree");
      expect(migrated.claimDueDeliveries(10)).toHaveLength(1);
      expect(
        migrated.db.pragma("foreign_keys", { simple: true }) as number,
      ).toBe(1);
      expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("refuses newer schemas before creating a backup", () => {
    const paths = fixture();
    const store = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    store.close();
    const db = new Database(paths.database);
    db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)",
    ).run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
    const expectedBytes = db.serialize();
    db.close();
    const before = readdirSync(paths.backups);
    expect(
      () =>
        new Persistence(paths.database, {
          backupDirectory: paths.backups,
        }),
    ).toThrow("newer than supported");
    expect(readdirSync(paths.backups)).toEqual(before);
    const unchanged = new Database(paths.database, { readonly: true });
    expect(unchanged.serialize()).toEqual(expectedBytes);
    unchanged.close();
  });

  it("leaves the source schema untouched when backup fails", () => {
    const paths = fixture();
    const initial = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    initial.close();
    downgradeToV1(paths.database);
    const backupDatabase = vi.fn(() => {
      throw new Error("backup unavailable");
    });
    expect(
      () =>
        new Persistence(paths.database, {
          backupDirectory: paths.backups,
          backupDatabase,
        }),
    ).toThrow("backup unavailable");
    expect(backupDatabase).toHaveBeenCalledOnce();
    const db = new Database(paths.database, { readonly: true });
    expect(
      (
        db
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get() as {
          version: number;
        }
      ).version,
    ).toBe(1);
    db.close();
  });

  it("exempts in-memory databases from backup", () => {
    const backupDatabase = vi.fn();
    const store = new Persistence(":memory:", { backupDatabase });
    expect(backupDatabase).not.toHaveBeenCalled();
    store.close();
  });
});
