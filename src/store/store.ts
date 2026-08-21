import Database from "better-sqlite3";
import { relative, resolve } from "node:path";

import { internalError, invalidState } from "../errors.ts";
import { canTransition } from "../model.ts";
import type {
  Agent,
  Binding,
  ConnectorType,
  Interaction,
  InteractionKind,
  InteractionStatus,
  Session,
  SessionStatus,
} from "../model.ts";

/** The model states which transitions are legal; the store is what enforces them. */
function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to))
    throw internalError(`Invalid Session transition: ${from} -> ${to}`);
}
import { migrate } from "./migrations.ts";
import {
  assertSafeMetadata,
  id,
  iso,
  json,
  mapAgent,
  mapBinding,
  mapBindingSetup,
  mapDelivery,
  mapFollowUp,
  mapInteraction,
  mapSession,
  required,
  type AccessGrant,
  type BindingSetup,
  type BindingSetupStep,
  type CreateAgentInput,
  type CreateBindingInput,
  type CreateSessionInput,
  type Delivery,
  type FollowUp,
  type Installation,
  type PersistenceOptions,
} from "./rows.ts";

export type {
  AccessGrant,
  BindingSetup,
  BindingSetupStep,
  CreateAgentInput,
  CreateBindingInput,
  CreateSessionInput,
  Delivery,
  DeliveryStatus,
  FollowUp,
  Installation,
  PersistenceOptions,
} from "./rows.ts";

export class Persistence {
  readonly db: Database.Database;
  private readonly retentionMs: number;

  constructor(filename = ":memory:", options: PersistenceOptions = {}) {
    this.db = new Database(filename);
    this.retentionMs = options.sessionRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    migrate(this.db, {
      filename,
      ...(options.backupDirectory === undefined
        ? {}
        : { backupDirectory: options.backupDirectory }),
      ...(options.componentVersion === undefined
        ? {}
        : { componentVersion: options.componentVersion }),
      ...(options.migrationNow === undefined
        ? {}
        : { now: options.migrationNow }),
      ...(options.backupDatabase === undefined
        ? {}
        : { backupDatabase: options.backupDatabase }),
    });
    this.db.pragma("journal_mode = WAL");
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  createAgent(input: CreateAgentInput): Agent {
    const createdAt = iso(input.createdAt);
    const agent: Agent = {
      id: input.id ?? id("ag"),
      name: input.name,
      cwd: input.cwd,
      additionalDirectories: [...(input.additionalDirectories ?? [])],
      runtime: input.runtime ?? "claude-code",
      createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO agents(id,name,cwd,additional_directories_json,runtime,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.cwd,
        json(agent.additionalDirectories),
        agent.runtime,
        createdAt,
      );
    return agent;
  }
  getAgent(agentId: string): Agent | undefined {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? mapAgent(row) : undefined;
  }
  listAgents(): Agent[] {
    return (
      this.db.prepare("SELECT * FROM agents ORDER BY id").all() as Record<
        string,
        unknown
      >[]
    ).map(mapAgent);
  }
  deleteAgent(agentId: string): boolean {
    const bindingCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM bindings WHERE agent_id=?")
      .get(agentId) as { count: number };
    if (bindingCount.count > 0)
      throw invalidState(`Agent ${agentId} still has Bindings.`, [
        "Run agentchannels binding remove for each Binding first.",
      ]);
    return (
      this.db.prepare("DELETE FROM agents WHERE id=?").run(agentId).changes ===
      1
    );
  }
  findAgentsByCwd(cwd: string): Agent[] {
    const target = resolve(cwd);
    return this.listAgents().filter((agent) => {
      const relativePath = relative(resolve(agent.cwd), target);
      return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && relativePath !== "..")
      );
    });
  }
  findAgentByExactCwd(cwd: string): Agent | undefined {
    const target = resolve(cwd);
    return this.listAgents().find((agent) => resolve(agent.cwd) === target);
  }

  createInstallation(input: {
    id?: string;
    publicKey: string;
    relayOrigin?: string | null;
    enrolledAt?: string | null;
    lastConnectedAt?: string | null;
    createdAt?: string;
  }): Installation {
    const installation: Installation = {
      id: input.id ?? id("in"),
      publicKey: input.publicKey,
      relayOrigin: input.relayOrigin ?? null,
      createdAt: iso(input.createdAt),
      enrolledAt: input.enrolledAt ?? null,
      lastConnectedAt: input.lastConnectedAt ?? null,
    };
    this.db
      .prepare(
        "INSERT INTO installations(id,public_key,relay_origin,created_at,enrolled_at,last_connected_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        installation.id,
        installation.publicKey,
        installation.relayOrigin,
        installation.createdAt,
        installation.enrolledAt,
        installation.lastConnectedAt,
      );
    return installation;
  }
  getInstallation(installationId: string): Installation | undefined {
    const row = this.db
      .prepare("SELECT * FROM installations WHERE id = ?")
      .get(installationId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      publicKey: row.public_key as string,
      relayOrigin: (row.relay_origin as string | null) ?? null,
      createdAt: row.created_at as string,
      enrolledAt: (row.enrolled_at as string | null) ?? null,
      lastConnectedAt: (row.last_connected_at as string | null) ?? null,
    };
  }
  setInstallationRelay(
    installationId: string,
    relayOrigin: string,
    enrolledAt = new Date(),
  ): Installation {
    const result = this.db
      .prepare(
        "UPDATE installations SET relay_origin=?,enrolled_at=? WHERE id=?",
      )
      .run(relayOrigin, iso(enrolledAt), installationId);
    if (result.changes !== 1)
      throw internalError(`Installation ${installationId} not found.`);
    return required(
      this.getInstallation(installationId),
      `Installation ${installationId} disappeared after Relay update`,
    );
  }
  getInstallationState(): Installation | undefined {
    const row = this.db
      .prepare("SELECT * FROM installations ORDER BY created_at,id LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return this.getInstallation(row.id as string);
  }
  touchInstallation(installationId: string, at = new Date()): void {
    this.db
      .prepare("UPDATE installations SET last_connected_at = ? WHERE id = ?")
      .run(iso(at), installationId);
  }

  createBinding(input: CreateBindingInput): Binding {
    const binding: Binding = {
      id: input.id ?? id("bd"),
      agentId: input.agentId,
      connector: input.connector,
      operatorUserId: input.operatorUserId,
      externalInstallationId: input.externalInstallationId,
      createdAt: iso(input.createdAt),
    };
    this.db
      .prepare(
        `INSERT INTO bindings(id,agent_id,connector,operator_user_id,external_installation_id,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        binding.id,
        binding.agentId,
        binding.connector,
        binding.operatorUserId,
        binding.externalInstallationId,
        binding.createdAt,
      );
    return binding;
  }
  createBindingSetup(input: {
    id?: string;
    agentId: string;
    connector: ConnectorType;
    createdAt?: string;
  }): BindingSetup {
    const createdAt = iso(input.createdAt);
    const setup: BindingSetup = {
      id: input.id ?? id("bd"),
      agentId: input.agentId,
      connector: input.connector,
      step: "selected",
      artifactPath: null,
      externalInstallationId: null,
      externalInstallationName: null,
      createdAt,
      updatedAt: createdAt,
      lastError: null,
    };
    this.db
      .prepare(
        "INSERT INTO binding_setups(id,agent_id,connector,step,artifact_path,external_installation_id,external_installation_name,created_at,updated_at,last_error) VALUES (?,?,?,'selected',NULL,NULL,NULL,?,?,NULL)",
      )
      .run(
        setup.id,
        setup.agentId,
        setup.connector,
        setup.createdAt,
        setup.updatedAt,
      );
    return setup;
  }
  getBindingSetup(setupId: string): BindingSetup | undefined {
    const row = this.db
      .prepare("SELECT * FROM binding_setups WHERE id=?")
      .get(setupId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return mapBindingSetup(row);
  }
  listBindingSetups(agentId: string): BindingSetup[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM binding_setups WHERE agent_id=? ORDER BY created_at,id",
        )
        .all(agentId) as Record<string, unknown>[]
    ).map(mapBindingSetup);
  }
  listAllBindingSetups(): BindingSetup[] {
    return (
      this.db
        .prepare("SELECT * FROM binding_setups ORDER BY created_at,id")
        .all() as Record<string, unknown>[]
    ).map(mapBindingSetup);
  }
  updateBindingSetup(
    setupId: string,
    input: {
      step?: BindingSetupStep;
      artifactPath?: string | null;
      externalInstallationId?: string | null;
      externalInstallationName?: string | null;
      lastError?: string | null;
      updatedAt?: Date | string;
    },
  ): BindingSetup {
    const current = required(
      this.getBindingSetup(setupId),
      `Binding setup ${setupId} not found`,
    );
    const next = {
      step: input.step ?? current.step,
      artifactPath:
        input.artifactPath === undefined
          ? current.artifactPath
          : input.artifactPath,
      externalInstallationId:
        input.externalInstallationId === undefined
          ? current.externalInstallationId
          : input.externalInstallationId,
      externalInstallationName:
        input.externalInstallationName === undefined
          ? current.externalInstallationName
          : input.externalInstallationName,
      lastError:
        input.lastError === undefined ? current.lastError : input.lastError,
      updatedAt: iso(input.updatedAt),
    };
    this.db
      .prepare(
        "UPDATE binding_setups SET step=?,artifact_path=?,external_installation_id=?,external_installation_name=?,updated_at=?,last_error=? WHERE id=?",
      )
      .run(
        next.step,
        next.artifactPath,
        next.externalInstallationId,
        next.externalInstallationName,
        next.updatedAt,
        next.lastError,
        setupId,
      );
    return required(
      this.getBindingSetup(setupId),
      `Binding setup ${setupId} disappeared after update`,
    );
  }
  completeBindingSetup(
    setupId: string,
    input: {
      operatorUserId: string;
      externalInstallationId: string;
      createdAt?: string;
    },
  ): Binding {
    return this.transaction(() => {
      const setup = this.getBindingSetup(setupId);
      if (setup === undefined)
        throw internalError(`Binding setup ${setupId} not found`);
      const binding = this.createBinding({
        id: setup.id,
        agentId: setup.agentId,
        connector: setup.connector,
        operatorUserId: input.operatorUserId,
        externalInstallationId: input.externalInstallationId,
        ...(input.createdAt === undefined
          ? {}
          : { createdAt: input.createdAt }),
      });
      this.db.prepare("DELETE FROM binding_setups WHERE id=?").run(setupId);
      return binding;
    });
  }
  getBinding(bindingId: string): Binding | undefined {
    const row = this.db
      .prepare("SELECT * FROM bindings WHERE id = ?")
      .get(bindingId) as Record<string, unknown> | undefined;
    return row ? mapBinding(row) : undefined;
  }
  listBindings(agentId: string): Binding[] {
    return (
      this.db
        .prepare("SELECT * FROM bindings WHERE agent_id = ? ORDER BY id")
        .all(agentId) as Record<string, unknown>[]
    ).map(mapBinding);
  }
  listAllBindings(): Binding[] {
    return (
      this.db.prepare("SELECT * FROM bindings ORDER BY id").all() as Record<
        string,
        unknown
      >[]
    ).map(mapBinding);
  }
  deleteBinding(bindingId: string): boolean {
    const sessionCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE binding_id=?")
      .get(bindingId) as { count: number };
    if (sessionCount.count > 0)
      throw internalError(
        `Binding ${bindingId} still has Sessions; retire them first`,
      );
    const deliveryCount = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM deliveries WHERE status NOT IN ('delivered','failed') AND json_extract(metadata_json,'$.bindingId')=?",
      )
      .get(bindingId) as { count: number };
    if (deliveryCount.count > 0)
      throw internalError(`Binding ${bindingId} still has pending deliveries`);
    return (
      this.db.prepare("DELETE FROM bindings WHERE id=?").run(bindingId)
        .changes === 1
    );
  }
  grantAccess(
    bindingId: string,
    userId: string,
    grantedAt = new Date(),
  ): AccessGrant {
    const grant = { bindingId, userId, grantedAt: iso(grantedAt) };
    this.db
      .prepare(
        "INSERT INTO access_grants(binding_id,user_id,granted_at) VALUES (?,?,?) ON CONFLICT(binding_id,user_id) DO UPDATE SET granted_at=excluded.granted_at",
      )
      .run(grant.bindingId, grant.userId, grant.grantedAt);
    return grant;
  }
  revokeAccess(bindingId: string, userId: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM access_grants WHERE binding_id = ? AND user_id = ?",
        )
        .run(bindingId, userId).changes > 0
    );
  }
  listAccess(bindingId: string): AccessGrant[] {
    return (
      this.db
        .prepare(
          "SELECT binding_id,user_id,granted_at FROM access_grants WHERE binding_id = ? ORDER BY user_id",
        )
        .all(bindingId) as Record<string, unknown>[]
    ).map((row) => ({
      bindingId: row.binding_id as string,
      userId: row.user_id as string,
      grantedAt: row.granted_at as string,
    }));
  }
  isAuthorized(bindingId: string, userId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM bindings b LEFT JOIN access_grants g ON g.binding_id=b.id AND g.user_id=? WHERE b.id=? AND (b.operator_user_id=? OR g.user_id IS NOT NULL)",
      )
      .get(userId, bindingId, userId);
    return row !== undefined;
  }
  isOperator(bindingId: string, userId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM bindings WHERE id=? AND operator_user_id=?")
        .get(bindingId, userId) !== undefined
    );
  }

  createSession(input: CreateSessionInput): Session {
    const now = iso(input.createdAt);
    const session: Session = {
      id: input.id ?? id("ss"),
      bindingId: input.bindingId,
      remoteConversationId: input.remoteConversationId,
      runtimeSessionId: input.runtimeSessionId ?? null,
      cwd: input.cwd,
      worktreePath: input.worktreePath,
      baseCommit: input.baseCommit,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions(id,binding_id,remote_conversation_id,runtime_session_id,cwd,worktree_path,base_commit,status,created_at,updated_at,completed_at,retention_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        session.id,
        session.bindingId,
        session.remoteConversationId,
        session.runtimeSessionId,
        session.cwd,
        session.worktreePath,
        session.baseCommit,
        session.status,
        now,
        now,
      );
    return session;
  }
  getSession(
    sessionId: string,
  ): (Session & { retentionExpiresAt: string | null }) | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }
  getSessionByRemoteConversation(
    bindingId: string,
    remoteConversationId: string,
    at = new Date(),
  ): (Session & { retentionExpiresAt: string | null }) | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE binding_id=? AND remote_conversation_id=? AND (retention_expires_at IS NULL OR retention_expires_at > ?)",
      )
      .get(bindingId, remoteConversationId, iso(at)) as
      | Record<string, unknown>
      | undefined;
    return row ? mapSession(row) : undefined;
  }
  listSessions(
    status?: SessionStatus,
  ): (Session & { retentionExpiresAt: string | null })[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM sessions WHERE status=? ORDER BY created_at",
            )
            .all(status)
        : this.db.prepare("SELECT * FROM sessions ORDER BY created_at").all()
    ) as Record<string, unknown>[];
    return rows.map(mapSession);
  }
  listExpiredSessions(
    at = new Date(),
  ): (Session & { retentionExpiresAt: string | null })[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE retention_expires_at IS NOT NULL AND retention_expires_at<=? AND status NOT IN ('queued','running','waiting') ORDER BY retention_expires_at",
        )
        .all(iso(at)) as Record<string, unknown>[]
    ).map(mapSession);
  }
  setRuntimeSessionId(
    sessionId: string,
    runtimeSessionId: string,
    at = new Date(),
  ): void {
    this.db
      .prepare(
        "UPDATE sessions SET runtime_session_id=?,updated_at=? WHERE id=?",
      )
      .run(runtimeSessionId, iso(at), sessionId);
  }
  transitionSession(
    sessionId: string,
    next: SessionStatus,
    at = new Date(),
    retentionMs = this.retentionMs,
  ): Session & { retentionExpiresAt: string | null } {
    const current = this.getSession(sessionId);
    if (!current) throw internalError(`Session ${sessionId} not found`);
    if (current.status !== next) assertTransition(current.status, next);
    const when = iso(at);
    const completedAt = next === "completed" ? when : current.completedAt;
    const retention =
      next === "completed" || next === "failed" || next === "stopped"
        ? new Date(new Date(when).getTime() + retentionMs).toISOString()
        : current.retentionExpiresAt;
    this.db
      .prepare(
        "UPDATE sessions SET status=?,updated_at=?,completed_at=?,retention_expires_at=? WHERE id=?",
      )
      .run(next, when, completedAt, retention, sessionId);
    return required(
      this.getSession(sessionId),
      `Session ${sessionId} disappeared after transition`,
    );
  }
  recoverInterrupted(at = new Date()): number {
    return this.transaction(() => {
      const when = iso(at);
      this.db
        .prepare(
          "UPDATE interactions SET status='cancelled',resolved_at=? WHERE status='pending' AND session_id IN (SELECT id FROM sessions WHERE status IN ('running','waiting'))",
        )
        .run(when);
      return this.db
        .prepare(
          "UPDATE sessions SET status='interrupted',updated_at=? WHERE status IN ('running','waiting')",
        )
        .run(when).changes;
    });
  }
  retireSession(sessionId: string, at = new Date()): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;
    if (["queued", "running", "waiting"].includes(session.status)) {
      throw internalError(`Active Session ${sessionId} cannot be retired`);
    }
    if (
      session.retentionExpiresAt === null ||
      session.retentionExpiresAt > iso(at)
    ) {
      throw internalError(`Session ${sessionId} is still retained`);
    }
    return (
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId)
        .changes === 1
    );
  }
  retireSessionNow(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (session === undefined) return false;
    if (["queued", "running", "waiting"].includes(session.status)) {
      throw internalError(`Active Session ${sessionId} cannot be retired`);
    }
    return (
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId)
        .changes === 1
    );
  }

  createInteraction(input: {
    id?: string;
    sessionId: string;
    kind: InteractionKind;
    request: unknown;
    createdAt?: string;
  }): Interaction {
    const interaction: Interaction = {
      id: input.id ?? id("ix"),
      sessionId: input.sessionId,
      kind: input.kind,
      status: "pending",
      request: input.request,
      response: null,
      createdAt: iso(input.createdAt),
      resolvedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO interactions(id,session_id,kind,status,request_json,response_json,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,NULL)",
      )
      .run(
        interaction.id,
        interaction.sessionId,
        interaction.kind,
        interaction.status,
        json(interaction.request),
        null,
        interaction.createdAt,
      );
    return interaction;
  }
  getInteraction(interactionId: string): Interaction | undefined {
    const row = this.db
      .prepare("SELECT * FROM interactions WHERE id=?")
      .get(interactionId) as Record<string, unknown> | undefined;
    return row ? mapInteraction(row) : undefined;
  }
  getPendingInteractionForSession(sessionId: string): Interaction | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM interactions WHERE session_id=? AND status='pending' ORDER BY created_at,id LIMIT 1",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapInteraction(row) : undefined;
  }
  updatePendingInteractionResponse(
    interactionId: string,
    response: unknown,
  ): Interaction {
    const changed = this.db
      .prepare(
        "UPDATE interactions SET response_json=? WHERE id=? AND status='pending'",
      )
      .run(json(response), interactionId).changes;
    if (changed !== 1)
      throw internalError(`Pending Interaction ${interactionId} was not found`);
    return required(
      this.getInteraction(interactionId),
      `Interaction ${interactionId} disappeared after its partial response`,
    );
  }
  resolveInteraction(
    interactionId: string,
    status: Exclude<InteractionStatus, "pending">,
    response: unknown = null,
    at = new Date(),
  ): Interaction {
    const existing = this.getInteraction(interactionId);
    if (!existing)
      throw internalError(`Interaction ${interactionId} not found`);
    if (existing.status !== "pending")
      throw internalError(`Interaction ${interactionId} is already resolved`);
    this.db
      .prepare(
        "UPDATE interactions SET status=?,response_json=?,resolved_at=? WHERE id=?",
      )
      .run(status, json(response), iso(at), interactionId);
    return required(
      this.getInteraction(interactionId),
      `Interaction ${interactionId} disappeared after resolution`,
    );
  }

  enqueueFollowUp(input: {
    id?: string;
    sessionId: string;
    remoteUserId: string;
    text: string;
    createdAt?: string;
  }): FollowUp {
    return this.transaction(() => {
      const sequence = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM followups WHERE session_id=?",
          )
          .get(input.sessionId) as { next: number }
      ).next;
      const followup: FollowUp = {
        id: input.id ?? id("fu"),
        sessionId: input.sessionId,
        sequence,
        remoteUserId: input.remoteUserId,
        text: input.text,
        status: "queued",
        createdAt: iso(input.createdAt),
        deliveredAt: null,
      };
      this.db
        .prepare(
          "INSERT INTO followups(id,session_id,sequence,remote_user_id,text,status,created_at,delivered_at) VALUES (?,?,?,?,?,?,?,NULL)",
        )
        .run(
          followup.id,
          followup.sessionId,
          sequence,
          followup.remoteUserId,
          followup.text,
          followup.status,
          followup.createdAt,
        );
      return followup;
    });
  }
  listQueuedFollowUps(sessionId: string): FollowUp[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM followups WHERE session_id=? AND status='queued' ORDER BY sequence",
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map(mapFollowUp);
  }
  markFollowUpDelivered(followupId: string, at = new Date()): FollowUp {
    this.db
      .prepare(
        "UPDATE followups SET status='delivered',delivered_at=? WHERE id=? AND status='queued'",
      )
      .run(iso(at), followupId);
    const row = this.db
      .prepare("SELECT * FROM followups WHERE id=?")
      .get(followupId) as Record<string, unknown> | undefined;
    if (!row) throw internalError(`Follow-up ${followupId} not found`);
    return mapFollowUp(row);
  }

  enqueueDelivery(input: {
    id?: string;
    sessionId?: string | null;
    connector: ConnectorType;
    remoteConversationId: string;
    kind: Delivery["kind"];
    body: string;
    metadata?: Record<string, unknown> | null;
    nextAttemptAt?: Date | string;
    createdAt?: Date | string;
  }): Delivery {
    assertSafeMetadata(input.metadata);
    const createdAt = iso(input.createdAt);
    const delivery: Delivery = {
      id: input.id ?? id("dl"),
      sessionId: input.sessionId ?? null,
      connector: input.connector,
      remoteConversationId: input.remoteConversationId,
      kind: input.kind,
      body: input.body,
      metadata: input.metadata ?? null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: iso(input.nextAttemptAt),
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.db
      .prepare(
        "INSERT INTO deliveries(id,session_id,connector,remote_conversation_id,kind,body,metadata_json,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',0,?,NULL,?,?)",
      )
      .run(
        delivery.id,
        delivery.sessionId,
        delivery.connector,
        delivery.remoteConversationId,
        delivery.kind,
        delivery.body,
        delivery.metadata === null ? null : json(delivery.metadata),
        delivery.nextAttemptAt,
        createdAt,
        createdAt,
      );
    return delivery;
  }
  getDelivery(deliveryId: string): Delivery | undefined {
    const row = this.db
      .prepare("SELECT * FROM deliveries WHERE id=?")
      .get(deliveryId) as Record<string, unknown> | undefined;
    return row ? mapDelivery(row) : undefined;
  }
  claimDueDeliveries(limit: number, at = new Date()): Delivery[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM deliveries WHERE status IN ('pending','retrying') AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?",
        )
        .all(iso(at), limit) as Record<string, unknown>[];
      const claim = this.db.prepare(
        "UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('pending','retrying')",
      );
      const now = iso(at);
      for (const row of rows) claim.run(now, row.id as string);
      return rows.map((row) =>
        mapDelivery({
          ...row,
          status: "sending",
          attempts: (row.attempts as number) + 1,
          updated_at: now,
        }),
      );
    });
  }
  markDeliveryDelivered(deliveryId: string, at = new Date()): Delivery {
    this.db
      .prepare(
        "UPDATE deliveries SET status='delivered',updated_at=?,last_error=NULL WHERE id=? AND status IN ('sending','pending','retrying')",
      )
      .run(iso(at), deliveryId);
    return required(
      this.getDelivery(deliveryId),
      `Delivery ${deliveryId} not found`,
    );
  }
  markDeliveryRetry(
    deliveryId: string,
    error: string,
    nextAttemptAt: Date | string,
    at = new Date(),
  ): Delivery {
    this.db
      .prepare(
        "UPDATE deliveries SET status='retrying',last_error=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='sending'",
      )
      .run(error, iso(nextAttemptAt), iso(at), deliveryId);
    return required(
      this.getDelivery(deliveryId),
      `Delivery ${deliveryId} not found`,
    );
  }
  markDeliveryFailed(
    deliveryId: string,
    error: string,
    at = new Date(),
  ): Delivery {
    this.db
      .prepare(
        "UPDATE deliveries SET status='failed',last_error=?,updated_at=? WHERE id=? AND status IN ('sending','retrying','pending')",
      )
      .run(error, iso(at), deliveryId);
    return required(
      this.getDelivery(deliveryId),
      `Delivery ${deliveryId} not found`,
    );
  }
  recoverSendingDeliveries(at = new Date()): number {
    return this.db
      .prepare(
        "UPDATE deliveries SET status='retrying',next_attempt_at=?,updated_at=? WHERE status='sending'",
      )
      .run(iso(at), iso(at)).changes;
  }
  recordIngress(
    bindingId: string,
    eventId: string,
    receivedAt = new Date(),
  ): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO ingress_events(binding_id,event_id,received_at) VALUES (?,?,?)",
        )
        .run(bindingId, eventId, iso(receivedAt)).changes === 1
    );
  }
}

export { migrate } from "./migrations.ts";
