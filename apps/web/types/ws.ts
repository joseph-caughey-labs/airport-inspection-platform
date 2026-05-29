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

const BoundingBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  alt_m: z.number().optional(),
});

const DetectionPayload = z.object({
  detection_id: z.string().min(1),
  sensor_id: z.string().min(1),
  frame_id: z.string().min(1),
  detection_class: z.enum(["fod", "crack", "snowbank", "wildlife", "anomaly"]),
  confidence: z.number().min(0).max(1),
  severity_hint: z.enum(["critical", "high", "medium", "low", "info"]),
  bbox: BoundingBox.optional(),
  captured_at: z.string().datetime(),
  geo: GeoPoint.optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * AI detection envelope. The wire-level event_type is
 * `ai.detection.<class>.emitted`, which the ws-broadcaster forwards
 * verbatim into the WS message's `type` field. We accept that
 * regex-shaped string rather than enumerate every literal so a new
 * detection class doesn't force a frontend rebuild.
 */
export const AiDetectionMessage = z.object({
  type: z.string().regex(/^ai\.detection\.[a-z_]+\.emitted$/),
  schema_version: z.string(),
  timestamp: z.string().datetime(),
  last_event_id: z.string().min(1).optional(),
  payload: DetectionPayload,
});
export type AiDetectionMessage = z.infer<typeof AiDetectionMessage>;
export type DetectionClass = AiDetectionMessage["payload"]["detection_class"];

export const WsMessage = z.discriminatedUnion("type", [
  SensorFrameMessage,
  PresenceSnapshotMessage,
  PresenceChangedMessage,
]);
export type WsMessage = z.infer<typeof WsMessage>;

/** Re-exported so consumers don't reach back into the alert types module just for the type. */
export type { AlertSeverity };
