import { z } from "zod";

/**
 * Canonical error response envelope returned by every REST endpoint
 * on failure. Never include stack traces or internal paths.
 */
export const ErrorResponse = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional(),
    correlation_id: z.string().uuid().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
