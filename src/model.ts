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
/**
 * Which channel provider a Binding talks to, and which runtime an Agent runs.
 *
 * Both are opaque identifiers rather than unions of known names. A closed set
 * here would have to be repeated in the SQLite schema, the Relay wire protocol,
 * and the Relay itself, so adding one provider would mean a coordinated release
 * of two components and two schema migrations. Constraining the shape instead
 * keeps that cost at one new file.
 */
export type ConnectorType = string;
export type RuntimeType = string;

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,31}$/;

export function isConnectorType(value: string): value is ConnectorType {
  return IDENTIFIER.test(value);
}

export function isRuntimeType(value: string): value is RuntimeType {
  return IDENTIFIER.test(value);
}

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
      allowNewSession?: boolean;
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

const transitions: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  queued: ["running", "failed", "stopped"],
  running: ["waiting", "completed", "interrupted", "failed", "stopped"],
  waiting: ["running", "interrupted", "failed", "stopped"],
  completed: ["queued"],
  interrupted: ["queued", "failed", "stopped"],
  failed: [],
  stopped: ["queued"],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return transitions[from].includes(to);
}
