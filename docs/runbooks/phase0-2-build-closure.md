# Phase0-2 Build Closure — Terminology Runbook

**Last updated:** 2026-07-30

**Purpose:** Define a deterministic vocabulary that prevents future documentation from confusing build blockers with go-live gates for Phase0-2 (FND-01 through FND-09, and FND-08 owner decisions D-001 through D-011).

**Audience:** Engineering contributors, reviewers, and automated checkers.

---

## 1. Definitions

### BUILD-BLOCKER

A **build-blocker** is a condition that prevents the source code from compiling, the local/synthetic test suite from passing, or the CI pipeline from completing successfully. Build-blockers are **fully resolvable inside the repository** — no external provider, production credential, Legal sign-off, or deployed infrastructure is required to clear them.

As of post-PR26 (Phase0-2 closure wave merged), there are **no build-blockers** for Phase0-2. All implementation code compiles, all deterministic local tests pass, and the checker suite exits 0 on a clean worktree.

**If a future change introduces a build-blocker, the contributor must fix it before marking the Phase0-2 build status as clean.**

### GO-LIVE GATE

A **go-live gate** is a condition that must be satisfied before the system can process real candidate data or be used in production. Go-live gates **require outcomes outside the repository**: external provider evidence, Legal/Security sign-off, deployed infrastructure, or named-owner acceptance.

Go-live gates remain **unwaived** — the fact that they are recorded does not mean they are satisfied. No automated checker can close a go-live gate.

### DEVELOPMENT NOT BLOCKED

Phase0-2 implementation can proceed independently of go-live gates. The following are **not build-blockers** for Phase0-2:

- Missing Legal DPDP documentation (D-009, D-010)
- Pending Axiom US-host Legal nod (D-008)
- Undeployed FND-05 (Infisical secret manager) or FND-06 (service identities)
- Unresolved production RPO/RTO evidence
- Absent residency/data-flow evidence
- Any condition that requires production credentials, provider access, or external sign-off

All of the above are go-live gates, not build-blockers.

---

## 2. True Build-Blockers for Phase0-2

As of post-PR26, there are **zero** true build-blockers for Phase0-2.

The following are **explicitly NOT build-blockers**:

| Condition | Classification | Rationale |
|-----------|---------------|-----------|
| FND-05 (secret manager) undeployed | Go-live gate | Implementation scaffold exists; deployment requires external provider access |
| FND-06 (service identities) undeployed | Go-live gate | Blocked on FND-05; internal synthetic test harness uses local secrets |
| D-009 (retention period) not Legal-approved | Go-live gate | No Legal Counsel assigned; owner direction recorded |
| D-010 (DPDP consent) not Legal-confirmed | Go-live gate | Legal confirmation pending; consent UI is future work |
| D-008 (Axiom US-host) Legal nod pending | Go-live gate | Log aggregation works locally; US-host acceptance is external |
| D-004 (DeepSeek self-hosted) no production deployment | Go-live gate | In-region self-hosted; optional GOV-02 redaction test is owner-run |
| Branch protection not enforced on GitHub Free | Go-live gate | GitHub Free API returns 403; documented in BRANCH_PROTECTION.md |
| Production Supabase project not company-controlled | Go-live gate | MIG-01/MIG-02 are administrative, not code |
| No real candidate data processed | Go-live gate | Deliberate; pre-production status |

---

## 3. Go-Live Evidence Gates (Unwaived)

The following go-live gates are recorded here for traceability. **None are waived or satisfied.** Each requires external evidence before go-live.

| Gate | Evidence Required | Status |
|------|-------------------|--------|
| D-009 PII retention period | Legal DPDP storage-limitation/lawful-basis document signed | Owner direction recorded; not Legal-approved |
| D-010 DPDP consent mechanism | Legal confirmation of combined consent approach; grievance mechanism gap resolved | Owner direction recorded; Legal confirmation pending |
| D-008 SIEM/log aggregator | Axiom US-host Legal nod (acknowledgement that US hosting is acceptable); Security Lead sign-off on log coverage | Pending |
| D-004 Scoring provider/hosting | Model-license/IP commercial-use check; optional GOV-02 redaction test | No D-004-specific hard blocker (in-region self-hosted); minor follow-up |
| FND-05 Secret manager | Deployed self-hosted Infisical (Oracle Mumbai); rotation/audit evidence; no persistent prod .env | Selection complete; deployment pending |
| FND-06 Service identities | Distinct least-privilege identities for all components; service_role key deleted from clients | Selection complete; execution blocked on FND-05 |
| D-001 Auth provider | Security Lead assigned; DPA/subprocessor evidence; MFA/SSO/audit enforcement | Production blocked |
| D-002 Queue/worker platform | Durable outbox pattern; idempotent consumers; retry/backoff/DLQ evidence | Production blocked |
| D-003 Cloud provider + region | DEP-01 region benchmark; residency/DPA evidence; deployed provider proof | Production blocked |
| D-005 LiveKit hosting | Region availability/capacity/DPA evidence; Cloud vs self-host decision with rationale | Production blocked |
| D-006 Backup strategy | RPO/RTO acceptance after successful restore rehearsal | Production blocked |
| D-007 Recording storage | Authenticated streaming upload; consent linkage; integrity provenance; retention compliance | Production blocked |
| D-011 Tenancy model | Full authorization matrix documented; cross-recruiter isolation tests pass | Production blocked |
| 0/17 launch gates | All 17 launch gates verified by named owners | 0 complete |
| 0/14 roadmap phases | All 14 phases accepted by named owners | 0 accepted |

---

## 4. Required Markers for Automated Verification

The checker (`scripts/check-phase0-2-build-status.mjs`) enforces the following markers across key documents:

| Document | Required Marker | Purpose |
|----------|----------------|---------|
| PLAN.md | `build-blocker: none` (or equivalent per-phase statement) | Confirms no true build-blockers exist for Phase0-2 |
| PLAN.md | `0/17` and `0/14` unchanged | Prevents accidental promotion of incomplete gates |
| PLAN.md | D-004 not a hard go-live blocker | Confirms in-region self-hosted status |
| PLAN.md | D-008, D-009, D-010 listed as go-live gates | Prevents waiving of Legal/Security dependencies |
| docs/HANDOVER.md | PR26 merged reference | Confirms Phase0-2 closure baseline |
| docs/HANDOVER.md | `0/17` and `0/14` unchanged | Prevents gate-count drift |
| docs/HANDOVER.md | D-004 not a hard blocker | Confirms in-region self-hosted status |
| docs/current-state.md | `pre-production` status | No production claims |
| docs/decisions/fnd-08-inputs.md | D-004 no cross-border, no DPA needed | Prevents regression on scoring provider decision |
| docs/decisions/fnd-08-owner-approval.md | FND-05/FND-06 selected but not deployed/accepted | Prevents false deployment claims |

---

## 5. Verification

```bash
# Run the build-status checker
node scripts/check-phase0-2-build-status.mjs

# Run negative tests
node scripts/check-phase0-2-build-status.test.mjs
```

Both commands must exit 0.

---

## 6. Updating

When future phases close or new build-blockers emerge:

1. Update this runbook with the new true build-blockers (or confirm none).
2. Update the checker script if new markers are required.
3. Update and add negative tests.
4. Commit all changes together.

Do not remove go-live gates from this runbook — they remain unwaived until externally evidenced.
