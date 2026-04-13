/**
 * CassetteReplayStub — a drop-in replacement for AgentClient that replays
 * pre-recorded SSE events from a cassette fixture file.
 *
 * Used in e2e tests to replace the live Claude Managed Agent SSE stream
 * with a deterministic, pre-recorded event sequence so that:
 *   - Slack API calls remain live (real round-trips)
 *   - Agent streaming is fully deterministic (no external API calls)
 *
 * ## Cassette file format
 *
 * ```json
 * {
 *   "version": 1,
 *   "recordedAt": "2026-04-13T10:30:00.000Z",
 *   "events": [
 *     { "type": "thinking", "text": "Let me analyze this..." },
 *     { "type": "text_delta", "text": "Hello, " },
 *     { "type": "text_delta", "text": "how can I help?" },
 *     { "type": "done", "stopReason": "end_turn" }
 *   ]
 * }
 * ```
 *
 * ## Wiring in tests
 *
 * ```ts
 * const stub = new CassetteReplayStub("./fixtures/my-cassette.json");
 * const bridge = new StreamingBridge({
 *   adapter,
 *   agentClient: stub as unknown as AgentClient,
 *   sessionManager,
 * });
 * ```
 *
 * The cast (`as unknown as AgentClient`) is required because TypeScript's
 * structural typing for classes considers private members. The stub satisfies
 * all public methods that StreamingBridge and SessionOutputReader call at
 * runtime — `createSession()` and `sendMessage()`.
 */

import { readFile } from "node:fs/promises";
import type { AgentStreamEvent } from "../../../src/core/chunk-parser.js";
import type {
  SendMessageOptions,
  CreateAgentResult,
  CreateEnvironmentResult,
} from "../../../src/core/agent-client.js";

// ---------------------------------------------------------------------------
// Cassette fixture schema
// ---------------------------------------------------------------------------

/**
 * Schema for a cassette fixture file stored on disk.
 * Written by the cassette recorder; read back by CassetteReplayStub.
 */
export interface CassetteFixture {
  /** Schema version — currently 1 */
  version: number;

  /** ISO 8601 timestamp of when the cassette was recorded */
  recordedAt: string;

  /** Ordered sequence of AgentStreamEvents to replay on sendMessage() */
  events: AgentStreamEvent[];
}

// ---------------------------------------------------------------------------
// CassetteReplayStub
// ---------------------------------------------------------------------------

/**
 * Structurally mimics the public API of AgentClient.
 * Replays pre-recorded AgentStreamEvents from a JSON cassette fixture.
 *
 * @param cassettePath  Absolute or project-relative path to the cassette JSON file.
 *                      If the file is missing, sendMessage() throws a descriptive
 *                      error hinting the contributor to run with RECORD=1.
 */
export class CassetteReplayStub {
  private readonly cassettePath: string;
  /** In-memory cache so the fixture is parsed only once per stub instance. */
  private cachedFixture: CassetteFixture | null = null;

  constructor(cassettePath: string) {
    this.cassettePath = cassettePath;
  }

  // ── Core methods used by StreamingBridge / SessionOutputReader ────────────

  /**
   * Returns a deterministic fake session ID.
   * No Anthropic API call is made — the session is not real.
   */
  async createSession(
    _params?: {
      agentId?: string;
      environmentId?: string;
      vaultIds?: string[];
      title?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<string> {
    return "cassette-replay-session";
  }

  /**
   * Load the cassette fixture and yield each recorded AgentStreamEvent in order.
   *
   * Respects AbortSignal — yields `{ type: "error" }` and returns early if
   * the signal is aborted before the first event or between events (mirrors
   * the real AgentClient.sendMessage behaviour).
   *
   * @param _sessionId  Ignored — the cassette is not scoped to a session ID.
   * @param _text       Ignored — the cassette records a fixed response.
   * @param options     Optional SendMessageOptions; only `signal` is observed.
   */
  async *sendMessage(
    _sessionId: string,
    _text: string,
    options?: SendMessageOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    // Pre-flight abort check (mirrors AgentClient)
    if (options?.signal?.aborted) {
      yield { type: "error", error: "Stream aborted before starting" };
      return;
    }

    const fixture = await this.loadCassette();

    for (const event of fixture.events) {
      // Per-event abort check (mirrors AgentClient)
      if (options?.signal?.aborted) {
        yield { type: "error", error: "Stream aborted" };
        return;
      }
      yield event;
    }
  }

  /**
   * Convenience wrapper — mirrors AgentClient.sendMessageAndCollect.
   * Concatenates all text_delta events from the replay stream.
   */
  async sendMessageAndCollect(
    sessionId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    let fullText = "";
    for await (const event of this.sendMessage(sessionId, text, options)) {
      if (event.type === "text_delta") {
        fullText += event.text;
      }
      if (event.type === "error") {
        throw new Error(event.error);
      }
    }
    return fullText;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** No agent ID in replay mode. */
  getAgentId(): string | undefined {
    return undefined;
  }

  /** No environment ID in replay mode. */
  getEnvironmentId(): string | undefined {
    return undefined;
  }

  /**
   * Not available in replay mode.
   * Throws to surface accidental calls that assume a live Anthropic client.
   */
  getRawClient(): never {
    throw new Error(
      "CassetteReplayStub.getRawClient() is not available in replay mode. " +
      "The stub has no underlying Anthropic client.",
    );
  }

  // ── Admin method stubs (not called during bridge streaming) ───────────────

  /** No-op — replay mode requires no auth. */
  async validateAuth(): Promise<void> {
    // intentional no-op
  }

  async createAgent(
    _params: { name: string; model?: string; description?: string; system?: string },
  ): Promise<CreateAgentResult> {
    throw new Error(
      "CassetteReplayStub.createAgent() is not supported. " +
      "Use a real AgentClient for agent management operations.",
    );
  }

  async getAgent(_agentId?: string): Promise<CreateAgentResult> {
    throw new Error(
      "CassetteReplayStub.getAgent() is not supported. " +
      "Use a real AgentClient for agent management operations.",
    );
  }

  async createEnvironment(
    _params: { name: string; description?: string },
  ): Promise<CreateEnvironmentResult> {
    throw new Error(
      "CassetteReplayStub.createEnvironment() is not supported. " +
      "Use a real AgentClient for environment management operations.",
    );
  }

  async getEnvironment(_environmentId?: string): Promise<CreateEnvironmentResult> {
    throw new Error(
      "CassetteReplayStub.getEnvironment() is not supported. " +
      "Use a real AgentClient for environment management operations.",
    );
  }

  // ── Cassette loading ───────────────────────────────────────────────────────

  /**
   * Load and cache the cassette fixture from disk.
   *
   * Caches the parsed result in memory so repeated sendMessage() calls within
   * a single test do not re-read the file.
   *
   * @throws  Descriptive error if the file cannot be read, hinting at RECORD=1.
   * @throws  Descriptive error if the JSON is malformed or has an unexpected schema.
   */
  async loadCassette(): Promise<CassetteFixture> {
    if (this.cachedFixture) return this.cachedFixture;

    let raw: string;
    try {
      raw = await readFile(this.cassettePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CassetteReplayStub: cannot read cassette at "${this.cassettePath}": ${msg}\n` +
        `Run the test with RECORD=1 to record a new cassette, ` +
        `or set FORCE_RECORD=1 to overwrite an existing one.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CassetteReplayStub: cassette at "${this.cassettePath}" contains invalid JSON: ${msg}`,
      );
    }

    if (!isCassetteFixture(parsed)) {
      throw new Error(
        `CassetteReplayStub: cassette at "${this.cassettePath}" has an unexpected schema. ` +
        `Expected { version: number, recordedAt: string, events: AgentStreamEvent[] }.`,
      );
    }

    this.cachedFixture = parsed;
    return parsed;
  }

  /** Return the cassette file path this stub was constructed with. */
  getCassettePath(): string {
    return this.cassettePath;
  }

  /**
   * Reset the in-memory fixture cache.
   * Useful when a test needs to reload an updated cassette within the same process.
   */
  resetCache(): void {
    this.cachedFixture = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Runtime schema guard for CassetteFixture.
 * Validates the top-level shape without validating each individual event
 * (AgentStreamEvent validation is delegated to the streaming consumer).
 */
function isCassetteFixture(value: unknown): value is CassetteFixture {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    typeof v.recordedAt === "string" &&
    Array.isArray(v.events)
  );
}
