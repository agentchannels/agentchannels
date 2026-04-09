import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import type { z } from 'zod';

/**
 * Load .env file from the current working directory if it exists
 */
export function loadEnvFile(cwd: string = process.cwd()): void {
  const envPath = path.resolve(cwd, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

/**
 * Read existing .env file as key-value pairs
 */
export function readEnvFile(cwd: string = process.cwd()): Record<string, string> {
  const envPath = path.resolve(cwd, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  return parsed;
}

/**
 * Determine if a .env value needs quoting.
 * Values containing spaces, quotes, #, newlines, or leading/trailing whitespace
 * are wrapped in double quotes with inner quotes escaped.
 */
export function quoteEnvValue(value: string): string {
  const needsQuoting = /[\s"'#\\]/.test(value) || value !== value.trim();
  if (!needsQuoting) {
    return value;
  }
  // Escape backslashes first, then double quotes
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Serialize key-value pairs into .env file content.
 */
export function serializeEnv(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
      .join('\n') + '\n'
  );
}

/**
 * Options for writeEnvFile
 */
export interface WriteEnvFileOptions {
  /** Working directory containing the .env file (defaults to process.cwd()) */
  cwd?: string;
  /** Create a .env.backup before overwriting an existing file (default: true) */
  backup?: boolean;
}

/**
 * Write key-value pairs to .env file, merging with existing values.
 *
 * - Merges new values with any existing .env entries (new values win on conflict)
 * - Backs up the existing .env to .env.backup before overwriting (unless backup: false)
 * - Properly quotes values that contain special characters
 *
 * @returns Object with metadata about the write operation
 */
export function writeEnvFile(
  values: Record<string, string>,
  cwdOrOptions?: string | WriteEnvFileOptions,
): WriteEnvFileResult {
  const opts: WriteEnvFileOptions =
    typeof cwdOrOptions === 'string' ? { cwd: cwdOrOptions } : cwdOrOptions ?? {};
  const cwd = opts.cwd ?? process.cwd();
  const shouldBackup = opts.backup ?? true;

  const envPath = path.resolve(cwd, '.env');
  const existed = fs.existsSync(envPath);
  const existing = readEnvFile(cwd);
  const merged = { ...existing, ...values };

  // Determine which keys were overwritten vs newly added
  const overwritten: string[] = [];
  const added: string[] = [];
  for (const key of Object.keys(values)) {
    if (key in existing && existing[key] !== values[key]) {
      overwritten.push(key);
    } else if (!(key in existing)) {
      added.push(key);
    }
  }

  // Back up existing file if it had content and we're about to modify it
  let backupPath: string | undefined;
  if (existed && shouldBackup && (overwritten.length > 0 || added.length > 0)) {
    backupPath = envPath + '.backup';
    fs.copyFileSync(envPath, backupPath);
  }

  const content = serializeEnv(merged);
  fs.writeFileSync(envPath, content, 'utf-8');

  return {
    envPath,
    existed,
    added,
    overwritten,
    backupPath,
    totalKeys: Object.keys(merged).length,
  };
}

/**
 * Result metadata from a writeEnvFile operation
 */
export interface WriteEnvFileResult {
  /** Absolute path to the .env file */
  envPath: string;
  /** Whether a .env file existed before writing */
  existed: boolean;
  /** Keys that were newly added */
  added: string[];
  /** Keys that were overwritten with different values */
  overwritten: string[];
  /** Path to the backup file, if one was created */
  backupPath?: string;
  /** Total number of keys in the resulting .env file */
  totalKeys: number;
}

/**
 * Validation error from writeValidatedEnvFile
 */
export class EnvValidationError extends Error {
  constructor(
    public readonly issues: Array<{ key: string; message: string }>,
  ) {
    const details = issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n');
    super(`Environment variable validation failed:\n${details}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate a set of key-value pairs against a Zod schema, then write to .env.
 *
 * The schema should validate the *values object* directly (e.g., z.object({ SLACK_BOT_TOKEN: z.string().startsWith('xoxb-') })).
 *
 * @throws {EnvValidationError} if validation fails
 * @returns WriteEnvFileResult with metadata about the write
 */
export function writeValidatedEnvFile<T extends z.ZodTypeAny>(
  values: Record<string, string>,
  schema: T,
  cwdOrOptions?: string | WriteEnvFileOptions,
): WriteEnvFileResult {
  const result = schema.safeParse(values);
  if (!result.success) {
    const issues = result.error.issues.map((issue: z.core.$ZodIssue) => ({
      key: issue.path.join('.') || 'unknown',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }
  return writeEnvFile(values, cwdOrOptions);
}
