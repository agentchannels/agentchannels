import { z } from "zod";

import { connectorTypeSchema } from "./identifiers.ts";

export const PROTOCOL = 1;

const protocol = z.literal(PROTOCOL);

export const relayToLocalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("challenge"),
    protocol,
    nonce: z.string().min(32),
  }),
  z.object({ type: z.literal("authenticated"), protocol }),
  z.object({
    type: z.literal("webhook"),
    protocol,
    requestId: z.string().min(1),
    bindingId: z.string().min(1),
    connector: connectorTypeSchema,
    receivedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    headers: z.record(z.string(), z.string()),
    rawBodyBase64: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    protocol,
    code: z.string(),
    message: z.string(),
  }),
]);

export const localToRelayMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authenticate"),
    protocol,
    installationId: z.string().min(1),
    signatureBase64: z.string().min(1),
  }),
  z.object({
    type: z.literal("sync_bindings"),
    protocol,
    bindings: z.array(
      z.object({
        bindingId: z.string().min(1),
        connector: connectorTypeSchema,
      }),
    ),
  }),
  z.object({
    type: z.literal("webhook_response"),
    protocol,
    requestId: z.string().min(1),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().default(""),
  }),
]);

export type RelayToLocalMessage = z.infer<typeof relayToLocalMessageSchema>;
export type LocalToRelayMessage = z.infer<typeof localToRelayMessageSchema>;
