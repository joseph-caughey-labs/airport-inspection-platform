import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ErrorResponse,
  EventEnvelope,
  PaginatedResponse,
  PaginationQuery,
  WsMessage,
} from "../../../packages/shared-contracts/src/index.js";
import { z } from "zod";

const UUID = "11111111-2222-3333-4444-555555555555";
const TS = "2026-05-27T10:00:00.000Z";

describe("EventEnvelope", () => {
  const valid = {
    event_id: UUID,
    event_type: "sensor.frame.captured",
    schema_version: "v1",
    source: { service: "sensor-gateway" },
    timestamp: TS,
  };

  it("accepts a minimal envelope", () => {
    expect(EventEnvelope.parse(valid).event_type).toBe("sensor.frame.captured");
  });

  it("accepts optional correlation + idempotency keys", () => {
    expect(
      EventEnvelope.parse({
        ...valid,
        correlation_id: UUID,
        idempotency_key: "fingerprint:abc-123",
      }),
    ).toBeDefined();
  });

  it("rejects malformed schema_version", () => {
    expect(() => EventEnvelope.parse({ ...valid, schema_version: "1.0" })).toThrow();
    expect(() => EventEnvelope.parse({ ...valid, schema_version: "version-1" })).toThrow();
  });

  it("rejects when timestamp is not ISO-8601", () => {
    expect(() => EventEnvelope.parse({ ...valid, timestamp: "not a date" })).toThrow();
  });
});

describe("WsMessage", () => {
  it("accepts an arbitrary payload type", () => {
    const msg = WsMessage.parse({
      type: "incident.created",
      schema_version: "v1",
      payload: { id: UUID },
      timestamp: TS,
    });
    expect(msg.type).toBe("incident.created");
  });

  it("rejects when type is empty", () => {
    expect(() =>
      WsMessage.parse({
        type: "",
        schema_version: "v1",
        payload: {},
        timestamp: TS,
      }),
    ).toThrow();
  });
});

describe("ErrorResponse", () => {
  it("accepts a canonical error", () => {
    expect(
      ErrorResponse.parse({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: "field x is required",
        },
      }).error.code,
    ).toBe("validation_failed");
  });

  it("requires both code and message", () => {
    expect(() => ErrorResponse.parse({ error: { code: "x" } })).toThrow();
    expect(() => ErrorResponse.parse({ error: { message: "y" } })).toThrow();
  });
});

describe("PaginationQuery", () => {
  it("defaults limit to 50", () => {
    expect(PaginationQuery.parse({}).limit).toBe(50);
  });

  it("coerces stringy limits", () => {
    expect(PaginationQuery.parse({ limit: "25" }).limit).toBe(25);
  });

  it("rejects out-of-range limit", () => {
    expect(() => PaginationQuery.parse({ limit: 0 })).toThrow();
    expect(() => PaginationQuery.parse({ limit: 201 })).toThrow();
  });
});

describe("PaginatedResponse", () => {
  it("accepts a typed paginated list", () => {
    const Schema = PaginatedResponse(z.object({ id: z.string() }));
    expect(
      Schema.parse({
        items: [{ id: "a" }, { id: "b" }],
        next_cursor: "cursor:1",
      }).items,
    ).toHaveLength(2);
  });

  it("rejects items that fail the inner schema", () => {
    const Schema = PaginatedResponse(z.object({ id: z.string() }));
    expect(() =>
      Schema.parse({
        items: [{ id: 1 }],
        next_cursor: null,
      }),
    ).toThrow();
  });
});

describe("ErrorCode", () => {
  it("maps to known string literals", () => {
    expect(ErrorCode.UNAUTHORIZED).toBe("unauthorized");
    expect(ErrorCode.UPSTREAM_TIMEOUT).toBe("upstream_timeout");
  });
});
