/**
 * Webhook channel — POSTs the event to a configured URL with
 * exponential backoff retry. Final failures land in an in-memory
 * DLQ that operators can inspect via `GET /deliveries/dlq`.
 *
 * The DLQ is intentionally in-memory: this is a portfolio demo, and
 * a real DLQ (Redis stream, Postgres table, S3 dropbox) belongs in
 * its own ticket alongside production storage decisions. The
 * interface is shaped so swapping the in-memory queue for a real
 * one is a one-file change.
 *
 * `appliesTo` decides whether a given event maps to the configured
 * URL. The demo wires webhook delivery only when the event has an
 * `incident.transitioned` event_type — operator UI events
 * (`events.broadcast.*`) are in-app only. A config-driven event
 * allowlist gives the caller room to widen.
 */
import type { DeliveryResult, NotificationChannel, NotificationEvent } from "./types.js";

export interface WebhookChannelOptions {
  /** Destination URL. Empty string disables the channel. */
  url: string;
  /** Allowed event_types — when empty, every event_type is delivered. */
  eventTypeAllowlist?: readonly string[];
  /** Maximum total attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Initial retry delay (ms). Default 100. Doubles per attempt. */
  initialBackoffMs?: number;
  /** Test seam — override fetch. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /** Test seam — override sleep between retries. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 100;

export class WebhookChannel implements NotificationChannel {
  readonly name = "webhook";
  private readonly url: string;
  private readonly allowlist: readonly string[];
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  /** Public for tests + the /deliveries/dlq HTTP route. */
  readonly dlq: DeliveryResult[] = [];

  constructor(opts: WebhookChannelOptions) {
    this.url = opts.url;
    this.allowlist = opts.eventTypeAllowlist ?? [];
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => new Date());
  }

  appliesTo(event: NotificationEvent): boolean {
    if (!this.url) return false;
    if (this.allowlist.length === 0) return true;
    return this.allowlist.includes(event.event_type);
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    let attempt = 0;
    let lastError: string | undefined;
    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        const res = await this.fetchFn(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        if (res.ok) {
          return {
            channel: this.name,
            event_id: event.event_id,
            status: "delivered",
            attempts: attempt,
            target: this.url,
            completed_at: this.now().toISOString(),
          };
        }
        lastError = `http_${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.initialBackoffMs * Math.pow(2, attempt - 1));
      }
    }
    const failed: DeliveryResult = {
      channel: this.name,
      event_id: event.event_id,
      status: "failed",
      attempts: attempt,
      completed_at: this.now().toISOString(),
      ...(lastError ? { error: lastError } : {}),
    };
    this.dlq.push(failed);
    return failed;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
