import { join } from "node:path";

import {
  commandEnvironment,
  logDirectory,
  serviceName,
  xmlEscape,
} from "./definition.ts";
import { assertExpectedServiceExit } from "./guards.ts";
import type {
  ServiceDefinition,
  ServiceOperationResult,
  ServicePlatformFactory,
  ServiceStatus,
} from "./types.ts";

const MACOS_PLATFORM = "darwin" as NodeJS.Platform;

export const macosServicePlatform: ServicePlatformFactory = (options) => {
  const label = options.serviceIdentifier;
  const directory = join(options.homeDirectory, "Library", "LaunchAgents");
  const definitionPath = join(directory, `${label}.plist`);
  const target = `gui/${String(options.uid)}/${label}`;
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
      renderLaunchAgent(definition, label),
    );
    const bootoutArgs = ["bootout", target];
    const bootoutResult = await options.runCommand("launchctl", bootoutArgs, {
      allowFailure: true,
    });
    assertExpectedServiceExit("launchctl", bootoutArgs, bootoutResult, [0, 3]);
    await options.runCommand("launchctl", [
      "bootstrap",
      `gui/${String(options.uid)}`,
      definitionPath,
    ]);
  };
  const adapter: ReturnType<ServicePlatformFactory> = {
    platform: MACOS_PLATFORM,
    definitionPath,
    async install(definition) {
      await installDefinition(definition);
    },
    async reconcile(definition) {
      const current = await readStatus(definition);
      if (!current.installed) {
        await installDefinition(definition);
        return result(definition, "installed");
      }
      if (!current.running) {
        if (!current.definitionMatches) {
          await installDefinition(definition);
          return result(definition, "started");
        }
        await adapter.start();
        return result(definition, "started");
      }
      if (!current.definitionMatches) {
        await installDefinition(definition);
        return result(definition, "restarted");
      }
      return { ...current, operation: "unchanged" };
    },
    async start() {
      const printArgs = ["print", target];
      const current = await options.runCommand("launchctl", printArgs, {
        allowFailure: true,
      });
      assertExpectedServiceExit("launchctl", printArgs, current, [0, 113]);
      if (current.exitCode !== 0) {
        await options.runCommand("launchctl", [
          "bootstrap",
          `gui/${String(options.uid)}`,
          definitionPath,
        ]);
        return;
      }
      if (!/(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/i.test(current.stdout))
        await options.runCommand("launchctl", ["kickstart", target]);
    },
    async restart(definition) {
      if (definition !== undefined) {
        const current = await readStatus(definition);
        if (!current.running) {
          if (!current.definitionMatches) await installDefinition(definition);
          else await adapter.start();
          return;
        }
        if (!current.definitionMatches) {
          await installDefinition(definition);
          return;
        }
      }
      await options.runCommand("launchctl", ["kickstart", "-k", target]);
    },
    async stop() {
      const args = ["kill", "SIGTERM", target];
      const result = await options.runCommand("launchctl", args, {
        allowFailure: true,
      });
      assertExpectedServiceExit("launchctl", args, result, [0, 113]);
    },
    async uninstall() {
      const args = ["bootout", target];
      const result = await options.runCommand("launchctl", args, {
        allowFailure: true,
      });
      assertExpectedServiceExit("launchctl", args, result, [0, 3]);
      await options.fileSystem.remove(definitionPath);
    },
    async status(definition) {
      const content = await options.fileSystem.read(definitionPath);
      let running = false;
      if (content !== null) {
        const args = ["print", target];
        const result = await options.runCommand("launchctl", args, {
          allowFailure: true,
        });
        assertExpectedServiceExit("launchctl", args, result, [0, 113]);
        running =
          result.exitCode === 0 &&
          /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/i.test(result.stdout);
      }
      return {
        platform: MACOS_PLATFORM,
        supported: true,
        installed: content !== null,
        running,
        definitionMatches:
          content !== null &&
          (definition === undefined ||
            content === renderLaunchAgent(definition, label)),
        definitionPath,
        ...(definition === undefined
          ? {}
          : { command: definition.command, version: definition.version }),
      } satisfies ServiceStatus;
    },
  };
  return adapter;
};

export function renderLaunchAgent(
  definition: ServiceDefinition,
  label = serviceName(),
): string {
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
    `  <string>${xmlEscape(label)}</string>`,
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
