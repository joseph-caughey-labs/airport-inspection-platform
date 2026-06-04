/**
 * Auth store tests (T-504d). Cover the login → refresh → logout
 * lifecycle plus the tokenProvider closure semantics the API
 * clients rely on. localStorage is provided by happy-dom in this
 * test runner.
 */
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "~/stores/auth";

const STORAGE_KEY = "aip.auth.v1";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SEEDED_USER = {
  id: "33333333-1111-1111-1111-000000000001",
  email: "pat.operator@airport-ops.test",
  name: "Pat Operator",
  role: "operator" as const,
};

const LOGIN_OK = {
  access_token: "access-token-1",
  refresh_token: "refresh-token-1",
  user: SEEDED_USER,
};

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

describe("useAuthStore.login", () => {
  it("POSTs `{ email }` to /api/v1/auth/login and stamps state on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, LOGIN_OK));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "pat.operator@airport-ops.test" });

    expect(auth.isAuthenticated).toBe(true);
    expect(auth.accessToken).toBe("access-token-1");
    expect(auth.refreshToken).toBe("refresh-token-1");
    expect(auth.user).toEqual(SEEDED_USER);
    expect(auth.role).toBe("operator");
  });

  it("persists tokens + user to localStorage on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, LOGIN_OK));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { accessToken: string; refreshToken: string };
    expect(parsed.accessToken).toBe("access-token-1");
    expect(parsed.refreshToken).toBe("refresh-token-1");
  });

  it("stamps error + throws on 401", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: { code: "unauthorized", message: "invalid credentials" } }),
      );
    const auth = useAuthStore();
    await expect(auth.login("nobody@example.test", { fetchFn })).rejects.toThrow(
      /invalid credentials/,
    );
    expect(auth.error).toBe("invalid credentials");
    expect(auth.isAuthenticated).toBe(false);
  });

  it("clears `loading` even when the request rejects", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const auth = useAuthStore();
    await expect(auth.login("pat@example.test", { fetchFn })).rejects.toThrow(/network down/);
    expect(auth.loading).toBe(false);
  });
});

describe("useAuthStore.refresh", () => {
  it("swaps the access token and updates localStorage", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "access-token-2" }));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });

    const fresh = await auth.refresh({ fetchFn });
    expect(fresh).toBe("access-token-2");
    expect(auth.accessToken).toBe("access-token-2");
    expect(auth.refreshToken).toBe("refresh-token-1"); // unchanged

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as {
      accessToken: string;
    };
    expect(stored.accessToken).toBe("access-token-2");
  });

  it("returns null without a network call when there's no refresh token", async () => {
    const fetchFn = vi.fn();
    const auth = useAuthStore();
    const result = await auth.refresh({ fetchFn });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("logs the user out when the refresh endpoint rejects", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "refresh expired" } }));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });

    const result = await auth.refresh({ fetchFn });
    expect(result).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("useAuthStore.logout", () => {
  it("clears all auth state + localStorage", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, LOGIN_OK));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    auth.logout();
    expect(auth.accessToken).toBeNull();
    expect(auth.refreshToken).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("useAuthStore.logoutAndNotifyServer", () => {
  it("POSTs the refresh token to /api/v1/auth/logout then clears state", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, LOGIN_OK))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });

    await auth.logoutAndNotifyServer({ fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[1]!;
    expect(url).toBe("/api/v1/auth/logout");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "refresh-token-1" });

    expect(auth.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("still clears local state when the server request fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, LOGIN_OK))
      .mockRejectedValueOnce(new Error("network down"));
    const auth = useAuthStore();
    await auth.login("pat.operator@airport-ops.test", { fetchFn });

    // Must NOT throw — network failure isn't a reason to keep the
    // user signed in locally.
    await expect(auth.logoutAndNotifyServer({ fetchFn })).resolves.toBeUndefined();
    expect(auth.isAuthenticated).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("skips the network call when there's no refresh token (already signed out)", async () => {
    const fetchFn = vi.fn();
    const auth = useAuthStore();
    await auth.logoutAndNotifyServer({ fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("useAuthStore.restoreFromStorage", () => {
  it("rehydrates state from a previously-persisted login", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        accessToken: "stored-access",
        refreshToken: "stored-refresh",
        user: SEEDED_USER,
      }),
    );
    const auth = useAuthStore();
    auth.restoreFromStorage();
    expect(auth.accessToken).toBe("stored-access");
    expect(auth.refreshToken).toBe("stored-refresh");
    expect(auth.user).toEqual(SEEDED_USER);
    expect(auth.isAuthenticated).toBe(true);
  });

  it("is a no-op when localStorage holds garbage", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    const auth = useAuthStore();
    auth.restoreFromStorage();
    expect(auth.isAuthenticated).toBe(false);
  });
});

describe("useAuthStore.tokenProvider", () => {
  it("reads the current access token each call (sees post-refresh values)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "access-token-2" }));
    const auth = useAuthStore();
    const provider = auth.tokenProvider();
    expect(provider()).toBeNull();

    await auth.login("pat.operator@airport-ops.test", { fetchFn });
    expect(provider()).toBe("access-token-1");

    await auth.refresh({ fetchFn });
    expect(provider()).toBe("access-token-2");

    auth.logout();
    expect(provider()).toBeNull();
  });
});
