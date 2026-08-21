import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConnectorModules } from "./connectors/connector.ts";
import { DeliveryWorker } from "./engine/deliveries.ts";
import { ensureProductPaths, resolveProductPaths } from "./paths.ts";
import { SessionCoordinator } from "./engine/coordinator.ts";
import { SessionRetentionCleaner } from "./engine/retention.ts";
import { Persistence } from "./store/store.ts";
import { resolveRuntime } from "./runtimes/contract.ts";
import { BindingCredentialCache } from "./security/credential-cache.ts";
import { KeyringCredentialStore } from "./security/keyring.ts";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "./security/identity.ts";
import { IngressService } from "./engine/ingress.ts";
import { RelayClient } from "./relay/client.ts";
import { RelayManager } from "./relay/enrollment.ts";
import { AgentChannelsError } from "./errors.ts";
import { createLogger } from "./log.ts";
import { redactErrorDiagnostic } from "./security/redact.ts";

export type DaemonOptions = {
  concurrency?: number;
  home?: string;
};

export async function startDaemon(options: DaemonOptions): Promise<void> {
  const environment =
    options.home === undefined
      ? process.env
      : { ...process.env, AGENTCHANNELS_HOME: options.home };
  const paths = resolveProductPaths(environment);
  if (!existsSync(paths.database))
    throw new AgentChannelsError(
      "MISSING_AGENT",
      "AgentChannels is not initialized.",
      ["Run agentchannels init in a Git repository."],
    );
  ensureProductPaths(paths);
  const store = new Persistence(paths.database, {
    backupDirectory: paths.backups,
  });
  const log = createLogger({ file: join(paths.logs, "daemon.log") });
  const keyring = new KeyringCredentialStore(paths.keyringService);
  const identityService = new InstallationIdentityService(keyring);
  const relayManager = new RelayManager({ store, identity: identityService });
  const relayEndpoints = relayManager.endpoints();
  if (relayEndpoints === undefined) {
    store.close();
    throw new AgentChannelsError(
      "RELAY_UNAVAILABLE",
      "Relay is not configured.",
      ["Run agentchannels init to finish Relay setup."],
    );
  }
  if (store.listAllBindings().length === 0) {
    store.close();
    throw new AgentChannelsError(
      "MISSING_AGENT",
      "No usable Bindings are configured.",
      ["Run agentchannels init to connect a channel."],
    );
  }
  const installation = await identityService.getOrCreate();
  const bindingCredentials = new BindingCredentialService(keyring);
  // Webhook handling must not touch the keyring or a provider token endpoint,
  // so credentials are loaded before the Relay connection opens and are kept
  // fresh on a timer rather than on demand.
  const credentialCache = new BindingCredentialCache({
    service: bindingCredentials,
  });
  const bindingIds = (): string[] =>
    store.listAllBindings().map((binding) => binding.id);
  await credentialCache.prime(bindingIds());
  const connectors = await loadConnectorModules();
  const sessions = new SessionCoordinator({
    store,
    runtimes: resolveRuntime,
    worktreeRoot: paths.worktrees,
    concurrency: options.concurrency ?? 2,
  });
  const recovery = sessions.recoverAfterCrash();
  if (recovery.sessions > 0 || recovery.deliveries > 0) {
    log.info(
      `Recovered ${String(recovery.sessions)} interrupted Session(s) and ${String(recovery.deliveries)} pending delivery attempt(s).`,
    );
  }
  const ingress = new IngressService({
    store,
    credentials: credentialCache,
    connectors,
    sessions,
    onError: ({ bindingId, requestId, error }) => {
      log.error(
        `Ingress error binding=${bindingId} request=${requestId}: ${error}`,
      );
    },
  });
  const relay = new RelayClient({
    endpoints: relayEndpoints,
    identity: identityService,
    listBindings: () => [
      ...store.listAllBindings(),
      ...store.listAllBindingSetups(),
    ],
    handleWebhook: (request) => Promise.resolve(ingress.handle(request)),
    onStateChange: (connected) => {
      if (connected) store.touchInstallation(installation.installationId);
      log.info(`Relay ${connected ? "connected" : "disconnected"}.`);
    },
  });
  const deliveries = new DeliveryWorker({
    store,
    credentials: bindingCredentials,
    connectors,
  });
  const retention = new SessionRetentionCleaner(store, paths.worktrees);
  await retention.clean();
  let draining = false;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    void deliveries
      .drain()
      .catch((error: unknown) => {
        log.error(`Delivery worker failed: ${redactErrorDiagnostic(error)}`);
      })
      .finally(() => {
        draining = false;
      });
  }, 250);
  timer.unref();
  const retentionTimer = setInterval(() => {
    void retention.clean().catch((error: unknown) => {
      log.error(`Retention cleanup failed: ${redactErrorDiagnostic(error)}`);
    });
  }, 60 * 60_000);
  retentionTimer.unref();
  // Only tell the Relay about Bindings when the set actually changes; this ran
  // unconditionally every second and re-sent an identical list each time.
  let lastBindingSignature = "";
  const bindingSyncTimer = setInterval(() => {
    const signature = [
      ...store.listAllBindings(),
      ...store.listAllBindingSetups(),
    ]
      .map((binding) => `${binding.id}:${binding.connector}`)
      .sort()
      .join(",");
    if (signature === lastBindingSignature) return;
    if (relay.syncBindings()) lastBindingSignature = signature;
  }, 1_000);
  bindingSyncTimer.unref();
  const credentialTimer = setInterval(() => {
    void credentialCache.keepFresh(bindingIds()).catch((error: unknown) => {
      log.error(`Credential refresh failed: ${redactErrorDiagnostic(error)}`);
    });
  }, 60_000);
  credentialTimer.unref();

  const stop = (): void => relay.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await relay.run();
  } finally {
    clearInterval(timer);
    clearInterval(retentionTimer);
    clearInterval(bindingSyncTimer);
    clearInterval(credentialTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    store.close();
  }
}
