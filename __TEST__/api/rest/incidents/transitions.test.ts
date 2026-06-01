/**
 * T-404 — covers the six transition endpoints that walk an incident
 * the rest of the way through the lifecycle: assign, start_progress,
 * resolve, escalate, archive, reject.
 *
 * The happy paths walk the canonical operator flow:
 *   new → ack → assigned → in_progress → resolved → archived.
 *
 * The "escalate from any active state" branch is verified separately
 * (escalate is the side-entry the state machine allows from new,
 * acknowledged, assigned, in_progress). Likewise reject from any
 * non-terminal state.
 *
 * Error path coverage is intentionally not 7×N: the transition
 * scaffolding is shared (`registerTransitionRoute`) so we just spot-check
 * each route's denormalization + event channel, plus one
 * ILLEGAL_TRANSITION + TERMINAL_STATE pair to confirm the helper
 * surfaces the 409/410 mapping. Acknowledge already covers the full
 * error matrix in `acknowledge.test.ts`.
 */
import { createLogger } from "@aip/logger";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../../services/incident-service/src/app.js";
import { RecordingIncidentEventPublisher } from "../../../../services/incident-service/src/events/index.js";
import { InMemoryIncidentRepository } from "../../../../services/incident-service/src/repository/index.js";
import { adminToken, bearer, makeTestSigner } from "../../../helpers/auth.js";

const logger = createLogger({ service: "transitions-test", level: "fatal" });

function fakePool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as import("pg").Pool;
}

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const OPERATOR = "33333333-3333-3333-3333-333333333333";
const ASSIGNEE = "44444444-4444-4444-4444-444444444444";

const signer = makeTestSigner();
let auth: { authorization: string };
beforeAll(async () => {
  auth = bearer(await adminToken(signer));
});

async function build() {
  const repository = new InMemoryIncidentRepository();
  const events = new RecordingIncidentEventPublisher();
  const app = await buildApp({ logger, pool: fakePool(), repository, events, signer });
  // Wrap inject so every call carries the suite's admin token. Auth-
  // specific cases (401 / 403 by role) live in the service's own
  // app.test.ts; this file is about lifecycle behaviour.
  const originalInject = app.inject.bind(app);
  app.inject = ((opts: Parameters<typeof originalInject>[0]) => {
    if (typeof opts === "string") return originalInject({ url: opts, headers: auth });
    const merged = {
      ...opts,
      headers: { ...((opts as { headers?: Record<string, string> }).headers ?? {}), ...auth },
    };
    return originalInject(merged);
  }) as typeof originalInject;
  return { app, repository, events };
}

async function seed(repository: InMemoryIncidentRepository) {
  return repository.create({
    airport_id: AIRPORT,
    severity: "high",
    title: "FOD on RWY 10L",
  });
}

async function ack(app: Awaited<ReturnType<typeof build>>["app"], id: string) {
  return app.inject({
    method: "POST",
    url: `/incidents/${id}/acknowledge`,
    payload: { operator_id: OPERATOR },
  });
}

describe("POST /incidents/:id/assign", () => {
  it("transitions acknowledged → assigned and denormalizes assigned_to", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("assigned");
    expect(body.assigned_to).toBe(ASSIGNEE);
  });

  it("publishes on incident.transition.assigned with the actor", async () => {
    const { app, repository, events } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    expect(events.published).toHaveLength(2);
    const emitted = events.published[1]!;
    expect(emitted.transition.to).toBe("assigned");
    expect(emitted.transition.from).toBe("acknowledged");
    expect(emitted.transition.actor).toBe(OPERATOR);
  });

  it("returns 409 ILLEGAL_TRANSITION when called on `new`", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("returns 400 VALIDATION when assignee_id is missing", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("POST /incidents/:id/start_progress", () => {
  it("transitions assigned → in_progress", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("in_progress");
  });

  it("publishes on incident.transition.in_progress", async () => {
    const { app, repository, events } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    const last = events.published.at(-1)!;
    expect(last.transition.to).toBe("in_progress");
    expect(last.transition.from).toBe("assigned");
  });
});

describe("POST /incidents/:id/resolve", () => {
  it("transitions in_progress → resolved and denormalizes resolved_at", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/resolve`,
      payload: { operator_id: ASSIGNEE, resolution_summary: "FOD removed; runway swept" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("resolved");
    expect(typeof body.resolved_at).toBe("string");
    expect(body.updated_at).toBe(body.resolved_at);
  });

  it("threads resolution_summary into transition.reason", async () => {
    const { app, repository, events } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/resolve`,
      payload: { operator_id: ASSIGNEE, resolution_summary: "FOD removed; runway swept" },
    });
    const last = events.published.at(-1)!;
    expect(last.transition.reason).toBe("FOD removed; runway swept");
  });

  it("returns 400 VALIDATION when resolution_summary is missing", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/resolve`,
      payload: { operator_id: ASSIGNEE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("POST /incidents/:id/escalate", () => {
  it("escalates from `new`", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/escalate`,
      payload: { operator_id: OPERATOR, reason: "severity_override" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("escalated");
  });

  it("escalates from `in_progress` (side-entry from any active state)", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/escalate`,
      payload: { operator_id: OPERATOR, reason: "sla_breach" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("escalated");
  });

  it("acknowledge from escalated re-routes to `assigned`", async () => {
    // Confirms the dual-target branch on `escalated` documented in
    // incident-lifecycle.md: a supervisor re-acknowledging an
    // escalated incident routes it back into the assignment queue
    // without bouncing through `acknowledged` again.
    const { app, repository } = await build();
    const incident = await seed(repository);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/escalate`,
      payload: { operator_id: OPERATOR, reason: "severity_override" },
    });
    const res = await ack(app, incident.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("assigned");
  });

  it("returns 400 VALIDATION when reason is missing", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/escalate`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /incidents/:id/archive", () => {
  it("archives a resolved incident and the result is terminal", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/resolve`,
      payload: { operator_id: ASSIGNEE, resolution_summary: "done" },
    });
    const archived = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/archive`,
      payload: { operator_id: OPERATOR },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");

    // A second archive must surface 410 TERMINAL_STATE.
    const again = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/archive`,
      payload: { operator_id: OPERATOR },
    });
    expect(again.statusCode).toBe(410);
    expect(again.json().error.code).toBe("TERMINAL_STATE");
  });

  it("returns 409 ILLEGAL_TRANSITION when archiving a `new` incident", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/archive`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /incidents/:id/reject", () => {
  it("rejects a new incident (validation-engine path)", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/reject`,
      payload: { operator_id: OPERATOR, reason: "layer3_false_positive" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
  });

  it("rejects from in_progress and publishes on the rejected channel", async () => {
    const { app, repository, events } = await build();
    const incident = await seed(repository);
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/reject`,
      payload: { operator_id: OPERATOR, reason: "duplicate_detection" },
    });
    const last = events.published.at(-1)!;
    expect(last.transition.to).toBe("rejected");
    expect(last.transition.reason).toBe("duplicate_detection");
  });

  it("returns 410 TERMINAL_STATE when the incident is already rejected", async () => {
    const { app, repository } = await build();
    const incident = await seed(repository);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/reject`,
      payload: { operator_id: OPERATOR, reason: "fp" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/reject`,
      payload: { operator_id: OPERATOR, reason: "fp" },
    });
    expect(second.statusCode).toBe(410);
  });
});

describe("Transition publish failure isolation", () => {
  it("a publish failure on resolve does not roll back the persisted resolution", async () => {
    const repository = new InMemoryIncidentRepository();
    let calls = 0;
    const events = {
      emit: vi.fn(async () => {
        calls += 1;
        // First 3 calls succeed (ack, assign, start_progress);
        // the resolve publish fails so we can confirm the operator's
        // request still returns 200 and the row is persisted.
        if (calls === 4) throw new Error("broker offline");
      }),
    };
    const app = await buildApp({ logger, pool: fakePool(), repository, events, signer });
    // Same inject wrapper the `build()` helper installs.
    const originalInject = app.inject.bind(app);
    app.inject = ((opts: Parameters<typeof originalInject>[0]) => {
      if (typeof opts === "string") return originalInject({ url: opts, headers: auth });
      const merged = {
        ...opts,
        headers: { ...((opts as { headers?: Record<string, string> }).headers ?? {}), ...auth },
      };
      return originalInject(merged);
    }) as typeof originalInject;
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await ack(app, incident.id);
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/assign`,
      payload: { operator_id: OPERATOR, assignee_id: ASSIGNEE },
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/start_progress`,
      payload: { operator_id: ASSIGNEE },
    });
    const resolved = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/resolve`,
      payload: { operator_id: ASSIGNEE, resolution_summary: "done" },
    });
    expect(resolved.statusCode).toBe(200);
    const stored = await repository.findById(incident.id);
    expect(stored?.status).toBe("resolved");
  });
});
