# ADR 0007: Edge / cloud separation

- **Status**: Accepted
- **Date**: 2026-06-05
- **Owner**: Principal Architect
- **Reviewers**: DevOps & Platform Engineer, AI/ML Engineer

## Context

A real airport inspection system is physically split. Sensors and inference run **at the edge** — on-airport hardware near the cameras/LiDAR — because you cannot ship raw high-bandwidth sensor streams to a cloud region on every frame (bandwidth, latency, and the need to keep detecting when the WAN link flaps). Aggregation, persistence, incident lifecycle, audit, and the operator dashboard run in the **cloud**, where you want durability, cross-site rollups, and a single pane of glass.

The demo runs every service in one `docker-compose` network on one host, so there's no literal edge/cloud split. The question this ADR settles is whether the architecture should nonetheless be _drawn_ along that boundary — service responsibilities and the seam between them chosen as if they were going to be deployed apart — or whether to ignore a distinction that doesn't physically exist in the demo.

## Decision

Draw the boundary now, in the service topology and the transport seam, even though the demo collocates everything.

- **Edge tier (sensor-proximate):** `sensor-gateway` (sensor simulation / frame capture) and `ai-inference` (detection). These are the components that, in production, run on airport-local hardware and must keep functioning during a cloud-link outage.
- **Cloud tier:** `event-pipeline`, `incident-service`, `audit-service`, `validation-engine`, `notification-service`, `reference-data`, `ws-broadcaster`, `api-gateway`, and the `web` dashboard — aggregation, persistence, lifecycle, and operator surface.
- **The seam is Redis pub/sub.** Edge publishes `sensor.frame.captured` and `ai.detection.<class>.emitted`; cloud consumes. The channel taxonomy ([ADR 0001](0001-redis-pubsub-vs-kafka.md)) — `<domain>.<entity>.<action>` — is the contract across the boundary. Nothing in the cloud tier imports edge code; nothing in the edge tier knows what the cloud does with a frame. The coupling is the wire format, full stop.

This makes the boundary real where it matters (responsibilities + dependency direction) without paying for a distributed deployment the demo doesn't need.

## Alternatives considered

- **No edge/cloud distinction — just "services":** rejected — it would let cloud concerns (DB access, incident logic) leak into the sensor/inference components, so the topology could never be split later without surgery. The discipline only holds if it's drawn up front.
- **Physically split the demo (separate networks / hosts / a real edge box):** rejected — large operational cost for a portfolio demo, and it would obscure the walkthrough behind networking setup. The boundary is architectural intent, not a deployment the demo ships.
- **Run inference in the cloud, stream raw frames up:** rejected as the _production_ model — it's the thing edge inference exists to avoid (bandwidth + latency + survive-the-WAN). Simulating it would teach the wrong shape.

## Trade-offs

- **Lost**: an actual demonstration of edge resilience — in the demo, "edge" and "cloud" share a host and a Redis, so a real WAN partition between them isn't shown (the closest proxy is the Redis-outage resilience scenario).
- **Lost**: store-and-forward at the edge — today an edge publish to a down Redis is just a failed publish; a real edge box would buffer locally and forward on reconnect.
- **Kept**: a topology that _can_ be split — clean dependency direction (cloud depends on edge events, never the reverse), a single well-defined seam, and inference already isolated as its own (Python) process per [ADR 0004](0004-ai-inference-simulation.md).

## Consequences

- The pub/sub seam is now a load-bearing contract, not an implementation detail — changing a channel name or envelope is a cross-boundary breaking change.
- Edge components must not gain cloud dependencies (no DB handles in sensor-gateway/ai-inference); a PR that adds one is violating this ADR.
- AI-outage failure isolation ([FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) mode 2, [load scenario 06](../../__TEST__/load/scenarios/06-ai-timeout.scenario.ts)) is a direct consequence: because inference is edge-side and off the cloud hot path, its outage can't stall cloud ingestion.

## Production evolution path

Each airport gets an **edge deployment** — sensor-gateway + an inference box (real GPU) — colocated with the sensors, plus a **regional cloud** running the rest. The Redis seam becomes a WAN-spanning, durable bridge: an MQTT/Kafka edge broker with **store-and-forward** so the edge keeps detecting and buffers during a cloud-link outage, replaying on reconnect (the durability the demo's outbox hints at, pushed to the edge). The cloud tier scales horizontally and aggregates across airports. Because the boundary and the channel contract already exist, this is a deployment-topology change, not an application rewrite.
