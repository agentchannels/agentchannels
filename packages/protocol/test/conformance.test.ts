import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  localToRelayMessageSchema,
  relayToLocalMessageSchema,
} from "../src/index.ts";
import v1 from "./v1.json" with { type: "json" };

const fixture = z
  .object({
    protocol: z.number(),
    accepted: z.array(
      z.object({
        direction: z.enum(["relayToLocal", "localToRelay"]),
        message: z.unknown(),
      }),
    ),
    rejected: z.array(
      z.object({ errorCode: z.string(), message: z.unknown() }),
    ),
  })
  .parse(v1);

describe("protocol 1 conformance fixture", () => {
  it("accepts every Relay-to-local fixture message", () => {
    expect(fixture.protocol).toBe(1);
    for (const entry of fixture.accepted.filter(
      ({ direction }) => direction === "relayToLocal",
    )) {
      expect(relayToLocalMessageSchema.safeParse(entry.message).success).toBe(
        true,
      );
    }
  });

  it("accepts every local-to-Relay fixture message", () => {
    for (const entry of fixture.accepted.filter(
      ({ direction }) => direction === "localToRelay",
    )) {
      expect(localToRelayMessageSchema.safeParse(entry.message).success).toBe(
        true,
      );
    }
  });

  it("rejects unsupported protocol values", () => {
    for (const entry of fixture.rejected) {
      expect(localToRelayMessageSchema.safeParse(entry.message).success).toBe(
        false,
      );
    }
    expect(fixture.rejected.map(({ errorCode }) => errorCode)).toContain(
      "unsupported_protocol",
    );
  });
});
