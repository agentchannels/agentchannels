import type { Command } from "commander";

import type { ConnectorModule } from "../connectors/connector.ts";
import type { ConnectorType } from "../model.ts";
import type { ProductPaths } from "../paths.ts";
import type { Persistence } from "../store/store.ts";
import type { RelayManager } from "../relay/enrollment.ts";
import type { CredentialStore } from "../security/keyring.ts";
import type { ServiceDefinition, ServiceStatus } from "../service/types.ts";
import type { ServiceManager } from "../service/manager.ts";
import type { TerminalFormatter } from "./format.ts";
import type { ExternalActions, PromptIO } from "./io.ts";

/**
 * What every command needs, resolved once by `createProgram`.
 *
 * These used to be closure variables inside a single 1,600-line factory, which
 * is why commands could not live in their own files. Passing them explicitly is
 * what makes a command a unit that can be read on its own.
 */
export type CommandContext = Readonly<{
  program: Command;
  paths(): ProductPaths;
  openStore(): Persistence;
  openExistingStore(): Persistence | undefined;
  credentials(): CredentialStore;
  connectors(): Promise<ReadonlyMap<ConnectorType, ConnectorModule>>;
  relay(store: Persistence): RelayManager;
  prompt: PromptIO;
  external: ExternalActions;
  interactive(): boolean;
  formatter(): TerminalFormatter;
  services(): ServiceManager;
  serviceDefinition(): ServiceDefinition;
  assertStableServiceEntry(definition: ServiceDefinition): void;
  offerDaemon(): Promise<void>;
  daemonStatus(): Promise<ServiceStatus>;
}>;
