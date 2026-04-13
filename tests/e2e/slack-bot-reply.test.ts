/**
 * E2E: Slack @bot mention → bot reply (Socket Mode + cassette replay)
 *
 * Sub-AC 3: Spins up BotHarness, posts a @bot mention via SlackUserClient,
 * awaits the bot reply in the thread via the polling helper, and asserts the
 * reply text matches the cassette fixture.
 *
 * ## What makes this test different from slack-bridge-e2e.test.ts
 *
 * `slack-bridge-e2e.test.ts` wires `TestSlackAdapter` in-process and calls
 * `bridge.handleMessage()` directly, bypassing Socket Mode event delivery.
 *
 * This test exercises the FULL Socket Mode path:
 *
 *   User → Slack API ──(app_mention)──▶ Socket Mode WebSocket
 *                                              │
 *                                   SlackAdapter.setupListeners()
 *                                              │
 *                                   BotHarness.onMessage callback
 *                                              │
 *                                   StreamingBridge.handleMessage()
 *                                              │
 *                                   ReplayAgentClient (cassette replay)
 *                                              │
 *                                   chat.startStream + appendStream + stopStream
 *                                              │
 *   User reads reply ◀── conversations.replies ◀── Slack thread
 *
 * All Slack API calls (posting, streaming, reading replies) are live.
 * Only the Claude Managed Agent SSE stream is replaced by the cassette replay stub.
 *
 * ## Required contributor env vars (suite auto-skips when any are missing)
 *
 *   SLACK_TEST_USER_TOKEN   xoxp- user OAuth token for posting as a Slack user
 *   SLACK_TEST_CHANNEL_ID   dedicated e2e test channel ID (C0123456789)
 *   SLACK_BOT_TOKEN         bot token (xoxb-)
 *   SLACK_APP_TOKEN         app-level token (xapp-) for Socket Mode
 *
 * ## Optional env vars (required only when recording a new cassette)
 *
 *   ANTHROPIC_API_KEY       Anthropic API key
 *   CLAUDE_AGENT_ID         Claude Managed Agent ID (optional)
 *   CLAUDE_ENVIRONMENT_ID   Claude Environment ID (optional)
 *
 * ## Record/replay behaviour
 *
 *   First run (no cassette on disk):
 *     - If ANTHROPIC_API_KEY is set: records from live Claude API and saves fixture.
 *     - Otherwise: falls back to a deterministic stub cassette (no external API calls).
 *   Subsequent runs:
 *     - Replays from the saved cassette (no Claude API calls).
 *   Force re-record:
 *     - E2E_RERECORD=true overwrites the existing cassette and re-records.
 *
 * Fixtures are stored in tests/e2e/fixtures/ (gitignored).
 * Each contributor records their own cassette on first run.
 *
 * ## Usage
 *
 *   # Replay (default — uses cassette if present, records stub on first run)
 *   pnpm vitest run tests/e2e/slack-bot-reply.test.ts
 *
 *   # Record from live Claude API (requires Anthropic creds)
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm vitest run tests/e2e/slack-bot-reply.test.ts
 *
 *   # Force re-record
 *   E2E_RERECORD=true ANTHROPIC_API_KEY=sk-ant-... pnpm vitest run tests/e2e/slack-bot-reply.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as dotenvConfig } from "dotenv";

import { isE2EEnabled, getE2EEnv, parseVaultIds } from "./helpers/env.js";
import { makeRunTag } from "./helpers/tag.js";
import {
  loadCassette,
  saveCassette,
  computeExpectedFromEvents,
  computeFullText,
  FIXTURES_DIR,
} from "./helpers/fixture-io.js";
import { BotHarness } from "./helpers/bot-harness.js";
import { SlackUserClient, type PostedMessage } from "./helpers/slack-user-client.js";
import { assertSlackThread } from "./helpers/slack-thread-assertions.js";
import { RecordingAgentClient } from "./helpers/recording-agent-client.js";

import type { BridgeResult } from "../../src/core/streaming-bridge.js";
import type { AgentStreamEvent } from "../../src/core/chunk-parser.js";
import type { Cassette } from "./helpers/types.js";

// Load .env when present (does not override already-set env vars).
// Lets contributors store Slack and Anthropic tokens in .env without exporting them.
dotenvConfig();

// ---------------------------------------------------------------------------
// Cassette scenario
// ---------------------------------------------------------------------------

/**
 * Fixture file key — determines the path under tests/e2e/fixtures/.
 * Separate from the "basic-mention" cassette used by slack-bridge-e2e.test.ts
 * so the two suites can evolve their fixtures independently.
 */
const SCENARIO = "slack-bot-reply";

// ---------------------------------------------------------------------------
// Cassette helpers
// ---------------------------------------------------------------------------

/**
 * Record a cassette by streaming from the live Claude Managed Agent API.
 *
 * Uses RecordingAgentClient to transparently capture every SSE event yielded
 * by the real AgentClient during a live session. No Slack API calls are made
 * here — recording is purely against the Anthropic API.
 *
 * Called when no fixture exists on disk and ANTHROPIC_API_KEY is present.
 */
async function recordCassetteFromAPI(tag: string): Promise<Cassette> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const agentId = process.env.CLAUDE_AGENT_ID;
  const environmentId = process.env.CLAUDE_ENVIRONMENT_ID;

  // Dynamic import so that the AgentClient (and its Anthropic SDK dependency)
  // is only loaded in record mode — replay mode never touches the real client.
  const { AgentClient } = await import("../../src/core/agent-client.js");
  const realClient = new AgentClient({
    apiKey,
    agentId,
    environmentId,
    vaultIds: parseVaultIds(),
  });

  // Wrap in RecordingAgentClient to capture the SSE event stream transparently.
  const recorder = new RecordingAgentClient(realClient);

  // Create a real session (sets recorder.capturedSessionId).
  const sessionId = await recorder.createSession();

  // Stream — RecordingAgentClient captures every yielded event to capturedEvents.
  for await (const _event of recorder.sendMessage(
    sessionId,
    `[${tag}] e2e record: say exactly "Hello from agentchannels e2e" and nothing else.`,
  )) {
    // Events are captured internally; we just drain the generator here.
  }

  const events = recorder.capturedEvents;
  const fullText = computeFullText(events);
  const { totalChars, updateCount } = computeExpectedFromEvents(events);

  return {
    tag,
    sessionId: recorder.capturedSessionId,
    events,
    expected: {
      result: { success: true, totalChars, updateCount },
      slackThread: { finalText: fullText },
    },
  };
}

/**
 * Create a deterministic stub cassette when no Anthropic API keys are present.
 *
 * The stub produces a short, fixed reply that contains the run tag so that
 * the recorded fixture is visually identifiable in the Slack channel.
 * No external API calls are made — everything is in-memory.
 */
function makeStubCassette(tag: string): Cassette {
  const stubText = `e2e-stub: hello from agentchannels [${tag}]`;
  const events: AgentStreamEvent[] = [
    { type: "text_delta", text: stubText },
    { type: "done" },
  ];
  const { totalChars, updateCount } = computeExpectedFromEvents(events);
  return {
    tag,
    sessionId: "stub-session-bot-reply",
    events,
    expected: {
      result: { success: true, totalChars, updateCount },
      slackThread: { finalText: stubText },
    },
  };
}

/**
 * Resolve the cassette for this test run.
 *
 * Priority:
 *   1. Existing fixture on disk (unless E2E_RERECORD=true)
 *   2. Live recording from Claude API (if ANTHROPIC_API_KEY is set)
 *   3. In-memory stub cassette (deterministic fallback)
 *
 * Returns whether a new cassette was created so that the caller can decide
 * whether to persist it to disk.
 */
async function resolveCassette(
  tag: string,
): Promise<{ cassette: Cassette; isNew: boolean }> {
  const forceRerecord = process.env.E2E_RERECORD === "true";

  // Replay path: load from disk when available and not forced to re-record.
  if (!forceRerecord) {
    const existing = await loadCassette(SCENARIO);
    if (existing) {
      return { cassette: existing, isNew: false };
    }
  }

  // Record / stub path: no fixture on disk (or E2E_RERECORD=true).
  if (process.env.ANTHROPIC_API_KEY) {
    // Live recording from Anthropic API.
    const cassette = await recordCassetteFromAPI(tag);
    return { cassette, isNew: true };
  }

  // Fallback: deterministic stub (no external API calls required).
  // Hint for contributors who want real Claude responses:
  console.info(
    `[slack-bot-reply] No cassette found at ${FIXTURES_DIR}/${SCENARIO}.json and ` +
      `ANTHROPIC_API_KEY is not set. Using a stub cassette.\n` +
      `To record a real fixture: set ANTHROPIC_API_KEY (and optionally ` +
      `CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID) then run:\n` +
      `  pnpm vitest run tests/e2e/slack-bot-reply.test.ts\n`,
  );
  const cassette = makeStubCassette(tag);
  return { cassette, isNew: true };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!isE2EEnabled)(
  "E2E: Slack @bot mention → bot reply (Socket Mode + cassette replay)",
  () => {
    // ── Shared state populated by beforeAll ────────────────────────────────

    /** The in-process bot harness: SlackAdapter + StreamingBridge + ReplayAgentClient */
    let harness: BotHarness;

    /** Slack user client for posting the trigger message and reading replies */
    let userClient: SlackUserClient;

    /** Loaded (or recorded) cassette fixture for this test run */
    let cassette: Cassette;

    /** Metadata about the @mention message posted to Slack */
    let postedMessage: PostedMessage;

    /** Result returned by bridge.handleMessage() after Socket Mode delivery */
    let bridgeResult: BridgeResult;

    /** Slack user ID of the bot (Uxxxxxxxx) — used to construct <@BOT> mentions */
    let botUserId: string;

    /** Unique tag embedded in the trigger message for run isolation */
    let runTag: string;

    // -----------------------------------------------------------------------
    // beforeAll — full setup and round-trip
    //
    // A single beforeAll drives one complete Slack round-trip:
    //   resolve cassette → start harness → post @mention → await bridge result
    //
    // All it() assertions below run against the shared state captured here,
    // matching the production pattern of one thread → one bot response.
    // -----------------------------------------------------------------------

    beforeAll(async () => {
      const env = getE2EEnv()!;
      runTag = makeRunTag();

      // ── Step 1: Resolve cassette (load / record / stub) ──────────────────
      //
      // In replay mode (default): load the existing fixture from disk.
      // On first run or with E2E_RERECORD=true: record from the live Claude
      // API (if ANTHROPIC_API_KEY is set) or fall back to a stub cassette.
      const { cassette: resolved, isNew } = await resolveCassette(runTag);
      cassette = resolved;

      // Persist newly created cassette so subsequent runs replay from disk.
      if (isNew) {
        await saveCassette(SCENARIO, cassette);
      }

      // ── Step 2: Spin up BotHarness ────────────────────────────────────────
      //
      // BotHarness wires together:
      //   - SlackAdapter (Socket Mode via Bolt App + WebSocket)
      //   - SessionManager (in-memory)
      //   - StreamingBridge
      //   - ReplayAgentClient (cassette-driven, no Anthropic API calls)
      //
      // Messages posted to Slack trigger app_mention events → SlackAdapter
      // → BotHarness.onMessage callback → bridge.handleMessage().
      harness = new BotHarness({ env, cassette });
      await harness.start(); // connects Socket Mode WebSocket, resolves botUserId

      // ── Step 3: Resolve bot user ID ───────────────────────────────────────
      //
      // SlackAdapter.connect() calls auth.test() and stores the result in the
      // private botUserId field. BotHarness exposes it via structural cast.
      // Required to build the <@BOTID> mention that triggers app_mention events.
      const resolvedBotUserId = harness.getBotUserId();
      if (!resolvedBotUserId) {
        throw new Error(
          "[slack-bot-reply] harness.getBotUserId() returned undefined after start().\n" +
            "This means SlackAdapter.connect() did not resolve the bot user ID.\n" +
            "Check that SLACK_BOT_TOKEN is valid and has the auth.test permission scope.",
        );
      }
      botUserId = resolvedBotUserId;

      // ── Step 4: Create SlackUserClient ────────────────────────────────────
      userClient = new SlackUserClient({
        userToken: env.SLACK_TEST_USER_TOKEN,
        channelId: env.SLACK_TEST_CHANNEL_ID,
        botUserId,
      });

      // ── Step 5: Arm bridge result listener BEFORE posting ────────────────
      //
      // CRITICAL ordering: waitForBridgeResult() MUST be called before
      // postMessage() to avoid a race condition where the Socket Mode event
      // arrives, the bridge finishes, and the Promise is never resolved because
      // we armed the listener too late.
      const resultPromise = harness.waitForBridgeResult();

      // ── Step 6: Post @bot mention as a Slack user ─────────────────────────
      //
      // The <@BOTID> mention in the text causes Slack to emit an app_mention
      // event to the bot via Socket Mode. The event is delivered to
      // SlackAdapter.setupListeners() → dispatchMessage() → BotHarness.onMessage
      // → StreamingBridge.handleMessage() → ReplayAgentClient streams cassette
      // events → chat.startStream + appendStream + stopStream in this thread.
      //
      // The run tag [runTag] is embedded in the text for per-run isolation:
      // each run's trigger message is unique and identifiable in the channel.
      const mentionText = `<@${botUserId}> [${runTag}] What is 1+1?`;
      postedMessage = await userClient.postMessage(mentionText);

      // ── Step 7: Await bridge completion ───────────────────────────────────
      //
      // Resolves when BotHarness.onMessage callback finishes bridge.handleMessage().
      // Socket Mode event delivery typically arrives within a few seconds;
      // the bridge processing (replay + Slack streaming) adds a few more.
      bridgeResult = await resultPromise;
    }, 120_000 /* 2-min timeout: Socket Mode connect + event delivery + Slack streaming */);

    // -----------------------------------------------------------------------
    // afterAll — stop harness
    // -----------------------------------------------------------------------

    afterAll(async () => {
      // abortAll() cancels in-flight bridge threads; disconnect() closes the
      // Socket Mode WebSocket gracefully. Safe to call even if start() threw.
      await harness?.stop();
    }, 15_000);

    // ── BridgeResult assertions ─────────────────────────────────────────────
    //
    // Verify that StreamingBridge.handleMessage() returned expected values.
    // In replay mode these are deterministic: ReplayAgentClient always yields
    // the same cassette event sequence, making totalChars and updateCount
    // invariant across runs.

    it("bridge result: success is true", () => {
      expect(bridgeResult.success, "bridge should succeed without error").toBe(true);
    });

    it("bridge result: sessionId matches cassette sessionId", () => {
      expect(
        bridgeResult.sessionId,
        "sessionId returned by bridge must equal the cassette's recorded session ID",
      ).toBe(cassette.sessionId);
    });

    it("bridge result: totalChars matches cassette expected total character count", () => {
      expect(
        bridgeResult.totalChars,
        `expected ${cassette.expected.result.totalChars} chars (sum of text_delta.text lengths in cassette)`,
      ).toBe(cassette.expected.result.totalChars);
    });

    it("bridge result: updateCount matches cassette expected streaming update count", () => {
      expect(
        bridgeResult.updateCount,
        `expected ${cassette.expected.result.updateCount} streaming updates (one per text_delta event)`,
      ).toBe(cassette.expected.result.updateCount);
    });

    it("bridge result: error is undefined on successful completion", () => {
      expect(bridgeResult.error, "no error should be present when bridge succeeds").toBeUndefined();
    });

    it("bridge result: sessionCreated is true (new session for new thread)", () => {
      expect(
        bridgeResult.sessionCreated,
        "first message in a thread should always create a new session",
      ).toBe(true);
    });

    // ── AC 3: Slack thread assertions ───────────────────────────────────────
    //
    // Read the live Slack thread via conversations.replies and assert:
    //   1. Exactly one bot reply is present in the thread.
    //   2. The bot reply text contains the fixture's expected final text.
    //
    // assertSlackThread() polls until at least one bot reply appears (up to
    // maxAttempts × intervalMs = 60 s), then runs the two vitest assertions
    // internally. Additional metadata checks follow.

    it(
      "conversations.replies: single bot reply present whose text matches the fixture",
      async () => {
        // expectedText is the concatenation of all text_delta.text values from
        // the cassette — exactly what ReplayAgentClient streams to Slack.
        const expectedText =
          cassette.expected.slackThread?.finalText ??
          computeFullText(cassette.events);

        const threadResult = await assertSlackThread({
          userClient,
          threadTs: postedMessage.ts,
          afterTs: postedMessage.ts,
          botUserId,
          expectedText,
          pollOptions: {
            // Poll for up to 60 s (30 × 2 s) to allow for Slack propagation lag.
            maxAttempts: 30,
            intervalMs: 2000,
          },
        });

        // assertSlackThread ran the two core vitest assertions internally:
        //   expect(botReplies).toHaveLength(1)
        //   expect(replyText).toContain(expectedText)
        //
        // Additional metadata assertions on the returned result:
        expect(
          threadResult.botReply.ts,
          "bot reply must have a Slack timestamp",
        ).toBeTruthy();

        expect(
          threadResult.botReply.ts,
          "bot reply timestamp must differ from the trigger message timestamp",
        ).not.toBe(postedMessage.ts);

        expect(
          threadResult.allBotReplies,
          "exactly one bot reply should be present — multiple would indicate a double-send bug",
        ).toHaveLength(1);
      },
      90_000 /* 90-s timeout: up to 30 × 2 s polling + Slack propagation delay */,
    );

    // ── Run isolation assertions ────────────────────────────────────────────
    //
    // Each run embeds a unique tag (timestamp + hex suffix) in the trigger
    // message text. This makes individual test runs identifiable in the shared
    // test channel and prevents cross-run reply pollution in conversations.replies.

    it("unique run tag is embedded in the trigger message text", () => {
      expect(
        postedMessage.text,
        `trigger message should contain the run tag "${runTag}"`,
      ).toContain(runTag);
    });
  },
);
