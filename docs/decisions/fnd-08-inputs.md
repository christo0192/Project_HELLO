# FND-08 Launch-Blocking Policy Inputs — Decision Status Matrix

**Date:** 2026-07-28

**Plan reference:** FND-08 (P0 — blocks everything)

**Context:** FND-08 requires signed decisions on tenancy, residency/data-flow,
RPO/RTO, launch concurrency, and accountable owners. The following technical
directions have been selected by the repository owner during project alignment
to unblock architecture and scaffolding work. They are **NOT** signed
stakeholder/Legal/Security approval, do **NOT** constitute FND-08 acceptance,
and do **NOT** resolve the named-owner requirement.

## Direction Status (Selected Technical Directions — Not Approved)

| ID | Decision | Direction as of 2026-07-28 | Formal Owner Approval |
|----|----------|---------------------------|----------------------|
| D-001 | Auth provider | **Supabase Auth.** Auth modes (email/password, SSO), MFA enforcement, account lifecycle, session management, and contractual/DPA evidence pending. ADR-0003 direction confirmed. | formal approval pending; owner unassigned |
| D-002 | Queue/worker platform | **OCI Queue** (managed, with Logging/Monitoring/APM/Notifications). ADR-0004 direction confirmed. | formal approval pending; owner unassigned |
| D-003 | Cloud provider + region | **Oracle Cloud Infrastructure (OCI).** Mumbai (`ap-mumbai-1`) and Hyderabad (`ap-hyderabad-1`) must be benchmarked before region selection; measured latency and contractual/legal evidence required. ADR-0007 direction confirmed. | formal approval pending; owner unassigned |
| D-004 | Scoring provider/hosting | **OPEN.** Current `claude -p` CLI is prototype-only. An evaluated, compliant API/hosted alternative must be selected and approved before production (LLM-03/LLM-04). | formal approval pending; owner unassigned |
| D-005 | LiveKit hosting | **OPEN.** Stay Cloud vs self-host; region availability TBD after FND-08 residency input. | formal approval pending; owner unassigned |
| D-006 | Backup strategy | **OPEN.** PITR only vs PITR + daily snapshot export. | formal approval pending; owner unassigned |
| D-007 | Recording storage | **OPEN.** Supabase Storage vs S3-compatible. | formal approval pending; owner unassigned |
| D-008 | SIEM/log aggregator | **OCI managed observability** (Logging, Monitoring, APM, Notifications) selected as operational observability stack. Security-log/SIEM acceptance is separate and pending. | formal approval pending; owner unassigned |
| D-009 | PII retention period | **OPEN.** Must come from Legal. | formal approval pending; owner unassigned |
| D-010 | DPDP consent mechanism | **OPEN.** Must come from Legal. | formal approval pending; owner unassigned |
| D-011 | Tenancy model | **Single-organization launch.** No multi-tenant `org_id` isolation required for launch; does not permanently ban future multi-tenancy. Authenticated roles, RLS, and authorization matrix still required. ADR-0005 direction confirmed. | formal approval pending; owner unassigned |

## FND-08 Approval Matrix

### Resolved (Direction Only — Not Approved)

| Item | Selected Direction |
|------|--------------------|
| Auth provider | Supabase Auth (modes, MFA, lifecycle evidence pending) |
| Queue platform | OCI Queue + OCI Observability |
| Cloud provider | OCI (region TBD after Mumbai/Hyderabad benchmark) |
| Tenancy model | Single-org launch (no multi-tenant org_id for launch) |
| Observability stack | OCI Logging, Monitoring, APM, Notifications |
| Dev environment | Local Supabase Docker for dev/rehearsal |
| Staging environment | Persistent isolated OCI staging — apply only after protected remote state and owner approval |
| Production application | Manual reviewed application; no automated production deployment exists |

### Missing — Blocks FND-08 Acceptance

| Item | What Is Missing |
|------|-----------------|
| **Named accountable owners** | Engineering Lead, Product Manager, Security Lead, Legal Counsel — all `[placeholder]` in PLAN.md §1 |
| **Residency/data-flow evidence** | India residency is an unverified requirement (PLAN.md assumption 7). Contractual and technical evidence of data region required for Supabase (Mumbai `ap-south-1`), LiveKit, Sarvam, Anthropic, and OCI before launch |
| **RPO/RTO** | Not defined. Required for backup strategy (D-006), migration rehearsal (MIG-10), and HA decision |
| **HA posture** | Not decided. DEP-03 is PENDING; no explicit single-instance or multi-AD decision |
| **Backup/PITR plan** | D-006 open. Supabase PITR capability not yet verified against Legal requirements |
| **LiveKit hosting** | D-005 open. Cloud vs self-host; region availability unverified |
| **Legal/DPDP review** | D-009, D-010, GOV-07 all open. No DPDP memo, no vendor DPA evidence, no retention schedule |
| **Launch concurrency target** | Direction: 5 concurrent sessions, validate to 10. Must be approved by Product+SRE (DEP-01 benchmark required first) |
| **Budgets** | OCI budget resource scaffolded; amounts not approved by owner |
| **Formal sign-off** | No signed decision record exists. FND-08 acceptance requires signed record from all four accountable roles |

## Merged Scaffolds Do NOT Complete Plan Tasks

| Scaffold | Plan Task | What It Provides | What Is Still Required |
|----------|-----------|-----------------|----------------------|
| `infra/oracle/` (PR #7) | FND-05, FND-06, DEP-02..07 | Vault + key resources, fail-closed IAM dynamic groups, queue/observability modules, remote-state safety gate | Tenancy access, `terraform apply`, deployed compute, secret resources, rotation policies, narrowed IAM, runtime injection |
| `app/supabase/` (PR #9) | MIG-03, MIG-04 | Membership-gated RLS, forward-only hardened migrations, local CI validation, limited Realtime and private-storage posture. The production Supabase project already exists unused in Mumbai (`ap-south-1`) but MIG-01/02 administrative acceptance (company-controlled organization ownership evidence and access configuration, second MFA admin, plan/PITR/billing/break-glass evidence) is pending. Hosted/full role authorization remains pending (SEC-01 through SEC-04, MIG-05, MIG-06). | Company-controlled organization ownership evidence and access configuration, second MFA admin, plan/PITR/billing evidence, break-glass procedure, hosted Realtime/storage authorization, backup/PITR verification, cutover rehearsal |
| `docs/benchmarks/` (PR #8) | DEP-01 | Preliminary region-discovery groundwork: benchmark harness + runbook with NOT-YET-MEASURED guard. Formal DEP-01 capacity acceptance depends on TST-09 (load/soak), REL-01 (durable queue), and OBS-03 (metrics). | An owner-approved preliminary Mumbai/Hyderabad synthetic probe with teardown may run, but must not claim formal DEP-01 completion. Executed benchmark with real OCI instances, measured latency, cost model, load-test integration still required |

## Next Required Action

1. Assign named owners to the four placeholder roles in PLAN.md §1.
2. Each owner reviews the selected directions above and either signs or counterproposes.
3. Legal provides India-residency go/no-go, DPDP applicability assessment, and retention period.
4. Engineering may run an owner-approved preliminary Mumbai/Hyderabad synthetic probe (teardown after) for region discovery; formal DEP-01 acceptance requires TST-09/REL-01/OBS-03 integration.
5. Product approves launch concurrency target (5 → validate to 10).
6. All 11 D-xxx decisions receive formal signed approval before FND-08 is marked complete.

**This document is a status tracker. It does not constitute FND-08 acceptance.**
