/**
 * IncidentNotificationsSubscriber tests (T-413).
 *
 * Drives the pmessage handler directly so the test doesn't need a
 * real Redis. Verifies the parse → dedup → dispatch path plus the
 * lifecycle (psubscribe/punsubscribe) hooks.
 */
import { createLogger } from "@aip/logger";
import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../services/notification-service/src/channels/registry.js";
import { IncidentNotificationsSubscriber } from "../../../services/notification-service/src/subscribers/incident-notifications.js";
import type { NotificationChannel } from "../../../services/notification-service/src/channels/types.js";

const logger = createLogger({ service: "subscriber-test", level: "fatal" });

function fakeRedis(): import("ioredis").default {
  return {
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => 1),
    punsubscribe: vi.fn(async () => 1),
  } as unknown as import("ioredis").default;
}

function fakeChannel(): NotificationChannel {
  return {
    name: "fake",
    appliesTo: () => true,
    deliver: vi.fn(async (e) => ({
      channel: "fake",
      event_id: e.event_id,
      status: "delivered",
      attempts: 1,
      completed_at: "2026-05-29T10:00:00.000Z",
    })),
  };
}

const INCIDENT = "11111111-1111-1111-1111-111111111111";

function validMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "22222222-2222-2222-2222-222222222222",
    event_type: "incident.transitioned",
    schema_version: "v1",
    incident_id: INCIDENT,
    transition: { from: "new", to: "acknowledged", actor: "operator", reason: "ok" },
    ...overrides,
  });
}

describe("IncidentNotificationsSubscriber.handleMessage", () => {
  it("parses + dispatches a well-formed transition", async () => {
    const ch = fakeChannel();
    const registry = new ChannelRegistry({ channels: [ch] });
    const sub = new IncidentNotificationsSubscriber({
      redis: fakeRedis(),
      registry,
      logger,
    });
    await sub.handleMessage("incident.transition.acknowledged", validMessage());
    expect(ch.deliver).toHaveBeenCalledOnce();
    const event = (ch.deliver as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(event.subject_id).toBe(INCIDENT);
    expect(event.rationale).toBe("ok");
  });

  it("deduplicates the same event_id within the idempotency window", async () => {
    const ch = fakeChannel();
    const registry = new ChannelRegistry({ channels: [ch] });
    const sub = new IncidentNotificationsSubscriber({
      redis: fakeRedis(),
      registry,
      logger,
    });
    await sub.handleMessage("incident.transition.acknowledged", validMessage());
    await sub.handleMessage("incident.transition.acknowledged", validMessage());
    expect(ch.deliver).toHaveBeenCalledOnce();
    expect(sub.duplicateCount).toBe(1);
  });

  it("re-dispatches when event_id is different", async () => {
    const ch = fakeChannel();
    const registry = new ChannelRegistry({ channels: [ch] });
    const sub = new IncidentNotificationsSubscriber({
      redis: fakeRedis(),
      registry,
      logger,
    });
    await sub.handleMessage("x", validMessage({ event_id: "a" }));
    await sub.handleMessage("x", validMessage({ event_id: "b" }));
    expect(ch.deliver).toHaveBeenCalledTimes(2);
  });

  it("drops malformed JSON", async () => {
    const ch = fakeChannel();
    const sub = new IncidentNotificationsSubscriber({
      redis: fakeRedis(),
      registry: new ChannelRegistry({ channels: [ch] }),
      logger,
    });
    await sub.handleMessage("x", "not json");
    expect(ch.deliver).not.toHaveBeenCalled();
    expect(sub.droppedCount).toBe(1);
  });

  it("drops a wrong event_type", async () => {
    const ch = fakeChannel();
    const sub = new IncidentNotificationsSubscriber({
      redis: fakeRedis(),
      registry: new ChannelRegistry({ channels: [ch] }),
      logger,
    });
    await sub.handleMessage("x", JSON.stringify({ event_type: "other", incident_id: INCIDENT }));
    expect(ch.deliver).not.toHaveBeenCalled();
    expect(sub.droppedCount).toBe(1);
  });

  it("drops a non-UUID incident_id", async () => {
    const ch = fakeChannel();
    const sub = new IncidentNotificationsSubscriber({
      redis: fakeRedis(),
      registry: new ChannelRegistry({ channels: [ch] }),
      logger,
    });
    await sub.handleMessage("x", validMessage({ incident_id: "nope" }));
    expect(ch.deliver).not.toHaveBeenCalled();
    expect(sub.droppedCount).toBe(1);
  });
});

describe("IncidentNotificationsSubscriber lifecycle", () => {
  it("psubscribes on start + punsubscribes on stop", async () => {
    const redis = fakeRedis();
    const sub = new IncidentNotificationsSubscriber({
      redis,
      registry: new ChannelRegistry({ channels: [fakeChannel()] }),
      logger,
    });
    await sub.start();
    expect(redis.psubscribe).toHaveBeenCalledWith("incident.transition.*");
    await sub.stop();
    expect(redis.punsubscribe).toHaveBeenCalledWith("incident.transition.*");
  });
});
