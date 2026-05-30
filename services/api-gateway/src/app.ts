import {
  createJwtSigner,
  requireAuth,
  requireRole,
  verifyJwtHook,
  type JwtSigner,
} from "@aip/auth-jwt";
import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import Fastify from "fastify";
import { createInMemoryDirectory } from "./auth/directory.js";
import { errorHandler, notFoundHandler } from "./errors/handler.js";
import { registerAuthRoutes, type UserDirectory } from "./routes/auth.js";
import { pingRoute } from "./routes/ping.js";

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
}

const TEST_SECRET = "test-only-secret-do-not-use-in-prod-32-bytes-minimum-thanks";

export async function buildApp({ logger, registry, signer, directory }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

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

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // ── Metrics (T-502) ──────────────────────────────────────────────
  installMetrics({ app, registry });

  // ── Liveness and readiness ───────────────────────────────────────
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  // ── Auth (T-504) ─────────────────────────────────────────────────
  registerAuthRoutes(app, { signer: jwtSigner, directory: userDirectory });

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
