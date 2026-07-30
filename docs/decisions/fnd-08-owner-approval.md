# FND-08 Sole-Owner Decision Record — Internal Engineering Approval

**Record type:** Engineering/Product owner approval — not Legal Counsel, not Security Lead, not independent reviewer

**Owner:** Single Product/Engineering owner (repository owner / sole contributor)

**Date:** 2026-07-29

**Mem0 recall:** Initial implementation recall was unavailable; the scoped repair recall returned 5 entries. Repository decisions remain evidence-led rather than memory-led.

**Predecessor:** `docs/decisions/fnd-08-inputs.md` (2026-07-28) — selected technical directions, no formal owner approval

**Authorization boundary:** This record authorises **internal synthetic browser-only engineering evaluation**. It does **NOT** authorise real candidate data, paid cloud provisioning, production launch, or any commitment that implies stakeholder/Legal/Security sign-off. Production acceptance of any decision requires a separate signed record from all four accountable roles (Engineering Lead, Product Manager, Security Lead, Legal Counsel).

---

## Cost posture

This record adopts a strict **no-cost posture** for all approved decisions, leveraging Oracle Cloud Always-Free Mumbai ($0). Prefer existing free tiers (Supabase Free, LiveKit free cloud tier initially, Axiom free tier). Do not provision paid cloud tiers or commit to free-tier guarantees as permanent contracts. Do not create new paid accounts without explicit owner approval.

---

## Decision matrix

### Key

| Status | Meaning |
|--------|---------|
| **APPROVED FOR INTERNAL ENGINEERING** | Owner authorises implementation for internal synthetic browser-only evaluation under the no-cost posture. Not production approval. |
| **DEFERRED** | Not actionable at current internal-engineering stage; revisit when production gates are defined. |
| **BLOCKED FOR PRODUCTION** | Requires a named owner, evidence, or sign-off that the sole Product/Engineering owner cannot provide (Legal, Security, independent reviewer). Internal side-steps or synthetic-only approaches are noted. |

### D-001 — Auth provider

| Field | Value |
|-------|-------|
| **Decision** | Supabase Auth: email/password + SSO + MFA |
| **Status** | **Accepted as architecture** (owner-complete direction). ADR-0003 accepted. Not production/go-live accepted. |
| **Rationale** | Supabase Auth (email/password, SSO, MFA) is the owner-selected architecture. ADR-0003 is accepted as the architectural direction. Production go-live additionally requires named Security Lead, DPA/subprocessor evidence, MFA/SSO/audit enforcement, account lifecycle, session revocation, and operational ownership. |
| **Cost posture** | Supabase Free tier = $0. No cloud project upgrade. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: Security Lead assigned, DPA evidence, MFA/SSO/audit enforcement. |
| **Production-revisit trigger** | Named Security Lead assigned; DPA evidence collected; MFA/SSO/audit requirements documented. |

### D-002 — Queue/worker platform

| Field | Value |
|-------|-------|
| **Decision** | pg-boss in existing Supabase/Postgres; no new queue infra |
| **Status** | **Accepted as architecture** (owner-complete direction). ADR-0004 accepted. Not production/go-live accepted. |
| **Rationale** | Owner selected pg-boss (PostgreSQL-based job queue) running in the existing Supabase Postgres instance. No separate queue infrastructure (OCI Queue, BullMQ+Redis, etc.) is introduced. This keeps cost at $0 (Supabase Free) and operational complexity near zero. Production go-live additionally requires durable outbox pattern, idempotent consumers, retry/backoff/DLQ, and concurrency evidence. |
| **Cost posture** | Zero cost — reuses existing Supabase Postgres. No additional queue infrastructure. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: outbox + idempotent consumer tested at concurrency target. |
| **Production-revisit trigger** | Concurrency target sustained; first scoring durability failure observed; Supabase Free DB limits approached. |

### D-003 — Cloud provider + region

| Field | Value |
|-------|-------|
| **Decision** | Oracle Cloud Always-Free Mumbai, $0 |
| **Status** | **Accepted as architecture** (owner-complete direction). ADR-0007 accepted. Not production/go-live accepted. |
| **Rationale** | Owner selected Oracle Cloud Infrastructure Always-Free tier in Mumbai region at $0 cost. This replaces the earlier TBD region with a concrete free-tier commitment. Production go-live additionally requires dep-01 region-latency benchmark, residency/DPA evidence, and provider deployment evidence. |
| **Cost posture** | Zero cost — OCI Always-Free tier, Mumbai. No paid OCI provisioning. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: DEP-01 region benchmark, residency/DPA evidence, deployed provider proof. |
| **Production-revisit trigger** | FND-08 production evidence (residency, RPO/RTO, named owners) completed; DEP-01 benchmark executed. |

### D-004 — Scoring provider/hosting

| Field | Value |
|-------|-------|
| **Decision** | DeepSeek V4 Pro through Ikey self-hosted OpenRouter alternative on fly.io India-only |
| **Status** | **Accepted as architecture** (owner-complete direction). Replaces `claude -p`. Not production/go-live accepted. In-region self-hosted; no China cross-border; no DeepSeek vendor DPA needed. |
| **Rationale** | Owner selected DeepSeek V4 Pro self-hosted by Ikey on in-house India infrastructure (fly.io India). Ikey does NOT call DeepSeek's China API — the model runs locally on India infrastructure. Therefore no China cross-border transfer occurs, no DeepSeek third-party vendor DPA is needed, and the D-004 Legal memo is a routine in-region processing documentation item folded into the general DPDP package. Pre-egress stripe name/phone/email is optional GOV-02 defense-in-depth, owner-run, not a hard go-live blocker. Model-license/IP commercial-use check is a minor non-data-protection follow-up. |
| **Cost posture** | Self-hosted on fly.io India region; DeepSeek model inference cost via Ikey infra. |
| **Verification trigger** | Owner: architecture direction confirmed. Go-live: no D-004-specific blocker (in-region self-hosted); owners optionally run redaction test as GOV-02 defense-in-depth. |
| **Production-revisit trigger** | Model-license/IP commercial-use check confirms self-hosted DeepSeek weights use is allowed. Gated behind LLM-03/LLM-04 evaluation suite. |

### D-005 — LiveKit hosting

| Field | Value |
|-------|-------|
| **Decision** | Self-host LiveKit Mumbai, begin on free cloud tier |
| **Status** | **Accepted as architecture** (owner-complete direction). Not production/go-live accepted. |
| **Rationale** | Owner selected self-hosted LiveKit in Mumbai region, beginning with the free cloud tier (LiveKit Cloud free) for initial evaluation. Production go-live additionally requires region availability, capacity, Egress support, DPA, and a hosting decision (Cloud vs self-host) with evidence. |
| **Cost posture** | LiveKit Cloud free tier = $0 initially. Self-hosted LiveKit on OCI Always-Free eligible if applicable. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: region-capacity-DPA evidence, self-host or Cloud decision with rationale. |
| **Production-revisit trigger** | FND-08 production evidence completed; concurrency target exceeds free-tier limits. |

### D-006 — Backup strategy

| Field | Value |
|-------|-------|
| **Decision** | Supabase Free only/no PITR; daily custom-format pg_dump → encrypted → Cloudflare R2 via Oracle cron; RPO 24h/RTO 8h target |
| **Status** | **Accepted as architecture** (owner-complete direction). Not production/go-live accepted. RPO/RTO acceptance only after restore rehearsal. |
| **Rationale** | Owner selected Supabase Free tier (no PITR) with daily custom-format pg_dump, encrypted, pushed to Cloudflare R2 via Oracle Always-Free cron. Target RPO 24h, RTO 8h. These targets are accepted only after a successful restore rehearsal. This replaces the earlier deferred position. |
| **Cost posture** | Supabase Free = $0. Cloudflare R2 free tier = $0. Oracle Always-Free cron = $0. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: RPO/RTO acceptance only after restore rehearsal passes. |
| **Production-revisit trigger** | RPO/RTO targets defined and rehearsed; MIG-10 migration rehearsal planned; production Supabase project activated. |

### D-007 — Recording storage

| Field | Value |
|-------|-------|
| **Decision** | Cloudflare R2 recording target; begin with Supabase Storage free |
| **Status** | **Accepted as architecture** (owner-complete direction). Not production/go-live accepted. |
| **Rationale** | Owner selected Cloudflare R2 as the recording storage target. Begin with Supabase Storage free tier for initial evaluation; migrate to R2 when needed. This replaces the earlier browser-MediaRecorder-only approach. Production go-live additionally requires authenticated streaming upload, server-side Egress evaluation (REC-02), consent linkage, integrity provenance, retention compliance, DPA/region evidence, and Legal approval. |
| **Cost posture** | Supabase Storage free = $0 initially. Cloudflare R2 free tier = $0. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: Recordings stored in R2 or Supabase Storage with authenticated access, integrity, retention compliance. |
| **Production-revisit trigger** | Q-09 recording requirements defined; consent/auth/storage/retention/residency/reliability gates cleared. |

### D-008 — SIEM/log aggregator

| Field | Value |
|-------|-------|
| **Decision** | Axiom free tier, PII-redacted at emission; US-hosted Legal nod pending |
| **Status** | **Accepted as architecture** (owner-complete direction). Not production/go-live accepted. US-hosted Legal nod is pending. |
| **Rationale** | Owner selected Axiom free tier for log aggregation. PII is redacted at emission. Replaces the earlier OCI Observability direction. Production go-live additionally requires a US-hosted Legal nod (acknowledgement that Axiom US hosting is acceptable) and Security Lead sign-off on log coverage. |
| **Cost posture** | Axiom free tier = $0. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: PII-redacted emission verified; US-host Legal nod documented; Security Lead sign-off. |
| **Production-revisit trigger** | US-host Legal nod obtained; Security Lead assigned; log coverage requirements defined. |

### D-009 — PII retention period

| Field | Value |
|-------|-------|
| **Decision** | Owner direction: retain by default indefinitely ('store everything, never delete') |
| **Status** | **Owner direction recorded — NOT Legal-approved retention.** Production blocked until Legal DPDP storage-limitation/lawful-basis document is completed. |
| **Rationale** | Owner direction is to retain by default indefinitely: recordings/logs to R2/Oracle object storage, transcripts/scores/PII in Supabase then offload to object storage near free cap. This is NOT Legal-approved retention. Legal DPDP storage-limitation/lawful-basis document is in preparation and gates go-live. Valid erasure requests MUST still delete via GOV-04/GOV-05; this must never be rewritten as literal no-deletion. |
| **Cost posture** | Object storage costs for indefinite retention; Supabase Free 500MB/1GB limits constrain primary storage. |
| **Verification trigger** | Owner direction recorded. Production: Legal DPDP storage-limitation document completed and signed. |
| **Production-revisit trigger** | Legal Counsel assigned; DPDP applicability assessment complete; retention period documented and signed. |

### D-010 — DPDP consent mechanism

| Field | Value |
|-------|-------|
| **Decision** | Owner direction: combined consent; includes AI interviewer, recording, purpose, processors (in-region), retention summary, rights, decline |
| **Status** | **Owner direction recorded — NOT Legal-approved consent.** Legal confirmation pending. Grievance mechanism marked possible DPDP gap. |
| **Rationale** | Owner direction specifies combined consent: approved notice content includes AI interviewer, recording, purpose, processors (all in-region India except Axiom US for redacted operational logs), retention summary, candidate rights, and ability to decline. Legal confirmation of this approach is pending. Grievance mechanism is noted as a possible DPDP gap. Job-portal consent only counts if the portal notice specifically discloses AI interview, recording, and cross-border purposes (GOV-10 assumption); generic application consent is NOT sufficient. |
| **Cost posture** | Implementation cost for consent UI/flows; zero incremental infra cost. |
| **Verification trigger** | Owner direction recorded. Production: Legal Confirmation; GOV-08/GOV-09/GOV-10 implemented and tested. |
| **Production-revisit trigger** | Legal Counsel assigned; DPDP applicability assessment complete; consent mechanism defined and signed. |

### D-011 — Tenancy model

| Field | Value |
|-------|-------|
| **Decision** | Single-org IK India, admin/interviewer/viewer, no org_id |
| **Status** | **Accepted as architecture** (owner-complete direction). ADR-0005 accepted. Not production/go-live accepted. |
| **Rationale** | Owner selected single-org tenancy model for Interview Kickstart India, with admin/interviewer/viewer roles and no org_id field. The merged membership-gated RLS baseline (PR #9) provides the local implementation. Production additionally requires a complete authorization matrix, representative RLS/Realtime/storage tests, migration impact assessment, and named organization administration. |
| **Cost posture** | Zero cost. Supabase Free with existing RLS policies. |
| **Verification trigger** | Owner: architecture direction confirmed. Production: full authorization matrix documented; cross-recruiter isolation tests pass. |
| **Production-revisit trigger** | Named Product Manager and Security Lead assigned; full authorization matrix documented; multi-tenancy requirements (if any) defined. |

---

## LiveKit worker status

The LiveKit Agents worker (`app/voice-livekit/`) is the **current active runtime** for internal engineering. Pipecat and Retell implementations (`app/voice/`) are **stale/reference only** — not to be used as active development targets. Telephony (PSTN, SIP) is **explicitly future** and separately gated; the current browser-only MediaRecorder path is the only approved capture mechanism.

---

## Real-candidate data and production launch

**No decision in this record authorises:**
- Real candidate data collection, processing, or storage
- Production launch of any kind
- Paid cloud provisioning
- Legal, Security, or compliance sign-off
- India residency determination or DPDP compliance claims
- Vendor DPA acceptance
- Production RPO/RTO acceptance
- Provider production suitability determination

All of the above remain **explicitly blocked** and require separate signed records from the appropriate accountable roles (Engineering Lead, Product Manager, Security Lead, Legal Counsel).

---

## FND-05 / FND-06 status

FND-05 (secret manager): owner selected self-hosted Infisical on Oracle Mumbai ($0), runtime injection/sync to fly.io/Vercel/GitHub Actions, rotation/audit, no persistent production .env. **Selection is complete; deployment/security evidence pending.**

FND-06 (service identities): owner selected distinct least-privilege identities for AI worker/API/web build/CI-CD/scoring worker; remove service_role from all clients. **Selection is complete; execution blocked on deployed FND-05.**

Both are accepted as architecture/owner direction. Neither is production/go-live accepted. The existing `infra/oracle/` Terraform scaffold (Vault/KMS/IAM) is superseded by the Infisical selection; the scaffold may still inform architecture but will not be applied as-is.

---

## ADR cross-reference

| ADR | Title | Owner-Approval Status | ADR Status |
|-----|-------|-----------------------|------------|
| ADR-0002 | Current voice and model runtime | Internal engineering runtime confirmed | Accepted (no change) |
| ADR-0003 | Recruiter authentication provider | **Accepted as architecture** (owner-complete). Production not accepted. | **Accepted** (updated) |
| ADR-0004 | Durable post-session job queue | **Accepted as architecture** (owner-complete: pg-boss). Production not accepted. | **Accepted** (updated) |
| ADR-0005 | Launch tenancy model | **Accepted as architecture** (owner-complete: single-org IK India). Production not accepted. | **Accepted** (updated) |
| ADR-0006 | Recording capture and storage | **Accepted as architecture** (owner-complete: Cloudflare R2 target, Supabase Storage free start). Production not accepted. | **Accepted** (updated) |
| ADR-0007 | Production deployment and region | **Accepted as architecture** (owner-complete: OCI Always-Free Mumbai). Production not accepted. | **Accepted** (updated) |

All six ADRs are now accepted as architecture/owner direction. None are production/go-live accepted.

---

## Handoff summary

| Item | Status |
|------|--------|
| Mem0 recall count | Initial attempt unavailable; scoped repair returned 5 entries |
| Files created | `docs/decisions/fnd-08-owner-approval.md` |
| Files updated | `docs/decisions/fnd-08-inputs.md`, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007 |
| ADRs created | 0 |
| ADRs modified | 6 (all updated to Accepted as architecture) |
| Decisions accepted as architecture | D-001 (Supabase Auth), D-002 (pg-boss), D-003 (OCI Always-Free Mumbai), D-004 (DeepSeek V4 Pro via Ikey), D-005 (self-host LiveKit Mumbai), D-006 (pg_dump→R2, RPO24h/RTO8h), D-007 (R2 target, start Supabase Storage), D-008 (Axiom), D-011 (single-org IK India) |
| Owner direction recorded (NOT Legal-approved) | D-009 (retain indefinitely), D-010 (combined consent) |
| FND-05/FND-06 | Selected (Infisical + least-privilege identities); deployment/execution pending |
| Production blockers unchanged | All D-items and Legal/Security/residency evidence per `fnd-08-inputs.md` § "Missing — Blocks FND-08 Acceptance" remain unresolved |

## Residual risks

1. **No independent Security review** — every accepted architecture decision lacks Security Lead sign-off. A Security finding later may invalidate architectural assumptions.
2. **No Legal input on data classification/retention** — D-009 owner direction (indefinite retention) is NOT Legal-approved. If real candidate data is introduced accidentally, no approved retention, consent, or DPDP framework exists.
3. **Redaction test optional** — Pre-egress name/phone/email stripping is optional GOV-02 defense-in-depth, owner-run, not a hard go-live blocker. Model-license/IP commercial-use check for self-hosted DeepSeek weights is a minor non-data-protection follow-up.
4. **Supabase Free constraints** — no PITR, 500MB DB/1GB storage, ~7-day inactivity pause, 2 active projects/org (sequential old/new/rehearsal). These bound all architecture decisions.
5. **Infisical not deployed** — FND-05 selection is complete but deployment/security evidence is pending, blocking FND-06 and all dependent production work.
6. **Axiom US-host Legal nod pending** — log aggregation direction is accepted but US hosting requires Legal acknowledgement.
7. **Memory is advisory** — the scoped repair recalled five entries, but repository evidence and the owner's explicit confirmation remain authoritative.
