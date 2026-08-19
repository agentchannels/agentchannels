import type {
  ConnectorCommand,
  ConnectorType,
  DeliveryMessage,
  InboundRequest,
  RemoteUser,
} from "../core/types.js";

export type VerificationResult =
  | {
      ok: true;
      response?: {
        status: number;
        headers?: Record<string, string>;
        body?: string;
      };
      command?: ConnectorCommand;
    }
  | { ok: false; status: number; reason: string };

export type ConnectorCredentials = Readonly<Record<string, string>>;

export type Connector = {
  readonly type: ConnectorType;
  verifyAndParse(
    request: InboundRequest,
    credentials: ConnectorCredentials,
  ): VerificationResult;
  deliver(
    message: DeliveryMessage,
    credentials: ConnectorCredentials,
  ): Promise<void>;
  searchUsers(
    query: string,
    credentials: ConnectorCredentials,
  ): Promise<RemoteUser[]>;
};
