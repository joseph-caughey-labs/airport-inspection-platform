import type { FastifyInstance } from "fastify";

/**
 * `/api/v1/ping` — proves the shell. Echoes the request_id and the
 * decoded auth (when present) so wiring can be eyeballed end-to-end.
 *
 * Real routes (incidents, sensors, etc.) attach in their respective
 * tickets.
 */
export async function pingRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/ping", async (req) => ({
    pong: true,
    time: new Date().toISOString(),
    request_id: req.request_id,
    ...(req.auth ? { auth: { userId: req.auth.userId, role: req.auth.role } } : {}),
  }));
}
