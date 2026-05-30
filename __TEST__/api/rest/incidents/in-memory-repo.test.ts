import type { ListIncidentsQuery } from "@aip/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  IdempotencyKeyConflictError,
  InMemoryIncidentRepository,
} from "../../../../services/incident-service/src/repository/index.js";

const AIRPORT = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const AIRPORT_2 = "11111111-1111-1111-1111-bbbbbbbbbbbb";

function fixedClock(start: string) {
  let n = 0;
  return () => new Date(new Date(start).getTime() + n++ * 1000);
}

describe("InMemoryIncidentRepository — create", () => {
  it("stamps id, created_at, updated_at, default status=new", async () => {
    const repo = new InMemoryIncidentRepository();
    const incident = await repo.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "FOD on RWY 10L",
      now: fixedClock("2026-05-29T10:00:00.000Z"),
    });
    expect(incident.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(incident.status).toBe("new");
    expect(incident.created_at).toBe("2026-05-29T10:00:00.000Z");
    expect(incident.updated_at).toBe(incident.created_at);
    expect(incident.airport_id).toBe(AIRPORT);
  });

  it("accepts caller-supplied id", async () => {
    const repo = new InMemoryIncidentRepository();
    const incident = await repo.create({
      id: "22222222-2222-2222-2222-222222222222",
      airport_id: AIRPORT,
      severity: "low",
      title: "test",
    });
    expect(incident.id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("returns existing row on duplicate idempotency_key", async () => {
    const repo = new InMemoryIncidentRepository();
    const first = await repo.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "A",
      idempotency_key: "incident:CAM-1:F-1",
    });
    const second = await repo.create({
      airport_id: AIRPORT,
      severity: "low",
      title: "B (ignored)",
      idempotency_key: "incident:CAM-1:F-1",
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("A"); // original wins
  });

  it("never mixes idempotency keys across rows", async () => {
    const repo = new InMemoryIncidentRepository();
    const a = await repo.create({
      airport_id: AIRPORT,
      severity: "high",
      title: "A",
      idempotency_key: "k-a",
    });
    const b = await repo.create({
      airport_id: AIRPORT,
      severity: "low",
      title: "B",
      idempotency_key: "k-b",
    });
    expect(a.id).not.toBe(b.id);
  });

  it("omits optional fields when not provided (exactOptionalPropertyTypes safe)", async () => {
    const repo = new InMemoryIncidentRepository();
    const incident = await repo.create({
      airport_id: AIRPORT,
      severity: "info",
      title: "no extras",
    });
    expect("runway_id" in incident).toBe(false);
    expect("details" in incident).toBe(false);
    expect("idempotency_key" in incident).toBe(false);
  });
});

describe("InMemoryIncidentRepository — findById", () => {
  it("returns the stored incident", async () => {
    const repo = new InMemoryIncidentRepository();
    const created = await repo.create({ airport_id: AIRPORT, severity: "high", title: "x" });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it("returns null for missing id", async () => {
    const repo = new InMemoryIncidentRepository();
    expect(await repo.findById("99999999-9999-9999-9999-999999999999")).toBeNull();
  });
});

describe("InMemoryIncidentRepository — save (update)", () => {
  it("overwrites the row in place", async () => {
    const repo = new InMemoryIncidentRepository();
    const created = await repo.create({ airport_id: AIRPORT, severity: "high", title: "x" });
    const updated = await repo.save({ ...created, status: "acknowledged" });
    expect(updated.status).toBe("acknowledged");
    expect((await repo.findById(created.id))?.status).toBe("acknowledged");
  });
});

describe("InMemoryIncidentRepository — list filters", () => {
  async function seed() {
    const repo = new InMemoryIncidentRepository();
    const clock = fixedClock("2026-05-29T10:00:00.000Z");
    await repo.create({ airport_id: AIRPORT, severity: "high", title: "1", now: clock });
    await repo.create({ airport_id: AIRPORT, severity: "low", title: "2", now: clock });
    await repo.create({
      airport_id: AIRPORT_2,
      severity: "high",
      title: "3",
      now: clock,
    });
    await repo.create({
      airport_id: AIRPORT,
      severity: "critical",
      title: "4",
      now: clock,
    });
    // Move one to acknowledged for status-filter assertion.
    const fourth = (await repo.findById((await repo.list({}, { limit: 1 })).items[0]!.id))!;
    await repo.save({ ...fourth, status: "acknowledged" });
    return repo;
  }

  it("filters by airport_id", async () => {
    const repo = await seed();
    const { items } = await repo.list({ airport_id: AIRPORT } as ListIncidentsQuery, { limit: 10 });
    expect(items.every((i) => i.airport_id === AIRPORT)).toBe(true);
    expect(items).toHaveLength(3);
  });

  it("filters by severity", async () => {
    const repo = await seed();
    const { items } = await repo.list({ severity: "high" } as ListIncidentsQuery, { limit: 10 });
    expect(items.every((i) => i.severity === "high")).toBe(true);
  });

  it("filters by status", async () => {
    const repo = await seed();
    const { items } = await repo.list({ status: "acknowledged" } as ListIncidentsQuery, {
      limit: 10,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("acknowledged");
  });

  it("combines filters with AND", async () => {
    const repo = await seed();
    const { items } = await repo.list(
      { airport_id: AIRPORT, severity: "high" } as ListIncidentsQuery,
      { limit: 10 },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.airport_id).toBe(AIRPORT);
    expect(items[0]?.severity).toBe("high");
  });

  it("respects created_after / created_before bounds", async () => {
    const repo = new InMemoryIncidentRepository();
    const clock = fixedClock("2026-05-29T10:00:00.000Z");
    await repo.create({ airport_id: AIRPORT, severity: "high", title: "early", now: clock });
    await repo.create({ airport_id: AIRPORT, severity: "high", title: "mid", now: clock });
    await repo.create({ airport_id: AIRPORT, severity: "high", title: "late", now: clock });

    const after = await repo.list(
      { created_after: "2026-05-29T10:00:01.000Z" } as ListIncidentsQuery,
      { limit: 10 },
    );
    expect(after.items.map((i) => i.title).sort()).toEqual(["late", "mid"]);

    const before = await repo.list(
      { created_before: "2026-05-29T10:00:02.000Z" } as ListIncidentsQuery,
      { limit: 10 },
    );
    expect(before.items.map((i) => i.title).sort()).toEqual(["early", "mid"]);
  });
});

describe("InMemoryIncidentRepository — pagination", () => {
  it("returns DESC by created_at; cursor pages through", async () => {
    const repo = new InMemoryIncidentRepository();
    const clock = fixedClock("2026-05-29T10:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await repo.create({ airport_id: AIRPORT, severity: "high", title: `i-${i}`, now: clock });
    }
    const page1 = await repo.list({}, { limit: 2 });
    expect(page1.items.map((i) => i.title)).toEqual(["i-4", "i-3"]);
    expect(page1.next_cursor).not.toBeNull();
    expect(page1.total).toBe(5);

    const page2 = await repo.list({}, { limit: 2, cursor: page1.next_cursor! });
    expect(page2.items.map((i) => i.title)).toEqual(["i-2", "i-1"]);

    const page3 = await repo.list({}, { limit: 2, cursor: page2.next_cursor! });
    expect(page3.items.map((i) => i.title)).toEqual(["i-0"]);
    expect(page3.next_cursor).toBeNull();
  });

  it("falls back to empty next_cursor on the final page", async () => {
    const repo = new InMemoryIncidentRepository();
    const result = await repo.list({}, { limit: 10 });
    expect(result.items).toEqual([]);
    expect(result.next_cursor).toBeNull();
    expect(result.total).toBe(0);
  });

  it("ignores a malformed cursor (returns the head as if no cursor)", async () => {
    const repo = new InMemoryIncidentRepository();
    await repo.create({ airport_id: AIRPORT, severity: "high", title: "x" });
    const result = await repo.list({}, { limit: 10, cursor: "not-base64" });
    expect(result.items).toHaveLength(1);
  });
});

describe("Idempotency error class", () => {
  it("is exported and carries the existing id", () => {
    const err = new IdempotencyKeyConflictError("k-1", "id-1");
    expect(err.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(err.key).toBe("k-1");
    expect(err.existingId).toBe("id-1");
  });
});
