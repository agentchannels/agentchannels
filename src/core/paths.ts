import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export type ProductPaths = {
  root: string;
  database: string;
  logs: string;
  worktrees: string;
};

export function resolveProductPaths(
  environment: NodeJS.ProcessEnv = process.env,
): ProductPaths {
  const root = resolve(
    environment.AGENTCHANNELS_HOME ?? join(homedir(), ".agentchannels"),
  );
  return {
    root,
    database: join(root, "agentchannels.db"),
    logs: join(root, "logs"),
    worktrees: join(root, "worktrees"),
  };
}

export function ensureProductPaths(paths: ProductPaths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.worktrees, { recursive: true, mode: 0o700 });
}
