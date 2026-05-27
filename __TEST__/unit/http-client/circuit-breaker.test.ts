import { describe, expect, it } from "vitest";
import { CircuitBreaker, HttpClientError } from "../../../packages/http-client/src/index.js";

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("CircuitBreaker — closed (happy path)", () => {
  it("starts closed and passes through successes", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({ name: "x", now: clock.now });
    expect(cb.getState()).toBe("closed");
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
    expect(cb.getState()).toBe("closed");
  });

  it("resets consecutive failures on success", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 3,
      now: clock.now,
    });
    await cb.execute(async () => 1).catch(() => undefined);
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    await cb.execute(async () => 2);
    // After one success the count is reset. Two more failures should NOT open.
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    expect(cb.getState()).toBe("closed");
  });
});

describe("CircuitBreaker — open transition", () => {
  it("opens after threshold consecutive failures", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 3,
      now: clock.now,
    });
    for (let i = 0; i < 3; i++) {
      await cb
        .execute(async () => {
          throw new Error("nope");
        })
        .catch(() => undefined);
    }
    expect(cb.getState()).toBe("open");
  });

  it("rejects with `circuit_open` while open", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      now: clock.now,
    });
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    expect(cb.getState()).toBe("open");
    await expect(cb.execute(async () => 1)).rejects.toMatchObject({
      code: "circuit_open",
    });
  });
});

describe("CircuitBreaker — half-open transition", () => {
  it("transitions to half-open after resetTimeoutMs", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      now: clock.now,
    });
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    expect(cb.getState()).toBe("open");
    clock.advance(1_001);
    expect(cb.getState()).toBe("half_open");
  });

  it("closes on half-open success", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      now: clock.now,
    });
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    clock.advance(1_001);
    const ok = await cb.execute(async () => "ok");
    expect(ok).toBe("ok");
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens on half-open failure", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      now: clock.now,
    });
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    clock.advance(1_001);
    await cb
      .execute(async () => {
        throw new Error("still nope");
      })
      .catch(() => undefined);
    expect(cb.getState()).toBe("open");
  });
});

describe("CircuitBreaker — error shape", () => {
  it("throws an HttpClientError instance with code circuit_open", async () => {
    const clock = makeClock();
    const cb = new CircuitBreaker({
      name: "incident-service",
      failureThreshold: 1,
      now: clock.now,
    });
    await cb
      .execute(async () => {
        throw new Error("nope");
      })
      .catch(() => undefined);
    try {
      await cb.execute(async () => 1);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpClientError);
      expect((err as HttpClientError).code).toBe("circuit_open");
      expect((err as HttpClientError).message).toContain("incident-service");
    }
  });
});
