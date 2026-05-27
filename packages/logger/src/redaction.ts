/**
 * Default paths redacted from every log line. Extend at logger
 * creation time when a service handles additional sensitive fields.
 *
 * Pino interprets these as object-path patterns. See
 * https://getpino.io/#/docs/redaction for the syntax.
 */
export const DEFAULT_REDACTION_PATHS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apiKey",
  "authorization",
  "auth",
  "cookie",
  "set-cookie",
  "*.password",
  "*.token",
  "*.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
] as const;
