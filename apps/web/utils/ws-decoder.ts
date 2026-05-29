import { AiDetectionMessage, WsMessage, type SensorFrameMessage } from "~/types/ws";
import type { AlertItem } from "~/types/alert";
import { severityFromEventType, titleForEventType } from "./alerts";

/**
 * Outcome of decoding a single raw WS frame. Pure — no side effects,
 * no Vue. Callers (the WS client + tests) decide what to do with
 * each variant. `unknown_type` is distinct from `parse_error` so
 * future server versions that introduce new event types don't show
 * up as malformed in the metrics.
 */
export type DecodeResult =
  | { kind: "message"; message: WsMessage }
  | { kind: "detection"; message: AiDetectionMessage }
  | { kind: "unknown_type"; type: string }
  | { kind: "parse_error"; reason: string };

const AI_DETECTION_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;
const KNOWN_DISCRIMINATED_TYPES = new Set([
  "sensor.frame.captured",
  "presence.snapshot",
  "presence.changed",
]);

export function decodeWsFrame(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "parse_error",
      reason: err instanceof Error ? err.message : "invalid JSON",
    };
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !("type" in json) ||
    typeof (json as { type: unknown }).type !== "string"
  ) {
    return { kind: "parse_error", reason: "missing type field" };
  }
  const typeStr = (json as { type: string }).type;

  // AI detection events have a regex-shaped event_type (one per
  // class) so they don't sit in the discriminated union. Try them
  // first — if the type matches the pattern but the payload is
  // malformed we return parse_error rather than unknown_type, since
  // the type is structurally a detection.
  if (AI_DETECTION_TYPE_RE.test(typeStr)) {
    const det = AiDetectionMessage.safeParse(json);
    if (det.success) return { kind: "detection", message: det.data };
    const issue = det.error.issues[0];
    return {
      kind: "parse_error",
      reason: issue ? `${issue.path.join(".")}: ${issue.message}` : "schema violation",
    };
  }

  const parsed = WsMessage.safeParse(json);
  if (parsed.success) return { kind: "message", message: parsed.data };
  if (!KNOWN_DISCRIMINATED_TYPES.has(typeStr)) {
    return { kind: "unknown_type", type: typeStr };
  }
  const issue = parsed.error.issues[0];
  return {
    kind: "parse_error",
    reason: issue ? `${issue.path.join(".")}: ${issue.message}` : "schema violation",
  };
}

/**
 * Builds an AlertItem from a SensorFrameMessage. Pure — used by the
 * WS client and by tests that want to drive the alert store
 * without spinning up a real WebSocket.
 */
export function alertFromSensorFrame(
  msg: SensorFrameMessage,
  airportId: string,
  receivedAt: string = new Date().toISOString(),
): AlertItem {
  const id = msg.last_event_id ?? msg.payload.frame_id;
  return {
    id,
    event_type: msg.type,
    severity: severityFromEventType(msg.type),
    title: titleForEventType(msg.type),
    detail: `${msg.payload.sensor_type} · ${msg.payload.sensor_id}`,
    sensor_id: msg.payload.sensor_id,
    airport_id: airportId,
    received_at: receivedAt,
  };
}

/**
 * Builds an AlertItem from an AiDetectionMessage. Severity comes
 * straight from the detector's `severity_hint` (already calibrated +
 * smoothed server-side); confidence flows through into the title so
 * the operator sees the numeric value without diving into the
 * envelope.
 *
 * The "low confidence" indicator the AC mentions is driven by
 * `metadata.low_confidence = true` when the calibrated confidence
 * fell below 0.5 — typically the weather-degraded scenario from T-306.
 */
export function alertFromDetection(
  msg: AiDetectionMessage,
  airportId: string,
  receivedAt: string = new Date().toISOString(),
): AlertItem {
  const id = msg.last_event_id ?? msg.payload.detection_id;
  const confidencePct = Math.round(msg.payload.confidence * 100);
  const className = msg.payload.detection_class.toUpperCase();
  const lowConf = isLowConfidence(msg);
  return {
    id,
    event_type: msg.type,
    severity: msg.payload.severity_hint,
    title: `${className} detected · ${confidencePct}%`,
    detail: msg.payload.sensor_id,
    sensor_id: msg.payload.sensor_id,
    airport_id: airportId,
    received_at: receivedAt,
    ...(lowConf ? { low_confidence: true } : {}),
  };
}

/**
 * Returns true when the detection's confidence is below the
 * "low confidence" indicator threshold. The AlertFeed uses this to
 * render the "low confidence" badge from the T-310 AC.
 */
export function isLowConfidence(msg: AiDetectionMessage, threshold = 0.5): boolean {
  return msg.payload.confidence < threshold;
}
