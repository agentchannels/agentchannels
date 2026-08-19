import { join } from "node:path";

import type { Persistence } from "../persistence/store.js";
import { WorktreeManager } from "./worktrees.js";

export class SessionRetentionCleaner {
  public constructor(
    private readonly store: Persistence,
    private readonly worktreeRoot: string,
  ) {}

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
