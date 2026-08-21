import { randomUUID } from "node:crypto";
import type {
  Agent,
  Binding,
  ConnectorType,
  Interaction,
  InteractionKind,
  InteractionStatus,
  RuntimeType,
  Session,
  SessionStatus,
} from "../model.ts";
import { internalError } from "../errors.ts";

/**
 * The persisted shapes and the translation between SQLite rows and them.
 *
 * Every column name in the product appears here and nowhere else, so a schema
 * change has one place to land.
 */

export type Installation = {
  id: string;
  publicKey: string;
  relayOrigin: string | null;
  createdAt: string;
  enrolledAt: string | null;
  lastConnectedAt: string | null;
};

export type AccessGrant = {
  bindingId: string;
  userId: string;
  grantedAt: string;
};

export type BindingSetup = {
  id: string;
  agentId: string;
  connector: ConnectorType;
  step: BindingSetupStep;
  artifactPath: string | null;
  externalInstallationId: string | null;
  externalInstallationName: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

export type BindingSetupStep =
  | "selected"
  | "admin_action"
  | "credentials"
  | "operator";

export type FollowUp = {
  id: string;
  sessionId: string;
  sequence: number;
  remoteUserId: string;
  text: string;
  status: "queued" | "delivered";
  createdAt: string;
  deliveredAt: string | null;
};

export type DeliveryStatus =
  | "pending"
  | "sending"
  | "retrying"
  | "delivered"
  | "failed";
export type Delivery = {
  id: string;
  sessionId: string | null;
  connector: ConnectorType;
  remoteConversationId: string;
  kind:
    | "progress"
    | "final"
    | "question"
    | "permission"
    | "plan"
    | "stopped"
    | "error";
  body: string;
  metadata: Record<string, unknown> | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentInput = {
  id?: string;
  name: string;
  cwd: string;
  additionalDirectories?: readonly string[];
  runtime?: RuntimeType;
  createdAt?: string;
};
export type CreateBindingInput = {
  id?: string;
  agentId: string;
  connector: ConnectorType;
  operatorUserId: string;
  externalInstallationId: string;
  createdAt?: string;
};
export type CreateSessionInput = {
  id?: string;
  bindingId: string;
  remoteConversationId: string;
  runtimeSessionId?: string | null;
  cwd: string;
  worktreePath: string;
  baseCommit: string;
  createdAt?: string;
};

export type PersistenceOptions = {
  /** Completed sessions remain resumable for this long unless explicitly overridden. */
  sessionRetentionMs?: number;
  backupDirectory?: string;
  componentVersion?: string;
  migrationNow?: () => Date;
  backupDatabase?: (source: string, destination: string) => void;
};

export const id = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const iso = (value: Date | string | undefined): string =>
  (value instanceof Date ? value : new Date(value ?? Date.now())).toISOString();
export const json = (value: unknown): string => JSON.stringify(value);
export const parseJson = (value: string): unknown =>
  JSON.parse(value) as unknown;
export function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw internalError(message);
  return value;
}

export function assertSafeMetadata(
  value: Record<string, unknown> | null | undefined,
): void {
  if (value === null || value === undefined) return;
  const forbidden = /(?:secret|private.?key|password|token|credential)/i;
  const inspect = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) inspect(item);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.test(key))
        throw internalError(
          `Sensitive metadata field ${key} cannot be persisted.`,
        );
      inspect(child);
    }
  };
  inspect(value);
}

export function mapAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    name: row.name as string,
    cwd: row.cwd as string,
    additionalDirectories: parseJson(
      row.additional_directories_json as string,
    ) as string[],
    runtime: row.runtime as RuntimeType,
    createdAt: row.created_at as string,
  };
}
export function mapBinding(row: Record<string, unknown>): Binding {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    connector: row.connector as ConnectorType,
    operatorUserId: row.operator_user_id as string,
    externalInstallationId: row.external_installation_id as string,
    createdAt: row.created_at as string,
  };
}
export function mapBindingSetup(row: Record<string, unknown>): BindingSetup {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    connector: row.connector as ConnectorType,
    step: (row.step as BindingSetupStep | undefined) ?? "selected",
    artifactPath: (row.artifact_path as string | null) ?? null,
    externalInstallationId:
      (row.external_installation_id as string | null) ?? null,
    externalInstallationName:
      (row.external_installation_name as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt:
      (row.updated_at as string | null | undefined) ??
      (row.created_at as string),
    lastError: (row.last_error as string | null) ?? null,
  };
}
export function mapSession(
  row: Record<string, unknown>,
): Session & { retentionExpiresAt: string | null } {
  return {
    id: row.id as string,
    bindingId: row.binding_id as string,
    remoteConversationId: row.remote_conversation_id as string,
    runtimeSessionId: (row.runtime_session_id as string | null) ?? null,
    cwd: row.cwd as string,
    worktreePath: row.worktree_path as string,
    baseCommit: row.base_commit as string,
    status: row.status as SessionStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    retentionExpiresAt: (row.retention_expires_at as string | null) ?? null,
  };
}
export function mapInteraction(row: Record<string, unknown>): Interaction {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    kind: row.kind as InteractionKind,
    status: row.status as InteractionStatus,
    request: parseJson(row.request_json as string),
    response:
      row.response_json === null
        ? null
        : parseJson(row.response_json as string),
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}
export function mapFollowUp(row: Record<string, unknown>): FollowUp {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    sequence: row.sequence as number,
    remoteUserId: row.remote_user_id as string,
    text: row.text as string,
    status: row.status as "queued" | "delivered",
    createdAt: row.created_at as string,
    deliveredAt: (row.delivered_at as string | null) ?? null,
  };
}
export function mapDelivery(row: Record<string, unknown>): Delivery {
  return {
    id: row.id as string,
    sessionId: (row.session_id as string | null) ?? null,
    connector: row.connector as ConnectorType,
    remoteConversationId: row.remote_conversation_id as string,
    kind: row.kind as Delivery["kind"],
    body: row.body as string,
    metadata:
      row.metadata_json === null
        ? null
        : (parseJson(row.metadata_json as string) as Record<string, unknown>),
    status: row.status as DeliveryStatus,
    attempts: row.attempts as number,
    nextAttemptAt: row.next_attempt_at as string,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Durable local state; connector secrets and installation private keys intentionally have no SQLite representation. */
