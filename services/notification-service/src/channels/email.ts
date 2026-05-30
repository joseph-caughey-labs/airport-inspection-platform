/**
 * Email channel — STUB.
 *
 * A real SMTP / SES integration is out of demo scope. The stub
 * still implements the full `NotificationChannel` interface so the
 * registry + subscriber don't need to special-case it; the
 * `deliver()` call writes the payload to the logger and returns
 * `delivered`. A future ticket replaces this with a real sender.
 */
import type { Logger } from "@aip/logger";
import type { DeliveryResult, NotificationChannel, NotificationEvent } from "./types.js";

export interface EmailChannelOptions {
  logger: Logger;
  /** Allowed event_types; empty = all. Default: critical incidents only. */
  eventTypeAllowlist?: readonly string[];
  /** Recipients address book — first match wins. Default: a single
   * `ops@example.com` placeholder so the stub log shows a destination. */
  recipients?: readonly string[];
  now?: () => Date;
}

export class EmailChannel implements NotificationChannel {
  readonly name = "email";
  private readonly logger: Logger;
  private readonly allowlist: readonly string[];
  private readonly recipients: readonly string[];
  private readonly now: () => Date;

  constructor(opts: EmailChannelOptions) {
    this.logger = opts.logger;
    this.allowlist = opts.eventTypeAllowlist ?? [];
    this.recipients = opts.recipients ?? ["ops@example.com"];
    this.now = opts.now ?? (() => new Date());
  }

  appliesTo(event: NotificationEvent): boolean {
    if (this.allowlist.length === 0) return true;
    return this.allowlist.includes(event.event_type);
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    const to = this.recipients[0];
    this.logger.info(
      {
        channel: "email",
        to,
        event_id: event.event_id,
        event_type: event.event_type,
        subject: event.subject_id,
      },
      "[stub] email send",
    );
    return {
      channel: this.name,
      event_id: event.event_id,
      status: "delivered",
      attempts: 1,
      ...(to ? { target: to } : {}),
      completed_at: this.now().toISOString(),
    };
  }
}
