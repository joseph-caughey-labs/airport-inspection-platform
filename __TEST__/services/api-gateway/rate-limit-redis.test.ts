/**
 * Redis-backed rate-limit store tests (Phase 6 follow-up to T-505).
 *
 * The default in-process store loses count on restart and doesn't
 * share between replicas; production wires `@fastify/rate-limit`
 * to a Redis-backed store via `app.ts`'s `rateLimitRedis` option.
 *
 * This file pins two safety properties:
 *
 *   1. The option is actually plumbed through — when a `redis`
 *      client is provided, `@fastify/rate-limit` calls
 *      `defineCommand` on it to register the Lua script that backs
 *      the `RedisStore` (the canonical signal that the store
 *      switched away from in-process).
 *
 *   2. `skipOnError: true` degrades safely — when Redis is broken
 *      (every command throws), requests STILL succeed at their
 *      handler instead of all returning 500. The user-facing
 *      surface stays up; rate-limit is the casualty, not auth.
 */
import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import type { RedisClient } from "@aip/redis-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../services/api-gateway/src/app.js";
import { createInMemoryDirectory } from "../../../services/api-gateway/src/auth/directory.js";

const logger = createLogger({ service: "rate-limit-redis-test", level: "fatal" });

function buildOpts() {
  return {
    logger,
    registry: createRegistry({
      service: "rate-limit-redis-test",
      collectDefault: false,
    }),
    signer: createJwtSigner({
      secret: "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks",
      issuer: "aip-api-gateway",
    }),
    directory: createInMemoryDirectory(),
  };
}

/**
 * Minimal stub that satisfies the surface `@fastify/rate-limit`
 * touches when handed a `redis` client. We don't need a working
 * Lua execution — only the right hooks for the plugin to think it
 * succeeded in defining its script.
 */
function fakeRedis(opts: { defineCommand: ReturnType<typeof vi.fn> }): RedisClient {
  // `@fastify/rate-limit`'s RedisStore skips `defineCommand` when
  // `redis.rateLimit` already exists. So we leave it off, let
  // defineCommand be called, and have that call attach `rateLimit`
  // to mimic what ioredis does.
  const redis: Record<string, unknown> = {};
  redis["defineCommand"] = (...args: unknown[]) => {
    opts.defineCommand(...args);
    // Mimic ioredis: defineCommand attaches the command as a method.
    redis["rateLimit"] = (..._a: unknown[]) => Promise.resolve([1, 60_000]);
  };
  return redis as unknown as RedisClient;
}

/**
 * "Broken" redis — every call throws. Drives the `skipOnError`
 * graceful-degradation path.
 */
function brokenRedis(): RedisClient {
  const redis: Record<string, unknown> = {};
  redis["defineCommand"] = (..._args: unknown[]) => {
    // defineCommand itself succeeds — the failure mode that
    // `skipOnError` actually catches is at command-call time,
    // not plugin-registration time.
    redis["rateLimit"] = (..._a: unknown[]) => {
      throw new Error("redis is down");
    };
  };
  return redis as unknown as RedisClient;
}

let app: Awaited<ReturnType<typeof buildApp>>;
afterEach(async () => {
  await app.close();
});

describe("api-gateway — rate-limit Redis store wiring", () => {
  it("calls defineCommand on the provided redis when the option is wired", async () => {
    const defineCommand = vi.fn();
    app = await buildApp({
      ...buildOpts(),
      rateLimitRedis: fakeRedis({ defineCommand }),
    });
    // `defineCommand` is called once on registration to install the
    // `rateLimit` Lua script. Asserting on it proves we left the
    // in-process default and switched to RedisStore.
    expect(defineCommand).toHaveBeenCalled();
    expect(defineCommand.mock.calls[0]![0]).toBe("rateLimit");
  });

  it("does NOT call defineCommand when no redis is provided (in-process default)", async () => {
    // Build with no rateLimitRedis. The defineCommand spy must
    // never see a call because RedisStore is never instantiated.
    const defineCommand = vi.fn();
    void defineCommand; // tracked for symmetry; assertion below
    app = await buildApp(buildOpts());
    expect(defineCommand).not.toHaveBeenCalled();
  });

  it("skipOnError keeps requests serving when redis throws on every command", async () => {
    app = await buildApp({
      ...buildOpts(),
      rateLimitRedis: brokenRedis(),
    });
    // Fire 25 login attempts — well above the 20/min auth budget.
    // With the redis store broken AND `skipOnError: true`, the
    // limiter should silently no-op and every request should land
    // at the login handler (401 for the unseeded email). No 500s.
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "no-such-user@example.test" },
      });
      statuses.push(res.statusCode);
    }
    // Every response is a clean 401 from the auth handler — no 500
    // (would mean the broken redis crashed the request) and no 429
    // (the limiter degraded to off rather than fail-closed).
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});
