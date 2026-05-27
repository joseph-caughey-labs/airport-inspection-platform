import type { ValidationLayer } from "../types.js";

/**
 * Layer 6 — AI Output Validation.
 * Real logic in T-408: bbox sanity, confidence ≥ threshold, evidence
 * linkage (frame id, model id, threshold used).
 */
export const aiOutputLayer: ValidationLayer = {
  id: "06_ai_output",
  name: "AI Output Validation",
  async run(_ctx) {
    return { layer: "06_ai_output", passed: true };
  },
};
