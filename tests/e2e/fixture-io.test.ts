/**
 * Unit tests for fixture-io helpers — AC 7: force rerecord via E2E_RERECORD=true
 *
 * Verifies:
 *   1. shouldForceRerecord() correctly reads the E2E_RERECORD environment variable.
 *   2. saveCassette() creates a fixture that loadCassette() can subsequently load.
 *   3. saveCassette() OVERWRITES an existing fixture when called again (the core
 *      AC 7 behaviour — the old cassette content is fully replaced).
 *   4. The complete E2E_RERECORD=true integration pattern produces the expected
 *      file overwrite end-to-end (cassette bypass → record → overwrite).
 *
 * These tests exercise only the local filesystem I/O layer and do NOT require
 * any Slack or Anthropic credentials.  They run unconditionally alongside the
 * rest of the unit-test suite (pnpm test).
 *
 * The test scenario "__unit_test_rerecord__" is used as an ephemeral fixture
 * name.  Each test suite cleans it up in afterEach so the fixtures/ directory
 * is left in a clean state after the suite exits (pass or fail).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  loadCassette,
  saveCassette,
  shouldForceRerecord,
  fixturePath,
} from "./helpers/fixture-io.js";
import type { Cassette } from "./helpers/types.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/** Minimal valid cassette — simulates a "previous run" fixture. */
const CASSETTE_V1: Cassette = {
  tag: "v1-2025-01-01-aabbcc",
  sessionId: "session-v1-xxxxxxxx",
  events: [
    { type: "text_delta", text: "Hello from v1." },
    { type: "done", stopReason: "end_turn" },
  ],
  expected: {
    result: { success: true, totalChars: 14, updateCount: 1 },
    slackThread: { finalText: "Hello from v1." },
  },
};

/** Cassette that represents a fresh re-recording (v2 content replaces v1). */
const CASSETTE_V2: Cassette = {
  tag: "v2-2025-06-01-ddeeff",
  sessionId: "session-v2-yyyyyyyy",
  events: [
    { type: "thinking", text: "Let me compute this." },
    { type: "text_delta", text: "The answer is 2." },
    { type: "done", stopReason: "end_turn" },
  ],
  expected: {
    result: { success: true, totalChars: 16, updateCount: 1 },
    slackThread: { finalText: "The answer is 2." },
  },
};

/** A complex cassette with multiple event types for round-trip integrity checks. */
const CASSETTE_COMPLEX: Cassette = {
  tag: "complex-2025-06-01-ffaabb",
  sessionId: "session-complex-zzzzzzzz",
  events: [
    { type: "thinking", text: "Analyzing the question..." },
    { type: "tool_use", name: "bash", input: { command: "echo hi" } },
    { type: "tool_result", name: "bash", toolUseId: "tool-1" },
    { type: "text_delta", text: "Here is the result: " },
    { type: "text_delta", text: "42." },
    { type: "done", stopReason: "end_turn" },
  ],
  expected: {
    result: { success: true, totalChars: 23, updateCount: 2 },
    slackThread: { finalText: "Here is the result: 42." },
  },
};

/** Ephemeral scenario name — used only during this test file's lifecycle. */
const TEST_SCENARIO = "__unit_test_rerecord__";

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

async function cleanupTestFixture(): Promise<void> {
  const path = fixturePath(TEST_SCENARIO);
  if (existsSync(path)) {
    await rm(path);
  }
}

// ---------------------------------------------------------------------------
// AC 7 Part 1 — shouldForceRerecord() reads E2E_RERECORD correctly
// ---------------------------------------------------------------------------

describe("shouldForceRerecord()", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    // Snapshot the current value so we can restore it unconditionally in afterEach.
    savedEnv = process.env["E2E_RERECORD"];
  });

  afterEach(() => {
    // Always restore the original env state, whether the test passed or not.
    if (savedEnv === undefined) {
      delete process.env["E2E_RERECORD"];
    } else {
      process.env["E2E_RERECORD"] = savedEnv;
    }
  });

  it("returns false when E2E_RERECORD is not set", () => {
    delete process.env["E2E_RERECORD"];
    expect(shouldForceRerecord()).toBe(false);
  });

  it("returns true when E2E_RERECORD is exactly 'true'", () => {
    process.env["E2E_RERECORD"] = "true";
    expect(shouldForceRerecord()).toBe(true);
  });

  it("returns false when E2E_RERECORD is 'false'", () => {
    process.env["E2E_RERECORD"] = "false";
    expect(shouldForceRerecord()).toBe(false);
  });

  it("returns false when E2E_RERECORD is '1' (only exact 'true' triggers rerecord)", () => {
    process.env["E2E_RERECORD"] = "1";
    expect(shouldForceRerecord()).toBe(false);
  });

  it("returns false when E2E_RERECORD is 'TRUE' (case-sensitive check)", () => {
    process.env["E2E_RERECORD"] = "TRUE";
    expect(shouldForceRerecord()).toBe(false);
  });

  it("returns false when E2E_RERECORD is an empty string", () => {
    process.env["E2E_RERECORD"] = "";
    expect(shouldForceRerecord()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC 7 Part 2 — saveCassette() overwrites existing fixture on disk
// ---------------------------------------------------------------------------

describe("saveCassette() overwrite behaviour", () => {
  beforeEach(cleanupTestFixture);
  afterEach(cleanupTestFixture);

  it("loadCassette() returns null when no fixture file exists yet", async () => {
    const result = await loadCassette(TEST_SCENARIO);
    expect(result).toBeNull();
  });

  it("saveCassette() creates a fixture file that loadCassette() can read back", async () => {
    await saveCassette(TEST_SCENARIO, CASSETTE_V1);

    const loaded = await loadCassette(TEST_SCENARIO);
    expect(loaded).toEqual(CASSETTE_V1);
  });

  it("saveCassette() called a second time OVERWRITES the existing fixture", async () => {
    // First write — simulates a previous recording run.
    await saveCassette(TEST_SCENARIO, CASSETTE_V1);
    const afterFirstWrite = await loadCassette(TEST_SCENARIO);
    expect(afterFirstWrite?.sessionId).toBe(CASSETTE_V1.sessionId);

    // Second write — simulates E2E_RERECORD=true overwriting the old fixture.
    await saveCassette(TEST_SCENARIO, CASSETTE_V2);
    const afterSecondWrite = await loadCassette(TEST_SCENARIO);

    // The new content must be present…
    expect(afterSecondWrite?.sessionId).toBe(CASSETTE_V2.sessionId);
    expect(afterSecondWrite?.tag).toBe(CASSETTE_V2.tag);
    expect(afterSecondWrite?.events).toEqual(CASSETTE_V2.events);

    // …and the old content must be gone.
    expect(afterSecondWrite?.sessionId).not.toBe(CASSETTE_V1.sessionId);
    expect(afterSecondWrite?.tag).not.toBe(CASSETTE_V1.tag);
  });

  it("overwritten fixture preserves full JSON structure without data loss", async () => {
    // Write a simple fixture first.
    await saveCassette(TEST_SCENARIO, CASSETTE_V1);

    // Overwrite with a complex multi-event cassette.
    await saveCassette(TEST_SCENARIO, CASSETTE_COMPLEX);

    // Every field of the complex cassette must survive the round-trip.
    const loaded = await loadCassette(TEST_SCENARIO);
    expect(loaded).toEqual(CASSETTE_COMPLEX);
    expect(loaded?.events).toHaveLength(CASSETTE_COMPLEX.events.length);
    expect(loaded?.expected.result.totalChars).toBe(
      CASSETTE_COMPLEX.expected.result.totalChars,
    );
  });
});

// ---------------------------------------------------------------------------
// AC 7 Part 3 — End-to-end integration of the E2E_RERECORD=true pattern
//
// Replicates the exact conditional logic used in slack-bridge-e2e.test.ts
// so that any future change to the integration pattern is also reflected here.
// ---------------------------------------------------------------------------

describe("E2E_RERECORD=true integration pattern (AC 7 end-to-end)", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env["E2E_RERECORD"];
    await cleanupTestFixture();
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env["E2E_RERECORD"];
    } else {
      process.env["E2E_RERECORD"] = savedEnv;
    }
    await cleanupTestFixture();
  });

  it("E2E_RERECORD=true: existing cassette is bypassed and then overwritten", async () => {
    // ── Setup: a fixture from a previous run exists on disk ─────────────────
    await saveCassette(TEST_SCENARIO, CASSETTE_V1);
    const preExisting = await loadCassette(TEST_SCENARIO);
    expect(preExisting?.sessionId).toBe(CASSETTE_V1.sessionId);

    // ── Step 1: set E2E_RERECORD=true ────────────────────────────────────────
    process.env["E2E_RERECORD"] = "true";
    expect(shouldForceRerecord()).toBe(true);

    // ── Step 2: existing cassette is ignored (not loaded) ────────────────────
    // This mirrors the line in slack-bridge-e2e.test.ts:
    //   const existingCassette = shouldForceRerecord() ? null : await loadCassette(SCENARIO);
    const existingCassette = shouldForceRerecord()
      ? null
      : await loadCassette(TEST_SCENARIO);

    expect(existingCassette).toBeNull(); // Bypassed despite being present on disk.

    // ── Step 3: recording happens (simulated with CASSETTE_V2) ───────────────
    // In the real suite a RecordingAgentClient streams from the live Claude API.
    const recordedCassette = CASSETTE_V2;

    // ── Step 4: cassette is saved unconditionally when rerecording ──────────
    // This mirrors the condition in slack-bridge-e2e.test.ts:
    //   if (!existingCassette || shouldForceRerecord()) { await saveCassette(...); }
    if (!existingCassette || shouldForceRerecord()) {
      await saveCassette(TEST_SCENARIO, recordedCassette);
    }

    // ── Step 5: verify the fixture was overwritten with the fresh recording ──
    const reloaded = await loadCassette(TEST_SCENARIO);
    expect(reloaded?.sessionId).toBe(CASSETTE_V2.sessionId);
    expect(reloaded?.tag).toBe(CASSETTE_V2.tag);
    expect(reloaded?.events).toEqual(CASSETTE_V2.events);
    // The old v1 content must no longer be present.
    expect(reloaded?.sessionId).not.toBe(CASSETTE_V1.sessionId);
  });

  it("without E2E_RERECORD: existing cassette is loaded and NOT overwritten", async () => {
    // ── Setup: a fixture from a previous run exists on disk ─────────────────
    await saveCassette(TEST_SCENARIO, CASSETTE_V1);

    // ── E2E_RERECORD is absent → replay mode ────────────────────────────────
    delete process.env["E2E_RERECORD"];
    expect(shouldForceRerecord()).toBe(false);

    // Existing cassette is loaded normally.
    const existingCassette = shouldForceRerecord()
      ? null
      : await loadCassette(TEST_SCENARIO);

    expect(existingCassette).not.toBeNull();
    expect(existingCassette?.sessionId).toBe(CASSETTE_V1.sessionId);

    // The save-guard condition evaluates to false → cassette is NOT overwritten.
    // (!existingCassette || shouldForceRerecord()) → (false || false) = false
    if (!existingCassette || shouldForceRerecord()) {
      // This block must NOT execute in replay mode.
      await saveCassette(TEST_SCENARIO, CASSETTE_V2);
    }

    // Fixture on disk is still v1 — untouched.
    const reloaded = await loadCassette(TEST_SCENARIO);
    expect(reloaded?.sessionId).toBe(CASSETTE_V1.sessionId);
    expect(reloaded?.tag).toBe(CASSETTE_V1.tag);
  });

  it("without cassette AND without E2E_RERECORD: auto-records and saves on first run", async () => {
    // No pre-existing fixture on disk.
    expect(await loadCassette(TEST_SCENARIO)).toBeNull();

    delete process.env["E2E_RERECORD"];
    expect(shouldForceRerecord()).toBe(false);

    // existingCassette is null because no file exists.
    const existingCassette = shouldForceRerecord()
      ? null
      : await loadCassette(TEST_SCENARIO);

    expect(existingCassette).toBeNull();

    // The save-guard: (!existingCassette || shouldForceRerecord()) → (true || false) = true
    if (!existingCassette || shouldForceRerecord()) {
      await saveCassette(TEST_SCENARIO, CASSETTE_V1); // Initial record.
    }

    // Fixture was written for the first time.
    const loaded = await loadCassette(TEST_SCENARIO);
    expect(loaded?.sessionId).toBe(CASSETTE_V1.sessionId);
  });
});
