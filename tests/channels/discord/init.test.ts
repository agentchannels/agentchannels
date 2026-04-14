import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initDiscord,
  validateDiscordBotToken,
  validateDiscordApplicationId,
  validateDiscordPublicKey,
  validateDiscordBotTokenViaApi,
  type DiscordInitOptions,
} from '../../../src/channels/discord/init.js';

// ────────────────────────── Mocks ──────────────────────────

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../../src/config/env.js', () => ({
  writeEnvFile: vi.fn().mockReturnValue({
    envPath: '/tmp/test/.env',
    existed: false,
    added: ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY'],
    overwritten: [],
    totalKeys: 3,
  }),
}));

import { input, confirm } from '@inquirer/prompts';
import { writeEnvFile } from '../../../src/config/env.js';

// ────────────────────────── Fixtures ──────────────────────────

/** A valid Discord bot token (three dot-separated segments, 59+ chars) */
const VALID_BOT_TOKEN =
  'NzkyNzE1NDU0MTk2MDg4ODQy.X-hvzA.Gy5SIVnSwhpwdRRnQTa24tKx8g';

/** A valid Discord snowflake application ID */
const VALID_APPLICATION_ID = '912345678901234567';

/** A valid Discord public key (64-char hex) */
const VALID_PUBLIC_KEY = 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567';

/** Reusable mock Discord API validator (returns success by default) */
const mockApiValidator = vi.fn().mockResolvedValue({ valid: true, username: 'TestBot#1234' });

// ────────────────────────── Helpers ──────────────────────────

/**
 * Build DiscordInitOptions with the mock API validator wired in.
 * Prevents live Discord API calls in all tests.
 */
function makeOpts(extra: Partial<DiscordInitOptions> = {}): DiscordInitOptions {
  return { discordApiValidator: mockApiValidator, ...extra };
}

/**
 * Set up mocks for the happy-path guided flow.
 *
 * confirm() is called multiple times during the wizard:
 *   1. "Application created — ready to add a bot?"
 *   2. "Intents enabled and saved — ready to copy the bot token?"
 *   3. "Bot invited to your server — ready to save credentials?"
 *   4. "Save these credentials to .env file?"
 *
 * input() is called for:
 *   1. Bot token
 *   2. Application ID
 *   3. Public Key
 */
function setupHappyPath(
  opts: { applicationId?: string; publicKey?: string; saveToEnv?: boolean } = {},
) {
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(input)
    .mockResolvedValueOnce(VALID_BOT_TOKEN)                              // bot token
    .mockResolvedValueOnce(opts.applicationId ?? VALID_APPLICATION_ID)  // application ID
    .mockResolvedValueOnce(opts.publicKey ?? VALID_PUBLIC_KEY);         // public key

  if (opts.saveToEnv === false) {
    // Last confirm (save to .env?) returns false
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)   // step 1
      .mockResolvedValueOnce(true)   // step 2
      .mockResolvedValueOnce(true)   // step 3
      .mockResolvedValueOnce(false); // save to .env
  }
}

// ────────────────────────── validateDiscordBotToken ──────────────────────────

describe('validateDiscordBotToken', () => {
  it('accepts a valid Discord bot token', () => {
    expect(validateDiscordBotToken(VALID_BOT_TOKEN)).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(validateDiscordBotToken('')).toBeTypeOf('string');
    expect(validateDiscordBotToken('   ')).toBeTypeOf('string');
  });

  it('rejects a token that is too short', () => {
    const result = validateDiscordBotToken('short.token');
    expect(result).toBeTypeOf('string');
  });

  it('rejects a token without three dot-separated segments', () => {
    // Only two segments
    const twoSeg = 'NzkyNzE1NDU0MTk2MDg4ODQy.Gy5SIVnSwhpwdRRnQTa24tKx8gGy5SIVnS';
    const result = validateDiscordBotToken(twoSeg);
    expect(result).toBeTypeOf('string');
  });

  it('accepts a token with exactly three segments of sufficient length', () => {
    // Construct a 3-part token that passes the length check
    const longToken = 'A'.repeat(20) + '.' + 'B'.repeat(6) + '.' + 'C'.repeat(27);
    expect(validateDiscordBotToken(longToken)).toBe(true);
  });
});

// ────────────────────────── validateDiscordApplicationId ──────────────────────────

describe('validateDiscordApplicationId', () => {
  it('accepts a valid snowflake ID', () => {
    expect(validateDiscordApplicationId(VALID_APPLICATION_ID)).toBe(true);
  });

  it('returns true for empty string (field is optional)', () => {
    expect(validateDiscordApplicationId('')).toBe(true);
    expect(validateDiscordApplicationId('   ')).toBe(true);
  });

  it('rejects a non-numeric value', () => {
    expect(validateDiscordApplicationId('not-a-snowflake')).toBeTypeOf('string');
  });

  it('rejects an ID that is too short (< 17 digits)', () => {
    expect(validateDiscordApplicationId('1234567890')).toBeTypeOf('string');
  });

  it('rejects an ID that is too long (> 20 digits)', () => {
    expect(validateDiscordApplicationId('123456789012345678901')).toBeTypeOf('string');
  });

  it('accepts a 20-digit snowflake', () => {
    expect(validateDiscordApplicationId('12345678901234567890')).toBe(true);
  });
});

// ────────────────────────── validateDiscordPublicKey ──────────────────────────

describe('validateDiscordPublicKey', () => {
  it('accepts a valid 64-char hex public key', () => {
    expect(validateDiscordPublicKey(VALID_PUBLIC_KEY)).toBe(true);
  });

  it('returns true for empty string (field is optional)', () => {
    expect(validateDiscordPublicKey('')).toBe(true);
    expect(validateDiscordPublicKey('   ')).toBe(true);
  });

  it('rejects a key that is too short', () => {
    const shortKey = 'deadbeef1234';
    expect(validateDiscordPublicKey(shortKey)).toBeTypeOf('string');
  });

  it('rejects a key that is too long (> 64 chars)', () => {
    const longKey = 'a'.repeat(65);
    expect(validateDiscordPublicKey(longKey)).toBeTypeOf('string');
  });

  it('rejects a key containing non-hex characters', () => {
    // Replace last char with 'z' which is not valid hex
    const badKey = VALID_PUBLIC_KEY.slice(0, 63) + 'z';
    expect(validateDiscordPublicKey(badKey)).toBeTypeOf('string');
  });

  it('accepts keys with uppercase hex characters', () => {
    const upperKey = VALID_PUBLIC_KEY.toUpperCase();
    expect(validateDiscordPublicKey(upperKey)).toBe(true);
  });
});

// ────────────────────────── validateDiscordBotTokenViaApi ──────────────────────────

describe('validateDiscordBotTokenViaApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns valid: true with username on a 200 response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ username: 'MyBot', id: '123' }),
    } as Response);

    const result = await validateDiscordBotTokenViaApi(VALID_BOT_TOKEN);
    expect(result.valid).toBe(true);
    expect(result.username).toBe('MyBot');
    expect(fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/users/@me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bot ${VALID_BOT_TOKEN}`,
        }),
      }),
    );
  });

  it('returns valid: false with error on a 401 response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: '401: Unauthorized' }),
    } as Response);

    const result = await validateDiscordBotTokenViaApi('bad.token.here');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns valid: false with HTTP status on non-200/non-401 response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await validateDiscordBotTokenViaApi(VALID_BOT_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns valid: false with error message on network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validateDiscordBotTokenViaApi(VALID_BOT_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

// ────────────────────────── initDiscord ──────────────────────────

describe('initDiscord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiValidator.mockResolvedValue({ valid: true, username: 'TestBot#1234' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Happy path ────────────────────────────────────────────────

  it('completes the guided flow and returns bot token, application ID, and public key', async () => {
    setupHappyPath();

    const result = await initDiscord(makeOpts({ skipEnvWrite: true, cwd: '/tmp/test' }));

    expect(result.botToken).toBe(VALID_BOT_TOKEN);
    expect(result.applicationId).toBe(VALID_APPLICATION_ID);
    expect(result.publicKey).toBe(VALID_PUBLIC_KEY);
    expect(result.envWritten).toBe(false);
  });

  it('returns envWritten: true when credentials are saved to .env', async () => {
    setupHappyPath();

    const result = await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(result.envWritten).toBe(true);
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ DISCORD_BOT_TOKEN: VALID_BOT_TOKEN }),
      '/tmp/test',
    );
  });

  it('includes DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY in .env when both provided', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({
        DISCORD_BOT_TOKEN: VALID_BOT_TOKEN,
        DISCORD_APPLICATION_ID: VALID_APPLICATION_ID,
        DISCORD_PUBLIC_KEY: VALID_PUBLIC_KEY,
      }),
      '/tmp/test',
    );
  });

  it('omits DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY from .env when both skipped', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(input)
      .mockResolvedValueOnce(VALID_BOT_TOKEN) // bot token
      .mockResolvedValueOnce('')              // application ID skipped
      .mockResolvedValueOnce('');             // public key skipped

    const result = await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(result.applicationId).toBeUndefined();
    expect(result.publicKey).toBeUndefined();
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.not.objectContaining({
        DISCORD_APPLICATION_ID: expect.anything(),
        DISCORD_PUBLIC_KEY: expect.anything(),
      }),
      '/tmp/test',
    );
  });

  it('includes only DISCORD_APPLICATION_ID when public key is skipped', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(input)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APPLICATION_ID)
      .mockResolvedValueOnce(''); // public key skipped

    const result = await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(result.applicationId).toBe(VALID_APPLICATION_ID);
    expect(result.publicKey).toBeUndefined();
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ DISCORD_APPLICATION_ID: VALID_APPLICATION_ID }),
      '/tmp/test',
    );
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.not.objectContaining({ DISCORD_PUBLIC_KEY: expect.anything() }),
      '/tmp/test',
    );
  });

  // ── Env file skipping ─────────────────────────────────────────

  it('does not call writeEnvFile when skipEnvWrite is true', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ skipEnvWrite: true, cwd: '/tmp/test' }));

    expect(writeEnvFile).not.toHaveBeenCalled();
  });

  it('does not write .env when user declines the save prompt', async () => {
    setupHappyPath({ saveToEnv: false });

    const result = await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(result.envWritten).toBe(false);
    expect(writeEnvFile).not.toHaveBeenCalled();
  });

  // ── Prompt call counts ────────────────────────────────────────

  it('calls input() exactly three times: bot token, application ID, and public key', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ skipEnvWrite: true }));

    expect(vi.mocked(input)).toHaveBeenCalledTimes(3);
  });

  it('calls confirm() at least three times for wizard steps', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ skipEnvWrite: true }));

    expect(vi.mocked(confirm).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('calls confirm() four times when skipEnvWrite is false (includes save prompt)', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(4);
  });

  // ── Default cwd ───────────────────────────────────────────────

  it('uses process.cwd() when no cwd option is provided', async () => {
    setupHappyPath();

    await initDiscord(makeOpts());

    // writeEnvFile should be called with process.cwd() as the path
    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ DISCORD_BOT_TOKEN: VALID_BOT_TOKEN }),
      process.cwd(),
    );
  });

  // ── API validation ────────────────────────────────────────────

  it('calls the discordApiValidator with the collected bot token', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ skipEnvWrite: true }));

    expect(mockApiValidator).toHaveBeenCalledOnce();
    expect(mockApiValidator).toHaveBeenCalledWith(VALID_BOT_TOKEN);
  });

  it('logs validation success with the bot username', async () => {
    setupHappyPath();
    mockApiValidator.mockResolvedValue({ valid: true, username: 'AwesomeBot' });

    const consoleSpy = vi.spyOn(console, 'log');
    await initDiscord(makeOpts({ skipEnvWrite: true }));

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('AwesomeBot');
    expect(allOutput).toContain('Token valid');
  });

  it('logs a warning when API validation fails but continues the wizard', async () => {
    setupHappyPath();
    mockApiValidator.mockResolvedValue({
      valid: false,
      error: 'Invalid token — Discord returned 401 Unauthorized',
    });

    const consoleSpy = vi.spyOn(console, 'log');
    const result = await initDiscord(makeOpts({ skipEnvWrite: true }));

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('validation warning');
    // Wizard continues despite the failure
    expect(result.botToken).toBe(VALID_BOT_TOKEN);
  });

  it('falls back gracefully when API is unreachable', async () => {
    setupHappyPath();
    mockApiValidator.mockResolvedValue({
      valid: false,
      error: 'Could not reach Discord API: ECONNREFUSED',
    });

    const consoleSpy = vi.spyOn(console, 'log');
    // Should not throw
    const result = await initDiscord(makeOpts({ skipEnvWrite: true }));

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('validation warning');
    expect(result.botToken).toBe(VALID_BOT_TOKEN);
  });

  // ── Token validation integration ──────────────────────────────

  it('the bot token prompt validator rejects a short/bad token', async () => {
    vi.mocked(confirm).mockResolvedValue(true);

    vi.mocked(input).mockImplementationOnce(async (opts) => {
      if (typeof opts.validate === 'function') {
        const bad = opts.validate('bad');
        expect(bad).toBeTypeOf('string'); // should return error message
      }
      return VALID_BOT_TOKEN;
    });
    vi.mocked(input)
      .mockResolvedValueOnce(VALID_APPLICATION_ID)
      .mockResolvedValueOnce(VALID_PUBLIC_KEY);

    const result = await initDiscord(makeOpts({ skipEnvWrite: true }));
    expect(result.botToken).toBe(VALID_BOT_TOKEN);
  });

  // ── Application ID validation integration ────────────────────

  it('the application ID prompt validator rejects non-numeric IDs', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(input).mockResolvedValueOnce(VALID_BOT_TOKEN);

    vi.mocked(input).mockImplementationOnce(async (opts) => {
      if (typeof opts.validate === 'function') {
        const bad = opts.validate('not-a-snowflake');
        expect(bad).toBeTypeOf('string');

        const empty = opts.validate('');
        expect(empty).toBe(true); // empty = skip, which is allowed

        const valid = opts.validate(VALID_APPLICATION_ID);
        expect(valid).toBe(true);
      }
      return VALID_APPLICATION_ID;
    });
    vi.mocked(input).mockResolvedValueOnce(VALID_PUBLIC_KEY);

    const result = await initDiscord(makeOpts({ skipEnvWrite: true }));
    expect(result.applicationId).toBe(VALID_APPLICATION_ID);
  });

  // ── Public key validation integration ────────────────────────

  it('the public key prompt validator rejects non-hex / wrong-length strings', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(input)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce(VALID_APPLICATION_ID);

    vi.mocked(input).mockImplementationOnce(async (opts) => {
      if (typeof opts.validate === 'function') {
        const tooShort = opts.validate('deadbeef');
        expect(tooShort).toBeTypeOf('string');

        const notHex = opts.validate('z'.repeat(64));
        expect(notHex).toBeTypeOf('string');

        const empty = opts.validate('');
        expect(empty).toBe(true); // empty = skip, which is allowed

        const valid = opts.validate(VALID_PUBLIC_KEY);
        expect(valid).toBe(true);
      }
      return VALID_PUBLIC_KEY;
    });

    const result = await initDiscord(makeOpts({ skipEnvWrite: true }));
    expect(result.publicKey).toBe(VALID_PUBLIC_KEY);
  });

  // ── Invite URL generation ─────────────────────────────────────

  it('generates an invite URL containing the application ID when provided', async () => {
    setupHappyPath();

    const consoleSpy = vi.spyOn(console, 'log');

    await initDiscord(makeOpts({ skipEnvWrite: true }));

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain(VALID_APPLICATION_ID);
    expect(allOutput).toContain('discord.com/api/oauth2/authorize');
  });

  it('shows manual permission instructions when application ID is skipped', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(input)
      .mockResolvedValueOnce(VALID_BOT_TOKEN)
      .mockResolvedValueOnce('')   // no application ID
      .mockResolvedValueOnce('');  // no public key

    const consoleSpy = vi.spyOn(console, 'log');

    await initDiscord(makeOpts({ skipEnvWrite: true }));

    const allOutput = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toContain('OAuth2 → URL Generator');
  });

  // ── Env var name assertions ───────────────────────────────────

  it('writes DISCORD_APPLICATION_ID (not DISCORD_CLIENT_ID) to .env', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ DISCORD_APPLICATION_ID: VALID_APPLICATION_ID }),
      '/tmp/test',
    );
    // Must NOT use the old DISCORD_CLIENT_ID key
    expect(writeEnvFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ DISCORD_CLIENT_ID: expect.anything() }),
      expect.anything(),
    );
  });

  it('writes DISCORD_PUBLIC_KEY to .env when public key is provided', async () => {
    setupHappyPath();

    await initDiscord(makeOpts({ cwd: '/tmp/test' }));

    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ DISCORD_PUBLIC_KEY: VALID_PUBLIC_KEY }),
      '/tmp/test',
    );
  });
});
