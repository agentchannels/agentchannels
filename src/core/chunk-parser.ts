/**
 * Typed message chunk parser for Claude Managed Agent SSE events.
 *
 * Transforms raw SSE events from the /v1/sessions/{id}/events stream
 * into a structured discriminated union of output types:
 * - text_delta: incremental text chunks
 * - tool_use: tool invocations with name and input
 * - thinking: extended thinking blocks
 * - status: session lifecycle status changes
 * - done: completion signals with optional stop reason
 * - error: error events
 * - raw: passthrough of original event for debugging
 */

/**
 * Raw SSE event as received from the Managed Agent sessions API.
 * Preserved for debugging and extensibility.
 */
export interface RawSessionEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Discriminated union for stream events emitted by the agent.
 * Each variant carries only the data relevant to its type.
 */
export type AgentStreamEvent =
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | ThinkingEvent
  | StatusEvent
  | DoneEvent
  | ErrorEvent
  | RawEvent;

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ToolUseEvent {
  type: "tool_use";
  name: string;
  input: unknown;
}

export interface ToolResultEvent {
  type: "tool_result";
  name?: string;
  toolUseId?: string;
}

export interface ThinkingEvent {
  type: "thinking";
  text?: string;
}

export interface StatusEvent {
  type: "status";
  status: string;
}

export interface DoneEvent {
  type: "done";
  stopReason?: string;
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export interface RawEvent {
  type: "raw";
  event: RawSessionEvent;
}

/**
 * Result of parsing a single SSE event.
 * - `events`: zero or more typed events to emit
 * - `terminal`: if true, the stream should be closed after emitting these events
 */
export interface ParseResult {
  events: AgentStreamEvent[];
  terminal: boolean;
}

/**
 * Parse a single raw SSE event from the Managed Agent session stream
 * into typed AgentStreamEvent values.
 *
 * Handles both incremental streaming formats (content_block_delta, content_block_start)
 * and full message formats (agent.message, agent.tool_use, agent.thinking)
 * for maximum compatibility across API versions.
 *
 * Unknown event types are silently ignored (returns empty events array).
 */
export function parseSSEEvent(event: unknown): ParseResult {
  if (event == null || typeof event !== "object") {
    return { events: [], terminal: false };
  }

  const rawEvent = event as Record<string, unknown>;
  const eventType = rawEvent.type as string | undefined;

  if (!eventType) return { events: [], terminal: false };

  switch (eventType) {
    // --- Incremental content streaming events ---
    case "content_block_delta":
      return parseContentBlockDelta(rawEvent);

    case "content_block_start":
      return parseContentBlockStart(rawEvent);

    // content_block_stop: no action needed, content is already yielded incrementally
    case "content_block_stop":
      return { events: [], terminal: false };

    // --- Full message events (non-streaming fallback) ---
    case "agent.message":
      return parseAgentMessage(rawEvent);

    case "agent.tool_use":
      return parseAgentToolUse(rawEvent);

    case "agent.tool_result":
      return parseAgentToolResult(rawEvent);

    case "agent.mcp_tool_use":
      return parseAgentToolUse(rawEvent);

    case "agent.mcp_tool_result":
      return parseAgentToolResult(rawEvent);

    case "agent.custom_tool_use":
      return parseAgentToolUse(rawEvent);

    case "agent.thinking":
      return parseAgentThinking(rawEvent);

    // --- Session lifecycle events ---
    case "session.status_running":
      return { events: [{ type: "status", status: "running" }], terminal: false };

    case "session.status_idle":
      return parseSessionIdle(rawEvent);

    case "session.status_rescheduled":
      return { events: [{ type: "status", status: "rescheduled" }], terminal: false };

    case "session.status_terminated":
      return { events: [{ type: "done", stopReason: "terminated" }], terminal: true };

    case "session.error":
      return parseSessionError(rawEvent);

    case "session.deleted":
      return { events: [{ type: "done", stopReason: "deleted" }], terminal: true };

    // --- Span events (observability) ---
    case "span.model_request_start":
      return { events: [{ type: "thinking" }], terminal: false };

    case "span.model_request_end":
      return { events: [], terminal: false };

    // --- Informational events ---
    case "agent.thread_context_compacted":
    case "agent.thread_message_sent":
    case "agent.thread_message_received":
    case "session.thread_created":
    case "session.thread_idle":
    case "session.outcome_evaluated":
    case "span.outcome_evaluation_start":
    case "span.outcome_evaluation_ongoing":
    case "span.outcome_evaluation_end":
    case "message_start":
    case "message_delta":
    case "message_stop":
      return { events: [], terminal: false };

    // Ignore any unknown/telemetry events
    default:
      return { events: [], terminal: false };
  }
}

// --- Internal parsing helpers ---

function parseContentBlockDelta(rawEvent: Record<string, unknown>): ParseResult {
  const delta = rawEvent.delta as Record<string, unknown> | undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return { events: [{ type: "text_delta", text: delta.text }], terminal: false };
  }
  if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
    return { events: [{ type: "thinking", text: delta.thinking }], terminal: false };
  }
  return { events: [], terminal: false };
}

function parseContentBlockStart(rawEvent: Record<string, unknown>): ParseResult {
  const contentBlock = rawEvent.content_block as Record<string, unknown> | undefined;
  if (contentBlock?.type === "tool_use") {
    return {
      events: [{
        type: "tool_use",
        name: (contentBlock.name as string) ?? "unknown",
        input: contentBlock.input,
      }],
      terminal: false,
    };
  }
  return { events: [], terminal: false };
}

function parseAgentMessage(rawEvent: Record<string, unknown>): ParseResult {
  const content = rawEvent.content;
  const events: AgentStreamEvent[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        events.push({ type: "text_delta", text: (block as Record<string, unknown>).text as string });
      }
    }
  }
  return { events, terminal: false };
}

function parseAgentToolUse(rawEvent: Record<string, unknown>): ParseResult {
  return {
    events: [{
      type: "tool_use",
      name: (rawEvent.name as string) ?? "unknown",
      input: rawEvent.input,
    }],
    terminal: false,
  };
}

function parseAgentToolResult(rawEvent: Record<string, unknown>): ParseResult {
  return {
    events: [{
      type: "tool_result",
      name: (rawEvent.name as string) ?? undefined,
      toolUseId: (rawEvent.tool_use_id as string) ?? undefined,
    }],
    terminal: false,
  };
}

function parseAgentThinking(rawEvent: Record<string, unknown>): ParseResult {
  const thinkingText = typeof rawEvent.text === "string" ? rawEvent.text : undefined;
  return { events: [{ type: "thinking", text: thinkingText }], terminal: false };
}

function parseSessionIdle(rawEvent: Record<string, unknown>): ParseResult {
  const stopReason =
    (rawEvent.stop_reason as Record<string, unknown>)?.type as string ?? "end_turn";
  return { events: [{ type: "done", stopReason }], terminal: true };
}

function parseSessionError(rawEvent: Record<string, unknown>): ParseResult {
  const errObj = rawEvent.error as Record<string, unknown> | undefined;
  const errMsg = typeof errObj?.message === "string"
    ? errObj.message
    : "Unknown session error";
  return { events: [{ type: "error", error: errMsg }], terminal: true };
}
