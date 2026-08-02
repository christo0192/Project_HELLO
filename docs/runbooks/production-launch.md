# Runbook: LCH-02 Production Launch (deployment / first real session)

Status: **TEMPLATE / FOUNDATION — NOT_DEPLOYED.** This runbook documents the
procedure the repository owner would follow when operating LCH-02. Nothing in
this runbook has been executed: no service is deployed, no launch session
exists, no dashboard is monitored, no on-call is active, and no rollback has
been performed. The committed LCH-02 contract
(`infra/launch/launch-execution.example.json`, schema
`config/phase12-launch-execution.schema.json`) truthfully records
`NOT_DEPLOYED` / `PENDING` / `NOT_ACTIVE` state.

## 1. Scope

LCH-02 (PLAN.md section 8) is the launch execution gate:

> Launch: deploy to production. Monitor dashboards. On-call engineer active.
> Success: production live; first real session completes successfully.

This repository ships the **contract foundation** for that gate only. It does
not deploy anything and does not record a first session. The release state
machine is the Phase 11 DEP-06 machine, referenced — not forked — from
`infra/deployment-contracts/release-record.example.json` and validated by
`scripts/validate-deployment-release`.

## 2. Repository validation (offline, deterministic)

These commands are safe to run in CI or locally. They never touch a provider,
a live endpoint, or a secret.

```bash
# Phase 11 DEP-06 release state machine (the machine Phase 12 references)
node scripts/validate-deployment-release validate infra/deployment-contracts/release-record.example.json
node scripts/validate-deployment-release --fixtures

# Phase 11 deployment contract manifest (migrations registry for rollback targets)
node scripts/validate-deployment-contracts
node scripts/validate-deployment-contracts --fixtures

# Phase 12 LCH-02 contract structural validation
node scripts/check-phase12-launch-status.mjs
```

The Phase 11 validator enforces the legal chain
`prepared → staging_verified → canary_observing → promote_pending → promoted`
with `rollback_required → rolled_back | aborted` escapes, stage consistency,
and rollback compatibility against the repository migrations registry. Any
incompatible transition detected there is inherited by Phase 12; this runbook
defines no alternative transitions.

## 3. Owner-run live procedure (operator actions, outside this repository)

The following is the procedure the **owner** would follow when operating a
real launch. It is documented for completeness and is NOT performed by
repository work, CI, or this runbook. Every step happens on owner-operated
infrastructure with real credentials, outside CI, and is recorded by the
owner only.

1. **Go/no-go (LCH-01).** Engineering Lead, Security Lead, and Product
   Manager give go; any of those or Legal Counsel may veto. The go decision
   is recorded outside the repository; the LCH-01 registry stays PENDING.
2. **Release record.** The owner instantiates a Phase 11 DEP-06 release
   record and advances it through the machine: `prepared` → `staging_verified`
   → `canary_observing` → `promote_pending` → `promoted` (prod). Each
   transition is validated by `scripts/validate-deployment-release`.
3. **Deploy to production.** The owner promotes the validated release to
   `stage: prod` and starts the deployed services with runtime secrets from
   the managed secret source. Staging and prod stages in the Phase 11
   deployment contract manifest (`infra/deployment-contracts/manifest.json`)
   stay `NOT_DEPLOYED` in the repository.
4. **Monitor dashboards.** The owner observes the operational dashboards and
   confirms logs, metrics, and traces flow to the observability platform.
   `monitoring.dashboardMonitored` stays `false` and
   `monitoring.endpoint` stays `null` in the committed contract.
5. **First real session.** The owner completes a first real production
   session (a real candidate, real consent, real recording/transcript
   evidence). Synthetic local fixtures never satisfy LCH-02.
   `firstSessionCompleted` and `firstRealSessionCompleted` stay `false` and
   `firstSessionEvidence` stays `PENDING` in the committed contract.
6. **On-call.** The owner activates an on-call engineer and an escalation
   path. `onCallActive` stays `false` and `onCallRoster` stays `PENDING` in
   the committed contract.

## 4. Abort and rollback safety

- **Abort points.** Before promotion, the release can abort at any
  non-terminal state of the Phase 11 machine (`prepared`/`staging_verified`/
  `canary_observing`/`promote_pending` → `aborted`). The owner records the
  abort in the release record and stops traffic.
- **Rollback triggers.** From PLAN.md section 8: any confirmed P0 event
  (data loss/corruption, PII exposure, auth bypass, unlawful processing,
  uncontrolled outage), launch error budget/completion/voice-quality/
  queue-backlog/saturation crossing the approved rollback threshold, Supabase
  reconciliation divergence, missing recording/consent evidence, or a
  Security/Legal stop-processing declaration.
- **Rollback compatibility.** Rollback targets are repository migration
  markers from `infra/deployment-contracts/manifest.json` only. The Phase 11
  validator rejects unknown targets, targets newer than the current marker,
  `compatible` claims across a `breaking` marker without a migration-back
  plan, and non-`aborted` outcomes for incompatible rollbacks. The committed
  LCH-02 contract records `rollback.rollbackAuthority: PENDING`,
  `rollback.plan: PENDING`, and `rollback.authorizedBy: null` — no authority
  is pre-declared and no rollback is executed.
- **Safety posture.** If a rollback decision is made, the owner executes it
  under the documented rollback procedure (`docs/runbooks/production-rollback.md`)
  and records the terminal state (`rolled_back` for a compatible rollback,
  `aborted` for an incompatible one) in the release record. Repository work
  never executes a rollback.

## 5. Truth boundary

The committed LCH-02 contract stays `NOT_DEPLOYED` / `PENDING` / `NOT_ACTIVE`
in every status field: `deployed: false`, `stage: NOT_DEPLOYED`,
`launchSessionId: null`, `launchWindow: PENDING`, `firstSessionCompleted:
false`, `firstSessionEvidence: PENDING`, `onCallActive: false`, `dashboardMonitored:
false`, `monitoring.endpoint: null`, `rollbackAuthority: PENDING`. No
positive claim is possible: `true` on any boolean, any non-null identifier,
any monitoring endpoint, or any AUTHORIZED/APPROVED/ACTIVE status value is
rejected by the Phase 12 status validator.

## 6. Residuals (remain PENDING)

The actual LCH-02 execution — production deploy, dashboards observed, active
on-call, and a first real session — requires owner operation and external
evidence outside the repository and is not delivered by this foundation.
See `PLAN.md` section 8 and `config/current-state.json` (authoritative:
0/17 gates, 0/14 phases, `pre-production`).
