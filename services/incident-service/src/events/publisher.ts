import { type Logger } from "@aip/logger";
import { type RedisClient } from "@aip/redis-client";
import { Counter, type Registry } from "prom-client";
import { channelFor, type IncidentTransitionedEvent } from "../domain/index.js";

/**
 * Publishes incident domain events to Redis on the
 * `incident.transition.<next_state>` channel.
 *
 * Two consumers will subscribe (in later tickets):
 *   - audit-service (T-412) — hash-chained append-only audit log
 *   - notification-service (T-413) — operator + webhook + email
 *
 * Split as an interface so route tests can drop in a fake recorder
 * without needing a real Redis. The production path keeps the call
 * site trivial — `await events.emit(event)`.
 */
export interface IncidentEventPublisher {
  emit(event: IncidentTransitionedEvent): Promise<void>;
}

export interface RedisIncidentEventPublisherOptions {
  redis: RedisClient;
  logger: Logger;
  registry: Registry;
}

/** Production publisher wired to the workspace Redis client. */
export class RedisIncidentEventPublisher implements IncidentEventPublisher {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly metrics: {
    published: Counter<"next_state">;
    failures: Counter<"next_state">;
  };

  constructor(opts: RedisIncidentEventPublisherOptions) {
    this.redis = opts.redis;
    this.logger = opts.logger;
    this.metrics = {
      published: new Counter({
        name: "incident_events_published_total",
        help: "Incident transition events published on Redis.",
        labelNames: ["next_state"] as const,
        registers: [opts.registry],
      }),
      failures: new Counter({
        name: "incident_events_publish_failures_total",
        help: "Incident transition publish failures.",
        labelNames: ["next_state"] as const,
        registers: [opts.registry],
      }),
    };
  }

  async emit(event: IncidentTransitionedEvent): Promise<void> {
    const channel = channelFor(event.transition);
    try {
      await this.redis.publish(channel, JSON.stringify(event));
      this.metrics.published.labels(event.transition.to).inc();
    } catch (err) {
      this.metrics.failures.labels(event.transition.to).inc();
      this.logger.error(
        {
          channel,
          incident_id: event.incident_id,
          err: err instanceof Error ? err.message : String(err),
        },
        "incident event publish failed",
      );
      throw err;
    }
  }
}

/**
 * In-memory publisher for unit tests. Records every emitted event
 * in `published` so tests can assert without parsing log lines.
 */
export class RecordingIncidentEventPublisher implements IncidentEventPublisher {
  readonly published: IncidentTransitionedEvent[] = [];

  async emit(event: IncidentTransitionedEvent): Promise<void> {
    this.published.push(event);
  }
}
