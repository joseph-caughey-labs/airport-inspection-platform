import { expect, test } from "@playwright/test";
import { installWsFixture, presenceSnapshot, sensorFrame } from "../fixtures/ws-fixture";

const AIRPORT_ID = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const SENSOR_ID = "CAM-RWY10L-01";

/**
 * Scenario 04 — sensor outage → reconnect → replay.
 *
 * Scope split between this file and T-507:
 *
 *   • Here (fixture-driven) — verify the page renders ws-broadcaster
 *     envelopes correctly: presence, sensor frames, dedup on
 *     redelivery. Routes are mocked via Playwright's
 *     `routeWebSocket`, which intercepts the initial connection but
 *     does NOT re-intercept after `route.close()` — so the
 *     reconnect-resume tail of the scenario is exercised via the
 *     WsClient unit tests in `__TEST__/frontend/ws-client.test.ts`
 *     (which prove the URL carries `?last_event_id=` on retry).
 *
 *   • In T-507 (dockerized stack) — the same scenario runs against
 *     the real ws-broadcaster + event-pipeline + outbox, which
 *     covers actual broadcaster restart + replay.
 *
 * Together those layers satisfy the T-214 acceptance criterion that
 * the scenario fails loudly if reconnect / replay regress.
 */
test.describe("scenario 04 — fixture-driven live feed", () => {
  test("presence snapshot + sensor frames render in the alert feed", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    // Send the server's typical first frame.
    await fixture.send(presenceSnapshot({ airportId: AIRPORT_ID, count: 1 }));
    await expect(page.getByLabel("Active subscribers")).toContainText("1 online");

    // Three sensor frames → three rows in the feed.
    for (const i of [1, 2, 3]) {
      await fixture.send(
        sensorFrame({
          airportId: AIRPORT_ID,
          sensorId: SENSOR_ID,
          eventId: `evt-${i}`,
          frameId: `${SENSOR_ID}-${String(i).padStart(8, "0")}`,
        }),
      );
    }
    const feed = page.getByRole("log");
    await expect(feed.getByText("Sensor telemetry")).toHaveCount(3);
    await expect(feed.getByText(SENSOR_ID).first()).toBeVisible();

    // Severity counter strip shows 3 info-level events.
    await expect(page.getByLabel("Live alert feed")).toContainText(/info[\s\S]*3/i);
  });

  test("redelivered frames are deduplicated by id", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    const dup = sensorFrame({
      airportId: AIRPORT_ID,
      sensorId: SENSOR_ID,
      eventId: "evt-dup",
      frameId: `${SENSOR_ID}-DUP`,
    });
    await fixture.send(dup);
    await fixture.send(dup);
    await fixture.send(dup);

    // The store's insertAlert dedup on `id` should fold these
    // three deliveries into one feed row.
    await expect(page.getByRole("log").getByText("Sensor telemetry")).toHaveCount(1);
  });

  test("non-sensor events with unknown type don't break the feed", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    // The ws-decoder routes unknown types into a metric, not the feed.
    await fixture.send({
      type: "ai.detection.fod",
      schema_version: "v1",
      timestamp: "2026-05-28T10:00:00.000Z",
      payload: { detection_id: "x" },
    });
    // Send a real frame after to prove the stream keeps flowing.
    await fixture.send(
      sensorFrame({
        airportId: AIRPORT_ID,
        sensorId: SENSOR_ID,
        eventId: "evt-after-unknown",
        frameId: `${SENSOR_ID}-AFTER`,
      }),
    );
    await expect(page.getByRole("log").getByText("Sensor telemetry")).toHaveCount(1);
  });
});
