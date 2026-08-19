import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  localToRelayMessageSchema,
  relayToLocalMessageSchema,
} from "../src/protocol/messages.js";

type Fixture = {
  protocol: number;
  accepted: { direction: "relayToLocal" | "localToRelay"; message: unknown }[];
  rejected: { errorCode: string; message: unknown }[];
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/protocol-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

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
