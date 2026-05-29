import {
  AcknowledgeIncidentRequest,
  CreateIncidentRequest,
  ListIncidentsQuery,
  PaginationQuery,
} from "@aip/shared-contracts";
import type { FastifyInstance } from "fastify";
import { IllegalTransitionError, Incident, TerminalStateError } from "../domain/index.js";
import type { IncidentEventPublisher } from "../events/index.js";
import { IdempotencyKeyConflictError, type IncidentRepository } from "../repository/index.js";

export interface IncidentRoutesOptions {
  repository: IncidentRepository;
  /** Domain event publisher. When omitted, transitions silently
   * skip the event emission — convenient for unit tests that only
   * care about the route's input → output contract. */
  events?: IncidentEventPublisher | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * REST endpoints for the incident lifecycle.
 *
 *   GET    /incidents                       — paginated list
 *   GET    /incidents/:id                   — single envelope
 *   POST   /incidents                       — create
 *   POST   /incidents/:id/acknowledge       — new → acknowledged (T-403)
 *
 * All responses use the canonical envelopes from `@aip/shared-contracts`
 * — never raw rows. Errors use the `ErrorResponse` envelope.
 *
 * Remaining transition endpoints (assign / start / resolve / escalate
 * / archive / reject) land in T-404.
 */
export function registerIncidentRoutes(app: FastifyInstance, opts: IncidentRoutesOptions): void {
  const repo = opts.repository;
  const events = opts.events;

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

  /**
   * POST /incidents/:id/acknowledge (T-403)
   *
   * Transitions an incident from `new → acknowledged`, denormalizes
   * `acknowledged_by` + `acknowledged_at` onto the row for fast list
   * queries, and emits an `incident.transitioned` event so the audit
   * + notification services can react.
   *
   * Status codes:
   *   200 — transitioned; returns the updated envelope
   *   400 — VALIDATION (body) or INVALID_ID (path)
   *   404 — INCIDENT_NOT_FOUND
   *   409 — ILLEGAL_TRANSITION (e.g. already acknowledged)
   *   410 — TERMINAL_STATE (archived / rejected)
   */
  app.post<{ Params: { id: string } }>("/incidents/:id/acknowledge", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send(toErrorEnvelope("INVALID_ID", "id must be a uuid"));
    }
    const parse = AcknowledgeIncidentRequest.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope("VALIDATION", parse.error.message));
    }
    const found = await repo.findById(req.params.id);
    if (!found) {
      return reply
        .code(404)
        .send(toErrorEnvelope("INCIDENT_NOT_FOUND", `incident ${req.params.id} not found`));
    }
    let dispatched;
    try {
      // We construct a fresh Incident with empty history because the
      // route layer doesn't track history yet (event-sourced history
      // lands with the audit service in T-412). The state machine
      // only reads `status`.
      dispatched = new Incident({ ...found, history: [] }).dispatch({
        command: "acknowledge",
        actor: parse.data.operator_id,
        ...(parse.data.note !== undefined ? { reason: parse.data.note } : {}),
      });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return reply.code(409).send(
          toErrorEnvelope("ILLEGAL_TRANSITION", err.message, {
            from: err.from,
            command: err.command,
          }),
        );
      }
      if (err instanceof TerminalStateError) {
        return reply.code(410).send(
          toErrorEnvelope("TERMINAL_STATE", err.message, {
            state: err.state,
            command: err.command,
          }),
        );
      }
      throw err;
    }
    const persisted = await repo.save({
      ...found,
      status: dispatched.next.status,
      updated_at: dispatched.transition.occurred_at,
      acknowledged_by: parse.data.operator_id,
      acknowledged_at: dispatched.transition.occurred_at,
    });
    if (events) {
      // Publish AFTER persistence. If the publish fails, the
      // transition is still durable on disk and the audit-service
      // catches up via the outbox sweep (T-412).
      try {
        await events.emit(dispatched.event);
      } catch {
        // Logged + counted inside the publisher; we don't fail the
        // operator's request because the broker is briefly down.
      }
    }
    return persisted;
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
