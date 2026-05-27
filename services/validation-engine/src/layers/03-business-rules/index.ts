import type { ValidationLayer } from "../types.js";

/**
 * Layer 3 — Business Rule Validation.
 * Real logic in T-406: policy thresholds, severity-by-location matrix,
 * SOP-derived constraints from `reference-data`.
 */
export const businessRulesLayer: ValidationLayer = {
  id: "03_business_rules",
  name: "Business Rule Validation",
  async run(_ctx) {
    return { layer: "03_business_rules", passed: true };
  },
};
