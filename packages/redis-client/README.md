# `@aip/redis-client`

Redis client wrapper for every Node/TS service in the platform. Built on [ioredis](https://github.com/redis/ioredis), with three additions:

1. **`createRedis(...)`** — `Redis` factory with exponential-backoff reconnect, capped retries, and capped connection-open timeout.
2. **`buildChannelName(domain, entity, action)`** — enforces the platform's `<domain>.<entity>.<action>` channel-naming convention.
3. **`checkHealth(redis)`** — readiness probe returning `{ healthy, latency_ms }`. Use in service `/health` endpoints.

## Usage

```ts
import { buildChannelName, checkHealth, createRedis } from "@aip/redis-client";

const redis = createRedis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
});

const channel = buildChannelName("sensor", "frame", "captured");
// → "sensor.frame.captured"

await redis.publish(channel, JSON.stringify(event));

const health = await checkHealth(redis);
// { healthy: true, latency_ms: 2 }
```

For pub/sub, ioredis requires a **separate connection** for subscribing — open a second client:

```ts
const subscriber = createRedis({ host, port });
await subscriber.subscribe(buildChannelName("sensor", "frame", "*"));
subscriber.on("message", (channel, message) => {
  /* ... */
});
```

## Channel naming

All channels follow `<domain>.<entity>.<action>` with lowercase letters, digits, and `_`. Validated by `buildChannelName`. Examples:

| Channel                      | Meaning                                     |
| ---------------------------- | ------------------------------------------- |
| `sensor.frame.captured`      | A sensor frame was published.               |
| `ai.detection.emitted`       | The AI service published a detection event. |
| `incident.lifecycle.updated` | An incident transitioned state.             |
| `audit.event.recorded`       | A new audit event landed.                   |

Invalid names throw — fail-fast at startup rather than silently mistyping a channel.

## Reconnect

`createRedis` configures ioredis with an exponential-backoff retry strategy: 100ms → 200ms → 400ms → … capped at 5s. After 20 attempts the client gives up and emits `end`; supervising services should treat that as a fatal condition.

## Health probe

`checkHealth` sends a `PING` and measures round-trip latency. Sanitizes errors (no stack traces) so they're safe to expose on `/health`.
