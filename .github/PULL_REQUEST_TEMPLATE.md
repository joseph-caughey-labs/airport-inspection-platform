<!--
Title format: <type>(<scope>): <concise summary>
Examples:
  feat(sensor-gateway): add LiDAR simulator with packet-loss fault injection
  fix(ws-broadcaster): handle reconnect during burst fanout
  docs(adr): add ADR 0008 — validation engine design
Pick from: feat | fix | docs | test | refactor | perf | chore | ci | style | revert
-->

## Problem statement

<!-- What problem does this PR solve? Link to issue if applicable: Refs #N -->

## Proposed change

<!-- One paragraph summarizing the change. The "what" goes here; the "why" goes in Architectural reasoning. -->

## Architectural reasoning

<!-- Why this approach? What alternatives were considered and rejected? If this is a non-trivial decision, link or include an ADR. -->

## Validation layers touched

<!--
Which of the 10 Parity validation layers does this affect?
- [ ] Layer 1 — Input Validation
- [ ] Layer 2 — Schema & Contract Validation
- [ ] Layer 3 — Business Rule Validation
- [ ] Layer 4 — Source-of-Truth Validation
- [ ] Layer 5 — Cross-System Consistency Validation
- [ ] Layer 6 — AI Output Validation
- [ ] Layer 7 — Risk & Exception Scoring
- [ ] Layer 8 — Human-in-the-Loop Review
- [ ] Layer 9 — Audit Trail & Evidence Logging
- [ ] Layer 10 — Final Output Certification
- [ ] None — no validation impact
-->

## Risk and rollback plan

<!-- New risks introduced? Mitigations applied? Residual risk accepted? How do we revert if this breaks production/demo? -->

## Test evidence summary

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] E2E tests added/updated (if applicable)
- [ ] Manual verification — describe what you ran:

<!-- e.g. "Started compose stack, triggered FOD scenario, verified incident reaches dashboard within 2s and audit entry written." -->

## Documentation impact

- [ ] ADR added/updated
- [ ] Runbook added/updated
- [ ] README / interview README updated
- [ ] Domain glossary updated
- [ ] None

## Follow-up actions

<!-- TODOs, separate PRs, known limitations. -->

---

### Checklist (open at the bottom; uncheck if not applicable)

- [ ] Branch name follows convention (`feature/*`, `bugfix/*`, `hotfix/*`, `release/*`)
- [ ] PR title follows Conventional Commits (`type(scope): subject`)
- [ ] Commits within follow Conventional Commits
- [ ] PR is < 400 lines of diff (excluding lockfiles/generated)
- [ ] Self-reviewed the diff before requesting review
- [ ] Linked to an issue and/or a phase milestone
- [ ] CI is green
