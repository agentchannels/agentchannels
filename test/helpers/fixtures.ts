import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialStore } from "../../src/security/keyring.ts";

/**
 * Disposable state for tests.
 *
 * Every suite used to build its own temporary home and Git repository, which is
 * how they drifted apart on details that matter - whether the repository has a
 * commit, whether the path is canonical on macOS, whether cleanup happens.
 */
const created: string[] = [];

/** A temporary directory removed by `cleanupFixtures`. */
export function temporaryDirectory(prefix = "agentchannels-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

export type RepositoryFixture = Readonly<{
  /** The temporary root holding both the repository and the product home. */
  root: string;
  /** Canonical repository path: macOS resolves /var through a symlink. */
  cwd: string;
  /** An isolated `AGENTCHANNELS_HOME`, including its keyring namespace. */
  home: string;
}>;

/**
 * A Git repository with one commit, plus an isolated product home.
 *
 * `withHead: false` produces a repository without a commit, which is the state
 * `init` must refuse.
 */
export function repositoryFixture(
  options: {
    withHead?: boolean;
    file?: { name: string; content: string };
  } = {},
): RepositoryFixture {
  const root = temporaryDirectory("agentchannels-repository-");
  const cwd = join(root, "repository");
  execFileSync("git", ["init", "--initial-branch", "main", cwd], {
    stdio: "ignore",
  });
  if (options.file !== undefined)
    writeFileSync(join(cwd, options.file.name), options.file.content);
  if (options.withHead !== false) {
    if (options.file !== undefined)
      execFileSync("git", ["add", options.file.name], { cwd, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=AgentChannels Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd, stdio: "ignore" },
    );
  }
  return { root, cwd: realpathSync(cwd), home: join(root, "home") };
}

/** Run git in a fixture repository and return stdout. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** A credential store that keeps secrets in memory and never touches the keyring. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** Poll until a condition holds, so tests do not depend on a fixed sleep. */
export async function waitUntil(
  predicate: () => boolean,
  description = "condition",
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export function cleanupFixtures(): void {
  for (const directory of created.splice(0))
    rmSync(directory, { recursive: true, force: true });
}
