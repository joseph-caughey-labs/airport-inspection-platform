import { z } from "zod";
import type { AlertSeverity } from "./alert";

/**
 * Frontend zod mirrors for the WebSocket envelopes the ws-broadcaster
 * emits. The server-side schema lives in `@aip/shared-contracts/ws`;
 * the frontend keeps a narrower local schema that captures only the
 * fields the UI actually consumes (so adding a server-side field
 * doesn't force a frontend redeploy).
 *
 * Decoded into a discriminated union by `utils/ws-decoder.ts` — that
 * module is the single funnel between the raw socket and the stores.
 */

const SensorFramePayload = z.object({
  sensor_id: z.string().min(1),
  sensor_type: z.string().min(1),
  frame_id: z.string().min(1),
  captured_at: z.string().datetime(),
  geo: z.object({
    lat: z.number(),
    lng: z.number(),
    alt_m: z.number().optional(),
  }),
  metadata: z.record(z.unknown()).optional(),
});

export const SensorFrameMessage = z.object({
  type: z.literal("sensor.frame.captured"),
  schema_version: z.string(),
  timestamp: z.string().datetime(),
  last_event_id: z.string().min(1).optional(),
  payload: SensorFramePayload,
});
export type SensorFrameMessage = z.infer<typeof SensorFrameMessage>;

const PresenceSubscriber = z.object({
  connection_id: z.string(),
  role: z.string(),
  connected_at: z.string().datetime(),
});

const PresencePayload = z.object({
  airport_id: z.string().uuid(),
  count: z.number().int().nonnegative(),
  subscribers: z.array(PresenceSubscriber),
});

export const PresenceSnapshotMessage = z.object({
  type: z.literal("presence.snapshot"),
  schema_version: z.string(),
  timestamp: z.string().datetime(),
  payload: PresencePayload,
});
export type PresenceSnapshotMessage = z.infer<typeof PresenceSnapshotMessage>;

export const PresenceChangedMessage = z.object({
  type: z.literal("presence.changed"),
  schema_version: z.string(),
  timestamp: z.string().datetime(),
  payload: PresencePayload,
});
export type PresenceChangedMessage = z.infer<typeof PresenceChangedMessage>;

export const WsMessage = z.discriminatedUnion("type", [
  SensorFrameMessage,
  PresenceSnapshotMessage,
  PresenceChangedMessage,
]);
export type WsMessage = z.infer<typeof WsMessage>;

/** Re-exported so consumers don't reach back into the alert types module just for the type. */
export type { AlertSeverity };
