/**
 * SecurityEventsSubscriber tests (T-506).
 *
 * Drives `handleMessage` directly so the test stays fast and
 * deterministic without spinning up a real Redis. Mirrors the
 * design of `incident-transitions-subscriber.test.ts`.
 */
import { createLogger } from "@aip/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditChainWriter } from "../../../services/audit-service/src/chain/writer.js";
import { SecurityEventsSubscriber } from "../../../services/audit-service/src/subscribers/security-events.js";

const logger = createLogger({ service: "security-events-subscriber-test", level: "fatal" });

// `AuditChainWriter` is the production type; for these tests we
// stub `append` to record what the subscriber called it with. Cast
// through unknown so we don't need to fake every internal field.
function makeRecordingWriter(): {
  writer: AuditChainWriter;
  appends: Parameters<AuditChainWriter["append"]>[0][];
} {
  const appends: Parameters<AuditChainWriter["append"]>[0][] = [];
  const writer = {
    append: vi.fn(async (input: Parameters<AuditChainWriter["append"]>[0]) => {
      appends.push(input);
      return {
        seq: String(appends.length),
        event_id: input.event_id ?? "00000000-0000-0000-0000-000000000000",
        entry_hash: "deadbeef",
        prev_hash: null,
        occurred_at: input.occurred_at ?? "2026-05-29T10:00:00.000Z",
      } as never;
    }),
  } as unknown as AuditChainWriter;
  return { writer, appends };
}

function makeFakeRedis(): import("ioredis").default {
  return {
    on: vi.fn(),
    off: vi.fn(),
    psubscribe: vi.fn(async () => 1),
    punsubscribe: vi.fn(async () => 1),
  } as unknown as import("ioredis").default;
}

const VALID_AUTH_LOGIN_SUCCESS = JSON.stringify({
  event_id: "11111111-1111-1111-1111-111111111111",
  event_type: "auth.login.succeeded",
  schema_version: "v1",
  source: { service: "api-gateway" },
  timestamp: "2026-05-29T10:00:00.000Z",
  actor_user_id: "00000000-0000-0000-0000-0000000000aa",
  subject_id: "00000000-0000-0000-0000-0000000000aa",
  correlation_id: "req-abc-123",
  payload: { email: "pat.operator@airport-ops.test", role: "operator", ip: "127.0.0.1" },
});

const VALID_AUTH_LOGIN_FAILED = JSON.stringify({
  event_id: "22222222-2222-2222-2222-222222222222",
  event_type: "auth.login.failed",
  schema_version: "v1",
  source: { service: "api-gateway" },
  timestamp: "2026-05-29T10:01:00.000Z",
  actor_user_id: null,
  subject_id: null,
  payload: { email: "no-such-user@example.test", ip: "127.0.0.1", reason: "no_such_user" },
});

let writer: AuditChainWriter;
let appends: Parameters<AuditChainWriter["append"]>[0][];
beforeEach(() => {
  ({ writer, appends } = makeRecordingWriter());
});

describe("SecurityEventsSubscriber — happy path", () => {
  it("appends an auth.login.succeeded as an audit row keyed on the user", async () => {
    const sub = new SecurityEventsSubscriber({ redis: makeFakeRedis(), writer, logger });
    await sub.handleMessage("events.security.auth.login.succeeded", VALID_AUTH_LOGIN_SUCCESS);

    expect(appends).toHaveLength(1);
    const row = appends[0]!;
    expect(row.source).toBe("api-gateway");
    expect(row.event_type).toBe("auth.login.succeeded");
    expect(row.actor_user_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(row.subject_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(row.correlation_id).toBe("req-abc-123");
    expect(row.occurred_at).toBe("2026-05-29T10:00:00.000Z");
    expect(row.payload).toMatchObject({ event_type: "auth.login.succeeded" });
  });

  it("appends an auth.login.failed with null actor + subject", async () => {
    const sub = new SecurityEventsSubscriber({ redis: makeFakeRedis(), writer, logger });
    await sub.handleMessage("events.security.auth.login.failed", VALID_AUTH_LOGIN_FAILED);

    expect(appends).toHaveLength(1);
    const row = appends[0]!;
    expect(row.actor_user_id).toBeNull();
    expect(row.subject_id).toBeNull();
    expect(row.payload).toMatchObject({ payload: { reason: "no_such_user" } });
  });
});

describe("SecurityEventsSubscriber — malformed input", () => {
  it("drops invalid JSON and bumps the dropped counter", async () => {
    const sub = new SecurityEventsSubscriber({ redis: makeFakeRedis(), writer, logger });
    await sub.handleMessage("events.security.auth.login.succeeded", "not-json{");
    expect(appends).toHaveLength(0);
    expect(sub.droppedCount).toBe(1);
  });

  it("drops envelopes with the wrong schema_version", async () => {
    const sub = new SecurityEventsSubscriber({ redis: makeFakeRedis(), writer, logger });
    const bad = JSON.stringify({
      event_id: "22222222-2222-2222-2222-222222222222",
      event_type: "auth.login.failed",
      schema_version: "v999",
      source: { service: "api-gateway" },
      actor_user_id: null,
      subject_id: null,
      payload: {},
    });
    await sub.handleMessage("events.security.auth.login.failed", bad);
    expect(appends).toHaveLength(0);
    expect(sub.droppedCount).toBe(1);
  });

  it("drops envelopes missing source.service", async () => {
    const sub = new SecurityEventsSubscriber({ redis: makeFakeRedis(), writer, logger });
    const bad = JSON.stringify({
      event_id: "22222222-2222-2222-2222-222222222222",
      event_type: "auth.login.failed",
      schema_version: "v1",
      source: {},
      actor_user_id: null,
      subject_id: null,
      payload: {},
    });
    await sub.handleMessage("events.security.auth.login.failed", bad);
    expect(appends).toHaveLength(0);
    expect(sub.droppedCount).toBe(1);
  });

  it("drops envelopes where actor_user_id is a non-UUID string", async () => {
    const sub = new SecurityEventsSubscriber({ redis: makeFakeRedis(), writer, logger });
    const bad = JSON.stringify({
      event_id: "22222222-2222-2222-2222-222222222222",
      event_type: "auth.login.failed",
      schema_version: "v1",
      source: { service: "api-gateway" },
      actor_user_id: "not-a-uuid",
      subject_id: null,
      payload: {},
    });
    await sub.handleMessage("events.security.auth.login.failed", bad);
    expect(appends).toHaveLength(0);
    expect(sub.droppedCount).toBe(1);
  });
});

describe("SecurityEventsSubscriber — lifecycle", () => {
  it("psubscribes to events.security.* on start, unsubscribes on stop", async () => {
    const redis = makeFakeRedis();
    const sub = new SecurityEventsSubscriber({ redis, writer, logger });
    await sub.start();
    expect(redis.psubscribe).toHaveBeenCalledWith("events.security.*");
    expect(redis.on).toHaveBeenCalledWith("pmessage", expect.any(Function));

    await sub.stop();
    expect(redis.punsubscribe).toHaveBeenCalledWith("events.security.*");
    expect(redis.off).toHaveBeenCalledWith("pmessage", expect.any(Function));
  });

  it("start is idempotent — calling twice does NOT double-subscribe", async () => {
    const redis = makeFakeRedis();
    const sub = new SecurityEventsSubscriber({ redis, writer, logger });
    await sub.start();
    await sub.start();
    expect((redis.psubscribe as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
