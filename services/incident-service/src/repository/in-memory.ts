import { randomUUID } from "node:crypto";
import type { Incident, ListIncidentsQuery } from "@aip/shared-contracts";
import {
  IdempotencyKeyConflictError,
  type IncidentListResult,
  type IncidentRepository,
  type NewIncidentInput,
  type PageRequest,
} from "./types.js";

/**
 * In-memory IncidentRepository — primarily for tests.
 *
 * Matches the contract of the (future) Postgres implementation
 * exactly: same cursor format `(created_at, id)`, same idempotency
 * collision semantics, same filter behavior. The route tests run
 * against this; the eventual Postgres impl will run the same
 * integration suite against a real DB.
 */
export class InMemoryIncidentRepository implements IncidentRepository {
  private readonly items = new Map<string, Incident>();
  private readonly idempotencyIndex = new Map<string, string>();

  async create(input: NewIncidentInput): Promise<Incident> {
    if (input.idempotency_key) {
      const existing = this.idempotencyIndex.get(input.idempotency_key);
      if (existing) {
        const existingItem = this.items.get(existing);
        if (existingItem) return existingItem;
        throw new IdempotencyKeyConflictError(input.idempotency_key, existing);
      }
    }
    const now = (input.now ?? (() => new Date()))().toISOString();
    const incident: Incident = {
      id: input.id ?? randomUUID(),
      airport_id: input.airport_id,
      severity: input.severity,
      status: input.status ?? "new",
      title: input.title,
      created_at: now,
      updated_at: now,
      ...(input.runway_id !== undefined ? { runway_id: input.runway_id } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.idempotency_key !== undefined ? { idempotency_key: input.idempotency_key } : {}),
    };
    this.items.set(incident.id, incident);
    if (incident.idempotency_key) {
      this.idempotencyIndex.set(incident.idempotency_key, incident.id);
    }
    return incident;
  }

  async findById(id: string): Promise<Incident | null> {
    return this.items.get(id) ?? null;
  }

  async save(incident: Incident): Promise<Incident> {
    this.items.set(incident.id, incident);
    return incident;
  }

  async list(filter: ListIncidentsQuery, page: PageRequest): Promise<IncidentListResult> {
    let matched = Array.from(this.items.values()).filter((item) => matches(item, filter));
    matched.sort(compareDescending);
    const total = matched.length;
    if (page.cursor) {
      const cursor = decodeCursor(page.cursor);
      if (cursor) {
        matched = matched.filter(
          (item) =>
            item.created_at < cursor.created_at ||
            (item.created_at === cursor.created_at && item.id < cursor.id),
        );
      }
    }
    const slice = matched.slice(0, page.limit);
    const next_cursor =
      matched.length > slice.length && slice.length > 0
        ? encodeCursor({
            created_at: slice[slice.length - 1]!.created_at,
            id: slice[slice.length - 1]!.id,
          })
        : null;
    return { items: slice, next_cursor, total };
  }
}

function matches(item: Incident, filter: ListIncidentsQuery): boolean {
  if (filter.status && item.status !== filter.status) return false;
  if (filter.severity && item.severity !== filter.severity) return false;
  if (filter.airport_id && item.airport_id !== filter.airport_id) return false;
  if (filter.runway_id && item.runway_id !== filter.runway_id) return false;
  if (filter.created_after && item.created_at < filter.created_after) return false;
  if (filter.created_before && item.created_at >= filter.created_before) return false;
  return true;
}

function compareDescending(a: Incident, b: Incident): number {
  if (a.created_at < b.created_at) return 1;
  if (a.created_at > b.created_at) return -1;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

function encodeCursor(cursor: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { created_at: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      created_at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.created_at !== "string" || typeof parsed.id !== "string") return null;
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    return null;
  }
}
