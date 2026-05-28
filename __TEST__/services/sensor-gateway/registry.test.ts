import { describe, expect, it, vi } from "vitest";
import {
  SimulatorRegistry,
  type Simulator,
} from "../../../services/sensor-gateway/src/simulators/index.js";

function makeFakeSimulator(sensorId: string): Simulator & {
  startCalls: number;
  stopCalls: number;
} {
  let startCalls = 0;
  let stopCalls = 0;
  return {
    sensorId,
    sensorType: "camera",
    start: () => {
      startCalls++;
    },
    stop: async () => {
      stopCalls++;
    },
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

describe("SimulatorRegistry", () => {
  it("registers and starts every simulator on start()", () => {
    const reg = new SimulatorRegistry();
    const a = makeFakeSimulator("CAM-A-01");
    const b = makeFakeSimulator("CAM-B-01");
    reg.register(a);
    reg.register(b);
    reg.start();
    expect(a.startCalls).toBe(1);
    expect(b.startCalls).toBe(1);
  });

  it("stops every simulator on stop() in parallel", async () => {
    const reg = new SimulatorRegistry();
    const a = makeFakeSimulator("CAM-A-01");
    const b = makeFakeSimulator("CAM-B-01");
    reg.register(a);
    reg.register(b);
    await reg.stop();
    expect(a.stopCalls).toBe(1);
    expect(b.stopCalls).toBe(1);
  });

  it("rejects duplicate sensor_id registrations", () => {
    const reg = new SimulatorRegistry();
    reg.register(makeFakeSimulator("CAM-A-01"));
    expect(() => reg.register(makeFakeSimulator("CAM-A-01"))).toThrow(/already registered/i);
  });

  it("size() reflects the number of registered simulators", () => {
    const reg = new SimulatorRegistry();
    expect(reg.size()).toBe(0);
    reg.register(makeFakeSimulator("CAM-A-01"));
    reg.register(makeFakeSimulator("CAM-B-01"));
    expect(reg.size()).toBe(2);
  });

  it("has() and ids() expose the registered set", () => {
    const reg = new SimulatorRegistry();
    reg.register(makeFakeSimulator("CAM-A-01"));
    expect(reg.has("CAM-A-01")).toBe(true);
    expect(reg.has("CAM-Z-99")).toBe(false);
    expect(reg.ids()).toEqual(["CAM-A-01"]);
  });

  it("propagates simulator stop errors via Promise.all", async () => {
    const reg = new SimulatorRegistry();
    const broken: Simulator = {
      sensorId: "CAM-BROKEN-01",
      sensorType: "camera",
      start: vi.fn(),
      stop: vi.fn(async () => {
        throw new Error("graceful drain failed");
      }),
    };
    reg.register(broken);
    await expect(reg.stop()).rejects.toThrow(/graceful drain failed/);
  });
});
