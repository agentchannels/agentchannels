import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionCoordinator } from "../src/core/session-coordinator.js";
import type { ConnectorCommand, InteractionKind } from "../src/core/types.js";
import type {
  Runtime,
  RuntimeEvent,
  RuntimeInteractionRequest,
  RuntimeResumeOptions,
  RuntimeStartOptions,
  RuntimeTurn,
} from "../src/runtime/runtime.js";
import { Persistence } from "../src/persistence/index.js";
import { WorktreeManager } from "../src/core/worktrees.js";

type RuntimeCall = {
  method: "start" | "resume";
  prompt: string;
  cwd: string;
  runtimeSessionId: string | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

/** Deterministic runtime double: it models only the SDK boundary and records every invocation. */
class DeterministicRuntime implements Runtime {
  readonly type = "claude-code" as const;
  readonly calls: RuntimeCall[] = [];
  private readonly holds = new Map<string, Deferred<true>>();
  private nextSession = 1;

  start(options: RuntimeStartOptions): RuntimeTurn {
    const runtimeSessionId = `runtime-${String(this.nextSession++)}`;
    this.calls.push({
      method: "start",
      prompt: options.prompt,
      cwd: options.cwd,
      runtimeSessionId: null,
    });
    return this.turn(options, runtimeSessionId);
  }

  resume(options: RuntimeResumeOptions): RuntimeTurn {
    this.calls.push({
      method: "resume",
      prompt: options.prompt,
      cwd: options.cwd,
      runtimeSessionId: options.runtimeSessionId,
    });
    return this.turn(options, options.runtimeSessionId);
  }

  release(prompt: string): void {
    this.holds.get(prompt)?.resolve(true);
  }

  private turn(
    options: RuntimeStartOptions,
    runtimeSessionId: string,
  ): RuntimeTurn {
    const events = this.events(options, runtimeSessionId);
    return {
      events,
      interrupt: async () => {
        await Promise.resolve();
        this.release(options.prompt);
      },
      dispose: () => undefined,
    };
  }

  private async *events(
    options: RuntimeStartOptions,
    runtimeSessionId: string,
  ): AsyncIterable<RuntimeEvent> {
    yield { type: "session_started", runtimeSessionId };
    if (options.prompt === "investigate signup regression") {
      yield { type: "progress", body: "Investigating the signup regression." };
      await options.requestInteraction(
        this.interaction("question", "Which signup flow should I prioritize?"),
      );
      await options.requestInteraction(
        this.interaction("permission", "Runbear wants to run git push."),
      );
      yield { type: "final", body: "The signup regression is fixed." };
      return;
    }
    if (options.prompt === "ask multiple questions") {
      await options.requestInteraction({
        kind: "question",
        title: "Two questions",
        body: "Choose a flow and environment.",
        data: {
          questions: [
            {
              question: "Flow?",
              options: [{ label: "Signup" }, { label: "Invite" }],
              multiSelect: false,
            },
            {
              question: "Environments?",
              options: [{ label: "Web" }, { label: "Mobile" }],
              multiSelect: true,
            },
          ],
        },
      });
      yield { type: "final", body: "All questions answered." };
      return;
    }
    if (options.prompt.startsWith("hold-")) {
      const gate = deferred<true>();
      this.holds.set(options.prompt, gate);
      await gate.promise;
    }
    yield { type: "final", body: `Completed: ${options.prompt}` };
  }

  private interaction(
    kind: InteractionKind,
    body: string,
  ): RuntimeInteractionRequest {
    return {
      kind,
      title: kind === "question" ? "Question" : "Permission",
      body,
      data: {},
    };
  }
}

type Fixture = {
  directory: string;
  repository: string;
  store: Persistence;
  coordinator: SessionCoordinator;
  runtime: DeterministicRuntime;
  bindingId: string;
  operatorUserId: string;
};

const fixtures: Fixture[] = [];

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" });
}

function createFixture(concurrency = 2): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agentchannels-product-"));
  const repositoryPath = join(directory, "repository");
  execFileSync("git", ["init", "--initial-branch", "main", repositoryPath], {
    encoding: "utf8",
  });
  const repository = realpathSync(repositoryPath);
  git(repository, ["config", "user.email", "tests@example.com"]);
  git(repository, ["config", "user.name", "AgentChannels Tests"]);
  writeFileSync(join(repository, "signup.ts"), "export const signup = true;\n");
  git(repository, ["add", "signup.ts"]);
  git(repository, ["commit", "-m", "initial"]);
  writeFileSync(join(repository, "operator-dirty.txt"), "must not be cloned\n");

  const store = new Persistence(join(directory, "agentchannels.db"));
  const agent = store.createAgent({
    id: "ag_product",
    name: "Runbear",
    cwd: repository,
  });
  const binding = store.createBinding({
    id: "bd_product",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "slack-installation",
  });
  store.grantAccess(binding.id, "alice");
  const runtime = new DeterministicRuntime();
  const coordinator = new SessionCoordinator({
    store,
    runtime,
    worktreeRoot: join(directory, "worktrees"),
    concurrency,
  });
  const fixture = {
    directory,
    repository,
    store,
    coordinator,
    runtime,
    bindingId: binding.id,
    operatorUserId: "operator",
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for deterministic test state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function message(
  deliveryId: string,
  remoteConversationId: string,
  remoteUserId: string,
  text: string,
): ConnectorCommand {
  return {
    type: "message",
    deliveryId,
    remoteConversationId,
    remoteUserId,
    text,
  };
}

function latestInteraction(store: Persistence, kind: InteractionKind) {
  const row = store.db
    .prepare(
      "SELECT id FROM interactions WHERE kind=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(kind) as { id: string } | undefined;
  return row === undefined ? undefined : store.getInteraction(row.id);
}

describe("AgentChannels product flow", () => {
  it("does not start a Session from an unrelated Slack thread follow-up", async () => {
    const { store, coordinator, runtime, bindingId } = createFixture();
    await expect(
      coordinator.accept(bindingId, {
        type: "message",
        deliveryId: "evt-unrelated-thread",
        remoteConversationId: "unrelated-thread",
        remoteUserId: "alice",
        text: "ls",
        allowNewSession: false,
      }),
    ).resolves.toBe("denied");
    expect(store.listSessions()).toEqual([]);
    expect(runtime.calls).toEqual([]);
  });

  it("keeps the complete interaction flow local, isolated, authorized, and resumable", async () => {
    const {
      repository,
      store,
      coordinator,
      runtime,
      bindingId,
      operatorUserId,
    } = createFixture();
    const head = git(repository, ["rev-parse", "HEAD"]).trim();

    expect(
      await coordinator.accept(
        bindingId,
        message("evt-1", "thread-1", "alice", "investigate signup regression"),
      ),
    ).toBe("accepted");
    await waitUntil(() => store.listSessions()[0]?.status === "waiting");
    const session = store.listSessions()[0];
    if (session === undefined) throw new Error("Session was not created");
    expect(session.baseCommit).toBe(head);
    expect(session.cwd).toBe(session.worktreePath);
    expect(readFileSync(join(session.cwd, "signup.ts"), "utf8")).toContain(
      "signup",
    );
    expect(existsSync(join(session.cwd, "operator-dirty.txt"))).toBe(false);
    expect(
      git(session.cwd, ["status", "--porcelain", "--untracked-files=all"]),
    ).toBe("");

    const question = latestInteraction(store, "question");
    if (question === undefined)
      throw new Error("Question interaction was not persisted");
    expect(
      await coordinator.accept(bindingId, {
        type: "interaction_response",
        deliveryId: "evt-question-alice",
        remoteConversationId: "thread-1",
        remoteUserId: "alice",
        interactionId: question.id,
        response: { answers: { flow: "Signup" } },
      }),
    ).toBe("accepted");
    await waitUntil(
      () =>
        store.listSessions()[0]?.status === "waiting" &&
        latestInteraction(store, "permission") !== undefined,
    );
    const permission = latestInteraction(store, "permission");
    if (permission === undefined)
      throw new Error("Permission interaction was not persisted");
    expect(
      await coordinator.accept(bindingId, {
        type: "interaction_response",
        deliveryId: "evt-permission-alice",
        remoteConversationId: "thread-1",
        remoteUserId: "alice",
        interactionId: permission.id,
        response: { action: "approve" },
      }),
    ).toBe("denied");
    expect(store.getInteraction(permission.id)?.status).toBe("pending");
    expect(
      await coordinator.accept(bindingId, {
        type: "interaction_response",
        deliveryId: "evt-permission-operator",
        remoteConversationId: "thread-1",
        remoteUserId: operatorUserId,
        interactionId: permission.id,
        response: { action: "approve" },
      }),
    ).toBe("accepted");
    await waitUntil(() => store.listSessions()[0]?.status === "completed");

    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]).toMatchObject({
      method: "start",
      cwd: session.cwd,
      runtimeSessionId: null,
    });
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM deliveries WHERE session_id=? AND kind='final'",
        )
        .get(session.id),
    ).toMatchObject({ count: 1 });

    expect(
      await coordinator.accept(
        bindingId,
        message(
          "evt-follow-up",
          "thread-1",
          "alice",
          "follow up with the test result",
        ),
      ),
    ).toBe("accepted");
    await waitUntil(
      () =>
        store.listSessions()[0]?.status === "completed" &&
        runtime.calls.length === 2,
    );
    expect(runtime.calls[1]).toEqual({
      method: "resume",
      prompt: "follow up with the test result",
      cwd: session.cwd,
      runtimeSessionId: "runtime-1",
    });
    expect(store.getSession(session.id)?.runtimeSessionId).toBe("runtime-1");
  });

  it("queues follow-ups until the active turn completes and preserves their order", async () => {
    const { store, coordinator, runtime, bindingId } = createFixture(1);
    await coordinator.accept(
      bindingId,
      message("evt-hold", "thread-queue", "alice", "hold-first"),
    );
    await waitUntil(() => store.listSessions()[0]?.status === "running");
    await coordinator.accept(
      bindingId,
      message("evt-follow-1", "thread-queue", "alice", "follow-up one"),
    );
    await coordinator.accept(
      bindingId,
      message("evt-follow-2", "thread-queue", "alice", "follow-up two"),
    );
    expect(store.listSessions()[0]?.status).toBe("running");
    expect(runtime.calls.map((call) => call.prompt)).toEqual(["hold-first"]);
    expect(
      store.db
        .prepare(
          "SELECT text FROM followups WHERE session_id=? ORDER BY sequence",
        )
        .all(store.listSessions()[0]?.id),
    ).toEqual([{ text: "follow-up one" }, { text: "follow-up two" }]);

    runtime.release("hold-first");
    await waitUntil(
      () =>
        store.listSessions()[0]?.status === "completed" &&
        runtime.calls.length === 3,
    );
    expect(runtime.calls.map((call) => call.prompt)).toEqual([
      "hold-first",
      "follow-up one",
      "follow-up two",
    ]);
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM followups WHERE status='queued'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it("collects multi-question and multi-select answers before resuming the runtime", async () => {
    const { store, coordinator, bindingId } = createFixture();
    await coordinator.accept(
      bindingId,
      message("evt-multi", "thread-multi", "alice", "ask multiple questions"),
    );
    await waitUntil(() => store.listSessions()[0]?.status === "waiting");
    const interaction = latestInteraction(store, "question");
    if (interaction === undefined)
      throw new Error("Question interaction was not created");

    await coordinator.accept(bindingId, {
      type: "interaction_response",
      deliveryId: "evt-flow",
      remoteConversationId: "thread-multi",
      remoteUserId: "alice",
      interactionId: interaction.id,
      response: { questionIndex: 0, answer: "Signup" },
    });
    expect(store.getInteraction(interaction.id)).toMatchObject({
      status: "pending",
      response: { answers: { "Flow?": "Signup" } },
    });
    expect(store.listSessions()[0]?.status).toBe("waiting");

    await coordinator.accept(bindingId, {
      type: "interaction_response",
      deliveryId: "evt-environments",
      remoteConversationId: "thread-multi",
      remoteUserId: "alice",
      interactionId: interaction.id,
      response: { questionIndex: 1, answer: ["Web", "Mobile"] },
    });
    await waitUntil(() => store.listSessions()[0]?.status === "completed");
    expect(store.getInteraction(interaction.id)).toMatchObject({
      status: "answered",
      response: {
        answers: { "Flow?": "Signup", "Environments?": ["Web", "Mobile"] },
      },
    });
  });

  it("keeps excess sessions queued behind the local concurrency limit", async () => {
    const { store, coordinator, runtime, bindingId } = createFixture(1);
    await coordinator.accept(
      bindingId,
      message("evt-first", "thread-first", "alice", "hold-first"),
    );
    await waitUntil(() => store.listSessions()[0]?.status === "running");
    await coordinator.accept(
      bindingId,
      message("evt-second", "thread-second", "alice", "hold-second"),
    );
    const sessions = store.listSessions();
    const second = sessions.find(
      (candidate) => candidate.remoteConversationId === "thread-second",
    );
    if (second === undefined) throw new Error("Queued Session was not created");
    expect(second.status).toBe("queued");
    expect(runtime.calls.map((call) => call.prompt)).toEqual(["hold-first"]);
    runtime.release("hold-first");
    await waitUntil(() =>
      runtime.calls.some((call) => call.prompt === "hold-second"),
    );
    runtime.release("hold-second");
    await waitUntil(() =>
      store
        .listSessions()
        .every((candidate) => candidate.status === "completed"),
    );
    expect(runtime.calls.map((call) => call.prompt)).toEqual([
      "hold-first",
      "hold-second",
    ]);
  });

  it("recovers running state as interrupted and requires an explicit continuation", async () => {
    const { repository, store, coordinator, runtime, bindingId } =
      createFixture();
    const manager = new WorktreeManager({
      repositoryPath: repository,
      worktreeRoot: join(repository, ".agentchannels-test-worktrees"),
    });
    const worktree = await manager.create("ss_crash");
    const session = store.createSession({
      id: "ss_crash",
      bindingId,
      remoteConversationId: "thread-crash",
      cwd: worktree.path,
      worktreePath: worktree.path,
      baseCommit: worktree.baseCommit,
    });
    store.setRuntimeSessionId(session.id, "runtime-crashed");
    store.transitionSession(session.id, "running");

    expect(coordinator.recoverAfterCrash().sessions).toBe(1);
    expect(store.getSession(session.id)?.status).toBe("interrupted");
    expect(store.getSession(session.id)?.runtimeSessionId).toBe(
      "runtime-crashed",
    );
    expect(runtime.calls).toHaveLength(0);

    await coordinator.accept(
      bindingId,
      message("evt-continue", "thread-crash", "alice", "continue"),
    );
    await waitUntil(() => store.getSession(session.id)?.status === "completed");
    expect(runtime.calls).toEqual([
      {
        method: "resume",
        prompt: "continue",
        cwd: worktree.path,
        runtimeSessionId: "runtime-crashed",
      },
    ]);
  });
});
