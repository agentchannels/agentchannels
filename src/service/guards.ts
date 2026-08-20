import type { ServiceCommandResult } from "./types.js";

export class UnsupportedServicePlatformError extends Error {
  readonly code = "UNSUPPORTED_SERVICE_PLATFORM";

  constructor(platform: NodeJS.Platform | string) {
    super(
      `Background services are unsupported on ${platform}; run agentchannels daemon in the foreground`,
    );
    this.name = "UnsupportedServicePlatformError";
  }
}

export class PrivilegedServiceError extends Error {
  readonly code = "PRIVILEGED_SERVICE_OPERATION";

  constructor() {
    super(
      "Background services must be installed for the current user; do not run AgentChannels as root or with sudo",
    );
    this.name = "PrivilegedServiceError";
  }
}

export class ServiceManagerError extends Error {
  readonly code = "SERVICE_MANAGER_FAILED";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ServiceManagerError";
  }
}

/** A service-manager command failed; stdout/stderr remain available for debug output. */
export class ServiceCommandError extends Error {
  readonly code = "SERVICE_COMMAND_FAILED";

  constructor(
    readonly executable: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
    cause?: unknown,
  ) {
    const diagnostic = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
    super(
      `Service command failed with exit code ${String(exitCode)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ServiceCommandError";
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
