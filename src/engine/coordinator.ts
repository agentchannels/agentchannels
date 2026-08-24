import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  Agent,
  ConnectorCommand,
  DeliveryKind,
  InteractionKind,
  RuntimeType,
  Session,
} from "../model.ts";
import type { Persistence } from "../store/store.ts";
import type {
  InteractionResult,
  Runtime,
  RuntimeInteractionRequest,
  RuntimeTurn,
} from "../runtimes/contract.ts";
import { redactSensitiveText } from "../security/redact.ts";
import { WorktreeManager } from "./worktrees.ts";
import { internalError, invalidState } from "../errors.ts";

export type SessionCoordinatorOptions = {
  store: Persistence;
  /** Resolved per Agent: the runtime is a property of the Agent, not the daemon. */
  runtimes: (type: RuntimeType) => Runtime;
  worktreeRoot: string;
  concurrency?: number;
};

type PendingInteraction = {
  sessionId: string;
  resolve(value: InteractionResult): void;
  reject(error: Error): void;
};

type ScheduledTurn = { sessionId: string; prompt: string; followUpId?: string };

const sessionId = () => `ss_${randomUUID().replaceAll("-", "")}`;

/**
 * The `data` a runtime attached to an interaction request, read back.
 *
 * This is the coordinator reading its own envelope, not the runtime's protocol:
 * the contents stay opaque and are passed through exactly as they arrived.
 */
function persistedRequestData(
  request: unknown,
): Readonly<Record<string, unknown>> {
  const record =
    typeof request === "object" && request !== null
      ? (request as Record<string, unknown>)
      : {};
  const data = record.data;
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

export class SessionCoordinator {
  private readonly concurrency: number;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly activeTurns = new Map<string, RuntimeTurn>();
  private readonly queue: ScheduledTurn[] = [];
  private running = 0;

  private readonly options: SessionCoordinatorOptions;

  public constructor(options: SessionCoordinatorOptions) {
    this.options = options;
    this.concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw invalidState("Session concurrency must be a positive integer.", [
        "Pass --concurrency with a value of 1 or more.",
      ]);
    }
  }

  public recoverAfterCrash(): { sessions: number; deliveries: number } {
    return {
      sessions: this.options.store.recoverInterrupted(),
      deliveries: this.options.store.recoverSendingDeliveries(),
    };
  }

  public async accept(
    bindingId: string,
    command: ConnectorCommand,
  ): Promise<"accepted" | "duplicate" | "denied"> {
    if (!this.options.store.recordIngress(bindingId, command.deliveryId))
      return "duplicate";
    const binding = this.options.store.getBinding(bindingId);
    if (binding === undefined) return "denied";
    const isOperator = this.options.store.isOperator(
      bindingId,
      command.remoteUserId,
    );
    const hasAccess =
      isOperator ||
      this.options.store.isAuthorized(bindingId, command.remoteUserId);
    if (!hasAccess) return "denied";

    if (command.type === "message") {
      const existing = this.options.store.getSessionByRemoteConversation(
        bindingId,
        command.remoteConversationId,
      );
      if (existing === undefined) {
        if (command.allowNewSession === false) return "denied";
        try {
          await this.createAndSchedule(
            bindingId,
            command.remoteConversationId,
            command.text,
          );
        } catch (error) {
          this.options.store.enqueueDelivery({
            connector: binding.connector,
            remoteConversationId: command.remoteConversationId,
            kind: "error",
            body: `Could not start this task. ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
            metadata: { bindingId },
          });
          throw error;
        }
      } else if (existing.status === "waiting") {
        const interaction = this.options.store.getPendingInteractionForSession(
          existing.id,
        );
        if (
          interaction === undefined ||
          (interaction.kind === "permission" && !isOperator)
        )
          return "denied";
        this.resolveInteraction(interaction.id, existing.id, command.text);
      } else if (
        existing.status === "running" ||
        existing.status === "queued"
      ) {
        this.options.store.enqueueFollowUp({
          sessionId: existing.id,
          remoteUserId: command.remoteUserId,
          text: command.text,
        });
      } else if (existing.status === "failed") {
        this.rejectFailedRetainedSession(
          bindingId,
          command.remoteConversationId,
        );
      } else {
        this.options.store.transitionSession(existing.id, "queued");
        this.schedule({ sessionId: existing.id, prompt: command.text });
      }
      return "accepted";
    }

    const session = this.options.store.getSessionByRemoteConversation(
      bindingId,
      command.remoteConversationId,
    );
    if (session === undefined) return "denied";
    if (command.type === "stop") {
      await this.stop(session);
      return "accepted";
    }

    const interaction = this.options.store.getInteraction(
      command.interactionId,
    );
    if (
      interaction === undefined ||
      interaction.sessionId !== session.id ||
      interaction.status !== "pending"
    ) {
      return "denied";
    }
    if (interaction.kind === "permission" && !isOperator) return "denied";
    this.resolveInteraction(interaction.id, session.id, command.response);
    return "accepted";
  }

  public async waitForIdle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async createAndSchedule(
    bindingId: string,
    remoteConversationId: string,
    prompt: string,
  ): Promise<void> {
    const binding = this.options.store.getBinding(bindingId);
    if (binding === undefined)
      throw internalError(
        `Binding ${bindingId} disappeared while starting a Session.`,
      );
    const agent = this.options.store.getAgent(binding.agentId);
    if (agent === undefined)
      throw internalError(
        `Agent ${binding.agentId} is missing for an active Binding.`,
      );
    // Acknowledge before the worktree exists. Providers expect a first activity
    // within seconds, while checking out a large repository and starting the
    // runtime can take considerably longer than that.
    this.options.store.enqueueDelivery({
      connector: binding.connector,
      remoteConversationId,
      kind: "progress",
      body: `Starting work in ${agent.name}.`,
      metadata: { bindingId },
    });
    const id = sessionId();
    const manager = new WorktreeManager({
      repositoryPath: agent.cwd,
      worktreeRoot: join(this.options.worktreeRoot, agent.id),
    });
    const worktree = await manager.create(id);
    this.options.store.createSession({
      id,
      bindingId,
      remoteConversationId,
      cwd: worktree.cwd,
      worktreePath: worktree.path,
      baseCommit: worktree.baseCommit,
    });
    this.schedule({ sessionId: id, prompt });
  }

  private rejectFailedRetainedSession(
    bindingId: string,
    remoteConversationId: string,
  ): never {
    // A failed retained Session cannot safely reuse an unrecoverable runtime. Its remote mapping
    // must first age out; callers get an explicit failure instead of an implicit destructive reset.
    throw invalidState(
      `The retained Session for ${bindingId}/${remoteConversationId} failed and cannot be resumed.`,
      ["Retire the Session before starting a replacement."],
    );
  }

  private schedule(turn: ScheduledTurn): void {
    this.queue.push(turn);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.running += 1;
      void this.execute(next)
        .then((followUp) => {
          if (followUp !== undefined) this.queue.push(followUp);
        })
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }

  private async execute(
    scheduled: ScheduledTurn,
  ): Promise<ScheduledTurn | undefined> {
    const session = this.options.store.getSession(scheduled.sessionId);
    if (session === undefined || session.status === "stopped") return undefined;
    const binding = this.options.store.getBinding(session.bindingId);
    if (binding === undefined)
      throw internalError(
        `Binding ${session.bindingId} is missing for an active Session.`,
      );
    const agent = this.options.store.getAgent(binding.agentId);
    if (agent === undefined)
      throw internalError(
        `Agent ${binding.agentId} is missing for an active Binding.`,
      );
    this.options.store.transitionSession(session.id, "running");

    const common = {
      cwd: session.cwd,
      additionalDirectories: agent.additionalDirectories,
      prompt: scheduled.prompt,
      runtimeState: this.options.store.getAgentRuntimeState(
        agent.id,
        agent.runtime,
      ),
      requestInteraction: (request: RuntimeInteractionRequest) =>
        this.requestInteraction(session, request),
    };
    const runtime = this.options.runtimes(agent.runtime);
    const turn =
      session.runtimeSessionId === null
        ? runtime.start(common)
        : runtime.resume({
            ...common,
            runtimeSessionId: session.runtimeSessionId,
          });
    this.activeTurns.set(session.id, turn);
    let runtimeError: string | null = null;
    try {
      for await (const event of turn.events) {
        if (event.type === "session_started")
          this.options.store.setRuntimeSessionId(
            session.id,
            event.runtimeSessionId,
          );
        if (event.type === "progress")
          this.enqueue(session, "progress", event.body);
        if (event.type === "tool_started")
          this.enqueue(session, "action", event.parameter || event.action, {
            action: event.action,
            ephemeral: true,
          });
        if (event.type === "tool_finished")
          this.enqueue(session, "action", event.parameter || event.action, {
            action: event.action,
            result: event.result,
          });
        if (event.type === "final") this.enqueue(session, "final", event.body);
        if (event.type === "error") runtimeError = event.message;
      }
      const current = this.options.store.getSession(session.id);
      if (current?.status === "stopped") return undefined;
      if (runtimeError !== null) {
        this.options.store.transitionSession(session.id, "failed");
        this.enqueue(session, "error", runtimeError);
        return undefined;
      }
      if (scheduled.followUpId !== undefined)
        this.options.store.markFollowUpDelivered(scheduled.followUpId);
      const followUp = this.options.store.listQueuedFollowUps(session.id)[0];
      if (followUp !== undefined) {
        return {
          sessionId: session.id,
          prompt: followUp.text,
          followUpId: followUp.id,
        };
      } else {
        this.options.store.transitionSession(session.id, "completed");
      }
      return undefined;
    } catch {
      const current = this.options.store.getSession(session.id);
      if (current !== undefined && current.status !== "stopped") {
        this.options.store.transitionSession(session.id, "interrupted");
        this.enqueue(
          session,
          "error",
          `${agent.name} stopped unexpectedly. The worktree was preserved. Send “continue” to resume.`,
        );
      }
      return undefined;
    } finally {
      this.activeTurns.delete(session.id);
      turn.dispose();
    }
  }

  private requestInteraction(
    session: Session,
    request: RuntimeInteractionRequest,
  ): Promise<InteractionResult> {
    const { signal, ...persistedRequest } = request;
    const interaction = this.options.store.createInteraction({
      sessionId: session.id,
      kind: request.kind,
      request: persistedRequest,
    });
    this.options.store.transitionSession(session.id, "waiting");
    this.enqueue(
      session,
      request.kind,
      request.body,
      this.interactionMetadata(interaction.id, request.kind, request.data),
    );
    const promise = new Promise<InteractionResult>((resolve, reject) => {
      this.pendingInteractions.set(interaction.id, {
        sessionId: session.id,
        resolve,
        reject,
      });
      const abort = (): void => {
        if (!this.pendingInteractions.has(interaction.id)) return;
        this.pendingInteractions.delete(interaction.id);
        const current = this.options.store.getInteraction(interaction.id);
        if (current?.status === "pending")
          this.options.store.resolveInteraction(interaction.id, "cancelled");
        reject(new Error("Runtime cancelled the pending interaction"));
      };
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    return promise.finally(() => {
      const current = this.options.store.getSession(session.id);
      if (current?.status === "waiting")
        this.options.store.transitionSession(session.id, "running");
    });
  }

  private interactionMetadata(
    interactionId: string,
    kind: InteractionKind,
    data: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      interactionId,
      ...(kind === "permission" ? { operatorOnly: true } : {}),
      ...data,
    };
  }

  /**
   * Hand a channel reply to the runtime and record whatever it decided.
   *
   * The coordinator does not interpret the reply: what counts as an approval,
   * when a multi-part question is complete, and whether a reply said anything
   * readable at all are properties of the runtime's tool protocol and are
   * decided there. A reply the runtime could not read leaves the interaction
   * pending and goes back to the channel as a fresh request, because a channel
   * activity cannot be edited once posted.
   */
  private resolveInteraction(
    interactionId: string,
    sessionId: string,
    response: unknown,
  ): void {
    const interaction = this.options.store.getInteraction(interactionId);
    if (interaction === undefined) return;
    const executor = this.executorForSession(sessionId);
    if (executor === undefined) return;
    const outcome = executor.runtime.interpretResponse(
      {
        kind: interaction.kind,
        request: interaction.request,
        progress: interaction.response,
        runtimeState: this.options.store.getAgentRuntimeState(
          executor.agent.id,
          executor.agent.runtime,
        ),
      },
      response,
    );
    if (outcome.state === "partial") {
      this.options.store.updatePendingInteractionResponse(
        interactionId,
        outcome.progress,
      );
      return;
    }
    if (outcome.state === "unresolved") {
      const session = this.options.store.getSession(sessionId);
      if (session === undefined) return;
      this.enqueue(
        session,
        interaction.kind,
        outcome.body,
        this.interactionMetadata(
          interaction.id,
          interaction.kind,
          persistedRequestData(interaction.request),
        ),
      );
      return;
    }
    if (outcome.runtimeState !== undefined) {
      this.options.store.setAgentRuntimeState(
        executor.agent.id,
        executor.agent.runtime,
        outcome.runtimeState,
      );
    }
    this.options.store.resolveInteraction(
      interactionId,
      outcome.status,
      outcome.response,
    );
    const pending = this.pendingInteractions.get(interactionId);
    if (pending !== undefined && pending.sessionId === sessionId) {
      this.pendingInteractions.delete(interactionId);
      pending.resolve(outcome);
    }
  }

  /** The Agent that owns a Session and the runtime it runs on. */
  private executorForSession(
    sessionId: string,
  ): { agent: Agent; runtime: Runtime } | undefined {
    const session = this.options.store.getSession(sessionId);
    if (session === undefined) return undefined;
    const binding = this.options.store.getBinding(session.bindingId);
    if (binding === undefined) return undefined;
    const agent = this.options.store.getAgent(binding.agentId);
    if (agent === undefined) return undefined;
    return { agent, runtime: this.options.runtimes(agent.runtime) };
  }

  private async stop(session: Session): Promise<void> {
    const turn = this.activeTurns.get(session.id);
    if (turn !== undefined) await turn.interrupt();
    const current = this.options.store.getSession(session.id);
    if (current !== undefined && current.status !== "stopped") {
      this.options.store.transitionSession(session.id, "stopped");
      this.enqueue(session, "stopped", "Stopped by a Session participant.");
    }
    for (const [id, pending] of this.pendingInteractions) {
      if (pending.sessionId !== session.id) continue;
      this.options.store.resolveInteraction(id, "cancelled");
      pending.reject(new Error("Session stopped"));
      this.pendingInteractions.delete(id);
    }
  }

  private enqueue(
    session: Session,
    kind: DeliveryKind,
    body: string,
    metadata?: Record<string, unknown>,
  ): void {
    const binding = this.options.store.getBinding(session.bindingId);
    if (binding === undefined)
      throw internalError(
        `Binding ${session.bindingId} is missing for an active Session.`,
      );
    this.options.store.enqueueDelivery({
      sessionId: session.id,
      connector: binding.connector,
      remoteConversationId: session.remoteConversationId,
      kind,
      body,
      metadata: { bindingId: binding.id, ...(metadata ?? {}) },
    });
  }
}
