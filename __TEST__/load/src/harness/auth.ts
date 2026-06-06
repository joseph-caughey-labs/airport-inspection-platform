/**
 * Mints access tokens the stack will accept, using the SAME signer
 * config (`@aip/auth-jwt`) the services verify against. The secret +
 * issuer come from `env` and must match the running stack's
 * `JWT_SECRET` / issuer, or every WS upgrade closes with 4401.
 */
import { createJwtSigner } from "@aip/auth-jwt";
import { env } from "./env.js";

const signer = createJwtSigner({ secret: env.jwt.secret, issuer: env.jwt.issuer });

const OPERATOR_ID = "33333333-1111-1111-1111-000000000001";

export function operatorToken(): Promise<string> {
  return signer.signAccess({ user_id: OPERATOR_ID, role: "operator" });
}
