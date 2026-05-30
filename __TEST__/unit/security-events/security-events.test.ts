/**
 * @aip/security-events tests (T-506).
 *
 * Covers: envelope builder, channel naming, Redis publisher
 * (success + failure swallowing), and the in-memory recorder used
 * by tests across services.
 */
import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../../../packages/metrics/src/index.js";
import {
  buildSecurityEvent,
  channelFor,
  RecordingSecurityEventPublisher,
  RedisSecurityEventPublisher,
  SECURITY_EVENT_TYPES,
} from "../../../packages/security-events/src/index.js";

function freshRegistry() {
  return createRegistry({
    service: "security-events-test",
    collectDefault: false,
  });
}

function silentLogger() {
  return {
    level: "fatal" as const,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => silentLogger(),
  } as unknown as Parameters<typeof RedisSecurityEventPublisher.prototype.constructor>[0]["logger"];
}

describe("buildSecurityEvent", () => {
  it("stamps event_id (uuid), schema_version, and an iso timestamp", () => {
    const ev = buildSecurityEvent({
      event_type: "auth.login.succeeded",
      source: { service: "api-gateway" },
      actor_user_id: "00000000-0000-0000-0000-000000000001",
      subject_id: "00000000-0000-0000-0000-000000000001",
      payload: { email: "a@b.test" },
    });
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev.schema_version).toBe("v1");
    expect(ev.event_type).toBe("auth.login.succeeded");
    expect(new Date(ev.timestamp).toISOString()).toBe(ev.timestamp);
  });

  it("honours an injected clock for deterministic tests", () => {
    const ev = buildSecurityEvent({
      event_type: "auth.login.failed",
      source: { service: "api-gateway" },
      actor_user_id: null,
      subject_id: null,
      payload: {},
      now: () => "2026-05-29T10:00:00.000Z",
    });
    expect(ev.timestamp).toBe("2026-05-29T10:00:00.000Z");
  });

  it("includes correlation_id when passed, omits when missing", () => {
    const with_id = buildSecurityEvent({
      event_type: "access.denied",
      source: { service: "api-gateway" },
      actor_user_id: null,
      subject_id: null,
      payload: {},
      correlation_id: "req-abc-123",
    });
    expect(with_id.correlation_id).toBe("req-abc-123");

    const without = buildSecurityEvent({
      event_type: "access.denied",
      source: { service: "api-gateway" },
      actor_user_id: null,
      subject_id: null,
      payload: {},
    });
    expect(without).not.toHaveProperty("correlation_id");
  });
});

describe("channelFor", () => {
  it("maps every event_type to events.security.<type>", () => {
    for (const t of SECURITY_EVENT_TYPES) {
      expect(channelFor(t)).toBe(`events.security.${t}`);
    }
  });
});

describe("RedisSecurityEventPublisher", () => {
  it("publishes the envelope to events.security.<type> on the redis client", async () => {
    const publish = vi.fn(async () => 1);
    const redis = { publish } as unknown as Parameters<
      typeof RedisSecurityEventPublisher.prototype.constructor
    >[0]["redis"];
    const pub = new RedisSecurityEventPublisher({
      redis,
      logger: silentLogger(),
      registry: freshRegistry(),
    });
    const ev = buildSecurityEvent({
      event_type: "auth.login.succeeded",
      source: { service: "api-gateway" },
      actor_user_id: "00000000-0000-0000-0000-000000000001",
      subject_id: "00000000-0000-0000-0000-000000000001",
      payload: { email: "a@b.test" },
    });
    await pub.emit(ev);
    expect(publish).toHaveBeenCalledOnce();
    const [channel, payload] = publish.mock.calls[0]!;
    expect(channel).toBe("events.security.auth.login.succeeded");
    expect(JSON.parse(payload as string).event_id).toBe(ev.event_id);
  });

  it("swallows publish failures — never rethrows to the caller", async () => {
    const publish = vi.fn(async () => {
      throw new Error("redis down");
    });
    const redis = { publish } as unknown as Parameters<
      typeof RedisSecurityEventPublisher.prototype.constructor
    >[0]["redis"];
    const pub = new RedisSecurityEventPublisher({
      redis,
      logger: silentLogger(),
      registry: freshRegistry(),
    });
    const ev = buildSecurityEvent({
      event_type: "auth.login.succeeded",
      source: { service: "api-gateway" },
      actor_user_id: null,
      subject_id: null,
      payload: {},
    });
    // Must NOT throw — an audit miss is a degradation, not a user-
    // visible failure.
    await expect(pub.emit(ev)).resolves.toBeUndefined();
  });

  it("increments the failures counter on publish error", async () => {
    const publish = vi.fn(async () => {
      throw new Error("broken");
    });
    const redis = { publish } as unknown as Parameters<
      typeof RedisSecurityEventPublisher.prototype.constructor
    >[0]["redis"];
    const reg = freshRegistry();
    const pub = new RedisSecurityEventPublisher({
      redis,
      logger: silentLogger(),
      registry: reg,
    });
    await pub.emit(
      buildSecurityEvent({
        event_type: "auth.login.failed",
        source: { service: "api-gateway" },
        actor_user_id: null,
        subject_id: null,
        payload: {},
      }),
    );
    const text = await reg.metrics();
    expect(text).toMatch(
      /security_events_publish_failures_total\{[^}]*event_type="auth.login.failed"[^}]*\}\s+1/,
    );
  });
});

describe("RecordingSecurityEventPublisher", () => {
  it("appends every emitted event to `published`", async () => {
    const rec = new RecordingSecurityEventPublisher();
    await rec.emit(
      buildSecurityEvent({
        event_type: "auth.login.succeeded",
        source: { service: "api-gateway" },
        actor_user_id: "00000000-0000-0000-0000-000000000001",
        subject_id: "00000000-0000-0000-0000-000000000001",
        payload: {},
      }),
    );
    await rec.emit(
      buildSecurityEvent({
        event_type: "auth.login.failed",
        source: { service: "api-gateway" },
        actor_user_id: null,
        subject_id: null,
        payload: {},
      }),
    );
    expect(rec.published).toHaveLength(2);
    expect(rec.published.map((e) => e.event_type)).toEqual([
      "auth.login.succeeded",
      "auth.login.failed",
    ]);
  });
});
