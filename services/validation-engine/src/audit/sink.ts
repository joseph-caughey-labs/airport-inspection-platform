/**
 * Audit sink interface. L9 hands a record of every validation run
 * (envelope summary + per-layer results + risk + HITL) to a sink.
 *
 * Two implementations ship with the engine:
 *
 *   - `RecordingAuditSink`: keeps every record in memory. Unit
 *     tests assert on `sink.records`.
 *   - (future) `RestAuditSink`: POSTs to the audit-service (T-412)
 *     where the hash-chained append-only log lives. Deferred to
 *     keep the engine ↔ audit-service wiring (retries, batching,
 *     backpressure) in its own ticket.
 *
 * Same default-pass semantics as L4/L5/L10: when no sink is
 * configured, L9 still produces the record on `details.audit` but
 * doesn't transmit anywhere.
 */

import type { ValidationLayerResult } from "../layers/types.js";
import type { HitlDecision } from "../layers/08-human-review/index.js";
import type { RiskReport } from "../layers/07-risk/index.js";

export interface ValidationAuditRecord {
  /** Stable id for the run — matches `ValidationRun.run_id`. */
  run_id?: string;
  /** Caller-supplied or generated. */
  submission_id: string;
  /** Wire envelope summary, intentionally narrow — full envelope
   * is already in the originating event. */
  envelope: { event_id?: string; event_type?: string; timestamp?: string };
  /** Every layer's result, in order. */
  layers: ValidationLayerResult[];
  /** L7's risk report, if present. */
  risk?: RiskReport;
  /** L8's HITL decision, if present. */
  hitl?: HitlDecision;
  /** When L9 emitted this record. */
  emitted_at: string;
}

export interface AuditSink {
  emit(record: ValidationAuditRecord): Promise<void>;
}

/** In-memory sink for tests. Captures every emitted record. */
export class RecordingAuditSink implements AuditSink {
  readonly records: ValidationAuditRecord[] = [];

  async emit(record: ValidationAuditRecord): Promise<void> {
    this.records.push(record);
  }
}
