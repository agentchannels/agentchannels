import WebSocket, { type RawData } from "ws";

import type { Binding } from "../core/types.js";
import {
  relayToLocalMessageSchema,
  type LocalToRelayMessage,
  type RelayToLocalMessage,
} from "../protocol/messages.js";
import type { InstallationIdentityService } from "../security/identity.js";
import type { RelayEndpoints } from "../relay/origin.js";

export type RelayWebhook = Extract<RelayToLocalMessage, { type: "webhook" }>;
export type RelayWebhookResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

export type RelayClientOptions = {
  endpoints: RelayEndpoints;
  identity: InstallationIdentityService;
  listBindings(): readonly Pick<Binding, "id" | "connector">[];
  handleWebhook(request: RelayWebhook): Promise<RelayWebhookResponse>;
  onStateChange?(connected: boolean): void;
};

function websocketText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private stopping = false;
  private authenticated = false;

  public constructor(private readonly options: RelayClientOptions) {}

  public async run(): Promise<void> {
    this.stopping = false;
    let delay = 250;
    while (!this.isStopping()) {
      try {
        await this.connectOnce();
        delay = 250;
      } catch (error) {
        if (this.isStopping()) break;
        this.options.onStateChange?.(false);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
        if (
          error instanceof Error &&
          (error.message.includes("authentication") ||
            error.message.startsWith("Relay "))
        ) {
          throw error;
        }
      }
    }
  }

  public stop(): void {
    this.stopping = true;
    this.socket?.close();
  }

  public syncBindings(): boolean {
    const socket = this.socket;
    if (
      !this.authenticated ||
      socket === null ||
      socket.readyState !== WebSocket.OPEN
    )
      return false;
    try {
      this.send(socket, {
        type: "sync_bindings",
        protocol: 1,
        bindings: this.options
          .listBindings()
          .map(({ id, connector }) => ({ bindingId: id, connector })),
      });
      return true;
    } catch {
      return false;
    }
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.endpoints.websocketUrl);
      this.socket = socket;
      let authenticated = false;

      socket.on("message", (data) => {
        void this.handleMessage(socket, websocketText(data)).then(
          (didAuthenticate) => {
            if (didAuthenticate) authenticated = true;
          },
          (error: unknown) => {
            socket.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
      socket.once("error", (error) => reject(error));
      socket.once("close", () => {
        this.authenticated = false;
        this.options.onStateChange?.(false);
        if (!authenticated && !this.stopping)
          reject(new Error("Relay authentication connection closed"));
        else resolve();
      });
    });
  }

  private async handleMessage(
    socket: WebSocket,
    raw: string,
  ): Promise<boolean> {
    let wireMessage: unknown;
    try {
      wireMessage = JSON.parse(raw);
    } catch {
      throw new Error("Relay invalid_message: incompatible protocol message");
    }
    const parsed = relayToLocalMessageSchema.safeParse(wireMessage);
    if (!parsed.success) {
      throw new Error("Relay invalid_message: incompatible protocol message");
    }
    const message = parsed.data;
    switch (message.type) {
      case "challenge": {
        const identity = await this.options.identity.getOrCreate();
        this.send(socket, {
          type: "authenticate",
          protocol: 1,
          installationId: identity.installationId,
          signatureBase64: await this.options.identity.signChallenge(
            message.nonce,
          ),
        });
        return false;
      }
      case "authenticated":
        this.authenticated = true;
        this.syncBindings();
        this.options.onStateChange?.(true);
        return true;
      case "webhook": {
        const response = await this.options.handleWebhook(message);
        this.send(socket, {
          type: "webhook_response",
          protocol: 1,
          requestId: message.requestId,
          status: response.status,
          headers: response.headers ?? {},
          body: response.body ?? "",
        });
        return false;
      }
      case "error":
        throw new Error(`Relay ${message.code}: ${message.message}`);
    }
  }

  private send(socket: WebSocket, message: LocalToRelayMessage): void {
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Relay connection is not open");
    socket.send(JSON.stringify(message));
  }
}
