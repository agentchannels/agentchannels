function redactAssignments(value: string): string {
  const key =
    "(?:access[ _-]?token|api[ _-]?key|authorization|bearer[ _-]?token|bot[ _-]?token|client[ _-]?(?:id|secret)|cookie|credential|enrollment(?:[ _-]?(?:token|authorization))?|password|private[ _-]?key|refresh[ _-]?token|secret|signing[ _-]?secret|token|webhook[ _-]?secret)";
  const quoted = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*:\s*)"(?:\\.|[^"\\])*"`,
    "gi",
  );
  const assignment = new RegExp(
    String.raw`((?:"|')?${key}(?:"|')?\s*(?:=>|[:=]|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`,
    "gi",
  );
  return value
    .replace(quoted, '$1"[redacted]"')
    .replace(assignment, "$1[redacted]");
}

/** Remove credentials and channel content before logs, persistence, or output. */
export function redactSensitiveText(value: string): string {
  return redactAssignments(value)
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted private key]",
    )
    .replace(
      /((?:serialized\s+)?credentials?\s*(?:[:=]|\bis\b)\s*)\{(?:[^{}]|\{[^{}]*\})*\}/gi,
      "$1[redacted credentials]",
    )
    .replace(
      /((?:channel[ _-]?body|raw[ _-]?(?:channel|request)?[ _-]?body|request[ _-]?body)\s*(?:[:=]|\bis\b)\s*)(?:\{(?:[^{}]|\{[^{}]*\})*\}|"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted raw body]",
    )
    .replace(/(?:xox[baprs]|xapp|xoxe)-[A-Za-z0-9-]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/(bearer\s+)[^\s,;}]+/gi, "$1[redacted]");
}

/** Render nested causes for operator diagnostics without exposing secrets. */
export function redactErrorDiagnostic(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  return redactSensitiveText(messages.join(" <- "));
}
