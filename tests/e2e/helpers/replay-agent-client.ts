/**
 * ReplayAgentClient — deterministic AgentClient stub for cassette replay.
 *
 * Replaces the real AgentClient in e2e tests so that the Claude Managed Agent
 * SSE stream is driven entirely from a pre-recorded cassette fixture.
 * No real Anthropic API calls are made during replay.
 *
 * Implements the minimal interface required by StreamingBridge + SessionOutputReader:
 *   - createSession() → returns the cassette's recorded session ID
 *   - sendMessage()   → yields the cassette's recorded SSE events
 */

import type { AgentStreamEvent } from "../../../src/core/chunk-parser.js";

export class ReplayAgentClient {
  private readonly replaySessionId: string;
  private readonly events: readonly AgentStreamEvent[];

  /**
   * @param sessionId  The Claude session ID to return from createSession().
   *                   Should match the value stored in the cassette.
   * @param events     The SSE event sequence to yield from sendMessage().
   *                   Replayed in order, deterministically.
   */
  constructor(sessionId: string, events: readonly AgentStreamEvent[]) {
    this.replaySessionId = sessionId;
    this.events = events;
  }

  /**
   * Returns the pre-recorded session ID.
   * SessionManager will store this in the thread→session map.
   */
  async createSession(): Promise<string> {
    return this.replaySessionId;
  }

  /**
   * Yields the pre-recorded SSE events in order.
   * The sessionId and text parameters are accepted but ignored during replay.
   */
  async *sendMessage(
    _sessionId: string,
    _text: string,
    _options?: { emitRawEvents?: boolean; signal?: AbortSignal },
  ): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}
