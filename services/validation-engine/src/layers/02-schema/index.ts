/**
 * Layer 2 — Schema & Contract Validation.
 *
 * Where L1 was the shape gate ("are the right fields present?"),
 * L2 is the contract gate ("does every field conform to the
 * canonical schema?"). Specifically:
 *
 *   1. The envelope passes `EventEnvelope` zod parse — the
 *      `event_type` is a non-empty string, `schema_version` matches
 *      the version regex, `source.service` is non-empty, the
 *      optional `idempotency_key` is the right length, etc.
 *
 *   2. `schema_version` is in the configured supported list. New
 *      majors land as code changes (a new payload schema), not as
 *      runtime config — but we surface the rejection here so a
 *      forward-compat-bumped publisher gets a clear error instead
 *      of confusing payload failures further down.
 *
 *   3. The payload parses cleanly against its event-type-specific
 *      schema:
 *        - `sensor.frame.captured`     → SensorFramePayload
 *        - `ai.detection.<class>.emitted` → AiDetectionPayload
 *
 *      Other event_types fail with `UNSUPPORTED_EVENT_TYPE` —
 *      reaching L2 with an unknown event_type means L1 let through
 *      something we don't have a contract for, and the right answer
 *      is to reject loudly rather than fall through to L3.
 *
 * L2 collects every zod issue into `details.failures` so operators
 * see all of them at once, mirroring L1's contract.
 */
import type { ZodIssue } from "zod";
import { EventEnvelope } from "@aip/shared-contracts";
import type { ValidationLayer } from "../types.js";
import { AiDetectionPayload, SensorFramePayload } from "./payload-schemas.js";

export interface SchemaValidationConfig {
  /**
   * Schema versions L2 knows how to validate against. A payload
   * carrying any other value fails with `UNSUPPORTED_SCHEMA_VERSION`.
   * Default `["v1"]` — bumped when a new payload schema is added.
   */
  supportedSchemaVersions?: readonly string[];
}

const DEFAULT_SUPPORTED_SCHEMA_VERSIONS = ["v1"] as const;
const AI_DETECTION_EVENT_TYPE_RE = /^ai\.detection\.[a-z_]+\.emitted$/;

interface SchemaFailure {
  code: string;
  message: string;
  path?: string;
}

export function createSchemaValidationLayer(cfg: SchemaValidationConfig = {}): ValidationLayer {
  const supported = cfg.supportedSchemaVersions ?? DEFAULT_SUPPORTED_SCHEMA_VERSIONS;

  return {
    id: "02_schema",
    name: "Schema & Contract Validation",
    async run(ctx) {
      const failures: SchemaFailure[] = [];

      // 1. Envelope-level contract.
      const envParse = EventEnvelope.safeParse(ctx.payload);
      if (!envParse.success) {
        for (const issue of envParse.error.issues) {
          failures.push(zodIssueToFailure("ENVELOPE_SCHEMA", issue));
        }
        // Even with envelope failures we can still try the payload
        // parse if the input is at least an object — operators get
        // a complete picture in one pass.
      }

      const env = envParse.success ? envParse.data : safeEnvelope(ctx.payload);

      // 2. Supported schema_version.
      if (env?.schema_version && !supported.includes(env.schema_version)) {
        failures.push({
          code: "UNSUPPORTED_SCHEMA_VERSION",
          message: `schema_version "${env.schema_version}" is not in [${supported.join(", ")}]`,
          path: "schema_version",
        });
      }

      // 3. Payload schema by event_type.
      if (env?.event_type !== undefined) {
        const payloadFailures = validatePayload(env.event_type, getPayload(ctx.payload));
        failures.push(...payloadFailures);
      }

      if (failures.length === 0) {
        return { layer: "02_schema", passed: true };
      }
      const primary = failures[0]!;
      return {
        layer: "02_schema",
        passed: false,
        error_code: primary.code,
        error_message: primary.message,
        details: { failures },
      };
    },
  };
}

export const schemaValidationLayer: ValidationLayer = createSchemaValidationLayer();

function validatePayload(eventType: string, payload: unknown): SchemaFailure[] {
  if (eventType === "sensor.frame.captured") {
    return runParse("SENSOR_FRAME_PAYLOAD", SensorFramePayload, payload, "payload");
  }
  if (AI_DETECTION_EVENT_TYPE_RE.test(eventType)) {
    return runParse("AI_DETECTION_PAYLOAD", AiDetectionPayload, payload, "payload");
  }
  return [
    {
      code: "UNSUPPORTED_EVENT_TYPE",
      message: `no L2 schema for event_type "${eventType}"`,
      path: "event_type",
    },
  ];
}

function runParse<T>(
  codePrefix: string,
  schema: {
    safeParse(
      input: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } };
  },
  input: unknown,
  pathPrefix: string,
): SchemaFailure[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => zodIssueToFailure(codePrefix, issue, pathPrefix));
}

function zodIssueToFailure(
  codePrefix: string,
  issue: ZodIssue,
  pathPrefix?: string,
): SchemaFailure {
  const issuePath = issue.path.map((p) => String(p)).join(".");
  const fullPath = pathPrefix && issuePath ? `${pathPrefix}.${issuePath}` : pathPrefix || issuePath;
  return {
    code: `${codePrefix}__${issue.code.toUpperCase()}`,
    message: issue.message,
    ...(fullPath ? { path: fullPath } : {}),
  };
}

/**
 * Pull `event_type` + `schema_version` off a possibly-malformed input
 * so we can still surface UNSUPPORTED_SCHEMA_VERSION / payload-schema
 * failures when the envelope parse failed. Returns undefined if the
 * input isn't object-shaped enough to read.
 */
function safeEnvelope(
  input: unknown,
): { event_type?: string; schema_version?: string } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: { event_type?: string; schema_version?: string } = {};
  if (typeof raw.event_type === "string") out.event_type = raw.event_type;
  if (typeof raw.schema_version === "string") out.schema_version = raw.schema_version;
  return out;
}

function getPayload(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>).payload;
}
