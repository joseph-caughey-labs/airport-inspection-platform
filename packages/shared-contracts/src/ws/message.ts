import { z } from "zod";

/**
 * Envelope for every WebSocket message between ws-broadcaster and clients.
 *
 * - `type`            Discriminator (e.g. "incident.created").
 * - `schema_version`  Schema version of `payload`.
 * - `payload`         Typed in concrete subtypes.
 * - `timestamp`       Server-side send time.
 * - `message_id`      Optional client-replay key.
 * - `last_event_id`   Optional resume-from cursor, set by server when
 *                     hydrating a freshly connected client.
 */
export const WsMessage = z.object({
  type: z.string().min(1),
  schema_version: z.string().regex(/^v\d+(\.\d+)?$/),
  payload: z.unknown(),
  timestamp: z.string().datetime(),
  message_id: z.string().uuid().optional(),
  last_event_id: z.string().min(1).optional(),
});
export type WsMessage = z.infer<typeof WsMessage>;
