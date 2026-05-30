/**
 * Auth routes: login + refresh.
 *
 * Demo posture (read carefully — production-different):
 *
 *   - `POST /api/v1/auth/login` accepts `{ email }` and matches it
 *     against a seeded user lookup. No password verification — the
 *     seed users carry a stable email-to-role mapping and the
 *     interview demo lives off them.
 *   - `POST /api/v1/auth/refresh` accepts `{ refresh_token }`,
 *     verifies via `@aip/auth-jwt`, and issues a fresh access
 *     token. The refresh token itself stays valid until its own
 *     `exp` — refresh-token rotation lands in T-505 alongside
 *     audit hooks (logged via T-506).
 *
 * Both routes are PUBLIC — they don't go through `requireAuth`
 * (you can't auth to get auth). The `verifyJwtHook` runs anyway at
 * the app level and leaves `req.auth` undefined for these.
 *
 * The user-lookup contract is shaped as `UserDirectory` so the
 * production path swaps the seed map for a real Postgres-backed
 * directory without touching this file.
 */
import { Role, type Role as RoleType } from "@aip/shared-contracts";
import type { JwtSigner } from "@aip/auth-jwt";
import { AuthJwtError } from "@aip/auth-jwt";
import {
  buildSecurityEvent,
  type SecurityEventPublisher,
  type SecurityEventType,
} from "@aip/security-events";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const SOURCE = { service: "api-gateway" };

export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  role: RoleType;
}

export interface UserDirectory {
  findByEmail(email: string): Promise<DirectoryUser | null>;
  findById(id: string): Promise<DirectoryUser | null>;
}

export interface RegisterAuthRoutesOptions {
  signer: JwtSigner;
  directory: UserDirectory;
  /**
   * Per-route per-minute rate limit override (T-505). When omitted,
   * the auth routes ride the app-level limiter. Production should
   * always pass a value to keep brute-force budgets tight.
   */
  authMaxPerMinute?: number;
  /**
   * Security event publisher (T-506). Required so the audit chain
   * captures every login + refresh attempt — success and failure.
   * Tests can drop in a recording publisher.
   */
  securityEvents: SecurityEventPublisher;
}

const LoginBody = z.object({
  email: z.string().email(),
});

const RefreshBody = z.object({
  refresh_token: z.string().min(1),
});

export function registerAuthRoutes(app: FastifyInstance, opts: RegisterAuthRoutesOptions): void {
  // T-505: tighter per-route token bucket on the auth surface. The
  // global limiter still applies; this `config.rateLimit` overrides
  // its `max` for these routes only. Shape matches `@fastify/rate-limit`.
  const authRateLimit =
    opts.authMaxPerMinute !== undefined
      ? { rateLimit: { max: opts.authMaxPerMinute, timeWindow: "1 minute" } }
      : {};

  // Tiny helper — every auth event needs the same envelope shape.
  // Don't await: emission failure must never block the user.
  const emitAuthEvent = (
    req: FastifyRequest,
    type: SecurityEventType,
    actorUserId: string | null,
    payload: Record<string, unknown>,
  ): void => {
    void opts.securityEvents.emit(
      buildSecurityEvent({
        event_type: type,
        source: SOURCE,
        actor_user_id: actorUserId,
        subject_id: actorUserId,
        ...(req.request_id ? { correlation_id: req.request_id } : {}),
        payload,
      }),
    );
  };

  app.post("/api/v1/auth/login", { config: authRateLimit }, async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope("validation_failed", "invalid login body"));
    }
    const email = parsed.data.email.toLowerCase();
    const user = await opts.directory.findByEmail(email);
    if (!user) {
      // Don't disclose whether the email exists — return 401 either
      // way. The actual demo seeds three users; any other email
      // results in this branch. Audit the attempt so brute-force
      // shows up in the hash chain (T-506).
      emitAuthEvent(req, "auth.login.failed", null, {
        email,
        ip: req.ip,
        reason: "no_such_user",
      });
      return reply.code(401).send(errorEnvelope("unauthorized", "invalid credentials"));
    }
    const access_token = await opts.signer.signAccess({
      user_id: user.id,
      role: user.role,
    });
    const refresh_token = await opts.signer.signRefresh({ user_id: user.id });
    emitAuthEvent(req, "auth.login.succeeded", user.id, {
      email: user.email,
      role: user.role,
      ip: req.ip,
    });
    return reply.send({
      access_token,
      refresh_token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  app.post("/api/v1/auth/refresh", { config: authRateLimit }, async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope("validation_failed", "invalid refresh body"));
    }
    try {
      const verified = await opts.signer.verifyRefresh(parsed.data.refresh_token);
      const user = await opts.directory.findById(verified.user_id);
      if (!user) {
        // The refresh token referenced a user that no longer
        // exists (deleted, etc.). 401 is the right answer.
        emitAuthEvent(req, "auth.refresh.failed", verified.user_id, {
          ip: req.ip,
          reason: "user_no_longer_exists",
        });
        return reply.code(401).send(errorEnvelope("unauthorized", "user no longer exists"));
      }
      const access_token = await opts.signer.signAccess({
        user_id: user.id,
        role: user.role,
      });
      emitAuthEvent(req, "auth.refresh.succeeded", user.id, { ip: req.ip });
      return reply.send({ access_token });
    } catch (err) {
      if (err instanceof AuthJwtError) {
        emitAuthEvent(req, "auth.refresh.failed", null, {
          ip: req.ip,
          reason: err.code,
        });
        return reply.code(401).send(errorEnvelope("unauthorized", err.message, { code: err.code }));
      }
      throw err;
    }
  });
}

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

// Re-export so app.ts can construct a directory inline without
// having to import from a separate module.
export { Role };
