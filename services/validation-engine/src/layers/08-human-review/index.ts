import type { ValidationLayer } from "../types.js";

/**
 * Layer 8 — Human-in-the-Loop Review.
 * Real logic in T-409: route to reviewer queue when risk ≥ threshold,
 * unresolved contradictions, or low confidence on safety-critical
 * events. Reviewer claim/decision API lives here.
 */
export const humanReviewLayer: ValidationLayer = {
  id: "08_human_review",
  name: "Human-in-the-Loop Review",
  async run(_ctx) {
    return { layer: "08_human_review", passed: true };
  },
};
