import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const origin = argument("--origin");
if (origin === undefined) throw new Error("--origin is required");
const token = process.env.AGENTCHANNELS_CONFORMANCE_ENROLLMENT_TOKEN;
const stateFile = argument("--state-file");
const moduleName = argument(
  "--client-module",
  pathToFileURL(resolve("dist/index.js")).href,
);
const client = await import(moduleName);
const endpoints = client.parseRelayOrigin(origin);
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/protocol-v1.json", import.meta.url),
    "utf8",
  ),
);
for (const entry of fixture.accepted.filter(
  ({ direction }) => direction === "relayToLocal",
)) {
  if (!client.relayToLocalMessageSchema.safeParse(entry.message).success) {
    throw new Error("client rejected Relay protocol fixture");
  }
}
for (const entry of fixture.accepted.filter(
  ({ direction }) => direction === "localToRelay",
)) {
  if (!client.localToRelayMessageSchema.safeParse(entry.message).success) {
    throw new Error("client rejected local protocol fixture");
  }
}
for (const entry of fixture.rejected) {
  if (client.localToRelayMessageSchema.safeParse(entry.message).success) {
    throw new Error("client accepted a rejected Relay protocol fixture");
  }
}

const savedState =
  stateFile !== undefined && existsSync(stateFile)
    ? JSON.parse(await readFile(stateFile, "utf8"))
    : undefined;
const privateKey =
  savedState === undefined
    ? generateKeyPairSync("ed25519").privateKey
    : createPrivateKey({
        key: Buffer.from(savedState.privateKeyBase64, "base64"),
        format: "der",
        type: "pkcs8",
      });
const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
if (typeof publicJwk.x !== "string") {
  throw new Error("missing Ed25519 public key");
}
const installationId =
  savedState?.installationId ?? `conformance-${randomUUID()}`;
const bindingId = savedState?.bindingId ?? `binding-${randomUUID()}`;
if (stateFile !== undefined && savedState === undefined) {
  await writeFile(
    stateFile,
    `${JSON.stringify({
      installationId,
      bindingId,
      privateKeyBase64: privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
    })}\n`,
    { mode: 0o600 },
  );
}

const enrollmentHeaders = { "content-type": "application/json" };
if (token !== undefined) enrollmentHeaders.authorization = `Bearer ${token}`;
const enrollment = await fetch(endpoints.installationUrl, {
  method: "POST",
  headers: enrollmentHeaders,
  body: JSON.stringify({
    installationId,
    publicKeyBase64: Buffer.from(publicJwk.x, "base64url").toString("base64"),
  }),
});
if (!enrollment.ok) {
  throw new Error(`enrollment failed with HTTP ${String(enrollment.status)}`);
}

async function connectAndAuthenticate() {
  const socket = new WebSocket(endpoints.websocketUrl);
  const messages = [];
  const waiters = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter === undefined) messages.push(value);
    else waiter(value);
  });
  const nextMessage = async () => {
    const value = messages.shift();
    if (value !== undefined) return value;
    return new Promise((resolveMessage, rejectMessage) => {
      const timer = setTimeout(
        () => rejectMessage(new Error("Relay message timed out")),
        5_000,
      );
      waiters.push((message) => {
        clearTimeout(timer);
        resolveMessage(message);
      });
    });
  };
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  const challenge = client.relayToLocalMessageSchema.parse(await nextMessage());
  if (challenge.type !== "challenge") {
    throw new Error("Relay did not challenge client");
  }
  socket.send(
    JSON.stringify({
      type: "authenticate",
      protocol: 1,
      installationId,
      signatureBase64: sign(
        null,
        Buffer.from(challenge.nonce, "utf8"),
        privateKey,
      ).toString("base64"),
    }),
  );
  const authenticated = client.relayToLocalMessageSchema.parse(
    await nextMessage(),
  );
  if (authenticated.type !== "authenticated") {
    throw new Error("Relay did not authenticate client");
  }
  return { socket, nextMessage };
}

async function signedWebhookRoundTrip(socket, nextMessage, eventId) {
  const body = JSON.stringify({ event_id: eventId });
  const requestTimestamp = String(Math.floor(Date.now() / 1000));
  const signingSecret = "conformance-signing-secret";
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${requestTimestamp}:${body}`)
    .digest("hex")}`;
  const webhookPromise = fetch(endpoints.webhookUrl("slack", bindingId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": requestTimestamp,
      "x-slack-signature": signature,
    },
    body,
  });
  const forwarded = client.relayToLocalMessageSchema.parse(await nextMessage());
  if (forwarded.type !== "webhook") {
    throw new Error("Relay did not forward webhook");
  }
  const forwardedBody = Buffer.from(forwarded.rawBodyBase64, "base64").toString(
    "utf8",
  );
  const forwardedTimestamp = forwarded.headers["x-slack-request-timestamp"];
  const forwardedSignature = forwarded.headers["x-slack-signature"];
  const expectedSignature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${forwardedTimestamp}:${forwardedBody}`)
    .digest("hex")}`;
  if (forwardedBody !== body || forwardedSignature !== expectedSignature) {
    throw new Error("forwarded webhook signature did not verify");
  }
  socket.send(
    JSON.stringify({
      type: "webhook_response",
      protocol: 1,
      requestId: forwarded.requestId,
      status: 202,
      headers: { "x-conformance": "passed" },
      body: "accepted",
    }),
  );
  const webhookResponse = await webhookPromise;
  if (
    webhookResponse.status !== 202 ||
    webhookResponse.headers.get("x-conformance") !== "passed" ||
    (await webhookResponse.text()) !== "accepted"
  ) {
    throw new Error("Relay did not return local webhook response");
  }
}

const firstConnection = await connectAndAuthenticate();
await new Promise((resolveClose) => {
  firstConnection.socket.once("close", resolveClose);
  firstConnection.socket.close();
});
const { socket, nextMessage } = await connectAndAuthenticate();
if (process.argv.includes("--expect-existing-binding")) {
  await signedWebhookRoundTrip(
    socket,
    nextMessage,
    "conformance-preserved-route",
  );
}
socket.send(
  JSON.stringify({
    type: "sync_bindings",
    protocol: 1,
    bindings: [{ bindingId, connector: "slack" }],
  }),
);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
await signedWebhookRoundTrip(
  socket,
  nextMessage,
  "conformance-synchronized-route",
);
socket.close();
process.stdout.write("protocol_conformance=passed\n");
