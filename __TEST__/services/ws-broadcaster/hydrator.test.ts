import { describe, expect, it, vi } from "vitest";
import { FrameHydrator } from "../../../services/ws-broadcaster/src/channels/hydrator.js";

const AIRPORT = "11111111-2222-3333-4444-555555555555";

function makePool(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, ...(params ? { params } : {}) });
    return { rows, rowCount: rows.length };
  });
  return { pool: { query } as unknown as import("pg").Pool, query, calls };
}

const rowBase = {
  sensor_id: "CAM-RWY10L-01",
  sensor_type: "camera",
  frame_id: "CAM-RWY10L-01-00000001",
  captured_at: "2026-05-28T10:00:00.000Z",
  geo_lat: 37.62,
  geo_lng: -122.37,
  geo_alt_m: 4,
  metadata: { w: 1920, h: 1080 },
  idempotency_key: "k1",
};

describe("FrameHydrator", () => {
  it("queries sensor_events filtered by airport_id and ordered DESC, then reverses to ASC", async () => {
    const { pool, calls } = makePool([
      { ...rowBase, event_id: "e3", received_at: "2026-05-28T10:00:02.000Z" },
      { ...rowBase, event_id: "e2", received_at: "2026-05-28T10:00:01.000Z" },
      { ...rowBase, event_id: "e1", received_at: "2026-05-28T10:00:00.000Z" },
    ]);
    const h = new FrameHydrator({ pool });
    const out = await h.hydrate(AIRPORT);
    expect(calls[0]?.sql).toMatch(/FROM sensor_events/);
    expect(calls[0]?.sql).toMatch(/WHERE airport_id = \$1/);
    expect(calls[0]?.sql).toMatch(/ORDER BY received_at DESC/);
    expect(calls[0]?.params?.[0]).toBe(AIRPORT);
    expect(out.map((f) => f.event_id)).toEqual(["e1", "e2", "e3"]);
  });

  it("caps limit at MAX_LIMIT (200) and floors at 1", async () => {
    const { pool, calls } = makePool([]);
    const h = new FrameHydrator({ pool });
    await h.hydrate(AIRPORT, 9999);
    expect(calls[0]?.params?.[1]).toBe(200);
    await h.hydrate(AIRPORT, 0);
    expect(calls[1]?.params?.[1]).toBe(1);
  });

  it("emits a sensor.frame.captured WS envelope", async () => {
    const { pool } = makePool([
      { ...rowBase, event_id: "e1", received_at: "2026-05-28T10:00:00.000Z" },
    ]);
    const h = new FrameHydrator({ pool });
    const [frame] = await h.hydrate(AIRPORT);
    expect(frame).toBeDefined();
    const parsed = JSON.parse(frame!.message);
    expect(parsed.type).toBe("sensor.frame.captured");
    expect(parsed.schema_version).toBe("v1");
    expect(parsed.last_event_id).toBe("e1");
    expect(parsed.payload.sensor_id).toBe("CAM-RWY10L-01");
    expect(parsed.payload.geo).toEqual({ lat: 37.62, lng: -122.37, alt_m: 4 });
  });

  it("omits alt_m when the column is null (exactOptionalPropertyTypes safe)", async () => {
    const { pool } = makePool([
      {
        ...rowBase,
        geo_alt_m: null,
        event_id: "e1",
        received_at: "2026-05-28T10:00:00.000Z",
      },
    ]);
    const h = new FrameHydrator({ pool });
    const [frame] = await h.hydrate(AIRPORT);
    const parsed = JSON.parse(frame!.message);
    expect(parsed.payload.geo).toEqual({ lat: 37.62, lng: -122.37 });
    expect("alt_m" in parsed.payload.geo).toBe(false);
  });

  it("returns [] for airport with no events", async () => {
    const { pool } = makePool([]);
    const h = new FrameHydrator({ pool });
    const out = await h.hydrate(AIRPORT);
    expect(out).toEqual([]);
  });
});
