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
