import { expect, test } from "@playwright/test";
import { seedAuth } from "../fixtures/auth-fixture";
import { aiDetection, installWsFixture, presenceSnapshot } from "../fixtures/ws-fixture";

const AIRPORT_ID = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const SENSOR_ID = "CAM-RWY10L-01";

/**
 * Scenario 06 — weather-degraded visibility.
 *
 * Asserts the T-306 calibration + weather modifier surfaces a
 * "LOW CONF" visual indicator on the operator dashboard when the
 * AI emits a low-confidence detection (as it would under the SOP's
 * < 800m visibility branch).
 *
 * What we exercise:
 *   1. Clear-weather detection at high confidence → no indicator.
 *   2. Weather-degraded detection at low confidence → "LOW CONF"
 *      badge visible alongside the alert row.
 *   3. The event STILL appears in the feed (we surface, not
 *      suppress) — the indicator just flags it for review.
 *
 * The wire-level transform (raw confidence × weather modifier) is
 * unit-tested in `test_calibration.py` and `ws-decoder-detection`;
 * this test proves the chain is wired through to the operator's
 * eyes.
 */
test.describe("scenario 06 — weather-degraded visibility", () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
  });

  test("clear-weather detection has no low-confidence indicator", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    await fixture.send(presenceSnapshot({ airportId: AIRPORT_ID, count: 1 }));
    await fixture.send(
      aiDetection({
        airportId: AIRPORT_ID,
        sensorId: SENSOR_ID,
        eventId: "evt-clear-1",
        detectionId: "det-clear-1",
        frameId: `${SENSOR_ID}-CLEAR`,
        detectionClass: "fod",
        confidence: 0.85,
        severityHint: "critical",
        bbox: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 },
      }),
    );

    const feed = page.getByRole("log");
    const row = feed.getByText("FOD detected · 85%");
    await expect(row).toBeVisible();
    // No low-conf badge anywhere in the feed.
    await expect(page.getByLabel("Low confidence detection")).toHaveCount(0);
  });

  test("weather-degraded detection surfaces the LOW CONF indicator", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    await fixture.send(presenceSnapshot({ airportId: AIRPORT_ID, count: 1 }));
    // 0.35 ≈ 0.5 calibrated × 0.7 weather factor in the < 1200m band.
    await fixture.send(
      aiDetection({
        airportId: AIRPORT_ID,
        sensorId: SENSOR_ID,
        eventId: "evt-fog-1",
        detectionId: "det-fog-1",
        frameId: `${SENSOR_ID}-FOG`,
        detectionClass: "fod",
        confidence: 0.35,
        severityHint: "critical",
        bbox: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 },
      }),
    );

    const feed = page.getByRole("log");
    // AC: visual indicator (confidence band) visible to the operator.
    await expect(feed.getByLabel("Low confidence detection")).toBeVisible();
    await expect(feed.getByText("LOW CONF")).toBeVisible();
    // The event is still in the feed (we surface, not suppress).
    await expect(feed.getByText(/FOD detected · 35%/)).toBeVisible();
  });

  test("LOW CONF indicator scopes per-alert, not feed-wide", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    await fixture.send(presenceSnapshot({ airportId: AIRPORT_ID, count: 1 }));
    // One clear + one degraded — only the degraded row gets the badge.
    await fixture.send(
      aiDetection({
        airportId: AIRPORT_ID,
        sensorId: SENSOR_ID,
        eventId: "evt-clear-2",
        detectionId: "det-clear-2",
        frameId: `${SENSOR_ID}-CLEAR-2`,
        detectionClass: "fod",
        confidence: 0.9,
        severityHint: "critical",
      }),
    );
    await fixture.send(
      aiDetection({
        airportId: AIRPORT_ID,
        sensorId: SENSOR_ID,
        eventId: "evt-fog-2",
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
    // Exactly one row has the badge.
    await expect(feed.getByLabel("Low confidence detection")).toHaveCount(1);
  });
});
