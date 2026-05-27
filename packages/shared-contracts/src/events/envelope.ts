import { z } from "zod";

/**
 * Base envelope wrapping every internal event published on Redis. Concrete
 * event types extend this with a typed `payload` and a discriminating
 * `event_type` literal.
 *
 * - `event_id`        Globally unique id for this delivery.
 * - `event_type`      Discriminator (e.g. "sensor.frame.captured").
 * - `schema_version`  Payload schema version ("v1", "v1.2", ...).
 * - `source`          Originating service identity.
 * - `timestamp`       ISO-8601 occurrence time.
 * - `correlation_id`  Threads across services for a single logical flow.
 * - `idempotency_key` Used for dedup; same key → same effect.
 */
export const EventEnvelope = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().min(1),
  schema_version: z.string().regex(/^v\d+(\.\d+)?$/, "schema_version must match v\\d+(.\\d+)?"),
  source: z.object({
    service: z.string().min(1),
    instance_id: z.string().min(1).optional(),
  }),
  timestamp: z.string().datetime(),
  correlation_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
