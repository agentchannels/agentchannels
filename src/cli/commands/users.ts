import type { CommandContext } from "../context.ts";
import { emit, ok, renderTable } from "../output.ts";
import { resolveAgent, resolveBinding, searchUsers } from "./shared.ts";

/** Find stable provider user IDs to use with access grants. */
export function registerUsersCommands(context: CommandContext): void {
  const {
    program,
    prompt,
    interactive,
    formatter,
    openStore,
    credentials,
    connectors,
  } = context;
  const users = program
    .command("users")
    .description("Find provider users for access grants")
    .addHelpText(
      "after",
      `
Search uses a configured Slack or Linear Binding and returns stable provider
user IDs for access grants.

Example:
  agentchannels users search alice --binding bd_...`,
    );
  users.action(() => users.outputHelp());
  users
    .command("search")
    .description("Search by name or email and print stable provider user IDs")
    .argument("<query>", "provider user name or email")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "provider Binding to search")
    .addHelpText(
      "after",
      `
Example:
  agentchannels users search alice --binding bd_...

Use the returned stable ID with agentchannels access add --user <id>.`,
    )
    .action(
      async (query: string, options: { agent?: string; binding?: string }) => {
        const store = openStore();
        try {
          const selectedAgent = await resolveAgent(
            store,
            options.agent,
            interactive(),
            prompt,
          );
          const selected = await resolveBinding(
            store,
            selectedAgent,
            options.binding,
            interactive(),
            prompt,
          );
          const results = await searchUsers(
            selected,
            query,
            await connectors(),
            credentials(),
          );
          emit(
            program,
            ok({ users: results }),
            renderTable(
              results.map((user) => [
                { header: "NAME", value: user.name },
                { header: "EMAIL", value: user.email ?? "" },
                { header: "ID", value: user.id },
              ]),
              "No users found",
              formatter(),
            ),
          );
        } finally {
          store.close();
        }
      },
    );
}
