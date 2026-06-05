/**
 * Connection + tuning config for the load suite, all overridable by env
 * so the same scenarios run against a local compose stack or a remote
 * staging host. Defaults target the published ports in the repo's
 * `docker-compose.yml`.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export const env = {
  redis: {
    host: str("LOAD_REDIS_HOST", "127.0.0.1"),
    port: num("LOAD_REDIS_PORT", 6379),
  },
  /** nginx reverse proxy — the single public edge (REST + WS). */
  edge: {
    host: str("LOAD_EDGE_HOST", "127.0.0.1"),
    port: num("LOAD_EDGE_PORT", 3000),
  },
  /**
   * Per-service `/metrics` ports (host-published in docker-compose.yml).
   * The load thresholds are asserted by scraping these directly rather
   * than through nginx, so a scenario can attribute latency/errors to a
   * specific service.
   */
  metricsPorts: {
    "api-gateway": num("LOAD_PORT_API_GATEWAY", 3001),
    "reference-data": num("LOAD_PORT_REFERENCE_DATA", 3002),
    "sensor-gateway": num("LOAD_PORT_SENSOR_GATEWAY", 3003),
    "event-pipeline": num("LOAD_PORT_EVENT_PIPELINE", 3004),
    "ws-broadcaster": num("LOAD_PORT_WS_BROADCASTER", 3005),
    "incident-service": num("LOAD_PORT_INCIDENT_SERVICE", 3006),
    "audit-service": num("LOAD_PORT_AUDIT_SERVICE", 3007),
    "notification-service": num("LOAD_PORT_NOTIFICATION_SERVICE", 3008),
  } as const,
  /** JWT signer config — MUST match the stack's `JWT_SECRET` / issuer
   * so WS connections authenticate. Compose wires a CI-friendly secret. */
  jwt: {
    secret: str("LOAD_JWT_SECRET", "ci-integration-secret-must-be-at-least-32-bytes-long"),
    issuer: str("LOAD_JWT_ISSUER", "aip-api-gateway"),
  },
  /** Seeded airports (db/seed). SFO has 3 cameras, JFK has 1. */
  airports: {
    sfo: str("LOAD_AIRPORT_SFO", "11111111-1111-1111-1111-aaaaaaaaaaaa"),
    jfk: str("LOAD_AIRPORT_JFK", "11111111-1111-1111-1111-bbbbbbbbbbbb"),
  },
  /** Compose container names — used by the docker fault-injection lever. */
  containers: {
    redis: str("LOAD_CONTAINER_REDIS", "aip-redis"),
    postgres: str("LOAD_CONTAINER_POSTGRES", "aip-postgres"),
    eventPipeline: str("LOAD_CONTAINER_EVENT_PIPELINE", "aip-event-pipeline"),
    aiInference: str("LOAD_CONTAINER_AI_INFERENCE", "aip-ai-inference"),
    wsBroadcaster: str("LOAD_CONTAINER_WS_BROADCASTER", "aip-ws-broadcaster"),
  },
} as const;

export type ServiceName = keyof typeof env.metricsPorts;

/** Canonical Redis channels (mirror @aip/redis-client conventions). */
export const channels = {
  /** Ingestion: event-pipeline subscribes here. */
  sensorFrameCaptured: "sensor.frame.captured",
  /** Broadcast: ws-broadcaster pattern-subscribes `events.broadcast.*`. */
  broadcastFor: (airportId: string) => `events.broadcast.${airportId}`,
} as const;
