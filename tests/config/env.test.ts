import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import {
  readEnvFile,
  writeEnvFile,
  writeValidatedEnvFile,
  quoteEnvValue,
  serializeEnv,
  EnvValidationError,
} from '../../src/config/env.js';

describe('env utilities', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── quoteEnvValue ───────────────────────────────────────────────────

  describe('quoteEnvValue', () => {
    it('returns plain value when no special characters', () => {
      expect(quoteEnvValue('xoxb-123-abc')).toBe('xoxb-123-abc');
    });

    it('quotes values with spaces', () => {
      expect(quoteEnvValue('hello world')).toBe('"hello world"');
    });

    it('quotes values with hash characters', () => {
      expect(quoteEnvValue('secret#123')).toBe('"secret#123"');
    });

    it('escapes double quotes inside the value', () => {
      expect(quoteEnvValue('say "hello"')).toBe('"say \\"hello\\""');
    });

    it('escapes backslashes inside the value', () => {
      expect(quoteEnvValue('path\\to\\thing')).toBe('"path\\\\to\\\\thing"');
    });

    it('quotes values with leading whitespace', () => {
      expect(quoteEnvValue('  leading')).toBe('"  leading"');
    });

    it('quotes values with trailing whitespace', () => {
      expect(quoteEnvValue('trailing  ')).toBe('"trailing  "');
    });

    it('returns empty string as-is', () => {
      expect(quoteEnvValue('')).toBe('');
    });
  });

  // ─── serializeEnv ────────────────────────────────────────────────────

  describe('serializeEnv', () => {
    it('serializes simple key-value pairs', () => {
      const result = serializeEnv({ FOO: 'bar', BAZ: 'qux' });
      expect(result).toBe('FOO=bar\nBAZ=qux\n');
    });

    it('quotes values that need it', () => {
      const result = serializeEnv({ KEY: 'value with spaces' });
      expect(result).toBe('KEY="value with spaces"\n');
    });

    it('handles empty object', () => {
      expect(serializeEnv({})).toBe('\n');
    });
  });

  // ─── readEnvFile ─────────────────────────────────────────────────────

  describe('readEnvFile', () => {
    it('returns empty object when .env does not exist', () => {
      const result = readEnvFile(tmpDir);
      expect(result).toEqual({});
    });

    it('reads existing .env file', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nBAZ=qux\n');
      const result = readEnvFile(tmpDir);
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('reads quoted values correctly', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY="value with spaces"\n');
      const result = readEnvFile(tmpDir);
      expect(result).toEqual({ KEY: 'value with spaces' });
    });
  });

  // ─── writeEnvFile ────────────────────────────────────────────────────

  describe('writeEnvFile', () => {
    it('creates .env with given values', () => {
      const result = writeEnvFile({ KEY1: 'val1', KEY2: 'val2' }, tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
      expect(content).toContain('KEY1=val1');
      expect(content).toContain('KEY2=val2');
      expect(result.existed).toBe(false);
      expect(result.added).toEqual(['KEY1', 'KEY2']);
      expect(result.overwritten).toEqual([]);
      expect(result.totalKeys).toBe(2);
    });

    it('merges with existing .env values', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'EXISTING=keep\n');
      const result = writeEnvFile({ NEW_KEY: 'new_val' }, tmpDir);
      const parsed = readEnvFile(tmpDir);
      expect(parsed).toEqual({ EXISTING: 'keep', NEW_KEY: 'new_val' });
      expect(result.existed).toBe(true);
      expect(result.added).toEqual(['NEW_KEY']);
      expect(result.overwritten).toEqual([]);
    });

    it('overwrites existing keys and reports them', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=old\n');
      const result = writeEnvFile({ KEY: 'new' }, tmpDir);
      const parsed = readEnvFile(tmpDir);
      expect(parsed).toEqual({ KEY: 'new' });
      expect(result.overwritten).toEqual(['KEY']);
      expect(result.added).toEqual([]);
    });

    it('does not report unchanged keys as overwritten', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=same\n');
      const result = writeEnvFile({ KEY: 'same' }, tmpDir);
      expect(result.overwritten).toEqual([]);
      expect(result.added).toEqual([]);
    });

    // ─── Backup ─────────────────────────────────────────────────────

    it('creates .env.backup when overwriting existing values', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=old\n');
      const result = writeEnvFile({ KEY: 'new' }, { cwd: tmpDir });
      expect(result.backupPath).toBeDefined();
      const backup = fs.readFileSync(result.backupPath!, 'utf-8');
      expect(backup).toBe('KEY=old\n');
    });

    it('creates .env.backup when adding new values to existing file', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'OLD=val\n');
      const result = writeEnvFile({ NEW: 'val' }, { cwd: tmpDir });
      expect(result.backupPath).toBeDefined();
    });

    it('does not create backup when file does not exist yet', () => {
      const result = writeEnvFile({ KEY: 'val' }, { cwd: tmpDir });
      expect(result.backupPath).toBeUndefined();
    });

    it('does not create backup when backup option is false', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=old\n');
      const result = writeEnvFile({ KEY: 'new' }, { cwd: tmpDir, backup: false });
      expect(result.backupPath).toBeUndefined();
      expect(fs.existsSync(path.join(tmpDir, '.env.backup'))).toBe(false);
    });

    it('does not create backup when nothing changes', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'KEY=same\n');
      const result = writeEnvFile({ KEY: 'same' }, { cwd: tmpDir });
      expect(result.backupPath).toBeUndefined();
    });

    // ─── Options object API ─────────────────────────────────────────

    it('accepts options object with cwd', () => {
      writeEnvFile({ A: '1' }, { cwd: tmpDir });
      const parsed = readEnvFile(tmpDir);
      expect(parsed).toEqual({ A: '1' });
    });

    // ─── Special characters ─────────────────────────────────────────

    it('handles values with special characters round-trip', () => {
      writeEnvFile({ TOKEN: 'xoxb-123 #comment' }, tmpDir);
      const parsed = readEnvFile(tmpDir);
      expect(parsed.TOKEN).toBe('xoxb-123 #comment');
    });
  });

  // ─── writeValidatedEnvFile ──────────────────────────────────────────

  describe('writeValidatedEnvFile', () => {
    const SlackTokenSchema = z.object({
      SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'Must start with xoxb-'),
      SLACK_APP_TOKEN: z.string().startsWith('xapp-', 'Must start with xapp-'),
      SLACK_SIGNING_SECRET: z.string().min(1, 'Signing secret is required'),
    });

    it('writes .env when values pass validation', () => {
      const values = {
        SLACK_BOT_TOKEN: 'xoxb-123456789-abcdef',
        SLACK_APP_TOKEN: 'xapp-1-A1234-567-abcdef',
        SLACK_SIGNING_SECRET: 'abc123def456',
      };
      const result = writeValidatedEnvFile(values, SlackTokenSchema, tmpDir);
      expect(result.totalKeys).toBe(3);
      const parsed = readEnvFile(tmpDir);
      expect(parsed.SLACK_BOT_TOKEN).toBe('xoxb-123456789-abcdef');
    });

    it('throws EnvValidationError when values fail validation', () => {
      const values = {
        SLACK_BOT_TOKEN: 'invalid-token',
        SLACK_APP_TOKEN: 'xapp-valid-token-here',
        SLACK_SIGNING_SECRET: '',
      };
      expect(() =>
        writeValidatedEnvFile(values, SlackTokenSchema, tmpDir),
      ).toThrow(EnvValidationError);

      // .env should NOT be written
      expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
    });

    it('EnvValidationError contains structured issues', () => {
      const values = {
        SLACK_BOT_TOKEN: 'bad',
        SLACK_APP_TOKEN: 'bad',
        SLACK_SIGNING_SECRET: '',
      };
      try {
        writeValidatedEnvFile(values, SlackTokenSchema, tmpDir);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        const validationErr = err as EnvValidationError;
        expect(validationErr.issues.length).toBeGreaterThanOrEqual(2);
        expect(validationErr.issues.some((i) => i.key === 'SLACK_BOT_TOKEN')).toBe(true);
      }
    });

    it('merges validated values with existing .env', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'OTHER_KEY=keep\n');

      const values = {
        SLACK_BOT_TOKEN: 'xoxb-123456789-abcdef',
        SLACK_APP_TOKEN: 'xapp-1-A1234-567-abcdef',
        SLACK_SIGNING_SECRET: 'abc123def456',
      };
      writeValidatedEnvFile(values, SlackTokenSchema, tmpDir);

      const parsed = readEnvFile(tmpDir);
      expect(parsed.OTHER_KEY).toBe('keep');
      expect(parsed.SLACK_BOT_TOKEN).toBe('xoxb-123456789-abcdef');
    });
  });
});
