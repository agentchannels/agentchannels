import { z } from "zod";

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

export const connectorTypeSchema = z.string().regex(IDENTIFIER_PATTERN);
export const routeIdSchema = z.string().regex(ROUTE_ID_PATTERN);
