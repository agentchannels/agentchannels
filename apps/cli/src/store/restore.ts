import { Database } from "bun:sqlite";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { invalidState } from "../errors.ts";
import { PRODUCT_VERSION } from "../version.ts";

export type RestoreResult = Readonly<{
  restored: string;
  preserved: string;
  source: string;
}>;

function timestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function copyDatabase(source: string, destination: string): void {
  const database = new Database(source, { readonly: true });
  try {
    database.run("VACUUM INTO ?", [destination]);
  } finally {
    database.close();
  }
  chmodSync(destination, 0o600);
}

function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${path}${suffix}`, { force: true });
}

export function restoreDatabase(options: {
  database: string;
  backup: string;
  now?: Date;
}): RestoreResult {
  const database = resolve(options.database);
  const backup = resolve(options.backup);
  if (!existsSync(database))
    throw invalidState(`Database ${database} does not exist.`);
  if (!existsSync(backup))
    throw invalidState(`Backup ${backup} does not exist.`);
  if (database === backup)
    throw invalidState("The database and the backup must be different files.");

  const version = PRODUCT_VERSION.replace(/[^0-9A-Za-z.-]/g, "_");
  const preserved = join(
    dirname(database),
    `${basename(database)}.pre-restore-v${version}-${timestamp(options.now ?? new Date())}.db`,
  );
  copyDatabase(database, preserved);
  removeDatabase(database);
  try {
    copyDatabase(backup, database);
  } catch (error) {
    removeDatabase(database);
    copyDatabase(preserved, database);
    throw error;
  }
  return { restored: database, preserved, source: backup };
}
