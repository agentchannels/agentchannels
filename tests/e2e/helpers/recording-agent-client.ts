/**
 * RecordingAgentClient — transparent proxy that records SSE events for cassette creation.
 *
 * Wraps a real AgentClient and captures every SSE event yielded by sendMessage(),
 * plus the session ID returned by createSession(). The captured data is then
 * stored in the cassette fixture for use in subsequent replay runs.
 *
 * Used only in RECORD mode (when no cassette exists or E2E_RERECORD=true).
 */

import type { AgentClient } from "../../../src/core/agent-client.js";
import type { AgentStreamEvent } from "../../../src/core/chunk-parser.js";

export class RecordingAgentClient {
  /** All SSE events captured across all sendMessage() calls, in order */
  readonly capturedEvents: AgentStreamEvent[] = [];

  /** The session ID returned by createSession() */
  capturedSessionId = "";

  constructor(private readonly real: AgentClient) {}

  /**
   * Delegates to the real AgentClient and records the returned session ID.
   */
  async createSession(
    params?: Parameters<AgentClient["createSession"]>[0],
  ): Promise<string> {
    const id = await this.real.createSession(params);
    this.capturedSessionId = id;
    return id;
  }

  /**
   * Delegates to the real AgentClient and records every yielded SSE event.
   * Events are both captured and forwarded to the caller transparently.
   */
  async *sendMessage(
    sessionId: string,
    text: string,
    options?: Parameters<AgentClient["sendMessage"]>[2],
  ): AsyncGenerator<AgentStreamEvent> {
    for await (const event of this.real.sendMessage(sessionId, text, options)) {
      this.capturedEvents.push(event);
      yield event;
    }
  }
}
