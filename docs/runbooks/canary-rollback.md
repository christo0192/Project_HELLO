# Runbook: DEP-06 Canary / Blue-Green Release State Machine & Rollback

Status: **PENDING / PROPOSED.** This runbook is repository architecture only.
The committed example release record stays in the `prepared` state; no release
has been promoted, rolled back, or aborted by repository work. Canary cohort
and observation windows are PENDING SRE/product.

## 1. Deterministic state machine

A release record (`infra/deployment-contracts/release-record.example.json`,
schema `config/deployment-capacity-release.schema.json`) moves through the
following states:

```
prepared ──→ staging_verified ──→ canary_observing ──→ promote_pending ──→ promoted
   │               │                  │                     │
   ▼               ▼                  ▼                     ▼
 aborted          aborted      rollback_required     rollback_required
                                   │   │                   │   │
                                   ▼   ▼                   ▼   ▼
                              rolled_back            aborted
```

Only the transitions above are legal. In particular:

- `prepared → promoted` is rejected — staging verification and a canary
  observation are mandatory;
- `canary_observing → promoted` and `staging_verified → promoted` are
  rejected (promote_pending is required between observation and promotion);
- `promoted`, `rolled_back` and `aborted` are terminal — no transitions out;
- `aborted` is reachable from every non-terminal state.

Stage consistency is enforced: `staging_verified` requires `stage: "staging"`
and `promoted` requires `stage: "prod"`.

## 2. Canary

In `canary_observing` / `promote_pending`, a `canary` object is required with
`status: PENDING` and an observation window that is `null` (unset) or an
integer >= 1 minute. A window of `0` is rejected: it would claim an accepted
zero-observation canary. Cohort, success criteria, and window are PENDING
SRE/product and are never fixed by repository work.

## 3. Rollback compatibility (repository manifests only)

Rollback targets and migration markers come from the deployment contract
manifest's migrations registry (`infra/deployment-contracts/manifest.json`).
`scripts/validate-deployment-release` rejects:

- rollback to a migration marker that is not in the registry;
- rollback to a marker whose schemaVersion is newer than the current
  release's marker (rolling forward is not a rollback);
- a `compatible` rollback across a `breaking` migration marker unless a
  `migrationBackPlan` is declared — this is the **incompatible schema
  rollback** negative control;
- an `incompatible` rollback that does not terminate in `aborted`;
- a `rolled_back` state without a `compatible` declaration.

## 4. Commands

```bash
node scripts/validate-deployment-release validate infra/deployment-contracts/release-record.example.json
node scripts/validate-deployment-release --fixtures   # full negative-control suite
```

The `--fixtures` suite proves, among others: `prepared → promoted` is
rejected, skip-transitions are rejected, stage mismatches are rejected, and
the breaking-marker rollback is rejected while additive rollback to
`rolled_back` and incompatible-abort paths pass.

## 5. Truth boundary

The state machine is deterministic and offline. It defines HOW a release WOULD
move; it does not move one. Nothing here is deployed or promoted. When the
owner operates a real release, the record is updated by the owner only, with
real evidence paths and timestamps, outside this repository's CI.

## 6. Owner path

1. Owner/SRE fix the canary cohort, success criteria, and observation window.
2. The owner records each state transition in a local, non-committed release
   record with evidence (synthetic or real, as appropriate).
3. Repository-only records remain PENDING placeholders; the committed example
   stays `prepared`.
