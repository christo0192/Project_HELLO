# Launch Readiness — LCH-01 Gate Registry Foundation

**Status:** TEMPLATE / FOUNDATION — not launch completion
**Artifacts:** `config/phase12-launch-readiness.schema.json`,
`infra/launch/launch-readiness.example.json`
**Baseline:** `9db22b3`

## Purpose

LCH-01 is the production launch checklist gate: the checklist completed, all
P0 gates green, and the go/no-go authority signed off. This directory ships
the **repository foundation** for that gate only: a deterministic,
machine-readable registry of the 17 canonical launch gates and a fillable
template that truthfully records their state as `PENDING`.

**Nothing in this foundation claims launch completion.** No gate is complete,
green, signed, or approved. There is no signatory, no decision date, no
evidence reference, and no go decision. A repository-only artifact can never
authorize a positive claim — no `EV-*` reference, UUID, ticket ID, or URL
changes that.

## Authority

`config/current-state.json` is the **authoritative source of truth** for
repository status and remains byte-identical and untouched by Phase 12
(0/17 launch gates complete, 0/14 phases accepted, `pre-production`,
`synthetic-only`, `browser-only`). This registry is a separate Phase 12
artifact: it enumerates the same 17 gate IDs from `PLAN.md` section 8 for
checklist tracking, and it never overrides or duplicates the current-state
manifest. If the two ever disagree, current-state wins.

## The 17 canonical launch gates

Every gate below is `PENDING` with `synthetic_local` evidence type and
`PENDING` evidence status. Definitions are summarized from `PLAN.md`
section 8 (Production Launch Checklist).

| # | Gate ID | Title | Status |
|---|---------|-------|--------|
| 1 | `PII-GATE` | PII Cleanliness | PENDING |
| 2 | `AUTH-GATE` | Authentication and Authorization | PENDING |
| 3 | `KEY-GATE` | Credential Rotation and Secret Management | PENDING |
| 4 | `UPLOAD-GATE` | Upload Security | PENDING |
| 5 | `AI-GATE` | No Sole Automated Rejection | PENDING |
| 6 | `CONSENT-GATE` | Recording Consent | PENDING |
| 7 | `MIGRATION-GATE` | Production Database Migration | PENDING |
| 8 | `BACKUP-GATE` | Backup and Restore | PENDING |
| 9 | `LOAD-GATE` | Load, Spike, and Soak | PENDING |
| 10 | `OBSERVABILITY-GATE` | Observability | PENDING |
| 11 | `CI-GATE` | CI/CD Integrity | PENDING |
| 12 | `E2E-GATE` | End-to-End Voice | PENDING |
| 13 | `RELIABILITY-GATE` | Reliability | PENDING |
| 14 | `SECURITY-GATE` | Security Posture | PENDING |
| 15 | `FAIRNESS-GATE` | Fairness | PENDING |
| 16 | `LEGAL-GATE` | Legal Sign-Off | PENDING |
| 17 | `DATA-GATE` | Data Lifecycle | PENDING |

The example fixture (`infra/launch/launch-readiness.example.json`) is the
fillable template: all 17 gates above, `goDecision.decision: PENDING`, and
`approvals.status: PENDING` with `signatory`, `date`, and `evidenceRef`
explicitly `null`.

## Policy state model

Allowed states in every LCH-01 repository artifact:

| State | Meaning |
|---|---|
| `PENDING` | Awaits owner/external verification; nothing is complete |
| `PROPOSED` | A proposal exists; nothing is implemented or measured |
| `synthetic_local` | Evidence type for repository fixtures; real targets are owner-operated outside the repository |

Forbidden states (rejected by the status validator): `COMPLETE`, `GREEN`,
`SIGNED`, `APPROVED`, `GO`, and any non-null signatory, decision date, or
approval evidence reference. A `goDecision` value of `GO` is a forbidden
positive claim: recording one requires an authorized named owner with
authentic external evidence, which repository-only foundations never
contain.

## Go/No-Go authority

Per `PLAN.md` section 8, a go decision requires the Engineering Lead,
Security Lead, and Product Manager, with a no-go veto from any of those or
Legal Counsel. In this foundation that authority is recorded as `PENDING`
only — no name is listed and no sign-off exists.

## What this foundation is not

- It is **not** launch completion, a go decision, or an approval record.
- It does **not** modify, duplicate, or shadow `config/current-state.json`
  or `docs/current-state.md`.
- It contains **no** production endpoints, provider addresses, real
  candidate data, or secrets.
- It introduces **no** dashboard, UI, or runnable system behavior.

## Residuals (external, remain PENDING)

Actual checklist completion, all P0 gates green, and named-authority sign-off
for LCH-01 require owner and external evidence outside the repository and
are not delivered by this foundation. See `PLAN.md` section 8 and the
repository `current-state` manifest.

## Related Phase 12 artifacts

| Artifact | Purpose |
|----------|---------|
| `config/phase12-launch-readiness.schema.json` | LCH-01 gate registry schema (this foundation) |
| `infra/launch/launch-readiness.example.json` | LCH-01 fillable example fixture (this foundation) |
| `docs/launch/README.md` | Phase 12 artifact index (cross-links all LCH foundations) |
| LCH-02 execution/rollback contracts | Deployment and rollback contract foundations |
| LCH-03 hypercare drill + fixtures | Bounded synthetic traffic-count drill harness |
| LCH-04 retro template + status validator | Post-launch retro template and contract validator |

`docs/launch/README.md` is the index for the full Phase 12 launch-readiness
artifact set.
