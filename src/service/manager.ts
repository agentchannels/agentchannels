import { join } from "node:path";

import {
  defaultHomeDirectory,
  nodeCommandRunner,
  nodeFileSystem,
} from "./io.js";
import {
  assertUserServiceMutation,
  PrivilegedServiceError,
  ServiceManagerError,
  UnsupportedServicePlatformError,
} from "./guards.js";
import { defaultServicePlatformRegistry } from "./registry.js";
import { scopedServiceName } from "./format.js";
import type {
  ServiceDefinition,
  ServiceManagerOptions,
  ServiceOperationResult,
  ServicePlatformAdapter,
  ServiceStatus,
} from "./types.js";

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

async function serviceBoundary<Value>(
  message: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof UnsupportedServicePlatformError ||
      error instanceof PrivilegedServiceError ||
      error instanceof ServiceManagerError
    )
      throw error;
    throw new ServiceManagerError(message, error);
  }
}

export class ServiceManager {
  private readonly adapter: ServicePlatformAdapter | undefined;
  private definition: ServiceDefinition | undefined;
  private readonly options: Required<
    Pick<
      ServiceManagerOptions,
      | "uid"
      | "environment"
      | "homeDirectory"
      | "fileSystem"
      | "runCommand"
      | "serviceIdentifier"
    >
  > & { platform: NodeJS.Platform | string };

  constructor(options: ServiceManagerOptions = {}) {
    const platform = options.platform ?? process.platform;
    const environment = options.environment ?? process.env;
    const homeDirectory =
      options.homeDirectory ?? defaultHomeDirectory(environment);
    this.options = {
      platform,
      uid: options.uid ?? currentUid(),
      environment,
      homeDirectory,
      fileSystem: options.fileSystem ?? nodeFileSystem,
      runCommand: options.runCommand ?? nodeCommandRunner,
      serviceIdentifier:
        options.serviceIdentifier ??
        scopedServiceName(
          environment.AGENTCHANNELS_HOME ??
            join(homeDirectory, ".agentchannels"),
          homeDirectory,
        ),
    };
    const factory = (options.registry ?? defaultServicePlatformRegistry).get(
      platform,
    );
    this.adapter = factory?.(this.options);
  }

  get platform(): NodeJS.Platform | string {
    return this.options.platform;
  }

  async install(
    definition: ServiceDefinition,
  ): Promise<ServiceOperationResult> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    this.definition = definition;
    return serviceBoundary(
      "Could not install or update the background daemon.",
      () => adapter.reconcile(definition),
    );
  }

  async reconcile(
    definition: ServiceDefinition,
  ): Promise<ServiceOperationResult> {
    if (this.adapter === undefined)
      return {
        ...this.unsupportedStatus(definition),
        operation: "unsupported",
      };
    const adapter = this.adapter;
    this.assertMutationAllowed();
    this.definition = definition;
    return serviceBoundary(
      "Could not update or start the background daemon.",
      () => adapter.reconcile(definition),
    );
  }

  async restart(
    definition?: ServiceDefinition,
  ): Promise<ServiceOperationResult> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await serviceBoundary("Could not restart the background daemon.", () =>
      adapter.restart(this.definition),
    );
    return this.operationResult(
      adapter,
      "Could not inspect the background daemon after restart.",
      "restarted",
    );
  }

  async start(definition?: ServiceDefinition): Promise<ServiceOperationResult> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await serviceBoundary("Could not start the background daemon.", () =>
      adapter.start(),
    );
    return this.operationResult(
      adapter,
      "Could not inspect the background daemon after start.",
      "started",
    );
  }

  async stop(definition?: ServiceDefinition): Promise<ServiceOperationResult> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await serviceBoundary("Could not stop the background daemon.", () =>
      adapter.stop(),
    );
    return this.operationResult(
      adapter,
      "Could not inspect the background daemon after stop.",
      "stopped",
    );
  }

  async uninstall(
    definition?: ServiceDefinition,
  ): Promise<ServiceOperationResult> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await serviceBoundary("Could not uninstall the background daemon.", () =>
      adapter.uninstall(),
    );
    return this.operationResult(
      adapter,
      "Could not inspect the background daemon after uninstall.",
      "uninstalled",
    );
  }

  async status(definition?: ServiceDefinition): Promise<ServiceStatus> {
    if (this.adapter === undefined) {
      return this.unsupportedStatus(definition);
    }
    const adapter = this.adapter;
    if (definition !== undefined) this.definition = definition;
    return serviceBoundary("Could not inspect the background daemon.", () =>
      adapter.status(this.definition),
    );
  }

  private requireAdapter(): ServicePlatformAdapter {
    if (this.adapter === undefined)
      throw new UnsupportedServicePlatformError(this.options.platform);
    return this.adapter;
  }

  private unsupportedStatus(definition?: ServiceDefinition): ServiceStatus {
    return {
      platform: this.options.platform,
      supported: false,
      installed: false,
      running: false,
      definitionMatches: false,
      definitionPath: "",
      ...(definition === undefined
        ? {}
        : { command: definition.command, version: definition.version }),
    };
  }

  private assertMutationAllowed(): void {
    assertUserServiceMutation(this.options);
  }

  private async operationResult(
    adapter: ServicePlatformAdapter,
    message: string,
    operation: ServiceOperationResult["operation"],
  ): Promise<ServiceOperationResult> {
    return {
      ...(await serviceBoundary(message, () =>
        adapter.status(this.definition),
      )),
      operation,
    };
  }
}

export function createServiceManager(
  options: ServiceManagerOptions = {},
): ServiceManager {
  return new ServiceManager(options);
}
