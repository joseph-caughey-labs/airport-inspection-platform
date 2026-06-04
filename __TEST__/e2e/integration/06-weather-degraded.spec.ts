/**
 * Integration port of scenario 06 (LOW CONF indicator).
 *
 * Sibling to `__TEST__/e2e/scenarios/06-weather-degraded.spec.ts` —
 * same dashboard contract, but the AI detection envelopes are
 * published to the live compose Redis on
 * `events.broadcast.<airport_id>`. The real ws-broadcaster's
 * `RedisBridge` picks them up and fans them to the connected
 * browser via the actual WS pipeline through nginx.
 *
 * What this tier proves that the mocked tier doesn't:
 *   - The `ai.detection.<class>.emitted` topic name reaches the
 *     bridge intact (no event-pipeline rewrite that changes the
 *     final wire shape between publish and bridge).
 *   - The frontend's confidence-threshold decoder fires LOW CONF
 *     on the same value the calibration path emits in production.
 *   - The badge is per-row, not feed-wide, when both a clear and a
 *     degraded detection are interleaved.
 *
 * Mirrors the mocked tier's 3 tests:
 *   1. High-confidence detection → no LOW CONF badge.
 *   2. Low-confidence detection → LOW CONF visible + row still in feed.
 *   3. Mixed feed → badge scopes per alert.
 */
import { expect, test } from "@playwright/test";
import {
  aiDetectionEnvelope,
  connectRedisPublisher,
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

async function loginAndVisitBoard(
  request: import("@playwright/test").APIRequestContext,
  page: import("@playwright/test").Page,
) {
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
  await page.goto(`/airports/${AIRPORT_ID}`);
  await expect(page.getByLabel("Live alert feed")).toBeVisible();
  await expect(page.getByText(/No alerts yet/i)).toBeVisible();
}

test.describe("scenario 06 (integration) — real-stack LOW CONF indicator", () => {
  test("high-confidence detection has no LOW CONF badge", async ({ page, request }) => {
    await loginAndVisitBoard(request, page);

    await publisher.publishToAirport(
      AIRPORT_ID,
      aiDetectionEnvelope({
        sensorId: SENSOR_ID,
        detectionId: "det-clear-1",
        frameId: `${SENSOR_ID}-CLEAR`,
        detectionClass: "fod",
        confidence: 0.85,
        severityHint: "critical",
        bbox: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 },
      }),
    );

    const feed = page.getByRole("log");
    await expect(feed.getByText("FOD detected · 85%")).toBeVisible();
    await expect(page.getByLabel("Low confidence detection")).toHaveCount(0);
  });

  test("low-confidence detection surfaces the LOW CONF indicator", async ({ page, request }) => {
    await loginAndVisitBoard(request, page);

    // 0.35 ≈ 0.5 calibrated × 0.7 weather factor in the < 1200m
    // visibility band — same envelope the calibration path would
    // emit under weather degradation.
    await publisher.publishToAirport(
      AIRPORT_ID,
      aiDetectionEnvelope({
        sensorId: SENSOR_ID,
        detectionId: "det-fog-1",
        frameId: `${SENSOR_ID}-FOG`,
        detectionClass: "fod",
        confidence: 0.35,
        severityHint: "critical",
        bbox: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 },
      }),
    );

    const feed = page.getByRole("log");
    await expect(feed.getByLabel("Low confidence detection")).toBeVisible();
    await expect(feed.getByText("LOW CONF")).toBeVisible();
    await expect(feed.getByText(/FOD detected · 35%/)).toBeVisible();
  });

  test("LOW CONF badge scopes per alert, not feed-wide", async ({ page, request }) => {
    await loginAndVisitBoard(request, page);

    await publisher.publishToAirport(
      AIRPORT_ID,
      aiDetectionEnvelope({
        sensorId: SENSOR_ID,
        detectionId: "det-clear-2",
        frameId: `${SENSOR_ID}-CLEAR-2`,
        detectionClass: "fod",
        confidence: 0.9,
        severityHint: "critical",
      }),
    );
    await publisher.publishToAirport(
      AIRPORT_ID,
      aiDetectionEnvelope({
        sensorId: SENSOR_ID,
        detectionId: "det-fog-2",
        frameId: `${SENSOR_ID}-FOG-2`,
        detectionClass: "fod",
        confidence: 0.3,
        severityHint: "critical",
      }),
    );

    const feed = page.getByRole("log");
    await expect(feed.getByText(/FOD detected · 90%/)).toBeVisible();
    await expect(feed.getByText(/FOD detected · 30%/)).toBeVisible();
    await expect(feed.getByLabel("Low confidence detection")).toHaveCount(1);
  });
});
