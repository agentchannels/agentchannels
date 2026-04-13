/**
 * BotHarness — in-process end-to-end test harness.
 *
 * Wires together:
 *   - SlackAdapter (Socket Mode, real Slack API)
 *   - SessionManager (in-memory, no TTL)
 *   - StreamingBridge
 *   - ReplayAgentClient (cassette replay stub — no Anthropic API calls)
 *
 * The real AgentClient is replaced entirely by ReplayAgentClient, which
 * replays the pre-recorded SSE event sequence from a Cassette fixture.
 * All Slack API interactions remain live (real round-trips).
 *
 * ## Lifecycle
 *
 * ```ts
 * const harness = new BotHarness({ env, cassette });
 *
 * await harness.start();   // connects SlackAdapter via Socket Mode
 *
 * const resultPromise = harness.waitForBridgeResult();  // arm BEFORE posting
 * await userClient.postMessage(`<@${harness.getBotUserId()}> hello`);
 * const result = await resultPromise;                   // await after posting
 *
 * await harness.stop();    // aborts in-flight threads, disconnects
 * ```
 *
 * NO test assertions live in this file — it is a pure wiring/lifecycle helper.
 */

import { SlackAdapter } from "../../../src/channels/slack/index.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { StreamingBridge, type BridgeResult } from "../../../src/core/streaming-bridge.js";
import type { AgentClient } from "../../../src/core/agent-client.js";
import type { ChannelMessage } from "../../../src/core/channel-adapter.js";
import { ReplayAgentClient } from "./replay-agent-client.js";
import type { E2EEnv } from "./env.js";
import type { Cassette } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BotHarnessConfig {
  /**
   * Validated contributor env vars.
   * Obtain via `getE2EEnv()` from `./env.js`; the suite should already have
   * skipped if any vars were missing before constructing the harness.
   */
  env: E2EEnv;

  /**
   * Cassette fixture to replay.
   * Drives both the ReplayAgentClient (SSE events) and the expected outcomes
   * that tests assert against.
   */
  cassette: Cassette;
}

// ---------------------------------------------------------------------------
// BotHarness
// ---------------------------------------------------------------------------

/**
 * In-process test harness that instantiates the full bot pipeline against a
 * real Slack workspace, with the Claude Managed Agent replaced by a
 * deterministic cassette replay stub.
 */
export class BotHarness {
  /** Slack Socket Mode adapter wired to the test workspace */
  readonly adapter: SlackAdapter;

  /** In-memory session store scoped to this harness instance */
  readonly sessionManager: SessionManager;

  /** Streaming bridge coordinator wired to the adapter, session manager, and replay stub */
  readonly bridge: StreamingBridge;

  // ── Private result-tracking state ────────────────────────────────────────

  private _lastBridgeResult: BridgeResult | undefined;

  /**
   * Promise created by waitForBridgeResult() that resolves when the next
   * bridge.handleMessage() call completes.
   */
  private _pendingResultPromise: Promise<BridgeResult> | undefined;

  /**
   * Resolver for _pendingResultPromise — cleared after each resolution so that
   * a fresh Promise is created on the next waitForBridgeResult() call.
   */
  private _pendingResultResolve: ((result: BridgeResult) => void) | undefined;

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(private readonly config: BotHarnessConfig) {
    const { env, cassette } = config;

    // ------------------------------------------------------------------
    // 1. SlackAdapter in Socket Mode using contributor test credentials
    // ------------------------------------------------------------------
    this.adapter = new SlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      appToken: env.SLACK_APP_TOKEN,
      // signingSecret is unused in Socket Mode; omit to use the default placeholder
    });

    // ------------------------------------------------------------------
    // 2. In-memory session manager — no TTL so sessions persist for
    //    the entire test run without expiring mid-assertion
    // ------------------------------------------------------------------
    this.sessionManager = new SessionManager();

    // ------------------------------------------------------------------
    // 3. Cassette replay stub replacing AgentClient
    //
    //    ReplayAgentClient satisfies the public AgentClient interface used
    //    by StreamingBridge + SessionOutputReader at runtime:
    //      - createSession() → returns the cassette's recorded session ID
    //      - sendMessage()   → yields the cassette's recorded SSE events
    //
    //    The cast `as unknown as AgentClient` is required because TypeScript
    //    structural typing for classes compares private members — the stub
    //    satisfies all runtime-called methods without carrying the private
    //    Anthropic SDK internals.
    // ------------------------------------------------------------------
    const replayClient = new ReplayAgentClient(cassette.sessionId, cassette.events);

    // ------------------------------------------------------------------
    // 4. StreamingBridge wired with replay stub
    // ------------------------------------------------------------------
    this.bridge = new StreamingBridge({
      adapter: this.adapter,
      agentClient: replayClient as unknown as AgentClient,
      sessionManager: this.sessionManager,
    });

    // ------------------------------------------------------------------
    // 5. Route every incoming Slack message through the bridge
    //
    //    After the bridge resolves we:
    //      a. Store the result for synchronous inspection via lastBridgeResult
    //      b. Resolve any outstanding waitForBridgeResult() promise
    // ------------------------------------------------------------------
    this.adapter.onMessage(async (message: ChannelMessage) => {
      const result = await this.bridge.handleMessage(message);

      this._lastBridgeResult = result;

      // Notify any test awaiting the next bridge completion
      if (this._pendingResultResolve) {
        const resolve = this._pendingResultResolve;
        // Clear before calling so that a new promise can be armed immediately
        this._pendingResultResolve = undefined;
        this._pendingResultPromise = undefined;
        resolve(result);
      }
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Connect the SlackAdapter to Slack via Socket Mode.
   *
   * After this resolves:
   * - The adapter is listening for app_mention and DM events
   * - `getBotUserId()` returns the resolved bot user ID
   * - Messages posted to the test channel will trigger the bridge
   *
   * Must be called before posting any test messages.
   */
  async start(): Promise<void> {
    await this.adapter.connect();
  }

  /**
   * Gracefully stop the harness:
   *   1. Abort any in-flight bridge threads (sends abort signal to stream)
   *   2. Disconnect the SlackAdapter (closes Socket Mode WebSocket)
   *
   * Safe to call even if start() has not been called or already completed.
   */
  async stop(): Promise<void> {
    this.bridge.abortAll();
    await this.adapter.disconnect();
  }

  // ── Result access ─────────────────────────────────────────────────────────

  /**
   * The BridgeResult from the most recent `bridge.handleMessage()` call.
   *
   * Undefined until at least one message has been processed by the bridge.
   * Suitable for synchronous inspection after `waitForBridgeResult()` resolves.
   */
  get lastBridgeResult(): BridgeResult | undefined {
    return this._lastBridgeResult;
  }

  /**
   * Return a Promise that resolves with the BridgeResult of the NEXT
   * `bridge.handleMessage()` call.
   *
   * IMPORTANT: call this BEFORE triggering the Slack message so that no
   * race condition can occur between posting the message and arming the
   * listener.
   *
   * @example
   * ```ts
   * const resultPromise = harness.waitForBridgeResult();
   * await userClient.postMessage(`<@${harness.getBotUserId()}> hello`);
   * const result = await resultPromise;
   * // result.success, result.totalChars, etc. are now available
   * ```
   *
   * If called while a previous pending promise has not yet resolved, the
   * same promise instance is returned (idempotent for the current cycle).
   */
  waitForBridgeResult(): Promise<BridgeResult> {
    if (!this._pendingResultPromise) {
      this._pendingResultPromise = new Promise<BridgeResult>((resolve) => {
        this._pendingResultResolve = resolve;
      });
    }
    return this._pendingResultPromise;
  }

  // ── Identity helpers ──────────────────────────────────────────────────────

  /**
   * Return the Slack bot user ID (Uxxxxxxxx) resolved during `start()`.
   *
   * Used to construct `<@BOTID>` mention text in test messages that need to
   * trigger the `app_mention` event on the adapter.
   *
   * Returns `undefined` before `start()` is called or if `auth.test` failed
   * during connect (check the console for a warning in that case).
   */
  getBotUserId(): string | undefined {
    // SlackAdapter.botUserId is private; access via structural cast.
    // This avoids exposing it on the public adapter interface while still
    // making it available to the harness for mention-text construction.
    return (this.adapter as unknown as { botUserId?: string }).botUserId;
  }
}
