import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  authenticationPayload,
  localToRelayMessageSchema,
  PROTOCOL,
  relayToLocalMessageSchema,
} from "../src/index.ts";
import v2 from "./v2.json" with { type: "json" };

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
  .parse(v2);

describe("protocol 2 conformance fixture", () => {
  it("accepts every Relay-to-local fixture message", () => {
    expect(fixture.protocol).toBe(PROTOCOL);
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

describe("authenticationPayload", () => {
  it("binds the signature to the relay origin, the installation, and the nonce", () => {
    const payload = authenticationPayload({
      origin: "https://relay.example.com/",
      installationId: "in_one",
      nonce: "nonce-value",
    });
    expect(payload).toBe(
      "agentchannels-relay-auth:v2\nhttps://relay.example.com\nin_one\nnonce-value",
    );
    expect(
      authenticationPayload({
        origin: "https://other.example.com",
        installationId: "in_one",
        nonce: "nonce-value",
      }),
    ).not.toBe(payload);
  });
});
