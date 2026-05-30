# Structured logging conventions

How every TS service in this monorepo logs, why it logs that way, and what an operator on shift can expect to see in the output.

## What every log line carries

The canonical line shape is whatever `@aip/logger` (pino under the hood) emits — a JSON object with at minimum:

| Field            | Source                                                             |
| ---------------- | ------------------------------------------------------------------ |
| `level`          | pino's numeric level (10 trace … 60 fatal)                         |
| `time`           | ISO-8601 UTC                                                       |
| `service`        | the `service` value passed into `createLogger({ service })`        |
| `request_id`     | `@aip/logger` AsyncLocalStorage context, merged via pino `mixin()` |
| `correlation_id` | same                                                               |
| `msg`            | the human-readable string                                          |

…plus whatever object the caller passed to `logger.info(obj, msg)`. `service` is set per-process at boot; `request_id` + `correlation_id` are set per-request by the `correlationHook` middleware.

## Request lifecycle — how the ids get attached

1. The Fastify `onRequest` hook `correlationHook()` (from `@aip/logger/fastify-plugin`) runs first on every request.
2. It reads `x-request-id` and `x-correlation-id` from the inbound headers. If a caller already supplied either, that value wins. If absent, the hook generates a UUIDv4.
3. The hook calls `enterContext({ request_id, correlation_id })`, which stores the pair in `AsyncLocalStorage`. The rest of the request handlers in the same async chain see it via `getContext()`.
4. The hook also echoes both ids on the response headers so the next hop in the chain receives them too.
5. Every `logger.info` / `logger.error` etc. emitted while the request is in flight picks up `request_id` + `correlation_id` automatically via pino's `mixin` — handlers never thread the ids manually.

The Fastify-side wiring is identical in every service:

```ts
import { correlationHook } from "@aip/logger";

const app = Fastify({ logger: { level: logger.level } });
app.addHook("onRequest", correlationHook());
```

Use `addHook("onRequest", correlationHook())` directly (not `app.register(plugin)`) — Fastify's `register` creates an encapsulated scope and the hook would only apply to routes registered inside it.

## Correlation id propagation across services

A single logical operation (e.g. acknowledge → publish → audit-service persist → notification-service fanout) shares one `correlation_id` across every service it touches.

- HTTP boundaries: services that make outbound HTTP calls SHOULD forward `req.correlation_id` as the `x-correlation-id` header. The receiving service's `correlationHook` picks it up.
- Redis pub/sub boundaries: the event envelope's `correlation_id` field carries it. Subscribers extract that field and enter a context for the message-handler async chain.

When a service generates a new operation that isn't downstream of a request (a cron job, a background worker, an outbox sweep), it creates a fresh correlation id at the start of the operation and uses `withContext(...)` around the inner async function.

## Redaction

`@aip/logger` ships with a default redaction allowlist in `packages/logger/src/redaction.ts`. Anything matching the path patterns is replaced with `[REDACTED]` before the line hits stdout. The defaults cover the obvious credential fields (`password`, `token`, `authorization`, etc.) and standard auth-header locations (`req.headers.authorization`).

When a service handles a new sensitive field, extend the allowlist on the local `createLogger` call:

```ts
import { createLogger, DEFAULT_REDACTION_PATHS } from "@aip/logger";

const logger = createLogger({
  service: "incident-service",
  redact: [...DEFAULT_REDACTION_PATHS, "payload.operator_pii.ssn"],
});
```

## `no-console` lint rule

`console.log` is unstructured and bypasses the logger's context propagation + redaction. The ESLint root config bans `console.log` / `info` / `warn` / `debug` everywhere with `no-console: ['error', { allow: ['error'] }]`. The only exception:

- `packages/db-schema/src/cli/**` — `db:migrate` and `db:seed` are operator-facing CLI tools where structured logs would be worse UX than plain terminal output.

`console.error` stays allowed because the catch-all at the bottom of every `main.ts` (`main().catch((err) => { console.error(...); process.exit(1); })`) runs before any logger is up and we need _some_ output if logger creation itself throws.

## Test seam

`createLogger({ destination })` accepts a `pino.DestinationStream` override. Unit tests pass an in-memory stream to capture lines without writing to stdout:

```ts
import { Writable } from "node:stream";
import { createLogger } from "@aip/logger";

const lines: string[] = [];
const destination = new Writable({
  write(chunk, _enc, cb) {
    lines.push(chunk.toString());
    cb();
  },
});
const logger = createLogger({ service: "test", destination });
```

## Production evolution

The current pino writes JSON lines to stdout, which is what Docker / Kubernetes / Heroku-style platforms expect. A real production deployment would:

- Ship logs to a centralized aggregator (Loki / Datadog / Cloudwatch) via a sidecar tailing stdout.
- Add a sampling policy on info-level lines if log volume becomes a cost concern.
- Promote `correlation_id` into a distributed trace id (OpenTelemetry W3C `traceparent`) so the same id can join request logs with downstream service traces in a single APM dashboard.
- Add structured PII / GDPR redaction guarded by a separate `sensitive_redact` allowlist auditable independently from the operational allowlist.

The interfaces in `@aip/logger` don't change for any of those — they all swap the destination + extend the redaction list.
