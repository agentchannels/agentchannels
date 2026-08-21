import type { Connector } from "../connectors/connector.ts";
import type { ConnectorType, DeliveryMessage } from "../model.ts";
import type { Persistence } from "../store/store.ts";
import type { BindingCredentialService } from "../security/identity.ts";
import { redactSensitiveText } from "../security/redact.ts";
import { internalError, invalidState } from "../errors.ts";

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

  private readonly options: DeliveryWorkerOptions;

  public constructor(options: DeliveryWorkerOptions) {
    this.options = options;
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
          throw internalError("Delivery has no Binding association.");
        const connector = this.options.connectors.get(delivery.connector);
        if (connector === undefined)
          throw invalidState(
            `Connector ${delivery.connector} is unavailable.`,
            ["Reinstall AgentChannels with the connector this Binding uses."],
          );
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
        const detail = redactSensitiveText(
          error instanceof Error ? error.message : String(error),
        );
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
