# `@aip/logger`

Structured logging for every Node/TS service in the platform. Built on [pino](https://getpino.io), with two additions on top:

- **Async context propagation** via `AsyncLocalStorage` — `request_id` and `correlation_id` automatically appear on every log line within a request scope, no manual threading.
- **Safe-by-default redaction** — common sensitive paths (`password`, `token`, `authorization`, etc.) are redacted to `[REDACTED]` before serialization.

## Usage

```ts
import { createLogger, withContext } from "@aip/logger";

const log = createLogger({ service: "sensor-gateway" });

// Normal logging:
log.info({ sensor_id: "CAM-N-03" }, "frame captured");

// Threaded with request + correlation ids:
withContext({ correlation_id: incomingRequest.correlation_id }, () => {
  log.info("processing"); // includes correlation_id automatically
  doMoreWork(); // anything called inside sees the same context
});
```

Output (truncated):

```json
{
  "level": 30,
  "time": "2026-05-27T17:00:00.000Z",
  "service": "sensor-gateway",
  "request_id": "…",
  "correlation_id": "…",
  "msg": "frame captured",
  "sensor_id": "CAM-N-03"
}
```

## Pattern

- Each service creates **one** logger at startup via `createLogger({ service })`.
- HTTP / Redis consumer / scheduler entrypoints wrap the work in `withContext(...)` to populate request/correlation ids.
- `getContext()` is available for code that needs to access ids directly (e.g. building downstream HTTP headers).
- Child loggers via `log.child({ sensor_id })` are encouraged for per-entity scopes.

## Redaction

The default redaction list is in `src/redaction.ts`. Extend at logger creation time:

```ts
const log = createLogger({
  service: "incident-service",
  redact: [...DEFAULT_REDACTION_PATHS, "req.body.medical_records"],
});
```

Never log full request bodies. Always log the field(s) you need.

## Log levels

Default level is `info`. Override via the `LOG_LEVEL` env var or the `level` option. Allowed values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.
