/**
 * In-app channel — Redis publish back to the operator UI fanout.
 *
 * Why a second Redis publish (when we're already a Redis subscriber)?
 * The `incident.transition.*` channels are the *domain event*
 * surface; `events.broadcast.<airport_id>` is the *operator UI
 * delivery* surface. The notification service translates between
 * them so the UI subscribes to a single channel taxonomy regardless
 * of which domain produced the event.
 */
import type { RedisClient } from "@aip/redis-client";
import type { DeliveryResult, NotificationChannel, NotificationEvent } from "./types.js";

export interface InAppChannelOptions {
  redis: RedisClient;
  channelPrefix?: string;
  /** Pull the airport id off the event payload. Default: looks at
   * `payload.airport_id` (string). When absent, the message goes to
   * `<prefix>.unscoped` so the UI's pattern subscription still
   * catches it. */
  airportIdOf?: (event: NotificationEvent) => string | undefined;
  now?: () => Date;
}

export class InAppChannel implements NotificationChannel {
  readonly name = "in_app";
  private readonly redis: RedisClient;
  private readonly prefix: string;
  private readonly airportIdOf: (event: NotificationEvent) => string | undefined;
  private readonly now: () => Date;

  constructor(opts: InAppChannelOptions) {
    this.redis = opts.redis;
    this.prefix = opts.channelPrefix ?? "events.broadcast";
    this.airportIdOf = opts.airportIdOf ?? defaultAirportIdOf;
    this.now = opts.now ?? (() => new Date());
  }

  appliesTo(_event: NotificationEvent): boolean {
    // Every event is broadcast to the operator UI by default; the
    // UI itself filters by airport/role.
    return true;
  }

  async deliver(event: NotificationEvent): Promise<DeliveryResult> {
    const airportId = this.airportIdOf(event);
    const channel = airportId ? `${this.prefix}.${airportId}` : `${this.prefix}.unscoped`;
    try {
      await this.redis.publish(channel, JSON.stringify(event));
      return {
        channel: this.name,
        event_id: event.event_id,
        status: "delivered",
        attempts: 1,
        target: channel,
        completed_at: this.now().toISOString(),
      };
    } catch (err) {
      return {
        channel: this.name,
        event_id: event.event_id,
        status: "failed",
        attempts: 1,
        error: err instanceof Error ? err.message : String(err),
        completed_at: this.now().toISOString(),
      };
    }
  }
}

function defaultAirportIdOf(event: NotificationEvent): string | undefined {
  const v = event.payload["airport_id"];
  return typeof v === "string" ? v : undefined;
}
