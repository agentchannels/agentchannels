import { join } from "node:path";

import {
  commandEnvironment,
  logDirectory,
  serviceName,
  shellQuote,
} from "./format.js";
import type {
  ServiceDefinition,
  ServicePlatformFactory,
  ServiceStatus,
} from "./types.js";

const LINUX_PLATFORM = "linux" as NodeJS.Platform;

export const linuxServicePlatform: ServicePlatformFactory = (options) => {
  const name = `${serviceName()}.service`;
  const directory = join(options.homeDirectory, ".config", "systemd", "user");
  const definitionPath = join(directory, name);
  return {
    platform: LINUX_PLATFORM,
    definitionPath,
    async install(definition) {
      await options.fileSystem.mkdir(directory);
      const logs = logDirectory(definition);
      if (logs !== undefined) await options.fileSystem.mkdir(logs);
      await options.fileSystem.write(
        definitionPath,
        renderSystemdUnit(definition),
      );
      await options.runCommand("systemctl", ["--user", "daemon-reload"]);
      await options.runCommand("systemctl", ["--user", "enable", name]);
    },
    async start() {
      await options.runCommand("systemctl", ["--user", "start", name]);
    },
    async stop() {
      await options.runCommand("systemctl", ["--user", "stop", name], {
        allowFailure: true,
      });
    },
    async uninstall() {
      await options.runCommand(
        "systemctl",
        ["--user", "disable", "--now", name],
        { allowFailure: true },
      );
      await options.fileSystem.remove(definitionPath);
      await options.runCommand("systemctl", ["--user", "daemon-reload"]);
    },
    async status(definition) {
      const content = await options.fileSystem.read(definitionPath);
      const running =
        content !== null &&
        (
          await options.runCommand(
            "systemctl",
            ["--user", "is-active", "--quiet", name],
            { allowFailure: true },
          )
        ).exitCode === 0;
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
        nextAction:
          content === null
            ? "Run agentchannels daemon install"
            : running
              ? "No action required"
              : "Run agentchannels daemon start",
      } satisfies ServiceStatus;
    },
  };
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
