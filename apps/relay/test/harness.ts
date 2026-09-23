import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const command = process.env.AGENTCHANNELS_RELAY_COMMAND?.split(" ") ?? [
  process.execPath,
  resolve(import.meta.dir, "../src/main.ts"),
];

export const ENROLLMENT_TOKEN = "behavior-enrollment-token";

export type Enrollment =
  | { type: "token"; token: string }
  | { type: "open" }
  | { type: "environment"; values: Record<string, string> };

export type Relay = Readonly<{
  origin: string;
  database: string;
  stop(): Promise<void>;
}>;

const directories: string[] = [];

export function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentchannels-relay-"));
  directories.push(directory);
  return directory;
}

export function cleanupDirectories(): void {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null)
          resolvePort(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

function enrollmentEnvironment(enrollment: Enrollment): Record<string, string> {
  if (enrollment.type === "token")
    return { AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN: enrollment.token };
  if (enrollment.type === "open")
    return { AGENTCHANNELS_RELAY_ALLOW_OPEN_ENROLLMENT: "true" };
  return enrollment.values;
}

export function launch(
  database: string,
  port: number,
  enrollment: Enrollment,
): Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      AGENTCHANNELS_RELAY_BIND: `127.0.0.1:${String(port)}`,
      AGENTCHANNELS_RELAY_DATABASE: database,
      ...enrollmentEnvironment(enrollment),
    },
  });
}

async function waitForListener(
  origin: string,
  process: Subprocess,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null)
      throw new Error(`relay exited with ${String(process.exitCode)}`);
    try {
      await fetch(`${origin}/`);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error("relay did not start listening");
}

export async function startRelay(
  options: { database?: string; enrollment?: Enrollment } = {},
): Promise<Relay> {
  const database =
    options.database ?? join(temporaryDirectory(), "relay.sqlite3");
  const port = await freePort();
  const child = launch(
    database,
    port,
    options.enrollment ?? { type: "token", token: ENROLLMENT_TOKEN },
  );
  const origin = `http://127.0.0.1:${String(port)}`;
  await waitForListener(origin, child);
  return {
    origin,
    database,
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
    },
  };
}

export type Installation = Readonly<{
  installationId: string;
  publicKeyBase64: string;
  sign(message: string): string;
}>;

export function createInstallation(
  installationId = `in_${crypto.randomUUID()}`,
): Installation {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    installationId,
    publicKeyBase64: raw.toString("base64"),
    sign: (message) =>
      sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

export function enroll(
  relay: Relay,
  installation: Installation,
  authorization: string | null = `Bearer ${ENROLLMENT_TOKEN}`,
): Promise<Response> {
  return fetch(`${relay.origin}/v1/installations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
    },
    body: JSON.stringify({
      installationId: installation.installationId,
      publicKeyBase64: installation.publicKeyBase64,
    }),
  });
}

export type Frame = Record<string, unknown> & { type: string };

export class Peer {
  readonly socket: WebSocket;
  private readonly frames: Frame[] = [];
  private readonly waiters: ((frame: Frame) => void)[] = [];
  readonly closed: Promise<void>;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolveClosed) => {
      socket.addEventListener("close", () => resolveClosed());
    });
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.frames.push(frame);
      else waiter(frame);
    });
  }

  static async open(relay: Relay): Promise<Peer> {
    const socket = new WebSocket(
      `${relay.origin.replace("http", "ws")}/v1/connect`,
    );
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("socket error")),
        {
          once: true,
        },
      );
    });
    return new Peer(socket);
  }

  next(timeoutMs = 5_000): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolveFrame, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a relay frame")),
        timeoutMs,
      );
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolveFrame(frame);
      });
    });
  }

  send(message: unknown): void {
    this.socket.send(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  }

  close(): void {
    this.socket.close();
  }
}

export async function connect(
  relay: Relay,
  installation: Installation,
  protocol = 1,
): Promise<Peer> {
  const peer = await Peer.open(relay);
  const challenge = await peer.next();
  if (challenge.type !== "challenge" || typeof challenge.nonce !== "string")
    throw new Error(`expected a challenge, got ${challenge.type}`);
  peer.send({
    type: "authenticate",
    protocol,
    installationId: installation.installationId,
    signatureBase64: installation.sign(challenge.nonce),
  });
  return peer;
}

export async function authenticated(
  relay: Relay,
  installation: Installation,
): Promise<Peer> {
  const peer = await connect(relay, installation);
  const reply = await peer.next();
  if (reply.type !== "authenticated")
    throw new Error(`expected authenticated, got ${JSON.stringify(reply)}`);
  return peer;
}

export function syncBindings(
  peer: Peer,
  bindings: readonly { bindingId: string; connector: string }[],
): void {
  peer.send({ type: "sync_bindings", protocol: 1, bindings });
}

export async function routable(
  relay: Relay,
  connector: string,
  bindingId: string,
): Promise<number> {
  const response = await fetch(
    `${relay.origin}/v1/webhooks/${connector}/${bindingId}`,
    { method: "POST", body: "{}" },
  );
  return response.status;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function settle(peer: Peer): Promise<void> {
  peer.send("{}");
  const reply = await peer.next();
  if (reply.type !== "error" || reply.code !== "invalid_message")
    throw new Error(`expected a barrier error, got ${JSON.stringify(reply)}`);
}
