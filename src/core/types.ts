export const sessionStatuses = [
  "queued",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "stopped",
] as const;

export type SessionStatus = (typeof sessionStatuses)[number];
export type ConnectorType = "linear" | "slack";
export type RuntimeType = "claude-code";

export type Agent = {
  id: string;
  name: string;
  cwd: string;
  additionalDirectories: string[];
  runtime: RuntimeType;
  createdAt: string;
};

export type Binding = {
  id: string;
  agentId: string;
  connector: ConnectorType;
  operatorUserId: string;
  externalInstallationId: string;
  createdAt: string;
};

export type Session = {
  id: string;
  bindingId: string;
  remoteConversationId: string;
  runtimeSessionId: string | null;
  cwd: string;
  worktreePath: string;
  baseCommit: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type InteractionKind = "question" | "permission" | "plan";
export type InteractionStatus = "pending" | "answered" | "denied" | "cancelled";

export type Interaction = {
  id: string;
  sessionId: string;
  kind: InteractionKind;
  status: InteractionStatus;
  request: unknown;
  response: unknown;
  createdAt: string;
  resolvedAt: string | null;
};

export type InboundRequest = {
  bindingId: string;
  deliveryId: string;
  timestamp: Date;
  rawBody: Buffer;
  headers: Readonly<Record<string, string>>;
};

export type ConnectorCommand =
  | {
      type: "message";
      deliveryId: string;
      remoteConversationId: string;
      remoteUserId: string;
      text: string;
    }
  | {
      type: "stop";
      deliveryId: string;
      remoteConversationId: string;
      remoteUserId: string;
    }
  | {
      type: "interaction_response";
      deliveryId: string;
      remoteConversationId: string;
      remoteUserId: string;
      interactionId: string;
      response: unknown;
    };

export type DeliveryKind =
  | "progress"
  | "final"
  | "question"
  | "permission"
  | "plan"
  | "stopped"
  | "error";

export type DeliveryMessage = {
  kind: DeliveryKind;
  remoteConversationId: string;
  body: string;
  metadata?: Readonly<Record<string, unknown>>;
};

export type RemoteUser = { id: string; name: string; email: string | null };
