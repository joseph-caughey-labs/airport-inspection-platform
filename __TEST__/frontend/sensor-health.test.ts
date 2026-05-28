import { describe, expect, it } from "vitest";
import { summarizeSensorHealth } from "~/utils/sensor-health";
import type { Sensor } from "~/types/airport";

const NOW = new Date("2026-05-28T10:00:00.000Z");

function sensor(p: Partial<Sensor> = {}): Sensor {
  return {
    id: p.id ?? "CAM-1",
    airport_id: p.airport_id ?? "11111111-1111-1111-1111-aaaaaaaaaaaa",
    type: p.type ?? "camera",
    lat: 37.6,
    lng: -122.4,
    status: p.status ?? "online",
    last_seen_at: p.last_seen_at ?? "2026-05-28T09:59:30.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("summarizeSensorHealth", () => {
  it("counts by status and reports total", () => {
    const out = summarizeSensorHealth(
      [
        sensor({ id: "1", status: "online" }),
        sensor({ id: "2", status: "online" }),
        sensor({ id: "3", status: "degraded" }),
        sensor({ id: "4", status: "offline" }),
      ],
      NOW,
    );
    expect(out.total).toBe(4);
    expect(out.byStatus).toEqual({ online: 2, degraded: 1, offline: 1 });
  });

  it("picks the worst status across the list", () => {
    expect(summarizeSensorHealth([sensor({ status: "online" })], NOW).worst).toBe("online");
    expect(
      summarizeSensorHealth([sensor({ status: "online" }), sensor({ status: "degraded" })], NOW)
        .worst,
    ).toBe("degraded");
    expect(
      summarizeSensorHealth([sensor({ status: "online" }), sensor({ status: "offline" })], NOW)
        .worst,
    ).toBe("offline");
  });

  it("returns online + 0 staleCount on an empty list (no nulls)", () => {
    const out = summarizeSensorHealth([], NOW);
    expect(out.total).toBe(0);
    expect(out.worst).toBe("online");
    expect(out.staleCount).toBe(0);
  });

  it("counts a sensor as stale when last_seen_at older than threshold", () => {
    const fresh = sensor({ id: "fresh", last_seen_at: "2026-05-28T09:59:00.000Z" }); // 60s
    const stale = sensor({ id: "stale", last_seen_at: "2026-05-28T09:55:00.000Z" }); // 5m
    const out = summarizeSensorHealth([fresh, stale], NOW, 120); // 2 minute threshold
    expect(out.staleCount).toBe(1);
  });

  it("never marks future-dated sensors as stale", () => {
    const future = sensor({ last_seen_at: "2026-05-28T10:05:00.000Z" });
    const out = summarizeSensorHealth([future], NOW);
    expect(out.staleCount).toBe(0);
  });
});
