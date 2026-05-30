import { expect, test } from "@playwright/test";
import { aiDetection, installWsFixture, presenceSnapshot } from "../fixtures/ws-fixture";

const AIRPORT_ID = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const SENSOR_ID = "CAM-RWY10L-01";
const INCIDENT_ID = "44444444-4444-4444-4444-444444444444";
const OPERATOR_A = "55555555-5555-5555-5555-555555555555";
const RESPONDER = "77777777-7777-7777-7777-777777777777";

/**
 * Scenario 07 — FOD on active runway, full operator workflow (T-416).
 *
 * The capstone E2E for Phase 4. Walks the same path an on-shift
 * operator follows when an AI detection of foreign object debris
 * fires on an active runway:
 *
 *   1. Sensor publishes a high-confidence critical FOD on RWY 10L.
 *   2. The operator dashboard surfaces it in the live alert feed
 *      with the right severity + percentage + sensor identifier.
 *      The LOW CONF indicator is NOT present (high-confidence path).
 *   3. The operator deep-links to /incidents/<id> from the feed
 *      (mocked here — the click-through wires in a follow-up).
 *   4. The timeline page loads the audit lineage from
 *      audit-service (mocked via page.route) and renders the
 *      played-back lifecycle: created → acknowledged → assigned →
 *      in_progress → resolved. The slider + prev/next surface each
 *      step.
 *
 * Coverage choice — why mock audit + not stand up the service:
 *   - The frontend's contract with audit-service is the
 *     ValidationLineage shape; the wire is locked by the typed
 *     AuditEventRow. Standing up the real service would only
 *     re-test what the chain-writer unit tests already cover.
 *   - The dockerized full-stack run (T-507) exercises the real
 *     incident → audit → operator UI chain end-to-end.
 *
 * Together that gives us both the wire contract here AND the
 * production wiring in T-507 — without doubling the demo's CI
 * minutes.
 */
test.describe("scenario 07 — FOD on active runway", () => {
  test("a critical FOD detection appears in the operator alert feed", async ({ page }) => {
    const fixture = await installWsFixture(page);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    await fixture.send(presenceSnapshot({ airportId: AIRPORT_ID, count: 1 }));
    await fixture.send(
      aiDetection({
        airportId: AIRPORT_ID,
        sensorId: SENSOR_ID,
        eventId: "evt-fod-rwy-1",
        detectionId: "det-fod-rwy-1",
        frameId: `${SENSOR_ID}-FOD-1`,
        detectionClass: "fod",
        confidence: 0.92,
        severityHint: "critical",
        bbox: { x: 0.42, y: 0.55, w: 0.08, h: 0.05 },
      }),
    );

    const feed = page.getByRole("log");
    // The row text confirms detection class + (calibrated) confidence.
    await expect(feed.getByText(/FOD detected · 92%/)).toBeVisible();
    // The sensor identifier carries the runway location, which is the
    // operator's primary "where" cue at a glance.
    await expect(feed.getByText(SENSOR_ID).first()).toBeVisible();
    // High-confidence — no LOW CONF chrome on the row.
    await expect(feed.getByLabel("Low confidence detection")).toHaveCount(0);
    // Severity counter strip shows at least one critical-tagged event.
    await expect(page.getByLabel("Live alert feed")).toContainText(/critical/i);
  });

  test("incident detail page replays the full lifecycle from audit lineage", async ({ page }) => {
    // The page calls AuditApi.lineage(:id) on mount. We intercept the
    // request and return a hand-rolled lineage that walks an incident
    // through `new → acknowledged → assigned → in_progress → resolved`.
    await page.route(`**/audit/lineage/${INCIDENT_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          subject_id: INCIDENT_ID,
          total: 4,
          items: [
            auditRow({
              event_id: "audit-1",
              seq: "1",
              from: "new",
              to: "acknowledged",
              command: "acknowledge",
              actor: OPERATOR_A,
              rationale: "tower confirmed visual",
              occurredAt: "2026-05-29T10:00:00.000Z",
            }),
            auditRow({
              event_id: "audit-2",
              seq: "2",
              from: "acknowledged",
              to: "assigned",
              command: "assign",
              actor: OPERATOR_A,
              rationale: "routed to runway crew",
              occurredAt: "2026-05-29T10:01:00.000Z",
            }),
            auditRow({
              event_id: "audit-3",
              seq: "3",
              from: "assigned",
              to: "in_progress",
              command: "start_progress",
              actor: RESPONDER,
              rationale: null,
              occurredAt: "2026-05-29T10:03:00.000Z",
            }),
            auditRow({
              event_id: "audit-4",
              seq: "4",
              from: "in_progress",
              to: "resolved",
              command: "resolve",
              actor: RESPONDER,
              rationale: "FOD removed; runway swept",
              occurredAt: "2026-05-29T10:08:00.000Z",
            }),
          ],
        }),
      });
    });

    await page.goto(`/incidents/${INCIDENT_ID}`);

    const timeline = page.getByTestId("incident-timeline");
    await expect(timeline).toBeVisible();
    // Five steps total: implicit `created` (status=new) + 4 transitions.
    const steps = timeline.getByTestId(/^incident-timeline-step-\d+$/);
    await expect(steps).toHaveCount(5);

    // Cursor lands on the latest step (resolved) per the composable's
    // contract — operators reloading mid-incident see "now", not the
    // start.
    const snapshot = page.getByTestId("incident-timeline-snapshot");
    await expect(snapshot).toContainText("resolved");

    // Walk back through the playback. Prev moves the cursor backwards
    // and the snapshot follows.
    await page.getByTestId("incident-timeline-prev").click();
    await expect(snapshot).toContainText("in_progress");
    await page.getByTestId("incident-timeline-prev").click();
    await expect(snapshot).toContainText("assigned");

    // Jump-to-latest button returns to resolved.
    await page.getByTestId("incident-timeline-last").click();
    await expect(snapshot).toContainText("resolved");

    // Per-step inline labels show the command + rationale we sent.
    // exact:true keeps `acknowledge` from matching `acknowledged` in
    // the transition arrow text.
    await expect(timeline.getByText("acknowledge", { exact: true })).toBeVisible();
    await expect(timeline.getByText(/tower confirmed visual/)).toBeVisible();
    await expect(timeline.getByText(/FOD removed; runway swept/)).toBeVisible();
  });
});

interface AuditRowOpts {
  event_id: string;
  seq: string;
  from: string;
  to: string;
  command: string;
  actor: string | null;
  rationale: string | null;
  occurredAt: string;
}

function auditRow(opts: AuditRowOpts) {
  return {
    seq: opts.seq,
    event_id: opts.event_id,
    occurred_at: opts.occurredAt,
    source: "incident-service",
    event_type: "incident.transitioned",
    actor_user_id: opts.actor,
    subject_id: INCIDENT_ID,
    payload: {
      transition: {
        from: opts.from,
        to: opts.to,
        command: opts.command,
        actor: opts.actor,
        reason: opts.rationale,
        occurred_at: opts.occurredAt,
      },
    },
    prev_hash: null,
    entry_hash: `hash-${opts.event_id}`,
    correlation_id: null,
    rationale: opts.rationale,
  };
}
