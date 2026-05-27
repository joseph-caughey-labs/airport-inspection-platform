import { z } from "zod";

/**
 * Canonical id for each of the 10 Parity validation layers. This is
 * a candidate for promotion to `@aip/shared-contracts` once consumers
 * exist (T-405); for now it's local to the engine.
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

/** Input to every layer. Layers may read accumulated results from prior layers. */
export interface ValidationContext {
  submission_id: string;
  payload: unknown;
  previous_results: ValidationLayerResult[];
}

/** Output from every layer. */
export interface ValidationLayerResult {
  layer: ValidationLayerId;
  passed: boolean;
  details?: Record<string, unknown>;
  evidence?: unknown[];
  error_code?: string;
  error_message?: string;
}

/** Implementation contract for every layer. */
export interface ValidationLayer {
  id: ValidationLayerId;
  name: string;
  run(ctx: ValidationContext): Promise<ValidationLayerResult>;
}
