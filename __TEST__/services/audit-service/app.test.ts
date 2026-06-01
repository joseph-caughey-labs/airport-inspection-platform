/**
 * HTTP-surface tests for audit-service (T-412).
 *
 * The route layer is tested with a hand-rolled fake Pool that maps
 * the SQL to canned responses. This keeps the tests fast and
 * deterministic; real DB integration is left to a future ticket.
 */
import { createLogger } from "@aip/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/audit-service/src/app.js";
import {
  computeEntryHash,
  GENESIS_PREV_HASH,
  type HashableAuditEntry,
} from "../../../services/audit-service/src/chain/hash.js";
import { bearer, makeTestSigner, operatorToken, reviewerToken } from "../../helpers/auth.js";

const logger = createLogger({ service: "audit-service-test", level: "fatal" });

// One signer per file, used to mint tokens AND wired through every
// `buildApp` call so the per-route requireRole guards (T-504c) see
// the same key the test's tokens were signed with.
const signer = makeTestSigner();
let opAuth: { authorization: string };
let revAuth: { authorization: string };
// Resolve once before the suites run; vitest awaits this via
// beforeAll because top-level await isn't enabled in this config.
beforeAll(async () => {
  opAuth = bearer(await operatorToken(signer));
  revAuth = bearer(await reviewerToken(signer));
});

function healthyRedis(): import("ioredis").default {
  return { ping: vi.fn(async () => "PONG") } as unknown as import("ioredis").default;
}

interface FakeRow extends HashableAuditEntry {
  seq: string;
  prev_hash: string | null;
  entry_hash: string;
}

function fixedRow(seq: string, payload: Record<string, unknown>, prev: string): FakeRow {
  const entry: HashableAuditEntry = {
    event_id: `00000000-0000-0000-0000-00000000000${seq}`,
    occurred_at: `2026-05-29T10:00:0${seq}.000Z`,
    source: "incident-service",
    event_type: "incident.transitioned",
    actor_user_id: null,
    subject_id: "subject-1",
    payload,
    correlation_id: null,
    rationale: null,
  };
  return {
    ...entry,
    seq,
    prev_hash: prev === GENESIS_PREV_HASH ? null : prev,
    entry_hash: computeEntryHash(prev, entry),
  };
}

interface QueryHandler {
  match: RegExp;
  rows: (params: unknown[]) => Record<string, unknown>[];
}

function fakePool(handlers: QueryHandler[]): import("pg").Pool {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      for (const h of handlers) {
        if (h.match.test(sql)) return { rows: h.rows(params) };
      }
      return { rows: [{ "?column?": 1 }] };
    }),
  } as unknown as import("pg").Pool;
}

const r1 = fixedRow("1", { from: "new", to: "acknowledged" }, GENESIS_PREV_HASH);
const r2 = fixedRow("2", { from: "acknowledged", to: "assigned" }, r1.entry_hash);
const r3 = fixedRow("3", { from: "assigned", to: "in_progress" }, r2.entry_hash);

describe("audit-service — /audit/events list", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([
        {
          match: /FROM audit_events/i,
          rows: () => [r3, r2, r1].map((r) => ({ ...r, seq: r.seq })),
        },
      ]),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns items newest-first + null cursor when fully drained", async () => {
    const res = await app.inject({ method: "GET", url: "/audit/events", headers: opAuth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { event_id: string }[]; next_cursor: string | null };
    expect(body.items.map((i) => i.event_id)).toEqual([r3.event_id, r2.event_id, r1.event_id]);
    expect(body.next_cursor).toBeNull();
  });
});

describe("audit-service — /audit/events list (cursor)", () => {
  it("returns next_cursor when more rows exist", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      // 4 rows but limit=3 → next_cursor surfaces.
      pool: fakePool([
        {
          match: /FROM audit_events/i,
          rows: () => [r3, r2, r1, fixedRow("0", {}, GENESIS_PREV_HASH)],
        },
      ]),
      listPageLimit: 3,
    });
    const res = await app.inject({
      method: "GET",
      url: "/audit/events?limit=3",
      headers: opAuth,
    });
    expect((res.json() as { next_cursor: string | null }).next_cursor).not.toBeNull();
    await app.close();
  });

  it("rejects a malformed cursor with 400", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([{ match: /./, rows: () => [] }]),
    });
    const res = await app.inject({
      method: "GET",
      url: "/audit/events?cursor=!!!",
      headers: opAuth,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("INVALID_CURSOR");
    await app.close();
  });
});

describe("audit-service — /audit/events/:event_id", () => {
  it("returns 400 INVALID_ID on a non-uuid", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([{ match: /./, rows: () => [] }]),
    });
    const res = await app.inject({
      method: "GET",
      url: "/audit/events/not-a-uuid",
      headers: opAuth,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when nothing matches", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([{ match: /WHERE event_id/i, rows: () => [] }]),
    });
    const res = await app.inject({
      method: "GET",
      url: `/audit/events/${r1.event_id}`,
      headers: opAuth,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("AUDIT_EVENT_NOT_FOUND");
    await app.close();
  });
});

describe("audit-service — /audit/lineage/:subject_id", () => {
  it("returns all events for a subject oldest-first", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([{ match: /WHERE subject_id/i, rows: () => [r1, r2, r3] }]),
    });
    const res = await app.inject({
      method: "GET",
      url: "/audit/lineage/subject-1",
      headers: opAuth,
    });
    const body = res.json() as { items: { event_id: string }[]; total: number };
    expect(body.items.map((i) => i.event_id)).toEqual([r1.event_id, r2.event_id, r3.event_id]);
    expect(body.total).toBe(3);
    await app.close();
  });
});

describe("audit-service — /audit/verify", () => {
  it("returns verified=true for an untampered chain", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([
        {
          // SELECT entry_hash ... seq < $1 — chainTipBefore helper.
          match: /SELECT entry_hash FROM audit_events WHERE seq < /i,
          rows: () => [],
        },
        { match: /FROM audit_events/i, rows: () => [r1, r2, r3] },
      ]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/audit/verify",
      payload: {},
      headers: revAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verified: boolean; broken_at: unknown; rows_scanned: number };
    expect(body.verified).toBe(true);
    expect(body.broken_at).toBeNull();
    expect(body.rows_scanned).toBe(3);
    await app.close();
  });

  it("returns verified=false + broken_at when a row is tampered", async () => {
    const tampered: FakeRow = { ...r2, payload: { evil: true } };
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([
        {
          match: /SELECT entry_hash FROM audit_events WHERE seq < /i,
          rows: () => [],
        },
        { match: /FROM audit_events/i, rows: () => [r1, tampered, r3] },
      ]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/audit/verify",
      payload: {},
      headers: revAuth,
    });
    const body = res.json() as { verified: boolean; broken_at: { broken_at_event_id: string } };
    expect(body.verified).toBe(false);
    expect(body.broken_at.broken_at_event_id).toBe(r2.event_id);
    await app.close();
  });

  it("rejects when the requested range exceeds verifyMaxRows", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([
        {
          match: /SELECT entry_hash FROM audit_events WHERE seq < /i,
          rows: () => [],
        },
        { match: /FROM audit_events/i, rows: () => Array(2).fill(r1) },
      ]),
      verifyMaxRows: 2,
    });
    const res = await app.inject({
      method: "POST",
      url: "/audit/verify",
      payload: {},
      headers: revAuth,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("VERIFY_RANGE_TOO_LARGE");
    await app.close();
  });
});

describe("audit-service — health + ready", () => {
  it("GET /health returns 200", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([{ match: /./, rows: () => [{ "?column?": 1 }] }]),
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("GET /ready returns 200 when both deps are up", async () => {
    const app = await buildApp({
      logger,
      signer,
      redis: healthyRedis(),
      pool: fakePool([{ match: /./, rows: () => [{ "?column?": 1 }] }]),
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("ready");
    await app.close();
  });
});
