/**
 * HTTP-surface tests for notification-service (T-413).
 *
 * Build the app with a small in-process channel + registry so we
 * can verify /channels (live status), /deliveries (recent
 * deliveries from the ring buffer), and /deliveries/dlq (webhook
 * DLQ contents) all return the right shapes.
 */
import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/notification-service/src/app.js";
import { ChannelRegistry } from "../../../services/notification-service/src/channels/registry.js";
import { WebhookChannel } from "../../../services/notification-service/src/channels/webhook.js";
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationEvent,
} from "../../../services/notification-service/src/channels/types.js";
import { bearer, makeTestSigner, operatorToken } from "../../helpers/auth.js";

const logger = createLogger({ service: "notification-service-test", level: "fatal" });

const signer = makeTestSigner();
let opAuth: { authorization: string };
beforeAll(async () => {
  opAuth = bearer(await operatorToken(signer));
});

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

function deliveringChannel(name: string): NotificationChannel {
  return {
    name,
    appliesTo: () => true,
    async deliver(e: NotificationEvent): Promise<DeliveryResult> {
      return {
        channel: name,
        event_id: e.event_id,
        status: "delivered",
        attempts: 1,
        completed_at: "2026-05-29T10:00:00.000Z",
      };
    },
  };
}

function event(id = "e-1"): NotificationEvent {
  return {
    event_id: id,
    event_type: "incident.transitioned",
    subject_id: "incident-1",
    source: "incident-service",
    occurred_at: "2026-05-29T10:00:00.000Z",
    payload: {},
  };
}

describe("notification-service — health + ready", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const registry = new ChannelRegistry({ channels: [deliveringChannel("in_app")] });
    app = await buildApp({ logger, redis: healthyRedis(), registry, signer });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /ready returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready" });
  });
});

describe("notification-service — /channels", () => {
  it("lists every configured channel", async () => {
    const registry = new ChannelRegistry({
      channels: [
        deliveringChannel("in_app"),
        deliveringChannel("webhook"),
        deliveringChannel("email"),
      ],
    });
    const app = await buildApp({ logger, redis: healthyRedis(), registry, signer });
    const res = await app.inject({ method: "GET", url: "/channels", headers: opAuth });
    const body = res.json() as { channels: { name: string }[] };
    expect(body.channels.map((c) => c.name)).toEqual(["in_app", "webhook", "email"]);
    await app.close();
  });
});

describe("notification-service — /deliveries", () => {
  it("returns recent deliveries, most-recent first", async () => {
    const registry = new ChannelRegistry({ channels: [deliveringChannel("in_app")] });
    await registry.dispatch(event("e-1"));
    await registry.dispatch(event("e-2"));
    const app = await buildApp({ logger, redis: healthyRedis(), registry, signer });
    const res = await app.inject({ method: "GET", url: "/deliveries", headers: opAuth });
    const body = res.json() as { items: DeliveryResult[] };
    expect(body.items.map((i) => i.event_id)).toEqual(["e-2", "e-1"]);
    await app.close();
  });

  it("respects ?limit=", async () => {
    const registry = new ChannelRegistry({ channels: [deliveringChannel("in_app")] });
    await registry.dispatch(event("e-1"));
    await registry.dispatch(event("e-2"));
    await registry.dispatch(event("e-3"));
    const app = await buildApp({ logger, redis: healthyRedis(), registry, signer });
    const res = await app.inject({ method: "GET", url: "/deliveries?limit=2", headers: opAuth });
    expect((res.json() as { items: DeliveryResult[] }).items).toHaveLength(2);
    await app.close();
  });
});

describe("notification-service — /deliveries/dlq", () => {
  it("returns webhook DLQ contents", async () => {
    const webhook = new WebhookChannel({
      url: "https://example/h",
      fetchFn: (async () =>
        ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch,
      sleep: async () => undefined,
      maxAttempts: 1,
    });
    await webhook.deliver(event("e-dlq"));
    const registry = new ChannelRegistry({ channels: [webhook] });
    const app = await buildApp({ logger, redis: healthyRedis(), registry, webhook, signer });
    const res = await app.inject({ method: "GET", url: "/deliveries/dlq", headers: opAuth });
    const body = res.json() as { items: DeliveryResult[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.event_id).toBe("e-dlq");
    await app.close();
  });

  it("returns an empty list when no webhook is wired", async () => {
    const registry = new ChannelRegistry({ channels: [deliveringChannel("in_app")] });
    const app = await buildApp({ logger, redis: healthyRedis(), registry, signer });
    const res = await app.inject({ method: "GET", url: "/deliveries/dlq", headers: opAuth });
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
    await app.close();
  });
});
