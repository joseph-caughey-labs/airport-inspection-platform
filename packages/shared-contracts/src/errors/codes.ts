/**
 * Canonical error codes used across services in the `error.code` field
 * of `ErrorResponse`. Maps roughly to HTTP status families:
 *
 * 4xx (client) — validation, auth, not found, conflict, rate, payload size.
 * 5xx (server) — internal, upstream timeout/unavailable.
 *
 * Add codes here when they are reused across services. Service-local
 * codes stay in the service.
 */
export const ErrorCode = {
  // 4xx
  VALIDATION_FAILED: "validation_failed",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  UNPROCESSABLE: "unprocessable",
  // 5xx
  INTERNAL_ERROR: "internal_error",
  UPSTREAM_TIMEOUT: "upstream_timeout",
  UPSTREAM_UNAVAILABLE: "upstream_unavailable",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
