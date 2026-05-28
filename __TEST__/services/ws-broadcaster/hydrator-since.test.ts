import { describe, expect, it, vi } from "vitest";
import { FrameHydrator } from "../../../services/ws-broadcaster/src/channels/hydrator.js";

const AIRPORT = "11111111-2222-3333-4444-555555555555";
const CURSOR = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const rowBase = {
  sensor_id: "CAM-1",
  sensor_type: "camera",
  frame_id: "f1",
  captured_at: "2026-05-28T10:00:00.000Z",
  geo_lat: 37.62,
  geo_lng: -122.37,
  geo_alt_m: null,
  metadata: {},
  idempotency_key: "k",
};

interface QueryCall {
  sql: string;
  params?: unknown[];
}

/**
 * Multi-query fake. Routes by SQL substring so we can return different
 * result sets to the resume query vs. the fallback tail query without
 * coupling the test to query order.
 */
function makePool(opts: {
  resumeRows?: Record<string, unknown>[];
  fallbackRows?: Record<string, unknown>[];
}) {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params ? { params } : {}) });
    if (sql.includes("WITH cursor AS")) {
      return { rows: opts.resumeRows ?? [], rowCount: opts.resumeRows?.length ?? 0 };
    }
    return { rows: opts.fallbackRows ?? [], rowCount: opts.fallbackRows?.length ?? 0 };
  });
  return { pool: { query } as unknown as import("pg").Pool, query, calls };
}

describe("FrameHydrator.hydrateSince", () => {
  it("returns mode=resume when the cursor matches a row and overflow not hit", async () => {
    const { pool, calls } = makePool({
      resumeRows: [
        { ...rowBase, event_id: "e2", received_at: "2026-05-28T10:00:01.000Z" },
        { ...rowBase, event_id: "e3", received_at: "2026-05-28T10:00:02.000Z" },
      ],
    });
    const h = new FrameHydrator({ pool });
    const result = await h.hydrateSince(AIRPORT, CURSOR);
    expect(result.mode).toBe("resume");
    expect(result.frames.map((f) => f.event_id)).toEqual(["e2", "e3"]);
    expect(calls[0]?.params).toEqual([AIRPORT, CURSOR, 501]);
  });

  it("returns mode=resume_capped when results exceed the limit", async () => {
    const overLimit = Array.from({ length: 4 }).map((_, i) => ({
      ...rowBase,
      event_id: `e${i}`,
      received_at: `2026-05-28T10:00:0${i}.000Z`,
    }));
    const { pool } = makePool({ resumeRows: overLimit });
    const h = new FrameHydrator({ pool });
    const result = await h.hydrateSince(AIRPORT, CURSOR, 3);
    expect(result.mode).toBe("resume_capped");
    expect(result.frames).toHaveLength(3);
  });

  it("returns mode=resume_fallback when cursor isn't a uuid", async () => {
    const { pool, query } = makePool({
      fallbackRows: [{ ...rowBase, event_id: "tail", received_at: "2026-05-28T10:00:05.000Z" }],
    });
    const h = new FrameHydrator({ pool });
    const result = await h.hydrateSince(AIRPORT, "not-a-uuid");
    expect(result.mode).toBe("resume_fallback");
    expect(result.frames.map((f) => f.event_id)).toEqual(["tail"]);
    // Should have run only the fallback SELECT, not the CTE
    expect(query.mock.calls.every((c) => !(c[0] as string).includes("WITH cursor AS"))).toBe(true);
  });

  it("returns mode=resume_fallback when cursor row isn't found in the retention window", async () => {
    const { pool, calls } = makePool({
      resumeRows: [],
      fallbackRows: [{ ...rowBase, event_id: "tail", received_at: "2026-05-28T10:00:05.000Z" }],
    });
    const h = new FrameHydrator({ pool });
    const result = await h.hydrateSince(AIRPORT, CURSOR);
    expect(result.mode).toBe("resume_fallback");
    expect(result.frames.map((f) => f.event_id)).toEqual(["tail"]);
    // First call was the CTE attempt; second was the fallback.
    expect(calls[0]?.sql).toMatch(/WITH cursor AS/);
    expect(calls[1]?.sql).toMatch(/FROM sensor_events\s+WHERE airport_id/);
  });

  it("caps limit at MAX_RESUME (1000)", async () => {
    const { pool, calls } = makePool({
      resumeRows: [{ ...rowBase, event_id: "e1", received_at: "2026-05-28T10:00:01.000Z" }],
    });
    const h = new FrameHydrator({ pool });
    await h.hydrateSince(AIRPORT, CURSOR, 99999);
    expect(calls[0]?.params?.[2]).toBe(1001);
  });

  it("filters by airport in the resume CTE", async () => {
    const { pool, calls } = makePool({ resumeRows: [] });
    const h = new FrameHydrator({ pool });
    await h.hydrateSince(AIRPORT, CURSOR).catch(() => undefined);
    expect(calls[0]?.sql).toMatch(/WHERE e\.airport_id = \$1/);
    expect(calls[0]?.params?.[0]).toBe(AIRPORT);
  });
});
