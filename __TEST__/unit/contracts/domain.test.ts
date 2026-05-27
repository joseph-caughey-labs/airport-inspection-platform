import { describe, expect, it } from "vitest";
import {
  Airport,
  GeoPoint,
  IcaoCode,
  IataCode,
  Runway,
  RunwayDesignator,
  Sensor,
  SensorId,
  User,
} from "../../../packages/shared-contracts/src/index.js";

const TS = "2026-05-27T10:00:00.000Z";
const UUID = "11111111-2222-3333-4444-555555555555";

describe("IcaoCode", () => {
  it("accepts 4 uppercase letters", () => {
    expect(IcaoCode.parse("KSFO")).toBe("KSFO");
    expect(IcaoCode.parse("EGLL")).toBe("EGLL");
  });

  it("rejects wrong length, case, or non-letters", () => {
    expect(() => IcaoCode.parse("SFO")).toThrow();
    expect(() => IcaoCode.parse("ksfo")).toThrow();
    expect(() => IcaoCode.parse("K1FO")).toThrow();
    expect(() => IcaoCode.parse("KSFOX")).toThrow();
  });
});

describe("IataCode", () => {
  it("accepts 3 uppercase letters", () => {
    expect(IataCode.parse("SFO")).toBe("SFO");
    expect(IataCode.parse("LHR")).toBe("LHR");
  });

  it("rejects wrong shape", () => {
    expect(() => IataCode.parse("KSFO")).toThrow();
    expect(() => IataCode.parse("sfo")).toThrow();
  });
});

describe("Airport", () => {
  const valid = {
    id: UUID,
    icao_code: "KSFO",
    iata_code: "SFO",
    name: "San Francisco International",
    city: "San Francisco",
    country: "US",
    timezone: "America/Los_Angeles",
    created_at: TS,
  };

  it("accepts a fully formed airport", () => {
    expect(Airport.parse(valid)).toMatchObject({ icao_code: "KSFO" });
  });

  it("allows iata_code to be omitted", () => {
    const { iata_code: _, ...minimal } = valid;
    expect(() => Airport.parse(minimal)).not.toThrow();
  });

  it("rejects non-ISO country codes", () => {
    expect(() => Airport.parse({ ...valid, country: "USA" })).toThrow();
  });
});

describe("RunwayDesignator", () => {
  it("accepts NN within 01–36 with optional L/R/C", () => {
    for (const d of ["01", "09", "09L", "27R", "36C", "18"]) {
      expect(RunwayDesignator.parse(d)).toBe(d);
    }
  });

  it("rejects out-of-range, lowercase, or wrong shape", () => {
    expect(() => RunwayDesignator.parse("00")).toThrow();
    expect(() => RunwayDesignator.parse("37")).toThrow();
    expect(() => RunwayDesignator.parse("9L")).toThrow();
    expect(() => RunwayDesignator.parse("09l")).toThrow();
    expect(() => RunwayDesignator.parse("09Q")).toThrow();
  });
});

describe("Runway", () => {
  const valid = {
    id: UUID,
    airport_id: UUID,
    designator: "09L",
    paired_designator: "27R",
    length_m: 3618,
    width_m: 60,
    surface: "asphalt",
    status: "open",
    created_at: TS,
  };

  it("accepts a fully formed runway", () => {
    expect(Runway.parse(valid)).toMatchObject({ designator: "09L" });
  });

  it("rejects non-positive dimensions", () => {
    expect(() => Runway.parse({ ...valid, length_m: 0 })).toThrow();
    expect(() => Runway.parse({ ...valid, width_m: -1 })).toThrow();
  });
});

describe("GeoPoint", () => {
  it("accepts coordinates within bounds", () => {
    expect(GeoPoint.parse({ lat: 37.6213, lng: -122.379 })).toBeDefined();
  });

  it("rejects out-of-range lat/lng", () => {
    expect(() => GeoPoint.parse({ lat: 91, lng: 0 })).toThrow();
    expect(() => GeoPoint.parse({ lat: 0, lng: 181 })).toThrow();
  });
});

describe("SensorId", () => {
  it("accepts the TYPE-LOCATION-INDEX convention", () => {
    expect(SensorId.parse("CAM-N-03")).toBe("CAM-N-03");
    expect(SensorId.parse("LDR-RWY09L-01")).toBe("LDR-RWY09L-01");
    expect(SensorId.parse("WX-T1-002")).toBe("WX-T1-002");
  });

  it("rejects malformed ids", () => {
    expect(() => SensorId.parse("cam-n-03")).toThrow();
    expect(() => SensorId.parse("CAM_N_03")).toThrow();
    expect(() => SensorId.parse("CAM-N")).toThrow();
  });
});

describe("Sensor", () => {
  const valid = {
    id: "CAM-N-03",
    airport_id: UUID,
    type: "camera",
    location: { lat: 37.6213, lng: -122.379 },
    status: "online",
    created_at: TS,
  };

  it("accepts a fully formed sensor", () => {
    expect(Sensor.parse(valid)).toMatchObject({ id: "CAM-N-03" });
  });

  it("rejects when type is unknown", () => {
    expect(() => Sensor.parse({ ...valid, type: "microphone" })).toThrow();
  });
});

describe("User", () => {
  const valid = {
    id: UUID,
    email: "operator@example.com",
    name: "Pat Operator",
    role: "operator",
    organization: "SFO Ops",
    created_at: TS,
  };

  it("accepts a fully formed user", () => {
    expect(User.parse(valid).role).toBe("operator");
  });

  it("rejects bad email", () => {
    expect(() => User.parse({ ...valid, email: "not-an-email" })).toThrow();
  });
});
