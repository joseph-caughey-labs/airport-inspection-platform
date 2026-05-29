import { z } from "zod";

/**
 * Request body for `POST /validate`.
 *
 * `submission_id` is OPTIONAL on the wire: the engine generates one
 * when the caller doesn't supply it. Callers that bridge from AI
 * detection (event-pipeline) supply the detection's idempotency_key
 * as the submission_id so the validation run can be correlated with
 * the originating frame in postmortems.
 *
 * `payload` is intentionally `unknown` here — every layer reads from
 * it through layer-specific zod schemas (e.g. L6 needs a bbox + a
 * confidence; L1 needs a timestamp + lat/lng). Centralizing the
 * payload shape here would force every layer to know every field
 * up-front, which we don't want.
 */
export const ValidationSubmissionRequest = z.object({
  submission_id: z.string().uuid().optional(),
  payload: z.unknown(),
});
export type ValidationSubmissionRequest = z.infer<typeof ValidationSubmissionRequest>;
