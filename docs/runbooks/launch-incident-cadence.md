# Runbook: LCH-03 Incident Cadence During Hypercare

**Status:** TEMPLATE / FOUNDATION — NOT_ESTABLISHED. This runbook documents
the incident cadence the owner/SRE would operate **during** a real hypercare
window. Nothing here is active: the committed LCH-03 records keep
`incidentCadence: PENDING` and `rollbackAuthority: PENDING`, no on-call
roster is established, and no incident has been paged, triaged, or resolved
by repository work. See the pre-existing `docs/runbooks/incident-response.md`
for the general incident process; this runbook scopes it to hypercare.

## 1. Scope

Hypercare is the heightened post-launch monitoring window of LCH-03: an
SRE-approved window based on **traffic volume** (not merely elapsed hours),
with active on-call, an issue cadence, and explicit rollback authority. This
foundation ships only the cadence **template**. The cadence itself is
`PENDING` and requires an owner/SRE decision and external tooling before it
can be established.

## 2. Cadence roles (PENDING, not named)

| Role | Responsibility | Status |
|------|----------------|--------|
| Hypercare window owner | Declares window start/end based on approved traffic volume; records decisions outside the repository | PENDING |
| On-call engineer | Pages on alerts, triages, escalates | PENDING (no roster) |
| Incident commander | Runs the incident response process during a P0/P1 | PENDING |
| Rollback authority | Authorizes extend-hypercare or roll-back per PLAN.md section 8 | PENDING |
| SRE approver | Approves the real window, threshold, and error-budget health | PENDING |

No name, roster, schedule, or contact channel is recorded in any committed
artifact. `incidentCadence` and `rollbackAuthority` are `PENDING` in
`infra/launch/hypercare-drill.example.json` and every fixture under
`infra/launch/fixtures/hypercare/`.

## 3. Issue review cadence (template)

During an active window the owner/SRE would review issues on this cadence
(all timings are placeholders for owner approval):

| Cadence | Activity |
|---------|----------|
| Per-incident | P0: immediate page and incident-commander takeover; P1: page and triage |
| Daily | Summarize open incidents, escalations, and error-budget position |
| On threshold breach | Decide extend-hypercare or roll back (PLAN.md section 8) |
| On window end | Close the window, record residual issues for LCH-04 retro |

Severity definitions follow `docs/runbooks/incident-response.md`
(P0 = complete outage or data loss, P1 = major impairment, P2 = partial
impairment, P3 = minor, P4 = internal).

## 4. Hypercare exit decisions (PLAN.md section 8)

If the minimum approved number of sessions completes **without a P0
incident** and the error budget stays healthy through the configured window,
the outcome is **extend hypercare or roll back** as the SRE decides.
Rollback during hypercare follows the LCH-02 rollback runbook
(`docs/runbooks/production-rollback.md`) and the Phase 11 DEP-06 release
state machine — this runbook does not define a rollback machine of its own.
Terminal states (`promoted`, `rolled_back`, `aborted`) have no outgoing
transitions.

## 5. Truth boundary

The committed LCH-03 artifacts never claim an established cadence: every
record carries `incidentCadence: PENDING`, `rollbackAuthority: PENDING`,
`hypercareStatus: PENDING`, and `productionAcceptance: false`. A synthetic
drill result (`hypercareWindowAccepted: true` on the 200/1000-session
fixtures) is not an incident cadence, an on-call roster, or production
hypercare acceptance. No `EV-*` reference, UUID, ticket ID, or URL
authorizes any of these claims.

## 6. Residuals (remain PENDING)

Establishing an active incident cadence, naming on-call and rollback
authority, wiring alert delivery, and running a real hypercare window are
owner/SRE operations outside the repository. See `PLAN.md` section 8 and
`docs/runbooks/launch-hypercare.md`.
