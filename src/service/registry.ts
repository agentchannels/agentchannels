import { linuxServicePlatform } from "./linux.js";
import { macosServicePlatform } from "./macos.js";
import type {
  ServicePlatformFactory,
  ServicePlatformRegistry,
} from "./types.js";

export class MapServicePlatformRegistry implements ServicePlatformRegistry {
  private readonly factories = new Map<string, ServicePlatformFactory>();

  constructor(factories: Iterable<ServicePlatformFactory> = []) {
    for (const factory of factories) {
      const platform = factory({
        platform: "registry",
        homeDirectory: "",
        uid: 0,
        fileSystem: {
          read: async () => null,
          write: async () => undefined,
          mkdir: async () => undefined,
          remove: async () => undefined,
        },
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }).platform;
      this.factories.set(platform, factory);
    }
  }

  get(platform: string): ServicePlatformFactory | undefined {
    return this.factories.get(platform);
  }
}

export const defaultServicePlatformRegistry: ServicePlatformRegistry =
  new MapServicePlatformRegistry([macosServicePlatform, linuxServicePlatform]);
