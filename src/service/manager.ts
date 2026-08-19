import {
  defaultHomeDirectory,
  nodeCommandRunner,
  nodeFileSystem,
} from "./io.js";
import {
  assertUserServiceMutation,
  UnsupportedServicePlatformError,
} from "./guards.js";
import { defaultServicePlatformRegistry } from "./registry.js";
import type {
  ServiceDefinition,
  ServiceManagerOptions,
  ServicePlatformAdapter,
  ServiceStatus,
} from "./types.js";

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

export class ServiceManager {
  private readonly adapter: ServicePlatformAdapter | undefined;
  private definition: ServiceDefinition | undefined;
  private readonly options: Required<
    Pick<
      ServiceManagerOptions,
      "uid" | "environment" | "homeDirectory" | "fileSystem" | "runCommand"
    >
  > & { platform: NodeJS.Platform | string };

  constructor(options: ServiceManagerOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.options = {
      platform,
      uid: options.uid ?? currentUid(),
      environment: options.environment ?? process.env,
      homeDirectory:
        options.homeDirectory ??
        defaultHomeDirectory(options.environment ?? process.env),
      fileSystem: options.fileSystem ?? nodeFileSystem,
      runCommand: options.runCommand ?? nodeCommandRunner,
    };
    const factory = (options.registry ?? defaultServicePlatformRegistry).get(
      platform,
    );
    this.adapter = factory?.(this.options);
  }

  get platform(): NodeJS.Platform | string {
    return this.options.platform;
  }

  async install(definition: ServiceDefinition): Promise<ServiceStatus> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    this.definition = definition;
    await adapter.install(definition);
    await adapter.start();
    return adapter.status(definition);
  }

  async start(definition?: ServiceDefinition): Promise<ServiceStatus> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await adapter.start();
    return adapter.status(this.definition);
  }

  async stop(definition?: ServiceDefinition): Promise<ServiceStatus> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await adapter.stop();
    return adapter.status(this.definition);
  }

  async uninstall(definition?: ServiceDefinition): Promise<ServiceStatus> {
    const adapter = this.requireAdapter();
    this.assertMutationAllowed();
    if (definition !== undefined) this.definition = definition;
    await adapter.uninstall();
    return adapter.status(this.definition);
  }

  async status(definition?: ServiceDefinition): Promise<ServiceStatus> {
    if (this.adapter === undefined) {
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
        nextAction: `Run agentchannels daemon in the foreground; background services are unsupported on ${this.options.platform}`,
      };
    }
    if (definition !== undefined) this.definition = definition;
    return this.adapter.status(this.definition);
  }

  private requireAdapter(): ServicePlatformAdapter {
    if (this.adapter === undefined)
      throw new UnsupportedServicePlatformError(this.options.platform);
    return this.adapter;
  }

  private assertMutationAllowed(): void {
    assertUserServiceMutation(this.options);
  }
}

export function createServiceManager(
  options: ServiceManagerOptions = {},
): ServiceManager {
  return new ServiceManager(options);
}
