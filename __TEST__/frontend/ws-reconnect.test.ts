import { describe, expect, it } from "vitest";
import { nextReconnectDelay } from "~/utils/ws-reconnect";

describe("nextReconnectDelay", () => {
  it("grows exponentially per attempt at the median jitter (rand=0.5)", () => {
    const median = () => 0.5; // factor = 1.0, output equals deterministic exp
    const opts = { baseMs: 250, maxMs: 60_000, randomFn: median };
    expect(nextReconnectDelay(0, opts)).toBe(250);
    expect(nextReconnectDelay(1, opts)).toBe(500);
    expect(nextReconnectDelay(2, opts)).toBe(1000);
    expect(nextReconnectDelay(3, opts)).toBe(2000);
  });

  it("caps at maxMs", () => {
    const median = () => 0.5;
    expect(nextReconnectDelay(20, { baseMs: 250, maxMs: 5_000, randomFn: median })).toBe(5000);
  });

  it("applies +25% jitter at rand=1 and -25% at rand=0", () => {
    const high = nextReconnectDelay(0, { baseMs: 1000, maxMs: 60_000, randomFn: () => 0.9999 });
    const low = nextReconnectDelay(0, { baseMs: 1000, maxMs: 60_000, randomFn: () => 0 });
    expect(high).toBeGreaterThanOrEqual(1240);
    expect(high).toBeLessThanOrEqual(1250);
    expect(low).toBe(750);
  });

  it("clamps negative attempts to 0", () => {
    const median = () => 0.5;
    expect(nextReconnectDelay(-5, { baseMs: 250, randomFn: median })).toBe(250);
  });
});
