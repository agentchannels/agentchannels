/**
 * Walk an error and its `cause` chain, oldest wrapper first.
 *
 * Cycle-safe: a `cause` that points back at an ancestor terminates the walk
 * instead of looping. Every caller that inspects nested failures - error
 * classification, operator diagnostics, redaction - uses this one traversal.
 */
export function errorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}
