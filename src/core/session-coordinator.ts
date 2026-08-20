import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ConnectorCommand, DeliveryKind, Session } from "./types.js";
import type { Persistence } from "../persistence/store.js";
import type {
  Runtime,
  RuntimeInteractionRequest,
  RuntimeTurn,
} from "../runtime/runtime.js";
import { redactSensitiveText } from "../security/redaction.js";
import { WorktreeManager } from "./worktrees.js";

export type SessionCoordinatorOptions = {
  store: Persistence;
  runtime: Runtime;
  worktreeRoot: string;
  concurrency?: number;
};

type PendingInteraction = {
  sessionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type ScheduledTurn = { sessionId: string; prompt: string; followUpId?: string };

const sessionId = () => `ss_${randomUUID().replaceAll("-", "")}`;

export class SessionCoordinator {
  private readonly concurrency: number;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly activeTurns = new Map<string, RuntimeTurn>();
  private readonly queue: ScheduledTurn[] = [];
  private running = 0;

  public constructor(private readonly options: SessionCoordinatorOptions) {
    this.concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Session concurrency must be a positive integer");
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
      throw new Error(`Binding ${bindingId} not found`);
    const agent = this.options.store.getAgent(binding.agentId);
    if (agent === undefined)
      throw new Error(`Agent ${binding.agentId} not found`);
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
    throw new Error(
      `The retained Session for ${bindingId}/${remoteConversationId} failed and cannot be resumed; retire it before starting a replacement`,
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
      throw new Error(`Binding ${session.bindingId} not found`);
    const agent = this.options.store.getAgent(binding.agentId);
    if (agent === undefined)
      throw new Error(`Agent ${binding.agentId} not found`);
    this.options.store.transitionSession(session.id, "running");

    const common = {
      cwd: session.cwd,
      additionalDirectories: agent.additionalDirectories,
      prompt: scheduled.prompt,
      requestInteraction: (request: RuntimeInteractionRequest) =>
        this.requestInteraction(session, request),
    };
    const turn =
      session.runtimeSessionId === null
        ? this.options.runtime.start(common)
        : this.options.runtime.resume({
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
  ): Promise<unknown> {
    const { signal, ...persistedRequest } = request;
    const interaction = this.options.store.createInteraction({
      sessionId: session.id,
      kind: request.kind,
      request: persistedRequest,
    });
    this.options.store.transitionSession(session.id, "waiting");
    this.enqueue(session, request.kind, request.body, {
      interactionId: interaction.id,
      ...(request.kind === "permission" ? { operatorOnly: true } : {}),
      ...request.data,
    });
    const promise = new Promise((resolve, reject) => {
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

  private resolveInteraction(
    interactionId: string,
    sessionId: string,
    response: unknown,
  ): void {
    const interaction = this.options.store.getInteraction(interactionId);
    if (interaction?.kind === "question") {
      const completed = this.accumulateQuestionAnswer(
        interactionId,
        interaction.request,
        interaction.response,
        response,
      );
      if (completed === undefined) return;
      response = completed;
    }
    const denied =
      response === false ||
      (typeof response === "string" &&
        /^(deny|denied|no)$/i.test(response.trim()));
    this.options.store.resolveInteraction(
      interactionId,
      denied ? "denied" : "answered",
      response,
    );
    const pending = this.pendingInteractions.get(interactionId);
    if (pending !== undefined && pending.sessionId === sessionId) {
      this.pendingInteractions.delete(interactionId);
      pending.resolve(response);
    }
  }

  private accumulateQuestionAnswer(
    interactionId: string,
    request: unknown,
    previousResponse: unknown,
    incoming: unknown,
  ): { answers: Record<string, unknown> } | undefined {
    const requestRecord =
      typeof request === "object" && request !== null
        ? (request as Record<string, unknown>)
        : {};
    const data =
      typeof requestRecord.data === "object" && requestRecord.data !== null
        ? (requestRecord.data as Record<string, unknown>)
        : {};
    const questions = (Array.isArray(data.questions) ? data.questions : [])
      .map((question) =>
        typeof question === "object" && question !== null
          ? (question as Record<string, unknown>)
          : {},
      )
      .filter((question) => typeof question.question === "string");
    if (questions.length === 0) return { answers: { response: incoming } };

    const previousRecord =
      typeof previousResponse === "object" && previousResponse !== null
        ? (previousResponse as Record<string, unknown>)
        : {};
    const savedAnswers =
      typeof previousRecord.answers === "object" &&
      previousRecord.answers !== null
        ? (previousRecord.answers as Record<string, unknown>)
        : {};
    const answers: Record<string, unknown> = { ...savedAnswers };
    const incomingRecord =
      typeof incoming === "object" && incoming !== null
        ? (incoming as Record<string, unknown>)
        : {};
    if (
      typeof incomingRecord.answers === "object" &&
      incomingRecord.answers !== null
    ) {
      Object.assign(answers, incomingRecord.answers);
    } else {
      const explicitIndex =
        typeof incomingRecord.questionIndex === "number"
          ? incomingRecord.questionIndex
          : undefined;
      const nextIndex =
        explicitIndex ??
        questions.findIndex(
          (question) => !Object.hasOwn(answers, question.question as string),
        );
      const question = questions[nextIndex];
      if (question !== undefined) {
        let answer = Object.hasOwn(incomingRecord, "answer")
          ? incomingRecord.answer
          : incoming;
        if (question.multiSelect === true && typeof answer === "string") {
          answer = answer
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        }
        answers[question.question as string] = answer;
      }
    }

    const result = { answers };
    const complete = questions.every((question) =>
      Object.hasOwn(answers, question.question as string),
    );
    if (complete) return result;
    this.options.store.updatePendingInteractionResponse(interactionId, result);
    return undefined;
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
      throw new Error(`Binding ${session.bindingId} not found`);
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
