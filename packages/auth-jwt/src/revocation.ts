/**
 * Refresh-token revocation list (Phase 6 follow-up to T-506).
 *
 * A signed JWT is valid until its `exp` — there's no way to
 * cryptographically invalidate one once issued. To support user-
 * initiated logout we keep an out-of-band list of "tokens we
 * promised would still verify, but should no longer be honoured".
 * The caller (e.g. api-gateway `/api/v1/auth/refresh`) consults
 * this list AFTER verifying the cryptographic shape, BEFORE
 * issuing a new access token.
 *
 * Demo posture (production-different):
 *
 *   - `InMemoryRefreshTokenRevocationList` keeps a `Set<string>`
 *     of revoked tokens. Per-process, lost on restart, not
 *     shared across replicas. Fine for the single-instance demo.
 *   - Production wants a Redis-backed implementation with TTL
 *     equal to each token's `exp - now` so the set self-prunes.
 *     The `RefreshTokenRevocationList` interface stays the same
 *     either way — `revoke` + `isRevoked` is the contract.
 *
 * What the key is: the raw token STRING. Not its `jti` claim
 * (the JWTs minted here don't set one) and not the user_id
 * (we want logout to invalidate THIS session, not every session
 * the user has). String hashing isn't required — JWT secret
 * leakage already breaks everything, so storing the string in
 * memory is no worse than storing the cookie.
 */

export interface RefreshTokenRevocationList {
  /** Add a refresh-token string to the revocation set. Idempotent. */
  revoke(token: string): Promise<void>;
  /** Check whether a refresh-token has been revoked. */
  isRevoked(token: string): Promise<boolean>;
}

/**
 * In-memory implementation. Production wires a Redis-backed one
 * with TTL = each token's `exp - now`.
 */
export class InMemoryRefreshTokenRevocationList implements RefreshTokenRevocationList {
  private readonly revoked = new Set<string>();

  async revoke(token: string): Promise<void> {
    this.revoked.add(token);
  }

  async isRevoked(token: string): Promise<boolean> {
    return this.revoked.has(token);
  }

  /** Number of currently-revoked tokens — exposed for tests + metrics. */
  get size(): number {
    return this.revoked.size;
  }
}
