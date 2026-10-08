import { describe, expect, it } from "bun:test";

import { tokensMatch, trimTrailingAsciiWhitespace } from "../src/token.ts";

describe("trimTrailingAsciiWhitespace", () => {
  it.each([
    ["token \t\r\n", "token"],
    [" token", " token"],
    ["token ", "token "],
    ["token﻿", "token﻿"],
    [" \n", ""],
  ])("trims %j to %j", (input, expected) => {
    expect(
      trimTrailingAsciiWhitespace(Buffer.from(input, "utf8")).toString("utf8"),
    ).toBe(expected);
  });
});

describe("tokensMatch", () => {
  it.each([
    ["secret", "secret", true],
    ["secret", "secreT", false],
    ["secret", "secret-longer", false],
    ["secret", "", false],
  ])("compares %j with %j as %p", (expected, presented, match) => {
    expect(tokensMatch(Buffer.from(expected), Buffer.from(presented))).toBe(
      match,
    );
  });
});
