# Cutover Rehearsal & Consistency Runbook (MIG-10 / MIG-11)

**Status:** Template — unexecuted. All timings, approvals, and evidence are
placeholder. Hosted/provider steps are BLOCKED by default; none may be
executed without an owner-gated change-control approval.

**Owner-gate:** DB Admin + SRE for rehearsal (MIG-10); DB Admin + Product for
consistency-strategy selection (MIG-11).

---

## 1. Scope

This runbook covers two sequential, owner-gated phases:

| Phase | MIG | Description |
|-------|-----|-------------|
| A — Rehearsal | MIG-10 | Run the complete cutover at production-like volume in an isolated rehearsal project until the owner-approved number of consecutive clean runs is achieved. Measure freeze, cutover, and rollback times. |
| B — Consistency Strategy | MIG-11 | Select and test the final consistency strategy (freeze-vs-delta), block new calls before the final sync, drain writes, reconcile. |

Phase B is **not invoked** until Phase A produces a signed rehearsal report
meeting proposed RTO/RPO targets.

---

## 2. Phase A — Rehearsal (MIG-10)

### 2.1 Preconditions

> **INVARIANT:** All preconditions are checked and recorded in the rehearsal
> log before any step. Missing or failed precondition → HARD STOP.

- [ ] **MIG-08/MIG-09 tooling exists and has passed offline tests.**
      The logical export/import (MIG-07), reconciliation (MIG-08), and storage
      manifest (MIG-09) scripts exist, have clean offline self-tests, and are
      pinned to a reviewed commit.
- [ ] **Rehearsal Supabase project is provisioned and empty.**
      A non-production isolated Supabase project exists, is company-controlled,
      and contains no application or candidate rows. Project ref is recorded
      only in the secret/config system.
- [ ] **Source project snapshot is available.**
      A synthetic or anonymized production-like snapshot of the current project
      is available for rehearsal. The snapshot contains representative volume
      (table row counts, storage object count/size) matching a scale agreed by
      DB Admin + SRE.
- [ ] **Roles are assigned and acknowledged.**
      | Role | Incumbent | Acknowledged |
      |------|-----------|--------------|
      | DB Admin | OWNER-ASSIGNED | [ ] |
      | SRE / Release Engineer | OWNER-ASSIGNED | [ ] |
      | Product representative | OWNER-ASSIGNED | [ ] |
      | Observer (evidence capture) | OWNER-ASSIGNED | [ ] |
- [ ] **Timer tooling is prepared.**
      A stopwatch or timer script records wall-clock durations for freeze,
      export, sync, reconcile, switch, and rollback segments. Durations are
      logged to the rehearsal report.
- [ ] **Rollback procedure script exists.**
      The rollback procedure (stop new traffic, restore old config, reconcile)
      has been prepared as a checked-in, reviewed, and rehearsable script or
      runbook section. Rollback has been tested at least once in isolation.

### 2.2 Required owner-approval gates

Each rehearsal run requires sign-off before the next may begin:

| Gate | Approver | Criterion |
|------|----------|-----------|
| **Run N plan** | DB Admin | Run N steps are understood; timer, evidence, and rollback are ready |
| **Run N result** | DB Admin + SRE | Zero unexplained mismatches; all checksums/counts reconcile |
| **Consecutive-clean threshold** | DB Admin + SRE + Security | N consecutive clean runs (owner-approved N) are achieved |

### 2.3 Steps (template — unexecuted)

```
STEP 1: Notify observers and start evidence capture.
   Action: Begin screen/command-log recording. Record git HEAD commit,
           rehearsal project ref, source snapshot digest, and start time.

STEP 2: Begin freeze timer.
   Action: Record T0 = now(). Block new calls at the ingress layer
           (API gateway / load balancer) or confirm synthetic source is
           quiescent. Wait for in-flight writes to drain.
   GATE:   In-flight write count reaches zero. If drain exceeds
           OWNER-APPROVED-DRAIN-LIMIT, issue HARD STOP.

STEP 3: Export data & objects.
   Action: Run MIG-07 export pipeline (logical schema + storage).
           Record export start and end times.
   VERIFY: Export manifest includes table row counts, canonical per-table
           digest, sequence values, and storage object key/size/digest list.

STEP 4: Import into rehearsal project.
   Action: Run MIG-08 import (dependency-safe order, restore constraints,
           sequences). Record import start and end times.

STEP 5: Reconcile.
   Action: Run MIG-08 reconciliation scripts: compare source vs destination
           for row counts, canonical digests, FK/orphan checks, sequence
           bounds, and representative application-smoke queries.
   VERIFY: Zero unexplained differences. Any accepted transformation must
           have owner-written sign-off in the rehearsal log.
   GATE:   If any mismatch is unexplained → HARD STOP and fail the run.
           If mismatch has documented, owner-approved rationale → record
           and proceed.

STEP 6: Reconcile storage objects.
   Action: Run MIG-09 storage manifest reconciliation: compare source vs
           destination object key/size/digest manifests.
   VERIFY: Zero missing or corrupt objects. Failures are replayable without
           duplicates.
   GATE:   Re-copy failed objects and re-verify. If retry limit exceeded →
           HARD STOP.

STEP 7: Record freeze-to-reconciled duration.
   Action: Record T1 = now(). Freeze duration = T1 - T0.
           Log to rehearsal report.

STEP 8: Rollback drill.
   Action: Execute the rollback procedure (stop traffic to rehearsal target,
           restore configuration to point at source, reconcile any writes
           made to rehearsal target during the window). Record rollback
           start and end times. Log to rehearsal report.
   VERIFY: Rollback completes within owner-approved rollback-time budget.
           No data loss — source project remains intact.
   GATE:   If rollback exceeds budget or causes data loss → HARD STOP and
           flag as failed run.

STEP 9: Score the run.
   Each run is scored PASS/FAIL:
   - PASS: All verifications pass; no HARD STOP; rollback completes within
           budget; durations are logged.
   - FAIL: Any HARD STOP triggered; evidence is preserved for root-cause
           analysis.
   Record the score in the rehearsal log.

STEP 10: Clean rehearsal project.
   Action: Reset or recreate the rehearsal project to a clean state.
           Preserve logs and evidence.

STEP 11: Repeat.
   Action: Repeat STEP 1–10 until owner-approved N consecutive PASS runs
           are achieved. After each failure, remediate the root cause in a
           reviewed PR before the next run.
```

### 2.4 RPO/RTO measurement template

| Metric | Proposed target | Measured (this run) | Meets target? |
|--------|-----------------|---------------------|---------------|
| Freeze-to-reconciled duration | OWNER-APPROVED | — | [ ] |
| Rollback duration | OWNER-APPROVED | — | [ ] |
| Data loss (rows) | 0 | — | [ ] |
| Data loss (storage objects) | 0 | — | [ ] |

> **INVARIANT:** Proposed targets are OWNER-APPROVED and recorded before
> any run. No target is invented by this template.

### 2.5 Evidence capture

The following evidence MUST be preserved for each run:

- Console/command log (script output or terminal recording)
- Export manifest (table counts, digests, sequence values)
- Storage object manifest (key/size/digest)
- Import manifest (destination after import, same schema)
- Reconciliation report (diff output, zero-mismatch assertion result)
- Rollback timing log
- Run score and owner sign-off

Evidence is stored in a timestamped directory and linked in the signed
rehearsal report.

### 2.6 Acceptance criteria for Phase A completion

- [ ] Owner-approved N consecutive PASS runs (N recorded and agreed before
      Phase A start).
- [ ] Signed rehearsal report documenting all runs, durations, RPO/RTO
      comparison, rollback verification, and evidence locations.
- [ ] Report reviewed and accepted by DB Admin + SRE + Security.
- [ ] Remediation items (if any) are tracked to closure.

---

## 3. Phase B — Consistency Strategy (MIG-11)

### 3.1 Strategy selection

Phase B is gated on Phase A completion (Section 2.6). The DB Admin + Product
owner selects ONE of the following strategies:

| Strategy | Description | When to choose |
|----------|-------------|----------------|
| **Freeze-final-export** | Full maintenance/write freeze, final export, import, reconcile. No delta capture. Single sync point. | Write volumes are low; freeze duration is acceptable; delta complexity is not justified. |
| **Copy-plus-delta** | Initial copy (online, no freeze), then controlled delta capture during a short final freeze. Two sync points. | Write volumes are high; freeze duration must be minimised; delta tooling exists and is tested in rehearsal. |

> **INVARIANT:** The selected strategy must have been rehearsed successfully
> in Phase A. No untested strategy may be selected.

### 3.2 Preconditions for strategy execution

- [ ] Strategy selection recorded and approved (DB Admin + Product).
- [ ] Final freeze window is scheduled, announced, and published.
- [ ] All dependent teams (Product, Support, SRE) acknowledge the freeze
      window and any candidate-facing maintenance behavior.
- [ ] No blocking rehearsals remain (Phase A acceptance criteria met).

### 3.3 No-go criteria

If ANY of the following conditions is true, the strategy is **no-go** and
Phase B is postponed:

- Phase A acceptance criteria are not met.
- Rehearsal evidence reveals an unmitigated data-loss or RPO/RTO risk.
- A blocking P0 incident is open in any dependent system.
- The freeze window conflicts with a previously scheduled event or campaign.
- Owner (DB Admin or Product) issues a no-go.

### 3.4 Freeze & consistency execution (template)

```
STEP 1: Announce freeze start.
   Action: Notify all stakeholders. Record T0 = now().
           Block new calls at the ingress layer.

STEP 2: Drain writes.
   Action: Wait for in-flight writes to complete. Verify write-drain
           monitors show zero.
   GATE:   If drain does not complete within owner-approved limit →
           HARD STOP, execute rollback, reschedule.

STEP 3: (If Copy-plus-delta) Capture and apply delta.
   Action: Export rows changed/modified since the initial copy timestamp.
           Import into destination. Reconcile.

STEP 4: Final canonical consistency check.
   Action: Run MIG-08 reconciliation at table, digest, FK, sequence,
           and storage levels. Record timestamps.
   VERIFY: Zero unexplained mismatches.
   GATE:   Mismatch → HARD STOP. Rollback. Do not proceed to cutover.

STEP 5: Record freeze duration.
   Action: T1 = now(). Freeze duration = T1 - T0. Log to report.

STEP 6: Produce no-data-loss report.
   Action: Signed report documenting reconciliation results, freeze
           duration, and data-loss assertion (zero rows/objects lost).
   GATE:   Report is signed by DB Admin + SRE. Without it, cutover is
           blocked.
```

### 3.5 No-data-loss gate

The following MUST be true before cutover (MIG-12/13) may proceed:

- [ ] Final canonical reconciliation has zero unexplained differences.
- [ ] The no-data-loss report is signed (DB Admin + SRE).
- [ ] Freeze-to-reconciled duration is within RTO target.
- [ ] Rollback procedure is tested and ready.
- [ ] Owner (Eng Lead) approves cutover to proceed.

**Without a signed no-data-loss report, cutover is BLOCKED.**

---

## 4. Rollback / fail-forward during Phase B

| Condition | Action |
|-----------|--------|
| Freeze drain exceeds budget | Rollback: lift freeze, continue on old project. Reschedule. |
| Reconciliation mismatch (unexplained) | Rollback: do NOT apply any delta. Investigate. |
| Reconciliation mismatch (documented, signed off) | Record in report. Proceed only with owner approval. |
| No-go condition reached | Rollback. Document reason in post-mortem. |

---

## 5. Owner-gate summary

| Decision | Required approvers | Artifact |
|----------|-------------------|----------|
| Rehearsal run plan | DB Admin | Run log |
| Rehearsal PASS/FAIL score | DB Admin + SRE | Signed run log |
| Phase A complete | DB Admin + SRE + Security | Signed rehearsal report |
| Consistency strategy selection | DB Admin + Product | Strategy record |
| No-data-loss signature | DB Admin + SRE | Signed no-data-loss report |
| Proceed to cutover (MIG-12) | Eng Lead | Cutover approval (separate runbook) |

> **INVARIANT:** No automated or CI-driven cutover. Every gate requires
> a named human approver with recorded sign-off.

---

## 6. Hosted / provider steps

All steps above that reference a Supabase project (rehearsal or production)
interact with a hosted Supabase instance. These steps are **BLOCKED** by
default:

```
BLOCKED: Requires DB Admin authentication and change-control approval
         outside this repository. No credential, project ref, or hosted
         action is placed in this runbook.
```

This runbook defines the procedure template only. No hosted action may be
taken unless the runbook is:
1. Approved under the project's change-control process.
2. Executed by the named role with authenticated access.
3. Recorded in the rehearsal report with evidence.
