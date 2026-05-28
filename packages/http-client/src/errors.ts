export type HttpClientErrorCode =
  | "timeout"
  | "network"
  | "exhausted"
  | "circuit_open"
  | `http_${number}`;

export class HttpClientError extends Error {
  readonly code: HttpClientErrorCode;
  readonly status?: number;
  readonly attempts: number;

  constructor(
    code: HttpClientErrorCode,
    message: string,
    opts: { status?: number; attempts?: number } = {},
  ) {
    super(message);
    this.name = "HttpClientError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    this.attempts = opts.attempts ?? 1;
    // Drop the stack trace — these errors are exposed on /health and
    // proxied between services; no stack leakage.
    delete (this as { stack?: string }).stack;
  }
}

/**
 * Retryable HTTP statuses per the contract documented in the README.
 * `408` (Request Timeout), `429` (Too Many Requests), and any `5xx`.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}
