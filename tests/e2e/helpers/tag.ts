/**
 * Run-isolation tag helpers.
 *
 * Each e2e test run embeds a unique tag in the Slack message text so that
 * messages from different runs can be distinguished in the test channel.
 * The tag is also stored in the cassette fixture for traceability.
 */

import { randomBytes } from "node:crypto";

/**
 * Generate a unique run tag: ISO timestamp (15 digits) + 8 random hex chars.
 *
 * Format: `e2e-{15 digits}-{8 hex chars}`
 * Example: `e2e-202604131200000-a1b2c3d4`
 *
 * - The `e2e-` prefix makes tags easily identifiable in Slack channel history.
 * - The 15-digit timestamp is derived from the ISO date string by stripping all
 *   non-digit characters and taking the first 15 digits (YYYYMMDDTHHMMSS).
 * - The 8 hex chars (4 random bytes) provide per-run uniqueness guaranteeing
 *   no collision even within the same millisecond.
 *
 * Matches the AC 8 assertion regex: /^e2e-\d{15}-[0-9a-f]{8}$/
 */
export function makeRunTag(): string {
  // Strip all non-digit characters from the ISO string, then take the first 15.
  // e.g. "2026-04-13T12:00:00.000Z" → "20260413120000000" → "202604131200000"
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 15);
  // 4 random bytes → 8 hex chars for per-run uniqueness
  const rnd = randomBytes(4).toString("hex");
  return `e2e-${ts}-${rnd}`;
}
