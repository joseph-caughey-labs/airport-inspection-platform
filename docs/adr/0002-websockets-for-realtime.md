# ADR 0002: WebSockets for real-time operator updates (over SSE / long-poll / gRPC streaming)

- **Status**: Accepted
- **Date**: 2026-05-27
- **Owner**: 01 — Principal Architect
- **Reviewers**: 02 — Backend, 04 — Frontend, 10 — SRE

## Context

The operator dashboard must reflect telemetry, AI detections, and incident lifecycle changes in real time. Operator UX requirements:

- Sub-second alert delivery.
- Per-airport, per-role channel filtering.
- Reconnect that resumes from the last delivered event (no replays from the beginning).
- Reviewer queue benefits from bidirectional updates (claim / release / presence).

Lifecycle actions (acknowledge / assign / resolve) are user-initiated REST calls and don't need to be bidirectional over the stream.

Options:

- **WebSocket** — bidirectional, low-latency, broad library support.
- **Server-Sent Events (SSE)** — one-way server→client, simpler protocol, reconnect built in.
- **HTTP long-poll** — works through any proxy, but high per-request overhead.
- **gRPC web streaming** — type-safe, but adds a transcoding layer through NGINX and increases browser/library complexity.

## Decision

Use **WebSockets** for all real-time dashboard updates, served by a dedicated `ws-broadcaster` service behind NGINX. Lifecycle actions stay on REST (`api-gateway`).

## Alternatives considered

- **SSE**: enough for operator alerts, but reviewer-queue presence and claim/release benefit from bidirectional channels. Mixing SSE for one role and WS for another means two protocols — not worth it.
- **Long-poll**: per-request overhead and stale connection state make this inferior to WS at this scale.
- **gRPC web streaming**: type safety is nice but transcoding through NGINX is operationally heavy for a demo.

## Trade-offs

- **Lost**: simpler protocol (SSE); simpler proxy/firewall semantics (long-poll).
- **Kept**: bidirectional channel for presence; sub-second latency; explicit reconnect protocol.
- **Added complexity**: stateful connections (presence, reconnect, backpressure) live in `ws-broadcaster` rather than being avoided.

## Consequences

- Dedicated `ws-broadcaster` service isolates stateful connections from REST.
- Per-airport channels (`/ws/v1/airport/:id/events`) with role-based message filtering.
- Reconnect protocol: client sends `last_event_id` on resume; broadcaster backfills missed events from Redis stream + Postgres.
- Backpressure: per-connection queue depth limit; surface "stale" indicator to the client when slow.
- Auth on WS connection establishment (T-504); per-channel role check enforced server-side.
- NGINX needs explicit `Upgrade` / `Connection` header rules (T-117).

## Production evolution path

- Keep WebSockets as the primary transport.
- For multi-instance scale: sticky routing (HAProxy or service-mesh affinity) so a client returns to the same broadcaster on reconnect.
- Move presence + last-event-id state to a shared store (Redis sorted sets) so any broadcaster instance can serve any client.
- Add WS message compression (`permessage-deflate`) for high-frequency channels.
- Consider mTLS between NGINX and `ws-broadcaster` once the platform spans security zones.
