/**
 * Integration port of scenario 07 (FOD on active runway).
 *
 * Sibling to `__TEST__/e2e/scenarios/07-fod-runway-workflow.spec.ts`
 * — same workflow but every wire is real:
 *
 *   1. AI detection envelope publishes to compose Redis on
 *      `events.broadcast.<airport_id>`; ws-broadcaster's bridge
 *      fans it to the connected browser. Alert feed renders.
 *
 *   2. The operator drives the incident through its full lifecycle
 *      with REAL REST calls to incident-service. Each transition
 *      publishes on `incident.transition.*`; audit-service
 *      subscribes and hash-chains the row. We poll
 *      `/audit/lineage/:id` until the chain catches up, then
 *      navigate to `/incidents/:id` and verify the timeline page
 *      renders the live audit data — no `page.route` intercept.
 *
 * Coverage the mocked tier can't give us:
 *   - JSON shape contract between incident-service's transition
 *     publish and audit-service's subscriber parse.
 *   - audit-service hash chain INSERT semantics under sequential
 *     transitions.
 *   - nginx routes `/audit/*` + `/incidents/*` actually reach
 *     audit-service + incident-service (new in this PR).
 *
 * This is the capstone — the full Phase 4 workflow against the
 * Phase 5 hardened stack.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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

async function login(request: APIRequestContext): Promise<{ token: string; userId: string }> {
  const res = await request.post("/api/v1/auth/login", {
    data: { email: OPERATOR_EMAIL },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as LoginResponse;
  return { token: body.access_token, userId: body.user.id };
}

async function primeAuth(page: Page, request: APIRequestContext): Promise<{ userId: string }> {
  const r = await request.post("/api/v1/auth/login", {
    data: { email: OPERATOR_EMAIL },
  });
  const body = (await r.json()) as LoginResponse;
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    {
      key: "aip.auth.v1",
      value: JSON.stringify({
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        user: body.user,
      }),
    },
  );
  return { userId: body.user.id };
}

test.describe("scenario 07 (integration) — FOD on active runway, real stack", () => {
  test("a critical FOD detection appears in the operator alert feed", async ({ page, request }) => {
    await primeAuth(page, request);
    await page.goto(`/airports/${AIRPORT_ID}`);
    await expect(page.getByLabel("Live alert feed")).toBeVisible();
    await expect(page.getByText(/No alerts yet/i)).toBeVisible();

    await publisher.publishToAirport(
      AIRPORT_ID,
      aiDetectionEnvelope({
        sensorId: SENSOR_ID,
        detectionId: "det-fod-rwy-1",
        frameId: `${SENSOR_ID}-FOD-1`,
        detectionClass: "fod",
        confidence: 0.92,
        severityHint: "critical",
        bbox: { x: 0.42, y: 0.55, w: 0.08, h: 0.05 },
      }),
    );

    const feed = page.getByRole("log");
    await expect(feed.getByText(/FOD detected · 92%/)).toBeVisible();
    await expect(feed.getByText(SENSOR_ID).first()).toBeVisible();
    await expect(feed.getByLabel("Low confidence detection")).toHaveCount(0);
    await expect(page.getByLabel("Live alert feed")).toContainText(/critical/i);
  });

  test("incident timeline replays the lifecycle from the real audit chain", async ({
    page,
    request,
  }) => {
    // Login through nginx → api-gateway → JWT signer for a real access
    // token. The same token authorizes every subsequent REST write.
    const { token, userId } = await login(request);
    const headers = { authorization: `Bearer ${token}` };

    // 1. Create an incident via api-gateway → incident-service.
    const create = await request.post("/api/v1/incidents", {
      headers,
      data: {
        airport_id: AIRPORT_ID,
        severity: "critical",
        title: "FOD on RWY 10L (e2e integration)",
      },
    });
    expect(create.status()).toBe(201);
    const created = (await create.json()) as { id: string; status: string };
    const incidentId = created.id;
    expect(created.status).toBe("new");

    // 2. Walk the lifecycle. Each transition publishes on Redis;
    //    audit-service's subscriber hash-chains it.
    for (const step of [
      { url: `/api/v1/incidents/${incidentId}/acknowledge`, body: { operator_id: userId } },
      {
        url: `/api/v1/incidents/${incidentId}/assign`,
        body: { operator_id: userId, assignee_id: userId },
      },
      { url: `/api/v1/incidents/${incidentId}/start_progress`, body: { operator_id: userId } },
      {
        url: `/api/v1/incidents/${incidentId}/resolve`,
        body: { operator_id: userId, resolution_summary: "FOD removed; runway swept" },
      },
    ]) {
      const res = await request.post(step.url, { headers, data: step.body });
      expect(res.status(), `transition ${step.url} should 200`).toBe(200);
    }

    // 3. Poll audit-service for the chain to catch up. The publish
    //    → subscribe → INSERT path is asynchronous; under CI load
    //    this can take a few hundred ms per row.
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/v1/audit/lineage/${incidentId}`, { headers });
          if (r.status() !== 200) return -1;
          const body = (await r.json()) as { total: number };
          return body.total;
        },
        {
          message: "audit chain never reached 4 rows",
          timeout: 20_000,
          intervals: [200, 500, 1000],
        },
      )
      .toBe(4);

    // 4. Render the live timeline page. AuditApi.lineage hits the
    //    same /audit/lineage/:id endpoint through nginx → audit-
    //    service, no `page.route` intercept.
    await primeAuth(page, request);
    await page.goto(`/incidents/${incidentId}`);
    const timeline = page.getByTestId("incident-timeline");
    await expect(timeline).toBeVisible();

    // 5 steps total: implicit `created` (status=new) + 4 transitions.
    const steps = timeline.getByTestId(/^incident-timeline-step-\d+$/);
    await expect(steps).toHaveCount(5);

    // Cursor lands on the latest step.
    const snapshot = page.getByTestId("incident-timeline-snapshot");
    await expect(snapshot).toContainText("resolved");

    // Walk backwards through the playback.
    await page.getByTestId("incident-timeline-prev").click();
    await expect(snapshot).toContainText("in_progress");
    await page.getByTestId("incident-timeline-prev").click();
    await expect(snapshot).toContainText("assigned");

    // Jump-to-latest returns to resolved.
    await page.getByTestId("incident-timeline-last").click();
    await expect(snapshot).toContainText("resolved");

    // Per-step inline labels confirm the rationale we passed on resolve.
    await expect(timeline.getByText(/FOD removed; runway swept/)).toBeVisible();
  });
});
