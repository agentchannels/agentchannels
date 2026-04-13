/**
 * Fixture I/O helpers for cassette-based e2e tests.
 *
 * Cassettes are stored as JSON files under tests/e2e/fixtures/ (gitignored).
 * Each contributor records their own cassette on first run; subsequent runs
 * replay from the local cassette without hitting the Claude API.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cassette, CassetteExpectedSlackThread } from "./types.js";
import type { AgentStreamEvent } from "../../../src/core/chunk-parser.js";
import type { StreamTask } from "../../../src/core/channel-adapter.js";
import { describeToolUse } from "../../../src/core/tool-descriptions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixtures directory (gitignored) */
export const FIXTURES_DIR = join(__dirname, "..", "fixtures");

// ---------------------------------------------------------------------------
// Force-rerecord flag
// ---------------------------------------------------------------------------

/**
 * Returns true when `E2E_RERECORD=true` is set in the environment.
 *
 * When true the e2e test suite:
 *   1. Ignores any existing cassette on disk (treats it as if it were absent).
 *   2. Runs in record mode — hitting the live Claude Managed Agent API.
 *   3. Calls saveCassette() unconditionally, **overwriting** the existing fixture.
 *
 * This is intended for contributors who need to refresh their local cassette
 * after changing the test scenario, updating the agent prompt, or switching
 * the Claude model.
 *
 * Usage (from the repository root):
 *   E2E_RERECORD=true pnpm vitest run tests/e2e/slack-bridge-e2e.test.ts
 *
 * Only the exact string `"true"` triggers rerecord — any other value is ignored.
 */
export function shouldForceRerecord(): boolean {
  return process.env["E2E_RERECORD"] === "true";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path for a fixture file.
 * @param scenario  A short kebab-case name, e.g. "basic-mention"
 */
export function fixturePath(scenario: string): string {
  return join(FIXTURES_DIR, `${scenario}.json`);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load a cassette from disk. Returns null if the file does not exist.
 *
 * This is the replay path: if a cassette is found, the test drives the
 * Claude SSE stream from the cassette instead of hitting the real API.
 */
export async function loadCassette(scenario: string): Promise<Cassette | null> {
  const path = fixturePath(scenario);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as Cassette;
}

/**
 * Save a cassette to disk. Creates the fixtures/ directory if it does not exist.
 *
 * This is the record path: called after a live run to persist the cassette
 * for future replay runs.
 */
export async function saveCassette(
  scenario: string,
  cassette: Cassette,
): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(
    fixturePath(scenario),
    JSON.stringify(cassette, null, 2) + "\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

/**
 * Derive the expected BridgeResult values from a list of SSE events.
 *
 * - totalChars:  sum of all text_delta.text lengths (= fullText.length)
 * - updateCount: count of text_delta events (= StreamingBridge updateCount)
 *
 * These values are deterministic from the event list, so they can be used
 * as ground truth in AC 2 BridgeResult assertions.
 */
export function computeExpectedFromEvents(events: AgentStreamEvent[]): {
  totalChars: number;
  updateCount: number;
} {
  let totalChars = 0;
  let updateCount = 0;
  for (const event of events) {
    if (event.type === "text_delta") {
      totalChars += event.text.length;
      updateCount++;
    }
  }
  return { totalChars, updateCount };
}

/**
 * Compute the full concatenated text from a list of SSE events.
 * Useful for AC 3 Slack thread assertions.
 */
export function computeFullText(events: AgentStreamEvent[]): string {
  return events
    .filter((e): e is AgentStreamEvent & { type: "text_delta" } => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
}

/**
 * Derive the expected Slack thread state from a list of cassette SSE events.
 *
 * Computes a `CassetteExpectedSlackThread` that represents what the Slack thread
 * should look like after the StreamingBridge processes the cassette events.
 *
 * ## What is derived vs. what requires live recording
 *
 * This function derives as much as possible from the event sequence alone:
 *
 *   - `finalText` — concatenation of all `text_delta.text` values (deterministic)
 *   - `messages[0].text` — equals `finalText` (the bot's single streaming reply)
 *   - `messages[0].isBot` — always `true` (streaming replies are bot-authored)
 *   - `messages[0].meta.replyIndex` — `0` (first and only bot reply)
 *   - `messages[0].meta.isBotMessage` — `true` (matches `bot_id` presence in Slack)
 *
 * The following fields **cannot** be derived from events and are left absent:
 *
 *   - `messages[0].blocks` — Block Kit blocks Slack attaches to streaming messages.
 *     These must be captured from the live Slack API response during a recording
 *     run. In record mode, overwrite this field after reading conversations.replies.
 *
 * ## Usage
 *
 * ```ts
 * // In record mode: compute a starting point, then enrich with live Slack data
 * const base = computeExpectedSlackThread(capturedEvents);
 * const liveReplies = await userClient.fetchThreadReplies(threadTs, messageTs);
 * // Merge live blocks into the computed structure:
 * if (base.messages && liveReplies[0]?.blocks) {
 *   base.messages[0].blocks = liveReplies[0].blocks;
 * }
 *
 * // In replay mode (no live Claude): sufficient for text-based AC 3 assertions
 * const expected = computeExpectedSlackThread(cassette.events);
 * await assertSlackThread({ ..., expectedText: expected.finalText });
 * ```
 *
 * ## Edge cases
 *
 * - **No text_delta events**: `finalText` is `""` and `messages[0].text` is `""`.
 *   The bridge will call `finish()` with an empty-response fallback, so
 *   `toContain("")` is vacuously true — the assertion won't catch a missing reply.
 *   Callers should additionally check `messages.length` for a richer assertion.
 *
 * - **Multiple text_delta events**: their texts are concatenated in order, which
 *   matches exactly what the bridge appends via successive `StreamHandle.append()` calls.
 *
 * @param events  Ordered cassette SSE events from which to derive the expected state
 * @returns `CassetteExpectedSlackThread` with `finalText` and a single `messages` entry
 */
export function computeExpectedSlackThread(
  events: AgentStreamEvent[],
): CassetteExpectedSlackThread {
  const finalText = computeFullText(events);

  return {
    finalText,
    messages: [
      {
        // Text content: the concatenation of all text_delta values — this is exactly
        // what the bridge appends to the Slack stream and what conversations.replies
        // returns as the final message text after stopStream.
        text: finalText,

        // All streaming replies come from the bot adapter (chat.startStream sets bot_id).
        isBot: true,

        // blocks cannot be derived from SSE events; populated from live Slack during recording.
        blocks: undefined,

        meta: {
          // First (and only) bot reply in the thread for a single-turn test.
          replyIndex: 0,
          // Streaming messages always have bot_id set by Slack.
          isBotMessage: true,
        },
      },
    ],
  };
}

/**
 * Derive the expected final plan-mode task state from a list of SSE events.
 *
 * Replicates the task-tracking logic in StreamingBridge exactly, so the computed
 * result matches what StreamHandle.appendTasks() would receive in its final call.
 * This enables deterministic AC 4 assertions in replay mode without storing a
 * separate expected-tasks list in the cassette.
 *
 * Task lifecycle mirrors the bridge:
 *   - init task added at stream start (status: in_progress → complete on first thinking)
 *   - thinking_N tasks added on each thinking event
 *   - tool_N tasks added on each tool_use event, completed on tool_result
 *   - done event marks all remaining tasks as complete
 */
export function computeExpectedPlanTasks(events: AgentStreamEvent[]): StreamTask[] {
  type TaskStatus = "pending" | "in_progress" | "complete" | "error";
  type TaskInfo = { id: string; text: string; status: TaskStatus };

  const tasks: TaskInfo[] = [];
  let taskCounter = 0;
  let thinkingId = 0;

  // Bridge always starts with an "Initializing..." task before streaming begins.
  tasks.push({ id: "init", text: "Initializing...", status: "in_progress" });

  const markAllComplete = () => {
    for (const t of tasks) {
      if (t.status !== "complete") t.status = "complete";
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "thinking": {
        // Complete the init task on first thinking event
        const initTask = tasks.find((t) => t.id === "init");
        if (initTask && initTask.status === "in_progress") {
          initTask.status = "complete";
        }
        // Complete any previous in-progress thinking tasks
        for (const t of tasks) {
          if (t.id.startsWith("thinking_") && t.status === "in_progress") {
            t.status = "complete";
          }
        }
        const id = `thinking_${++thinkingId}`;
        const hasTools = tasks.some((t) => t.id.startsWith("tool_"));
        let label: string;
        if (event.text) {
          // Truncate long thinking text to match bridge behaviour
          label =
            event.text.length > 80
              ? event.text.slice(0, 77) + "..."
              : event.text;
        } else if (hasTools) {
          label = "Processing results...";
        } else if (thinkingId === 1) {
          label = "Analyzing your request...";
        } else {
          label = "Thinking...";
        }
        tasks.push({ id, text: label, status: "in_progress" });
        break;
      }

      case "tool_use": {
        // Complete any in-progress thinking tasks before starting a tool task
        for (const t of tasks) {
          if (t.id.startsWith("thinking_") && t.status === "in_progress") {
            t.status = "complete";
          }
        }
        const description = describeToolUse(event.name, event.input);
        const toolId = `tool_${++taskCounter}`;
        tasks.push({ id: toolId, text: description, status: "in_progress" });
        break;
      }

      case "tool_result": {
        // Mark the most recent in-progress tool task as complete
        for (let i = tasks.length - 1; i >= 0; i--) {
          if (tasks[i].id.startsWith("tool_") && tasks[i].status === "in_progress") {
            if (event.name) {
              tasks[i].text = describeToolUse(event.name, {}) + " ✓";
            }
            tasks[i].status = "complete";
            break;
          }
        }
        break;
      }

      case "done": {
        // Bridge calls markAllComplete() then sendTasks() on done event
        markAllComplete();
        break;
      }

      // text_delta, status, error, thinking (without text), raw — no task changes
      default:
        break;
    }
  }

  // Safety net: ensure all tasks are complete even if done event was not present
  // (mirrors the bridge's finally block which calls clearStatus unconditionally).
  markAllComplete();

  return tasks as StreamTask[];
}
