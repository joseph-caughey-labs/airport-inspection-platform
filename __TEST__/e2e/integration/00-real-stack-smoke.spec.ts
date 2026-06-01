/**
 * T-507 — dockerized full-stack smoke.
 *
 * Proves the wires connect against the REAL services running in
 * `docker-compose`. The CI workflow brings the stack up + seeds
 * users + airports before invoking this; the spec assumes those
 * have happened.
 *
 * What's covered (intentionally small):
 *   1. `POST /api/v1/auth/login` against api-gateway through nginx
 *      returns a token pair for a seeded operator.
 *   2. Pre-seeded auth in localStorage + a navigation to `/` lands
 *      on the dashboard (the global middleware doesn't bounce us
 *      to /login).
 *   3. `GET /api/v1/whoami` (the canary RBAC route) round-trips the
 *      access token and echoes the user_id + role from the JWT.
 *
 * What's NOT covered here (lives in the mocked tier):
 *   - Sensor frame fan-out, AI detection rendering, alert feed
 *     deduplication — those need the publisher chain primed with
 *     fixture frames. The mocked tier already proves the UI
 *     behaviour against canonical envelopes; this tier proves the
 *     network paths connect.
 */
import { expect, test } from "@playwright/test";

const OPERATOR_EMAIL = "pat.operator@airport-ops.test";

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: string };
}

test.describe("dockerized stack — real-service smoke", () => {
  test("operator can log in through nginx → api-gateway and get a JWT pair", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/auth/login", {
      data: { email: OPERATOR_EMAIL },
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as LoginResponse;
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(body.refresh_token.split(".")).toHaveLength(3);
    expect(body.user.email).toBe(OPERATOR_EMAIL);
    expect(body.user.role).toBe("operator");
  });

  test("whoami round-trips the access token + echoes claims from the JWT", async ({ request }) => {
    const login = await request.post("/api/v1/auth/login", {
      data: { email: OPERATOR_EMAIL },
    });
    const { access_token, user } = (await login.json()) as LoginResponse;

    const who = await request.get("/api/v1/whoami", {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(who.status()).toBe(200);
    const body = (await who.json()) as { user_id: string; role: string };
    expect(body.user_id).toBe(user.id);
    expect(body.role).toBe("operator");
  });

  test("authenticated browser session lands on the dashboard, not /login", async ({
    page,
    request,
  }) => {
    // Log in via the real api-gateway, then prime localStorage the
    // way the auth-restore plugin expects so the global middleware
    // lets the navigation through.
    const res = await request.post("/api/v1/auth/login", {
      data: { email: OPERATOR_EMAIL },
    });
    const { access_token, refresh_token, user } = (await res.json()) as LoginResponse;
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, value);
      },
      {
        key: "aip.auth.v1",
        value: JSON.stringify({
          accessToken: access_token,
          refreshToken: refresh_token,
          user,
        }),
      },
    );
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Live Ops|San Francisco/i).first()).toBeVisible();
  });
});
