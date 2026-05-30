/**
 * Channel registry: holds every configured `NotificationChannel`
 * and the recent `DeliveryResult` history each one produced.
 *
 * `dispatch(event)` walks every registered channel, asks
 * `appliesTo`, and (when applicable) calls `deliver`. Results are
 * appended to a ring buffer the HTTP `/deliveries` route reads.
 *
 * Concurrency: deliveries fire in parallel per event. A slow
 * webhook can't queue an in-app publish — the operator UI gets the
 * fast channel immediately.
 */
import type { DeliveryResult, NotificationChannel, NotificationEvent } from "./types.js";

export interface ChannelRegistryOptions {
  channels: readonly NotificationChannel[];
  /** Ring-buffer size for recent deliveries on /deliveries. */
  recentLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 200;

export class ChannelRegistry {
  readonly channels: readonly NotificationChannel[];
  private readonly recentLimit: number;
  private readonly recent: DeliveryResult[] = [];

  constructor(opts: ChannelRegistryOptions) {
    this.channels = opts.channels;
    this.recentLimit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
  }

  /** Most-recent first. */
  get recentDeliveries(): readonly DeliveryResult[] {
    return this.recent;
  }

  /** Dispatch one event across every registered channel. */
  async dispatch(event: NotificationEvent): Promise<DeliveryResult[]> {
    const applicable = this.channels.filter((c) => c.appliesTo(event));
    const skipped: DeliveryResult[] = this.channels
      .filter((c) => !c.appliesTo(event))
      .map((c) => ({
        channel: c.name,
        event_id: event.event_id,
        status: "skipped",
        attempts: 0,
        completed_at: new Date().toISOString(),
      }));
    const delivered = await Promise.all(applicable.map((c) => c.deliver(event)));
    const all = [...delivered, ...skipped];
    this.record(all);
    return all;
  }

  /** Status snapshot for `/channels`. */
  status(): { name: string }[] {
    return this.channels.map((c) => ({ name: c.name }));
  }

  private record(results: DeliveryResult[]): void {
    this.recent.unshift(...results);
    if (this.recent.length > this.recentLimit) {
      this.recent.length = this.recentLimit;
    }
  }
}
