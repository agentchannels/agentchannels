import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../src/engine/worktrees.ts";

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

  it("cleans an unregistered partial worktree after checkout failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentchannels-worktree-failure-"));
    const worktreeRoot = join(root, "worktrees");
    const worktreePath = join(worktreeRoot, "session-lfs");
    const git = {
      run: vi.fn((args: readonly string[]) => {
        if (args[1] === "--show-toplevel") return Promise.resolve("/repo\n");
        if (args[0] === "rev-parse") return Promise.resolve("abc123\n");
        if (args.includes("worktree") && args.includes("add")) {
          mkdirSync(worktreePath, { recursive: true });
          writeFileSync(join(worktreePath, "partial"), "partial\n");
          const error = new Error(
            "Command failed: git worktree add",
          ) as Error & {
            stderr: string;
          };
          error.stderr = "git-lfs filter-process: git-lfs: command not found";
          return Promise.reject(error);
        }
        if (args[0] === "worktree" && args[1] === "list")
          return Promise.resolve("worktree /repo\n");
        return Promise.resolve("");
      }),
    };
    const manager = new WorktreeManager({
      repositoryPath: "/repo",
      worktreeRoot,
      git,
    });
    await expect(manager.create("session-lfs")).rejects.toThrow(
      "The repository could not be checked out with its configured Git tools. Ask the Agent operator to inspect the local toolchain.",
    );
    expect(existsSync(worktreePath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rolls back a newly registered worktree when a checkout hook fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentchannels-worktree-hook-"));
    const worktreeRoot = join(root, "worktrees");
    const worktreePath = join(worktreeRoot, "session-hook");
    const git = {
      run: vi.fn((args: readonly string[]) => {
        if (args[1] === "--show-toplevel") return Promise.resolve("/repo\n");
        if (args[0] === "rev-parse") return Promise.resolve("abc123\n");
        if (args[0] === "worktree" && args[1] === "add") {
          mkdirSync(worktreePath, { recursive: true });
          return Promise.reject(new Error("post-checkout hook failed"));
        }
        if (args[0] === "worktree" && args[1] === "list")
          return Promise.resolve(
            `worktree /repo\n\nworktree ${worktreePath}\n`,
          );
        if (args[0] === "worktree" && args[1] === "remove") {
          rmSync(worktreePath, { recursive: true, force: true });
          return Promise.resolve("");
        }
        return Promise.resolve("");
      }),
    };
    const manager = new WorktreeManager({
      repositoryPath: "/repo",
      worktreeRoot,
      git,
    });
    await expect(manager.create("session-hook")).rejects.toThrow(
      "The repository could not be checked out with its configured Git tools.",
    );
    expect(existsSync(worktreePath)).toBe(false);
    expect(
      git.run.mock.calls.some(([args]) =>
        args.join(" ").includes("worktree remove --force"),
      ),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
