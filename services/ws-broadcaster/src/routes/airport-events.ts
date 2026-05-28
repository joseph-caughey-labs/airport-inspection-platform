import { type Logger } from "@aip/logger";
import { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { type FrameHydrator } from "../channels/hydrator.js";
import { type ChannelRegistry } from "../channels/registry.js";
import { type BroadcastClient, type ClientRole } from "../channels/types.js";
import {
  broadcastPresenceChange,
  buildPresenceMessage,
  PRESENCE_SNAPSHOT_TYPE,
} from "../presence/index.js";

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
 *   3. Hydrate — either `last_event_id` resume (T-210) or default tail.
 *      Resume reads frames since the cursor and tags the result with
 *      `mode: "resume" | "resume_fallback" | "resume_capped"` so the
 *      UI can flag a history gap to the user.
 *   4. Send a `presence.snapshot` to the new client.
 *   5. Subscribe to the registry, then fan a `presence.changed` to
 *      every existing subscriber (the new one is already counted).
 *
 * Hydration→subscribe race: with `last_event_id` resume the gap is
 * recoverable on the next reconnect, so we no longer treat it as a
 * known limitation — the client's persisted cursor closes it.
 */
export function registerAirportEventsRoute(
  app: FastifyInstance,
  opts: AirportEventsRouteOptions,
): void {
  app.get<{
    Params: { airportId: string };
    Querystring: { role?: string; hydrate?: string; last_event_id?: string };
  }>("/ws/v1/airport/:airportId/events", { websocket: true }, async (socket, req) => {
    const airportId = req.params.airportId;
    if (!UUID_RE.test(airportId)) {
      socket.close(4400, "invalid airport id");
      return;
    }
    const role = parseRole(req.query.role);
    const hydrateLimit = req.query.hydrate ? Number(req.query.hydrate) : undefined;
    const lastEventId = req.query.last_event_id?.trim();

    const client: BroadcastClient = {
      role,
      connection_id: randomUUID(),
      connected_at: new Date().toISOString(),
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };

    try {
      if (lastEventId) {
        const { frames, mode } = await opts.hydrator.hydrateSince(
          airportId,
          lastEventId,
          Number.isFinite(hydrateLimit) ? hydrateLimit : undefined,
        );
        for (const f of frames) socket.send(f.message);
        opts.logger.info(
          { airportId, role, lastEventId, mode, replayed: frames.length },
          "ws subscriber resumed",
        );
      } else {
        const frames = await opts.hydrator.hydrate(
          airportId,
          Number.isFinite(hydrateLimit) ? hydrateLimit : undefined,
        );
        for (const f of frames) socket.send(f.message);
      }
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err), airportId },
        "hydration failed; continuing without backfill",
      );
    }

    // Initial presence snapshot — sent BEFORE subscribe so the new
    // client sees the existing peers as they were when it joined.
    socket.send(
      buildPresenceMessage(PRESENCE_SNAPSHOT_TYPE, airportId, opts.registry.snapshot(airportId)),
    );

    opts.registry.subscribe(airportId, client);
    broadcastPresenceChange(opts.registry, airportId);

    opts.logger.info(
      {
        airportId,
        role,
        connection_id: client.connection_id,
        subscribers: opts.registry.subscriberCount(airportId),
      },
      "ws subscriber attached",
    );

    const detach = (): void => {
      opts.registry.unsubscribe(airportId, client);
      broadcastPresenceChange(opts.registry, airportId);
    };
    socket.on("close", detach);
    socket.on("error", (err: Error) => {
      opts.logger.warn({ airportId, err: err.message }, "ws socket error");
      detach();
    });
  });
}
