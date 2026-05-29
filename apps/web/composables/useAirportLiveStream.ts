import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useAlertsStore } from "~/stores/alerts";
import { usePresenceStore } from "~/stores/presence";
import { useSystemStore } from "~/stores/system";
import { alertFromDetection, alertFromSensorFrame } from "~/utils/ws-decoder";
import type { AiDetectionMessage } from "~/types/ws";
import { WsClient, type WsConnectionState } from "./useWebSocket";

export interface UseAirportLiveStreamOptions {
  airportId: string;
  /** Called on each sensor frame so the map can pulse the marker. */
  onSensorFrame?: (sensorId: string) => void;
  /** Called on each AI detection so the map can overlay a bbox (future). */
  onDetection?: (detection: AiDetectionMessage) => void;
  /** Override the URL builder (tests). */
  buildUrl?: (airportId: string) => string;
}

/**
 * Orchestrator composable. Mounts a `WsClient` targeting
 * `/ws/v1/airport/:airportId/events`, parses incoming frames, and
 * fans them into the alert + presence stores plus the optional
 * `onSensorFrame` callback used by the map for pulse animations.
 *
 * Lifecycle bound to the component: connects on mount, disposes
 * on unmount, no orphaned sockets across route changes.
 *
 * `last_event_id` resume uses the freshest alert in the store as
 * the cursor, so refreshing the tab or losing the socket replays
 * just the gap rather than the full retention window.
 */
export function useAirportLiveStream(opts: UseAirportLiveStreamOptions) {
  const system = useSystemStore();
  const alerts = useAlertsStore();
  const presence = usePresenceStore();

  const client = shallowRef<WsClient | null>(null);
  const state = ref<WsConnectionState>("disconnected");

  const buildUrl =
    opts.buildUrl ??
    ((airportId: string) => {
      const config = useRuntimeConfig();
      // Browser only — relative URL keeps the same origin so it goes through NGINX.
      const wsBase = config.public["wsBaseUrl"] as string | undefined;
      const base = wsBase ?? "/ws/v1";
      const proto =
        typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
      const host = typeof window !== "undefined" ? window.location.host : "";
      const path = base.endsWith("/") ? base.slice(0, -1) : base;
      return `${proto}://${host}${path}/airport/${airportId}/events`;
    });

  const lastEventId = (): string | undefined => {
    const newest = alerts.forAirport(opts.airportId)[0];
    return newest?.id;
  };

  onMounted(() => {
    alerts.setFeedState("loading");
    client.value = new WsClient({
      url: buildUrl(opts.airportId),
      lastEventId,
      onState(s) {
        state.value = s;
        // Map WS state into the global system store so the nav pill reflects reality.
        const sysState =
          s === "connected"
            ? "connected"
            : s === "connecting" || s === "reconnecting"
              ? "connecting"
              : "disconnected";
        system.setConnection(sysState);
        if (s === "connected") {
          alerts.setFeedState("ready");
          if (alerts.reconnectCount > 0) alerts.noteReconnect();
        }
        if (s === "reconnecting") alerts.noteReconnect();
      },
      onFrame(result) {
        if (result.kind === "parse_error") {
          alerts.setFeedState("error", result.reason);
          return;
        }
        if (result.kind === "detection") {
          alerts.push(alertFromDetection(result.message, opts.airportId, result.message.timestamp));
          opts.onDetection?.(result.message);
          return;
        }
        if (result.kind !== "message") {
          return;
        }
        const msg = result.message;
        if (msg.type === "sensor.frame.captured") {
          alerts.push(alertFromSensorFrame(msg, opts.airportId, msg.timestamp));
          opts.onSensorFrame?.(msg.payload.sensor_id);
        } else if (msg.type === "presence.snapshot" || msg.type === "presence.changed") {
          presence.set(msg.payload.airport_id, msg.payload.subscribers);
        }
      },
    });
    client.value.start();
  });

  onBeforeUnmount(() => {
    client.value?.dispose();
    client.value = null;
    state.value = "disconnected";
    system.setConnection("disconnected");
  });

  return {
    state,
  };
}
