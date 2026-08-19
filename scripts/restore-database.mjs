import { chmodSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (!process.argv.includes("--acknowledge-post-backup-data-loss")) {
  throw new Error(
    "restore requires --acknowledge-post-backup-data-loss because newer local state will be replaced",
  );
}
const databaseArgument = argument("--database");
const backupArgument = argument("--backup");
if (databaseArgument === undefined || backupArgument === undefined) {
  throw new Error("restore requires --database and --backup");
}
const databasePath = resolve(databaseArgument);
const backupPath = resolve(backupArgument);
if (!existsSync(databasePath)) throw new Error("database does not exist");
if (!existsSync(backupPath)) throw new Error("backup does not exist");
if (databasePath === backupPath) {
  throw new Error("database and backup must be different files");
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = String(manifest.version).replace(/[^0-9A-Za-z.-]/g, "_");
const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "Z");
const preservedPath = join(
  dirname(databasePath),
  `${basename(databasePath)}.pre-restore-v${version}-${timestamp}.db`,
);

process.umask(0o077);
const current = new Database(databasePath, { readonly: true });
try {
  await current.backup(preservedPath);
} finally {
  current.close();
}
chmodSync(preservedPath, 0o600);

const backup = new Database(backupPath, { readonly: true });
try {
  await backup.backup(databasePath);
} catch (error) {
  const preserved = new Database(preservedPath, { readonly: true });
  try {
    await preserved.backup(databasePath);
  } finally {
    preserved.close();
  }
  throw error;
} finally {
  backup.close();
}
chmodSync(databasePath, 0o600);
process.stdout.write(
  `restored=${databasePath}\npreserved=${preservedPath}\nsource_backup=${backupPath}\n`,
);
