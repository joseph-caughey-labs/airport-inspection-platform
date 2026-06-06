# ADR 0009: HITL routing thresholds

- **Status**: Accepted
- **Date**: 2026-06-05
- **Owner**: Validation Engineer
- **Reviewers**: Airport Ops Domain Expert, Principal Architect

## Context

Not every AI detection should auto-create an incident, and not every detection should demand a human's attention — but the dangerous ones must. The validation pipeline ([ADR 0008](0008-parity-10-layer-validation.md)) needs a principled way to decide which detections route to a **human-in-the-loop (HITL)** reviewer queue versus which flow straight through, and which are so risky they're held as exceptions.

A single confidence cutoff ("review anything below 0.8") is too blunt: a 0.7-confidence _critical_-severity FOD detection on a runway is far more deserving of a human than a 0.7-confidence _info_-severity surface anomaly. Risk is multi-factor — confidence, severity, freshness, and how much earlier validation already struggled all matter. The routing decision has to combine them, and the combination has to be **explainable** so a postmortem can answer "why was this routed to HITL?" (or why it wasn't).

## Decision

Risk scoring lives in **Layer 7** (`services/validation-engine/src/layers/07-risk`) and produces a composite score in `[0, 1]` from four weighted factors:

| Factor                  | Weight | Meaning                                                                |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| `confidence_gap`        | 0.30   | `1 − confidence` — lower model confidence is riskier                   |
| `severity_weight`       | 0.30   | `critical = 1 … info = 0` — hazard class matters as much as confidence |
| `freshness`             | 0.20   | age vs `freshnessSpanMs` — stale detections are riskier                |
| `prior_failure_density` | 0.20   | failed prior layers / 5 — earlier validation struggle compounds risk   |

Two thresholds turn that score into a routing decision:

- **`hitlScoreThreshold` (default 0.6)** — score `≥ 0.6` sets `routes_to_hitl` on the layer result. Layer 8 (HITL routing) uses that flag as its gate to place the detection in the reviewer queue; the contributing factors are attached so the _reason_ is auditable, not just the verdict.
- **`exceptionScoreThreshold` (default 0.95)** — score `≥ 0.95` fails Layer 7 with `RISK_EXCEPTION_THRESHOLD`. This is the "don't even wait for a human, hold it as an exception" cutoff for the most dangerous detections.

Thresholds and factor weights are **configurable defaults**, not hard-coded magic — they're parameters on the layer so they can be tuned per deployment without a code change. Severity contributes via a small lookup (`high 0.75, medium 0.5, low 0.25`) so the severity axis is legible and adjustable alongside the weights.

## Alternatives considered

- **Single confidence threshold**: rejected — ignores severity, freshness, and validation history; routes a low-confidence harmless detection to a human while passing a slightly-higher-confidence critical one.
- **Route everything to HITL**: rejected — drowns reviewers, destroys the value of automation, and makes the queue meaningless. The reviewer's time is the scarce resource the thresholds exist to protect.
- **Route nothing — fully automatic**: rejected — unacceptable in a safety-critical domain; the human override (and its audit trail) is the point of the HITL design.
- **A learned routing classifier**: rejected for now — no labelled "should-this-have-been-reviewed" dataset exists, and a transparent weighted score is far more defensible to an auditor than an opaque model. This is the production evolution.

## Trade-offs

- **Lost**: optimality and per-class tuning — the weights and the 0.6 / 0.95 cutoffs are hand-chosen, uniform across detection classes, and not validated against outcome data. A real deployment would tune them per class and per airport.
- **Lost**: adaptivity — static thresholds don't respond to reviewer load or shifting model calibration; a flood of borderline detections can't dynamically raise the bar.
- **Kept**: explainability and control — every routing decision decomposes into named, weighted factors an auditor can read, and an operator can retune the policy by changing parameters, not code. Transparent-but-imperfect beats optimal-but-opaque for a safety case.

## Consequences

- The reviewer queue is fed by an explainable signal: a HITL item carries _why_ it was routed (the factor breakdown), which the operator dashboard renders on the incident timeline and the audit chain records.
- Layer 7's output couples to two consumers — Layer 8's routing gate and the dashboard's "LOW CONF" / review affordances — so the score shape is a contract, not an internal detail.
- The weather-degraded LOW CONF scenario is a direct test of this path: degraded confidence ([ADR 0004](0004-ai-inference-simulation.md)) raises `confidence_gap`, pushing borderline detections over `hitlScoreThreshold`.

## Production evolution path

The transparent weighted score becomes the **baseline and the explainer**, not the whole story. Thresholds get tuned per detection class and per airport against logged reviewer outcomes (precision/recall on "was this worth a human?"); a learned model can rank or pre-score items _behind_ the transparent score, which stays as the auditable fallback and sanity check. Adaptive routing responds to reviewer queue depth (raise the bar under load, lower it when idle), and the factor weights themselves become a tracked, versioned configuration with their own change-audit — because in a safety-critical system, _why a human was or wasn't asked_ is exactly the kind of decision that must remain on the record.
