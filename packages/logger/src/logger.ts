import pino, {
  type DestinationStream,
  type Level,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from "pino";
import { getContext } from "./context.js";
import { DEFAULT_REDACTION_PATHS } from "./redaction.js";

export type Logger = PinoLogger;

export interface LoggerOptions {
  service: string;
  level?: Level;
  redact?: readonly string[];
  /**
   * Override the destination stream. Default writes JSON lines to
   * stdout. Tests pass an in-memory stream to capture output; production
   * could pass a syslog or file destination.
   */
  destination?: DestinationStream;
}

/**
 * Create the canonical service logger. Call once at startup and pass
 * the result around (or expose it via DI / module export).
 *
 * The logger automatically merges any `withContext` ids into every
 * log line via pino's `mixin` hook — no manual threading.
 */
export function createLogger({
  service,
  level = (process.env["LOG_LEVEL"] as Level | undefined) ?? "info",
  redact = DEFAULT_REDACTION_PATHS,
  destination,
}: LoggerOptions): Logger {
  const config: PinoLoggerOptions = {
    level,
    base: { service },
    mixin() {
      const ctx = getContext();
      return ctx ? { request_id: ctx.request_id, correlation_id: ctx.correlation_id } : {};
    },
    redact: {
      paths: [...redact],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(config, destination) : pino(config);
}
