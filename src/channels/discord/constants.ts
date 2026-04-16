/**
 * Shared constants for the Discord channel adapter.
 *
 * Centralised here so that `index.ts`, `stream-handle.ts`, and
 * `rate-limit.ts` never diverge on their values.
 */

/** Discord's maximum message length in characters. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Minimum interval (ms) between successive message edits.
 *
 * Discord enforces ~5 edits per 5 seconds per channel; 1 000 ms gives
 * comfortable headroom while keeping the stream visually responsive.
 */
export const STREAM_EDIT_INTERVAL_MS = 1000;

/** Placeholder content shown while the agent is still processing. */
export const THINKING_PLACEHOLDER = "⏳ Thinking…";

/**
 * Sentinel value for the guildId field when a message comes from a DM
 * (which has no guild). Used to construct a stable session key without
 * colliding with real guild IDs.
 */
export const DM_GUILD_SENTINEL = "@dm";

/**
 * Auto-archive duration for threads created by the bot (in minutes).
 * 60 min is the shortest Discord supports; keeps the thread list tidy.
 */
export const THREAD_AUTO_ARCHIVE_MINUTES = 60;

/** Maximum Discord thread name length */
export const THREAD_NAME_MAX_LENGTH = 100;

/**
 * Default fallback cooldown (ms) applied when a 429 response does not
 * include a `retry_after` field. Matches Discord's typical per-channel
 * edit rate-limit window of 5 seconds.
 */
export const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 5000;
