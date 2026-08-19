import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";

import type {
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceFileSystem,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const nodeFileSystem: ServiceFileSystem = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  async write(path, content) {
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  async remove(path) {
    try {
      await rm(path, { force: true });
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  },
};

export const nodeCommandRunner: ServiceCommandRunner = async (
  executable,
  args,
  options,
): Promise<ServiceCommandResult> => {
  try {
    const result = await execFileAsync(executable, args, {
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    if (options?.allowFailure === true) {
      return {
        exitCode,
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr:
          typeof failure.stderr === "string"
            ? failure.stderr
            : typeof failure.message === "string"
              ? failure.message
              : "",
      };
    }
    throw new Error(
      typeof failure.message === "string"
        ? failure.message
        : `Service command failed with exit code ${String(exitCode)}`,
    );
  }
};

export function defaultHomeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.HOME ?? homedir();
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
