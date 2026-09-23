import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Everything one AgentChannels installation owns, including the operating-system
 * credential-store namespace. Deriving all of it from a single root is what makes
 * `--home` a complete isolation boundary rather than a filesystem-only one.
 */
export type ProductPaths = {
  root: string;
  database: string;
  backups: string;
  logs: string;
  onboarding: string;
  worktrees: string;
  /** Service name under which this installation's secrets live in the OS keyring. */
  keyringService: string;
};

const KEYRING_SERVICE = "agentchannels";

export function defaultProductRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(environment.HOME ?? homedir(), ".agentchannels");
}

function keyringServiceFor(root: string, defaultRoot: string): string {
  if (root === defaultRoot) return KEYRING_SERVICE;
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return `${KEYRING_SERVICE}:${digest}`;
}

export function resolveProductPaths(
  environment: NodeJS.ProcessEnv = process.env,
): ProductPaths {
  const defaultRoot = defaultProductRoot(environment);
  const root = resolve(environment.AGENTCHANNELS_HOME ?? defaultRoot);
  return {
    root,
    database: join(root, "agentchannels.db"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
    onboarding: join(root, "onboarding"),
    worktrees: join(root, "worktrees"),
    keyringService: keyringServiceFor(root, defaultRoot),
  };
}

export function ensureProductPaths(paths: ProductPaths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
  mkdirSync(paths.onboarding, { recursive: true, mode: 0o700 });
  mkdirSync(paths.worktrees, { recursive: true, mode: 0o700 });
}
