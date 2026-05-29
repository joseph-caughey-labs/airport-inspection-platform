/**
 * Layer contract types. The wire-format shapes (`ValidationLayerId`,
 * `ValidationLayerResult`) live in `@aip/shared-contracts/validation`
 * as of T-405 so the bridge in event-pipeline and the operator UI in
 * apps/web can consume them without depending on this service. This
 * file only carries the in-process types that a layer's `run()`
 * actually implements.
 */
import type { ValidationLayerId, ValidationLayerResult } from "@aip/shared-contracts";

export type { ValidationLayerId, ValidationLayerResult } from "@aip/shared-contracts";
export { ValidationLayerId as ValidationLayerIdSchema } from "@aip/shared-contracts";

/** Input to every layer. Layers may read accumulated results from prior layers. */
export interface ValidationContext {
  submission_id: string;
  payload: unknown;
  previous_results: ValidationLayerResult[];
}

/** Implementation contract for every layer. */
export interface ValidationLayer {
  id: ValidationLayerId;
  name: string;
  run(ctx: ValidationContext): Promise<ValidationLayerResult>;
}
