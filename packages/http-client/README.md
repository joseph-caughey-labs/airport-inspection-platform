# `@aip/http-client`

Service-to-service HTTP client for the platform. Wraps Node's native `fetch` with:

- **Per-request timeouts** via `AbortController`.
- **Exponential-backoff retries** on retryable failures (network errors, `408`, `429`, `5xx`).
- **`CircuitBreaker`** as a separate primitive — wrap any call (HTTP or otherwise) for failure isolation.
- **Sanitized errors** — `HttpClientError` carries a code + message; never a stack trace.

## Usage

```ts
import { CircuitBreaker, createHttpClient, isRetryableStatus } from "@aip/http-client";

const client = createHttpClient({
  baseUrl: "http://incident-service",
  timeoutMs: 5_000,
  retries: 3,
  retryBackoffMs: 100,
});

// GET — returns Response on success; throws HttpClientError on failure.
const res = await client.request("GET", "/incidents/abc");
const incident = await res.json();

// POST with JSON body
await client.request("POST", "/incidents", {
  body: { runway: "09L", severity: "high" },
  headers: { "x-correlation-id": correlationId },
});

// Standalone circuit breaker — failure-isolate any operation
const cb = new CircuitBreaker({
  name: "incident-service",
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});
const fresh = await cb.execute(() => client.request("GET", "/incidents/abc"));
```

## Retry classification

| Outcome                              | Retryable |
| ------------------------------------ | --------- |
| Network error (DNS, ECONNREFUSED, …) | **Yes**   |
| Timeout (AbortError)                 | **Yes**   |
| `408 Request Timeout`                | **Yes**   |
| `429 Too Many Requests`              | **Yes**   |
| `5xx` server errors                  | **Yes**   |
| `4xx` (other than 408/429)           | No        |
| `2xx`/`3xx`                          | Success   |

Backoff: `min(retryBackoffMs * 2^attempt * jitter(0.5–1.5), retryMaxBackoffMs)`.

## Circuit breaker

Three states:

- **closed** — requests pass through; track consecutive failures.
- **open** — requests rejected immediately with `circuit_open`. After `resetTimeoutMs`, transitions to half-open.
- **half-open** — exactly one probe request allowed. Success → closed. Failure → open.

Use a CB per **downstream dependency**, named for that dependency. Avoid one global CB.

## Errors

`HttpClientError` carries a `code`:

| Code            | When                                                  |
| --------------- | ----------------------------------------------------- |
| `timeout`       | Per-request timeout exceeded.                         |
| `network`       | Underlying fetch threw (DNS, refused, etc.).          |
| `http_<status>` | Non-retryable HTTP status returned (e.g. `http_400`). |
| `exhausted`     | Retries exhausted on a retryable failure.             |
| `circuit_open`  | Circuit breaker rejected without attempting.          |

Never includes a stack trace.
