import { invalidState } from "../../errors.ts";
import { restoreDatabase } from "../../store/restore.ts";
import type { CommandContext } from "../context.ts";
import { emit, ok } from "../output.ts";

export function registerDatabaseCommands(context: CommandContext): void {
  const { program, paths } = context;
  const database = program
    .command("database")
    .description("Restore local state from a migration backup");
  database.action(() => database.outputHelp());
  database
    .command("restore")
    .description("Replace the local database with a migration backup")
    .requiredOption("--backup <path>", "migration backup to restore")
    .option("--database <path>", "database to replace")
    .option(
      "--acknowledge-post-backup-data-loss",
      "confirm that state written after the backup is replaced",
    )
    .addHelpText(
      "after",
      `
Stop the daemon first. The current database is preserved beside itself
before it is replaced.

Example:
  agentchannels database restore \\
    --backup ~/.agentchannels/backups/agentchannels-v0.3.0-schema-5-TIMESTAMP.db \\
    --acknowledge-post-backup-data-loss`,
    )
    .action(
      (options: {
        backup: string;
        database?: string;
        acknowledgePostBackupDataLoss?: boolean;
      }) => {
        if (options.acknowledgePostBackupDataLoss !== true)
          throw invalidState(
            "Restoring replaces state written after the backup was taken.",
            ["Rerun with --acknowledge-post-backup-data-loss."],
          );
        const result = restoreDatabase({
          database: options.database ?? paths().database,
          backup: options.backup,
        });
        emit(
          program,
          ok(result),
          [
            `Restored ${result.restored}`,
            `Preserved previous state at ${result.preserved}`,
          ].join("\n"),
        );
      },
    );
}
