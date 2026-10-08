import { join } from "node:path";

import type { Persistence } from "../store/store.ts";
import { WorktreeManager } from "./worktrees.ts";

export class SessionRetentionCleaner {
  private readonly store: Persistence;
  private readonly worktreeRoot: string;

  public constructor(store: Persistence, worktreeRoot: string) {
    this.store = store;
    this.worktreeRoot = worktreeRoot;
  }

  public async clean(
    at = new Date(),
  ): Promise<{ removed: number; preservedDirty: number }> {
    let removed = 0;
    let preservedDirty = 0;
    for (const session of this.store.listExpiredSessions(at)) {
      const binding = this.store.getBinding(session.bindingId);
      const agent =
        binding === undefined
          ? undefined
          : this.store.getAgent(binding.agentId);
      if (agent === undefined) continue;
      const worktrees = new WorktreeManager({
        repositoryPath: agent.cwd,
        worktreeRoot: join(this.worktreeRoot, agent.id),
      });
      const result = await worktrees.remove(session.worktreePath);
      if (result === "preserved") {
        preservedDirty += 1;
        continue;
      }
      if (this.store.retireSession(session.id, at)) removed += 1;
    }
    return { removed, preservedDirty };
  }
}
