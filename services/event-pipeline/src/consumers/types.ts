import { type Logger } from "@aip/logger";

/**
 * A handler is the per-channel processor. Implementations parse the
 * raw message into a typed event, decide what to do, and either
 * resolve (success) or throw (categorizable error).
 */
export interface ConsumerHandler {
  /** Logical name for metrics and logs (e.g. "sensor-frames"). */
  readonly name: string;
  /** Redis channel this handler subscribes to. */
  readonly channel: string;
  /** Process a single raw message. */
  handle(rawPayload: string, ctx: { logger: Logger }): Promise<void>;
}

/**
 * Result of dispatching a single message. Useful for tests and for
 * the orchestrator's own metric tagging.
 */
export type DispatchOutcome = "processed" | "errored" | "dropped";
