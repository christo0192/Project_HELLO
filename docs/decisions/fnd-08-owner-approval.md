# FND-08 Sole-Owner Decision Record — Internal Engineering Approval

**Record type:** Engineering/Product owner approval — not Legal Counsel, not Security Lead, not independent reviewer

**Owner:** Single Product/Engineering owner (repository owner / sole contributor)

**Date:** 2026-07-29

**Mem0 recall:** Initial implementation recall was unavailable; the scoped repair recall returned 5 entries. Repository decisions remain evidence-led rather than memory-led.

**Predecessor:** `docs/decisions/fnd-08-inputs.md` (2026-07-28) — selected technical directions, no formal owner approval

**Authorization boundary:** This record authorises **internal synthetic browser-only engineering evaluation**. It does **NOT** authorise real candidate data, paid cloud provisioning, production launch, or any commitment that implies stakeholder/Legal/Security sign-off. Production acceptance of any decision requires a separate signed record from all four accountable roles (Engineering Lead, Product Manager, Security Lead, Legal Counsel).

---

## Cost posture

This record adopts a strict **no-cost posture** for all approved internal-engineering decisions:

- Prefer existing local Supabase Docker, browser MediaRecorder/Web Audio API, current LiveKit development path (local agents worker, free-tier dev cloud where already provisioned), and offline/open-source tooling.
- Do not provision paid cloud tiers or commit to free-tier guarantees as permanent contracts.
- Do not apply unapproved OCI Terraform scaffolds (`infra/oracle/` — FND-05/FND-06 remain parked/pending; scaffold is unapplied).
- Do not create new paid accounts or upgrade existing ones for internal engineering.

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
| **Decision** | Supabase Auth |
| **Status** | **APPROVED FOR INTERNAL ENGINEERING** — BLOCKED FOR PRODUCTION |
| **Rationale** | Supabase Auth with local Docker (email/password, session management, RLS integration) is zero-cost and sufficient for synthetic browser-only evaluation with dummy recruiters. Production requires MFA enforcement, SSO support, account lifecycle policies, session revocation, audit events, DPA/subprocessor review, and a named operational owner — none of which the sole Product/Engineering owner can unilaterally approve. |
| **Cost posture** | Local Supabase Docker = zero cost. No cloud Supabase project upgrade. |
| **Verification trigger** | Internal: recruiter can log in, create synthetic sessions, view synthetic scorecards. |
| **Production-revisit trigger** | Named Security Lead assigned; DPA evidence collected; MFA/SSO/audit requirements documented. |

### D-002 — Queue/worker platform

| Field | Value |
|-------|-------|
| **Decision** | Provider-neutral outbox pattern; OCI Queue direction noted |
| **Status** | **DEFERRED** |
| **Rationale** | The current synchronous scoring path (LiveKit worker → API → `claude -p`) is adequate for synthetic evaluation with low concurrency. No durable queue is required until scoring must survive worker restart or scale beyond 1–2 concurrent sessions. OCI Queue remains the technical direction for production but is not actionable while OCI is unprovisioned and no-cost requirement holds. |
| **Cost posture** | Zero cost — maintain synchronous path. No OCI Queue provisioning. |
| **Verification trigger** | N/A — deferred. |
| **Production-revisit trigger** | Concurrency target defined; first scoring durability failure observed; OCI tenancy available. |

### D-003 — Cloud provider + region

| Field | Value |
|-------|-------|
| **Decision** | OCI (Mumbai/Hyderabad benchmark required for production); all internal = local |
| **Status** | **DEFERRED** |
| **Rationale** | Internal engineering runs entirely locally (local Supabase Docker, local LiveKit agents worker). No cloud compute or region selection is needed. The OCI Terraform scaffold remains unapplied (FND-05/FND-06 parked). An owner-approved preliminary Mumbai/Hyderabad synthetic probe with teardown may run for region discovery but is not a priority and does not constitute DEP-01 acceptance. |
| **Cost posture** | Zero cost — local only. No OCI provisioning. If synthetic probe runs, owner must approve a minimal-cost, short-lived instance with teardown guarantee. |
| **Verification trigger** | N/A — deferred. |
| **Production-revisit trigger** | FND-08 residency/data-flow constraints defined; RPO/RTO targets set; named owners assigned; OCI tenancy access confirmed. |

### D-004 — Scoring provider/hosting

| Field | Value |
|-------|-------|
| **Decision** | Current `claude -p` CLI for synthetic scoring |
| **Status** | **APPROVED FOR INTERNAL ENGINEERING** — BLOCKED FOR PRODUCTION |
| **Rationale** | CLI-based scoring via `claude -p` is zero-cost and adequate for synthetic evaluation with small candidate volumes (single-digit sessions). Production requires an evaluated, compliant API/hosted alternative with contractual evidence, latency bounds, cost model, and DPA — gated behind LLM-03/LLM-04. The sole Product/Engineering owner cannot approve production scoring. |
| **Cost posture** | No incremental infrastructure spend. Existing Anthropic subscription/quota may be consumed and is not represented as permanently free; evaluation stops when existing quota is unavailable. |
| **Verification trigger** | Internal: scorecards are generated and stored for synthetic sessions. |
| **Production-revisit trigger** | LLM-03/LLM-04 evaluation required; independent Security review; contractual terms accepted. |

### D-005 — LiveKit hosting

| Field | Value |
|-------|-------|
| **Decision** | Current LiveKit development path (local agents worker, existing dev cloud project if already provisioned) |
| **Status** | **APPROVED FOR INTERNAL ENGINEERING** — BLOCKED FOR PRODUCTION |
| **Rationale** | The LiveKit agents worker runs locally for internal evaluation. A free-tier LiveKit Cloud project may be used if already provisioned with zero additional cost; no new paid accounts or upgrades. Production requires region availability, capacity, Egress support, DPA, and a hosting decision (Cloud vs self-host) — all gated behind FND-08. |
| **Cost posture** | Local = zero cost. Existing free-tier dev cloud project = zero additional cost. No new LiveKit Cloud account creation. |
| **Verification trigger** | Internal: synthetic recruiter→candidate conversation completes end-to-end. |
| **Production-revisit trigger** | FND-08 residency/data-flow constraints defined; LiveKit hosting D-005 formally opened; production concurrency target set. |

### D-006 — Backup strategy

| Field | Value |
|-------|-------|
| **Decision** | No backup strategy required for internal engineering |
| **Status** | **DEFERRED** |
| **Rationale** | Internal engineering uses synthetic data with no durability requirement. Loss of local Supabase data is acceptable. Production requires RPO/RTO definition, PITR verification, and a named owner decision on PITR-only vs PITR + snapshot export — none applicable until production launch is gated. |
| **Cost posture** | Zero cost. No backup provisioning. |
| **Verification trigger** | N/A — deferred. |
| **Production-revisit trigger** | RPO/RTO targets defined; MIG-10 migration rehearsal planned; production Supabase project activated. |

### D-007 — Recording storage

| Field | Value |
|-------|-------|
| **Decision** | Browser MediaRecorder + local ephemeral storage for prototype; LiveKit server-side Egress as production candidate |
| **Status** | **APPROVED FOR INTERNAL ENGINEERING** (browser MediaRecorder only, no-cost prototype) — BLOCKED FOR PRODUCTION |
| **Rationale** | Browser MediaRecorder with Web Audio API provides a zero-cost capture mechanism for synthetic evaluation. Recordings are ephemeral, stored locally or in-memory, and never represent real candidate data. Production recording requires authenticated streaming upload, server-side Egress evaluation (REC-02), consent linkage, integrity provenance, retention compliance, DPA/region evidence, and Legal approval — all blocked. |
| **Cost posture** | Zero cost. No storage provisioning. No Supabase Storage bucket creation for recordings. |
| **Verification trigger** | Internal: synthetic session audio is captured and replayable in local development. |
| **Production-revisit trigger** | Q-09 recording requirements defined; D-007 formally opened with signed owner; consent/auth/storage/retention/residency/reliability gates cleared. |

### D-008 — SIEM/log aggregator

| Field | Value |
|-------|-------|
| **Decision** | OCI managed observability (Logging, Monitoring, APM, Notifications) selected as production direction |
| **Status** | **DEFERRED** |
| **Rationale** | Internal engineering uses local stdout/stderr logging. No SIEM, log aggregation, or observability stack is required for synthetic evaluation. OCI Observability is noted as the production direction but is not actionable while OCI is unprovisioned. Security-log/SIEM acceptance is a separate process that the sole owner cannot complete. |
| **Cost posture** | Zero cost. No OCI Observability provisioning. |
| **Verification trigger** | N/A — deferred. |
| **Production-revisit trigger** | OCI tenancy available; Security Lead assigned; security-log requirements defined. |

### D-009 — PII retention period

| Field | Value |
|-------|-------|
| **Decision** | No PII retention policy applicable (synthetic data only) |
| **Status** | **BLOCKED FOR PRODUCTION** — deferred for internal engineering |
| **Rationale** | Internal engineering uses only synthetic, non-identifiable data. No real candidate PII is collected, stored, or processed. A PII retention period is a Legal determination that the sole Product/Engineering owner cannot provide. For internal purposes, no retention schedule is needed. Do not fabricate a retention period. |
| **Cost posture** | Zero cost. |
| **Verification trigger** | N/A — blocked until Legal input. |
| **Production-revisit trigger** | Legal Counsel assigned; DPDP applicability assessment complete; retention period documented and signed. |

### D-010 — DPDP consent mechanism

| Field | Value |
|-------|-------|
| **Decision** | No consent mechanism applicable (synthetic data only) |
| **Status** | **BLOCKED FOR PRODUCTION** — deferred for internal engineering |
| **Rationale** | Internal engineering uses synthetic, non-identifiable data with no consent requirement. A DPDP consent mechanism is a Legal determination that the sole Product/Engineering owner cannot provide. Do not fabricate a consent flow or DPDP assessment. |
| **Cost posture** | Zero cost. |
| **Verification trigger** | N/A — blocked until Legal input. |
| **Production-revisit trigger** | Legal Counsel assigned; DPDP applicability assessment complete; consent mechanism defined and signed. |

### D-011 — Tenancy model

| Field | Value |
|-------|-------|
| **Decision** | Single-organization launch model |
| **Status** | **APPROVED FOR INTERNAL ENGINEERING** — BLOCKED FOR PRODUCTION |
| **Rationale** | Single-org tenancy is sufficient for synthetic evaluation with dummy recruiters and synthetic candidates. The merged membership-gated RLS baseline (PR #9) provides an adequate local seam. Production requires a signed D-011 decision with complete authorization matrix, representative RLS/Realtime/storage tests, migration impact assessment, and named organization administration — all gated behind formal owner approval from all four roles. |
| **Cost posture** | Zero cost. Local Supabase Docker with existing RLS policies. |
| **Verification trigger** | Internal: synthetic recruiter sees only their synthetic sessions; no cross-recruiter data leak in local testing. |
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

FND-05 (approved secret manager/KMS and runtime secret injection) and FND-06 (least-privilege service identities) remain **parked/pending**. The existing `infra/oracle/` Terraform provides only partial Vault/KMS and IAM scaffolding and remains unapplied. No OCI resources have been provisioned, and no OCI tenancy access has been confirmed.

---

## ADR cross-reference

| ADR | Title | Owner-Approval Status | ADR Status Remains |
|-----|-------|-----------------------|--------------------|
| ADR-0002 | Current voice and model runtime | Internal engineering runtime confirmed | Accepted (no change) |
| ADR-0003 | Recruiter authentication provider | Internal engineering: APPROVED. Production: BLOCKED. | Proposed (no change) |
| ADR-0004 | Durable post-session job queue | DEFERRED — not needed for internal engineering | Proposed (no change) |
| ADR-0005 | Launch tenancy model | Internal engineering: APPROVED. Production: BLOCKED. | Proposed (no change) |
| ADR-0006 | Recording capture and storage | Internal engineering: APPROVED (browser MediaRecorder only). Production: BLOCKED. | Proposed (no change) |
| ADR-0007 | Production deployment and region | DEFERRED — all internal is local | Proposed (no change) |

No new ADR is required for this sole-owner decision. The ADR format remains valid and cross-references are consistent.

---

## Handoff summary

| Item | Status |
|------|--------|
| Mem0 recall count | Initial attempt unavailable; scoped repair returned 5 entries |
| Files created | `docs/decisions/fnd-08-owner-approval.md` |
| Files updated | `docs/decisions/fnd-08-inputs.md`, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007 |
| ADRs created | 0 |
| ADRs modified | 5 (cross-reference and owner-approval links only) |
| Decisions approved for internal engineering | D-001, D-004, D-005, D-007 (browser MediaRecorder only), D-011 |
| Decisions deferred | D-002, D-003, D-006, D-008 |
| Decisions blocked for production explicitly | D-009, D-010 (+ all D-items for production) |
| Production blockers unchanged | All items listed in `fnd-08-inputs.md` § "Missing — Blocks FND-08 Acceptance" remain unresolved |

## Residual risks

1. **No independent Security review** — every approved internal decision lacks Security Lead sign-off. A Security finding later may invalidate internal engineering assumptions.
2. **No Legal input on data classification** — synthetic-only posture is self-declared. If real candidate data is introduced accidentally, no retention, consent, or DPDP framework exists.
3. **LiveKit free-tier instability** — if a LiveKit Cloud dev project is used, the free tier may change terms or availability without notice. No-cost posture means no SLA.
4. **Browser MediaRecorder quality** — browser capture is adequate for prototype but may miss audio segments or produce inconsistent formats. This is acceptable for synthetic evaluation but does not inform production recording quality.
5. **OCI scaffold drift** — unapplied `infra/oracle/` Terraform may become stale relative to Supabase schema or application requirements. A refresh review will be needed before any apply.
6. **Memory is advisory** — the scoped repair recalled five entries, but repository evidence and the owner's explicit confirmation remain authoritative.
