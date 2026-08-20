import { join } from "node:path";

import { commandEnvironment, logDirectory, shellQuote } from "./format.js";
import { assertExpectedServiceExit } from "./guards.js";
import type {
  ServiceDefinition,
  ServiceOperationResult,
  ServicePlatformFactory,
  ServiceStatus,
} from "./types.js";

const LINUX_PLATFORM = "linux" as NodeJS.Platform;

export const linuxServicePlatform: ServicePlatformFactory = (options) => {
  const name = `${options.serviceIdentifier}.service`;
  const directory = join(options.homeDirectory, ".config", "systemd", "user");
  const definitionPath = join(directory, name);
  const readStatus = (definition?: ServiceDefinition): Promise<ServiceStatus> =>
    adapter.status(definition);
  const result = async (
    definition: ServiceDefinition,
    operation: ServiceOperationResult["operation"],
  ): Promise<ServiceOperationResult> => ({
    ...(await readStatus(definition)),
    operation,
  });
  const installDefinition = async (definition: ServiceDefinition) => {
    await options.fileSystem.mkdir(directory);
    const logs = logDirectory(definition);
    if (logs !== undefined) await options.fileSystem.mkdir(logs);
    await options.fileSystem.write(
      definitionPath,
      renderSystemdUnit(definition),
    );
    await options.runCommand("systemctl", ["--user", "daemon-reload"]);
    await options.runCommand("systemctl", ["--user", "enable", name]);
  };
  const adapter: ReturnType<ServicePlatformFactory> = {
    platform: LINUX_PLATFORM,
    definitionPath,
    async install(definition) {
      await installDefinition(definition);
    },
    async reconcile(definition) {
      const current = await readStatus(definition);
      if (!current.installed) {
        await installDefinition(definition);
        await adapter.start();
        return result(definition, "installed");
      }
      if (!current.running) {
        if (!current.definitionMatches) await installDefinition(definition);
        await adapter.start();
        return result(definition, "started");
      }
      if (!current.definitionMatches) {
        await installDefinition(definition);
        await adapter.restart();
        return result(definition, "restarted");
      }
      return { ...current, operation: "unchanged" };
    },
    async start() {
      await options.runCommand("systemctl", ["--user", "start", name]);
    },
    async restart(definition) {
      if (definition !== undefined) {
        const current = await readStatus(definition);
        if (current.installed && !current.definitionMatches)
          await installDefinition(definition);
      }
      await options.runCommand("systemctl", ["--user", "restart", name]);
    },
    async stop() {
      const args = ["--user", "stop", name];
      const result = await options.runCommand("systemctl", args, {
        allowFailure: true,
      });
      assertExpectedServiceExit("systemctl", args, result, [0, 3, 4, 5]);
    },
    async uninstall() {
      const disableArgs = ["--user", "disable", "--now", name];
      const disableResult = await options.runCommand("systemctl", disableArgs, {
        allowFailure: true,
      });
      assertExpectedServiceExit(
        "systemctl",
        disableArgs,
        disableResult,
        [0, 3, 4, 5],
      );
      await options.fileSystem.remove(definitionPath);
      await options.runCommand("systemctl", ["--user", "daemon-reload"]);
    },
    async status(definition) {
      const content = await options.fileSystem.read(definitionPath);
      let running = false;
      if (content !== null) {
        const args = ["--user", "is-active", "--quiet", name];
        const result = await options.runCommand("systemctl", args, {
          allowFailure: true,
        });
        assertExpectedServiceExit("systemctl", args, result, [0, 3, 4]);
        running = result.exitCode === 0;
      }
      return {
        platform: LINUX_PLATFORM,
        supported: true,
        installed: content !== null,
        running,
        definitionMatches:
          content !== null &&
          (definition === undefined ||
            content === renderSystemdUnit(definition)),
        definitionPath,
        ...(definition === undefined
          ? {}
          : { command: definition.command, version: definition.version }),
      } satisfies ServiceStatus;
    },
  };
  return adapter;
};

export function renderSystemdUnit(definition: ServiceDefinition): string {
  const environment = commandEnvironment(
    definition.command,
    definition.version,
  );
  const command = [definition.command.executable, ...definition.command.args]
    .map(shellQuote)
    .join(" ");
  const environmentLines = Object.entries(environment)
    .map(([key, value]) => `Environment=${shellQuote(`${key}=${value}`)}`)
    .join("\n");
  const logs = logDirectory(definition);
  return [
    "[Unit]",
    "Description=AgentChannels background daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${command}`,
    environmentLines,
    ...(logs === undefined
      ? []
      : [
          `StandardOutput=append:${logs}/daemon.log`,
          `StandardError=append:${logs}/daemon.log`,
        ]),
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
