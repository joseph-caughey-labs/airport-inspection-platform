import { z } from "zod";

/**
 * Canonical id for each of the 10 Parity validation layers.
 *
 * Order is the contract — the engine runs them in this sequence and
 * downstream consumers (audit log, operator timeline) display them
 * in this sequence. Adding, removing, or reordering a layer is an
 * ADR-level change (see ADR 0011).
 */
export const ValidationLayerId = z.enum([
  "01_input",
  "02_schema",
  "03_business_rules",
  "04_source_of_truth",
  "05_cross_system",
  "06_ai_output",
  "07_risk",
  "08_human_review",
  "09_audit",
  "10_certification",
]);
export type ValidationLayerId = z.infer<typeof ValidationLayerId>;

/** Ordered list of layer ids — convenient for iteration + UI rendering. */
export const ORDERED_VALIDATION_LAYER_IDS: readonly ValidationLayerId[] = ValidationLayerId.options;

/**
 * The serializable result of a single layer's run. The engine
 * produces this; bridges + UI consume it. `details` and `evidence`
 * are intentionally loosely typed because every layer carries
 * different per-domain artifacts (geo coordinates for L1, bbox
 * checks for L6, etc.); the layer-specific shape is the layer's
 * problem.
 */
export const ValidationLayerResult = z.object({
  layer: ValidationLayerId,
  passed: z.boolean(),
  details: z.record(z.unknown()).optional(),
  evidence: z.array(z.unknown()).optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
});
export type ValidationLayerResult = z.infer<typeof ValidationLayerResult>;
