import { z } from 'zod';

export const RELAY_PROTOCOL_VERSION = 1;
export const MAX_RELAY_FRAME_BYTES = 256 * 1024;

export const relayDeliverySchema = z.object({
  version: z.literal(RELAY_PROTOCOL_VERSION),
  type: z.literal('deliver'),
  messageId: z.string().min(1),
  senderAgentId: z.string().min(1),
  recipientAgentId: z.string().min(1),
  credentialProof: z.string().min(1),
  content: z.string().min(1),
});
export type RelayDelivery = z.infer<typeof relayDeliverySchema>;

export const relayResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    ok: z.literal(true),
    provider: z.string().min(1),
    delivery: z.enum(['inject', 'steer']),
    receipt: z.string().optional(),
    /** The recipient session's opaque key, so the delivery can be credited and requeued. */
    session: z.string().optional(),
  }),
  z.object({
    version: z.literal(RELAY_PROTOCOL_VERSION),
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);
export type RelayResponse = z.infer<typeof relayResponseSchema>;

export function encodeRelayFrame(value: RelayDelivery | RelayResponse): string {
  return `${JSON.stringify(value)}\n`;
}

export function decodeRelayDelivery(frame: string): RelayDelivery {
  const parsed: unknown = JSON.parse(frame);
  return relayDeliverySchema.parse(parsed);
}

export function decodeRelayResponse(frame: string): RelayResponse {
  const parsed: unknown = JSON.parse(frame);
  return relayResponseSchema.parse(parsed);
}
