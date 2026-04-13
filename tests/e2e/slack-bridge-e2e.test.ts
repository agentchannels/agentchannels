/**
 * E2E test suite: Slack ↔ StreamingBridge with cassette replay
 *
 * Architecture:
 *   - Slack round-trips are ALWAYS live (real @slack/web-api calls)
 *   - Claude Managed Agent SSE stream is record/replayed via cassette fixtures
 *   - All components wired in-process (no `ach serve` child process)
 *
 * Required contributor env vars (suite skips when missing):
 *   SLACK_TEST_USER_TOKEN  – xoxp- user token for posting as a Slack user
 *   SLACK_TEST_CHANNEL_ID  – ID of the dedicated e2e test channel
 *   SLACK_BOT_TOKEN        – Bot token (xoxb-)
 *   SLACK_APP_TOKEN        – App-level token (xapp-) [currently unused for send-only tests]
 *
 * Additional vars required only when recording a new cassette:
 *   ANTHROPIC_API_KEY      – Anthropic API key
 *   CLAUDE_AGENT_ID        – Claude Managed Agent ID
 *   CLAUDE_ENVIRONMENT_ID  – Claude Environment ID
 *
 * Run normally (uses cassette if present, records on first run):
 *   pnpm vitest run tests/e2e/slack-bridge-e2e.test.ts
 *
 * Force re-record (overwrites existing cassette):
 *   E2E_RERECORD=true pnpm vitest run tests/e2e/slack-bridge-e2e.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";
import { WebClient } from "@slack/web-api";

import { isE2EEnabled, getE2EEnv, parseVaultIds } from "./helpers/env.js";
import { makeRunTag } from "./helpers/tag.js";
import {
  loadCassette,
  saveCassette,
  computeExpectedFromEvents,
  computeFullText,
  computeExpectedPlanTasks,
  fixturePath,
  FIXTURES_DIR,
} from "./helpers/fixture-io.js";
import { ReplayAgentClient } from "./helpers/replay-agent-client.js";
import { RecordingAgentClient } from "./helpers/recording-agent-client.js";
import { TestSlackAdapter } from "./helpers/test-slack-adapter.js";

import { SessionManager } from "../../src/core/session-manager.js";
import { StreamingBridge } from "../../src/core/streaming-bridge.js";
import { AgentClient } from "../../src/core/agent-client.js";
import type { BridgeResult } from "../../src/core/streaming-bridge.js";
import type { ChannelMessage } from "../../src/core/channel-adapter.js";
import type { Cassette } from "./helpers/types.js";

// Load .env file if present (does not override already-set env vars).
// This allows contributors to store Slack and Anthropic tokens in .env.
dotenvConfig();

// ---------------------------------------------------------------------------
// Test scenario name — used as the cassette filename key
// ---------------------------------------------------------------------------

const SCENARIO = "basic-mention";

// ---------------------------------------------------------------------------
// Suite: skipped when contributor env vars are absent
// ---------------------------------------------------------------------------

describe.skipIf(!isE2EEnabled)(
  "E2E: Slack ↔ StreamingBridge (cassette replay)",
  () => {
    // Shared state populated by beforeAll, consumed by each assertion block
    let bridgeResult: BridgeResult;
    let cassette: Cassette;
    let adapter: TestSlackAdapter;
    let channelId: string;
    let messageTs: string;
    /** True when the cassette was recorded live in this run (vs. loaded from disk) */
    let wasRecorded = false;

    // -----------------------------------------------------------------------
    // beforeAll: post Slack message → load/record cassette → run bridge
    // -----------------------------------------------------------------------

    beforeAll(async () => {
      const env = getE2EEnv()!;
      channelId = env.SLACK_TEST_CHANNEL_ID;
      const tag = makeRunTag();

      // ── Step 1: Post message as a Slack user ─────────────────────────────
      // Use the xoxp- user token so the message appears to come from a real user.
      // The message text includes the unique tag for run isolation (AC 8).
      const userClient = new WebClient(env.SLACK_TEST_USER_TOKEN);

      const [userAuthResult, postResult] = await Promise.all([
        userClient.auth.test({ token: env.SLACK_TEST_USER_TOKEN }),
        (userClient.chat as unknown as Record<string, Function>)["postMessage"]({
          channel: channelId,
          text: `e2e-test [${tag}] What is 1+1?`,
        }),
      ]);

      const userId = (userAuthResult.user_id ?? "") as string;
      messageTs = (postResult as Record<string, unknown>)["ts"] as string;

      // ── Step 2: Load cassette or enter record mode ────────────────────────
      const shouldRerecord = process.env.E2E_RERECORD === "true";
      const existingCassette =
        shouldRerecord ? null : await loadCassette(SCENARIO);

      let agentClientForBridge: ReplayAgentClient | RecordingAgentClient;

      if (existingCassette && !shouldRerecord) {
        // ── REPLAY mode: drive Claude SSE stream from cassette ────────────
        cassette = existingCassette;
        agentClientForBridge = new ReplayAgentClient(
          cassette.sessionId,
          cassette.events,
        );
      } else {
        // ── RECORD mode: stream from live Claude Managed Agent ────────────
        if (!process.env.ANTHROPIC_API_KEY) {
          throw new Error(
            `No cassette found for scenario "${SCENARIO}" and ANTHROPIC_API_KEY is not set.\n` +
            `To record on first run, also set:\n` +
            `  ANTHROPIC_API_KEY, CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID\n` +
            `Cassette path: ${FIXTURES_DIR}/${SCENARIO}.json`,
          );
        }

        const realClient = new AgentClient({
          apiKey: process.env.ANTHROPIC_API_KEY,
          agentId: process.env.CLAUDE_AGENT_ID,
          environmentId: process.env.CLAUDE_ENVIRONMENT_ID,
          vaultIds: parseVaultIds(),
        });

        agentClientForBridge = new RecordingAgentClient(realClient);
        wasRecorded = true;
      }

      // ── Step 3: Wire in-process bridge ───────────────────────────────────
      // TestSlackAdapter makes live Slack API calls (startStream, appendStream, etc.)
      // ReplayAgentClient / RecordingAgentClient replaces the Claude SSE stream
      adapter = new TestSlackAdapter(env.SLACK_BOT_TOKEN);
      await adapter.connect();

      const sessionManager = new SessionManager();

      // TestSlackAdapter implements ChannelAdapter; both replay/recording clients
      // implement the two methods StreamingBridge+SessionOutputReader actually call
      // (createSession + sendMessage), so cast the minimal stubs to AgentClient.
      const bridge = new StreamingBridge({
        adapter,
        agentClient: agentClientForBridge as unknown as AgentClient,
        sessionManager,
      });

      // Construct the ChannelMessage from the posted Slack message
      const message: ChannelMessage = {
        id: messageTs,
        channelId,
        threadId: messageTs, // top-level message — becomes its own thread root
        userId,
        text: `e2e-test [${tag}] What is 1+1?`,
        isMention: true,
        isDirectMessage: false,
      };

      // ── Step 4: Run the bridge (the heart of the e2e test) ───────────────
      bridgeResult = await bridge.handleMessage(message);

      // ── Step 5: Save cassette (record mode only) ──────────────────────────
      if (!existingCassette || shouldRerecord) {
        const recorder = agentClientForBridge as RecordingAgentClient;
        const events = recorder.capturedEvents;
        const { totalChars, updateCount } = computeExpectedFromEvents(events);
        const fullText = computeFullText(events);

        cassette = {
          tag,
          sessionId: recorder.capturedSessionId,
          events,
          expected: {
            result: {
              success: bridgeResult.success,
              totalChars,
              updateCount,
            },
            slackThread: {
              finalText: fullText,
            },
          },
        };

        await saveCassette(SCENARIO, cassette);
      }
    }, 120_000 /* 2-min timeout for live Slack + optionally live Claude */);

    // =========================================================================
    // AC 2: BridgeResult assertions
    // =========================================================================
    //
    // Verify that StreamingBridge.handleMessage() returns a BridgeResult whose
    // fields exactly match the values stored in the cassette fixture.
    // In replay mode these assertions are deterministic because ReplayAgentClient
    // yields a fixed event sequence, making totalChars and updateCount invariant.
    // =========================================================================

    it("BridgeResult.success is true", () => {
      expect(bridgeResult.success).toBe(true);
    });

    it("BridgeResult.sessionId matches the cassette session ID", () => {
      expect(bridgeResult.sessionId).toBe(cassette.sessionId);
    });

    it("BridgeResult.totalChars matches the fixture total character count", () => {
      expect(bridgeResult.totalChars).toBe(cassette.expected.result.totalChars);
    });

    it("BridgeResult.updateCount matches the fixture streaming update count", () => {
      expect(bridgeResult.updateCount).toBe(
        cassette.expected.result.updateCount,
      );
    });

    it("BridgeResult has no error field when successful", () => {
      expect(bridgeResult.error).toBeUndefined();
    });

    it("BridgeResult.sessionCreated is true (fresh session per test run)", () => {
      expect(bridgeResult.sessionCreated).toBe(true);
    });

    // =========================================================================
    // AC 3: Slack thread assertions
    //
    // Reads the live Slack thread via conversations.replies (bot token) and
    // verifies two properties of the bot's streaming reply:
    //   1. Exactly one bot reply exists in the thread (no duplicates or errors).
    //   2. The bot reply text contains the cassette's expected finalText.
    //
    // Polls with retries because Slack's conversations.replies may not reflect
    // a reply created by stopStream immediately (propagation delay).
    //
    // adapter.fetchThreadReplies() uses the bot token so this call exercises
    // the same credential path that posted the streaming reply.
    // =========================================================================

    it(
      "conversations.replies returns exactly one bot reply in the thread",
      async () => {
        // Poll until at least one bot reply appears (up to 30 × 2 s = 60 s).
        // A bot reply is any message whose ts differs from the thread root and
        // which carries a bot_id — the marker Slack sets on messages from bots.
        let botReplies: Array<Record<string, unknown>> = [];
        let allMessages: Array<Record<string, unknown>> = [];

        for (let attempt = 0; attempt < 30; attempt++) {
          allMessages = await adapter.fetchThreadReplies(channelId, messageTs);

          botReplies = allMessages.filter(
            (m) => m["ts"] !== messageTs && m["bot_id"] !== undefined,
          );

          if (botReplies.length > 0) break;

          if (attempt < 29) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }

        expect(
          botReplies,
          `Expected exactly 1 bot reply in thread ${messageTs}; ` +
            `got ${botReplies.length}.\n` +
            `Thread snapshot: ${JSON.stringify(
              allMessages.map((m) => ({
                ts: m["ts"],
                bot_id: m["bot_id"],
                text: String(m["text"] ?? "").slice(0, 100),
              })),
              null,
              2,
            )}`,
        ).toHaveLength(1);
      },
      70_000, // 30 attempts × 2 s interval + Slack propagation overhead
    );

    it(
      "bot reply text in conversations.replies contains the cassette finalText",
      async () => {
        // After the previous test confirmed the reply exists, the message is
        // already settled in Slack — a single read is sufficient.
        const messages = await adapter.fetchThreadReplies(channelId, messageTs);

        const botReply = messages.find(
          (m) => m["ts"] !== messageTs && m["bot_id"] !== undefined,
        );

        expect(botReply, "A bot reply must be present in the thread").toBeDefined();

        const replyText = String(botReply?.["text"] ?? "");
        const expectedFinalText = cassette.expected.slackThread?.finalText ?? "";

        // Slack's `conversations.replies` returns the bot message after it has
        // been rendered through Block Kit + mrkdwn, which diverges from the
        // raw Markdown the agent streamed:
        //
        //   • `**bold**` → `*bold*`            (CommonMark → Slack mrkdwn)
        //   • `🎉` → `:tada:`                   (unicode emoji → shortcode fallback)
        //   • blank lines collapse to single `\n`
        //   • a trailing `, with interactive elements` is appended as the
        //     accessibility fallback text for the streaming message block.
        //
        // None of those are functional deviations — they're presentation
        // normalisations Slack applies. We normalise both sides to a
        // word/digit-only form and assert the cassette content appears inside
        // what Slack stored.
        const normalize = (s: string): string =>
          s
            // Drop the Slack streaming-widget accessibility suffix.
            .replace(/,\s*with\s+interactive\s+elements\s*$/i, "")
            // Strip markdown bold/italic/underline markers.
            .replace(/\*+/g, "")
            .replace(/_+/g, "")
            // Strip Slack emoji shortcodes (:tada:, :+1:, :smile:).
            .replace(/:[a-z0-9_+-]+:/gi, "")
            // Strip unicode emoji / pictographs / dingbats.
            .replace(/[\p{Extended_Pictographic}]/gu, "")
            // Collapse any run of whitespace to a single space.
            .replace(/\s+/g, " ")
            .trim();

        const normalizedReply = normalize(replyText);
        const normalizedExpected = normalize(expectedFinalText);

        expect(
          normalizedReply,
          `Bot reply should contain the cassette finalText after normalising ` +
            `Slack's mrkdwn/emoji/whitespace rendering.\n` +
            `  Raw expected:         ${JSON.stringify(expectedFinalText.slice(0, 200))}\n` +
            `  Raw actual:           ${JSON.stringify(replyText.slice(0, 200))}\n` +
            `  Normalised expected:  ${JSON.stringify(normalizedExpected.slice(0, 200))}\n` +
            `  Normalised actual:    ${JSON.stringify(normalizedReply.slice(0, 200))}`,
        ).toContain(normalizedExpected);
      },
      15_000,
    );

    // =========================================================================
    // AC 4: Plan-mode task assertions
    //
    // The StreamingBridge emits plan-mode tasks via StreamHandle.appendTasks()
    // throughout streaming. TestSlackAdapter captures each appendTasks() call
    // as a deep-copied snapshot, so we can assert on the final terminal state.
    //
    // Assertions:
    //   1. Task list is non-empty (at minimum the "Initializing..." init task).
    //   2. All final tasks have status "complete" — no stalled in_progress tasks.
    //   3. Task IDs follow the naming convention: init | thinking_N | tool_N.
    //   4. Final task state equals the deterministic expectation derived from
    //      cassette events — ensures replay produces identical task sequences.
    //
    // The expected tasks are computed from cassette.events via
    // computeExpectedPlanTasks(), which mirrors the bridge's task-tracking
    // logic exactly. This makes the assertion deterministic across runs without
    // requiring a separate "expected tasks" field in the cassette.
    // =========================================================================

    it("plan-mode task list is non-empty (at least the init task)", () => {
      const finalTasks = adapter.finalTaskState;
      expect(
        finalTasks.length,
        "Bridge should emit at least the 'Initializing...' init task via appendTasks()",
      ).toBeGreaterThanOrEqual(1);
    });

    it("all final plan-mode tasks have status 'complete'", () => {
      const finalTasks = adapter.finalTaskState;
      // Verify no task is left stalled in "in_progress" or "pending" state.
      // The bridge calls markAllComplete() on done/error, so every task must
      // end up as "complete" in the terminal appendTasks() call.
      for (const task of finalTasks) {
        expect(
          task.status,
          `Task "${task.id}" ("${task.text}") should have status 'complete', got '${task.status}'`,
        ).toBe("complete");
      }
    });

    it("plan-mode task IDs follow the expected naming convention", () => {
      const finalTasks = adapter.finalTaskState;
      const validIdPattern = /^(init|thinking_\d+|tool_\d+)$/;
      for (const task of finalTasks) {
        expect(
          task.id,
          `Task ID "${task.id}" does not match expected pattern (init | thinking_N | tool_N)`,
        ).toMatch(validIdPattern);
      }
    });

    it(
      "plan-mode task sequence matches deterministic expectation from cassette events",
      () => {
        // computeExpectedPlanTasks() replicates the bridge's task-tracking logic,
        // producing the exact task array that appendTasks() should receive in its
        // final call. In replay mode this is 100% deterministic.
        const actualFinalTasks = adapter.finalTaskState;
        const expectedTasks = computeExpectedPlanTasks(cassette.events);

        expect(
          actualFinalTasks,
          `Final task state does not match the expected sequence derived from cassette events.\n` +
            `  Expected: ${JSON.stringify(expectedTasks, null, 2)}\n` +
            `  Actual:   ${JSON.stringify(actualFinalTasks, null, 2)}`,
        ).toEqual(expectedTasks);
      },
    );

    // =========================================================================
    // AC 5: Auto record-on-miss
    //
    // When no cassette fixture exists (first run) the suite automatically records
    // from the live Claude Managed Agent API via RecordingAgentClient and writes
    // the cassette to tests/e2e/fixtures/<scenario>.json for future replay runs.
    //
    // These tests verify the record-on-miss infrastructure:
    //   1. The cassette file is persisted to disk after record or replay.
    //   2. The cassette contains at least one real SSE event.
    //   3. The cassette SSE stream ends with a terminal event (done or error).
    //   4. The cassette sessionId is non-empty — createSession() was invoked.
    //   5. Cassette expected.result values are derivable from cassette.events.
    //   6. Cassette tag is set (run isolation embedded during recording).
    //
    // Note: "asserts on captured response" is satisfied jointly with AC 2 —
    // in record mode, bridgeResult comes from the live recording run, so the
    // AC 2 BridgeResult assertions ARE the "asserts on captured response".
    // =========================================================================

    it("AC5 — cassette file is persisted to disk after record or replay", () => {
      const cassetteFile = fixturePath(SCENARIO);
      expect(
        existsSync(cassetteFile),
        `Cassette file not found at: ${cassetteFile}\n` +
          `In record mode it should have been written by beforeAll.\n` +
          `In replay mode it should already exist on disk.\n` +
          `wasRecorded=${wasRecorded}`,
      ).toBe(true);
    });

    it("AC5 — cassette.events is non-empty (SSE events were captured from Claude)", () => {
      expect(
        cassette.events.length,
        "cassette.events must contain at least one SSE event — " +
          "an empty events array means nothing was streamed from the Claude Managed Agent",
      ).toBeGreaterThan(0);
    });

    it("AC5 — cassette.events ends with a terminal event (done or error)", () => {
      const lastEvent = cassette.events.at(-1);
      expect(lastEvent, "cassette must have at least one event").toBeDefined();
      expect(
        ["done", "error"].includes(lastEvent!.type),
        `Last cassette event should be terminal ("done" or "error"), ` +
          `got "${lastEvent!.type}". The Claude SSE stream must close cleanly.`,
      ).toBe(true);
    });

    it("AC5 — cassette.sessionId is a non-empty string (createSession() was invoked)", () => {
      expect(typeof cassette.sessionId, "cassette.sessionId must be a string").toBe("string");
      expect(
        cassette.sessionId,
        "cassette.sessionId must be non-empty — " +
          "RecordingAgentClient must have called createSession() on the real AgentClient",
      ).toBeTruthy();
    });

    it("AC5 — cassette expected.result.totalChars equals sum of text_delta event lengths", () => {
      const { totalChars } = computeExpectedFromEvents(cassette.events);
      expect(
        cassette.expected.result.totalChars,
        `cassette.expected.result.totalChars (${cassette.expected.result.totalChars}) ` +
          `should equal the sum of all text_delta.text lengths in cassette.events (${totalChars})`,
      ).toBe(totalChars);
    });

    it("AC5 — cassette expected.result.updateCount equals count of text_delta events", () => {
      const { updateCount } = computeExpectedFromEvents(cassette.events);
      expect(
        cassette.expected.result.updateCount,
        `cassette.expected.result.updateCount (${cassette.expected.result.updateCount}) ` +
          `should equal the number of text_delta events in cassette.events (${updateCount})`,
      ).toBe(updateCount);
    });

    it("AC5 — cassette.tag is a non-empty string (run isolation tag embedded)", () => {
      expect(typeof cassette.tag, "cassette.tag must be a string").toBe("string");
      expect(
        cassette.tag,
        "cassette.tag must be set to the run isolation tag from makeRunTag()",
      ).toBeTruthy();
    });

    it(
      "AC5 — cassette.expected.slackThread.finalText is derivable from cassette.events",
      () => {
        const computedFinalText = computeFullText(cassette.events);
        const storedFinalText = cassette.expected.slackThread?.finalText ?? "";
        expect(
          storedFinalText,
          `cassette.expected.slackThread.finalText should equal the concatenation ` +
            `of all text_delta.text values in cassette.events.\n` +
            `  Computed: ${JSON.stringify(computedFinalText.slice(0, 200))}\n` +
            `  Stored:   ${JSON.stringify(storedFinalText.slice(0, 200))}`,
        ).toBe(computedFinalText);
      },
    );
  },
);
