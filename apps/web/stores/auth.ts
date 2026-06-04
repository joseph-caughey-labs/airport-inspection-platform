/**
 * Auth store (T-504d) — owns the access + refresh tokens and the
 * `{ id, email, name, role }` triple the rest of the UI reads from.
 *
 * Demo posture (production-different — see ADR 0011):
 *   - Tokens live in `localStorage`. XSS-readable; for a real
 *     deployment with sensitive data we'd switch to httpOnly +
 *     SameSite cookies + a backend session.
 *   - Login is email-only against the seeded directory; the
 *     api-gateway accepts `{ email }` and returns a token pair.
 *   - Refresh is lazy: the API clients call `refresh()` from a 401
 *     and retry once with the new access token.
 *
 * The store deliberately exposes a `tokenProvider()` function rather
 * than letting callers pluck `accessToken` out of state. Callers that
 * need to inject `Authorization: Bearer ...` on every request close
 * over `tokenProvider` once at construction; the function reads the
 * current token each call, so a refresh between calls is observed
 * without the caller having to subscribe.
 */
import type { Role } from "@aip/shared-contracts";
import { defineStore } from "pinia";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  /** True while a login or refresh request is in flight. */
  loading: boolean;
  /** Last error message from login/refresh. UI surfaces this on the
   * login form; cleared on a successful subsequent attempt. */
  error: string | null;
}

const STORAGE_KEY = "aip.auth.v1";

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

function readStored(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      parsed.user &&
      typeof parsed.user === "object"
    ) {
      return parsed as StoredAuth;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredAuth | null): void {
  if (typeof window === "undefined") return;
  if (value === null) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

export interface RefreshResponse {
  access_token: string;
}

/** Pluggable HTTP layer so unit tests can inject a fake. */
export interface AuthApiDeps {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

async function postLogin(deps: AuthApiDeps, email: string): Promise<LoginResponse> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const base = deps.baseUrl ?? "/api/v1";
  const res = await fetchFn(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = (await safeJson(res)) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `login failed (${res.status})`);
  }
  return (await res.json()) as LoginResponse;
}

async function postRefresh(deps: AuthApiDeps, refreshToken: string): Promise<RefreshResponse> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const base = deps.baseUrl ?? "/api/v1";
  const res = await fetchFn(`${base}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const body = (await safeJson(res)) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `refresh failed (${res.status})`);
  }
  return (await res.json()) as RefreshResponse;
}

/**
 * Fire-and-forget logout call. Server invalidates the refresh
 * token + audits the `auth.logout` event; the result doesn't
 * change the local-clear behaviour either way, so we never throw.
 * A network failure here just means the server never sees the
 * logout; the local session still ends.
 */
async function postLogout(deps: AuthApiDeps, refreshToken: string): Promise<void> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const base = deps.baseUrl ?? "/api/v1";
  try {
    await fetchFn(`${base}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // Swallow — local logout proceeds regardless.
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    accessToken: null,
    refreshToken: null,
    user: null,
    loading: false,
    error: null,
  }),
  getters: {
    isAuthenticated: (s): boolean => s.accessToken !== null && s.user !== null,
    role: (s): Role | null => s.user?.role ?? null,
  },
  actions: {
    /**
     * Re-hydrate from localStorage. Called from the auth plugin on
     * app start. SSR-safe — does nothing on the server because
     * `window` isn't there.
     */
    restoreFromStorage(): void {
      const stored = readStored();
      if (!stored) return;
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.user = stored.user;
    },

    async login(email: string, deps: AuthApiDeps = {}): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const res = await postLogin(deps, email);
        this.accessToken = res.access_token;
        this.refreshToken = res.refresh_token;
        this.user = res.user;
        writeStored({
          accessToken: res.access_token,
          refreshToken: res.refresh_token,
          user: res.user,
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Exchange the stored refresh token for a fresh access token.
     * Returns the new token (or null if no refresh token is set or
     * the call fails). The lazy-401 retry path in the API clients
     * uses the return value to decide whether to retry the request.
     */
    async refresh(deps: AuthApiDeps = {}): Promise<string | null> {
      if (!this.refreshToken) return null;
      try {
        const res = await postRefresh(deps, this.refreshToken);
        this.accessToken = res.access_token;
        if (this.user) {
          writeStored({
            accessToken: res.access_token,
            refreshToken: this.refreshToken,
            user: this.user,
          });
        }
        return res.access_token;
      } catch {
        // Refresh failed — the refresh token is probably expired
        // too. Clear state so the next request triggers a fresh
        // login redirect rather than an infinite 401 loop.
        this.logout();
        return null;
      }
    },

    /**
     * Local logout — clears in-memory + localStorage state.
     * Called by the refresh path on a fatal failure (no point
     * pinging the server about a token it's already rejecting)
     * and by `logoutAndNotifyServer` after the audit-emit fires.
     */
    logout(): void {
      this.accessToken = null;
      this.refreshToken = null;
      this.user = null;
      this.error = null;
      writeStored(null);
    },

    /**
     * User-initiated logout. Posts the refresh token to
     * `/api/v1/auth/logout` first so audit-service hash-chains an
     * `auth.logout` security event and the token enters the
     * server-side revocation list. Then clears local state.
     *
     * Fire-and-forget on the network — a server hiccup must
     * never block the user from signing out locally.
     */
    async logoutAndNotifyServer(deps: AuthApiDeps = {}): Promise<void> {
      const token = this.refreshToken;
      if (token) {
        await postLogout(deps, token);
      }
      this.logout();
    },

    /**
     * Stable closure over the current access token. API clients
     * pass this to their constructors so each request reads the
     * freshest value without subscribing to store changes.
     */
    tokenProvider(): () => string | null {
      return () => this.accessToken;
    },
  },
});
