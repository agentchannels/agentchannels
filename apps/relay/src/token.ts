import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

export function trimTrailingAsciiWhitespace(value: Buffer): Buffer {
  let end = value.length;
  while (end > 0 && ASCII_WHITESPACE.has(value[end - 1] ?? 0)) end -= 1;
  return value.subarray(0, end);
}

const comparisonKey = randomBytes(32);

function fingerprint(value: Uint8Array): Buffer {
  return createHmac("sha256", comparisonKey).update(value).digest();
}

export function tokensMatch(
  expected: Uint8Array,
  presented: Uint8Array,
): boolean {
  return timingSafeEqual(fingerprint(expected), fingerprint(presented));
}
