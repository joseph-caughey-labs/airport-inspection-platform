# ADR 0010: Audit immutability via DB-level grant revocation + hash chain

- **Status**: Accepted
- **Date**: 2026-05-27
- **Owner**: 07 — Database Engineer
- **Reviewers**: 12 — Validation Engineer, 09 — Security Engineer, 01 — Principal Architect

## Context

The validation pipeline (ADR 0008) treats Layer 9 — Audit Trail & Evidence Logging — as a non-negotiable gate. The audit log must:

- Capture every material decision in the system (intake, classification, validation results, reviewer actions, certifications).
- Be **tamper-evident** even to privileged operators with write access to the database.
- Be safe to expose to regulators and post-incident analysis.

Two threat models matter:

1. **Accidental mutation** — application bugs (an UPDATE in the wrong service, a misrouted migration) silently rewriting history.
2. **Adversarial mutation** — a privileged actor (or a compromised credential) deliberately editing the log.

Defense should be layered: an attacker should have to defeat both layers to compromise auditability.

## Decision

`audit_events` is enforced as append-only with **two defenses**:

1. **DB-level grant revocation**. The role used by application services has `UPDATE`, `DELETE`, and `TRUNCATE` revoked on `audit_events` at migration time. Application bugs cannot rewrite rows even if they try; the DB rejects the operation.
2. **Hash-chained rows**. Each entry stores `prev_hash` (the previous row's `entry_hash`) and `entry_hash` (sha256 over the canonical JSON of this row minus `entry_hash`). Tampering with a row breaks the chain at that row; subsequent rows expose it.

A separate privileged role (out of scope for the demo) can be created for legal-hold or forensic procedures — its use is itself logged.

## Alternatives considered

- **Application-only append-only discipline**. Rejected: a single bug (an UPDATE in a future PR) silently rewrites history. Discipline alone is not a control.
- **Hash chain alone, no grant revocation**. Rejected: weakens the first defense. The chain makes tampering _detectable_ but does not _prevent_ an UPDATE from succeeding and creating confusion. Pair them.
- **Database trigger that refuses UPDATE/DELETE**. Viable, but `REVOKE` is the more direct expression of intent and visible in `\dp` inspection without reading trigger source.
- **Logical replication to a read-only replica**. Out of scope for the demo; valuable in production as a third defense.

## Trade-offs

- **Lost**: convenience. Migrations cannot retroactively add columns to `audit_events` with `UPDATE` against the app role — they need to run as a more privileged role (e.g., the role that owns the table, which today is the same as the app role; a future ticket can split them).
- **Kept**: tamper-evident lineage; defense in depth; behavior visible at the role-and-grant level (no hidden trigger logic).

## Consequences

- `0001_initial.sql` runs `REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM <current_user>`. The migration runner records the migration's sha256, so the revocation cannot be silently re-added by editing the file.
- Every audit-emitting service writes via INSERT only — there is no "edit" code path.
- The application enforces `prev_hash`/`entry_hash` calculation in `audit-service` (T-412); the schema enforces the columns are present and non-null where required.
- Querying audit lineage is unaffected — `SELECT` remains granted.
- A future ADR will cover splitting roles: owner role for migrations, app role for runtime, forensic role for break-glass.

## Production evolution path

- **Split DB roles**: owner (for migrations and schema-evolution), app (runtime, INSERT-only on audit), forensic (break-glass, audited via its own log channel).
- **Verify the chain on a schedule**: a cron job recomputes `entry_hash` for every row in batches and alerts on mismatches.
- **Replicate to a read-only audit replica** as a third defense — production-scale.
- **Store the chain tip in a separate system** (e.g., a blockchain-style or signed-receipt service) so an attacker who compromises the database alone cannot also rewrite the tip.
- **Encrypt sensitive payload fields at rest** with a key managed by a KMS — separates "who has DB access" from "who can read audit content".
