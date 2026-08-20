import { expect, it } from "vitest";

import { DeliveryWorker } from "../src/core/delivery-worker.js";
import type {
  Connector,
  ConnectorCredentials,
  VerificationResult,
} from "../src/connectors/connector.js";
import type {
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../src/core/types.js";
import { Persistence } from "../src/persistence/index.js";
import { BindingCredentialService } from "../src/security/identity.js";
import type { CredentialStore } from "../src/security/credentials.js";

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

/** External connector double: only the delivery API is exercised; credentials remain outside SQLite. */
class FailingOnceConnector implements Connector {
  readonly type = "slack" as const;
  readonly delivered: DeliveryMessage[] = [];
  private failuresRemaining = 1;

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
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(
        new Error(
          "Slack is temporarily offline; botToken=xoxb-syntheticSecret123",
        ),
      );
    }
    this.delivered.push(message);
    return Promise.resolve();
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

it("retries channel delivery independently after execution has completed", async () => {
  const store = new Persistence(":memory:");
  const credentials = new MemoryCredentialStore();
  const credentialService = new BindingCredentialService(credentials);
  const connector = new FailingOnceConnector();
  let now = new Date("2026-01-01T00:00:00.000Z");
  const agent = store.createAgent({
    id: "ag_delivery",
    name: "Runbear",
    cwd: "/workspace/repository",
  });
  const binding = store.createBinding({
    id: "bd_delivery",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "slack-installation",
  });
  await credentialService.set(binding.id, { botToken: "boundary-secret" });
  const session = store.createSession({
    id: "ss_delivery",
    bindingId: binding.id,
    remoteConversationId: "thread-delivery",
    cwd: "/workspace/repository/.worktrees/ss_delivery",
    worktreePath: "/workspace/repository/.worktrees/ss_delivery",
    baseCommit: "head-commit",
  });
  store.transitionSession(session.id, "running");
  store.transitionSession(session.id, "completed");
  const delivery = store.enqueueDelivery({
    id: "dl_delivery",
    sessionId: session.id,
    connector: "slack",
    remoteConversationId: session.remoteConversationId,
    kind: "final",
    body: "The signup regression is fixed.",
    createdAt: now,
    nextAttemptAt: now,
  });
  const worker = new DeliveryWorker({
    store,
    credentials: credentialService,
    connectors: new Map([["slack", connector]]),
    now: () => now,
    maxAttempts: 3,
  });

  expect(await worker.drain()).toBe(1);
  expect(store.getSession(session.id)?.status).toBe("completed");
  expect(store.getDelivery(delivery.id)).toMatchObject({
    status: "retrying",
    attempts: 1,
    lastError: "Slack is temporarily offline; botToken=[redacted]",
  });

  const retrying = store.getDelivery(delivery.id);
  if (retrying === undefined)
    throw new Error("Delivery disappeared before retry");
  now = new Date(retrying.nextAttemptAt);
  expect(await worker.drain()).toBe(1);
  expect(store.getSession(session.id)?.status).toBe("completed");
  expect(store.getDelivery(delivery.id)).toMatchObject({
    status: "delivered",
    attempts: 2,
    lastError: null,
  });
  expect(connector.delivered).toEqual([
    expect.objectContaining({
      kind: "final",
      body: "The signup regression is fixed.",
    }),
  ]);
  store.close();
});
