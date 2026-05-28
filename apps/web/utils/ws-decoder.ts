import { WsMessage, type SensorFrameMessage } from "~/types/ws";
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
  | { kind: "unknown_type"; type: string }
  | { kind: "parse_error"; reason: string };

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
  const parsed = WsMessage.safeParse(json);
  if (parsed.success) return { kind: "message", message: parsed.data };
  // Differentiate unknown event_type from a schema bug on a known type.
  const typeStr = (json as { type: string }).type;
  const knownTypes = ["sensor.frame.captured", "presence.snapshot", "presence.changed"];
  if (!knownTypes.includes(typeStr)) {
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
 *
 * `event_id` falls back to `frame_id` when the server omits the
 * `last_event_id` cursor (older server build). The id must be
 * stable across re-deliveries so the at-least-once dedup in the
 * alert store works.
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
