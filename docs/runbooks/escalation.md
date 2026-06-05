# Runbook — Escalation

**Use when:** an inspection incident needs to move up the operator → reviewer → admin chain, a HITL decision is required, or the **platform itself** is degraded and a human needs paging.

There are two escalation paths — pick the one that matches:

- [Incident escalation](#incident-escalation-operational) — a detected hazard needs review/override.
- [Platform escalation](#platform-escalation-the-system-is-degraded) — the stack is unhealthy and you've exhausted the recovery runbook.

## Incident escalation (operational)

The incident lifecycle and who may drive each transition (deny-by-default RBAC — see [operations/auth.md](../operations/auth.md) and the policy matrix in `@aip/shared-contracts`):

| Transition                                                 | Permission         | operator | reviewer | admin |
| ---------------------------------------------------------- | ------------------ | :------: | :------: | :---: |
| acknowledge / assign / start_progress / resolve / escalate | `incident.*`       |    ✓     |    ✓     |   ✓   |
| **archive**                                                | `incident.archive` |    —     |    ✓     |   ✓   |
| **reject**                                                 | `incident.reject`  |    —     |    ✓     |   ✓   |

**The escalation decision tree:**

### → An operator hits something they can't resolve or shouldn't close alone

(ambiguous detection, safety-critical FOD, a call that needs a second set of eyes)

```bash
# Escalate the incident — routes it to the reviewer HITL queue.
curl -s -X POST localhost:3000/api/v1/incidents/<id>/escalate \
  -H "Authorization: Bearer <operator-token>" \
  -H 'content-type: application/json' \
  -d '{"operator_id":"<id>","reason":"<why this needs review>"}'
```

The `reason` is mandatory context — it's denormalized onto the incident and captured on the audit chain. The incident now appears in the reviewer's queue.

### → A reviewer adjudicates

- **Confirmed hazard, action taken** → `acknowledge` / `assign` / `resolve` as appropriate.
- **False positive / not actionable** → `reject` (reviewer-only) with a `reason`.
- **Done and filed** → `archive` (reviewer-only).

Every transition emits an audit event hash-chained alongside the incident history — overrides are _extra-rich_ records, so a rejection or override is always attributable. Verify it landed:

```bash
curl -s localhost:3000/api/v1/incidents/<id> \
  -H "Authorization: Bearer <token>" | jq '{status,assigned_to}'
# Full lineage for the incident from the audit chain:
curl -s "localhost:3000/api/v1/audit/lineage/<id>" \
  -H "Authorization: Bearer <reviewer-token>" | jq '.events | length'
```

### → A transition returns an error

| Code                     | Meaning                                                                 | Action                                                            |
| ------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `403 forbidden`          | Role lacks the permission (e.g. operator trying to `archive`)           | Hand off to a reviewer/admin                                      |
| `409 illegal_transition` | Wrong current state for that command                                    | Re-read the incident's `status`; pick the valid next transition   |
| `410 terminal_state`     | Already archived/rejected                                               | Nothing to do — it's closed                                       |
| `5xx` on transition      | Event publish failed (incident-service throws on Redis publish failure) | Fix Redis ([recovery.md › Redis](recovery.md#-redis)), then retry |

## Platform escalation (the system is degraded)

When the stack — not an inspection — is the problem.

### → Page when any of these are true

- A core datastore (Postgres/Redis) is down and **does not recover** after [recovery.md](recovery.md).
- `POST /audit/verify` returns `verified: false` (possible audit tampering or a lost write) — **always page**, capture the `broken_at` id.
- `event_outbox` unpublished backlog is **growing unbounded** and a poison row keeps failing after [replay.md](replay.md).
- Multiple services crash-loop after a clean dependency recovery.

### → Before you page, capture state (so the responder doesn't start cold)

```bash
docker compose ps > /tmp/aip-incident.txt
for s in api-gateway sensor-gateway event-pipeline ws-broadcaster \
         incident-service audit-service notification-service; do
  echo "== $s ==" >> /tmp/aip-incident.txt
  docker compose logs --tail=100 $s >> /tmp/aip-incident.txt 2>&1
done
curl -s -X POST localhost:3007/audit/verify -H "Authorization: Bearer <reviewer-token>" >> /tmp/aip-incident.txt
docker compose exec -T postgres psql -U airport_ops -d airport_inspection \
  -c "SELECT count(*) FROM event_outbox WHERE published_at IS NULL;" >> /tmp/aip-incident.txt
```

Attach `/tmp/aip-incident.txt` and the **correlation id** of a failing request (every log line + audit row carries `correlation_id`; see [FAILURE_MODE_MATRIX.md › Correlation IDs](../FAILURE_MODE_MATRIX.md#cross-cutting)) so the responder can trace the failure across services.

### → Severity guide

| Severity  | Looks like                                            | Response                                                      |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| **SEV-1** | Audit chain broken, or data loss confirmed            | Page immediately; preserve volumes (do **not** `down -v`)     |
| **SEV-2** | A datastore down, ingestion stopped, no data loss yet | Work [recovery.md](recovery.md); page if not back in your SLO |
| **SEV-3** | One non-critical service degraded, rest serving       | Restart per [recovery.md](recovery.md); file an issue         |
