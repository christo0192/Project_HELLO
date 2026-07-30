# Rollback Window & Reconciliation Runbook (MIG-14)

**Status:** Template — unexecuted. All approvals, timings, and evidence are
placeholder. Hosted/provider steps are BLOCKED by default; none may be
executed without an owner-gated change-control approval.

**Owner-gate:** Eng Lead + DB Admin. The rollback window is opened by MIG-13
cutover and closed only after a configured stability window and reconciliation
pass, with an owner go/no-go decision.

---

## 1. Scope

After cutover (MIG-13) is complete and traffic is running on the new project,
the old project and its credentials remain intact but tightly access-controlled
for a **time-bounded rollback window**. This runbook covers:

- Maintaining the rollback window.
- Reconciliation of post-cutover writes if rollback is executed.
- Immutable evidence collection.
- Owner go/no-go to close the rollback window.

**After the rollback window closes**, the old project may be decommissioned
under MIG-15 (see `mig-decommission.md`).

---

## 2. Preconditions

> **INVARIANT:** All preconditions are confirmed and recorded before the
> rollback window is opened. Missing or failed precondition → do NOT open
> the window; escalate.

- [ ] **MIG-13 cutover is complete.** Traffic is live on the new project.
      The no-data-loss report is signed.
- [ ] **Old project credentials remain deployed and functional.**
      The old project's `service_role` and any other keys are intact,
      deployed to a controlled rollback configuration path, and verified
      to connect. Old keys have NOT been revoked.
- [ ] **Old project access is locked down.** Only the named rollback team
      (DB Admin, Eng Lead, SRE) may access the old project. All other team
      members' access is suspended for the duration. Break-glass procedure
      is documented.
- [ ] **Reconciliation tooling exists.** The script or procedure to reverse
      or reconcile writes made to the new project (if rollback occurs) has
      been prepared, reviewed, and rehearsed in Phase A (MIG-10).
- [ ] **Rollback window duration is approved and recorded.**
      | Parameter | Value (owner-approved) |
      |-----------|------------------------|
      | Rollback window start (T0) | MIG-13 cutover completion time |
      | Planned window duration | OWNER-APPROVED |
      | Window end (scheduled closure) | T0 + duration |
      | Stability observation period | OWNER-APPROVED |
- [ ] **Roles are assigned.**
      | Role | Incumbent | Acknowledged |
      |------|-----------|--------------|
      | Eng Lead (go/no-go authority) | OWNER-ASSIGNED | [ ] |
      | DB Admin | OWNER-ASSIGNED | [ ] |
      | SRE / Release Engineer | OWNER-ASSIGNED | [ ] |
      | Observer (evidence capture) | OWNER-ASSIGNED | [ ] |

---

## 3. Rollback window — observation and monitoring

### 3.1 Immutable evidence capture

Throughout the rollback window, the following evidence is captured and
stored immutably (write-once, read-only after capture):

- [ ] **Cutover boundary evidence** — the no-data-loss report, final
      reconciliation output, freeze timestamps, and cutover approval.
- [ ] **New-project health metrics** — P0 monitors (read/write/realtime/
      recording/scoring) sampled at the owner-approved interval. Evidence
      that all monitors remain green.
- [ ] **Old-project health metrics** — confirmation that the old project
      remains idle (no traffic, no writes, no errors). A brief connectivity
      check to prove credentials still work, logged and signed.
- [ ] **Reconciliation readiness evidence** — the rollback-reconciliation
      script is verified to exist, is pinned to the current commit, and
      its self-tests pass (zero network).

Evidence is stored in a timestamped directory in the repository under
`docs/runbooks/evidence/` or an owner-approved external evidence store.
Evidence files are not modified after capture.

### 3.2 Monitoring and alerting

During the window, P0 monitors must remain green for the new project:

| Monitor | Expected state | Escalation |
|---------|---------------|------------|
| API read/write error rate | < OWNER-APPROVED threshold | P0 alert |
| Realtime subscription delivery | All expected feeds active | P0 alert |
| Recording upload success rate | < OWNER-APPROVED threshold | P0 alert |
| Scoring completion rate | < OWNER-APPROVED threshold | P0 alert |
| Old project traffic | Zero | Investigate |

If any P0 monitor is red for longer than the owner-approved grace period,
the Eng Lead may issue a **hard-stop** and initiate rollback.

### 3.3 Hard-stops

The following conditions trigger an immediate hard-stop:

- **New-project data loss detected.** Any unexplained row/object count
  discrepancy between new and old project grows beyond zero.
- **New-project RLS or access-control failure.** A security incident
  exposes data that should be protected.
- **Old-project unauthorized access detected.** Any access to the old
  project outside the named rollback team.
- **Eng Lead or DB Admin issues hard-stop.** No further justification
  required.

On hard-stop: freeze new traffic, execute rollback (Section 4).

---

## 4. Rollback execution

### 4.1 When to roll back

| Trigger | Action |
|---------|--------|
| P0 monitor red and grace expired | Eng Lead decides: rollback or fail-forward |
| Data loss detected | **MANDATORY ROLLBACK** |
| Security incident | **MANDATORY ROLLBACK** |
| Hard-stop called | Mandatory rollback |
| Strategic decision (e.g., unrecoverable bug in new project) | Eng Lead decides |

### 4.2 Rollback procedure (template)

> **INVARIANT:** Rollback never disables RLS or loses data. Write-reversal
> is applied only through the approved reconciliation script. Do not DELETE
> rows in the old project — update or insert reconciliation records.

```
STEP 1: Freeze new traffic.
   Action: Block new calls at the ingress layer (API gateway / load
           balancer). Do NOT shut down the new project — it may still
           be needed for reconciliation reads.

STEP 2: Capture new-project writes.
   Action: Export all rows written to the new project since cutover
           (MIG-13 completion timestamp). Record row count, table
           distribution, and any new storage objects.

STEP 3: Reconcile writes back to old project.
   Action: Run the reconciliation script that inserts or updates the
           exported writes into the old project, respecting existing
           data and constraints. Do NOT delete or overwrite old rows
           unless the reconciliation script explicitly handles the
           conflict (approved and rehearsed).
   VERIFY: Reconciliation output shows zero errors. Row counts match
           (old + reconciled = expected). FK and sequence integrity
           pass.

STEP 4: Restore configuration.
   Action: Point services back to old-project credentials. Redeploy
           configuration (not code — code should be the same as before
           cutover). Verify service startup with old project.

STEP 5: Run E2E smoke test.
   Action: Execute a brief smoke test (create session, complete
           lifecycle, verify recording object key). Confirm reads and
           writes use the old project.

STEP 6: Resume traffic.
   Action: Lift the traffic freeze. Reopen calls gradually under
           enhanced monitoring.

STEP 7: Document rollback.
   Action: Produce a rollback report with timestamps, reconciliation
           output, smoke-test results, and lessons learned.
```

### 4.3 Rollback validation

- [ ] Reconciliation row counts match expected values.
- [ ] FK, sequence, and constraint checks pass.
- [ ] Storage objects from new project are accessible or re-linked.
- [ ] E2E smoke test passes on old project.
- [ ] P0 monitors are green within observation period.

> **INVARIANT:** If validation fails, the rollback is incomplete. Do NOT
> resume traffic until validation passes or an owner-approved exception is
> recorded.

---

## 5. Go/no-go: closing the rollback window

### 5.1 Preconditions for closure

- [ ] Configured stability window has elapsed (no hard-stops, no P0
      monitor red).
- [ ] Reconciliation pass is completed (even if rollback was not
      executed — prove that reconciliation CAN succeed).
- [ ] All evidence from the observation period is captured and stored.
- [ ] No blocking incident is open against the new project.
- [ ] MIG-15 prerequisites (except actual decommission) are reviewed:
      - GOV-04 retention policy applies.
      - Legal/Security have preliminary approval for decommission.

### 5.2 Closure go/no-go

The Eng Lead (or delegate) holds the sole go/no-go authority:

| Decision | Condition | Action |
|----------|-----------|--------|
| **GO** — close rollback window | All preconditions satisfied; Eng Lead approves | Proceed to MIG-15 decommission planning. Archive evidence. Lock old project for decommission. |
| **NO-GO** — extend window | Preconditions not met; Eng Lead issues extension | Document reason. Set new window end. Re-evaluate at new deadline. |
| **NO-GO** — escalate | Security/legal concern is outside Eng Lead authority | Escalate to Security + Legal. Old project remains intact until resolution. |

### 5.3 After closure

- Old project credentials remain deployed but are **scheduled for revocation**
  under MIG-15.
- Old project access restrictions may be tightened further (read-only, zero
  network access except decommission tooling).
- The signed closure report (with evidence) is stored as immutable evidence.

---

## 6. Hosted / provider steps

All steps above that interact with a Supabase project (old or new) are
**BLOCKED** by default:

```
BLOCKED: Requires authenticated DB Admin or Eng Lead access and
         change-control approval outside this repository. No credential,
         project ref, or hosted action is specified in this runbook.
```

This runbook defines the procedure template only. No hosted action may be
taken unless:
1. The rollback window is opened under approved change control.
2. Each action is executed by the named role with authenticated access.
3. Evidence is captured for every step.

---

## 7. Failure modes

| Failure | Response |
|---------|----------|
| Reconciliation script fails mid-rollback | Stop. Preserve partial state. Do NOT resume traffic. Escalate to DB Admin + Eng Lead. |
| New project becomes unavailable during rollback window | Old project is intact. Proceed with old-config restore; reconciliation may need manual steps. |
| Old project becomes unavailable during rollback window | Immediate escalation to DB Admin + Security. Data-loss incident. |
| Rollback window timer expires without a decision | Default: EXTEND. Do NOT close without an explicit go. |
