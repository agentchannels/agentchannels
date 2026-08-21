import { Option } from "commander";

import { AgentChannelsError } from "../../errors.ts";
import { HOSTED_RELAY_ORIGIN, parseRelayOrigin } from "../../relay/origin.ts";
import type { CommandContext } from "../context.ts";
import { emit } from "../output.ts";
import { readStandardInput } from "./shared.ts";

/** Select or inspect the installation-wide Relay. */
export function registerRelayCommands(context: CommandContext): void {
  const {
    program,
    prompt,
    interactive,
    formatter,
    openStore,
    openExistingStore,
    relay: relayManager,
    services,
    serviceDefinition,
    assertStableServiceEntry,
  } = context;
  const relay = program
    .command("relay")
    .description("Select or inspect the installation-wide AgentChannels Relay")
    .addHelpText(
      "after",
      `
Hosted Relay is the default for normal agentchannels init.
Use relay use only for an explicit hosted/self-hosted installation cutover.

Examples:
  agentchannels relay status
  agentchannels relay use --hosted
  agentchannels relay use --url https://relay.example.com --enrollment-token-stdin`,
    );
  const showRelayStatus = (): void => {
    const store = openExistingStore();
    try {
      const status =
        store === undefined
          ? { status: "uninitialized" as const }
          : relayManager(store).status();
      emit(
        program,
        status,
        status.status === "uninitialized"
          ? `${formatter().pending("Relay uninitialized")}\nRun agentchannels init to connect a channel.`
          : formatter().success("Relay configured"),
      );
    } finally {
      store?.close();
    }
  };
  relay.action(showRelayStatus);
  relay
    .command("status")
    .description("Show the selected Relay and enrollment state")
    .addHelpText(
      "after",
      `
The Relay is selected once for the local installation and shared by all
Agents and Bindings.

Examples:
  agentchannels relay status
  agentchannels relay status --json`,
    )
    .action(showRelayStatus);
  relay
    .command("use")
    .description("Select the hosted or a self-hosted Relay")
    .addOption(
      new Option("--hosted", "select the official hosted Relay").conflicts(
        "url",
      ),
    )
    .addOption(
      new Option("--url <origin>", "self-hosted HTTPS origin").conflicts(
        "hosted",
      ),
    )
    .addOption(
      new Option(
        "--enrollment-token-stdin",
        "read self-hosted enrollment authorization from stdin",
      ).conflicts("hosted"),
    )
    .option(
      "--acknowledge-binding-reconfiguration",
      "acknowledge provider webhook URL changes",
    )
    .addHelpText(
      "after",
      `
Hosted is the normal default. Use --url only for an explicit self-hosted
origin; self-hosted automation must provide enrollment authorization on stdin.
Changing Relay with existing Bindings requires
--acknowledge-binding-reconfiguration after reviewing the returned URLs.

Examples:
  agentchannels relay use --hosted
  agentchannels relay use --url https://relay.example.com \\
    --enrollment-token-stdin < enrollment-token`,
    )
    .action(
      async (options: {
        hosted?: boolean;
        url?: string;
        enrollmentTokenStdin?: boolean;
        acknowledgeBindingReconfiguration?: boolean;
      }) => {
        let origin = options.hosted ? HOSTED_RELAY_ORIGIN : options.url;
        if (origin === undefined) {
          if (!interactive())
            throw new AgentChannelsError(
              "USAGE_ERROR",
              "relay use requires --hosted or --url.",
              ["Pass --hosted, or --url with a self-hosted HTTPS origin."],
            );
          origin = await prompt.input("Self-hosted Relay URL");
        }
        const normalized = parseRelayOrigin(origin).origin;
        const store = openStore();
        try {
          const manager = relayManager(store);
          const requirement = manager.preview(normalized);
          let acknowledged = options.acknowledgeBindingReconfiguration === true;
          if (requirement !== undefined && !acknowledged) {
            if (!interactive()) {
              emit(program, requirement, JSON.stringify(requirement, null, 2));
              return;
            }
            acknowledged = await prompt.confirm(
              "Update provider webhook URLs?",
              false,
            );
            if (!acknowledged) {
              emit(program, { status: "unchanged" }, "Relay unchanged.");
              return;
            }
          }
          let enrollmentToken: string | undefined;
          if (normalized !== HOSTED_RELAY_ORIGIN) {
            if (options.enrollmentTokenStdin)
              enrollmentToken = (await readStandardInput(true)).trim();
            else if (!interactive())
              throw new AgentChannelsError(
                "USAGE_ERROR",
                "A self-hosted Relay requires enrollment authorization.",
                [
                  "Pass --enrollment-token-stdin and provide the token on stdin.",
                ],
              );
            else {
              const entered = await prompt.secret(
                "Enrollment token (blank for explicit open enrollment)",
              );
              enrollmentToken = entered || undefined;
            }
          }
          const result = await manager.use({
            origin: normalized,
            ...(enrollmentToken === undefined ? {} : { enrollmentToken }),
            ...(acknowledged
              ? { acknowledgeBindingReconfiguration: true }
              : {}),
          });
          if (result.action === "restart_daemon") {
            const service = services();
            const current = await service.status(serviceDefinition());
            if (current.installed) {
              const definition = serviceDefinition();
              assertStableServiceEntry(definition);
              await service.restart(definition);
            }
          }
          emit(
            program,
            result,
            result.action === "restart_daemon" && result.bindings.length > 0
              ? `${formatter().success("Relay selected")}\nUpdate the listed provider webhooks.`
              : formatter().success("Relay selected"),
          );
        } finally {
          store.close();
        }
      },
    );
}
