import { PROTOCOL } from "@agentchannels/protocol";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  authenticated,
  cleanupDirectories,
  connect,
  createInstallation,
  enroll,
  ENROLLMENT_TOKEN,
  launch,
  Peer,
  type Relay,
  routable,
  settle,
  startRelay,
  syncBindings,
  temporaryDirectory,
} from "./harness.ts";

const running: Relay[] = [];

async function relay(options?: Parameters<typeof startRelay>[0]) {
  const started = await startRelay(options);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.stop()));
  cleanupDirectories();
});

async function enrolled(target: Relay) {
  const installation = createInstallation();
  expect((await enroll(target, installation)).status).toBe(200);
  return installation;
}

describe("enrollment", () => {
  it("registers a key idempotently and conflicts on a different key", async () => {
    const target = await relay();
    const installation = createInstallation();
    const first = await enroll(target, installation);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      installationId: installation.installationId,
    });
    expect((await enroll(target, installation)).status).toBe(200);

    const replacement = {
      ...createInstallation(installation.installationId),
    };
    expect((await enroll(target, replacement)).status).toBe(409);
  });

  it("rejects a public key that is not an Ed25519 key", async () => {
    const target = await relay();
    const response = await enroll(target, {
      ...createInstallation(),
      publicKeyBase64: Buffer.alloc(31).toString("base64"),
    });
    expect(response.status).toBe(400);
  });

  it("answers every unauthorized enrollment identically", async () => {
    const target = await relay();
    const installation = createInstallation();
    const responses = await Promise.all(
      [
        null,
        "Bearer ",
        "Bearer x",
        `Bearer ${ENROLLMENT_TOKEN.slice(0, -1)}`,
        `Bearer ${ENROLLMENT_TOKEN}x`,
        `Bearer ${"y".repeat(4096)}`,
        ENROLLMENT_TOKEN,
      ].map(async (authorization) => {
        const response = await enroll(target, installation, authorization);
        return { status: response.status, body: await response.text() };
      }),
    );
    for (const response of responses)
      expect(response).toEqual({ status: 401, body: "unauthorized" });
  });

  it("accepts any valid key under explicit open enrollment", async () => {
    const target = await relay({ enrollment: { type: "open" } });
    expect((await enroll(target, createInstallation(), null)).status).toBe(200);
  });

  it("trims only trailing ASCII whitespace from a token file", async () => {
    const directory = temporaryDirectory();
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, `${ENROLLMENT_TOKEN}\r\n\t `);
    const target = await relay({
      enrollment: {
        type: "environment",
        values: { AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN_FILE: tokenFile },
      },
    });
    expect((await enroll(target, createInstallation())).status).toBe(200);
  });

  it.each([
    ["no enrollment policy", {}],
    [
      "two enrollment policies",
      {
        AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN: "a",
        AGENTCHANNELS_RELAY_ALLOW_OPEN_ENROLLMENT: "true",
      },
    ],
    [
      "open enrollment set to a non-true value",
      { AGENTCHANNELS_RELAY_ALLOW_OPEN_ENROLLMENT: "yes" },
    ],
    ["an empty token", { AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN: "" }],
  ])("refuses to start with %s", async (_name, values) => {
    const child = launch(join(temporaryDirectory(), "relay.sqlite3"), 1, {
      type: "environment",
      values,
    });
    expect(await child.exited).not.toBe(0);
  });
});

describe("authentication", () => {
  it("authenticates a registered key", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    peer.close();
  });

  it("rejects a signature from a different key", async () => {
    const target = await relay();
    const installation = await enrolled(target);
    const impostor = createInstallation(installation.installationId);
    const peer = await connect(target, impostor);
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "unauthenticated",
    });
    await peer.closed;
  });

  it("rejects an installation it has never seen", async () => {
    const target = await relay();
    const peer = await connect(target, createInstallation());
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "unauthenticated",
    });
    await peer.closed;
  });

  it("rejects a nonce relayed through another relay", async () => {
    const target = await relay();
    const peer = await connect(target, await enrolled(target), {
      origin: "https://relay.agentchannels.io",
    });
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "unauthenticated",
    });
    await peer.closed;
  });

  it("authenticates against the public origin it is configured with", async () => {
    const target = await relay({
      environment: { AGENTCHANNELS_RELAY_ORIGIN: "https://relay.example.com/" },
    });
    const installation = await enrolled(target);
    const behindProxy = await connect(target, installation, {
      origin: "https://relay.example.com",
    });
    expect(await behindProxy.next()).toMatchObject({ type: "authenticated" });
    behindProxy.close();

    const direct = await connect(target, installation);
    expect(await direct.next()).toMatchObject({
      type: "error",
      code: "unauthenticated",
    });
    await direct.closed;
  });

  it("names an unsupported protocol explicitly", async () => {
    const target = await relay();
    const peer = await connect(target, await enrolled(target), {
      protocol: 99,
    });
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "unsupported_protocol",
      supported: { min: PROTOCOL, max: PROTOCOL },
    });
    await peer.closed;
  });

  it("requires authenticate as the first message", async () => {
    const target = await relay();
    const peer = await Peer.open(target);
    await peer.next();
    peer.send({ type: "sync_bindings", protocol: PROTOCOL, bindings: [] });
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "invalid_message",
    });
    await peer.closed;
  });

  it("refuses a second authenticate on an authenticated connection", async () => {
    const target = await relay();
    const installation = await enrolled(target);
    const peer = await authenticated(target, installation);
    peer.send({
      type: "authenticate",
      protocol: PROTOCOL,
      installationId: installation.installationId,
      signatureBase64: "AA==",
    });
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "invalid_message",
    });
    peer.close();
  });
});

describe("routing", () => {
  it("forwards the exact request and returns the local response", async () => {
    const target = await relay();
    const installation = await enrolled(target);
    const peer = await authenticated(target, installation);
    syncBindings(peer, [{ bindingId: "bd_route", connector: "slack" }]);
    await settle(peer);

    const body = new Uint8Array([0, 1, 2, 255, 123, 34, 125]);
    const pending = fetch(`${target.origin}/v1/webhooks/slack/bd_route`, {
      method: "POST",
      headers: { "x-slack-signature": "v0=abc", "x-custom": "kept" },
      body,
    });
    const webhook = await peer.next();
    expect(webhook).toMatchObject({
      type: "webhook",
      protocol: PROTOCOL,
      bindingId: "bd_route",
      connector: "slack",
      headers: expect.objectContaining({
        "x-slack-signature": "v0=abc",
        "x-custom": "kept",
      }),
    });
    expect(
      new Uint8Array(Buffer.from(String(webhook.rawBodyBase64), "base64")),
    ).toEqual(body);
    expect(
      Date.parse(String(webhook.expiresAt)) -
        Date.parse(String(webhook.receivedAt)),
    ).toBeGreaterThan(0);

    peer.send({
      type: "webhook_response",
      protocol: PROTOCOL,
      requestId: webhook.requestId,
      status: 202,
      headers: { "x-local": "yes" },
      body: "challenge-echo",
    });
    const response = await pending;
    expect(response.status).toBe(202);
    expect(response.headers.get("x-local")).toBe("yes");
    expect(await response.text()).toBe("challenge-echo");
    peer.close();
  });

  it("routes any well-formed connector and hides malformed ones", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    syncBindings(peer, [
      { bindingId: "bd_new", connector: "brand-new_provider" },
    ]);
    await settle(peer);
    peer.close();
    await peer.closed;

    expect(await routable(target, "brand-new_provider", "bd_new")).toBe(200);
    expect(await routable(target, "slack", "bd_new")).toBe(404);
    expect(await routable(target, "Not-Lower", "bd_new")).toBe(404);
    expect(await routable(target, "slack", "bd_unknown")).toBe(404);
  });

  it("never turns a malformed connector into a route", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    syncBindings(peer, [{ bindingId: "bd_bad", connector: "Not/A" }]);
    await settle(peer).catch(() => undefined);
    expect(await routable(target, "not-a", "bd_bad")).toBe(404);
    peer.close();
  });

  it("acknowledges and drops an event for an offline installation", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    syncBindings(peer, [{ bindingId: "bd_offline", connector: "slack" }]);
    await settle(peer);
    peer.close();
    await peer.closed;

    const started = Date.now();
    expect(await routable(target, "slack", "bd_offline")).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("acknowledges and drops an event the installation never answers", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    syncBindings(peer, [{ bindingId: "bd_slow", connector: "slack" }]);
    await settle(peer);

    const started = Date.now();
    expect(await routable(target, "slack", "bd_slow")).toBe(200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(6_000);
    peer.close();
  }, 15_000);

  it("releases in-flight events at once when the installation reconnects", async () => {
    const target = await relay();
    const installation = await enrolled(target);
    const first = await authenticated(target, installation);
    syncBindings(first, [{ bindingId: "bd_swap", connector: "slack" }]);
    await settle(first);

    const started = Date.now();
    const inFlight = routable(target, "slack", "bd_swap");
    expect(await first.next()).toMatchObject({ type: "webhook" });
    const second = await authenticated(target, installation);
    expect(await inFlight).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_500);
    first.close();
    second.close();
  });

  it("keeps a binding with the installation that owns it", async () => {
    const target = await relay();
    const owner = await authenticated(target, await enrolled(target));
    syncBindings(owner, [{ bindingId: "bd_owned", connector: "slack" }]);
    await settle(owner);

    const intruder = await authenticated(target, await enrolled(target));
    syncBindings(intruder, [{ bindingId: "bd_owned", connector: "slack" }]);
    expect(await intruder.next()).toMatchObject({
      type: "error",
      code: "binding_conflict",
    });
    intruder.close();

    const pending = routable(target, "slack", "bd_owned");
    const webhook = await owner.next();
    owner.send({
      type: "webhook_response",
      protocol: PROTOCOL,
      requestId: webhook.requestId,
      status: 200,
    });
    expect(await pending).toBe(200);
    owner.close();
  });

  it("answers binary frames with an explicit error", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    peer.socket.send(new Uint8Array([1, 2, 3]));
    expect(await peer.next()).toMatchObject({
      type: "error",
      code: "invalid_message",
    });
    peer.close();
  });
});

describe("persistence", () => {
  it("routes a persisted binding after a restart before any sync", async () => {
    const database = join(temporaryDirectory(), "relay.sqlite3");
    const first = await relay({ database });
    const installation = await enrolled(first);
    const peer = await authenticated(first, installation);
    syncBindings(peer, [{ bindingId: "bd_persist", connector: "linear" }]);
    await settle(peer);
    peer.close();
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const second = await relay({ database });
    const reconnected = await authenticated(second, installation);
    const pending = routable(second, "linear", "bd_persist");
    const webhook = await reconnected.next();
    expect(webhook).toMatchObject({ type: "webhook", bindingId: "bd_persist" });
    reconnected.send({
      type: "webhook_response",
      protocol: PROTOCOL,
      requestId: webhook.requestId,
      status: 204,
    });
    expect(await pending).toBe(204);
    reconnected.close();
  });

  it("never writes webhook content to disk", async () => {
    const target = await relay();
    const peer = await authenticated(target, await enrolled(target));
    syncBindings(peer, [{ bindingId: "bd_secret", connector: "slack" }]);
    await settle(peer);
    const marker = `do-not-persist-${crypto.randomUUID()}`;
    const pending = fetch(`${target.origin}/v1/webhooks/slack/bd_secret`, {
      method: "POST",
      headers: { "x-marker": marker },
      body: marker,
    });
    const webhook = await peer.next();
    peer.send({
      type: "webhook_response",
      protocol: PROTOCOL,
      requestId: webhook.requestId,
      status: 200,
    });
    await pending;
    peer.close();
    await target.stop();
    running.splice(running.indexOf(target), 1);

    for (const suffix of ["", "-wal", "-journal"]) {
      const contents = (() => {
        try {
          return readFileSync(`${target.database}${suffix}`);
        } catch {
          return Buffer.alloc(0);
        }
      })();
      expect(contents.includes(marker)).toBe(false);
    }
  });

  it("refuses a database from a newer schema without touching it", async () => {
    const database = join(temporaryDirectory(), "relay.sqlite3");
    const newer = new Database(database, { create: true });
    newer.run("PRAGMA user_version = 99");
    newer.run("CREATE TABLE sentinel (value TEXT)");
    newer.close();
    const before = readFileSync(database);

    const child = launch(database, 1, {
      type: "token",
      token: ENROLLMENT_TOKEN,
    });
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(database).equals(before)).toBe(true);
  });
});
