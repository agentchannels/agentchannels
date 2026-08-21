import { AgentChannelsError } from "../../errors.ts";
import type { CommandContext } from "../context.ts";
import { emit, ok, renderTable } from "../output.ts";
import { resolveAgent, resolveBinding, searchUsers } from "./shared.ts";

/** Grant, list, and revoke shared-user access to a Binding. */
export function registerAccessCommands(context: CommandContext): void {
  const {
    program,
    prompt,
    interactive,
    formatter,
    openStore,
    credentials,
    connectors,
  } = context;
  const access = program
    .command("access")
    .description("Manage shared-user access for a Binding")
    .addHelpText(
      "after",
      `
Interactive mode selects the Agent, Binding, and provider user when omitted.

Examples:
  agentchannels access add
  agentchannels access list --binding bd_...
  agentchannels access remove --binding bd_... --user PLATFORM_USER_ID`,
    );
  access.action(() => access.outputHelp());
  access
    .command("add")
    .description("Grant a provider user access to a Binding")
    .option("--user <id>", "stable provider user ID for non-interactive use")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "target Binding ID")
    .addHelpText(
      "after",
      `
Human mode searches the provider when --user is omitted. Automation must pass
--agent, --binding, and --user.

Example:
  agentchannels access add --agent ag_... --binding bd_... --user U123...`,
    )
    .action(
      async (options: { user?: string; agent?: string; binding?: string }) => {
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
          let userId = options.user;
          if (userId === undefined) {
            if (!interactive())
              throw new AgentChannelsError(
                "USAGE_ERROR",
                "--user is required in non-interactive mode.",
                ["Pass --user with an ID from agentchannels users search."],
              );
            const results = await searchUsers(
              selected,
              await prompt.input("Search by name or email"),
              await connectors(),
              credentials(),
            );
            if (results.length === 0)
              throw new AgentChannelsError(
                "USAGE_ERROR",
                "No matching users found.",
                ["Search again with a different name or email."],
              );
            userId = await prompt.select(
              "User",
              results.map((user) => ({
                value: user.id,
                label: user.name,
                ...(user.email === null ? {} : { description: user.email }),
              })),
            );
          }
          const grant = store.grantAccess(selected.id, userId);
          emit(
            program,
            ok({ grant }),
            `Granted access via ${selected.connector}`,
          );
        } finally {
          store.close();
        }
      },
    );
  access
    .command("list")
    .description("List users who can use a Binding")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "target Binding ID")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels access list --binding bd_...
  agentchannels access list --agent ag_... --binding bd_... --json`,
    )
    .action(async (options: { agent?: string; binding?: string }) => {
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
        const grants = store.listAccess(selected.id);
        emit(
          program,
          ok({ grants }),
          renderTable(
            grants.map((item) => [
              { header: "USER", value: item.userId },
              { header: "GRANTED", value: item.grantedAt },
            ]),
            "No shared users",
            formatter(),
          ),
        );
      } finally {
        store.close();
      }
    });
  access
    .command("remove")
    .description("Revoke a provider user's Binding access")
    .requiredOption("--user <id>", "stable provider user ID")
    .option("--agent <id>", "target Agent ID")
    .option("--binding <id>", "target Binding ID")
    .addHelpText(
      "after",
      `
Examples:
  agentchannels access remove --binding bd_... --user U123...
  agentchannels access remove --agent ag_... --binding bd_... --user U123...`,
    )
    .action(
      async (options: { user: string; agent?: string; binding?: string }) => {
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
          const removed = store.revokeAccess(selected.id, options.user);
          emit(
            program,
            ok({ removed }),
            removed ? "Access removed" : "No matching grant",
          );
        } finally {
          store.close();
        }
      },
    );
}
