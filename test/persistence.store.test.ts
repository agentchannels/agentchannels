import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence } from "../src/store/store.ts";

const stores: Persistence[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture(options?: ConstructorParameters<typeof Persistence>[1]): {
  store: Persistence;
  agentId: string;
  bindingId: string;
} {
  const store = new Persistence(":memory:", options);
  stores.push(store);
  const agent = store.createAgent({
    id: "ag_test",
    name: "Test",
    cwd: "/workspace/project",
  });
  const binding = store.createBinding({
    id: "bd_test",
    agentId: agent.id,
    connector: "slack",
    operatorUserId: "operator",
    externalInstallationId: "slack-app",
  });
  return { store, agentId: agent.id, bindingId: binding.id };
}

describe("persistence schema and access", () => {
  it("enables foreign keys and keeps connector secrets/private keys out of SQLite", () => {
    const { store, bindingId } = fixture();
    expect(store.db.pragma("foreign_keys", { simple: true }) as number).toBe(1);
    expect(() =>
      store.createBinding({
        agentId: "missing",
        connector: "slack",
        operatorUserId: "u",
        externalInstallationId: "x",
      }),
    ).toThrow();
    const columns = store.db
      .prepare("SELECT name FROM pragma_table_info('installations')")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain("private_key");
    expect(columns.map((column) => column.name)).not.toContain(
      "connector_secret",
    );
    expect(store.isAuthorized(bindingId, "operator")).toBe(true);
    expect(store.isAuthorized(bindingId, "other")).toBe(false);
    store.grantAccess(bindingId, "other");
    expect(store.isAuthorized(bindingId, "other")).toBe(true);
    store.revokeAccess(bindingId, "other");
    expect(store.isAuthorized(bindingId, "other")).toBe(false);
  });

  it("matches a CWD inside an Agent and does not guess from a parent", () => {
    const { store } = fixture();
    const ids = (cwd: string) => store.findAgentsByCwd(cwd).map((a) => a.id);
    expect(ids("/workspace/project")).toEqual(["ag_test"]);
    expect(ids("/workspace/project/packages/core")).toEqual(["ag_test"]);
    expect(ids("/workspace")).toEqual([]);
    expect(ids("/workspace/project-other")).toEqual([]);
    store.createAgent({
      id: "ag_second",
      name: "Second",
      cwd: "/workspace/project",
    });
    expect(ids("/workspace/project").sort()).toEqual(["ag_second", "ag_test"]);
  });
});

describe("session state and recovery", () => {
  it("enforces lifecycle transitions and retains runtime/worktree metadata during crash recovery", () => {
    const { store, bindingId } = fixture({ sessionRetentionMs: 1_000 });
    const session = store.createSession({
      id: "ss_test",
      bindingId,
      remoteConversationId: "thread",
      cwd: "/workspace/project/.worktrees/ss_test",
      worktreePath: "/workspace/project/.worktrees/ss_test",
      baseCommit: "abc123",
    });
    store.setRuntimeSessionId(session.id, "runtime-1");
    store.transitionSession(session.id, "running");
    store.transitionSession(session.id, "waiting");
    const interaction = store.createInteraction({
      id: "ix_crash",
      sessionId: session.id,
      kind: "permission",
      request: { command: "git push" },
    });
    expect(store.recoverInterrupted()).toBe(1);
    const interrupted = store.getSession(session.id);
    if (interrupted === undefined)
      throw new Error("Interrupted Session disappeared");
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.runtimeSessionId).toBe("runtime-1");
    expect(interrupted.worktreePath).toContain(".worktrees/ss_test");
    expect(interrupted.baseCommit).toBe("abc123");
    expect(store.getInteraction(interaction.id)?.status).toBe("cancelled");
    expect(() => store.transitionSession(session.id, "completed")).toThrow();
    store.transitionSession(session.id, "queued");
    store.transitionSession(session.id, "running");
    const completed = store.transitionSession(
      session.id,
      "completed",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(completed.retentionExpiresAt).toBe("2026-01-01T00:00:01.000Z");
    expect(
      store.getSessionByRemoteConversation(
        bindingId,
        "thread",
        new Date("2026-01-01T00:00:00.999Z"),
      )?.id,
    ).toBe(session.id);
    expect(
      store.getSessionByRemoteConversation(
        bindingId,
        "thread",
        new Date("2026-01-01T00:00:01.000Z"),
      ),
    ).toBeUndefined();
    expect(() =>
      store.retireSession(session.id, new Date("2026-01-01T00:00:00.999Z")),
    ).toThrow(/still retained/);
    expect(
      store.retireSession(session.id, new Date("2026-01-01T00:00:01.000Z")),
    ).toBe(true);
    expect(store.getSession(session.id)).toBeUndefined();
  });

  it("keeps queued follow-ups ordered across insertion and recovery", () => {
    const { store, bindingId } = fixture();
    const session = store.createSession({
      bindingId,
      remoteConversationId: "thread",
      cwd: "/w/.worktree",
      worktreePath: "/w/.worktree",
      baseCommit: "head",
    });
    const first = store.enqueueFollowUp({
      sessionId: session.id,
      remoteUserId: "u",
      text: "first",
    });
    const second = store.enqueueFollowUp({
      sessionId: session.id,
      remoteUserId: "u",
      text: "second",
    });
    expect(
      store.listQueuedFollowUps(session.id).map((followup) => followup.text),
    ).toEqual(["first", "second"]);
    store.markFollowUpDelivered(first.id);
    expect(
      store.listQueuedFollowUps(session.id).map((followup) => followup.text),
    ).toEqual(["second"]);
    expect(second.sequence).toBe(2);
  });
});

describe("delivery and ingress durability", () => {
  it("tracks delivery retry independently from completed execution", () => {
    const { store, bindingId } = fixture();
    const session = store.createSession({
      bindingId,
      remoteConversationId: "thread",
      cwd: "/w/.worktree",
      worktreePath: "/w/.worktree",
      baseCommit: "head",
    });
    store.transitionSession(session.id, "running");
    store.transitionSession(session.id, "completed");
    const delivery = store.enqueueDelivery({
      sessionId: session.id,
      connector: "slack",
      remoteConversationId: "thread",
      kind: "final",
      body: "done",
    });
    expect(() =>
      store.enqueueDelivery({
        sessionId: session.id,
        connector: "slack",
        remoteConversationId: "thread",
        kind: "error",
        body: "bad",
        metadata: { accessToken: "must-not-persist" },
      }),
    ).toThrow(/Sensitive metadata/);
    const [claimed] = store.claimDueDeliveries(1);
    expect(claimed?.attempts).toBe(1);
    store.markDeliveryRetry(
      delivery.id,
      "offline",
      new Date("2030-01-01T00:00:00.000Z"),
    );
    expect(store.getSession(session.id)?.status).toBe("completed");
    expect(store.getDelivery(delivery.id)?.status).toBe("retrying");
    expect(store.getDelivery(delivery.id)?.lastError).toBe("offline");
  });

  it("deduplicates event IDs per binding but permits the same ID for another binding", () => {
    const { store, agentId, bindingId } = fixture();
    const other = store.createBinding({
      agentId,
      connector: "linear",
      operatorUserId: "operator",
      externalInstallationId: "linear-app",
    });
    expect(store.recordIngress(bindingId, "evt-1")).toBe(true);
    expect(store.recordIngress(bindingId, "evt-1")).toBe(false);
    expect(store.recordIngress(other.id, "evt-1")).toBe(true);
  });
});

describe("file-backed migrations", () => {
  it("applies once and preserves state on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentchannels-persistence-"));
    const filename = join(directory, "state.db");
    const first = new Persistence(filename);
    first.createAgent({
      id: "ag_persist",
      name: "Persisted",
      cwd: "/persisted",
    });
    first.close();
    const second = new Persistence(filename);
    stores.push(second);
    expect(second.getAgent("ag_persist")?.name).toBe("Persisted");
    expect(
      (
        second.db.pragma("journal_mode", { simple: true }) as string
      ).toLowerCase(),
    ).toBe("wal");
    rmSync(directory, { recursive: true, force: true });
  });
});
