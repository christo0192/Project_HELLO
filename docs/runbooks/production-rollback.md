# Runbook: LCH-02 Production Rollback (deployment rollback / abort)

Status: **TEMPLATE / FOUNDATION — NOT_EXECUTED.** This runbook documents the
procedure the repository owner would follow when rolling back or aborting a
launch. Nothing here has been executed: no release has been promoted, rolled
back, or aborted by repository work. The committed LCH-02 contract
(`infra/launch/launch-execution.example.json`) records
`rollback.rollbackAuthority: PENDING`, `rollback.authorizedBy: null`,
`rollback.plan: PENDING`, and `deployed: false` — no rollback authority is
declared and no rollback exists to execute.

## 1. Scope

Rollback is the escape path of the Phase 11 DEP-06 release state machine.
Phase 12 does not define a rollback state machine of its own; it references
the Phase 11 machine:

```
prepared ──→ staging_verified ──→ canary_observing ──→ promote_pending ──→ promoted
   │               │                  │                     │
   ▼               ▼                  ▼                     ▼
 aborted          aborted      rollback_required     rollback_required
                                   │   │                   │   │
                                   ▼   ▼                   ▼   ▼
                              rolled_back            aborted
```

Only transitions in that machine are legal. `rolled_back` requires a
`compatible` rollback declaration; an `incompatible` rollback must terminate
in `aborted`. Terminal states (`promoted`, `rolled_back`, `aborted`) have no
outgoing transitions.

## 2. Rollback triggers (PLAN.md section 8)

- Any confirmed P0 event: data loss/corruption, PII exposure, auth bypass,
  unlawful processing, or uncontrolled outage.
- Launch error budget, completion, voice-quality, queue-backlog, or
  saturation crosses the approved rollback threshold/window.
- Supabase reconciliation diverges, recording/consent evidence is missing, or
  rollback safety is threatened.
- Any Security or Legal incident commander declares stop-processing necessary.

## 3. Repository validation (offline, deterministic)

Rollback compatibility is checked against the repository migrations registry
only — existing markers in `infra/deployment-contracts/manifest.json` — with
no invented live target. These commands are safe to run locally or in CI:

```bash
# Phase 11 DEP-06 release state machine + rollback compatibility checker
node scripts/validate-deployment-release validate infra/deployment-contracts/release-record.example.json
node scripts/validate-deployment-release --fixtures

# Phase 11 deployment contract manifest (migrations registry)
node scripts/validate-deployment-contracts

# Phase 12 LCH-02 contract structural validation
node scripts/check-phase12-launch-status.mjs
```

The Phase 11 validator rejects, offline and deterministically:

- rollback to a migration marker that is not in the repository registry;
- rollback to a marker whose schemaVersion is newer than the current
  release's marker (rolling forward is not a rollback);
- a `compatible` rollback across a `breaking` migration marker unless a
  `migrationBackPlan` is declared;
- an `incompatible` rollback that does not terminate in `aborted`;
- a `rolled_back` state without a `compatible` declaration.

## 4. Owner-run rollback procedure (operator actions, outside this repository)

The following is the procedure the **owner** would follow when operating a
real rollback. It is documented for completeness and is NOT performed by
repository work or CI. Rollback authority is a real-world decision made by
the owner/SRE at the time of the incident; the committed contract records it
as `PENDING` with no named authority.

1. **Declare rollback authority.** The owner/SRE who decides to roll back
   records the decision and timestamp outside the repository. The committed
   contract keeps `rollbackAuthority: PENDING` and `authorizedBy: null`.
2. **Choose the terminal path.** If the rollback is schema-compatible (the
   target migration marker is additive and no migration-back plan is needed),
   the release ends in `rolled_back`. If the current marker is `breaking` and
   no migration-back plan exists, the rollback is `incompatible` and the
   release must end in `aborted`.
3. **Stop traffic.** The owner blocks new sessions/requests and drains
   in-flight work per the deployment contract before restoring the prior
   release.
4. **Restore prior release.** The owner restores the target release
   identified in the release record's `rollback.targetReleaseId` and the
   compatible target migration marker from the repository registry, then
   verifies the deployed services restart against the restored configuration.
5. **Reconcile writes.** If cutover-era writes occurred, the owner follows
   the tested reconciliation procedure (repository markers
   `mig-001`..`mig-004` in `infra/deployment-contracts/manifest.json` are the
   reference registry) before declaring the rollback closed.
6. **Record the terminal state.** The owner updates the release record to
   `rolled_back` or `aborted` with evidence and runs
   `scripts/validate-deployment-release validate <record.json>` to confirm the
   transition is legal.

## 5. Abort safety

- Abort is available at every non-terminal state of the Phase 11 machine
  (`prepared`, `staging_verified`, `canary_observing`, `promote_pending`, and
  `rollback_required` all allow `aborted`).
- Aborting before promotion is preferred when any rollback trigger fires
  before prod traffic opens; aborting after `promoted` is not a machine
  transition — the owner rolls back to a prior release instead.
- No repository artifact can authorize an abort or rollback; those are owner
  operations. `EV-*` references, UUIDs, ticket IDs, and URLs are metadata
  only and never authorize a positive claim.

## 6. Truth boundary

The committed LCH-02 contract stays truthful under all of the above:
`deployed: false`, `stage: NOT_DEPLOYED`, `rollback.rollbackAuthority:
PENDING`, `rollback.authorizedBy: null`, `rollback.plan: PENDING`,
`rollback.targetKind: repository-marker`, and
`rollback.compatibilityCheck: scripts/validate-deployment-release (Phase 11
DEP-06 validator)`. Rollback compatibility is validated against repository
markers only; no live target, host, or endpoint is referenced anywhere.

## 7. Residuals (remain PENDING)

Actual rollback authority, execution, and evidence require owner/SRE action
and external infrastructure outside the repository and are not delivered by
this foundation. See `PLAN.md` section 8 and
`infra/deployment-contracts/release-record.example.json` (the machine
instance, still in `prepared`).
