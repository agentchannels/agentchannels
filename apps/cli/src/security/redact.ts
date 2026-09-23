import { errorChain } from "../error-chain.ts";

/**
 * The one redaction pass. Every output path - CLI stdout and stderr, `--json`,
 * daemon logs, persisted setup errors, and channel delivery bodies - runs text
 * through this function, so a rule added here cannot be missing from one of them.
 */

const CREDENTIAL_KEY =
  "(?:access[ _-]?token|api[ _-]?key|authorization|bearer[ _-]?token|bot[ _-]?token|client[ _-]?(?:id|secret)|cookie|credential|enrollment(?:[ _-]?(?:token|authorization))?|password|private[ _-]?key|refresh[ _-]?token|secret|signing[ _-]?secret|token|webhook[ _-]?secret)";

const BODY_KEY =
  "(?:channel[ _-]?body|raw[ _-]?(?:channel|request)?[ _-]?body|request[ _-]?body)";

const credentialJson = new RegExp(
  String.raw`((?:"|')?${CREDENTIAL_KEY}(?:"|')?\s*:\s*)"(?:\\.|[^"\\])*"`,
  "gi",
);
const credentialAssignment = new RegExp(
  String.raw`((?:"|')?${CREDENTIAL_KEY}(?:"|')?\s*(?:=>|[:=]|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`,
  "gi",
);
const bodyObject = new RegExp(
  String.raw`((?:"|')?${BODY_KEY}(?:"|')?\s*(?:[:=]|\bis\b)\s*)\{(?:[^{}]|\{[^{}]*\})*\}`,
  "gi",
);
const bodyJson = new RegExp(
  String.raw`((?:"|')?${BODY_KEY}(?:"|')?\s*:\s*)"(?:\\.|[^"\\])*"`,
  "gi",
);
const bodyAssignment = new RegExp(
  String.raw`((?:"|')?${BODY_KEY}(?:"|')?\s*(?:[:=]|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`,
  "gi",
);
const credentialObject =
  /((?:serialized\s+)?credentials?\s*(?:[:=]|\bis\b)\s*)\{(?:[^{}]|\{[^{}]*\})*\}/gi;
const privateKeyBlock =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;
const slackToken = /(?:xox[baprs]|xapp|xoxe)-[A-Za-z0-9-]+/gi;
const apiKeyToken = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const bearerValue = /(bearer\s+)[^\s,;}]+/gi;
const queryParameter =
  /((?:"|')?(?:token|secret|authorization)(?:"|')?[ _-]*(?:query|parameter)?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi;

/** Remove credentials, private keys, and channel content before any output. */
export function redactSensitiveText(value: string): string {
  return (
    value
      // Serialized objects first: redacting one wholesale is safer than letting
      // the per-key rules below rewrite it field by field and leave the rest.
      .replace(credentialObject, "$1[redacted credentials]")
      .replace(credentialJson, '$1"[redacted]"')
      .replace(credentialAssignment, "$1[redacted]")
      .replace(bodyObject, "$1[redacted raw body]")
      .replace(bodyJson, '$1"[redacted]"')
      .replace(bodyAssignment, "$1[redacted]")
      .replace(privateKeyBlock, "[redacted private key]")
      .replace(slackToken, "[redacted]")
      .replace(apiKeyToken, "[redacted]")
      .replace(bearerValue, "$1[redacted]")
      .replace(queryParameter, "$1[redacted]")
  );
}

/** Render nested causes for operator diagnostics without exposing secrets. */
export function redactErrorDiagnostic(error: unknown): string {
  const messages = errorChain(error).map((item) =>
    item instanceof Error ? item.message : String(item),
  );
  return redactSensitiveText(messages.join(" <- "));
}
