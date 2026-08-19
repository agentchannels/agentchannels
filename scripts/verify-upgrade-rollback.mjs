import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const previousArgument = argument("--previous-client-module");
if (previousArgument === undefined) {
  throw new Error("--previous-client-module is required");
}
const previous = await import(pathToFileURL(resolve(previousArgument)).href);
const candidate = await import(pathToFileURL(resolve("dist/index.js")).href);
if (typeof previous.Persistence !== "function") {
  throw new Error("previous stable package does not export Persistence");
}

const root = mkdtempSync(join(tmpdir(), "agentchannels-upgrade-"));
const databasePath = join(root, "agentchannels.db");
const backupDirectory = join(root, "backups");
try {
  const oldStore = new previous.Persistence(databasePath, { backupDirectory });
  const agent = oldStore.createAgent({
    id: "ag_upgrade",
    name: "Upgrade",
    cwd: "/repository",
  });
  const binding = oldStore.createBinding({
    id: "bd_upgrade",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "workspace",
  });
  oldStore.createBindingSetup({
    id: "setup_upgrade",
    agentId: agent.id,
    connector: "linear",
  });
  oldStore.grantAccess(binding.id, "allowed-user");
  oldStore.createSession({
    id: "ses_upgrade",
    bindingId: binding.id,
    remoteConversationId: "thread",
    cwd: "/worktree",
    worktreePath: "/worktree",
    baseCommit: "0123456789abcdef",
  });
  oldStore.createInstallation({
    id: "in_upgrade",
    publicKey: "preserved-public-key",
    relayUrl: "https://relay.example.com",
    relayOrigin: "https://relay.example.com",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  oldStore.close();
  rmSync(backupDirectory, { recursive: true, force: true });

  const upgraded = new candidate.Persistence(databasePath, { backupDirectory });
  if (
    upgraded.getInstallation("in_upgrade")?.publicKey !==
      "preserved-public-key" ||
    upgraded.getInstallation("in_upgrade")?.relayOrigin !==
      "https://relay.example.com" ||
    upgraded.getBinding("bd_upgrade")?.agentId !== "ag_upgrade" ||
    upgraded.listAccess("bd_upgrade").length !== 1 ||
    upgraded.getSession("ses_upgrade")?.worktreePath !== "/worktree" ||
    upgraded.listAllBindingSetups().length !== 1
  ) {
    throw new Error("candidate did not preserve previous stable state");
  }
  upgraded.close();

  const backups = existsSync(backupDirectory)
    ? readdirSync(backupDirectory).map((name) => join(backupDirectory, name))
    : [];
  if (backups.length > 1) {
    throw new Error("candidate created more than one pre-migration backup");
  }
  if (backups[0] !== undefined) {
    execFileSync(
      process.execPath,
      [
        "scripts/restore-database.mjs",
        "--database",
        databasePath,
        "--backup",
        backups[0],
        "--acknowledge-post-backup-data-loss",
      ],
      { stdio: "pipe" },
    );
  }

  const rolledBack = new previous.Persistence(databasePath, {
    backupDirectory,
  });
  if (
    rolledBack.getInstallation("in_upgrade")?.publicKey !==
      "preserved-public-key" ||
    rolledBack.getBinding("bd_upgrade")?.agentId !== "ag_upgrade"
  ) {
    throw new Error("previous stable package could not read rolled-back state");
  }
  rolledBack.close();
  process.stdout.write(
    `upgrade_rollback=passed\npre_migration_backup=${backups[0] === undefined ? "not-required" : backups[0]}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
