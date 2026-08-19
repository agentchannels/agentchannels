import { describe, expect, it } from "vitest";

import { assertTransition, canTransition } from "../src/core/session-state.js";

describe("Session state transitions", () => {
  it("supports the execution, interaction, completion, and explicit resume paths", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting")).toBe(true);
    expect(canTransition("waiting", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("completed", "queued")).toBe(true);
    expect(canTransition("running", "stopped")).toBe(true);
    expect(canTransition("stopped", "queued")).toBe(true);
  });

  it("keeps failure terminal and distinguishes stop from failure", () => {
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "stopped")).toBe(true);
    expect(() => assertTransition("failed", "running")).toThrow(
      "failed -> running",
    );
  });
});
