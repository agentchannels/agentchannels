import { describe, it, expect } from "vitest";
import { parseSSEEvent } from "../../src/core/chunk-parser.js";
import type { AgentStreamEvent, ParseResult } from "../../src/core/chunk-parser.js";

describe("parseSSEEvent", () => {
  // ---- Text delta events ----

  describe("content_block_delta - text", () => {
    it("parses text_delta into TextDeltaEvent", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello world" },
      });

      expect(result).toEqual({
        events: [{ type: "text_delta", text: "Hello world" }],
        terminal: false,
      });
    });

    it("handles empty text string", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "" },
      });

      expect(result).toEqual({
        events: [{ type: "text_delta", text: "" }],
        terminal: false,
      });
    });

    it("ignores content_block_delta with no delta", () => {
      const result = parseSSEEvent({ type: "content_block_delta" });
      expect(result).toEqual({ events: [], terminal: false });
    });

    it("ignores content_block_delta with unknown delta type", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "unknown_delta", data: "foo" },
      });
      expect(result).toEqual({ events: [], terminal: false });
    });

    it("ignores content_block_delta with non-string text", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: 123 },
      });
      expect(result).toEqual({ events: [], terminal: false });
    });
  });

  // ---- Thinking events ----

  describe("content_block_delta - thinking", () => {
    it("parses thinking_delta into ThinkingEvent", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Let me consider..." },
      });

      expect(result).toEqual({
        events: [{ type: "thinking", text: "Let me consider..." }],
        terminal: false,
      });
    });

    it("ignores thinking_delta with non-string thinking", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: null },
      });
      expect(result).toEqual({ events: [], terminal: false });
    });
  });

  // ---- Tool use events ----

  describe("content_block_start - tool_use", () => {
    it("parses tool_use content block into ToolUseEvent", () => {
      const result = parseSSEEvent({
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          name: "calculator",
          input: { expr: "2+2" },
        },
      });

      expect(result).toEqual({
        events: [{
          type: "tool_use",
          name: "calculator",
          input: { expr: "2+2" },
        }],
        terminal: false,
      });
    });

    it("defaults tool name to 'unknown' when missing", () => {
      const result = parseSSEEvent({
        type: "content_block_start",
        content_block: { type: "tool_use", input: {} },
      });

      expect(result.events[0]).toEqual({
        type: "tool_use",
        name: "unknown",
        input: {},
      });
    });

    it("ignores content_block_start with non-tool_use type", () => {
      const result = parseSSEEvent({
        type: "content_block_start",
        content_block: { type: "text" },
      });
      expect(result).toEqual({ events: [], terminal: false });
    });

    it("ignores content_block_start with no content_block", () => {
      const result = parseSSEEvent({ type: "content_block_start" });
      expect(result).toEqual({ events: [], terminal: false });
    });
  });

  describe("agent.tool_use (legacy format)", () => {
    it("parses agent.tool_use into ToolUseEvent", () => {
      const result = parseSSEEvent({
        type: "agent.tool_use",
        name: "web_search",
        input: { query: "test" },
      });

      expect(result).toEqual({
        events: [{
          type: "tool_use",
          name: "web_search",
          input: { query: "test" },
        }],
        terminal: false,
      });
    });

    it("defaults name to 'unknown' when missing", () => {
      const result = parseSSEEvent({
        type: "agent.tool_use",
        input: { data: "x" },
      });

      expect(result.events[0]).toMatchObject({
        type: "tool_use",
        name: "unknown",
      });
    });
  });

  // ---- Full message events ----

  describe("agent.message", () => {
    it("extracts text blocks from content array", () => {
      const result = parseSSEEvent({
        type: "agent.message",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      });

      expect(result).toEqual({
        events: [
          { type: "text_delta", text: "Hello " },
          { type: "text_delta", text: "world" },
        ],
        terminal: false,
      });
    });

    it("skips non-text content blocks", () => {
      const result = parseSSEEvent({
        type: "agent.message",
        content: [
          { type: "text", text: "Hello" },
          { type: "image", source: { data: "..." } },
          { type: "tool_use", name: "foo" },
        ],
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({ type: "text_delta", text: "Hello" });
    });

    it("returns empty events for non-array content", () => {
      const result = parseSSEEvent({
        type: "agent.message",
        content: "not an array",
      });
      expect(result).toEqual({ events: [], terminal: false });
    });

    it("returns empty events for empty content array", () => {
      const result = parseSSEEvent({
        type: "agent.message",
        content: [],
      });
      expect(result).toEqual({ events: [], terminal: false });
    });

    it("skips null entries in content array", () => {
      const result = parseSSEEvent({
        type: "agent.message",
        content: [null, { type: "text", text: "ok" }, undefined],
      });
      expect(result.events).toEqual([{ type: "text_delta", text: "ok" }]);
    });
  });

  // ---- Thinking events (agent.thinking) ----

  describe("agent.thinking", () => {
    it("parses thinking event with text", () => {
      const result = parseSSEEvent({
        type: "agent.thinking",
        text: "Reasoning about the problem...",
      });

      expect(result).toEqual({
        events: [{ type: "thinking", text: "Reasoning about the problem..." }],
        terminal: false,
      });
    });

    it("parses thinking event without text", () => {
      const result = parseSSEEvent({ type: "agent.thinking" });
      expect(result).toEqual({
        events: [{ type: "thinking", text: undefined }],
        terminal: false,
      });
    });
  });

  // ---- Session lifecycle events ----

  describe("session lifecycle", () => {
    it("parses session.status_running", () => {
      const result = parseSSEEvent({ type: "session.status_running" });
      expect(result).toEqual({
        events: [{ type: "status", status: "running" }],
        terminal: false,
      });
    });

    it("parses session.status_idle with stop reason", () => {
      const result = parseSSEEvent({
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      });
      expect(result).toEqual({
        events: [{ type: "done", stopReason: "end_turn" }],
        terminal: true,
      });
    });

    it("parses session.status_idle with max_tokens stop reason", () => {
      const result = parseSSEEvent({
        type: "session.status_idle",
        stop_reason: { type: "max_tokens" },
      });
      expect(result).toEqual({
        events: [{ type: "done", stopReason: "max_tokens" }],
        terminal: true,
      });
    });

    it("defaults stop reason to end_turn when stop_reason is missing", () => {
      const result = parseSSEEvent({ type: "session.status_idle" });
      expect(result).toEqual({
        events: [{ type: "done", stopReason: "end_turn" }],
        terminal: true,
      });
    });

    it("parses session.status_terminated", () => {
      const result = parseSSEEvent({ type: "session.status_terminated" });
      expect(result).toEqual({
        events: [{ type: "done", stopReason: "terminated" }],
        terminal: true,
      });
    });

    it("parses session.deleted", () => {
      const result = parseSSEEvent({ type: "session.deleted" });
      expect(result).toEqual({
        events: [{ type: "done", stopReason: "deleted" }],
        terminal: true,
      });
    });
  });

  // ---- Error events ----

  describe("session.error", () => {
    it("parses error with message", () => {
      const result = parseSSEEvent({
        type: "session.error",
        error: { message: "Rate limited" },
      });

      expect(result).toEqual({
        events: [{ type: "error", error: "Rate limited" }],
        terminal: true,
      });
    });

    it("defaults to 'Unknown session error' when error message is missing", () => {
      const result = parseSSEEvent({
        type: "session.error",
        error: {},
      });

      expect(result).toEqual({
        events: [{ type: "error", error: "Unknown session error" }],
        terminal: true,
      });
    });

    it("defaults to 'Unknown session error' when error object is missing", () => {
      const result = parseSSEEvent({ type: "session.error" });
      expect(result).toEqual({
        events: [{ type: "error", error: "Unknown session error" }],
        terminal: true,
      });
    });
  });

  // ---- Informational/ignored events ----

  describe("informational events", () => {
    it("ignores content_block_stop", () => {
      expect(parseSSEEvent({ type: "content_block_stop" }))
        .toEqual({ events: [], terminal: false });
    });

    it("ignores message_start", () => {
      expect(parseSSEEvent({ type: "message_start" }))
        .toEqual({ events: [], terminal: false });
    });

    it("ignores message_delta", () => {
      expect(parseSSEEvent({ type: "message_delta" }))
        .toEqual({ events: [], terminal: false });
    });

    it("ignores message_stop", () => {
      expect(parseSSEEvent({ type: "message_stop" }))
        .toEqual({ events: [], terminal: false });
    });

    it("ignores unknown event types", () => {
      expect(parseSSEEvent({ type: "telemetry.ping", data: {} }))
        .toEqual({ events: [], terminal: false });
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    it("returns empty for event without type field", () => {
      expect(parseSSEEvent({ data: "no type here" }))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for null input", () => {
      expect(parseSSEEvent(null))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for undefined input", () => {
      expect(parseSSEEvent(undefined))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for empty object", () => {
      expect(parseSSEEvent({}))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for primitive string input", () => {
      expect(parseSSEEvent("not an object" as unknown))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for numeric input", () => {
      expect(parseSSEEvent(42 as unknown))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for boolean input", () => {
      expect(parseSSEEvent(true as unknown))
        .toEqual({ events: [], terminal: false });
    });

    it("returns empty for array input", () => {
      expect(parseSSEEvent([] as unknown))
        .toEqual({ events: [], terminal: false });
    });
  });

  // ---- Partial chunk / multi-byte / special content ----

  describe("partial chunks and special content", () => {
    it("handles text_delta with unicode characters", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "こんにちは 🌍 café" },
      });
      expect(result.events).toEqual([
        { type: "text_delta", text: "こんにちは 🌍 café" },
      ]);
    });

    it("handles text_delta with multiline content", () => {
      const multiline = "line1\nline2\n\nline4";
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: multiline },
      });
      expect(result.events).toEqual([
        { type: "text_delta", text: multiline },
      ]);
    });

    it("handles text_delta with very long content", () => {
      const longText = "x".repeat(100_000);
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: longText },
      });
      expect(result.events[0]).toEqual({ type: "text_delta", text: longText });
    });

    it("handles tool_use with complex nested input", () => {
      const input = { nested: { deep: [1, 2, { a: true }] }, arr: [null, "x"] };
      const result = parseSSEEvent({
        type: "content_block_start",
        content_block: { type: "tool_use", name: "complex", input },
      });
      expect(result.events[0]).toEqual({
        type: "tool_use",
        name: "complex",
        input,
      });
    });

    it("handles tool_use with undefined input", () => {
      const result = parseSSEEvent({
        type: "content_block_start",
        content_block: { type: "tool_use", name: "noinput" },
      });
      expect(result.events[0]).toEqual({
        type: "tool_use",
        name: "noinput",
        input: undefined,
      });
    });

    it("handles agent.message with text containing special chars", () => {
      const result = parseSSEEvent({
        type: "agent.message",
        content: [{ type: "text", text: '<script>alert("xss")</script>' }],
      });
      expect(result.events).toEqual([
        { type: "text_delta", text: '<script>alert("xss")</script>' },
      ]);
    });

    it("handles session.error with non-string message field", () => {
      const result = parseSSEEvent({
        type: "session.error",
        error: { message: 42 },
      });
      expect(result).toEqual({
        events: [{ type: "error", error: "Unknown session error" }],
        terminal: true,
      });
    });

    it("handles session.status_idle with null stop_reason", () => {
      const result = parseSSEEvent({
        type: "session.status_idle",
        stop_reason: null,
      });
      expect(result).toEqual({
        events: [{ type: "done", stopReason: "end_turn" }],
        terminal: true,
      });
    });
  });

  // ---- Terminal flag correctness ----

  describe("terminal flag", () => {
    const terminalEvents = [
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      { type: "session.status_terminated" },
      { type: "session.error", error: { message: "err" } },
      { type: "session.deleted" },
    ];

    const nonTerminalEvents = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_start", content_block: { type: "tool_use", name: "t" } },
      { type: "content_block_stop" },
      { type: "agent.message", content: [{ type: "text", text: "hi" }] },
      { type: "agent.tool_use", name: "t", input: {} },
      { type: "agent.thinking", text: "hmm" },
      { type: "session.status_running" },
      { type: "message_start" },
      { type: "message_delta" },
      { type: "message_stop" },
      { type: "unknown.event" },
    ];

    for (const event of terminalEvents) {
      it(`marks ${event.type} as terminal`, () => {
        expect(parseSSEEvent(event).terminal).toBe(true);
      });
    }

    for (const event of nonTerminalEvents) {
      it(`marks ${event.type} as non-terminal`, () => {
        expect(parseSSEEvent(event).terminal).toBe(false);
      });
    }
  });

  // ---- Type discrimination ----

  describe("type discrimination", () => {
    it("produces correctly typed text_delta events", () => {
      const result = parseSSEEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      });
      const event = result.events[0];
      expect(event.type).toBe("text_delta");
      if (event.type === "text_delta") {
        // TypeScript narrows to TextDeltaEvent
        expect(event.text).toBe("hi");
      }
    });

    it("produces correctly typed tool_use events", () => {
      const result = parseSSEEvent({
        type: "content_block_start",
        content_block: { type: "tool_use", name: "calc", input: { x: 1 } },
      });
      const event = result.events[0];
      expect(event.type).toBe("tool_use");
      if (event.type === "tool_use") {
        expect(event.name).toBe("calc");
        expect(event.input).toEqual({ x: 1 });
      }
    });

    it("produces correctly typed error events", () => {
      const result = parseSSEEvent({
        type: "session.error",
        error: { message: "fail" },
      });
      const event = result.events[0];
      expect(event.type).toBe("error");
      if (event.type === "error") {
        expect(event.error).toBe("fail");
      }
    });

    it("produces correctly typed done events", () => {
      const result = parseSSEEvent({
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      });
      const event = result.events[0];
      expect(event.type).toBe("done");
      if (event.type === "done") {
        expect(event.stopReason).toBe("end_turn");
      }
    });
  });
});
