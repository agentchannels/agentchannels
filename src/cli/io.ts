import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";

import { CliError } from "./errors.js";

export type PromptIO = Readonly<{
  input(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
  confirm(label: string, defaultYes: boolean): Promise<boolean>;
}>;

function inputClosed(error: unknown): never {
  throw new CliError(
    "INPUT_EOF",
    "Required input ended before setup completed.",
    ["Rerun agentchannels init in a terminal to resume."],
    { cause: error },
  );
}

export const terminalPromptIO: PromptIO = {
  async input(label, defaultValue) {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
      const answer = (await terminal.question(`${label}${suffix}:\n> `)).trim();
      return answer === "" && defaultValue !== undefined
        ? defaultValue
        : answer;
    } catch (error) {
      return inputClosed(error);
    } finally {
      terminal.close();
    }
  },
  async secret(label) {
    process.stdout.write(`${label}:\n> `);
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const terminal = createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });
    try {
      return (await terminal.question("")).trim();
    } catch (error) {
      return inputClosed(error);
    } finally {
      terminal.close();
      process.stdout.write("\n");
    }
  },
  async confirm(label, defaultYes) {
    const answer = await terminalPromptIO.input(
      `${label} ${defaultYes ? "[Y/n]" : "[y/N]"}`,
    );
    if (answer === "") return defaultYes;
    return /^(y|yes)$/i.test(answer);
  },
};

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
