import { expect, it } from "bun:test";

import {
  DeliveryWorker,
  type PermanentDeliveryFailure,
} from "../src/engine/deliveries.ts";
import type {
  Connector,
  ConnectorCredentials,
  VerificationResult,
} from "../src/connectors/connector.ts";
import type {
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../src/model.ts";
import { Persistence } from "../src/store/store.ts";
import { installationOverview, renderOverview } from "../src/cli/status.ts";
import { BindingCredentialService } from "../src/security/identity.ts";
import type { CredentialStore } from "../src/security/keyring.ts";

class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

class AlwaysFailingConnector implements Connector {
  readonly type = "slack" as const;
  readonly attempted: DeliveryMessage[] = [];

  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult {
    void request;
    void credentials;
    return { ok: false, status: 400, reason: "not used by delivery tests" };
  }

  deliver(
    message: DeliveryMessage,
    credentials: ConnectorCredentials,
  ): Promise<void> {
    void credentials;
    this.attempted.push(message);
    return Promise.reject(new Error("invalid_blocks"));
  }

  searchUsers(
    query: string,
    credentials: ConnectorCredentials,
  ): Promise<RemoteUser[]> {
    void query;
    void credentials;
    return Promise.resolve([]);
  }
}

async function drainUntilSettled(
  worker: DeliveryWorker,
  advance: (at: Date) => void,
  store: Persistence,
  deliveryId: string,
): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    if (store.getDelivery(deliveryId)?.status === "failed") return;
    await worker.drain();
    const current = store.getDelivery(deliveryId);
    if (current === undefined || current.status === "failed") return;
    advance(new Date(current.nextAttemptAt));
  }
}

it("surfaces a permanently failed delivery without failing the Session", async () => {
  const store = new Persistence(":memory:");
  const credentialService = new BindingCredentialService(
    new MemoryCredentialStore(),
  );
  const connector = new AlwaysFailingConnector();
  let now = new Date("2026-01-01T00:00:00.000Z");
  const failures: PermanentDeliveryFailure[] = [];

  const agent = store.createAgent({
    id: "ag_surfacing",
    name: "Runbear",
    cwd: "/workspace/repository",
  });
  const binding = store.createBinding({
    id: "bd_surfacing",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "slack-installation",
  });
  await credentialService.set(binding.id, { botToken: "boundary-secret" });
  const session = store.createSession({
    id: "ss_surfacing",
    bindingId: binding.id,
    remoteConversationId: "thread-surfacing",
    cwd: "/workspace/repository/.worktrees/ss_surfacing",
    worktreePath: "/workspace/repository/.worktrees/ss_surfacing",
    baseCommit: "head-commit",
  });
  store.transitionSession(session.id, "running");
  store.transitionSession(session.id, "completed");

  const delivery = store.enqueueDelivery({
    id: "dl_surfacing",
    sessionId: session.id,
    connector: "slack",
    remoteConversationId: session.remoteConversationId,
    kind: "plan",
    body: "a plan too long for one section",
    metadata: { bindingId: binding.id, interactionId: "ix_surfacing" },
    createdAt: now,
    nextAttemptAt: now,
  });

  const worker = new DeliveryWorker({
    store,
    credentials: credentialService,
    connectors: new Map([["slack", connector]]),
    now: () => now,
    maxAttempts: 3,
    onPermanentFailure: (failure) => failures.push(failure),
  });

  await drainUntilSettled(
    worker,
    (at) => {
      now = at;
    },
    store,
    delivery.id,
  );

  expect(store.getDelivery(delivery.id)).toMatchObject({
    status: "failed",
    lastError: "invalid_blocks",
  });
  expect(store.getSession(session.id)?.status).toBe("completed");
  expect(failures).toEqual([
    {
      deliveryId: delivery.id,
      connector: "slack",
      kind: "plan",
      detail: "invalid_blocks",
    },
  ]);

  const fallbacks = store
    .claimDueDeliveries(10, now)
    .filter((entry) => entry.metadata?.deliveryFallbackFor === delivery.id);
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]).toMatchObject({
    kind: "error",
    remoteConversationId: session.remoteConversationId,
  });
  expect(fallbacks[0]?.body).toContain("could not be delivered");

  store.close();
});

it("does not let a failing fallback spawn another fallback", async () => {
  const store = new Persistence(":memory:");
  const credentialService = new BindingCredentialService(
    new MemoryCredentialStore(),
  );
  let now = new Date("2026-01-01T00:00:00.000Z");

  const agent = store.createAgent({
    id: "ag_loop",
    name: "Runbear",
    cwd: "/workspace/repository",
  });
  const binding = store.createBinding({
    id: "bd_loop",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "slack-installation",
  });
  await credentialService.set(binding.id, { botToken: "boundary-secret" });

  const fallback = store.enqueueDelivery({
    id: "dl_loop",
    connector: "slack",
    remoteConversationId: "thread-loop",
    kind: "error",
    body: "A plan message could not be delivered to this channel.",
    metadata: { bindingId: binding.id, deliveryFallbackFor: "dl_original" },
    createdAt: now,
    nextAttemptAt: now,
  });

  const worker = new DeliveryWorker({
    store,
    credentials: credentialService,
    connectors: new Map([["slack", new AlwaysFailingConnector()]]),
    now: () => now,
    maxAttempts: 2,
  });

  await drainUntilSettled(
    worker,
    (at) => {
      now = at;
    },
    store,
    fallback.id,
  );

  expect(store.getDelivery(fallback.id)?.status).toBe("failed");
  expect(store.claimDueDeliveries(10, now)).toHaveLength(0);
  store.close();
});

it("reports undelivered messages in the installation overview", async () => {
  const store = new Persistence(":memory:");
  const credentialService = new BindingCredentialService(
    new MemoryCredentialStore(),
  );
  let now = new Date("2026-01-01T00:00:00.000Z");

  const agent = store.createAgent({
    id: "ag_overview",
    name: "Runbear",
    cwd: "/workspace/repository",
  });
  const binding = store.createBinding({
    id: "bd_overview",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "slack-installation",
  });
  await credentialService.set(binding.id, { botToken: "boundary-secret" });

  const delivery = store.enqueueDelivery({
    id: "dl_overview",
    connector: "slack",
    remoteConversationId: "thread-overview",
    kind: "final",
    body: "done",
    metadata: { bindingId: binding.id },
    createdAt: now,
    nextAttemptAt: now,
  });

  expect(store.countFailedDeliveries()).toBe(0);

  const worker = new DeliveryWorker({
    store,
    credentials: credentialService,
    connectors: new Map([["slack", new AlwaysFailingConnector()]]),
    now: () => now,
    maxAttempts: 2,
  });
  await drainUntilSettled(
    worker,
    (at) => {
      now = at;
    },
    store,
    delivery.id,
  );

  expect(store.countFailedDeliveries([binding.id])).toBe(1);
  expect(store.countFailedDeliveries(["bd_other"])).toBe(0);

  const overview = installationOverview(store, {
    cwd: "/workspace/repository",
  });
  expect(overview.failedDeliveries).toBe(1);
  expect(overview.status).toBe("degraded");
  expect(renderOverview(overview)).toContain("Undelivered channel messages: 1");

  store.close();
});
