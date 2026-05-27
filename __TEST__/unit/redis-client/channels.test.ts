import { describe, expect, it } from "vitest";
import { buildChannelName, isValidChannelName } from "../../../packages/redis-client/src/index.js";

describe("buildChannelName", () => {
  it("composes domain.entity.action", () => {
    expect(buildChannelName("sensor", "frame", "captured")).toBe("sensor.frame.captured");
    expect(buildChannelName("ai", "detection", "emitted")).toBe("ai.detection.emitted");
    expect(buildChannelName("incident", "lifecycle", "updated")).toBe("incident.lifecycle.updated");
  });

  it("accepts snake_case + digits in entity and action", () => {
    expect(buildChannelName("audit", "review_decision", "approved_1")).toBe(
      "audit.review_decision.approved_1",
    );
  });

  it("rejects uppercase, dashes, and dots in segments", () => {
    expect(() => buildChannelName("sensor", "Frame", "captured")).toThrow();
    expect(() => buildChannelName("sensor", "frame-x", "captured")).toThrow();
    expect(() => buildChannelName("sensor", "frame.captured", "x")).toThrow();
  });

  it("rejects empty segments", () => {
    expect(() => buildChannelName("sensor", "", "captured")).toThrow();
    expect(() => buildChannelName("sensor", "frame", "")).toThrow();
  });
});

describe("isValidChannelName", () => {
  it("accepts properly formed channels", () => {
    expect(isValidChannelName("sensor.frame.captured")).toBe(true);
    expect(isValidChannelName("ai.detection.emitted")).toBe(true);
  });

  it("rejects wrong segment counts", () => {
    expect(isValidChannelName("sensor.frame")).toBe(false);
    expect(isValidChannelName("sensor.frame.captured.extra")).toBe(false);
    expect(isValidChannelName("flat")).toBe(false);
  });

  it("rejects malformed segments", () => {
    expect(isValidChannelName("Sensor.frame.captured")).toBe(false);
    expect(isValidChannelName("sensor.frame!.captured")).toBe(false);
    expect(isValidChannelName("sensor..captured")).toBe(false);
  });
});
