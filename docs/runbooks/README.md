# Runbooks

Operational procedures for running the Airport Inspection Platform. Each runbook is **decision-tree shaped** — start at the top, follow the branch that matches what you're seeing, and stop when the symptom clears. They assume the single-host `docker-compose` deployment; the shapes carry over to a real orchestrator.

| Runbook                                  | Use it when                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [startup.md](startup.md)                 | Bringing the stack up from cold, or a service won't become ready                            |
| [recovery.md](recovery.md)               | A dependency (Redis / Postgres) or a service is down and you need it back                   |
| [replay.md](replay.md)                   | Events were accepted but didn't reach the dashboard / audit chain — drain the backlog       |
| [escalation.md](escalation.md)           | An incident needs to move up the operator → reviewer → admin chain, or a human needs paging |
| [troubleshooting.md](troubleshooting.md) | Symptom-indexed entry point — "X is broken, where do I start?"                              |

## The two things every runbook leans on

**Health vs. readiness** — every service exposes both:

```bash
curl -s localhost:3000/health     # liveness: 200 if the process is up
curl -s localhost:<port>/ready    # readiness: 503 if a dependency it needs is down
```

`/health` answers as long as the process lives; `/ready` is the one that tells you whether dependencies are wired. See [FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) for what each service's `/ready` checks.

**The port map** (host-published by `docker-compose.yml`):

| Port | Service                 |     | Port | Service              |
| ---- | ----------------------- | --- | ---- | -------------------- |
| 3000 | nginx (edge: REST + WS) |     | 3005 | ws-broadcaster       |
| 3001 | api-gateway             |     | 3006 | incident-service     |
| 3002 | reference-data          |     | 3007 | audit-service        |
| 3003 | sensor-gateway          |     | 3008 | notification-service |
| 3004 | event-pipeline          |     | 6379 | redis                |
| 8000 | ai-inference            |     | 5432 | postgres             |

Containers are named `aip-<service>` (e.g. `aip-event-pipeline`). Quick triage one-liner:

```bash
docker compose ps                                   # who's up
for p in 3001 3003 3004 3005 3006 3007 3008; do
  printf "%s " $p; curl -s -o /dev/null -w "%{http_code}\n" localhost:$p/ready; done
```

## Conventions

- **Commands are copy-pasteable** and run from the repo root unless noted.
- **Verification ends every branch** — you should always finish by confirming the symptom cleared, not by assuming it did.
- **Cross-links** point at [FAILURE_MODE_MATRIX.md](../FAILURE_MODE_MATRIX.md) (what fails and why), [operations/metrics.md](../operations/metrics.md) (what to watch), and [operations/auth.md](../operations/auth.md) (auth surface).
- These were dry-read by someone who didn't write them; if a step is ambiguous, that's a bug — open an issue.
