# NGINX reverse proxy

Single entry point at `http://localhost:3000` (host port) → port 80 inside the container. Fans out by path:

| Path               | Upstream              | Notes                                                                                      |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| `/health`          | _(nginx itself)_      | 200 ok — used by Compose healthcheck.                                                      |
| `/api/...`         | `api-gateway:3001`    | REST. Keepalive pooled.                                                                    |
| `/ws/...`          | `ws-broadcaster:3005` | WebSocket upgrade. `Connection: $connection_upgrade`, 1h read/send timeout, buffering off. |
| `/...` (catch-all) | `web:3000`            | Nuxt SSR app.                                                                              |

## Upstreams

Upstream hostnames resolve via Docker's embedded DNS (`resolver 127.0.0.11`) so a service restart (different container IP) does not pin NGINX to a stale address.

## Security headers

Baseline `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), camera=(), microphone=()`. **CSP is intentionally not set here** — it lands in T-505 alongside the real auth flow and the inline-script audit the frontend will need.

## Healthcheck

`curl -fsS http://localhost/health` returns 200. NGINX is configured with `depends_on: condition: service_healthy` on `web`, `api-gateway`, and `ws-broadcaster`, so Compose waits for all three before bringing NGINX up.

## Local verification

```bash
# Bring the stack up:
docker compose up -d

# Hit nginx directly:
curl http://localhost:3000/health             # 200 ok
curl http://localhost:3000/api/v1/ping        # api-gateway response
curl http://localhost:3000/                   # frontend HTML

# WebSocket round-trip via wscat (npm i -g wscat):
wscat -c ws://localhost:3000/ws/v1/ping
# > hello
# < pong:hello
```

## What's not here yet

- TLS termination (T-505 — runs behind a separate edge for the demo).
- Rate limiting at the proxy tier (`api-gateway` carries the application-tier rate limit in T-505).
- Per-host routing (single-tenant demo; multi-airport stays inside the apps).
