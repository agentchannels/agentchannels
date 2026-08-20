import { execFile } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Worktree = {
  /** Root path passed to `git worktree add`; use cwd for launching the runtime. */
  path: string;
  cwd: string;
  baseCommit: string;
};

export type GitClient = {
  run(args: readonly string[], cwd: string): Promise<string>;
};

const systemGit: GitClient = {
  async run(args, cwd) {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
    });
    return result.stdout;
  },
};

export type WorktreeManagerOptions = {
  /** Root of the repository whose current HEAD is used as the worktree base. */
  repositoryPath: string;
  /** Directory reserved for AgentChannels-created worktrees. */
  worktreeRoot?: string;
  git?: GitClient;
};

export class WorktreeCreationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "WorktreeCreationError";
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

function worktreeFailureMessage(): string {
  return "The repository could not be checked out with its configured Git tools. Ask the Agent operator to inspect the local toolchain.";
}

async function isRegisteredWorktree(
  git: GitClient,
  repositoryRoot: string,
  worktreePath: string,
): Promise<boolean> {
  const listing = await git.run(
    ["worktree", "list", "--porcelain"],
    repositoryRoot,
  );
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()))
    .includes(worktreePath);
}

/** Creates and retires only clean worktrees owned by this manager. */
export class WorktreeManager {
  private readonly git: GitClient;
  private readonly repositoryPath: string;
  private readonly configuredWorktreeRoot: string | undefined;
  private readonly ownedPaths = new Set<string>();

  constructor(options: WorktreeManagerOptions) {
    this.repositoryPath = path.resolve(options.repositoryPath);
    this.configuredWorktreeRoot = options.worktreeRoot
      ? path.resolve(options.worktreeRoot)
      : undefined;
    this.git = options.git ?? systemGit;
  }

  async create(sessionId: string): Promise<Worktree> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
      throw new Error("Session ID is not safe for a worktree path");
    }

    const repositoryRoot = (
      await this.git.run(["rev-parse", "--show-toplevel"], this.repositoryPath)
    ).trim();
    if (!repositoryRoot)
      throw new Error("The configured CWD is not a Git repository");

    const worktreeRoot =
      this.configuredWorktreeRoot ??
      path.join(repositoryRoot, ".agentchannels", "worktrees");

    // Resolve HEAD before adding the worktree. This intentionally excludes all
    // uncommitted files from a remote session's starting point.
    const baseCommit = (
      await this.git.run(["rev-parse", "--verify", "HEAD"], repositoryRoot)
    ).trim();
    if (!baseCommit) throw new Error("The repository has no current HEAD");

    await mkdir(worktreeRoot, { recursive: true });
    const worktreePath = path.join(worktreeRoot, sessionId);
    if (!worktreePath.startsWith(`${worktreeRoot}${path.sep}`)) {
      throw new Error("Worktree path escapes the owned worktree directory");
    }
    if (await pathExists(worktreePath))
      throw new WorktreeCreationError(
        "The Session worktree path already exists. Ask the Agent operator to inspect stale AgentChannels worktrees.",
        undefined,
      );

    try {
      await this.git.run(
        ["worktree", "add", "--detach", worktreePath, baseCommit],
        repositoryRoot,
      );
    } catch (error) {
      let registered: boolean | undefined;
      try {
        registered = await isRegisteredWorktree(
          this.git,
          repositoryRoot,
          worktreePath,
        );
      } catch {}
      if (registered === true) {
        try {
          await this.git.run(
            ["worktree", "remove", "--force", worktreePath],
            repositoryRoot,
          );
        } catch {}
      } else if (registered === false) {
        await rm(worktreePath, { recursive: true, force: true });
      }
      throw new WorktreeCreationError(worktreeFailureMessage(), error);
    }
    this.ownedPaths.add(worktreePath);
    const relativeCwd = path.relative(repositoryRoot, this.repositoryPath);
    return {
      path: worktreePath,
      cwd: relativeCwd ? path.join(worktreePath, relativeCwd) : worktreePath,
      baseCommit,
    };
  }

  /**
   * Removes a clean worktree created by this manager. Dirty worktrees are left
   * in place so local changes remain recoverable.
   */
  async remove(
    worktree: Pick<Worktree, "path"> | string,
  ): Promise<"removed" | "preserved"> {
    const worktreePath = path.resolve(
      typeof worktree === "string" ? worktree : worktree.path,
    );
    const repositoryRoot = (
      await this.git.run(["rev-parse", "--show-toplevel"], this.repositoryPath)
    ).trim();
    const worktreeRoot =
      this.configuredWorktreeRoot ??
      path.join(repositoryRoot, ".agentchannels", "worktrees");
    if (!worktreePath.startsWith(`${worktreeRoot}${path.sep}`))
      throw new Error(`Worktree is not owned by this manager: ${worktreePath}`);
    if (!this.ownedPaths.has(worktreePath)) {
      const listing = await this.git.run(
        ["worktree", "list", "--porcelain"],
        repositoryRoot,
      );
      const listed = listing
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => path.resolve(line.slice("worktree ".length).trim()));
      if (!listed.includes(worktreePath))
        throw new Error(
          `Worktree is not owned by this manager: ${worktreePath}`,
        );
    }

    const status = await this.git.run(
      ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"],
      worktreePath,
    );
    if (status.trim() !== "") return "preserved";

    await this.git.run(["worktree", "remove", worktreePath], repositoryRoot);
    this.ownedPaths.delete(worktreePath);
    return "removed";
  }

  owns(worktreePath: string): boolean {
    return this.ownedPaths.has(path.resolve(worktreePath));
  }
}
