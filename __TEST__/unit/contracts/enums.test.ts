import { describe, expect, it } from "vitest";
import {
  DetectionClass,
  IncidentStatus,
  Role,
  SEVERITY_ORDER,
  Severity,
  SensorType,
  TERMINAL_INCIDENT_STATUSES,
} from "../../../packages/shared-contracts/src/index.js";

describe("Severity", () => {
  it("accepts all known bands", () => {
    for (const v of ["critical", "high", "medium", "low", "info"] as const) {
      expect(Severity.parse(v)).toBe(v);
    }
  });

  it("rejects unknown values", () => {
    expect(() => Severity.parse("URGENT")).toThrow();
    expect(() => Severity.parse("")).toThrow();
    expect(() => Severity.parse(null)).toThrow();
  });

  it("SEVERITY_ORDER lists most-severe-first", () => {
    expect(SEVERITY_ORDER[0]).toBe("critical");
    expect(SEVERITY_ORDER[SEVERITY_ORDER.length - 1]).toBe("info");
    expect(SEVERITY_ORDER).toHaveLength(5);
  });
});

describe("IncidentStatus", () => {
  it("accepts the 8 lifecycle states", () => {
    const valid = [
      "new",
      "acknowledged",
      "assigned",
      "in_progress",
      "resolved",
      "escalated",
      "archived",
      "rejected",
    ] as const;
    for (const v of valid) {
      expect(IncidentStatus.parse(v)).toBe(v);
    }
  });

  it("flags terminal states", () => {
    expect(TERMINAL_INCIDENT_STATUSES.has("resolved")).toBe(true);
    expect(TERMINAL_INCIDENT_STATUSES.has("archived")).toBe(true);
    expect(TERMINAL_INCIDENT_STATUSES.has("rejected")).toBe(true);
    expect(TERMINAL_INCIDENT_STATUSES.has("new")).toBe(false);
    expect(TERMINAL_INCIDENT_STATUSES.has("in_progress")).toBe(false);
  });
});

describe("SensorType", () => {
  it("accepts all sensor categories", () => {
    for (const v of ["camera", "lidar", "gps", "imu", "weather", "perimeter"] as const) {
      expect(SensorType.parse(v)).toBe(v);
    }
  });

  it("rejects unknown sensors", () => {
    expect(() => SensorType.parse("microphone")).toThrow();
  });
});

describe("Role", () => {
  it("accepts the three platform roles", () => {
    expect(Role.parse("operator")).toBe("operator");
    expect(Role.parse("reviewer")).toBe("reviewer");
    expect(Role.parse("admin")).toBe("admin");
  });

  it("rejects unknown roles", () => {
    expect(() => Role.parse("superadmin")).toThrow();
    expect(() => Role.parse("ANONYMOUS")).toThrow();
  });
});

describe("DetectionClass", () => {
  it("accepts every modeled detection class", () => {
    for (const v of [
      "fod",
      "pavement_crack",
      "snowbank_violation",
      "wildlife",
      "surface_anomaly",
    ] as const) {
      expect(DetectionClass.parse(v)).toBe(v);
    }
  });

  it("rejects classes that need an ADR before adding", () => {
    expect(() => DetectionClass.parse("aircraft_incursion")).toThrow();
  });
});
