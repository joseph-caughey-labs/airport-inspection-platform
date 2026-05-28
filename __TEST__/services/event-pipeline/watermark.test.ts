import { describe, expect, it } from "vitest";
import { WatermarkTracker } from "../../../services/event-pipeline/src/prioritization/index.js";

describe("WatermarkTracker", () => {
  it("classifies the first frame from a sensor as in_order", () => {
    const wm = new WatermarkTracker();
    expect(wm.check("CAM-RWY10L-01", 1000)).toBe("in_order");
  });

  it("advances the watermark on every in_order frame", () => {
    const wm = new WatermarkTracker();
    wm.check("CAM-RWY10L-01", 1000);
    wm.check("CAM-RWY10L-01", 2000);
    wm.check("CAM-RWY10L-01", 3000);
    expect(wm.watermarkFor("CAM-RWY10L-01")).toBe(3000);
  });

  it("classifies a frame older than the watermark by < tolerance as late_in_window", () => {
    const wm = new WatermarkTracker({ toleranceMs: 5000 });
    wm.check("CAM-RWY10L-01", 10_000);
    expect(wm.check("CAM-RWY10L-01", 7000)).toBe("late_in_window");
  });

  it("classifies a frame older than the watermark by > tolerance as late_beyond_window", () => {
    const wm = new WatermarkTracker({ toleranceMs: 5000 });
    wm.check("CAM-RWY10L-01", 10_000);
    expect(wm.check("CAM-RWY10L-01", 4000)).toBe("late_beyond_window");
  });

  it("late frames do NOT advance the watermark", () => {
    const wm = new WatermarkTracker({ toleranceMs: 5000 });
    wm.check("CAM-RWY10L-01", 10_000);
    wm.check("CAM-RWY10L-01", 7000); // late
    wm.check("CAM-RWY10L-01", 4000); // very late
    expect(wm.watermarkFor("CAM-RWY10L-01")).toBe(10_000);
  });

  it("tracks watermarks per sensor independently", () => {
    const wm = new WatermarkTracker();
    wm.check("CAM-RWY10L-01", 1000);
    wm.check("CAM-RWY28R-01", 5000);
    expect(wm.watermarkFor("CAM-RWY10L-01")).toBe(1000);
    expect(wm.watermarkFor("CAM-RWY28R-01")).toBe(5000);
  });

  it("a re-arrival at the exact watermark is in_order (tied → advance)", () => {
    const wm = new WatermarkTracker();
    wm.check("CAM-RWY10L-01", 1000);
    expect(wm.check("CAM-RWY10L-01", 1000)).toBe("in_order");
  });

  it("watermarkFor returns null for unknown sensors", () => {
    expect(new WatermarkTracker().watermarkFor("CAM-X-01")).toBeNull();
  });

  it("clear() resets every sensor's watermark", () => {
    const wm = new WatermarkTracker();
    wm.check("CAM-RWY10L-01", 1000);
    wm.clear();
    expect(wm.watermarkFor("CAM-RWY10L-01")).toBeNull();
  });
});
