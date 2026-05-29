import { z } from "zod";
import { ValidationLayerResult } from "./layer.js";

/**
 * The envelope returned by `POST /validate` and persisted by the
 * audit-service (T-412). One run = one walk of (some prefix of) the
 * 10 layers.
 *
 * `certified` is the gate field every downstream consumer looks at:
 *   - true  → incident-service.create() runs
 *   - false → incident-service.reject() runs with `error_code` from
 *             the first failing layer as the reason
 *
 * When the engine short-circuits (production default) `layers` may be
 * shorter than 10. Consumers should not assume length; they should
 * key on `layer` ids or look at `certified`.
 */
export const ValidationRun = z.object({
  run_id: z.string().uuid(),
  submission_id: z.string().uuid(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  layers: z.array(ValidationLayerResult),
  certified: z.boolean(),
});
export type ValidationRun = z.infer<typeof ValidationRun>;
