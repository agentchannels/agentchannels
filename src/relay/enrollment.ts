import { AgentChannelsError, internalError } from "../errors.ts";
import type { Binding, ConnectorType } from "../model.ts";
import type { Persistence } from "../store/store.ts";
import type { InstallationIdentityService } from "../security/identity.ts";
import {
  HOSTED_RELAY_ORIGIN,
  parseRelayOrigin,
  type RelayEndpoints,
} from "./origin.ts";

export type RelayConnectionUpdate = {
  bindingId: string;
  connector: ConnectorType;
  webhookUrl: string;
};

export type RelaySelectionResult =
  | {
      status: "action_required";
      action: "acknowledge_binding_reconfiguration";
      from: string;
      to: string;
      bindings: RelayConnectionUpdate[];
    }
  | {
      status: "action_required";
      action: "restart_daemon";
      relayOrigin: string;
      bindings: RelayConnectionUpdate[];
    };

export type RelayStatus =
  | { status: "uninitialized" }
  | {
      status: "configured";
      relayOrigin: string;
      websocketUrl: string;
      installationUrl: string;
      enrolledAt: string | null;
      lastConnectedAt: string | null;
    };

export type RelayManagerOptions = {
  store: Persistence;
  identity: InstallationIdentityService;
  fetch?: typeof fetch;
  now?: () => Date;
};

export class RelayManager {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  private readonly options: RelayManagerOptions;

  public constructor(options: RelayManagerOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public status(): RelayStatus {
    const installation = this.options.store.getInstallationState();
    if (installation?.relayOrigin === null || installation === undefined) {
      return { status: "uninitialized" };
    }
    const endpoints = parseRelayOrigin(installation.relayOrigin);
    return {
      status: "configured",
      relayOrigin: endpoints.origin,
      websocketUrl: endpoints.websocketUrl.toString(),
      installationUrl: endpoints.installationUrl.toString(),
      enrolledAt: installation.enrolledAt,
      lastConnectedAt: installation.lastConnectedAt,
    };
  }

  public endpoints(): RelayEndpoints | undefined {
    const status = this.status();
    return status.status === "configured"
      ? parseRelayOrigin(status.relayOrigin)
      : undefined;
  }

  public async ensureHosted(): Promise<RelayEndpoints> {
    const existing = this.endpoints();
    if (existing !== undefined) return existing;
    await this.enrollAndPersist(parseRelayOrigin(HOSTED_RELAY_ORIGIN));
    return parseRelayOrigin(HOSTED_RELAY_ORIGIN);
  }

  public async use(input: {
    origin: string;
    enrollmentToken?: string;
    acknowledgeBindingReconfiguration?: boolean;
  }): Promise<RelaySelectionResult> {
    const target = parseRelayOrigin(input.origin);
    const requirement = this.preview(target.origin);
    if (
      requirement !== undefined &&
      input.acknowledgeBindingReconfiguration !== true
    )
      return requirement;
    const affected = this.affectedConnections(target);
    await this.enrollAndPersist(target, input.enrollmentToken);
    return {
      status: "action_required",
      action: "restart_daemon",
      relayOrigin: target.origin,
      bindings: affected,
    };
  }

  public preview(
    origin: string,
  ):
    | Extract<
        RelaySelectionResult,
        { action: "acknowledge_binding_reconfiguration" }
      >
    | undefined {
    const target = parseRelayOrigin(origin);
    const current = this.options.store.getInstallationState();
    const affected = this.affectedConnections(target);
    if (
      current?.relayOrigin !== null &&
      current !== undefined &&
      current.relayOrigin !== target.origin &&
      affected.length > 0
    ) {
      return {
        status: "action_required",
        action: "acknowledge_binding_reconfiguration",
        from: current.relayOrigin,
        to: target.origin,
        bindings: affected,
      };
    }
    return undefined;
  }

  private affectedConnections(target: RelayEndpoints): RelayConnectionUpdate[] {
    const completed = this.options.store
      .listAllBindings()
      .map((binding) => this.connectionUpdate(target, binding));
    const pending = this.options.store.listAllBindingSetups().map((setup) => ({
      bindingId: setup.id,
      connector: setup.connector,
      webhookUrl: target.webhookUrl(setup.connector, setup.id).toString(),
    }));
    return [...completed, ...pending].sort((left, right) =>
      left.bindingId.localeCompare(right.bindingId),
    );
  }

  private connectionUpdate(
    target: RelayEndpoints,
    binding: Binding,
  ): RelayConnectionUpdate {
    return {
      bindingId: binding.id,
      connector: binding.connector,
      webhookUrl: target.webhookUrl(binding.connector, binding.id).toString(),
    };
  }

  private async enrollAndPersist(
    target: RelayEndpoints,
    enrollmentToken?: string,
  ): Promise<void> {
    const identity = await this.options.identity.getOrCreate();
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (enrollmentToken !== undefined) {
      headers.authorization = `Bearer ${enrollmentToken}`;
    }
    const response = await this.fetcher(target.installationUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(identity),
    });
    if (!response.ok) {
      throw new AgentChannelsError(
        "RELAY_UNAVAILABLE",
        `Relay enrollment failed at ${target.origin}: HTTP ${String(response.status)}`,
        ["Retry after the Relay is reachable."],
      );
    }
    const registration = (await response.json()) as {
      installationId?: unknown;
    };
    if (registration.installationId !== identity.installationId) {
      throw new AgentChannelsError(
        "RELAY_UNAVAILABLE",
        "Relay enrollment returned a different installation ID.",
        ["Retry enrollment; if it persists the Relay is misconfigured."],
      );
    }
    const enrolledAt = this.now();
    const existing = this.options.store.getInstallationState();
    if (existing === undefined) {
      this.options.store.createInstallation({
        id: identity.installationId,
        publicKey: identity.publicKeyBase64,
        relayOrigin: target.origin,
        enrolledAt: enrolledAt.toISOString(),
        createdAt: enrolledAt.toISOString(),
      });
    } else {
      if (
        existing.id !== identity.installationId ||
        existing.publicKey !== identity.publicKeyBase64
      ) {
        throw internalError(
          "Persisted installation identity does not match the OS credential store.",
        );
      }
      this.options.store.setInstallationRelay(
        identity.installationId,
        target.origin,
        enrolledAt,
      );
    }
  }
}
