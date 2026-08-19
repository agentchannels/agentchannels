import type { Connector } from "../connectors/connector.js";
import type { ConnectorType, InboundRequest } from "../core/types.js";
import type { Persistence } from "../persistence/store.js";
import type { BindingCredentialService } from "../security/identity.js";
import type { SessionCoordinator } from "../core/session-coordinator.js";
import type { RelayWebhook, RelayWebhookResponse } from "./relay-client.js";

export type IngressServiceOptions = {
  store: Persistence;
  credentials: BindingCredentialService;
  connectors: ReadonlyMap<ConnectorType, Connector>;
  sessions: SessionCoordinator;
  onError?(metadata: {
    bindingId: string;
    requestId: string;
    error: string;
  }): void;
};

/** Verifies locally held connector secrets before any event may reach execution. */
export class IngressService {
  public constructor(private readonly options: IngressServiceOptions) {}

  public async handle(message: RelayWebhook): Promise<RelayWebhookResponse> {
    if (Date.parse(message.expiresAt) <= Date.now()) {
      return { status: 200, body: "" };
    }
    const binding = this.options.store.getBinding(message.bindingId);
    if (binding === undefined || binding.connector !== message.connector) {
      return { status: 404, body: "Unknown binding" };
    }
    const connector = this.options.connectors.get(binding.connector);
    if (connector === undefined)
      return { status: 503, body: "Connector unavailable" };

    try {
      const credentials = await this.options.credentials.require(binding.id);
      const request: InboundRequest = {
        bindingId: binding.id,
        deliveryId: message.requestId,
        timestamp: new Date(message.receivedAt),
        rawBody: Buffer.from(message.rawBodyBase64, "base64"),
        headers: message.headers,
      };
      const result = connector.verifyAndParse(request, credentials);
      if (!result.ok) return { status: result.status, body: result.reason };
      if (result.command !== undefined) {
        void this.options.sessions
          .accept(binding.id, result.command)
          .catch((error: unknown) => {
            this.options.onError?.({
              bindingId: binding.id,
              requestId: message.requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return result.response ?? { status: 200, body: "" };
    } catch (error) {
      this.options.onError?.({
        bindingId: binding.id,
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 500, body: "Local verification failed" };
    }
  }
}
