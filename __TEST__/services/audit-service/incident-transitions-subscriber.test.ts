/**
 * IncidentTransitionsSubscriber tests (T-412).
 *
 * Drives the subscriber's pmessage handler directly so the test
 * doesn't need a real Redis. Verifies:
 *   - well-formed incident.transitioned events → writer.append
 *   - actor / correlation / rationale mapping
 *   - malformed JSON / wrong event_type → dropped, counted
 *   - subject_id is the incident id
 */
import { createLogger } from "@aip/logger";
import { describe, expect, it, vi } from "vitest";
import { IncidentTransitionsSubscriber } from "../../../services/audit-service/src/subscribers/incident-transitions.js";

const logger = createLogger({ service: "subscriber-test", level: "fatal" });

function fakeRedis(): import("ioredis").default {
  return {
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => 1),
    punsubscribe: vi.fn(async () => 1),
  } as unknown as import("ioredis").default;
}

function fakeWriter() {
  return {
    append: vi.fn(async (input) => ({
      seq: 1n,
      event_id: "11111111-1111-1111-1111-111111111111",
      occurred_at: input.occurred_at ?? "2026-05-29T10:00:00.000Z",
      source: input.source,
      event_type: input.event_type,
      actor_user_id: input.actor_user_id ?? null,
      subject_id: input.subject_id ?? null,
      payload: input.payload,
      prev_hash: null,
      entry_hash: "x",
      correlation_id: input.correlation_id ?? null,
      rationale: input.rationale ?? null,
    })),
  };
}

const INCIDENT = "33333333-3333-3333-3333-333333333333";
const OPERATOR = "44444444-4444-4444-4444-444444444444";
const CORR = "55555555-5555-5555-5555-555555555555";

function validMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: "incident.transitioned",
    schema_version: "v1",
    incident_id: INCIDENT,
    correlation_id: CORR,
    transition: {
      from: "new",
      to: "acknowledged",
      command: "acknowledge",
      actor: OPERATOR,
      reason: "tower confirmed",
      occurred_at: "2026-05-29T10:00:00.000Z",
    },
    ...overrides,
  });
}

describe("IncidentTransitionsSubscriber.handleMessage", () => {
  it("appends a canonical row from a well-formed message", async () => {
    const writer = fakeWriter();
    const subscriber = new IncidentTransitionsSubscriber({
      redis: fakeRedis(),
      writer: writer as unknown as Parameters<typeof IncidentTransitionsSubscriber>[0]["writer"],
      logger,
    });
    await subscriber.handleMessage("incident.transition.acknowledged", validMessage());
    expect(writer.append).toHaveBeenCalledOnce();
    const call = writer.append.mock.calls[0]![0];
    expect(call.source).toBe("incident-service");
    expect(call.event_type).toBe("incident.transitioned");
    expect(call.subject_id).toBe(INCIDENT);
    expect(call.actor_user_id).toBe(OPERATOR);
    expect(call.correlation_id).toBe(CORR);
    expect(call.rationale).toBe("tower confirmed");
    expect(call.occurred_at).toBe("2026-05-29T10:00:00.000Z");
  });

  it("treats a non-uuid actor as null (system-emitted)", async () => {
    const writer = fakeWriter();
    const subscriber = new IncidentTransitionsSubscriber({
      redis: fakeRedis(),
      writer: writer as unknown as Parameters<typeof IncidentTransitionsSubscriber>[0]["writer"],
      logger,
    });
    await subscriber.handleMessage(
      "incident.transition.acknowledged",
      JSON.stringify({
        event_type: "incident.transitioned",
        incident_id: INCIDENT,
        transition: { actor: "system", from: "new", to: "acknowledged" },
      }),
    );
    expect(writer.append.mock.calls[0]![0].actor_user_id).toBeNull();
  });

  it("drops malformed JSON without throwing", async () => {
    const writer = fakeWriter();
    const subscriber = new IncidentTransitionsSubscriber({
      redis: fakeRedis(),
      writer: writer as unknown as Parameters<typeof IncidentTransitionsSubscriber>[0]["writer"],
      logger,
    });
    await subscriber.handleMessage("incident.transition.x", "not json");
    expect(writer.append).not.toHaveBeenCalled();
    expect(subscriber.droppedCount).toBe(1);
  });

  it("drops messages with the wrong event_type", async () => {
    const writer = fakeWriter();
    const subscriber = new IncidentTransitionsSubscriber({
      redis: fakeRedis(),
      writer: writer as unknown as Parameters<typeof IncidentTransitionsSubscriber>[0]["writer"],
      logger,
    });
    await subscriber.handleMessage(
      "incident.transition.acknowledged",
      JSON.stringify({ event_type: "sensor.frame.captured", incident_id: INCIDENT }),
    );
    expect(writer.append).not.toHaveBeenCalled();
    expect(subscriber.droppedCount).toBe(1);
  });

  it("drops when incident_id isn't a UUID", async () => {
    const writer = fakeWriter();
    const subscriber = new IncidentTransitionsSubscriber({
      redis: fakeRedis(),
      writer: writer as unknown as Parameters<typeof IncidentTransitionsSubscriber>[0]["writer"],
      logger,
    });
    await subscriber.handleMessage(
      "incident.transition.acknowledged",
      validMessage({ incident_id: "not-a-uuid" }),
    );
    expect(writer.append).not.toHaveBeenCalled();
    expect(subscriber.droppedCount).toBe(1);
  });
});

describe("IncidentTransitionsSubscriber lifecycle", () => {
  it("psubscribes on start + punsubscribes on stop", async () => {
    const redis = fakeRedis();
    const subscriber = new IncidentTransitionsSubscriber({
      redis,
      writer: fakeWriter() as unknown as Parameters<
        typeof IncidentTransitionsSubscriber
      >[0]["writer"],
      logger,
    });
    await subscriber.start();
    expect(redis.psubscribe).toHaveBeenCalledWith("incident.transition.*");
    await subscriber.stop();
    expect(redis.punsubscribe).toHaveBeenCalledWith("incident.transition.*");
  });
});
