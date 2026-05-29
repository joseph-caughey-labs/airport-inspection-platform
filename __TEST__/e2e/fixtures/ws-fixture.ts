import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * Scripted WebSocket fixture. Uses Playwright's `routeWebSocket` to
 * intercept the frontend's connection to `/ws/v1/airport/:id/events`
 * so we can drive the live-stream timeline from the test:
 *
 *   - `send(envelope)`       — pushes a single frame to the page
 *   - `closeServerSide()`    — simulates the broadcaster going down
 *   - `waitForReconnect()`   — resolves on the next reconnect attempt
 *   - `lastConnectUrl()`     — what the page used for the most recent
 *                              connect (lets us assert on
 *                              ?last_event_id resume)
 *
 * The fixture is decoupled from the real ws-broadcaster on purpose:
 * the test asserts the frontend's contract, not the server's. A
 * future integration test in T-507 swaps this for the dockerized
 * broadcaster.
 */
export interface WsFixture {
  send(envelope: unknown): Promise<void>;
  closeServerSide(): Promise<void>;
  waitForReconnect(timeoutMs?: number): Promise<URL>;
  lastConnectUrl(): URL | undefined;
  connectionCount(): number;
}

export interface WsFixtureOptions {
  /** URL pattern to intercept. Default matches the `/ws/v1/airport/.../events` path. */
  urlPattern?: string | RegExp;
}

const DEFAULT_PATTERN = /\/ws\/v1\/airport\/[0-9a-f-]+\/events(\?.*)?$/i;

export async function installWsFixture(
  page: Page,
  opts: WsFixtureOptions = {},
): Promise<WsFixture> {
  let activeRoute: WebSocketRoute | undefined;
  const connectUrls: URL[] = [];
  const reconnectWaiters: Array<(url: URL) => void> = [];
  let connections = 0;

  await page.routeWebSocket(opts.urlPattern ?? DEFAULT_PATTERN, (ws) => {
    activeRoute = ws;
    connections++;
    const u = new URL(ws.url());
    connectUrls.push(u);
    // Notify anyone awaiting a reconnect (skip the first since that's
    // the initial connect — callers explicitly opt into waiting).
    const waiter = reconnectWaiters.shift();
    if (waiter) waiter(u);
  });

  return {
    async send(envelope) {
      if (!activeRoute) {
        throw new Error("ws-fixture: no active WS — call after the page has connected");
      }
      activeRoute.send(JSON.stringify(envelope));
    },
    async closeServerSide() {
      if (!activeRoute) return;
      const target = activeRoute;
      activeRoute = undefined;
      await target.close({ code: 1011, reason: "fixture-simulated outage" });
    },
    async waitForReconnect(timeoutMs = 30_000) {
      const startCount = connections;
      const deadline = Date.now() + timeoutMs;
      // Race two paths: the inline waiter (set by the next route fire)
      // and a poll fallback in case the route handler fires between
      // when we push the waiter and when the schedule executes.
      let resolver: ((u: URL) => void) | undefined;
      const waited = new Promise<URL>((resolve) => {
        resolver = resolve;
        reconnectWaiters.push(resolve);
      });
      while (Date.now() < deadline) {
        if (connections > startCount && connectUrls.at(-1)) {
          // Strip the inline waiter — already satisfied.
          const idx = reconnectWaiters.indexOf(resolver!);
          if (idx >= 0) reconnectWaiters.splice(idx, 1);
          return connectUrls.at(-1)!;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Fall through to the inline waiter with a hard timeout error.
      const timeout = new Promise<URL>((_, reject) =>
        setTimeout(() => reject(new Error("waitForReconnect timed out")), 500),
      );
      return Promise.race([waited, timeout]);
    },
    lastConnectUrl() {
      return connectUrls.at(-1);
    },
    connectionCount() {
      return connections;
    },
  };
}

/**
 * Convenience builders for the canonical envelope shapes the
 * frontend zod schemas in `apps/web/types/ws.ts` will accept.
 */
export function sensorFrame(opts: {
  airportId: string;
  sensorId: string;
  eventId: string;
  frameId: string;
  capturedAt?: string;
  geo?: { lat: number; lng: number; alt_m?: number };
}) {
  return {
    type: "sensor.frame.captured",
    schema_version: "v1",
    timestamp: opts.capturedAt ?? new Date().toISOString(),
    last_event_id: opts.eventId,
    payload: {
      sensor_id: opts.sensorId,
      sensor_type: "camera",
      frame_id: opts.frameId,
      captured_at: opts.capturedAt ?? new Date().toISOString(),
      geo: opts.geo ?? { lat: 37.6213, lng: -122.379, alt_m: 4 },
      metadata: { width: 1920, height: 1080 },
    },
  };
}

export function presenceSnapshot(opts: { airportId: string; count?: number }) {
  return {
    type: "presence.snapshot",
    schema_version: "v1",
    timestamp: new Date().toISOString(),
    payload: {
      airport_id: opts.airportId,
      count: opts.count ?? 1,
      subscribers: Array.from({ length: opts.count ?? 1 }, (_, i) => ({
        connection_id: `e2e-conn-${i}`,
        role: "operator",
        connected_at: new Date().toISOString(),
      })),
    },
  };
}

/**
 * AI detection envelope as it lands on the WS broadcaster after the
 * outbox/bridge round-trip. Mirrors `AiDetectionMessage` in
 * `apps/web/types/ws.ts`; the frontend decoder validates the same
 * shape we send here, so a contract drift fails the e2e immediately.
 */
export function aiDetection(opts: {
  airportId: string;
  sensorId: string;
  eventId: string;
  detectionId: string;
  frameId: string;
  detectionClass: "fod" | "crack" | "snowbank" | "wildlife" | "anomaly";
  confidence: number;
  severityHint: "critical" | "high" | "medium" | "low" | "info";
  bbox?: { x: number; y: number; w: number; h: number };
  capturedAt?: string;
}) {
  const captured = opts.capturedAt ?? new Date().toISOString();
  return {
    type: `ai.detection.${opts.detectionClass}.emitted`,
    schema_version: "v1",
    timestamp: captured,
    last_event_id: opts.eventId,
    payload: {
      detection_id: opts.detectionId,
      sensor_id: opts.sensorId,
      frame_id: opts.frameId,
      detection_class: opts.detectionClass,
      confidence: opts.confidence,
      severity_hint: opts.severityHint,
      ...(opts.bbox ? { bbox: opts.bbox } : {}),
      captured_at: captured,
      geo: { lat: 37.6213, lng: -122.379, alt_m: 4 },
    },
  };
}
