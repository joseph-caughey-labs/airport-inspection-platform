import { type Logger } from "@aip/logger";
import { type FastifyInstance } from "fastify";
import { type FrameHydrator } from "../channels/hydrator.js";
import { type ChannelRegistry } from "../channels/registry.js";
import { type BroadcastClient, type ClientRole } from "../channels/types.js";

export interface AirportEventsRouteOptions {
  registry: ChannelRegistry;
  hydrator: FrameHydrator;
  logger: Logger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES: readonly ClientRole[] = ["operator", "supervisor", "viewer", "system"];

function parseRole(raw: string | undefined): ClientRole {
  if (!raw) return "viewer";
  return (VALID_ROLES as readonly string[]).includes(raw) ? (raw as ClientRole) : "viewer";
}

/**
 * WS route: `/ws/v1/airport/:airportId/events`.
 *
 * On connect:
 *   1. Validate airport id (uuid).
 *   2. Resolve role (query string today; bearer-token RBAC in T-504).
 *   3. Hydrate last N persisted frames straight from the socket so the
 *      client paints history before seeing the live tail.
 *   4. Subscribe to the registry; from this point the redis-bridge
 *      pushes live frames automatically.
 *
 * Hydration races: any live frame that arrives between the SELECT
 * cursor and the `subscribe()` call will simply not show up. With
 * `last_event_id` resume (T-210) the client backfills the gap on
 * the next reconnect. For T-209 we accept the window — it's narrower
 * than the dedup window and the outbox loop is idempotent anyway.
 */
export function registerAirportEventsRoute(
  app: FastifyInstance,
  opts: AirportEventsRouteOptions,
): void {
  app.get<{
    Params: { airportId: string };
    Querystring: { role?: string; hydrate?: string };
  }>("/ws/v1/airport/:airportId/events", { websocket: true }, async (socket, req) => {
    const airportId = req.params.airportId;
    if (!UUID_RE.test(airportId)) {
      socket.close(4400, "invalid airport id");
      return;
    }
    const role = parseRole(req.query.role);
    const hydrateLimit = req.query.hydrate ? Number(req.query.hydrate) : undefined;

    const client: BroadcastClient = {
      role,
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };

    try {
      const frames = await opts.hydrator.hydrate(
        airportId,
        Number.isFinite(hydrateLimit) ? hydrateLimit : undefined,
      );
      for (const f of frames) socket.send(f.message);
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err), airportId },
        "hydration failed; continuing without backfill",
      );
    }

    opts.registry.subscribe(airportId, client);
    opts.logger.info(
      { airportId, role, subscribers: opts.registry.subscriberCount(airportId) },
      "ws subscriber attached",
    );

    socket.on("close", () => {
      opts.registry.unsubscribe(airportId, client);
    });
    socket.on("error", (err: Error) => {
      opts.logger.warn({ airportId, err: err.message }, "ws socket error");
      opts.registry.unsubscribe(airportId, client);
    });
  });
}
