import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type {
  checkbox as inquirerCheckbox,
  confirm as inquirerConfirm,
  input as inquirerInput,
  password as inquirerPassword,
  select as inquirerSelect,
} from "@inquirer/prompts";
import {
  createTerminalPromptIO,
  requestPromptCancellation,
  type TerminalPromptOptions,
} from "../src/cli/io.ts";

type PromptFunctions = NonNullable<TerminalPromptOptions["prompts"]>;

function promptDouble(
  overrides: Partial<PromptFunctions> = {},
): PromptFunctions {
  return {
    input: ((config) =>
      Promise.resolve(config.default ?? "answer")) as typeof inquirerInput,
    password: (() =>
      Promise.resolve("secret")) as unknown as typeof inquirerPassword,
    confirm: ((config) =>
      Promise.resolve(config.default ?? false)) as typeof inquirerConfirm,
    select: ((config) => {
      const choice = config.choices[0];
      if (
        typeof choice === "string" ||
        choice === undefined ||
        !("value" in choice)
      )
        throw new Error("test choice is missing a value");
      return Promise.resolve(choice.value);
    }) as typeof inquirerSelect,
    checkbox: ((config) => {
      const choice = config.choices[0];
      if (
        typeof choice === "string" ||
        choice === undefined ||
        !("value" in choice)
      )
        throw new Error("test choice is missing a value");
      return Promise.resolve([choice.value]);
    }) as typeof inquirerCheckbox,
    ...overrides,
  };
}

function streams() {
  return { input: new PassThrough(), output: new PassThrough() };
}

type TtyStream = PassThrough & {
  isTTY: true;
  isRaw: boolean;
  columns: number;
  rows: number;
  setRawMode(mode: boolean): TtyStream;
};

function ttyStreams() {
  const input = new PassThrough() as TtyStream;
  const output = new PassThrough() as TtyStream;
  input.isTTY = true;
  output.isTTY = true;
  input.columns = 80;
  input.rows = 24;
  output.columns = 80;
  output.rows = 24;
  let raw = false;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    raw = mode;
    input.isRaw = mode;
    return input;
  };
  return {
    input,
    output,
    isRaw: () => raw,
  };
}

describe("terminal PromptIO", () => {
  it("forwards defaults, hidden passwords, confirmations, and typed choices", async () => {
    const calls: Record<string, unknown> = {};
    const prompts = promptDouble({
      input: ((config) => {
        calls.input = config;
        return Promise.resolve(config.default ?? "answer");
      }) as typeof inquirerInput,
      password: ((config) => {
        calls.password = config;
        return Promise.resolve("secret");
      }) as typeof inquirerPassword,
      confirm: ((config) => {
        calls.confirm = config;
        return Promise.resolve(config.default ?? false);
      }) as typeof inquirerConfirm,
      select: ((config) => {
        calls.select = config;
        return Promise.resolve("linear");
      }) as typeof inquirerSelect,
      checkbox: ((config) => {
        calls.checkbox = config;
        return Promise.resolve(["slack"]);
      }) as typeof inquirerCheckbox,
    });
    const io = createTerminalPromptIO({ ...streams(), prompts });

    await expect(io.input("Name", "project")).resolves.toBe("project");
    await expect(io.secret("Token")).resolves.toBe("secret");
    await expect(io.confirm("Continue", true)).resolves.toBe(true);
    await expect(
      io.select("Connector", [
        { value: "slack", label: "Slack", description: "HTTP events" },
        { value: "linear", label: "Linear" },
      ]),
    ).resolves.toBe("linear");
    await expect(
      io.multiSelect("Connectors", [
        { value: "slack", label: "Slack" },
        { value: "linear", label: "Linear" },
      ]),
    ).resolves.toEqual(["slack"]);

    expect(calls.input).toMatchObject({ message: "Name", default: "project" });
    expect(calls.password).toMatchObject({ message: "Token", mask: true });
    expect(calls.confirm).toMatchObject({ message: "Continue", default: true });
    expect(calls.select).toMatchObject({
      message: "Connector",
      choices: [
        { value: "slack", name: "Slack", description: "HTTP events" },
        { value: "linear", name: "Linear" },
      ],
    });
    expect(calls.checkbox).toMatchObject({
      message: "Connectors",
      choices: [
        { value: "slack", name: "Slack" },
        { value: "linear", name: "Linear" },
      ],
    });
  });

  it("maps Inquirer cancellation to CANCELLED and removes input listeners", async () => {
    const streamsForTest = streams();
    const cancel = async (): Promise<string> => {
      const error = new Error("Ctrl-C");
      error.name = "ExitPromptError";
      throw error;
    };
    const io = createTerminalPromptIO({
      ...streamsForTest,
      prompts: promptDouble({
        input: cancel as unknown as typeof inquirerInput,
      }),
    });

    await expect(io.input("Name")).rejects.toMatchObject({
      code: "CANCELLED",
      exitCode: 130,
    });
    expect(streamsForTest.input.listenerCount("end")).toBe(0);
    expect(streamsForTest.input.listenerCount("close")).toBe(0);
  });

  it("preserves prompt exceptions and cleans up after them", async () => {
    const streamsForTest = streams();
    const failure = new Error("provider prompt failed");
    const io = createTerminalPromptIO({
      ...streamsForTest,
      prompts: promptDouble({
        input: (async () => {
          throw failure;
        }) as unknown as typeof inquirerInput,
      }),
    });

    await expect(io.input("Name")).rejects.toBe(failure);
    expect(streamsForTest.input.listenerCount("end")).toBe(0);
    expect(streamsForTest.input.listenerCount("close")).toBe(0);
  });

  it("turns stdin end into INPUT_EOF without leaving cleanup listeners", async () => {
    const streamsForTest = streams();
    const io = createTerminalPromptIO({
      ...streamsForTest,
      prompts: promptDouble({
        input: (() =>
          new Promise<string>(
            () => undefined,
          )) as unknown as typeof inquirerInput,
      }),
    });

    const pending = io.input("Required value");
    streamsForTest.input.emit("end");
    await expect(pending).rejects.toMatchObject({
      code: "INPUT_EOF",
      exitCode: 9,
    });
    expect(streamsForTest.input.listenerCount("end")).toBe(0);
    expect(streamsForTest.input.listenerCount("close")).toBe(0);
  });

  it("uses an input default when stdin ends", async () => {
    const streamsForTest = streams();
    const io = createTerminalPromptIO({
      ...streamsForTest,
      prompts: promptDouble({
        input: (() =>
          new Promise<string>(
            () => undefined,
          )) as unknown as typeof inquirerInput,
      }),
    });
    const pending = io.input("Name", "repository");
    streamsForTest.input.emit("end");
    await expect(pending).resolves.toBe("repository");
  });

  it("uses a confirmation default when stdin ends", async () => {
    const streamsForTest = streams();
    const io = createTerminalPromptIO({
      ...streamsForTest,
      prompts: promptDouble({
        confirm: (() =>
          new Promise<boolean>(
            () => undefined,
          )) as unknown as typeof inquirerConfirm,
      }),
    });
    const pending = io.confirm("Continue", true);
    streamsForTest.input.emit("end");
    await expect(pending).resolves.toBe(true);
  });

  it("does not hang on input stream errors", async () => {
    const streamsForTest = streams();
    const failure = new Error("stdin failed");
    const io = createTerminalPromptIO({
      ...streamsForTest,
      prompts: promptDouble({
        input: (() =>
          new Promise<string>(
            () => undefined,
          )) as unknown as typeof inquirerInput,
      }),
    });
    const pending = io.input("Name");
    streamsForTest.input.emit("error", failure);
    await expect(pending).rejects.toBe(failure);
    expect(streamsForTest.input.listenerCount("error")).toBe(0);
  });

  it("serializes concurrent prompts and restores an already-raw terminal", async () => {
    const tty = ttyStreams();
    tty.input.setRawMode(true);
    const resolvers: Array<(value: string) => void> = [];
    const calls: string[] = [];
    const prompts = promptDouble({
      input: ((config) => {
        calls.push(config.message);
        return new Promise<string>((resolve) => resolvers.push(resolve));
      }) as typeof inquirerInput,
    });
    const io = createTerminalPromptIO({ ...tty, prompts });
    const first = io.input("First");
    const second = io.input("Second");
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["First"]);
    resolvers[0]?.("one");
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["First", "Second"]);
    resolvers[1]?.("two");
    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
    expect(tty.isRaw()).toBe(true);
  });

  it("runs input, secret, and confirmation key paths on a TTY", async () => {
    const tty = ttyStreams();
    const output: string[] = [];
    tty.output.on("data", (chunk: Buffer | string) =>
      output.push(chunk.toString()),
    );
    const io = createTerminalPromptIO(tty);

    const name = io.input("Name");
    setImmediate(() => tty.input.write("Alice\r"));
    await expect(name).resolves.toBe("Alice");

    const secret = io.secret("Token");
    setImmediate(() => tty.input.write("hidden-token\r"));
    await expect(secret).resolves.toBe("hidden-token");

    const accepted = io.confirm("Continue", false);
    setImmediate(() => tty.input.write("y\r"));
    await expect(accepted).resolves.toBe(true);

    expect(output.join("")).not.toContain("hidden-token");
    expect(tty.isRaw()).toBe(false);
  });

  it("cancels queued prompts together with the active prompt", async () => {
    const streamsForTest = streams();
    const prompts = promptDouble({
      input: (() =>
        new Promise<string>(
          () => undefined,
        )) as unknown as typeof inquirerInput,
    });
    const io = createTerminalPromptIO({ ...streamsForTest, prompts });
    const active = io.input("Active");
    const queued = io.input("Queued");
    const activeResult = expect(active).rejects.toMatchObject({
      code: "CANCELLED",
    });
    const queuedResult = expect(queued).rejects.toMatchObject({
      code: "CANCELLED",
    });
    requestPromptCancellation();
    await activeResult;
    await queuedResult;
  });

  it("uses arrow and Enter for select, and Space and Enter for checkbox", async () => {
    const selectStreams = ttyStreams();
    const selected = createTerminalPromptIO(selectStreams).select("Connector", [
      { value: "slack", label: "Slack" },
      { value: "linear", label: "Linear" },
    ]);
    setImmediate(() => selectStreams.input.write("\u001b[B\r"));
    await expect(selected).resolves.toBe("linear");
    expect(selectStreams.isRaw()).toBe(false);

    const checkboxStreams = ttyStreams();
    const checked = createTerminalPromptIO(checkboxStreams).multiSelect(
      "Connectors",
      [
        { value: "slack", label: "Slack" },
        { value: "linear", label: "Linear" },
      ],
    );
    setImmediate(() => checkboxStreams.input.write(" \u001b[B \r"));
    await expect(checked).resolves.toEqual(["slack", "linear"]);
    expect(checkboxStreams.isRaw()).toBe(false);
  });
});
