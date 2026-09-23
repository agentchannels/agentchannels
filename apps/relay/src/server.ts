import { randomBytes, randomUUID } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import {
  isIdentifier,
  type LocalToRelayMessage,
  localToRelayMessageSchema,
  PROTOCOL,
  ROUTE_ID_PATTERN,
  routeIdSchema,
} from "@agentchannels/protocol";
import { z } from "zod";

import type { RelayConfig } from "./config.ts";
import {
  Connection,
  type ConnectionRegistry,
  type Delivery,
  inMemoryRegistry,
} from "./connection.ts";
import { decodeBase64, publicKeyFrom, signatureIsValid } from "./identity.ts";
import type { RelayStore } from "./store.ts";
import { tokensMatch } from "./token.ts";

type SocketState = {
  nonce: string;
  installationId: string | null;
  connection: Connection | null;
  authenticationTimer: ReturnType<typeof setTimeout> | null;
};

type Socket = ServerWebSocket<SocketState>;

type Parsed =
  | Readonly<{ ok: true; message: LocalToRelayMessage }>
  | Readonly<{ ok: false; code: string; message: string }>;

const enrollmentSchema = z.object({
  installationId: routeIdSchema,
  publicKeyBase64: z.string(),
});

const WEBHOOK_ROUTE = /^\/v1\/webhooks\/([^/]+)\/([^/]+)$/;
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function frame(value: Record<string, unknown>): string {
  return JSON.stringify({ ...value, protocol: PROTOCOL });
}

function errorFrame(code: string, message: string): string {
  return frame({ type: "error", code, message });
}

function parseLocalMessage(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "invalid_message",
      message: "messages must be JSON",
    };
  }
  const declared =
    typeof value === "object" && value !== null && "protocol" in value
      ? value.protocol
      : undefined;
  if (typeof declared === "number" && declared !== PROTOCOL)
    return {
      ok: false,
      code: "unsupported_protocol",
      message: `protocol ${String(declared)} is not supported`,
    };
  const parsed = localToRelayMessageSchema.safeParse(value);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : {
        ok: false,
        code: "invalid_message",
        message: "unsupported relay message",
      };
}

function bearerToken(request: Request): Buffer {
  const header = request.headers.get("authorization") ?? "";
  return Buffer.from(
    header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "",
    "utf8",
  );
}

function localResponse(delivery: Delivery): Response {
  if (delivery.type === "offline") return new Response(null, { status: 200 });
  const headers = new Headers();
  for (const [name, value] of Object.entries(delivery.headers)) {
    try {
      headers.set(name, value);
    } catch {}
  }
  try {
    return new Response(
      NULL_BODY_STATUSES.has(delivery.status) ? null : delivery.body,
      { status: delivery.status, headers },
    );
  } catch {
    return new Response(null, { status: 502 });
  }
}

export type Relay = Readonly<{
  server: Server<SocketState>;
  stop(): Promise<void>;
}>;

export function startRelay(
  config: RelayConfig,
  store: RelayStore,
  registry: ConnectionRegistry = inMemoryRegistry(),
): Relay {
  const enroll = async (request: Request): Promise<Response> => {
    if (
      config.enrollment.type === "token" &&
      !tokensMatch(config.enrollment.token, bearerToken(request))
    )
      return new Response("unauthorized", { status: 401 });
    const parsed = enrollmentSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return new Response("invalid installation request", { status: 400 });
    const key = decodeBase64(parsed.data.publicKeyBase64);
    if (key === null || publicKeyFrom(key) === null)
      return new Response(
        "publicKeyBase64 must contain an Ed25519 public key",
        {
          status: 400,
        },
      );
    const outcome = store.register(parsed.data.installationId, key, {
      open: config.enrollment.type === "open",
    });
    if (outcome === "conflict") return new Response(null, { status: 409 });
    if (outcome === "capacity") return new Response(null, { status: 429 });
    return Response.json({ installationId: parsed.data.installationId });
  };

  const forward = async (
    request: Request,
    connector: string,
    bindingId: string,
  ): Promise<Response> => {
    if (!isIdentifier(connector) || !ROUTE_ID_PATTERN.test(bindingId))
      return new Response(null, { status: 404 });
    const owner = store.owner(bindingId, connector);
    if (owner === null) return new Response(null, { status: 404 });
    const connection = registry.get(owner);
    if (connection === undefined) return new Response(null, { status: 200 });

    const body = Buffer.from(await request.arrayBuffer());
    const received = Date.now();
    const deadline = received + config.responseBudgetMs;
    const requestId = randomUUID();
    const delivery = await connection.deliver(
      frame({
        type: "webhook",
        requestId,
        bindingId,
        connector,
        receivedAt: new Date(received).toISOString(),
        expiresAt: new Date(deadline).toISOString(),
        headers: Object.fromEntries(request.headers),
        rawBodyBase64: body.toString("base64"),
      }),
      requestId,
      deadline,
    );
    return localResponse(delivery);
  };

  const authenticate = (socket: Socket, message: LocalToRelayMessage): void => {
    if (message.type !== "authenticate") {
      socket.send(errorFrame("invalid_message", "authenticate is required"));
      socket.close();
      return;
    }
    const publicKey = store.publicKey(message.installationId);
    if (
      publicKey === null ||
      !signatureIsValid(publicKey, socket.data.nonce, message.signatureBase64)
    ) {
      socket.send(
        errorFrame("unauthenticated", "invalid installation authentication"),
      );
      socket.close();
      return;
    }
    if (socket.data.authenticationTimer !== null)
      clearTimeout(socket.data.authenticationTimer);
    store.touch(message.installationId);
    socket.send(frame({ type: "authenticated" }));
    const connection = new Connection({
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    });
    socket.data.installationId = message.installationId;
    socket.data.connection = connection;
    registry.attach(message.installationId, connection);
  };

  const dispatch = (
    installationId: string,
    connection: Connection,
    message: LocalToRelayMessage,
  ): void => {
    if (message.type === "authenticate") {
      connection.notify(
        errorFrame("invalid_message", "authenticate is only valid once"),
      );
      return;
    }
    if (message.type === "sync_bindings") {
      if (!store.replaceBindings(installationId, message.bindings))
        connection.notify(
          errorFrame(
            "binding_conflict",
            "one or more Binding IDs belong to another installation",
          ),
        );
      return;
    }
    connection.respond(message.requestId, {
      type: "response",
      status: message.status,
      headers: message.headers,
      body: message.body,
    });
  };

  const server = Bun.serve<SocketState>({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: config.maxRequestBodyBytes,
    fetch(request, bunServer) {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/v1/installations")
        return enroll(request);
      if (request.method === "GET" && pathname === "/v1/connect") {
        const upgraded = bunServer.upgrade(request, {
          data: {
            nonce: randomBytes(32).toString("base64"),
            installationId: null,
            connection: null,
            authenticationTimer: null,
          },
        });
        return upgraded
          ? undefined
          : new Response("WebSocket upgrade required", { status: 426 });
      }
      const route = WEBHOOK_ROUTE.exec(pathname);
      if (request.method === "POST" && route !== null)
        return forward(request, route[1] ?? "", route[2] ?? "");
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.send(frame({ type: "challenge", nonce: socket.data.nonce }));
        socket.data.authenticationTimer = setTimeout(
          () => socket.close(),
          config.authenticationBudgetMs,
        );
      },
      message(socket, raw) {
        const { connection, installationId } = socket.data;
        if (typeof raw !== "string") {
          const error = errorFrame(
            "invalid_message",
            "messages must be JSON text",
          );
          if (connection === null) {
            socket.send(error);
            socket.close();
          } else connection.notify(error);
          return;
        }
        const parsed = parseLocalMessage(raw);
        if (connection === null || installationId === null) {
          if (parsed.ok) authenticate(socket, parsed.message);
          else {
            socket.send(errorFrame(parsed.code, parsed.message));
            socket.close();
          }
          return;
        }
        if (parsed.ok) dispatch(installationId, connection, parsed.message);
        else connection.notify(errorFrame(parsed.code, parsed.message));
      },
      drain(socket) {
        socket.data.connection?.drained();
      },
      close(socket) {
        const { connection, installationId, authenticationTimer } = socket.data;
        if (authenticationTimer !== null) clearTimeout(authenticationTimer);
        if (connection === null || installationId === null) return;
        connection.release();
        registry.detach(installationId, connection);
      },
    },
  });

  return {
    server,
    stop: async () => {
      registry.closeAll();
      await server.stop(true);
    },
  };
}
