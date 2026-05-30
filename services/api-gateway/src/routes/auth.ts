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
import { Role } from "@aip/shared-contracts";
import type { JwtSigner } from "@aip/auth-jwt";
import { AuthJwtError } from "@aip/auth-jwt";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  role: import("@aip/shared-contracts").Role;
}

export interface UserDirectory {
  findByEmail(email: string): Promise<DirectoryUser | null>;
  findById(id: string): Promise<DirectoryUser | null>;
}

export interface RegisterAuthRoutesOptions {
  signer: JwtSigner;
  directory: UserDirectory;
}

const LoginBody = z.object({
  email: z.string().email(),
});

const RefreshBody = z.object({
  refresh_token: z.string().min(1),
});

export function registerAuthRoutes(app: FastifyInstance, opts: RegisterAuthRoutesOptions): void {
  app.post("/api/v1/auth/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope("validation_failed", "invalid login body"));
    }
    const user = await opts.directory.findByEmail(parsed.data.email.toLowerCase());
    if (!user) {
      // Don't disclose whether the email exists — return 401 either
      // way. The actual demo seeds three users; any other email
      // results in this branch.
      return reply.code(401).send(errorEnvelope("unauthorized", "invalid credentials"));
    }
    const access_token = await opts.signer.signAccess({
      user_id: user.id,
      role: user.role,
    });
    const refresh_token = await opts.signer.signRefresh({ user_id: user.id });
    return reply.send({
      access_token,
      refresh_token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  app.post("/api/v1/auth/refresh", async (req, reply) => {
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
        return reply.code(401).send(errorEnvelope("unauthorized", "user no longer exists"));
      }
      const access_token = await opts.signer.signAccess({
        user_id: user.id,
        role: user.role,
      });
      return reply.send({ access_token });
    } catch (err) {
      if (err instanceof AuthJwtError) {
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
