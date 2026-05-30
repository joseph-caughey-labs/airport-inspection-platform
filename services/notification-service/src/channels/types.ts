/**
 * Channel interface that every notification target implements.
 *
 * A `NotificationEvent` is a normalized envelope the subscriber
 * hands to every channel. Channels decide whether they care + how
 * to render — the in-app channel renders a `events.broadcast.*`
 * Redis publish; the webhook channel renders an HTTP POST; the
 * email channel renders a (stubbed) log line.
 *
 * Channels report a `DeliveryResult` so the subscriber can record
 * the attempt and decide what to do on failure (retry, DLQ, drop).
 */

export interface NotificationEvent {
  /** Unique event id from the originating publisher (used for
   * idempotency). */
  event_id: string;
  /** Discriminator — e.g. "incident.transitioned". */
  event_type: string;
  /** Subject the operator UI uses to route (incident id, etc.). */
  subject_id: string;
  /** Originating service. */
  source: string;
  /** ISO-8601. */
  occurred_at: string;
  /** Free-form payload from the upstream envelope. */
  payload: Record<string, unknown>;
  /** Optional human-facing text the channel may surface verbatim. */
  rationale?: string;
}

export type DeliveryStatus = "delivered" | "failed" | "skipped";

export interface DeliveryResult {
  channel: string;
  event_id: string;
  status: DeliveryStatus;
  attempts: number;
  /** Set on failed/skipped. */
  error?: string;
  /** Set on delivered — channel-specific (URL, message id, etc.). */
  target?: string;
  /** When the final attempt resolved. ISO-8601. */
  completed_at: string;
}

export interface NotificationChannel {
  /** Stable name surfaced on `/channels`. */
  readonly name: string;
  /**
   * Return `false` to indicate this channel doesn't apply to the
   * event (different from a failed attempt). The subscriber records
   * `status="skipped"` for these.
   */
  appliesTo(event: NotificationEvent): boolean;
  /**
   * Deliver the event. The channel owns its retry policy + records
   * `attempts`; the subscriber doesn't retry on the channel's behalf.
   */
  deliver(event: NotificationEvent): Promise<DeliveryResult>;
}
