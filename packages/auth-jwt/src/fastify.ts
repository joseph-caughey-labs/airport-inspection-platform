/**
 * Fastify integration for `@aip/auth-jwt`.
 *
 * - `verifyJwtHook({ signer })` — onRequest hook that reads the
 *   Authorization header, verifies an access token via the signer,
 *   and stamps `req.auth` with `{ user_id, role }`. A missing or
 *   bad header leaves `req.auth` undefined (no rejection); route-
 *   level `requireAuth` / `requireRole` is the gate that 401s /
 *   403s.
 * - `requireAuth()` — onRequest hook that 401s if `req.auth` is
 *   undefined.
 * - `requireRole(...allowed)` — onRequest hook that 401s on missing
 *   auth, 403s when the role isn't in the allowed set.
 *
 * The split is intentional: `verifyJwtHook` runs once at the app
 * level, attaches whatever's available; `requireRole` runs per
 * route and decides whether to reject. That mirrors the
 * authentication / authorization separation and keeps the auth
 * surface obvious in each route file.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@aip/shared-contracts";
import type { JwtSigner, VerifiedAccessToken } from "./jwt.js";
import { AuthJwtError } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { user_id: string; role: Role };
  }
}

export interface VerifyJwtHookOptions {
  signer: JwtSigner;
}

/**
 * Build an onRequest hook that verifies the Authorization header.
 * Does NOT reject on missing/invalid auth — that's the per-route
 * helper's job.
 */
export function verifyJwtHook(
  opts: VerifyJwtHookOptions,
): (req: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  return async (req) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return;
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) return;
    try {
      const verified: VerifiedAccessToken = await opts.signer.verifyAccess(token);
      req.auth = { user_id: verified.user_id, role: verified.role };
    } catch {
      // Don't throw here — the per-route helper decides whether to
      // reject. This keeps verifyJwtHook from blocking public
      // endpoints like /auth/login or /health that don't carry a
      // token.
    }
  };
}

/** Reject with 401 when no `req.auth` is present. */
export function requireAuth(): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send(authErrorEnvelope("unauthorized", "authentication required"));
    }
  };
}

/**
 * Reject with 401 when `req.auth` is missing, or 403 when the role
 * isn't in `allowed`. Usage on a Fastify route:
 *
 *   app.get("/admin", { preHandler: requireRole("admin") }, handler);
 */
export function requireRole(
  ...allowed: Role[]
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const set = new Set<Role>(allowed);
  return async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send(authErrorEnvelope("unauthorized", "authentication required"));
    }
    if (!set.has(req.auth.role)) {
      return reply.code(403).send(
        authErrorEnvelope("forbidden", "role not permitted", {
          required: [...set],
          actual: req.auth.role,
        }),
      );
    }
  };
}

function authErrorEnvelope(
  code: "unauthorized" | "forbidden",
  message: string,
  details?: Record<string, unknown>,
) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

export { AuthJwtError };
