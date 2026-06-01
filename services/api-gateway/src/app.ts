import {
  createJwtSigner,
  requireAuth,
  requireRole,
  verifyJwtHook,
  type JwtSigner,
} from "@aip/auth-jwt";
import { DEFAULT_BODY_LIMIT_BYTES, installHttpSafety } from "@aip/http-safety";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import {
  buildSecurityEvent,
  RecordingSecurityEventPublisher,
  type SecurityEventPublisher,
} from "@aip/security-events";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { createInMemoryDirectory } from "./auth/directory.js";
import { registerAuthRoutes, type UserDirectory } from "./routes/auth.js";
import { pingRoute } from "./routes/ping.js";

const SOURCE = { service: "api-gateway" };

export interface BuildAppOptions {
  logger: Logger;
  registry: Registry;
  /**
   * JWT signer. Tests can inject one with a fixed clock + short
   * TTLs; production wires one off the JWT_SECRET env var.
   */
  signer?: JwtSigner;
  /**
   * User directory. Tests can inject a synthetic one; production
   * uses the in-memory seeded list (and later a Postgres-backed
   * one — same interface, no app.ts change).
   */
  directory?: UserDirectory;
  /**
   * Disable the global rate limiter (T-505). Useful for unit tests
   * that fire hundreds of injects in a row without setting up the
   * per-IP allowance. Production never sets this.
   */
  rateLimitDisabled?: boolean;
  /**
   * Security event publisher (T-506). Production wires a Redis-
   * backed one in `main.ts`; tests get the in-memory recording
   * publisher by default so they can assert on emissions without
   * a live Redis.
   */
  securityEvents?: SecurityEventPublisher;
}

const TEST_SECRET = "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks";

// T-505 — rate-limit budgets, expressed per minute. Tighter on the
// auth endpoints because they're the public surface most worth
// brute-forcing; looser on read paths. Tune via the operations doc.
const GLOBAL_MAX_PER_MINUTE = 240; // ~4/sec sustained per source
const AUTH_MAX_PER_MINUTE = 20; // login + refresh combined

export async function buildApp({
  logger,
  registry,
  signer,
  directory,
  rateLimitDisabled,
  securityEvents,
}: BuildAppOptions) {
  // Default to the in-memory recorder so tests don't need to opt
  // into emission. Production passes the Redis-backed publisher.
  const events: SecurityEventPublisher = securityEvents ?? new RecordingSecurityEventPublisher();
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });

  // ── Input safety (T-505) ─────────────────────────────────────────
  // Sanitized error + 404 envelopes. Must run before any route is
  // declared because Fastify locks the handlers after first
  // registration.
  installHttpSafety(app);

  // ── Rate limiting (T-505) ────────────────────────────────────────
  // Per-IP token bucket. The auth routes set their own tighter
  // budget via the route-level `config.rateLimit` override.
  if (!rateLimitDisabled) {
    await app.register(rateLimit, {
      max: GLOBAL_MAX_PER_MINUTE,
      timeWindow: "1 minute",
      // Use the source IP. Behind a trusted proxy we'd switch to
      // `req.headers["x-forwarded-for"]` parsing, but the api-gateway
      // sits behind NGINX which sets `X-Real-IP`; Fastify's default
      // `req.ip` honours `trustProxy` and that's where production
      // config lives.
      keyGenerator: (req) => req.ip,
      // T-506: emit a security event on every block so the audit
      // chain captures the brute-force-attempt evidence. Fires on
      // each request that the limiter actually rejects.
      onExceeded: (req) => {
        void events.emit(
          buildSecurityEvent({
            event_type: "rate_limit.blocked",
            source: SOURCE,
            actor_user_id: req.auth?.user_id ?? null,
            subject_id: null,
            ...(req.request_id ? { correlation_id: req.request_id } : {}),
            payload: {
              route: req.routeOptions?.url ?? req.url,
              method: req.method.toLowerCase(),
              ip: req.ip,
              budget_per_minute: req.url.startsWith("/api/v1/auth/")
                ? AUTH_MAX_PER_MINUTE
                : GLOBAL_MAX_PER_MINUTE,
            },
          }),
        );
      },
    });
  }

  // ── Global hooks (order matters) ─────────────────────────────────
  // correlationHook runs first so every downstream handler logs
  // tagged lines.
  app.addHook("onRequest", correlationHook());

  // verifyJwtHook stamps req.auth from the Bearer token when
  // present. Routes that need auth call `requireAuth()` /
  // `requireRole(...)` from `@aip/auth-jwt` as a preHandler.
  // Routes that DON'T need auth (login, refresh, health, metrics)
  // see req.auth as undefined and proceed.
  const jwtSigner =
    signer ??
    createJwtSigner({
      secret: process.env["JWT_SECRET"] ?? TEST_SECRET,
      issuer: "aip-api-gateway",
    });
  const userDirectory = directory ?? createInMemoryDirectory();
  app.addHook("onRequest", verifyJwtHook({ signer: jwtSigner }));

  // ── Security audit hooks (T-506) ─────────────────────────────────
  // Emit `access.denied` whenever a protected route closes with a
  // 401 or 403. The auth helpers (`requireAuth`, `requireRole`)
  // route through `reply.code(...)` rather than throwing, so this
  // catches them via `onResponse` rather than the error handler.
  // The rate-limit 429 path stays handled by the limiter's own
  // `onExceeded` callback above — we don't want to double-count.
  app.addHook("onResponse", async (req, reply) => {
    const status = reply.statusCode;
    if (status !== 401 && status !== 403) return;
    if (req.url.startsWith("/api/v1/auth/")) return; // login/refresh emit their own auth.* events
    void events.emit(
      buildSecurityEvent({
        event_type: "access.denied",
        source: SOURCE,
        actor_user_id: req.auth?.user_id ?? null,
        subject_id: null,
        ...(req.request_id ? { correlation_id: req.request_id } : {}),
        payload: {
          route: req.routeOptions?.url ?? req.url,
          method: req.method.toLowerCase(),
          status,
          ip: req.ip,
          ...(req.auth?.role ? { actual_role: req.auth.role } : {}),
        },
      }),
    );
  });

  // ── Metrics (T-502) ──────────────────────────────────────────────
  installMetrics({ app, registry });

  // ── Liveness and readiness ───────────────────────────────────────
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  // ── Auth (T-504) ─────────────────────────────────────────────────
  registerAuthRoutes(app, {
    signer: jwtSigner,
    directory: userDirectory,
    authMaxPerMinute: AUTH_MAX_PER_MINUTE,
    securityEvents: events,
  });

  // ── API routes ───────────────────────────────────────────────────
  await app.register(pingRoute);

  // Canary RBAC-gated route — proves `requireAuth` and `requireRole`
  // wire correctly end-to-end. The cross-service rollout (per the
  // RBAC matrix in @aip/shared-contracts/auth) is its own ticket.
  app.get("/api/v1/whoami", { preHandler: requireAuth() }, async (req) => ({
    user_id: req.auth!.user_id,
    role: req.auth!.role,
  }));
  app.get("/api/v1/admin/echo", { preHandler: requireRole("admin") }, async (req) => ({
    admin: req.auth!.user_id,
  }));

  return app;
}
