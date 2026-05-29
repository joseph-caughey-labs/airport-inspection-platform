import { CreateIncidentRequest, ListIncidentsQuery, PaginationQuery } from "@aip/shared-contracts";
import type { FastifyInstance } from "fastify";
import { IdempotencyKeyConflictError, type IncidentRepository } from "../repository/index.js";

export interface IncidentRoutesOptions {
  repository: IncidentRepository;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * REST endpoints for the incident lifecycle.
 *
 *   GET    /incidents          — paginated list with filters
 *   GET    /incidents/:id      — single envelope
 *   POST   /incidents          — create (typically called by the
 *                                validation engine on Layer 10 cert)
 *
 * All responses use the canonical envelopes from `@aip/shared-contracts`
 * — never raw rows. Errors use the `ErrorResponse` envelope.
 *
 * Lifecycle transition endpoints (acknowledge / assign / resolve /
 * escalate / archive / reject) land in T-403 and T-404.
 */
export function registerIncidentRoutes(app: FastifyInstance, opts: IncidentRoutesOptions): void {
  const repo = opts.repository;

  app.get("/incidents", async (req, reply) => {
    const queryParse = ListIncidentsQuery.safeParse(req.query);
    if (!queryParse.success) {
      return reply.code(400).send(toErrorEnvelope("VALIDATION", queryParse.error.message));
    }
    const pageParse = PaginationQuery.safeParse(req.query);
    if (!pageParse.success) {
      return reply.code(400).send(toErrorEnvelope("VALIDATION", pageParse.error.message));
    }
    const result = await repo.list(queryParse.data, pageParse.data);
    return result;
  });

  app.get<{ Params: { id: string } }>("/incidents/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send(toErrorEnvelope("INVALID_ID", "id must be a uuid"));
    }
    const item = await repo.findById(req.params.id);
    if (!item) {
      return reply
        .code(404)
        .send(toErrorEnvelope("INCIDENT_NOT_FOUND", `incident ${req.params.id} not found`));
    }
    return item;
  });

  app.post("/incidents", async (req, reply) => {
    const parse = CreateIncidentRequest.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope("VALIDATION", parse.error.message));
    }
    try {
      const created = await repo.create(parse.data);
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof IdempotencyKeyConflictError) {
        return reply.code(409).send(
          toErrorEnvelope("IDEMPOTENCY_KEY_CONFLICT", err.message, {
            existingId: err.existingId,
          }),
        );
      }
      throw err;
    }
  });
}

function toErrorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
