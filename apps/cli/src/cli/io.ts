import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  checkbox as inquirerCheckbox,
  confirm as inquirerConfirm,
  input as inquirerInput,
  password as inquirerPassword,
  select as inquirerSelect,
} from "@inquirer/prompts";

import { AgentChannelsError } from "../errors.ts";

let cancellationRequested = false;
let activePrompts = 0;
const activePromptControllers = new Set<AbortController>();
const queuedPromptCancellers = new Set<() => void>();

/** Allow the process boundary to ask an active prompt to unwind before exit. */
export function requestPromptCancellation(): void {
  cancellationRequested = true;
  for (const controller of activePromptControllers) controller.abort();
  for (const cancel of queuedPromptCancellers) cancel();
  if (activePrompts === 0 && queuedPromptCancellers.size === 0)
    cancellationRequested = false;
}

export function hasActivePrompt(): boolean {
  return activePrompts > 0;
}

export type PromptIO = Readonly<{
  input(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
  confirm(label: string, defaultYes: boolean): Promise<boolean>;
  select<Value>(
    label: string,
    choices: readonly PromptChoice<Value>[],
  ): Promise<Value>;
  multiSelect<Value>(
    label: string,
    choices: readonly PromptChoice<Value>[],
  ): Promise<readonly Value[]>;
}>;

export type PromptChoice<Value> = Readonly<{
  value: Value;
  label: string;
  description?: string;
}>;

export type TerminalPromptOptions = Readonly<{
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompts?: PromptFunctions;
}>;

type PromptFunctions = Readonly<{
  input: typeof inquirerInput;
  password: typeof inquirerPassword;
  confirm: typeof inquirerConfirm;
  select: typeof inquirerSelect;
  checkbox: typeof inquirerCheckbox;
}>;

const defaultPrompts: PromptFunctions = {
  input: inquirerInput,
  password: inquirerPassword,
  confirm: inquirerConfirm,
  select: inquirerSelect,
  checkbox: inquirerCheckbox,
};

function isPromptCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "CancelPromptError" ||
      error.name === "ExitPromptError" ||
      error.name === "AbortPromptError")
  );
}

function promptContext(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  clearPromptOnDone: true;
} {
  return { input, output, clearPromptOnDone: true };
}

type PromptTask<Value> = Readonly<{
  run: () => Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
  cancelled: () => boolean;
}>;

/**
 * Inquirer owns the terminal while a prompt is active. Queueing calls keeps
 * independently-triggered prompt requests from creating competing readline
 * interfaces on the same TTY.
 */
class PromptQueue {
  private readonly tasks: PromptTask<unknown>[] = [];
  private running = false;

  enqueue<Value>(run: () => Promise<Value>): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      let cancelled = false;
      const cancel = (): void => {
        cancelled = true;
        queuedPromptCancellers.delete(cancel);
        reject(new AgentChannelsError("CANCELLED", "Cancelled.", []));
      };
      queuedPromptCancellers.add(cancel);
      this.tasks.push({
        run: async () => {
          queuedPromptCancellers.delete(cancel);
          return run();
        },
        resolve: resolve as (value: unknown) => void,
        reject,
        cancelled: () => cancelled,
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (task === undefined || task.cancelled()) continue;
        try {
          task.resolve(await task.run());
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

type RawModeStream = NodeJS.ReadableStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => RawModeStream;
};

function restoreRawMode(
  input: NodeJS.ReadableStream,
  previous: boolean | undefined,
): void {
  if (previous === undefined) return;
  const rawInput = input as RawModeStream;
  if (rawInput.isRaw === previous || rawInput.setRawMode === undefined) return;
  try {
    rawInput.setRawMode(previous);
  } catch {
    // Inquirer has already cleaned up its readline interface. A stream that
    // rejects restoration is no longer controllable by this boundary.
  }
}

async function runPrompt<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  input: NodeJS.ReadableStream,
  queue: PromptQueue,
  eofDefault?: { value: Value },
): Promise<Value> {
  return queue.enqueue(() => runPromptNow(operation, input, eofDefault));
}

async function runPromptNow<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  input: NodeJS.ReadableStream,
  eofDefault?: { value: Value },
): Promise<Value> {
  const controller = new AbortController();
  const previousRawMode = (input as RawModeStream).isRaw;
  let ended = false;
  let explicitEof = false;
  let inputFailure: unknown;
  let rejectEnd!: (error: unknown) => void;
  let rejectAbort!: (error: unknown) => void;
  const end = new Promise<never>((_resolve, reject) => {
    rejectEnd = reject;
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    if (cancellationRequested)
      rejectAbort(new AgentChannelsError("CANCELLED", "Cancelled.", []));
  };
  const onEnd = (): void => {
    if (ended) return;
    ended = true;
    if (!cancellationRequested) controller.abort();
    rejectEnd(
      cancellationRequested
        ? new AgentChannelsError("CANCELLED", "Cancelled.", [])
        : new AgentChannelsError(
            "INPUT_EOF",
            "Required input ended before setup completed.",
            ["Rerun agentchannels init in a terminal to resume."],
          ),
    );
  };
  const onData = (chunk: unknown): void => {
    if (
      (typeof chunk === "string" && chunk.includes("\u0004")) ||
      (Buffer.isBuffer(chunk) && chunk.includes(4))
    ) {
      explicitEof = true;
      // A TTY may deliver Ctrl-D without emitting `end`. Let readline process
      // the byte first, then close the prompt if it did not do so itself.
      queueMicrotask(() => {
        if (!ended) onEnd();
      });
    }
  };
  const onError = (error: unknown): void => {
    if (ended) return;
    ended = true;
    inputFailure = error;
    controller.abort();
    rejectEnd(error);
  };
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onEnd);
  input.once("error", onError);
  controller.signal.addEventListener("abort", onAbort);
  activePrompts += 1;
  activePromptControllers.add(controller);
  let prompt: Promise<Value> | undefined;
  try {
    prompt = operation(controller.signal);
    return await Promise.race([prompt, end, aborted]);
  } catch (error) {
    if (inputFailure !== undefined) throw inputFailure;
    if (error instanceof AgentChannelsError) {
      if (error.code === "INPUT_EOF" && eofDefault !== undefined)
        return eofDefault.value;
      throw error;
    }
    if (isPromptCancellation(error)) {
      if (explicitEof) {
        if (eofDefault !== undefined) return eofDefault.value;
        throw new AgentChannelsError(
          "INPUT_EOF",
          "Required input ended before setup completed.",
          ["Rerun agentchannels init in a terminal to resume."],
          { cause: error },
        );
      }
      throw new AgentChannelsError("CANCELLED", "Cancelled.", [], {
        cause: error,
      });
    }
    throw error;
  } finally {
    // AbortPromptError cleanup closes readline and restores its own terminal
    // state asynchronously. Give that cleanup one turn before our restoration
    // runs, while still bounding non-conforming prompt implementations.
    if (prompt !== undefined)
      await Promise.race([
        prompt.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setImmediate(resolve)),
      ]);
    ended = true;
    input.removeListener("end", onEnd);
    input.removeListener("close", onEnd);
    input.removeListener("data", onData);
    input.removeListener("error", onError);
    controller.signal.removeEventListener("abort", onAbort);
    activePrompts = Math.max(0, activePrompts - 1);
    activePromptControllers.delete(controller);
    restoreRawMode(input, previousRawMode);
    if (activePrompts === 0) cancellationRequested = false;
  }
}

function toInquirerChoices<Value>(
  choices: readonly PromptChoice<Value>[],
): readonly {
  value: Value;
  name: string;
  description?: string;
}[] {
  return choices.map(({ value, label, description }) => ({
    value,
    name: label,
    ...(description === undefined ? {} : { description }),
  }));
}

export function createTerminalPromptIO(
  options: TerminalPromptOptions = {},
): PromptIO {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const prompts = options.prompts ?? defaultPrompts;
  const context = promptContext(input, output);
  const queue = new PromptQueue();

  return {
    input: (label, defaultValue) =>
      runPrompt(
        (signal) =>
          prompts.input(
            {
              message: label,
              ...(defaultValue === undefined ? {} : { default: defaultValue }),
            },
            { ...context, signal },
          ),
        input,
        queue,
        defaultValue === undefined ? undefined : { value: defaultValue },
      ),
    secret: (label) =>
      runPrompt(
        (signal) =>
          prompts.password(
            { message: label, mask: true },
            { ...context, signal },
          ),
        input,
        queue,
      ),
    confirm: (label, defaultYes) =>
      runPrompt(
        (signal) =>
          prompts.confirm(
            { message: label, default: defaultYes },
            { ...context, signal },
          ),
        input,
        queue,
        { value: defaultYes },
      ),
    select: (label, choices) =>
      runPrompt(
        (signal) =>
          prompts.select(
            { message: label, choices: toInquirerChoices(choices) },
            { ...context, signal },
          ),
        input,
        queue,
      ),
    multiSelect: (label, choices) =>
      runPrompt(
        (signal) =>
          prompts.checkbox(
            { message: label, choices: toInquirerChoices(choices) },
            { ...context, signal },
          ),
        input,
        queue,
      ),
  };
}

export const terminalPromptIO: PromptIO = createTerminalPromptIO();

export type ExternalActions = Readonly<{
  openUrl(url: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  writeArtifact(path: string, content: string): Promise<void>;
}>;

async function tryExec(
  command: string,
  args: string[],
  input?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export const systemExternalActions: ExternalActions = {
  async openUrl(url) {
    if (process.platform === "darwin") return tryExec("open", [url]);
    if (process.platform === "linux") return tryExec("xdg-open", [url]);
    if (process.platform === "win32")
      return tryExec("rundll32", ["url.dll,FileProtocolHandler", url]);
    return false;
  },
  async copyText(text) {
    if (process.platform === "darwin") return tryExec("pbcopy", [], text);
    if (process.platform === "linux") {
      if (await tryExec("wl-copy", [], text)) return true;
      return tryExec("xclip", ["-selection", "clipboard"], text);
    }
    return false;
  },
  async writeArtifact(path, content) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  },
};
