import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { redactSensitiveText } from "./security/redact.ts";

export type LogLevel = "info" | "warn" | "error";

export type Logger = Readonly<{
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}>;

export type LoggerOptions = Readonly<{
  /** Append to this file as well as the stream, with rotation. */
  file?: string;
  stream?: NodeJS.WritableStream;
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
}>;

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 3;

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Move `daemon.log` aside once it grows past the limit, keeping a few generations.
 *
 * The service definitions redirect the daemon's output to a file with `append`,
 * which never truncates. Without this the log grows for as long as the daemon
 * runs, which on a long-lived installation means indefinitely.
 */
function rotate(path: string, maxBytes: number, keep: number): void {
  if (sizeOf(path) < maxBytes) return;
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${String(index)}`, `${path}.${String(index + 1)}`);
    } catch {
      // A generation that does not exist yet needs no rotation.
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // Losing the race with another writer is not worth failing a log line for.
  }
}

/**
 * The daemon's log.
 *
 * Lines are timestamped and levelled because they are read after the fact, out
 * of a file, when something has already gone wrong. Every line is redacted: this
 * is an output path like any other.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const stream = options.stream ?? process.stderr;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? DEFAULT_KEEP;
  const now = options.now ?? (() => new Date());
  if (options.file !== undefined)
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });

  const write = (level: LogLevel, message: string): void => {
    const line = `${now().toISOString()} ${level} ${redactSensitiveText(message)}\n`;
    stream.write(line);
    if (options.file === undefined) return;
    rotate(options.file, maxBytes, keep);
    try {
      appendFileSync(options.file, line, { mode: 0o600 });
    } catch {
      // The stream already carries the line; a full disk must not stop the daemon.
    }
  };

  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
