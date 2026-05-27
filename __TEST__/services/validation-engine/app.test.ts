import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../services/validation-engine/src/app.js";

const logger = createLogger({ service: "validation-engine-test", level: "fatal" });

describe("validation-engine — HTTP surface", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({
      logger,
      registry: createRegistry({
        service: "validation-engine-test",
        collectDefault: false,
      }),
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /metrics returns prometheus exposition", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("POST /validate returns a run with 10 stub-passed layers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/validate",
      payload: { payload: { hello: "world" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      certified: boolean;
      layers: { layer: string; passed: boolean }[];
    };
    expect(body.certified).toBe(true);
    expect(body.layers).toHaveLength(10);
    expect(body.layers.every((l) => l.passed)).toBe(true);
  });

  it("POST /validate rejects body with invalid submission_id (not a UUID)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/validate",
      payload: { submission_id: "not-a-uuid", payload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_failed");
  });

  it("POST /validate accepts caller-supplied submission_id", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const res = await app.inject({
      method: "POST",
      url: "/validate",
      payload: { submission_id: id, payload: {} },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { submission_id: string }).submission_id).toBe(id);
  });
});
