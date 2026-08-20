import { existsSync } from "node:fs";

import { loadConnectorModules } from "../connectors/connector.js";
import { DeliveryWorker } from "../core/delivery-worker.js";
import { ensureProductPaths, resolveProductPaths } from "../core/paths.js";
import { SessionCoordinator } from "../core/session-coordinator.js";
import { SessionRetentionCleaner } from "../core/retention.js";
import { Persistence } from "../persistence/store.js";
import { ClaudeRuntime } from "../runtime/claude.js";
import { KeyringCredentialStore } from "../security/credentials.js";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../security/identity.js";
import { IngressService } from "./ingress-service.js";
import { RelayClient } from "./relay-client.js";
import { RelayManager } from "../relay/manager.js";
import {
  redactErrorDiagnostic,
  redactSensitiveText,
} from "../security/redaction.js";

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
    throw new Error("AgentChannels is not initialized; run agentchannels init");
  ensureProductPaths(paths);
  const store = new Persistence(paths.database, {
    backupDirectory: paths.backups,
  });
  const keyring = new KeyringCredentialStore();
  const identityService = new InstallationIdentityService(keyring);
  const relayManager = new RelayManager({ store, identity: identityService });
  const relayEndpoints = relayManager.endpoints();
  if (relayEndpoints === undefined) {
    store.close();
    throw new Error("Relay is not configured; run agentchannels init");
  }
  if (store.listAllBindings().length === 0) {
    store.close();
    throw new Error(
      "No usable Bindings are configured; finish agentchannels init",
    );
  }
  const installation = await identityService.getOrCreate();
  const bindingCredentials = new BindingCredentialService(keyring);
  const connectors = await loadConnectorModules();
  const sessions = new SessionCoordinator({
    store,
    runtime: new ClaudeRuntime(),
    worktreeRoot: paths.worktrees,
    concurrency: options.concurrency ?? 2,
  });
  const recovery = sessions.recoverAfterCrash();
  if (recovery.sessions > 0 || recovery.deliveries > 0) {
    process.stderr.write(
      `Recovered ${String(recovery.sessions)} interrupted Session(s) and ${String(recovery.deliveries)} pending delivery attempt(s).\n`,
    );
  }
  const ingress = new IngressService({
    store,
    credentials: bindingCredentials,
    connectors,
    sessions,
    onError: ({ bindingId, requestId, error }) => {
      process.stderr.write(
        `Ingress error binding=${bindingId} request=${requestId}: ${redactSensitiveText(error)}\n`,
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
    handleWebhook: (request) => ingress.handle(request),
    onStateChange: (connected) => {
      if (connected) store.touchInstallation(installation.installationId);
      process.stderr.write(
        `Relay ${connected ? "connected" : "disconnected"}.\n`,
      );
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
        process.stderr.write(
          `Delivery worker failed: ${redactErrorDiagnostic(error)}\n`,
        );
      })
      .finally(() => {
        draining = false;
      });
  }, 250);
  timer.unref();
  const retentionTimer = setInterval(() => {
    void retention.clean().catch((error: unknown) => {
      process.stderr.write(
        `Retention cleanup failed: ${redactErrorDiagnostic(error)}\n`,
      );
    });
  }, 60 * 60_000);
  retentionTimer.unref();
  const bindingSyncTimer = setInterval(() => relay.syncBindings(), 1_000);
  bindingSyncTimer.unref();

  const stop = (): void => relay.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await relay.run();
  } finally {
    clearInterval(timer);
    clearInterval(retentionTimer);
    clearInterval(bindingSyncTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    store.close();
  }
}
