import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../../services/incident-service/src/app.js";
import {
  RecordingIncidentEventPublisher,
  RedisIncidentEventPublisher,
} from "../../../../services/incident-service/src/events/index.js";
import { InMemoryIncidentRepository } from "../../../../services/incident-service/src/repository/index.js";

const logger = createLogger({ service: "ack-test", level: "fatal" });
function reg() {
  return createRegistry({ service: "ack-test", collectDefault: false });
}

function fakePool(): import("pg").Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as import("pg").Pool;
}

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const OPERATOR = "33333333-3333-3333-3333-333333333333";

async function build() {
  const repository = new InMemoryIncidentRepository();
  const events = new RecordingIncidentEventPublisher();
  const app = await buildApp({ logger, pool: fakePool(), repository, events });
  return { app, repository, events };
}

describe("POST /incidents/:id/acknowledge — happy path", () => {
  it("transitions new → acknowledged and returns the updated envelope", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "FOD on RWY 10L",
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("acknowledged");
    expect(body.acknowledged_by).toBe(OPERATOR);
    expect(typeof body.acknowledged_at).toBe("string");
    expect(body.updated_at).toBe(body.acknowledged_at);
  });

  it("persists the new status to the repository", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    const stored = await repository.findById(incident.id);
    expect(stored?.status).toBe("acknowledged");
  });

  it("threads the optional note into the published transition.reason", async () => {
    const { app, repository, events } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR, note: "tower confirmed visual" },
    });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]?.transition.reason).toBe("tower confirmed visual");
  });
});

describe("POST /incidents/:id/acknowledge — event publication", () => {
  it("emits exactly one incident.transitioned event on the acknowledged channel", async () => {
    const { app, repository, events } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    expect(events.published).toHaveLength(1);
    const emitted = events.published[0]!;
    expect(emitted.event_type).toBe("incident.transitioned");
    expect(emitted.incident_id).toBe(incident.id);
    expect(emitted.transition.to).toBe("acknowledged");
    expect(emitted.transition.from).toBe("new");
    expect(emitted.transition.actor).toBe(OPERATOR);
  });

  it("a publish failure does NOT roll back the persisted transition", async () => {
    const repository = new InMemoryIncidentRepository();
    const exploding = {
      emit: vi.fn(async () => {
        throw new Error("broker offline");
      }),
    };
    const app = await buildApp({
      logger,
      pool: fakePool(),
      repository,
      events: exploding,
    });
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(200);
    expect(exploding.emit).toHaveBeenCalledOnce();
    const stored = await repository.findById(incident.id);
    expect(stored?.status).toBe("acknowledged");
  });
});

describe("POST /incidents/:id/acknowledge — error paths", () => {
  it("returns 400 INVALID_ID on a non-uuid path param", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/incidents/not-a-uuid/acknowledge",
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ID");
  });

  it("returns 400 VALIDATION on missing operator_id", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION on non-uuid operator_id", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 INCIDENT_NOT_FOUND for an unknown id", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/incidents/99999999-9999-9999-9999-999999999999/acknowledge",
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("INCIDENT_NOT_FOUND");
  });

  it("returns 409 ILLEGAL_TRANSITION when already acknowledged", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    const second = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("ILLEGAL_TRANSITION");
    expect(second.json().error.details.from).toBe("acknowledged");
  });

  it("returns 410 TERMINAL_STATE when the incident is archived", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await repository.save({ ...incident, status: "archived" });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe("TERMINAL_STATE");
  });

  it("returns 409 ILLEGAL_TRANSITION when the incident was already moved past `new`", async () => {
    const { app, repository } = await build();
    const incident = await repository.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "x",
    });
    await repository.save({ ...incident, status: "in_progress" });
    const res = await app.inject({
      method: "POST",
      url: `/incidents/${incident.id}/acknowledge`,
      payload: { operator_id: OPERATOR },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("RedisIncidentEventPublisher", () => {
  function fakeRedis(opts?: { failPublish?: boolean }) {
    return {
      publish: vi.fn(async () => {
        if (opts?.failPublish) throw new Error("broker offline");
        return 1;
      }),
    } as unknown as import("ioredis").default;
  }

  it("publishes on the incident.transition.<next_state> channel", async () => {
    const redis = fakeRedis();
    const publisher = new RedisIncidentEventPublisher({ redis, logger, registry: reg() });
    await publisher.emit({
      event_type: "incident.transitioned",
      schema_version: "v1",
      incident_id: "inc-1",
      transition: {
        from: "new",
        to: "acknowledged",
        command: "acknowledge",
        actor: OPERATOR,
        occurred_at: "2026-05-29T10:00:00.000Z",
      },
    });
    expect(redis.publish).toHaveBeenCalledWith(
      "incident.transition.acknowledged",
      expect.stringContaining('"event_type":"incident.transitioned"'),
    );
  });

  it("emits the published counter labeled by next_state on success", async () => {
    const registry = reg();
    const publisher = new RedisIncidentEventPublisher({
      redis: fakeRedis(),
      logger,
      registry,
    });
    await publisher.emit({
      event_type: "incident.transitioned",
      schema_version: "v1",
      incident_id: "inc-1",
      transition: {
        from: "new",
        to: "acknowledged",
        command: "acknowledge",
        actor: OPERATOR,
        occurred_at: "2026-05-29T10:00:00.000Z",
      },
    });
    const text = await registry.metrics();
    expect(text).toMatch(/incident_events_published_total[^\n]*next_state="acknowledged"[^\n]*1/);
  });

  it("rethrows on publish failure and counts a failure", async () => {
    const registry = reg();
    const publisher = new RedisIncidentEventPublisher({
      redis: fakeRedis({ failPublish: true }),
      logger,
      registry,
    });
    await expect(
      publisher.emit({
        event_type: "incident.transitioned",
        schema_version: "v1",
        incident_id: "inc-1",
        transition: {
          from: "new",
          to: "acknowledged",
          command: "acknowledge",
          actor: OPERATOR,
          occurred_at: "2026-05-29T10:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/broker offline/);
    const text = await registry.metrics();
    expect(text).toMatch(/incident_events_publish_failures_total[^\n]*next_state="acknowledged"/);
  });
});
