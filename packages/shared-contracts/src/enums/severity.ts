import { z } from "zod";

/**
 * Operational severity bands aligned with airport ops vocabulary.
 *
 * - `critical`  Immediate safety risk; runway closure may be required.
 * - `high`      Significant operational impact; requires prompt action.
 * - `medium`    Operational concern; schedule action within shift.
 * - `low`       Minor issue; log and address routinely.
 * - `info`      Informational only; no action required.
 */
export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof Severity>;

/**
 * Ordering for severity comparisons and prioritization.
 * Lower index = more severe.
 */
export const SEVERITY_ORDER: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
