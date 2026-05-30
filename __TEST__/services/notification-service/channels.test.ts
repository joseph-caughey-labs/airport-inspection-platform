/**
 * Channel tests (T-413).
 *
 * Each channel has its own appliesTo + deliver contract. Tests use
 * minimal fakes — the channels are pure with respect to their
 * injected dependencies (Redis, fetch, logger).
 */
import { createLogger } from "@aip/logger";
import { describe, expect, it, vi } from "vitest";
import { EmailChannel } from "../../../services/notification-service/src/channels/email.js";
import { InAppChannel } from "../../../services/notification-service/src/channels/in-app.js";
import { WebhookChannel } from "../../../services/notification-service/src/channels/webhook.js";
import type { NotificationEvent } from "../../../services/notification-service/src/channels/types.js";

const logger = createLogger({ service: "channels-test", level: "fatal" });

const FIXED_NOW = new Date("2026-05-29T10:00:00.000Z");
const now = () => FIXED_NOW;

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event_id: "11111111-1111-1111-1111-111111111111",
    event_type: "incident.transitioned",
    subject_id: "22222222-2222-2222-2222-222222222222",
    source: "incident-service",
    occurred_at: "2026-05-29T10:00:00.000Z",
    payload: { airport_id: "33333333-3333-3333-3333-333333333333" },
    ...overrides,
  };
}

describe("InAppChannel", () => {
  it("publishes to events.broadcast.<airport_id>", async () => {
    const redis = { publish: vi.fn(async () => 1) };
    const ch = new InAppChannel({
      redis: redis as unknown as import("ioredis").default,
      now,
    });
    const result = await ch.deliver(event());
    expect(result.status).toBe("delivered");
    expect(result.target).toBe("events.broadcast.33333333-3333-3333-3333-333333333333");
    expect(redis.publish).toHaveBeenCalledOnce();
  });

  it("falls back to .unscoped when payload lacks airport_id", async () => {
    const redis = { publish: vi.fn(async () => 1) };
    const ch = new InAppChannel({
      redis: redis as unknown as import("ioredis").default,
      now,
    });
    const result = await ch.deliver(event({ payload: {} }));
    expect(result.target).toBe("events.broadcast.unscoped");
  });

  it("returns status=failed when the publish throws", async () => {
    const redis = {
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const ch = new InAppChannel({
      redis: redis as unknown as import("ioredis").default,
      now,
    });
    const result = await ch.deliver(event());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("redis down");
  });
});

describe("WebhookChannel", () => {
  function fakeFetch(responses: Array<{ ok: boolean; status: number } | Error>): typeof fetch {
    let i = 0;
    return vi.fn(async () => {
      const r = responses[i++]!;
      if (r instanceof Error) throw r;
      return r as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("delivers on the first 2xx", async () => {
    const ch = new WebhookChannel({
      url: "https://hooks.example/incidents",
      fetchFn: fakeFetch([{ ok: true, status: 200 }]),
      sleep: async () => undefined,
      now,
    });
    const result = await ch.deliver(event());
    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(1);
    expect(ch.dlq).toHaveLength(0);
  });

  it("retries on 5xx up to maxAttempts then DLQs", async () => {
    const ch = new WebhookChannel({
      url: "https://hooks.example/incidents",
      fetchFn: fakeFetch([
        { ok: false, status: 500 },
        { ok: false, status: 500 },
        { ok: false, status: 503 },
      ]),
      sleep: async () => undefined,
      now,
      maxAttempts: 3,
    });
    const result = await ch.deliver(event());
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(result.error).toBe("http_503");
    expect(ch.dlq).toHaveLength(1);
  });

  it("retries on fetch throw + recovers on a later attempt", async () => {
    const ch = new WebhookChannel({
      url: "https://hooks.example/incidents",
      fetchFn: fakeFetch([new Error("network blip"), { ok: true, status: 200 }]),
      sleep: async () => undefined,
      now,
    });
    const result = await ch.deliver(event());
    expect(result.status).toBe("delivered");
    expect(result.attempts).toBe(2);
    expect(ch.dlq).toHaveLength(0);
  });

  it("appliesTo returns false when url is empty", () => {
    const ch = new WebhookChannel({ url: "", now });
    expect(ch.appliesTo(event())).toBe(false);
  });

  it("appliesTo respects the event_type allowlist", () => {
    const ch = new WebhookChannel({
      url: "https://h",
      eventTypeAllowlist: ["incident.transitioned"],
      now,
    });
    expect(ch.appliesTo(event())).toBe(true);
    expect(ch.appliesTo(event({ event_type: "sensor.frame.captured" }))).toBe(false);
  });
});

describe("EmailChannel", () => {
  it("delivers + logs the recipient", async () => {
    const ch = new EmailChannel({ logger, now, recipients: ["ops@example.com"] });
    const result = await ch.deliver(event());
    expect(result.status).toBe("delivered");
    expect(result.target).toBe("ops@example.com");
  });

  it("appliesTo respects the allowlist", () => {
    const ch = new EmailChannel({
      logger,
      eventTypeAllowlist: ["incident.transitioned"],
      now,
    });
    expect(ch.appliesTo(event())).toBe(true);
    expect(ch.appliesTo(event({ event_type: "x" }))).toBe(false);
  });
});
