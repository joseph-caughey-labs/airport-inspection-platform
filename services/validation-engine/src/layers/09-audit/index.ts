/**
 * Layer 9 — Audit Trail Emission.
 *
 * Captures a full record of the validation run — envelope summary,
 * every per-layer result so far, L7's risk report, L8's HITL
 * decision — and (optionally) emits it to an `AuditSink`. The hash-
 * chained append-only audit log lives in audit-service (T-412); L9
 * is the engine-side emit point that feeds it.
 *
 * Always passes. Audit emission is record-keeping, not rejection;
 * the layer surfaces the same record on `details.audit` so even
 * without a sink the run carries its own audit envelope (useful in
 * dev + for `RecordingAuditSink`-based tests).
 *
 * Layer is factory-configured with:
 *   - optional `sink`     ▶ where to write
 *   - optional `now()`    ▶ test seam for emitted_at
 */
import type { ValidationLayer } from "../types.js";
import type { AuditSink, ValidationAuditRecord } from "../../audit/sink.js";
import type { HitlDecision } from "../08-human-review/index.js";
import type { RiskReport } from "../07-risk/index.js";

export interface AuditEmissionConfig {
  sink?: AuditSink;
  now?: () => Date;
}

export function createAuditEmissionLayer(cfg: AuditEmissionConfig = {}): ValidationLayer {
  const sink = cfg.sink;
  const now = cfg.now ?? (() => new Date());

  return {
    id: "09_audit",
    name: "Audit Trail Emission",
    async run(ctx) {
      const env = extractEnvelopeSummary(ctx.payload);
      const risk = readRiskReport(ctx.previous_results);
      const hitl = readHitlDecision(ctx.previous_results);

      const record: ValidationAuditRecord = {
        submission_id: ctx.submission_id,
        envelope: env,
        layers: ctx.previous_results.slice(),
        ...(risk ? { risk } : {}),
        ...(hitl ? { hitl } : {}),
        emitted_at: now().toISOString(),
      };

      if (sink) {
        await sink.emit(record);
      }

      return {
        layer: "09_audit",
        passed: true,
        details: { audit: { emitted_at: record.emitted_at, layer_count: record.layers.length } },
      };
    },
  };
}

export const auditLayer: ValidationLayer = createAuditEmissionLayer();

function extractEnvelopeSummary(input: unknown): ValidationAuditRecord["envelope"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  const env = input as Record<string, unknown>;
  const out: ValidationAuditRecord["envelope"] = {};
  if (typeof env.event_id === "string") out.event_id = env.event_id;
  if (typeof env.event_type === "string") out.event_type = env.event_type;
  if (typeof env.timestamp === "string") out.timestamp = env.timestamp;
  return out;
}

function readRiskReport(
  results: { layer: string; details?: Record<string, unknown> | undefined }[],
): RiskReport | undefined {
  for (const r of results) {
    if (r.layer === "07_risk" && r.details && "risk" in r.details) {
      return r.details.risk as RiskReport;
    }
  }
  return undefined;
}

function readHitlDecision(
  results: { layer: string; details?: Record<string, unknown> | undefined }[],
): HitlDecision | undefined {
  for (const r of results) {
    if (r.layer === "08_human_review" && r.details && "hitl" in r.details) {
      return r.details.hitl as HitlDecision;
    }
  }
  return undefined;
}
