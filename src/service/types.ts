export type ServiceCommand = {
  executable: string;
  args: string[];
  environment?: Record<string, string>;
};

export type StableServiceCommand = ServiceCommand;

export type ServiceDefinition = {
  version: string;
  command: ServiceCommand;
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
  nextAction: string;
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
};

export type ServicePlatformAdapter = {
  readonly platform: NodeJS.Platform | string;
  readonly definitionPath: string;
  install(definition: ServiceDefinition): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  uninstall(): Promise<void>;
  status(definition?: ServiceDefinition): Promise<ServiceStatus>;
};

export type ServicePlatformFactory = (
  options: Required<
    Pick<
      ServiceManagerOptions,
      "homeDirectory" | "fileSystem" | "runCommand" | "uid"
    >
  > & { platform: NodeJS.Platform | string },
) => ServicePlatformAdapter;

export type ServicePlatformRegistry = {
  get(platform: NodeJS.Platform | string): ServicePlatformFactory | undefined;
};

export const SERVICE_NAME = "agentchannels";
export const SERVICE_VERSION_ENV = "AGENTCHANNELS_SERVICE_VERSION";
