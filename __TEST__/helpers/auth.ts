/**
 * Shared auth fixtures for service HTTP-surface tests (T-504c).
 *
 * Every service now requires a `signer` on `buildApp` and gates each
 * route with `requireRole(...rolesFor("perm"))`. Tests construct one
 * `signer` per file via `makeTestSigner()` and mint short-lived
 * tokens with `operatorToken()` / `reviewerToken()` / `adminToken()`.
 *
 * `bearer()` returns a `{ authorization: "Bearer ..." }` header
 * object that drops into Fastify's `app.inject({ headers, ... })`.
 *
 * The secret + issuer are arbitrary — production wires both through
 * env vars (JWT_SECRET shared with api-gateway, issuer fixed).
 */
import { createJwtSigner, type JwtSigner } from "../../packages/auth-jwt/src/index.js";

const TEST_SECRET = "test-secret-must-be-at-least-32-bytes-long-please";
const TEST_ISSUER = "aip-api-gateway";

export function makeTestSigner(): JwtSigner {
  return createJwtSigner({ secret: TEST_SECRET, issuer: TEST_ISSUER });
}

const OPERATOR_ID = "00000000-0000-0000-0000-0000000000aa";
const REVIEWER_ID = "00000000-0000-0000-0000-0000000000bb";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000cc";

export async function operatorToken(signer: JwtSigner): Promise<string> {
  return signer.signAccess({ user_id: OPERATOR_ID, role: "operator" });
}

export async function reviewerToken(signer: JwtSigner): Promise<string> {
  return signer.signAccess({ user_id: REVIEWER_ID, role: "reviewer" });
}

export async function adminToken(signer: JwtSigner): Promise<string> {
  return signer.signAccess({ user_id: ADMIN_ID, role: "admin" });
}

/** Header object that merges with whatever Fastify inject already wants. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
