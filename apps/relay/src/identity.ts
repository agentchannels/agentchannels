import { createPublicKey, type KeyObject, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export function decodeBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

export function publicKeyFrom(raw: Uint8Array): KeyObject | null {
  if (raw.length !== ED25519_KEY_BYTES) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

export function signatureIsValid(
  publicKey: Uint8Array,
  message: string,
  signatureBase64: string,
): boolean {
  const key = publicKeyFrom(publicKey);
  const signature = decodeBase64(signatureBase64);
  if (key === null || signature?.length !== ED25519_SIGNATURE_BYTES)
    return false;
  return verify(null, Buffer.from(message, "utf8"), key, signature);
}
