import { AgentChannelsError } from "../errors.ts";
import type { ServiceCommandResult } from "./types.ts";

export class UnsupportedServicePlatformError extends AgentChannelsError {
  constructor(platform: NodeJS.Platform | string) {
    super(
      "SERVICE_MANAGER_FAILED",
      `Background services are unsupported on ${platform}; run agentchannels daemon in the foreground`,
      ["Run agentchannels daemon in the foreground."],
    );
    this.name = "UnsupportedServicePlatformError";
  }
}

export class PrivilegedServiceError extends AgentChannelsError {
  constructor() {
    super(
      "SERVICE_MANAGER_FAILED",
      "Background services must be installed for the current user; do not run AgentChannels as root or with sudo",
      ["Run agentchannels daemon install as the current user, without sudo."],
    );
    this.name = "PrivilegedServiceError";
  }
}

export class ServiceManagerError extends AgentChannelsError {
  constructor(message: string, cause: unknown) {
    super(
      "SERVICE_MANAGER_FAILED",
      message,
      ["Run agentchannels daemon install --debug to retry with diagnostics."],
      { cause },
    );
    this.name = "ServiceManagerError";
  }
}

/** A service-manager command failed; stdout/stderr remain available for debug output. */
export class ServiceCommandError extends AgentChannelsError {
  readonly executable: string;
  readonly args: readonly string[];
  /** Exit status of the service-manager command, not this process's exit code. */
  readonly commandExitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    executable: string,
    args: readonly string[],
    exitCode: number,
    stdout: string,
    stderr: string,
    cause?: unknown,
  ) {
    const diagnostic = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
    super(
      "SERVICE_MANAGER_FAILED",
      `Service command failed with exit code ${String(exitCode)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
      ["Run agentchannels daemon install --debug to retry with diagnostics."],
      cause === undefined ? undefined : { cause },
    );
    this.name = "ServiceCommandError";
    this.executable = executable;
    this.args = args;
    this.commandExitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Keep expected "inactive" exits idempotent while surfacing manager failures. */
export function assertExpectedServiceExit(
  executable: string,
  args: readonly string[],
  result: ServiceCommandResult,
  expected: readonly number[],
): void {
  if (expected.includes(result.exitCode)) return;
  throw new ServiceCommandError(
    executable,
    args,
    result.exitCode,
    result.stdout,
    result.stderr,
  );
}

export function assertUserServiceMutation(options: {
  platform: NodeJS.Platform | string;
  uid: number;
  environment: NodeJS.ProcessEnv;
}): void {
  if (options.platform === "win32")
    throw new UnsupportedServicePlatformError(options.platform);
  if (
    options.uid === 0 ||
    options.environment.SUDO_USER !== undefined ||
    options.environment.SUDO_UID !== undefined
  ) {
    throw new PrivilegedServiceError();
  }
}
