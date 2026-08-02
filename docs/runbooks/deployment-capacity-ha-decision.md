# DEP-03 HA Decision Evidence Runbook

DEP-03 requires a documented decision on whether HA (multi-zone /
multi-instance) is needed for launch, based on SLO and cost. In repository-only
foundations the decision is always a **proposal**, the single-instance risk is
**explicit when applicable**, RTO/RPO values remain `PENDING`, and the owner
acceptance slot is always `PENDING`.

**Truth boundary:** no HA, failover, or multi-zone capability is claimed by
anything in this repository. The evidence template records the decision
*process*, not an outcome.

## Files

- `config/deployment-capacity-ha.schema.json` — HA decision evidence template schema
- `infra/capacity/ha-decision.example.json` — synthetic example (all `PENDING`)

## Template fields

| Field | Meaning |
|-------|---------|
| `decisionState` | `PROPOSED` or `PENDING` only |
| `haDecision.haRequiredProposal` | Proposed answer (a proposal, not a commitment) |
| `singleInstanceRisk.exists` | Explicit flag: a single-instance pilot means an instance outage interrupts service until owner recovery |
| `singleInstanceRisk.status` | `PENDING` or `PROPOSED` only |
| `rtoRpo.rtoMinutes.value` / `rpoMinutes.value` | `null` or an integer ≥ 1; `0` is invalid because it would claim zero-downtime recovery that repository-only work cannot evidence |
| `rtoRpo.*.status` | Always `PENDING` — target windows are never commitments |
| `approval.status` | Always `PENDING`; `ACCEPTED`/`APPROVED` values are invalid without authentic external evidence |
| `approval.owner` / `approval.date` | Remain `null` until the owner acts in writing |

## Validate an HA decision document

```bash
node scripts/capacity-benchmark-run ha-validate infra/capacity/ha-decision.example.json
```

The validator rejects:

- `rtoMinutes`/`rpoMinutes` value `0` (with or without `ACCEPTED` approval).
- `approval.status` other than `PENDING`.
- Missing or non-boolean `singleInstanceRisk.exists`.
- Secret-like content anywhere in the document.

## Owner path

1. Owner fills a local, non-committed copy of the template (the committed
   example stays synthetic and all-`PENDING`).
2. Owner/SRE agree target RTO/RPO values; the committed artifact may record
   them only as `PENDING` proposals.
3. If the pilot is single-instance, the risk is recorded explicitly and the
   acceptance slot remains `PENDING` until the owner signs off in writing.

## What this runbook does NOT authorize

- No failover testing, no multi-zone provisioning, no HA acceptance.
- No RTO/RPO commitment is valid from a repository-only artifact.
