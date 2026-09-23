export type ServiceCommand = {
  /** Must resolve to an installation-stable executable, not a checkout-local shim. */
  executable: string;
  args: string[];
  environment?: Record<string, string>;
};

/** The command persisted in launchd/systemd definitions across process updates. */
export type StableServiceCommand = ServiceCommand;

export type ServiceDefinition = {
  version: string;
  command: StableServiceCommand;
};

export type ServiceStatus = {
  platform: NodeJS.Platform | string;
  supported: boolean;
  installed: boolean;
  running: boolean;
  definitionMatches: boolean;
  definitionPath: string;
  command?: ServiceCommand;
  version?: string;
};

/** The externally meaningful result of a service lifecycle mutation. */
export type ServiceOperation =
  | "installed"
  | "started"
  | "restarted"
  | "unchanged"
  | "stopped"
  | "uninstalled"
  | "unsupported";

export type ServiceOperationResult = ServiceStatus & {
  operation: ServiceOperation;
};

export type ServiceFileSystem = {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

export type ServiceCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ServiceCommandRunner = (
  executable: string,
  args: string[],
  options?: { allowFailure?: boolean },
) => Promise<ServiceCommandResult>;

export type ServiceManagerOptions = {
  platform?: NodeJS.Platform | string;
  uid?: number;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  fileSystem?: ServiceFileSystem;
  runCommand?: ServiceCommandRunner;
  registry?: ServicePlatformRegistry;
  serviceIdentifier?: string;
};

export type ServicePlatformAdapter = {
  readonly platform: NodeJS.Platform | string;
  readonly definitionPath: string;
  install(definition: ServiceDefinition): Promise<void>;
  reconcile(definition: ServiceDefinition): Promise<ServiceOperationResult>;
  start(): Promise<void>;
  restart(definition?: ServiceDefinition): Promise<void>;
  stop(): Promise<void>;
  uninstall(): Promise<void>;
  status(definition?: ServiceDefinition): Promise<ServiceStatus>;
};

export type ServicePlatformFactory = (
  options: Required<
    Pick<
      ServiceManagerOptions,
      | "homeDirectory"
      | "fileSystem"
      | "runCommand"
      | "uid"
      | "serviceIdentifier"
    >
  > & { platform: NodeJS.Platform | string },
) => ServicePlatformAdapter;

export type ServicePlatformRegistry = {
  get(platform: NodeJS.Platform | string): ServicePlatformFactory | undefined;
};

export const SERVICE_NAME = "agentchannels";
export const SERVICE_VERSION_ENV = "AGENTCHANNELS_SERVICE_VERSION";
