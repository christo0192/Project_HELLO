# FND-08 Launch-Blocking Policy Inputs — Decision Status Matrix

**Date:** 2026-07-28 (updated 2026-07-29)

**Plan reference:** FND-08 (P0 — blocks everything)

**Context:** FND-08 requires signed decisions on tenancy, residency/data-flow,
RPO/RTO, launch concurrency, and accountable owners. The following technical
directions have been selected by the repository owner during project alignment
to unblock architecture and scaffolding work. They are **NOT** signed
stakeholder/Legal/Security approval, do **NOT** constitute FND-08 acceptance,
and do **NOT** resolve the named-owner requirement.

**Owner-approval update (2026-07-29):** The sole Product/Engineering owner has
reviewed all D-001..D-011 decisions and issued formal internal-engineering
approvals, deferrals, and production blocks in
[`fnd-08-owner-approval.md`](fnd-08-owner-approval.md). This predecessor document
continues to record the original selected technical directions; the owner-approval
record supersedes it for decision authority.

## Direction Status (Selected Owner Decisions — Accepted as Architecture, Not Production-Approved)

| ID | Decision | Owner Decision | Owner-Approval Status |
|----|----------|----------------|----------------------|
| D-001 | Auth provider | **Supabase Auth: email/password + Google OAuth, single factor (no MFA).** Authorization by server-held active allowlist + role. ADR-0003 accepted as architecture; MFA element withdrawn 2026-08-06 by owner (ADR-0011). | Accepted as architecture, single-factor risk explicitly accepted by owner. Production: blocked. |
| D-002 | Queue/worker platform | **pg-boss in existing Supabase/Postgres; no new queue infra.** ADR-0004 accepted as architecture. | Accepted as architecture. Production: blocked. |
| D-003 | Cloud provider + region | **Oracle Cloud Always-Free Mumbai, $0.** ADR-0007 accepted as architecture. | Accepted as architecture. Production: blocked. |
| D-004 | Scoring provider/hosting | **DeepSeek V4 Pro self-hosted by Ikey on in-house India infrastructure (fly.io India).** No China cross-border transfer; no DeepSeek vendor DPA needed. Pre-egress strip name/phone/email is optional GOV-02 defense-in-depth, owner-run, not a hard go-live blocker. Model-license/IP commercial-use check is a minor non-data-protection follow-up. Legal memo folded into general DPDP package. | Accepted as architecture. No D-004-specific go-live blocker. |
| D-005 | LiveKit hosting | **Self-host LiveKit Mumbai, begin on free cloud tier.** | Accepted as architecture. Production: blocked. |
| D-006 | Backup strategy | **Supabase Free only/no PITR; daily custom-format pg_dump → encrypted → Cloudflare R2 via Oracle cron; RPO 24h/RTO 8h target.** Acceptance only after restore rehearsal. | Accepted as architecture. RPO/RTO: acceptance after rehearsal only. |
| D-007 | Recording storage | **Cloudflare R2 recording target; begin with Supabase Storage free.** | Accepted as architecture. Production: blocked. |
| D-008 | SIEM/log aggregator | **Axiom free tier, PII-redacted at emission; US-hosted Legal nod pending.** | Accepted as architecture. Production: blocked (US-host Legal nod pending). |
| D-009 | PII retention period | **Owner direction: retain by default indefinitely ('store everything, never delete').** Recordings/logs to R2/Oracle object storage, transcripts/scores/PII in Supabase then object-storage offload near free cap. **NOT Legal-approved retention.** | Owner direction recorded. Production: blocked until Legal DPDP document. |
| D-010 | DPDP consent mechanism | **Owner direction: combined consent; includes AI interviewer, recording, purpose, processors (in-region India except Axiom US for redacted logs), retention summary, rights, decline.** Legal confirmation pending. Grievance mechanism: possible DPDP gap. Job-portal consent: must specifically disclose AI interview, recording, purposes, India-hosted processors, and any actual non-India processing if applicable (Axiom US redacted logs — separate D-008 nod). | Owner direction recorded. Production: blocked until Legal confirmation. |
| D-011 | Tenancy model | **Single-org IK India, admin/interviewer/viewer, no org_id.** ADR-0005 accepted as architecture. | Accepted as architecture. Production: blocked. |

## FND-08 Approval Matrix

### Resolved (Accepted as Architecture — Not Production-Approved)

| Item | Owner Decision |
|------|----------------|
| Auth provider | Supabase Auth (email/password + Google OAuth), single factor — no MFA. Authorization by server-held active allowlist + role. ADR-0003 accepted; MFA withdrawn 2026-08-06 (ADR-0011). |
| Queue platform | pg-boss in existing Supabase/Postgres. ADR-0004 accepted. |
| Cloud provider | Oracle Cloud Always-Free Mumbai ($0). ADR-0007 accepted. |
| Tenancy model | Single-org IK India (admin/interviewer/viewer, no org_id). ADR-0005 accepted. |
| Scoring provider | DeepSeek V4 Pro self-hosted by Ikey on in-house India infrastructure (fly.io India). In-region; no cross-border; no DPA needed. Redaction test optional GOV-02 defense-in-depth. Model-license/IP check minor follow-up. |
| LiveKit hosting | Self-host LiveKit Mumbai, begin free cloud tier. |
| Backup strategy | pg_dump → encrypted → Cloudflare R2 via Oracle cron. RPO 24h/RTO 8h target. Acceptance: restore rehearsal only. |
| Recording storage | Cloudflare R2 target; begin Supabase Storage free. |
| Observability stack | Axiom free tier, PII-redacted at emission. US-host Legal nod pending. |
| Secret management | Self-hosted Infisical on Oracle Mumbai ($0). Selection complete; deployment pending. |
| Service identities | Distinct least-privilege per component. Selection complete; execution blocked on FND-05. |
| Dev environment | Local Supabase Docker for dev/rehearsal |
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
| **Legal/DPDP review** | D-009/D-010 owner directions complete; Legal lawful-basis/storage-limitation (D-009) and consent/grievance confirmation (D-010) pending. D-008 Axiom US-host nod pending. DPDP memo and vendor DPA evidence for remaining processors (Supabase, LiveKit, Sarvam, Anthropic) pending. |
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
6. All 11 D-xxx decisions receive formal signed approval from all four accountable roles (Engineering Lead, Product Manager, Security Lead, Legal Counsel) before FND-08 is marked complete.
7. The sole-owner record in [`fnd-08-owner-approval.md`](fnd-08-owner-approval.md) unblocks internal engineering work but does not satisfy item 6.

**This document is a status tracker. It does not constitute FND-08 acceptance.**
