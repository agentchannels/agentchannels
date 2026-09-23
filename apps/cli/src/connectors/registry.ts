import { internalError } from "../errors.ts";
import type { ConnectorType } from "../model.ts";
import type { ConnectorModule } from "./connector.ts";
import linear from "./linear.ts";
import slack from "./slack.ts";

export type ConnectorRegistry = ReadonlyMap<ConnectorType, ConnectorModule>;

export function connectorRegistry(
  modules: readonly ConnectorModule[],
): ConnectorRegistry {
  const registry = new Map<ConnectorType, ConnectorModule>();
  for (const module of modules) {
    if (registry.has(module.type))
      throw internalError(`Duplicate connector module ${module.type}.`);
    registry.set(module.type, module);
  }
  return registry;
}

export const connectorModules = connectorRegistry([linear, slack]);
