import type { Connector } from "../connectors/connector.ts";
import type { ConnectorType, InboundRequest } from "../model.ts";
import type { Persistence } from "../store/store.ts";
import type { BindingCredentialCache } from "../security/credential-cache.ts";
import { redactErrorDiagnostic } from "../security/redact.ts";
import type { SessionCoordinator } from "../engine/coordinator.ts";
import type { RelayWebhook, RelayWebhookResponse } from "../relay/client.ts";

export type IngressServiceOptions = {
  store: Persistence;
  credentials: BindingCredentialCache;
  connectors: ReadonlyMap<ConnectorType, Connector>;
  sessions: SessionCoordinator;
  onError?(metadata: {
    bindingId: string;
    requestId: string;
    error: string;
  }): void;
};

/**
 * Verifies locally held connector secrets before any event may reach execution.
 *
 * The Relay drops a forwarded webhook if this handler does not answer inside its
 * response budget, so nothing here may await I/O. Credentials come from an
 * in-memory cache, signature verification is local CPU work, and execution is
 * dispatched without being awaited.
 */
export class IngressService {
  private readonly options: IngressServiceOptions;

  public constructor(options: IngressServiceOptions) {
    this.options = options;
  }

  public handle(message: RelayWebhook): RelayWebhookResponse {
    if (Date.parse(message.expiresAt) <= Date.now()) {
      return { status: 200, body: "" };
    }
    const binding = this.options.store.getBinding(message.bindingId);
    if (binding === undefined) {
      const setup = this.options.store.getBindingSetup(message.bindingId);
      const connector =
        setup?.connector === message.connector
          ? this.options.connectors.get(setup.connector)
          : undefined;
      const response = connector?.handlePendingWebhook?.(message);
      return response ?? { status: 404, body: "Unknown binding" };
    }
    if (binding.connector !== message.connector) {
      return { status: 404, body: "Unknown binding" };
    }
    const connector = this.options.connectors.get(binding.connector);
    if (connector === undefined)
      return { status: 503, body: "Connector unavailable" };

    // Not primed means the daemon has not loaded this Binding's credentials yet.
    // Asking the provider to retry is honest; blocking on the keyring here would
    // risk the Relay dropping the event outright.
    const credentials = this.options.credentials.cached(binding.id);
    if (credentials === undefined) {
      this.options.onError?.({
        bindingId: binding.id,
        requestId: message.requestId,
        error: "Binding credentials are not loaded yet",
      });
      return { status: 503, body: "Credentials not loaded" };
    }

    try {
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
              error: redactErrorDiagnostic(error),
            });
          });
      }
      return result.response ?? { status: 200, body: "" };
    } catch (error) {
      this.options.onError?.({
        bindingId: binding.id,
        requestId: message.requestId,
        error: redactErrorDiagnostic(error),
      });
      return { status: 500, body: "Local verification failed" };
    }
  }
}
