# FND-08 Launch-Blocking Policy Inputs — Decision Status Matrix

**Date:** 2026-07-28

**Plan reference:** FND-08 (P0 — blocks everything)

**Context:** FND-08 requires signed decisions on tenancy, residency/data-flow,
RPO/RTO, launch concurrency, and accountable owners. The following technical
directions have been selected by the Engineering Lead-equivalent (repository
owner) to unblock architecture and scaffolding work. They are **NOT** signed
stakeholder/Legal/Security approval, do **NOT** constitute FND-08 acceptance,
and do **NOT** resolve the named-owner requirement.

## Direction Status (Selected Technical Directions — Not Approved)

| ID | Decision | Direction as of 2026-07-28 | Formal Owner Approval |
|----|----------|---------------------------|----------------------|
| D-001 | Auth provider | **Supabase Auth** (email/password + SSO, MFA). ADR-0003 direction confirmed. | PENDING Eng Lead + Product signature |
| D-002 | Queue/worker platform | **OCI Queue** (managed, with Logging/Monitoring/APM/Notifications). ADR-0004 direction confirmed. | PENDING Eng Lead signature |
| D-003 | Cloud provider + region | **Oracle Cloud Infrastructure (OCI)**. Mumbai (`ap-mumbai-1`) and Hyderabad (`ap-hyderabad-1`) must be benchmarked before region selection; measured latency and contractual/legal evidence required. ADR-0007 direction confirmed. | PENDING Eng Lead + Legal + Security signature |
| D-004 | Scoring provider/hosting | **OPEN.** Retain `claude -p` CLI until evaluated, compliant API/hosted alternative is approved (LLM-03/LLM-04). | PENDING Eng Lead + Legal |
| D-005 | LiveKit hosting | **OPEN.** Stay Cloud vs self-host; region availability TBD after FND-08 residency input. | PENDING Eng Lead |
| D-006 | Backup strategy | **OPEN.** PITR only vs PITR + daily snapshot export. | PENDING Eng Lead |
| D-007 | Recording storage | **OPEN.** Supabase Storage vs S3-compatible. | PENDING Eng Lead |
| D-008 | SIEM/log aggregator | **OCI managed observability** (Logging, Monitoring, APM, Notifications) selected as operational observability stack. Security-log/SIEM acceptance is separate and pending. | PENDING Eng Lead + Security |
| D-009 | PII retention period | **OPEN.** Must come from Legal. | PENDING Legal |
| D-010 | DPDP consent mechanism | **OPEN.** Must come from Legal. | PENDING Legal |
| D-011 | Tenancy model | **Single-organization launch.** No `org_id` schema isolation. Authenticated roles, RLS, and authorization matrix still required. ADR-0005 direction confirmed. | PENDING Eng Lead + Product signature |

## FND-08 Approval Matrix

### Resolved (Direction Only — Not Approved)

| Item | Selected Direction |
|------|--------------------|
| Auth provider | Supabase Auth |
| Queue platform | OCI Queue + OCI Observability |
| Cloud provider | OCI (region TBD after Mumbai/Hyderabad benchmark) |
| Tenancy model | Single-org launch |
| Observability stack | OCI Logging, Monitoring, APM, Notifications |

### Missing — Blocks FND-08 Acceptance

| Item | What Is Missing |
|------|-----------------|
| **Named accountable owners** | Engineering Lead, Product Manager, Security Lead, Legal Counsel — all `[placeholder]` in PLAN.md §1 |
| **Residency/data-flow evidence** | India residency is an unverified requirement (PLAN.md assumption 7). Contractual and technical evidence of data region required for Supabase (Mumbai `ap-south-1`), LiveKit, Sarvam, Anthropic, and OCI before launch |
| **RPO/RTO** | Not defined. Required for backup strategy (D-006), migration rehearsal (MIG-10), and HA decision |
| **HA posture** | Not decided. DEP-03 is PENDING; single-AD subnet design exists but no explicit single-instance or multi-AD decision |
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
| `app/supabase/` (PR #9) | MIG-03, MIG-04 | Membership-gated RLS, forward-only hardened migrations, local CI validation | Production Supabase project (MIG-01), storage/Realtime configuration (MIG-05, MIG-06), backup/PITR verification, cutover rehearsal |
| `docs/benchmarks/` (PR #8) | DEP-01 | Benchmark harness + runbook; NOT-YET-MEASURED guard | Executed benchmark with real OCI instances, measured latency, cost model |

## Next Required Action

1. Assign named owners to the four placeholder roles in PLAN.md §1.
2. Each owner reviews the selected directions above and either signs or counterproposes.
3. Legal provides India-residency go/no-go, DPDP applicability assessment, and retention period.
4. Engineering executes DEP-01 OCI benchmark (Mumbai vs Hyderabad) to inform D-003 region selection.
5. Product approves launch concurrency target (5 → validate to 10).
6. All 11 D-xxx decisions receive formal signed approval before FND-08 is marked complete.

**This document is a status tracker. It does not constitute FND-08 acceptance.**
