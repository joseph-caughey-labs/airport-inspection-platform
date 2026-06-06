# Runbook — Troubleshooting

**Use when:** something's wrong and you need the fastest path to the right runbook. This is the symptom index — match what you're seeing, then follow the link.

## Symptom index

| What you observe                           | Most likely                        | Go to                                                                                |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Nothing comes up after `docker compose up` | Dependency healthcheck not passing | [startup.md](startup.md)                                                             |
| One service stuck 503 / restarting         | Dependency or wedged process       | [#a-service-is-unhealthy](#a-service-is-unhealthy-503-or-crash-looping)              |
| Dashboard live feed frozen                 | Redis down, or WS disconnect       | [#the-live-feed-is-frozen](#the-live-feed-is-frozen)                                 |
| Many services 503 at once                  | Shared datastore down              | [recovery.md](recovery.md#a-datastore-is-down)                                       |
| Events accepted but not showing            | Stuck in/behind outbox             | [replay.md](replay.md)                                                               |
| Login / API returns 401                    | Token expired or wrong secret      | [#auth-failures](#auth-failures-401--403)                                            |
| API returns 403                            | Role lacks permission              | [#auth-failures](#auth-failures-401--403)                                            |
| `429 Too Many Requests`                    | Rate limit tripped                 | [#rate-limited-429](#rate-limited-429)                                               |
| Requests are slow / timing out             | DB latency or overload             | [#slow-or-timing-out](#slow-or-timing-out)                                           |
| `POST /audit/verify` → `verified:false`    | Audit integrity broken             | [escalation.md](escalation.md#platform-escalation-the-system-is-degraded) — **page** |

## First move, always

```bash
docker compose ps
for p in 3001 3003 3004 3005 3006 3007 3008; do
  printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/ready; done
```

Then grab the **correlation id** of a failing request — it's in the response headers (`x-correlation-id`) and every related log line + audit row, so you can trace one failure across services:

```bash
docker compose logs --tail=200 <service> | grep <correlation-id>
```

## A service is unhealthy (503 or crash-looping)

```bash
docker compose logs --tail=50 <service>
```

1. **Dependency down?** Check `aip-postgres` / `aip-redis` health → if unhealthy, [recovery.md › Datastore down](recovery.md#a-datastore-is-down).
2. **Dependency healthy, service still 503?** `docker compose restart <service>`; re-check `/ready`.
3. **Still bad?** `docker compose up -d --force-recreate <service>`.
4. **Still bad?** It's not transient — capture logs and [escalate](escalation.md#platform-escalation-the-system-is-degraded).

## The live feed is frozen

```bash
curl -s localhost:6379 >/dev/null 2>&1; docker inspect --format='{{.State.Health.Status}}' aip-redis
curl -s localhost:3005/metrics | grep '^ws_broadcaster_received_total'
```

- **Redis unhealthy** → [recovery.md › Redis](recovery.md#-redis).
- **Redis healthy, `received` flat** → broadcasts not flowing → [replay.md › Dashboard empty](replay.md#events-persisted-but-the-dashboard-is-empty).
- **Redis healthy, `received` climbing** → it's the browser client → operator reloads the page (WsClient reconnects with a resume cursor); check the console for `4401` (→ re-login).

## Auth failures (401 / 403)

| Code                                 | Cause                                        | Fix                                                                                                                                    |
| ------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `401 unauthorized`                   | Missing/expired/forged access token          | Re-login (`POST /api/v1/auth/login`) or refresh; tokens are 15-min TTL                                                                 |
| `401` on a WS connect (`4401` close) | Token not presented or expired on the socket | Client re-auths on reconnect; if persistent, the stack's `JWT_SECRET` may not match what minted the token                              |
| `403 forbidden`                      | Authenticated but role lacks the permission  | Expected for deny-by-default — use an account with the right role (see [escalation.md](escalation.md#incident-escalation-operational)) |

Details: [operations/auth.md](../operations/auth.md). All auth outcomes are on the audit chain (`auth.login.*`, `access.denied`).

## Rate-limited (429)

The api-gateway token-bucket tripped (240/min global per IP; 20/min on auth routes). The `429` carries a `retry-after`. Expected under a burst or a misbehaving client — back off. If it's a load test, that's the system working ([FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) — rate limiting). Tripped events are audited as `rate_limit.blocked`. A Redis flap does **not** cause spurious 429s — the limiter runs `skipOnError` (fails open).

## Slow or timing out

```bash
# Is the DB the bottleneck?
docker compose exec postgres psql -U airport_ops -d airport_inspection -c "SELECT 1;"   # instant?
# Is the consumer shedding under load?
curl -s localhost:3004/metrics | grep -E '^consumer_(dropped|depth)_total'
# p95 request latency on a service:
curl -s localhost:<port>/metrics | grep '^http_request_duration_seconds'
```

- **DB query slow/hanging** → [recovery.md › Postgres](recovery.md#-postgres); queries fail fast at the 30s statement timeout rather than hanging forever.
- **`consumer_dropped_total` climbing** → overload shedding → [replay.md › Backlog growing under load](replay.md#backlog-growing-under-load).
- **Everything fast but a request still slow** → grab its `correlation_id` and trace it across services (top of this page).

## When in doubt

Re-read [FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) — it maps each symptom to its detection signal, recovery, and whether manual intervention is even needed. Many "failures" are designed graceful degradation (shedding, skip-on-error, reconnect) that resolve themselves.
