import type { Connector } from "../connectors/connector.js";
import type { ConnectorType, DeliveryMessage } from "./types.js";
import type { Persistence } from "../persistence/store.js";
import type { BindingCredentialService } from "../security/identity.js";

export type DeliveryWorkerOptions = {
  store: Persistence;
  credentials: BindingCredentialService;
  connectors: ReadonlyMap<ConnectorType, Connector>;
  maxAttempts?: number;
  now?: () => Date;
};

export class DeliveryWorker {
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  public constructor(private readonly options: DeliveryWorkerOptions) {
    this.maxAttempts = options.maxAttempts ?? 8;
    this.now = options.now ?? (() => new Date());
  }

  public async drain(limit = 100): Promise<number> {
    const deliveries = this.options.store.claimDueDeliveries(limit, this.now());
    for (const delivery of deliveries) {
      try {
        const session =
          delivery.sessionId === null
            ? undefined
            : this.options.store.getSession(delivery.sessionId);
        const metadataBindingId =
          delivery.metadata !== null &&
          typeof delivery.metadata.bindingId === "string"
            ? delivery.metadata.bindingId
            : undefined;
        const bindingId = session?.bindingId ?? metadataBindingId;
        if (bindingId === undefined)
          throw new Error("Delivery has no Binding association");
        const connector = this.options.connectors.get(delivery.connector);
        if (connector === undefined)
          throw new Error(`Connector ${delivery.connector} is unavailable`);
        const credentials = await this.options.credentials.require(bindingId);
        const message: DeliveryMessage = {
          kind: delivery.kind,
          remoteConversationId: delivery.remoteConversationId,
          body: delivery.body,
          ...(delivery.metadata === null
            ? {}
            : { metadata: delivery.metadata }),
        };
        await connector.deliver(message, credentials);
        this.options.store.markDeliveryDelivered(delivery.id, this.now());
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (delivery.attempts >= this.maxAttempts) {
          this.options.store.markDeliveryFailed(
            delivery.id,
            detail,
            this.now(),
          );
        } else {
          const delayMs = Math.min(
            1_000 * 2 ** (delivery.attempts - 1),
            5 * 60_000,
          );
          this.options.store.markDeliveryRetry(
            delivery.id,
            detail,
            new Date(this.now().getTime() + delayMs),
            this.now(),
          );
        }
      }
    }
    return deliveries.length;
  }
}
