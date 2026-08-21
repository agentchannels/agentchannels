import { z } from "zod";

/**
 * A connector is an opaque routing key on the wire. The Relay validates the same
 * shape, so a new provider needs no protocol change and no coordinated release.
 */
export const connectorTypeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

export const relayToLocalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("challenge"),
    protocol: z.literal(1),
    nonce: z.string().min(32),
  }),
  z.object({ type: z.literal("authenticated"), protocol: z.literal(1) }),
  z.object({
    type: z.literal("webhook"),
    protocol: z.literal(1),
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
    protocol: z.literal(1),
    code: z.string(),
    message: z.string(),
  }),
]);

export const localToRelayMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authenticate"),
    protocol: z.literal(1),
    installationId: z.string().min(1),
    signatureBase64: z.string().min(1),
  }),
  z.object({
    type: z.literal("sync_bindings"),
    protocol: z.literal(1),
    bindings: z.array(
      z.object({
        bindingId: z.string().min(1),
        connector: connectorTypeSchema,
      }),
    ),
  }),
  z.object({
    type: z.literal("webhook_response"),
    protocol: z.literal(1),
    requestId: z.string().min(1),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().default(""),
  }),
]);

export type RelayToLocalMessage = z.infer<typeof relayToLocalMessageSchema>;
export type LocalToRelayMessage = z.infer<typeof localToRelayMessageSchema>;
