/**
 * JWT issue + verify primitives. `jose` under the hood — modern,
 * native ESM, well-typed, audited.
 *
 * Two token kinds:
 *   - `access`  — short-lived (default 15min), carries `user_id` +
 *                 `role`. Every protected route checks this.
 *   - `refresh` — longer-lived (default 7 days), carries `user_id`
 *                 only. The `/auth/refresh` route swaps this for a
 *                 fresh access token.
 *
 * Why the split:
 *   - The access token's short TTL bounds the blast radius of a
 *     leaked credential.
 *   - The refresh token can be revoked server-side without
 *     invalidating every access token in flight.
 *   - The role is carried on the access token so RBAC checks don't
 *     need a DB lookup per request.
 *
 * Signing algorithm is HS256 by default — symmetric, fastest to
 * verify in-process. Production deployments with multiple
 * authenticating services should move to asymmetric (RS256 / EdDSA)
 * + JWKS endpoint so the signing key doesn't have to be shared.
 */
import { errors as joseErrors, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { Role, type Role as RoleType } from "@aip/shared-contracts";

export type TokenKind = "access" | "refresh";

export interface AccessTokenClaims {
  user_id: string;
  role: RoleType;
}

export interface RefreshTokenClaims {
  user_id: string;
}

export interface VerifiedAccessToken {
  kind: "access";
  user_id: string;
  role: RoleType;
  expires_at: number;
  issued_at: number;
}

export interface VerifiedRefreshToken {
  kind: "refresh";
  user_id: string;
  expires_at: number;
  issued_at: number;
}

export type VerifiedToken = VerifiedAccessToken | VerifiedRefreshToken;

export interface SignerOptions {
  /** Symmetric signing secret. 32+ bytes; throws otherwise. */
  secret: string;
  /** JWT `iss` claim. Default `aip`. */
  issuer?: string;
  /** Access token TTL in seconds. Default 900 (15min). */
  accessTtlSeconds?: number;
  /** Refresh token TTL in seconds. Default 604_800 (7 days). */
  refreshTtlSeconds?: number;
  /** Override clock for tests. Returns ms since epoch. */
  now?: () => number;
}

const DEFAULT_ISSUER = "aip";
const DEFAULT_ACCESS_TTL = 15 * 60;
const DEFAULT_REFRESH_TTL = 7 * 24 * 60 * 60;
const ALG = "HS256";
const MIN_SECRET_BYTES = 32;

export class AuthJwtError extends Error {
  readonly code: "invalid_token" | "expired_token" | "wrong_kind" | "invalid_secret";
  constructor(code: AuthJwtError["code"], message: string) {
    super(message);
    this.name = "AuthJwtError";
    this.code = code;
  }
}

export interface JwtSigner {
  signAccess(claims: AccessTokenClaims): Promise<string>;
  signRefresh(claims: RefreshTokenClaims): Promise<string>;
  verifyAccess(token: string): Promise<VerifiedAccessToken>;
  verifyRefresh(token: string): Promise<VerifiedRefreshToken>;
}

export function createJwtSigner(opts: SignerOptions): JwtSigner {
  const secretBytes = new TextEncoder().encode(opts.secret);
  if (secretBytes.length < MIN_SECRET_BYTES) {
    throw new AuthJwtError(
      "invalid_secret",
      `JWT secret must be at least ${MIN_SECRET_BYTES} bytes (got ${secretBytes.length})`,
    );
  }
  const issuer = opts.issuer ?? DEFAULT_ISSUER;
  const accessTtl = opts.accessTtlSeconds ?? DEFAULT_ACCESS_TTL;
  const refreshTtl = opts.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL;
  const now = opts.now ?? Date.now;

  async function sign(payload: JWTPayload, ttlSeconds: number): Promise<string> {
    const issuedAt = Math.floor(now() / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: ALG })
      .setIssuer(issuer)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .sign(secretBytes);
  }

  async function verify(token: string): Promise<JWTPayload & { kind?: unknown }> {
    try {
      // currentDate threads our injected clock through jose's expiry
      // check. Without it, `now: () => ...` would only affect signing
      // and tests of expiry would have to manipulate the real system
      // clock.
      const { payload } = await jwtVerify(token, secretBytes, {
        issuer,
        currentDate: new Date(now()),
      });
      return payload as JWTPayload & { kind?: unknown };
    } catch (err) {
      // Use the class instance for classification — message strings
      // are not stable across jose versions and the word "exp"
      // appears in errors that are NOT expiry (e.g. "expected `iss`").
      if (err instanceof joseErrors.JWTExpired) {
        throw new AuthJwtError("expired_token", "token expired");
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new AuthJwtError("invalid_token", `invalid token: ${msg}`);
    }
  }

  return {
    async signAccess(claims) {
      return sign({ kind: "access", user_id: claims.user_id, role: claims.role }, accessTtl);
    },
    async signRefresh(claims) {
      return sign({ kind: "refresh", user_id: claims.user_id }, refreshTtl);
    },
    async verifyAccess(token) {
      const payload = await verify(token);
      if (payload.kind !== "access") {
        throw new AuthJwtError("wrong_kind", `expected access token, got ${String(payload.kind)}`);
      }
      const role = Role.safeParse(payload.role);
      if (!role.success || typeof payload.user_id !== "string") {
        throw new AuthJwtError("invalid_token", "access token missing user_id or role");
      }
      return {
        kind: "access",
        user_id: payload.user_id,
        role: role.data,
        expires_at: payload.exp ?? 0,
        issued_at: payload.iat ?? 0,
      };
    },
    async verifyRefresh(token) {
      const payload = await verify(token);
      if (payload.kind !== "refresh") {
        throw new AuthJwtError("wrong_kind", `expected refresh token, got ${String(payload.kind)}`);
      }
      if (typeof payload.user_id !== "string") {
        throw new AuthJwtError("invalid_token", "refresh token missing user_id");
      }
      return {
        kind: "refresh",
        user_id: payload.user_id,
        expires_at: payload.exp ?? 0,
        issued_at: payload.iat ?? 0,
      };
    },
  };
}
