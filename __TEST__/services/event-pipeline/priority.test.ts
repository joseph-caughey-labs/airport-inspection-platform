import { describe, expect, it } from "vitest";
import {
  computeFramePriority,
  priorityTier,
} from "../../../services/event-pipeline/src/prioritization/index.js";

function frameFromSensor(sensorId: string, sensorType = "camera") {
  return {
    event_id: "11111111-2222-3333-4444-555555555555",
    event_type: "sensor.frame.captured" as const,
    schema_version: "v1" as const,
    source: { service: "sensor-gateway" },
    timestamp: "2026-05-28T10:00:00.000Z",
    payload: {
      sensor_id: sensorId,
      sensor_type: sensorType as "camera" | "lidar" | "gps" | "imu" | "weather" | "perimeter",
      frame_id: `${sensorId}-00000001`,
      captured_at: "2026-05-28T10:00:00.000Z",
      geo: { lat: 37.6213, lng: -122.379 },
      metadata: {},
    },
  };
}

describe("computeFramePriority", () => {
  it("rates runway cameras highest", () => {
    const p = computeFramePriority(frameFromSensor("CAM-RWY10L-01", "camera"));
    expect(p).toBe(100); // 100 base * 1.0 camera weight
  });

  it("rates taxiway cameras at the taxiway tier", () => {
    const p = computeFramePriority(frameFromSensor("CAM-TWY-A1-01", "camera"));
    expect(p).toBe(60);
  });

  it("rates apron cameras lowest of the placed sensors", () => {
    const p = computeFramePriority(frameFromSensor("CAM-APR-N-01", "camera"));
    expect(p).toBe(30);
  });

  it("uses default 50 when no zone token is recognized", () => {
    // Weather tower not on a runway/taxiway/apron — falls through.
    const p = computeFramePriority(frameFromSensor("WX-TOWER-01", "weather"));
    expect(p).toBe(25); // 50 base * 0.5 weather weight
  });

  it("weights sensor types: camera/lidar = 1.0, weather = 0.5, gps/imu = 0.3", () => {
    expect(computeFramePriority(frameFromSensor("LDR-RWY10L-01", "lidar"))).toBe(100);
    expect(computeFramePriority(frameFromSensor("WX-RWY10L-01", "weather"))).toBe(50);
    expect(computeFramePriority(frameFromSensor("GPS-RWY10L-01", "gps"))).toBe(30);
    expect(computeFramePriority(frameFromSensor("IMU-RWY10L-01", "imu"))).toBe(30);
    expect(computeFramePriority(frameFromSensor("PRM-RWY10L-01", "perimeter"))).toBe(80);
  });
});

describe("priorityTier", () => {
  it("classifies priorities into four bounded labels", () => {
    expect(priorityTier(100)).toBe("critical");
    expect(priorityTier(90)).toBe("critical");
    expect(priorityTier(89)).toBe("high");
    expect(priorityTier(60)).toBe("high");
    expect(priorityTier(59)).toBe("medium");
    expect(priorityTier(30)).toBe("medium");
    expect(priorityTier(29)).toBe("low");
    expect(priorityTier(0)).toBe("low");
  });
});
