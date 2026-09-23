import { z } from "zod";

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

export const connectorTypeSchema = z.string().regex(IDENTIFIER_PATTERN);
