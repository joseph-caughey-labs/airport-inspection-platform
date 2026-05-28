import { Role } from "@aip/shared-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface DecodedAuth {
  userId: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: DecodedAuth;
  }
}

/**
 * Auth decode **stub** for Phase 1. Parses an optional Bearer token in
 * the placeholder format `<user_id>.<role>` and attaches it to
 * `req.auth`. This intentionally does NOT verify signatures or
 * expirations — real JWT verification lands in T-504.
 *
 * Routes that need authn/authz today should treat a missing or
 * malformed token as unauthenticated (`req.auth === undefined`).
 */
export async function authDecode(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return;
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) return;

  const parts = token.split(".");
  if (parts.length !== 2) return;
  const [userId, rolePart] = parts;
  if (!userId || !rolePart) return;

  const parsed = Role.safeParse(rolePart);
  if (!parsed.success) return;

  req.auth = { userId, role: parsed.data };
}
