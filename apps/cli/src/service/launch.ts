import { existsSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export type DaemonLaunch = Readonly<{ executable: string; args: string[] }>;

const EMBEDDED_ROOTS = ["/$bunfs/", "B:/~BUN/", "B:\\~BUN\\"];

export function isCompiledBinary(main: string = Bun.main): boolean {
  return EMBEDDED_ROOTS.some((root) => main.startsWith(root));
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function stableRuntimeExecutable(
  path: string = process.env.PATH ?? "",
): string {
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    if (existsSync(candidate) && sameFile(candidate, process.execPath))
      return candidate;
  }
  return process.execPath;
}

export function daemonLaunch(entry?: string): DaemonLaunch {
  if (entry !== undefined)
    return { executable: resolve(entry), args: ["daemon"] };
  if (isCompiledBinary())
    return { executable: process.execPath, args: ["daemon"] };
  return {
    executable: stableRuntimeExecutable(),
    args: [resolve(Bun.main), "daemon"],
  };
}
