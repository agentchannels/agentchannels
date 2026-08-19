import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  Connector,
  ConnectorCredentials,
  VerificationResult,
} from "../src/connectors/connector.js";
import { SlackConnector } from "../src/connectors/slack.js";
import { SessionCoordinator } from "../src/core/session-coordinator.js";
import type { InboundRequest, RemoteUser } from "../src/core/types.js";
import { IngressService } from "../src/daemon/ingress-service.js";
import type { RelayWebhook } from "../src/daemon/relay-client.js";
import { Persistence } from "../src/persistence/index.js";
import type {
  Runtime,
  RuntimeEvent,
  RuntimeStartOptions,
  RuntimeResumeOptions,
  RuntimeTurn,
} from "../src/runtime/runtime.js";
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

/** External connector double: signature, timestamp, and event mapping stay at the connector boundary. */
class SignedIngressConnector implements Connector {
  readonly type = "slack" as const;

  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult {
    if (request.headers.authorization !== credentials.webhookSecret)
      return { ok: false, status: 401, reason: "Invalid signature" };
    if (Date.now() - request.timestamp.getTime() > 60_000)
      return { ok: false, status: 408, reason: "Stale event" };
    const parsed = JSON.parse(request.rawBody.toString()) as {
      conversation: string;
      user: string;
      text: string;
    };
    return {
      ok: true,
      command: {
        type: "message",
        deliveryId: request.deliveryId,
        remoteConversationId: parsed.conversation,
        remoteUserId: parsed.user,
        text: parsed.text,
      },
    };
  }

  deliver(): Promise<void> {
    return Promise.resolve();
  }
  searchUsers(): Promise<RemoteUser[]> {
    return Promise.resolve([]);
  }
}

/** Runtime boundary double: enough behavior to prove ingress cannot execute forged or replayed events. */
class ImmediateRuntime implements Runtime {
  readonly type = "claude-code" as const;
  calls: string[] = [];

  start(options: RuntimeStartOptions): RuntimeTurn {
    this.calls.push(options.prompt);
    return this.turn("runtime-ingress");
  }

  resume(options: RuntimeResumeOptions): RuntimeTurn {
    this.calls.push(options.prompt);
    return this.turn(options.runtimeSessionId);
  }

  private turn(runtimeSessionId: string): RuntimeTurn {
    const events: AsyncIterable<RuntimeEvent> =
      (async function* (): AsyncIterable<RuntimeEvent> {
        await Promise.resolve();
        yield { type: "session_started", runtimeSessionId };
        yield { type: "final", body: "done" };
      })();
    return {
      events,
      interrupt: async () => {
        await Promise.resolve();
      },
      dispose: () => undefined,
    };
  }
}

function webhook(
  requestId: string,
  receivedAt: string,
  authorization: string,
  body: string,
  bindingId = "bd_ingress",
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
): RelayWebhook {
  return {
    type: "webhook",
    protocol: 1,
    requestId,
    bindingId,
    connector: "slack",
    receivedAt,
    expiresAt,
    headers: { authorization },
    rawBodyBase64: Buffer.from(body).toString("base64"),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for ingress execution");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("local ingress verification", () => {
  it("answers Slack URL verification for a durable pending setup before credentials or Binding activation", async () => {
    const store = new Persistence(":memory:");
    const agent = store.createAgent({
      id: "ag_pending_slack",
      name: "Runbear",
      cwd: "/tmp/runbear",
    });
    const setup = store.createBindingSetup({
      id: "bd_pending_slack",
      agentId: agent.id,
      connector: "slack",
    });
    const credentials = new BindingCredentialService(
      new MemoryCredentialStore(),
    );
    const ingress = new IngressService({
      store,
      credentials,
      connectors: new Map([["slack", new SlackConnector()]]),
      sessions: {} as SessionCoordinator,
    });
    const response = await ingress.handle(
      webhook(
        "slack-verification",
        new Date().toISOString(),
        "",
        JSON.stringify({
          type: "url_verification",
          challenge: "provider-random-challenge",
        }),
        setup.id,
      ),
    );
    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: "provider-random-challenge" }),
    });
    expect(store.getBinding(setup.id)).toBeUndefined();
    store.close();
  });

  it("blocks forged, stale, unauthorized, and replayed ingress before runtime execution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentchannels-ingress-"));
    const repositoryPath = join(directory, "repository");
    execFileSync("git", ["init", "--initial-branch", "main", repositoryPath], {
      encoding: "utf8",
    });
    const repository = realpathSync(repositoryPath);
    execFileSync("git", ["config", "user.email", "tests@example.com"], {
      cwd: repository,
    });
    execFileSync("git", ["config", "user.name", "AgentChannels Tests"], {
      cwd: repository,
    });
    writeFileSync(join(repository, "README.md"), "ingress\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    const store = new Persistence(":memory:");
    const credentials = new MemoryCredentialStore();
    const credentialService = new BindingCredentialService(credentials);
    const connector = new SignedIngressConnector();
    const runtime = new ImmediateRuntime();
    const agent = store.createAgent({
      id: "ag_ingress",
      name: "Runbear",
      cwd: repository,
    });
    const binding = store.createBinding({
      id: "bd_ingress",
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "operator",
      externalInstallationId: "slack-installation",
    });
    store.grantAccess(binding.id, "alice");
    await credentialService.set(binding.id, { webhookSecret: "signed-secret" });
    const coordinator = new SessionCoordinator({
      store,
      runtime,
      worktreeRoot: join(directory, "worktrees"),
    });
    const ingress = new IngressService({
      store,
      credentials: credentialService,
      connectors: new Map([["slack", connector]]),
      sessions: coordinator,
    });
    const body = JSON.stringify({
      conversation: "thread-ingress",
      user: "alice",
      text: "valid task",
    });

    expect(
      (
        await ingress.handle(
          webhook(
            "evt-expired",
            new Date().toISOString(),
            "signed-secret",
            body,
            "bd_ingress",
            new Date(Date.now() - 1).toISOString(),
          ),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await ingress.handle(
          webhook("evt-forged", new Date().toISOString(), "wrong-secret", body),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await ingress.handle(
          webhook(
            "evt-stale",
            new Date(Date.now() - 120_000).toISOString(),
            "signed-secret",
            body,
          ),
        )
      ).status,
    ).toBe(408);
    expect(
      (
        await ingress.handle(
          webhook(
            "evt-unauthorized",
            new Date().toISOString(),
            "signed-secret",
            JSON.stringify({
              conversation: "thread-forged-user",
              user: "mallory",
              text: "do not run",
            }),
          ),
        )
      ).status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.calls).toEqual([]);

    expect(
      (
        await ingress.handle(
          webhook("evt-valid", new Date().toISOString(), "signed-secret", body),
        )
      ).status,
    ).toBe(200);
    await waitUntil(() =>
      store.listSessions().some((session) => session.status === "completed"),
    );
    expect(runtime.calls).toEqual(["valid task"]);
    expect(
      (
        await ingress.handle(
          webhook("evt-valid", new Date().toISOString(), "signed-secret", body),
        )
      ).status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.calls).toEqual(["valid task"]);
    expect(store.listSessions()).toHaveLength(1);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not execute when local connector credentials are unavailable", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agentchannels-ingress-offline-"),
    );
    const repositoryPath = join(directory, "repository");
    execFileSync("git", ["init", "--initial-branch", "main", repositoryPath], {
      encoding: "utf8",
    });
    const repository = realpathSync(repositoryPath);
    execFileSync("git", ["config", "user.email", "tests@example.com"], {
      cwd: repository,
    });
    execFileSync("git", ["config", "user.name", "AgentChannels Tests"], {
      cwd: repository,
    });
    writeFileSync(join(repository, "README.md"), "offline\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });
    const store = new Persistence(":memory:");
    const credentials = new BindingCredentialService(
      new MemoryCredentialStore(),
    );
    const runtime = new ImmediateRuntime();
    const agent = store.createAgent({
      id: "ag_offline",
      name: "Offline",
      cwd: repository,
    });
    store.createBinding({
      id: "bd_offline",
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "operator",
      externalInstallationId: "slack-installation",
    });
    const ingress = new IngressService({
      store,
      credentials,
      connectors: new Map([["slack", new SignedIngressConnector()]]),
      sessions: new SessionCoordinator({
        store,
        runtime,
        worktreeRoot: join(directory, "worktrees"),
      }),
    });
    const response = await ingress.handle(
      webhook(
        "evt-offline",
        new Date().toISOString(),
        "signed-secret",
        JSON.stringify({
          conversation: "thread-offline",
          user: "operator",
          text: "must not run",
        }),
        "bd_offline",
      ),
    );
    expect(response.status).toBe(500);
    expect(store.listSessions()).toEqual([]);
    expect(runtime.calls).toEqual([]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
