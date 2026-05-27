import { HttpClientError } from "./errors.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Identifier for logs/metrics (e.g. "incident-service"). */
  name: string;
  /** Consecutive failures before opening the circuit. Default 5. */
  failureThreshold?: number;
  /** Time to stay open before trying a probe. Default 30_000ms. */
  resetTimeoutMs?: number;
  /** Clock — override in tests for determinism. Default Date.now. */
  now?: () => number;
}

/**
 * Per-dependency circuit breaker. Use one per downstream service or
 * external API. Avoid a single global breaker — it would tie unrelated
 * failures together.
 *
 * States:
 * - `closed`     — passing through; counts consecutive failures.
 * - `open`       — rejecting immediately with `HttpClientError("circuit_open")`.
 * - `half_open`  — exactly one probe allowed; success → closed, failure → open.
 */
export class CircuitBreaker {
  readonly name: string;
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.threshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === "open") {
      throw new HttpClientError("circuit_open", `circuit "${this.name}" is open`);
    }

    if (this.state === "half_open") {
      if (this.halfOpenInFlight) {
        throw new HttpClientError(
          "circuit_open",
          `circuit "${this.name}" half-open probe already in flight`,
        );
      }
      this.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.halfOpenInFlight = false;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.state === "half_open") {
      this.state = "open";
      this.openedAt = this.now();
      this.halfOpenInFlight = false;
      return;
    }
    if (this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== "open") return;
    if (this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half_open";
      this.halfOpenInFlight = false;
    }
  }
}
