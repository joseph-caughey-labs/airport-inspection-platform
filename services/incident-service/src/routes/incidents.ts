import {
  AcknowledgeIncidentRequest,
  ArchiveIncidentRequest,
  AssignIncidentRequest,
  CreateIncidentRequest,
  EscalateIncidentRequest,
  type Incident as IncidentEnvelope,
  ListIncidentsQuery,
  PaginationQuery,
  RejectIncidentRequest,
  ResolveIncidentRequest,
  StartProgressIncidentRequest,
} from "@aip/shared-contracts";
import type { FastifyInstance } from "fastify";
import {
  IllegalTransitionError,
  Incident,
  TerminalStateError,
  type IncidentCommand,
  type Transition,
} from "../domain/index.js";
import type { IncidentEventPublisher } from "../events/index.js";
import { IdempotencyKeyConflictError, type IncidentRepository } from "../repository/index.js";

/**
 * Minimal structural type for a body parser. Matches zod's
 * `safeParse` contract without dragging the dependency into this
 * package — the routes only need pass/fail + error.message.
 */
interface BodyParser<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

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
 *   POST   /incidents/:id/<command>         — transition (T-403/T-404)
 *
 * The seven transition commands (`acknowledge`, `assign`,
 * `start_progress`, `resolve`, `escalate`, `archive`, `reject`) share
 * a `registerTransitionRoute` helper — they only differ in their
 * request body shape and which envelope fields they denormalize.
 *
 * All responses use the canonical envelopes from `@aip/shared-contracts`
 * — never raw rows. Errors use the `ErrorResponse` envelope.
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

  // --- Transition commands (T-403 / T-404) -------------------------
  //
  // Each command shares the same envelope contract:
  //
  //   200 → updated incident envelope
  //   400 → INVALID_ID / VALIDATION
  //   404 → INCIDENT_NOT_FOUND
  //   409 → ILLEGAL_TRANSITION (from is wrong)
  //   410 → TERMINAL_STATE     (archived / rejected)
  //
  // Differences are confined to the body schema + which fields the
  // route denormalizes onto the envelope after the dispatch (e.g.
  // `assigned_to` after `assign`, `resolved_at` after `resolve`).

  registerTransitionRoute<typeof AcknowledgeIncidentRequest._type>(app, {
    command: "acknowledge",
    path: "/incidents/:id/acknowledge",
    schema: AcknowledgeIncidentRequest,
    reasonOf: (b) => b.note,
    denormalize: (_body, t) => ({
      acknowledged_by: t.actor,
      acknowledged_at: t.occurred_at,
    }),
    repository: repo,
    events,
  });

  registerTransitionRoute<typeof AssignIncidentRequest._type>(app, {
    command: "assign",
    path: "/incidents/:id/assign",
    schema: AssignIncidentRequest,
    reasonOf: (b) => b.note,
    denormalize: (body) => ({ assigned_to: body.assignee_id }),
    repository: repo,
    events,
  });

  registerTransitionRoute<typeof StartProgressIncidentRequest._type>(app, {
    command: "start_progress",
    path: "/incidents/:id/start_progress",
    schema: StartProgressIncidentRequest,
    reasonOf: (b) => b.note,
    denormalize: () => ({}),
    repository: repo,
    events,
  });

  registerTransitionRoute<typeof ResolveIncidentRequest._type>(app, {
    command: "resolve",
    path: "/incidents/:id/resolve",
    schema: ResolveIncidentRequest,
    reasonOf: (b) => b.resolution_summary,
    denormalize: (_body, t) => ({ resolved_at: t.occurred_at }),
    repository: repo,
    events,
  });

  registerTransitionRoute<typeof EscalateIncidentRequest._type>(app, {
    command: "escalate",
    path: "/incidents/:id/escalate",
    schema: EscalateIncidentRequest,
    reasonOf: (b) => b.reason,
    denormalize: () => ({}),
    repository: repo,
    events,
  });

  registerTransitionRoute<typeof ArchiveIncidentRequest._type>(app, {
    command: "archive",
    path: "/incidents/:id/archive",
    schema: ArchiveIncidentRequest,
    reasonOf: (b) => b.note,
    denormalize: () => ({}),
    repository: repo,
    events,
  });

  registerTransitionRoute<typeof RejectIncidentRequest._type>(app, {
    command: "reject",
    path: "/incidents/:id/reject",
    schema: RejectIncidentRequest,
    reasonOf: (b) => b.reason,
    denormalize: () => ({}),
    repository: repo,
    events,
  });
}

interface TransitionRouteConfig<Body extends { operator_id: string }> {
  command: IncidentCommand;
  path: string;
  schema: BodyParser<Body>;
  /** Extracts the human-facing reason from the body. Threaded through
   * to the transition record + the published event. */
  reasonOf: (body: Body) => string | undefined;
  /** Fields denormalized onto the incident envelope after the
   * transition succeeds (e.g. `assigned_to`, `resolved_at`). */
  denormalize: (body: Body, transition: Transition) => Partial<IncidentEnvelope>;
  repository: IncidentRepository;
  events: IncidentEventPublisher | undefined;
}

/**
 * Registers a single transition endpoint following the canonical
 * pattern: validate path uuid → parse body → load → dispatch via
 * state machine → persist with denormalized fields → publish.
 *
 * A publish failure does NOT fail the request: persistence is the
 * source of truth and the audit-service catches up via the outbox
 * sweep (T-412). Wrapping the publish in try/catch keeps the operator
 * unblocked when the broker is briefly down.
 */
function registerTransitionRoute<Body extends { operator_id: string }>(
  app: FastifyInstance,
  cfg: TransitionRouteConfig<Body>,
): void {
  app.post<{ Params: { id: string } }>(cfg.path, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send(toErrorEnvelope("INVALID_ID", "id must be a uuid"));
    }
    const parse = cfg.schema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send(toErrorEnvelope("VALIDATION", parse.error.message));
    }
    const body = parse.data;
    const found = await cfg.repository.findById(req.params.id);
    if (!found) {
      return reply
        .code(404)
        .send(toErrorEnvelope("INCIDENT_NOT_FOUND", `incident ${req.params.id} not found`));
    }
    const reason = cfg.reasonOf(body);
    let dispatched;
    try {
      // Fresh Incident with empty history: the route layer doesn't
      // hydrate history yet (audit-service in T-412 owns the chain).
      // The state machine only reads `status`.
      dispatched = new Incident({ ...found, history: [] }).dispatch({
        command: cfg.command,
        actor: body.operator_id,
        ...(reason !== undefined ? { reason } : {}),
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
    const persisted = await cfg.repository.save({
      ...found,
      status: dispatched.next.status,
      updated_at: dispatched.transition.occurred_at,
      ...cfg.denormalize(body, dispatched.transition),
    });
    if (cfg.events) {
      try {
        await cfg.events.emit(dispatched.event);
      } catch {
        // Logged + counted inside the publisher; not fatal to the
        // operator's request.
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
