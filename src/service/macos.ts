import { join } from "node:path";

import {
  commandEnvironment,
  logDirectory,
  serviceName,
  xmlEscape,
} from "./format.js";
import type {
  ServiceDefinition,
  ServicePlatformFactory,
  ServiceStatus,
} from "./types.js";

const MACOS_PLATFORM = "darwin" as NodeJS.Platform;

export const macosServicePlatform: ServicePlatformFactory = (options) => {
  const label = serviceName();
  const directory = join(options.homeDirectory, "Library", "LaunchAgents");
  const definitionPath = join(directory, `${label}.plist`);
  const target = `gui/${String(options.uid)}/${label}`;
  return {
    platform: MACOS_PLATFORM,
    definitionPath,
    async install(definition) {
      await options.fileSystem.mkdir(directory);
      const logs = logDirectory(definition);
      if (logs !== undefined) await options.fileSystem.mkdir(logs);
      await options.fileSystem.write(
        definitionPath,
        renderLaunchAgent(definition),
      );
      await options.runCommand("launchctl", ["bootout", target], {
        allowFailure: true,
      });
      await options.runCommand("launchctl", [
        "bootstrap",
        `gui/${String(options.uid)}`,
        definitionPath,
      ]);
    },
    async start() {
      await options.runCommand("launchctl", ["kickstart", "-k", target]);
    },
    async stop() {
      await options.runCommand("launchctl", ["kill", "SIGTERM", target], {
        allowFailure: true,
      });
    },
    async uninstall() {
      await options.runCommand("launchctl", ["bootout", target], {
        allowFailure: true,
      });
      await options.fileSystem.remove(definitionPath);
    },
    async status(definition) {
      const content = await options.fileSystem.read(definitionPath);
      const running =
        content !== null &&
        (
          await options.runCommand("launchctl", ["print", target], {
            allowFailure: true,
          })
        ).exitCode === 0;
      return {
        platform: MACOS_PLATFORM,
        supported: true,
        installed: content !== null,
        running,
        definitionMatches:
          content !== null &&
          (definition === undefined ||
            content === renderLaunchAgent(definition)),
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

export function renderLaunchAgent(definition: ServiceDefinition): string {
  const environment = commandEnvironment(
    definition.command,
    definition.version,
  );
  const argumentsXml = [
    definition.command.executable,
    ...definition.command.args,
  ]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(environment)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const logs = logDirectory(definition);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(serviceName())}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentsXml,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environmentXml,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    ...(logs === undefined
      ? []
      : [
          "  <key>StandardOutPath</key>",
          `  <string>${xmlEscape(`${logs}/daemon.log`)}</string>`,
          "  <key>StandardErrorPath</key>",
          `  <string>${xmlEscape(`${logs}/daemon.log`)}</string>`,
        ]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
