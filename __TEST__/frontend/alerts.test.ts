import { describe, expect, it } from "vitest";
import {
  countsBySeverity,
  formatRelativeTime,
  insertAlert,
  severityFromEventType,
  titleForEventType,
  worstSeverity,
} from "~/utils/alerts";
import { SEVERITY_GLYPH, SEVERITY_RANK } from "~/types/alert";
import type { AlertItem } from "~/types/alert";

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";

function alert(partial: Partial<AlertItem> = {}): AlertItem {
  return {
    id: partial.id ?? "a-1",
    event_type: partial.event_type ?? "sensor.frame.captured",
    severity: partial.severity ?? "info",
    title: partial.title ?? "test",
    detail: partial.detail,
    sensor_id: partial.sensor_id,
    airport_id: partial.airport_id ?? AIRPORT,
    received_at: partial.received_at ?? "2026-05-28T10:00:00.000Z",
  };
}

describe("severityFromEventType", () => {
  it("maps incident.* to critical/high", () => {
    expect(severityFromEventType("incident.created")).toBe("critical");
    expect(severityFromEventType("incident.escalated")).toBe("high");
  });

  it("maps ai.detection.* to medium", () => {
    expect(severityFromEventType("ai.detection.fod")).toBe("medium");
  });

  it("maps sensor.* and presence.* to info", () => {
    expect(severityFromEventType("sensor.frame.captured")).toBe("info");
    expect(severityFromEventType("presence.changed")).toBe("info");
  });

  it("maps system.* to low", () => {
    expect(severityFromEventType("system.heartbeat")).toBe("low");
  });

  it("falls back to info for unknown event types (pessimistic on critical count)", () => {
    expect(severityFromEventType("unknown.thing.weird")).toBe("info");
  });
});

describe("titleForEventType", () => {
  it("returns a friendly label for known types", () => {
    expect(titleForEventType("sensor.frame.captured")).toBe("Sensor telemetry");
    expect(titleForEventType("presence.snapshot")).toBe("Subscribers snapshot");
    expect(titleForEventType("incident.created")).toBe("Incident opened");
  });

  it("echoes the event_type for unknown types so nothing is silently lost", () => {
    expect(titleForEventType("foo.bar.baz")).toBe("foo.bar.baz");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-28T10:00:00.000Z");

  it("formats seconds", () => {
    expect(formatRelativeTime("2026-05-28T09:59:55.000Z", now)).toBe("5s");
  });
  it("formats minutes", () => {
    expect(formatRelativeTime("2026-05-28T09:55:00.000Z", now)).toBe("5m");
  });
  it("formats hours up to 48", () => {
    expect(formatRelativeTime("2026-05-28T03:00:00.000Z", now)).toBe("7h");
    expect(formatRelativeTime("2026-05-26T11:00:00.000Z", now)).toBe("47h");
  });
  it("flips to days at 48h", () => {
    expect(formatRelativeTime("2026-05-26T10:00:00.000Z", now)).toBe("2d");
  });
  it("clamps negative deltas (future timestamps) to 0s", () => {
    expect(formatRelativeTime("2026-05-28T10:01:00.000Z", now)).toBe("0s");
  });
  it("returns em-dash on invalid input", () => {
    expect(formatRelativeTime("garbage", now)).toBe("—");
  });
});

describe("worstSeverity + countsBySeverity", () => {
  it("returns info for empty list", () => {
    expect(worstSeverity([])).toBe("info");
  });

  it("finds the worst severity in a mixed list", () => {
    expect(worstSeverity([alert({ severity: "low" }), alert({ id: "b", severity: "high" })])).toBe(
      "high",
    );
  });

  it("includes every severity key in counts, zero-defaulted", () => {
    const counts = countsBySeverity([]);
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  });

  it("counts by severity correctly", () => {
    const counts = countsBySeverity([
      alert({ id: "1", severity: "critical" }),
      alert({ id: "2", severity: "critical" }),
      alert({ id: "3", severity: "low" }),
    ]);
    expect(counts.critical).toBe(2);
    expect(counts.low).toBe(1);
    expect(counts.info).toBe(0);
  });
});

describe("insertAlert", () => {
  it("inserts newest-first by received_at", () => {
    const a = alert({ id: "1", received_at: "2026-05-28T10:00:00.000Z" });
    const b = alert({ id: "2", received_at: "2026-05-28T10:00:05.000Z" });
    const list = insertAlert([a], b, 10);
    expect(list.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("deduplicates on id (at-least-once delivery safety)", () => {
    const a = alert({ id: "1" });
    const list = insertAlert([a], a, 10);
    expect(list).toHaveLength(1);
  });

  it("caps at maxItems, dropping the oldest", () => {
    let list: AlertItem[] = [];
    for (let i = 0; i < 5; i++) {
      list = insertAlert(
        list,
        alert({ id: String(i), received_at: `2026-05-28T10:00:0${i}.000Z` }),
        3,
      );
    }
    expect(list).toHaveLength(3);
    expect(list.map((i) => i.id)).toEqual(["4", "3", "2"]);
  });
});

describe("severity tokens", () => {
  it("orders severity ranks descending", () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
    expect(SEVERITY_RANK.low).toBeGreaterThan(SEVERITY_RANK.info);
  });

  it("emits a distinct glyph per severity (color-independent indicator)", () => {
    const glyphs = Object.values(SEVERITY_GLYPH);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
