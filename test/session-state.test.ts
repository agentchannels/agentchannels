import { describe, expect, it } from "vitest";

import { canTransition } from "../src/model.ts";
import { Persistence } from "../src/store/store.ts";

describe("Session state transitions", () => {
  it("supports the execution, interaction, completion, and explicit resume paths", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting")).toBe(true);
    expect(canTransition("waiting", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("completed", "queued")).toBe(true);
    expect(canTransition("running", "stopped")).toBe(true);
    expect(canTransition("stopped", "queued")).toBe(true);
  });

  it("keeps failure terminal and distinguishes stop from failure", () => {
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "stopped")).toBe(true);
    // Enforcement lives where transitions are written, so assert it there.
    const store = new Persistence(":memory:");
    try {
      const agent = store.createAgent({ name: "T", cwd: "/repository" });
      const binding = store.createBinding({
        agentId: agent.id,
        connector: "slack",
        operatorUserId: "operator",
        externalInstallationId: "workspace",
      });
      const session = store.createSession({
        bindingId: binding.id,
        remoteConversationId: "thread",
        cwd: "/worktree",
        worktreePath: "/worktree",
        baseCommit: "head",
      });
      store.transitionSession(session.id, "running");
      store.transitionSession(session.id, "failed");
      expect(() => store.transitionSession(session.id, "running")).toThrow(
        "failed -> running",
      );
    } finally {
      store.close();
    }
  });
});
