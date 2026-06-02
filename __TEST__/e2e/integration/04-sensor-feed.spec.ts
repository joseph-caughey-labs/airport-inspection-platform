/**
 * Integration port of scenario 04 (sensor live feed).
 *
 * Sibling to `__TEST__/e2e/scenarios/04-sensor-outage.spec.ts` —
 * same dashboard contract, but the WS connection isn't mocked. We
 * publish sensor envelopes to the live compose Redis on
 * `events.broadcast.<airport_id>`; the real ws-broadcaster's
 * `RedisBridge` picks them up and fans them to the connected
 * browser via the actual WS pipeline through nginx.
 *
 * What this tier proves that the mocked tier doesn't:
 *   1. The Redis channel name + envelope shape match between the
 *      publish-side (event-pipeline + tests) and the bridge.
 *   2. The bridge correctly translates `event_type` →
 *      message `type` for the WS client.
 *   3. nginx + ws-broadcaster + the browser WS client all agree on
 *      the bearer-subprotocol auth handshake under real conditions.
 *
 * Presence is NOT triggered by us — ws-broadcaster auto-emits a
 * `presence.snapshot` to every new client populated from its
 * registry. With this spec being the only connected WS client, the
 * count is 1.
 */
import { expect, test } from "@playwright/test";
import {
  connectRedisPublisher,
  sensorFrameEnvelope,
  type RedisPublisher,
} from "./_helpers/redis-publisher";

const AIRPORT_ID = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const SENSOR_ID = "CAM-RWY10L-01";
const OPERATOR_EMAIL = "pat.operator@airport-ops.test";

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: string };
}

let publisher: RedisPublisher;

test.beforeAll(async () => {
  publisher = await connectRedisPublisher();
});

test.afterAll(async () => {
  publisher.disconnect();
});

test.describe("scenario 04 (integration) — real-stack live feed", () => {
  test("presence snapshot + three sensor frames render via the real WS pipeline", async ({
    page,
    request,
  }) => {
    // 1. Log in for real, prime localStorage so the auth middleware
    //    lets the navigation through. Same trick the smoke spec
    //    uses (`00-real-stack-smoke.spec.ts`).
    const login = await request.post("/api/v1/auth/login", {
      data: { email: OPERATOR_EMAIL },
    });
    expect(login.status()).toBe(200);
    const { access_token, refresh_token, user } = (await login.json()) as LoginResponse;
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

    // 2. Visit the airport board and wait for the live feed to be
    //    mounted (the empty-state row proves the WS connection
    //    landed without errors).
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByLabel("Live alert feed")).toBeVisible();
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    // 3. ws-broadcaster auto-emitted a presence snapshot on connect
    //    populated from its registry. With us being the only
    //    subscriber, count is 1.
    await expect(page.getByLabel("Active subscribers")).toContainText("1 online");

    // 4. Publish three sensor frames via the real Redis. The bridge
    //    routes by `events.broadcast.<airport_id>` and the connected
    //    browser's WS client renders each frame as an alert row.
    for (const i of [1, 2, 3]) {
      await publisher.publishToAirport(
        AIRPORT_ID,
        sensorFrameEnvelope({
          sensorId: SENSOR_ID,
          frameId: `${SENSOR_ID}-${String(i).padStart(8, "0")}`,
        }),
      );
    }

    const feed = page.getByRole("log");
    await expect(feed.getByText("Sensor telemetry")).toHaveCount(3);
    await expect(feed.getByText(SENSOR_ID).first()).toBeVisible();
  });
});
