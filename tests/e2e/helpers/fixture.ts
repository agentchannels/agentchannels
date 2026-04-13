/**
 * Fixture loader utility for cassette-based E2E tests (Sub-AC 10c).
 *
 * Reads a {@link CassetteFixtureSchema} fixture file from disk, validates it
 * against the schema, parses the raw SSE event array into `AgentStreamEvent[]`,
 * and exposes both the event array and the `expectedSlackThread` for use in
 * replay stubs and assertion helpers.
 *
 * ## Architecture
 *
 * Cassette fixtures use the {@link CassetteFixtureSchema} format (defined in
 * `fixture-schema.ts`) where SSE events are stored in **raw wire format**
 * (`RawSSEEvent[]` — each entry has an `event` name string and a `data` JSON
 * payload object).  Storing raw events rather than pre-parsed `AgentStreamEvent`
 * values has three benefits:
 *
 *   1. **No information loss** — the full SSE payload is preserved verbatim.
 *   2. **Parser evolution** — future improvements to `parseSSEEvent()` are
 *      automatically exercised when replaying existing cassettes; cassettes
 *      never need re-recording just because the parser improved.
 *   3. **Schema independence** — the on-disk format is not coupled to the
 *      `AgentStreamEvent` discriminated-union shape, so it can survive parser
 *      refactors.
 *
 * This loader bridges the disk format to the in-memory types expected by the
 * rest of the E2E suite:
 *
 * | Consumer              | Field used                          |
 * |-----------------------|-------------------------------------|
 * | `ReplayAgentClient`   | `events` (`AgentStreamEvent[]`)     |
 * | `assertSlackThread`   | `expectedSlackThread.finalText`     |
 * | BridgeResult checks   | `sessionId` + `cassette.expectedSlackThread` |
 *
 * ## Usage
 *
 * ```ts
 * import { loadFixture } from "./fixture.js";
 * import { ReplayAgentClient } from "./replay-agent-client.js";
 * import { computeFullText } from "./fixture-io.js";
 *
 * const fixture = await loadFixture("basic-mention");
 *
 * if (!fixture) {
 *   // No cassette on disk → enter record mode (auto record-on-miss, AC 5)
 * } else {
 *   // Replay mode — drive the SSE stream from the cassette
 *   const replayClient = new ReplayAgentClient(fixture.sessionId, fixture.events);
 *
 *   // AC 3 assertion: the expected Slack thread state
 *   const expectedText =
 *     fixture.expectedSlackThread?.finalText ?? computeFullText(fixture.events);
 * }
 * ```
 *
 * ## Fixture file location
 *
 * Fixtures are stored under `tests/e2e/fixtures/<scenario>.json`.
 * That directory is **gitignored** — each contributor records their own fixtures
 * on first run and replays from disk on subsequent runs.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCassetteFixtureSchema,
  CASSETTE_SCHEMA_VERSION,
  type CassetteFixtureSchema,
  type RawSSEEvent,
  type ExpectedSlackThread,
} from "./fixture-schema.js";
import {
  parseSSEEvent,
  type AgentStreamEvent,
} from "../../../src/core/chunk-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Absolute path to the fixtures directory (`tests/e2e/fixtures/`).
 *
 * This directory is gitignored — each contributor records their own cassettes
 * on first run.  The path is derived from this file's location so it stays
 * correct even when the test tree is moved or symlinked.
 */
export const FIXTURES_DIR = join(__dirname, "..", "fixtures");

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path for a fixture file given its scenario name.
 *
 * @param scenario  Kebab-case scenario identifier, e.g. `"basic-mention"`
 * @returns         Absolute path to `tests/e2e/fixtures/<scenario>.json`
 *
 * @example
 * ```ts
 * fixturePath("basic-mention");
 * // → "/path/to/tests/e2e/fixtures/basic-mention.json"
 * ```
 */
export function fixturePath(scenario: string): string {
  return join(FIXTURES_DIR, `${scenario}.json`);
}

// ---------------------------------------------------------------------------
// LoadedFixture — primary return type
// ---------------------------------------------------------------------------

/**
 * The fully loaded, validated, and parsed result of reading a cassette fixture.
 *
 * All fields are derived from the validated {@link CassetteFixtureSchema}:
 *
 * - `cassette`              — the full raw fixture (for direct schema access)
 * - `events`                — parsed `AgentStreamEvent[]` (for replay stubs)
 * - `expectedSlackThread`   — expected Slack thread state (for AC 3 assertions)
 * - `sessionId`             — replay session ID (for BridgeResult assertions)
 * - `scenario`              — kebab-case scenario name
 * - `tag`                   — unique run-isolation tag from recording
 * - `recordedAt`            — ISO 8601 timestamp of when the fixture was recorded
 *
 * ## Consumer guide
 *
 * **Replay stub (`ReplayAgentClient`):**
 * ```ts
 * new ReplayAgentClient(fixture.sessionId, fixture.events)
 * ```
 *
 * **AC 3 Slack thread assertions (`assertSlackThread`):**
 * ```ts
 * const expectedText = fixture.expectedSlackThread?.finalText
 *   ?? computeFullText(fixture.events);
 *
 * await assertSlackThread({ userClient, threadTs, afterTs, expectedText });
 * ```
 *
 * **AC 2 BridgeResult assertions:**
 * ```ts
 * const { totalChars, updateCount } = computeExpectedFromEvents(fixture.events);
 * expect(bridgeResult.sessionId).toBe(fixture.sessionId);
 * expect(bridgeResult.totalChars).toBe(totalChars);
 * ```
 */
export interface LoadedFixture {
  /**
   * The raw validated {@link CassetteFixtureSchema} fixture as stored on disk.
   *
   * Available for cases where direct access to the raw `RawSSEEvent[]` array
   * or other schema-level metadata is needed.  Most consumers should prefer
   * the processed `events` field over `cassette.events` (raw format).
   */
  cassette: CassetteFixtureSchema;

  /**
   * Parsed `AgentStreamEvent[]` derived from the raw SSE events in the fixture.
   *
   * Each `RawSSEEvent.data` object is passed through `parseSSEEvent()` from
   * `chunk-parser.ts`.  Parsing stops after the first **terminal** event
   * (one of `session.status_idle`, `session.status_terminated`, `session.error`,
   * `session.deleted`) so the sequence faithfully mirrors a live SSE stream.
   *
   * Ready for direct use with `ReplayAgentClient`:
   * ```ts
   * new ReplayAgentClient(fixture.sessionId, fixture.events)
   * ```
   */
  events: AgentStreamEvent[];

  /**
   * Expected final state of the Slack thread after `StreamingBridge` completes.
   *
   * Loaded directly from `cassette.expectedSlackThread`.  `undefined` when the
   * cassette was recorded before this field was introduced (cassettes remain
   * valid — backward-compatible).
   *
   * ### AC 3 assertion pattern
   *
   * ```ts
   * const expectedText =
   *   fixture.expectedSlackThread?.finalText ?? computeFullText(fixture.events);
   *
   * await assertSlackThread({
   *   userClient,
   *   threadTs,
   *   afterTs: threadTs,
   *   expectedText,
   * });
   * ```
   *
   * When `messages` is present (freshly recorded cassettes), assertion helpers
   * can additionally verify bot message count and block types.
   */
  expectedSlackThread: ExpectedSlackThread | undefined;

  /**
   * The Claude Managed Agent session ID from the recording run.
   *
   * Returned by `ReplayAgentClient.createSession()` so that
   * `BridgeResult.sessionId` is stable and assertable across replay runs
   * without making any live Anthropic API call.
   */
  sessionId: string;

  /**
   * Kebab-case scenario identifier — matches the fixture file's base name.
   *
   * Example: `"basic-mention"` for `fixtures/basic-mention.json`.
   */
  scenario: string;

  /**
   * Unique run-isolation tag embedded in the Slack trigger message during recording.
   *
   * Format: `e2e-{15 digits}-{8 hex chars}` (generated by `makeRunTag()`).
   * Stored for traceability — links each cassette to the Slack message that
   * produced it.
   */
  tag: string;

  /**
   * ISO 8601 UTC timestamp of when this fixture was recorded.
   *
   * Example: `"2026-04-13T12:00:00.000Z"`.
   * Informational only — staleness is not enforced automatically.
   */
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// parseRawEvents — RawSSEEvent[] → AgentStreamEvent[]
// ---------------------------------------------------------------------------

/**
 * Parse an array of raw SSE events into the `AgentStreamEvent` discriminated union.
 *
 * Implements the replay contract documented in {@link CassetteFixtureSchema}:
 *
 * ```ts
 * for (const raw of cassette.events) {
 *   const { events, terminal } = parseSSEEvent(raw.data);
 *   for (const e of events) yield e;
 *   if (terminal) return;
 * }
 * ```
 *
 * This function executes that loop and collects the yielded events into an array.
 *
 * ## Terminal event handling
 *
 * Parsing stops after the first raw event whose `parseSSEEvent()` result has
 * `terminal: true`.  This means the returned array contains all events up to
 * and including the terminal event's parsed form (e.g. `{ type: "done", ... }`),
 * matching the behaviour of a live SSE stream.
 *
 * ## Round-trip integrity
 *
 * Because raw events are parsed at replay time (not at record time), any future
 * improvement to `parseSSEEvent()` is automatically reflected in existing
 * cassettes — cassettes do not need to be re-recorded when the parser evolves.
 *
 * @param rawEvents  Array of raw SSE wire events from the cassette fixture
 * @returns          Typed `AgentStreamEvent[]`, stopping after the first terminal event
 *
 * @example
 * ```ts
 * // Directly parse a fixture's raw events:
 * const events = parseRawEvents(cassette.events);
 *
 * // Equivalent to the events field on a LoadedFixture:
 * const fixture = await loadFixture("basic-mention");
 * expect(fixture?.events).toEqual(parseRawEvents(fixture!.cassette.events));
 * ```
 */
export function parseRawEvents(rawEvents: RawSSEEvent[]): AgentStreamEvent[] {
  const result: AgentStreamEvent[] = [];

  for (const raw of rawEvents) {
    const { events, terminal } = parseSSEEvent(raw.data);

    for (const event of events) {
      result.push(event);
    }

    // Stop after the first terminal event — mirrors the live SSE stream behaviour
    // and the replay contract in CassetteFixtureSchema.
    if (terminal) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// loadFixture — primary API
// ---------------------------------------------------------------------------

/**
 * Load, validate, and parse a cassette fixture file by scenario name.
 *
 * ## Return value
 *
 * - Returns `null` when the fixture file does not exist — this is the signal
 *   for the test to enter **record mode** (auto record-on-miss, AC 5).
 * - Returns a {@link LoadedFixture} when the file exists and is valid.
 * - **Throws** when the file exists but cannot be read, contains invalid JSON,
 *   or does not conform to {@link CassetteFixtureSchema}.
 *
 * ## Error messages
 *
 * Version mismatches produce a specific error message with re-record instructions:
 * ```
 * loadFixture: fixture at "..." has schema version 0, but current version is 1.
 * Please re-record: E2E_RERECORD=true pnpm vitest run tests/e2e/slack-bridge-e2e.test.ts
 * ```
 *
 * @param scenario  Kebab-case scenario name, e.g. `"basic-mention"`
 * @returns         Loaded and parsed fixture, or `null` if no fixture exists
 * @throws          If the file exists but is invalid, unreadable, or fails schema validation
 *
 * @example
 * ```ts
 * const fixture = await loadFixture("basic-mention");
 *
 * if (!fixture) {
 *   // No cassette → record mode
 *   const recorder = new RecordingAgentClient(realAgentClient);
 *   // ... run bridge, then save cassette ...
 * } else {
 *   // Replay mode
 *   const replayClient = new ReplayAgentClient(fixture.sessionId, fixture.events);
 *   const expectedText = fixture.expectedSlackThread?.finalText ?? "";
 * }
 * ```
 */
export async function loadFixture(scenario: string): Promise<LoadedFixture | null> {
  const path = fixturePath(scenario);
  return loadFixtureFromPath(path, scenario);
}

// ---------------------------------------------------------------------------
// loadFixtureFromPath — low-level API (explicit path)
// ---------------------------------------------------------------------------

/**
 * Load, validate, and parse a cassette fixture file from an explicit absolute path.
 *
 * Unlike {@link loadFixture}, this accepts an explicit file path rather than
 * deriving it from a scenario name.  Useful for:
 *
 * - Tests that write fixtures to temporary directories
 * - Custom fixture roots outside `tests/e2e/fixtures/`
 * - Parameterised fixture loading in shared test helpers
 *
 * ## Behaviour
 *
 * - Returns `null` when the file does not exist.
 * - Throws on read errors, malformed JSON, or schema validation failures.
 *
 * @param path      Absolute path to the fixture JSON file
 * @param scenario  Optional scenario label for error messages; defaults to `path`
 * @returns         Loaded and parsed fixture, or `null` if the file does not exist
 * @throws          If the file exists but is invalid or cannot be read
 *
 * @example
 * ```ts
 * // Load from a custom path (e.g. in a temporary directory during tests):
 * const fixture = await loadFixtureFromPath("/tmp/my-cassette.json", "custom");
 * ```
 */
export async function loadFixtureFromPath(
  path: string,
  scenario?: string,
): Promise<LoadedFixture | null> {
  // ── Step 1: existence check ────────────────────────────────────────────────
  // Missing fixture → return null so the caller enters record mode (not an error).
  if (!existsSync(path)) {
    return null;
  }

  // ── Step 2: read the file ──────────────────────────────────────────────────
  let rawText: string;
  try {
    rawText = await readFile(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `loadFixture: cannot read fixture at "${path}": ${msg}`,
    );
  }

  // ── Step 3: parse JSON ─────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `loadFixture: fixture at "${path}" contains invalid JSON: ${msg}`,
    );
  }

  // ── Step 4: schema validation ──────────────────────────────────────────────
  if (!isCassetteFixtureSchema(parsed)) {
    // Provide a version-specific error when the version field is present but wrong.
    // This is the most common failure mode after a schema migration.
    const maybeObj =
      parsed != null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const storedVersion = maybeObj?.["version"];

    if (storedVersion !== undefined && storedVersion !== CASSETTE_SCHEMA_VERSION) {
      throw new Error(
        `loadFixture: fixture at "${path}" has schema version ${String(storedVersion)}, ` +
          `but the current schema version is ${CASSETTE_SCHEMA_VERSION}.\n` +
          `Please re-record the fixture:\n` +
          `  E2E_RERECORD=true pnpm vitest run tests/e2e/slack-bridge-e2e.test.ts`,
      );
    }

    // Generic validation failure — missing or mistyped required fields.
    throw new Error(
      `loadFixture: fixture at "${path}" does not conform to CassetteFixtureSchema ` +
        `(expected version: ${CASSETTE_SCHEMA_VERSION}).\n` +
        `Required fields: version, scenario, recordedAt, sessionId, tag, events[].\n` +
        `Please re-record the fixture:\n` +
        `  E2E_RERECORD=true pnpm vitest run tests/e2e/slack-bridge-e2e.test.ts`,
    );
  }

  // ── Step 5: parse raw SSE events → AgentStreamEvent[] ─────────────────────
  // Executes the replay contract: pass each RawSSEEvent.data through parseSSEEvent()
  // and stop after the first terminal event.
  const events = parseRawEvents(parsed.events);

  // ── Step 6: assemble and return LoadedFixture ──────────────────────────────
  return {
    cassette: parsed,
    events,
    expectedSlackThread: parsed.expectedSlackThread,
    sessionId: parsed.sessionId,
    // Use the caller-supplied scenario label when available, falling back to the
    // value embedded in the cassette itself (self-describing fixture design).
    scenario: scenario ?? parsed.scenario,
    tag: parsed.tag,
    recordedAt: parsed.recordedAt,
  };
}
