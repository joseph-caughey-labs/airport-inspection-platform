import { z } from "zod";

/**
 * Detection classes emitted by the AI inference service. New classes
 * require an ADR (or at least a design note) because they often imply
 * new validation rules and severity matrices.
 */
export const DetectionClass = z.enum([
  "fod", // Foreign Object Debris
  "pavement_crack",
  "snowbank_violation",
  "wildlife",
  "surface_anomaly",
]);
export type DetectionClass = z.infer<typeof DetectionClass>;
