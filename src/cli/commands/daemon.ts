import { AgentChannelsError } from "../../errors.ts";
import { startDaemon } from "../../daemon.ts";
import type { ServiceManager } from "../../service/manager.ts";
import type { CommandContext } from "../context.ts";
import { emit, needsAction, ok, type GlobalOptions } from "../output.ts";
import { positiveInteger } from "./shared.ts";

/** Run the daemon in the foreground, or manage the background service. */
export function registerDaemonCommands(context: CommandContext): void {
  const {
    program,
    formatter,
    services,
    serviceDefinition,
    assertStableServiceEntry,
  } = context;
  const daemon = program
    .command("daemon")
    .description("Run in the foreground or manage the background daemon")
    .addHelpText(
      "after",
      `
Foreground:
  agentchannels daemon

Background lifecycle:
  agentchannels daemon install|start|restart|stop|status|uninstall

Background services are per-user LaunchAgents on macOS and systemd user
services on Linux. Do not run these commands with sudo.`,
    );
  daemon
    .option("--concurrency <count>", "maximum simultaneous runtime turns", "2")
    .action(async (options: { concurrency: string }) => {
      await startDaemon({
        concurrency: positiveInteger(options.concurrency, "--concurrency"),
        ...(program.opts<GlobalOptions>().home === undefined
          ? {}
          : { home: program.opts<GlobalOptions>().home }),
      });
    });
  const lifecycleOutput = (
    result: Awaited<ReturnType<ServiceManager["install"]>>,
    message: string,
  ): void => {
    emit(program, ok({ service: result }), formatter().success(message));
  };
  daemon
    .command("install")
    .description("Install or reconcile the per-user background daemon")
    .addHelpText(
      "after",
      `
Installs and starts the per-user service. It does not require sudo.

Example:
  agentchannels daemon install`,
    )
    .action(async () => {
      const definition = serviceDefinition();
      assertStableServiceEntry(definition);
      const result = await services().reconcile(definition);
      if (result.operation === "unsupported")
        throw new AgentChannelsError(
          "SERVICE_MANAGER_FAILED",
          `Background services are unsupported on ${result.platform}.`,
          ["Run agentchannels daemon in the foreground."],
        );
      lifecycleOutput(result, "Background daemon running");
    });
  daemon
    .command("start")
    .description("Start the installed background daemon")
    .addHelpText(
      "after",
      `
The daemon must already be installed.

Example:
  agentchannels daemon start`,
    )
    .action(async () => {
      const result = await services().start(serviceDefinition());
      lifecycleOutput(result, "Daemon running");
    });
  daemon
    .command("restart")
    .description("Restart the installed background daemon")
    .addHelpText(
      "after",
      `
Use this after changing the installation Relay or daemon configuration.

Example:
  agentchannels daemon restart`,
    )
    .action(async () => {
      const definition = serviceDefinition();
      assertStableServiceEntry(definition);
      const result = await services().restart(definition);
      lifecycleOutput(result, "Daemon restarted");
    });
  daemon
    .command("stop")
    .description("Stop the background daemon")
    .addHelpText(
      "after",
      `
Stopping the service leaves configured Agents and Bindings unchanged.

Example:
  agentchannels daemon stop`,
    )
    .action(async () => {
      const result = await services().stop(serviceDefinition());
      lifecycleOutput(result, "Daemon stopped");
    });
  daemon
    .command("status")
    .description("Show background daemon installation and running state")
    .addHelpText(
      "after",
      `
Use the next step in this output to install or start the service when needed.

Examples:
  agentchannels daemon status
  agentchannels daemon status --json`,
    )
    .action(async () => {
      const status = await services().status(serviceDefinition());
      if (status.running) {
        emit(
          program,
          ok({ service: status }),
          formatter().success("Daemon running"),
        );
        return;
      }
      const nextStep = status.supported
        ? status.installed
          ? "Run agentchannels daemon start."
          : "Run agentchannels daemon install."
        : "Run agentchannels daemon in the foreground.";
      const state = status.installed
        ? "stopped"
        : status.supported
          ? "not installed"
          : "unsupported";
      emit(
        program,
        needsAction(nextStep, { service: status }),
        `${formatter().pending(`Daemon ${state}`)}\n${nextStep}`,
      );
    });
  daemon
    .command("uninstall")
    .description("Remove the per-user background daemon")
    .addHelpText(
      "after",
      `
Uninstalling stops and removes the service definition; local AgentChannels
state and provider credentials remain available.

Example:
  agentchannels daemon uninstall`,
    )
    .action(async () => {
      const result = await services().uninstall(serviceDefinition());
      lifecycleOutput(result, "Daemon uninstalled");
    });
}
