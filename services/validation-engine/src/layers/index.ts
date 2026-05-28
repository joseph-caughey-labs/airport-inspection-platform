import { aiOutputLayer } from "./06-ai-output/index.js";
import { auditLayer } from "./09-audit/index.js";
import { businessRulesLayer } from "./03-business-rules/index.js";
import { certificationLayer } from "./10-certification/index.js";
import { crossSystemLayer } from "./05-cross-system/index.js";
import { humanReviewLayer } from "./08-human-review/index.js";
import { inputValidationLayer } from "./01-input/index.js";
import { riskScoringLayer } from "./07-risk/index.js";
import { schemaValidationLayer } from "./02-schema/index.js";
import { sourceOfTruthLayer } from "./04-source-of-truth/index.js";
import type { ValidationLayer } from "./types.js";

/**
 * The 10 Parity validation layers in execution order. Order is the
 * contract; changing it requires an ADR update (currently ADR 0008
 * draft, accepted in T-405).
 */
export const ORDERED_LAYERS: readonly ValidationLayer[] = [
  inputValidationLayer,
  schemaValidationLayer,
  businessRulesLayer,
  sourceOfTruthLayer,
  crossSystemLayer,
  aiOutputLayer,
  riskScoringLayer,
  humanReviewLayer,
  auditLayer,
  certificationLayer,
] as const;

export * from "./types.js";
