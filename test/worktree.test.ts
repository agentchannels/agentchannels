import { describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../src/core/worktrees.js";

describe("WorktreeManager", () => {
  it("creates from HEAD and preserves dirty worktrees", async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const git = {
      run: vi.fn((args: readonly string[], cwd: string) => {
        calls.push({ args, cwd });
        if (args[1] === "--show-toplevel") return Promise.resolve("/repo\n");
        if (args[0] === "rev-parse") return Promise.resolve("abc123\n");
        if (args[0] === "status") return Promise.resolve(" M file.ts\n");
        return Promise.resolve("");
      }),
    };
    const manager = new WorktreeManager({
      repositoryPath: "/repo",
      worktreeRoot: "/tmp/agentchannels",
      git,
    });
    const worktree = await manager.create("session-1");
    expect(worktree).toEqual({
      path: "/tmp/agentchannels/session-1",
      cwd: "/tmp/agentchannels/session-1",
      baseCommit: "abc123",
    });
    expect(calls[2]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "/tmp/agentchannels/session-1",
      "abc123",
    ]);
    await expect(manager.remove(worktree)).resolves.toBe("preserved");
    expect(
      calls.some(({ args }) => args[0] === "worktree" && args[1] === "remove"),
    ).toBe(false);
  });

  it("removes only clean worktrees it owns", async () => {
    const git = {
      run: vi.fn((args: readonly string[]) =>
        Promise.resolve(
          args[1] === "--show-toplevel"
            ? "/repo\n"
            : args[0] === "rev-parse"
              ? "abc123\n"
              : "",
        ),
      ),
    };
    const manager = new WorktreeManager({
      repositoryPath: "/repo",
      worktreeRoot: "/tmp/agentchannels-clean",
      git,
    });
    const worktree = await manager.create("session-2");
    await expect(manager.remove(worktree)).resolves.toBe("removed");
    await expect(manager.remove(worktree)).rejects.toThrow("not owned");
  });

  it("keeps an Agent subdirectory as the runtime CWD inside the detached root", async () => {
    const git = {
      run: vi.fn((args: readonly string[]) =>
        Promise.resolve(args[1] === "--show-toplevel" ? "/repo\n" : "abc123\n"),
      ),
    };
    const manager = new WorktreeManager({
      repositoryPath: "/repo/packages/app",
      worktreeRoot: "/tmp/agentchannels-subdir",
      git,
    });
    await expect(manager.create("session-3")).resolves.toMatchObject({
      path: "/tmp/agentchannels-subdir/session-3",
      cwd: "/tmp/agentchannels-subdir/session-3/packages/app",
    });
  });
});
