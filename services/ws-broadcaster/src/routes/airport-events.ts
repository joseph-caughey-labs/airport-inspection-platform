import { AuthJwtError, type JwtSigner } from "@aip/auth-jwt";
import { type Logger } from "@aip/logger";
import { type Role } from "@aip/shared-contracts";
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
  /**
   * JWT signer used to verify the access token on the WS upgrade.
   * Required — there is no "auth disabled" mode here. Tests pass
   * a test signer + mint a token; production wires the same signer
   * the api-gateway uses.
   */
  signer: JwtSigner;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map the platform `Role` (operator/reviewer/admin) onto the
 * broadcaster's `ClientRole` (operator/supervisor/viewer/system).
 *
 *   - admin    → supervisor   (oversees the deck; sees everything)
 *   - reviewer → supervisor   (same elevation for the WS surface)
 *   - operator → operator
 *
 * The ClientRole is used by the channel registry's `allow()` filter
 * to scope which event_types reach which subscribers — for the demo
 * the default filter lets everything through, but the mapping is in
 * place for the filter to evolve.
 */
function clientRoleFor(authRole: Role): ClientRole {
  if (authRole === "admin" || authRole === "reviewer") return "supervisor";
  return "operator";
}

/**
 * Browsers cannot set arbitrary headers on the WebSocket upgrade
 * request, so we accept the access token from either of two places:
 *
 *   1. `Sec-WebSocket-Protocol: bearer.<token>` — preferred. The
 *      header IS settable in the browser WebSocket API (it's the
 *      `protocols` argument). Server echoes the same protocol back
 *      on accept so the handshake completes.
 *   2. `?access_token=<token>` query string — fallback for non-
 *      browser clients (curl-style smoke tests).
 *
 * Production should add a CSRF-style check on the query-string path
 * (referrer + same-origin) since query strings can leak to access
 * logs. Out of scope for the demo.
 */
function extractToken(req: {
  headers: Record<string, string | string[] | undefined>;
  query: { access_token?: string };
}): string | undefined {
  const proto = req.headers["sec-websocket-protocol"];
  const candidates = typeof proto === "string" ? proto.split(",").map((s) => s.trim()) : [];
  for (const c of candidates) {
    if (c.startsWith("bearer.")) {
      const token = c.slice("bearer.".length);
      if (token.length > 0) return token;
    }
  }
  if (typeof req.query.access_token === "string" && req.query.access_token.length > 0) {
    return req.query.access_token;
  }
  return undefined;
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
    Querystring: { hydrate?: string; last_event_id?: string; access_token?: string };
  }>("/ws/v1/airport/:airportId/events", { websocket: true }, async (socket, req) => {
    const airportId = req.params.airportId;
    if (!UUID_RE.test(airportId)) {
      socket.close(4400, "invalid airport id");
      return;
    }

    // T-504b — verify JWT before the connection becomes useful.
    // 4401 mirrors HTTP 401 (the 4xxx range is application-defined
    // in the WS close-code spec).
    const token = extractToken(req);
    if (!token) {
      socket.close(4401, "missing access token");
      return;
    }
    let authRole: Role;
    let userId: string;
    try {
      const verified = await opts.signer.verifyAccess(token);
      authRole = verified.role;
      userId = verified.user_id;
    } catch (err) {
      const reason = err instanceof AuthJwtError ? err.code : "invalid_token";
      socket.close(4401, `auth failed: ${reason}`);
      return;
    }
    const role = clientRoleFor(authRole);

    const hydrateLimit = req.query.hydrate ? Number(req.query.hydrate) : undefined;
    const lastEventId = req.query.last_event_id?.trim();

    const client: BroadcastClient = {
      role,
      connection_id: randomUUID(),
      connected_at: new Date().toISOString(),
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    };

    // Attach the authenticated user id to logs for postmortems.
    opts.logger.info(
      { airportId, user_id: userId, role, auth_role: authRole },
      "ws subscriber authenticated",
    );

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
