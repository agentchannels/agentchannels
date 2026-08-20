export { createServiceManager, ServiceManager } from "./manager.js";
export {
  defaultServicePlatformRegistry,
  MapServicePlatformRegistry,
} from "./registry.js";
export { linuxServicePlatform, renderSystemdUnit } from "./linux.js";
export { macosServicePlatform, renderLaunchAgent } from "./macos.js";
export {
  PrivilegedServiceError,
  ServiceCommandError,
  ServiceManagerError,
  UnsupportedServicePlatformError,
} from "./guards.js";
export { SERVICE_NAME, SERVICE_VERSION_ENV } from "./types.js";
export type {
  ServiceCommand,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceDefinition,
  ServiceFileSystem,
  ServiceManagerOptions,
  ServiceOperation,
  ServiceOperationResult,
  ServicePlatformAdapter,
  ServicePlatformFactory,
  ServicePlatformRegistry,
  ServiceStatus,
  StableServiceCommand,
} from "./types.js";
import type { ServiceDefinition, StableServiceCommand } from "./types.js";

export function createStableServiceCommand(
  options: {
    executable?: string;
    args?: string[];
    environment?: Record<string, string>;
  } = {},
): StableServiceCommand {
  return {
    executable: options.executable ?? "agentchannels",
    args: options.args ?? ["daemon"],
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  };
}

export function createServiceDefinition(options: {
  version: string;
  executable?: string;
  args?: string[];
  environment?: Record<string, string>;
}): ServiceDefinition {
  return {
    version: options.version,
    command: createStableServiceCommand(options),
  };
}
