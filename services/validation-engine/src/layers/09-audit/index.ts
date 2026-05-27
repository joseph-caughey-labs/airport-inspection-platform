import type { ValidationLayer } from "../types.js";

/**
 * Layer 9 — Audit Trail & Evidence Logging.
 * Real logic in T-411: write full lineage (raw → normalized → AI
 * → validation results → reviewer decision → final) to audit-service.
 * Append-only at the DB role level by ADR 0010.
 */
export const auditLayer: ValidationLayer = {
  id: "09_audit",
  name: "Audit Trail & Evidence Logging",
  async run(_ctx) {
    return { layer: "09_audit", passed: true };
  },
};
