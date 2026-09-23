import { createHmac } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "bun:test";
import type { Subprocess } from "bun";

import { connectorModules } from "../src/connectors/registry.ts";
import type { SessionCoordinator } from "../src/engine/coordinator.ts";
import { IngressService } from "../src/engine/ingress.ts";
import { RelayClient } from "../src/relay/client.ts";
import { RelayManager } from "../src/relay/enrollment.ts";
import { BindingCredentialCache } from "../src/security/credential-cache.ts";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../src/security/identity.ts";
import { Persistence } from "../src/store/store.ts";
import {
  cleanupFixtures,
  freePort,
  MemoryCredentialStore,
  temporaryDirectory,
  waitUntil,
} from "./helpers/fixtures.ts";

const RELAY_ENTRY = resolve(import.meta.dir, "../../relay/src/main.ts");
const ENROLLMENT_TOKEN = "roundtrip-enrollment-token";
const SIGNING_SECRET = "roundtrip-signing-secret";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cleanupFixtures();
});

async function startRelay(): Promise<string> {
  const port = await freePort();
  const relay: Subprocess = Bun.spawn([process.execPath, RELAY_ENTRY], {
    stdout: "ignore",
    stderr: "inherit",
    env: {
      PATH: process.env.PATH ?? "",
      AGENTCHANNELS_RELAY_BIND: `127.0.0.1:${String(port)}`,
      AGENTCHANNELS_RELAY_DATABASE: join(temporaryDirectory(), "relay.sqlite3"),
      AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN,
    },
  });
  cleanups.push(async () => {
    relay.kill("SIGTERM");
    await relay.exited;
  });
  const origin = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetch(origin);
      return origin;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error("relay did not start");
}

function signedSlackRequest(body: string, secret = SIGNING_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
    },
    body,
  };
}

async function untilRouted(url: string, body: string): Promise<Response> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, signedSlackRequest(body));
    if (response.status !== 404) return response;
    await Bun.sleep(20);
  }
  throw new Error("binding was never routed");
}

it("carries a signed provider webhook through the relay to local verification and back", async () => {
  const origin = await startRelay();
  const store = new Persistence(":memory:");
  cleanups.push(() => store.close());
  const agent = store.createAgent({ name: "Roundtrip", cwd: "/tmp/roundtrip" });
  const binding = store.createBinding({
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "U_OPERATOR",
    externalInstallationId: "T_WORKSPACE",
  });

  const secrets = new MemoryCredentialStore();
  const bindingCredentials = new BindingCredentialService(secrets);
  await bindingCredentials.set(binding.id, {
    signingSecret: SIGNING_SECRET,
    botToken: "xoxb-roundtrip",
  });
  const credentials = new BindingCredentialCache({
    service: bindingCredentials,
  });
  await credentials.prime([binding.id]);

  const identity = new InstallationIdentityService(secrets);
  const manager = new RelayManager({ store, identity });
  await manager.use({
    origin,
    enrollmentToken: ENROLLMENT_TOKEN,
    acknowledgeBindingReconfiguration: true,
  });
  const endpoints = manager.endpoints();
  if (endpoints === undefined) throw new Error("relay was not configured");

  const ingress = new IngressService({
    store,
    credentials,
    connectors: connectorModules,
    sessions: {} as SessionCoordinator,
  });
  let connected = false;
  const client = new RelayClient({
    endpoints,
    identity,
    listBindings: () => store.listAllBindings(),
    handleWebhook: async (message) => ingress.handle(message),
    onStateChange: (state) => {
      connected = state;
    },
  });
  const running = client.run();
  cleanups.push(async () => {
    client.stop();
    await running;
  });
  await waitUntil(() => connected, "relay authentication", 5_000);

  const webhookUrl = endpoints.webhookUrl("slack", binding.id).toString();
  const challenge = JSON.stringify({
    type: "url_verification",
    challenge: "roundtrip-challenge",
  });
  const answered = await untilRouted(webhookUrl, challenge);
  expect(answered.status).toBe(200);
  expect(await answered.text()).toBe("roundtrip-challenge");

  const forged = await fetch(
    webhookUrl,
    signedSlackRequest(challenge, "not-the-signing-secret"),
  );
  expect(forged.status).toBe(401);

  client.stop();
  await running;
  await waitUntil(() => !connected, "relay disconnect", 5_000);
  const offline = await fetch(webhookUrl, signedSlackRequest(challenge));
  expect(offline.status).toBe(200);
  expect(await offline.text()).toBe("");
}, 30_000);
