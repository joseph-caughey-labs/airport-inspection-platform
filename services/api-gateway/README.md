# `api-gateway`

Public REST entry point for the platform. Lands the foundational shell pieces every public route depends on:

- **Request-id** generated per request, propagated through `@aip/logger`'s `AsyncLocalStorage`, surfaced in the response as `x-request-id`.
- **Auth decode stub** — parses the optional `Authorization: Bearer <token>` header and attaches a decoded `auth` object (user id + role) to the request. **Does not yet enforce** — full JWT validation + RBAC lands in T-504.
- **Canonical error envelope** — every error response uses `ErrorResponse` from `@aip/shared-contracts` with a typed `code` and no stack-trace leakage.
- **`/metrics`** — Prometheus exposition powered by `@aip/metrics` with standard RED counters.
- **Rate-limit hook placeholder** — currently a no-op; real token-bucket lands in T-505.

A single example route (`/api/v1/ping`) lives in this PR to prove the shell works. Domain routes (incidents, sensors, etc.) attach in their respective tickets.

## Endpoints

| Method | Path           | Purpose                                                           |
| ------ | -------------- | ----------------------------------------------------------------- |
| GET    | `/health`      | Liveness — always 200.                                            |
| GET    | `/ready`       | Readiness — always 200 (api-gateway has no DB dependency itself). |
| GET    | `/metrics`     | Prometheus exposition.                                            |
| GET    | `/api/v1/ping` | `{ pong: true, time, request_id, auth? }` — proves the shell.     |

## Configuration

| Var         | Default | Purpose       |
| ----------- | ------- | ------------- |
| `PORT`      | `3001`  | Listen port.  |
| `LOG_LEVEL` | `info`  | Logger level. |

## Auth stub

```
Authorization: Bearer <user_id>.<role>
```

The stub splits on `.` and attaches `{ userId, role }` to `req.auth`. Tokens missing or malformed produce `req.auth = undefined`. This intentionally does **not** verify signatures or expiration — that's T-504. Any production-relevant decision must wait for T-504; this stub is for shape-only wiring.

## Error envelope

Every error response is:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "human-readable",
    "correlation_id": "uuid"
  }
}
```

Codes come from `@aip/shared-contracts/errors`. Stack traces are never included.
