# Production Readiness Plan — MVP to Production

**AI HR Voice-Screening Product**

---

> **Implementation status (2026-07-29):** Branch `feat/obs-01-02-logging-correlation` implements OBS-01/OBS-02 structured logging and correlation scaffolding across API and voice workers with local tests. This does **not** close deployed observability acceptance: managed log export, dashboards, alarms, SLOs, production correlation proof, and launch gates remain pending.

---

## 1. Document Control

| Field | Value |
|-------|-------|
| **Document status** | v1.0 production plan — technically reviewed; stakeholder approvals and open decisions pending |
| **Owner** | [Engineering Lead — placeholder] |
| **Reviewers** | [Security Lead — placeholder], [Product Manager — placeholder], [Legal Counsel — placeholder] |
| **Target** | Browser-first production launch (no PSTN) |
| **Non-goals** | Telephony/PSTN production (see Phase 13, §6.17); multi-tenant SaaS; mobile app |
| **Last updated** | 2026-07-29 |
| **Next review** | After owners are assigned and D-001 through D-011 receive initial decisions |

### Assumptions

1.  The user/org controls a billing account with Supabase, LiveKit Cloud, and Oracle Cloud Infrastructure (region TBD after Mumbai/Hyderabad benchmark).
2.  A Supabase production project already exists unused in Mumbai (`ap-south-1`). Company-controlled organization ownership evidence and access configuration pending; second MFA admin, plan, PITR, billing-alert, and break-glass acceptance are pending.
3.  Recruiter users will authenticate via Supabase Auth (direction selected; auth modes, MFA enforcement, lifecycle, and DPA evidence pending formal owner approval) — not phone-only.
4.  Candidate join flow remains browser-based; candidates do not authenticate (token-gated join).
5.  Browser-first production launch occurs before any telephony integration.
6.  DLT registration, consent automation, and legal review for outbound calling will gate the telephony phase (§6.17).
7.  India data residency is an open legal/security requirement, not a confirmed fact. During provisioning, verify whether an India region (Mumbai) is available from Supabase, LiveKit, and the compute provider. If an India region is unavailable for any critical service, escalate as a go/no-go decision with Legal and Eng Lead. Contractual and technical evidence of data region is required for every processor before launch (LLM-05, GOV-07).
8.  This document does not replace legal DPDP review; it identifies what legal must answer.

### Decision Log (Directions selected 2026-07-28; all formal approvals pending)

| ID | Decision | Owner | Status | Date |
|----|----------|-------|--------|------|
| D-001 | Auth provider: WorkOS vs Supabase Auth vs Clerk | Eng Lead + Product | Direction: Supabase Auth; formal approval pending | 2026-07-28 |
| D-002 | Queue/worker platform (Cloud Tasks, BullMQ+Redis, SQS, RabbitMQ) | Eng Lead | Direction: OCI Queue; formal approval pending | 2026-07-28 |
| D-003 | Production cloud provider and region for compute | Eng Lead + Legal + Security | Direction: OCI; Mumbai/Hyderabad region pending measured/legal evidence; formal approval pending | 2026-07-28 |
| D-004 | Scoring provider/hosting: current `claude -p` is prototype-only; an evaluated, compliant API/hosted alternative must be selected and approved before production (LLM-03/LLM-04) | Eng Lead + Legal | Open | — |
| D-005 | LiveKit: stay Cloud vs self-host; region availability TBD | Eng Lead | Open | — |
| D-006 | Backup strategy: PITR only vs PITR + daily snapshot export | Eng Lead | Open | — |
| D-007 | Recording storage: Supabase Storage vs S3-compatible | Eng Lead | Open | — |
| D-008 | SIEM/log aggregator choice | Eng Lead + Security | Direction: OCI managed observability (Logging/Monitoring/APM/Notifications); security-log/SIEM acceptance pending; formal approval pending | 2026-07-28 |
| D-009 | PII retention period (post-interview) | Legal | Open | — |
| D-010 | DPDP consent mechanism and record-keeping | Legal | Open | — |
| D-011 | Tenancy model: single-org launch vs org_id schema for future multi-tenancy | Eng Lead + Product | Direction: single-org launch; formal approval pending | 2026-07-28 |

---

## 2. Executive Summary

The current MVP demonstrates a working voice-screening loop: a candidate opens a browser link, LiveKit streams audio, an Anthropic Haiku agent conducts a structured interview, turns are persisted, a recording is uploaded from the browser, and a scorecard is generated via `claude -p`. The system produced a real end-to-end transcript, recording, and assessment.

**The current artifact is a prototype — not production.** It lacks authentication, authorization, rate limiting, audit trails, durable job processing, structured observability, CI/CD, IaC, credential hygiene, PII governance, reliability engineering, and a tested migration path. The repository has no Git history, `docs/HELLO.html` embeds real candidate PII, and service-role credentials sit in local env files.

> **Note:** The Current-vs-Target table below represents the original MVP audit
> baseline. For current implementation status (completed PRs, in-progress
> scaffolds, and remaining blockers), see `docs/HANDOVER.md`.

### Current vs Target

| Dimension | Current (MVP) | Target (Browser-First Production) |
|-----------|---------------|-----------------------------------|
| **Git** | None | Monorepo with protected branches, signed commits, pre-commit hooks |
| **Environments** | Local only | dev / staging / prod, fully separated |
| **AuthN** | None (open API, anon Supabase) | Recruiter SSO + MFA, candidate join tokens (JWT, short-lived) |
| **AuthZ / RBAC** | None | Recruiter roles (admin, interviewer, viewer); single-org isolation for launch or `org_id` isolation only if D-011 approves multi-tenancy |
| **LiveKit context privacy** | Candidate/resume/role/rubric context is serialized into room metadata | Worker-only context fetch; client-visible token/room metadata contains only minimal opaque identifiers |
| **API security** | No rate limits, limited validation, 100 MB in-memory multer | Input validation, rate limits, quotas, streaming uploads, security headers/CSP, strict CORS, and CSRF protection if cookie-based auth is chosen |
| **Secrets** | Local .env files only (no Git history); keys unrotated | KMS/Vault, CI-injected, least-privilege IAM, rotation. All existing keys rotated before first commit |
| **Supabase** | Single project, anon+service_role keys in local env files, basic blanket anon-read policies, 1-year recording URLs, PITR status unobserved, bucket privacy unverified | New company production project, tenancy-appropriate RLS tested, approved backup/PITR plan, configurable short-lived access, verified private buckets, region per Legal/Security decision |
| **Queue / jobs** | Direct scoring POST from agent close | Durable queue for post-session jobs; transactional outbox on durable state transitions; retries, dead-letter handling, and idempotent consumers |
| **Recording** | Browser AudioContext → WebM → unauthenticated POST | Server-side Egress MP3 + optionally browser upload, signed URLs, integrity hash |
| **Observability** | `console.log` | Structured redacted logs, metrics, traces, correlation IDs, dashboards, alerts, SLOs |
| **Testing** | Manual voice test | Unit, contract, integration, E2E voice, security, load/soak, chaos, backup/restore |
| **CI/CD** | None | GitHub Actions (or equiv), reproducible builds, migration gates, canary deploys |
| **PII governance** | Real PII in docs, no deletion, no DSAR | Data classification, encryption, retention, deletion, DSAR process, anonymized demos |
| **Responsible AI** | AI disclosure only | Human-in-loop, no auto-rejection, fairness testing, score calibration, appeal path |
| **Capacity** | Untested | Benchmarked, sized, HA decision documented |

---

## 3. Severity Definitions & Production Principles

### Severity

| Level | Definition | Example |
|-------|-----------|---------|
| **P0** | Block production launch; data loss, PII leak, auth bypass, total outage | Service-role key in browser; unauthenticated scoring endpoint; PII in public docs |
| **P1** | Degrades core flow or security posture; must fix before launch with documented exception | Missing rate limits; no audit log; no backup restore test |
| **P2** | Important for operations/quality; fix in first post-launch sprint | Dashboards; synthetic call schedules; admin UI polish |
| **P3** | Nice-to-have; backlog | Dark mode; advanced analytics |

For Phases 0–12, P0 blocks the browser-first launch. In Phase 13, P0 blocks **telephony only** and does not hold up an otherwise compliant browser launch.

### Production Principles

1.  **Security-first**: No unauthenticated write endpoints. Least privilege everywhere. Secrets never in code, logs, or client bundles.
2.  **Quality-first**: Every change has a test. Every migration has a rehearsal. Every PII path has a deletion.
3.  **Reliability-first**: Queues, not synchronous calls. Retries with backoff, not fire-and-forget. Graceful degradation, not total failure.
4.  **Observability-first**: You cannot fix what you cannot see. Structured logs, metrics, traces from day one.
5.  **Human-in-loop**: The system recommends; a human decides. No sole automated rejection.
6.  **Data minimization**: Collect only what's needed. Delete when retention expires. Anonymize for demos.
7.  **Compliance by design**: DPDP, consent, DLT gates are architectural constraints, not afterthoughts.

---

## 4. Target Architecture

### 4.1 Browser-First Production (Phase Target)

```
┌─────────────────────────────────────────────────────────┐
│                     Candidate Browser                     │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Join with │  │ LiveKit Room │  │ Recording consent│   │
│  │ JWT token │  │ (WebRTC)    │  │ (mandatory gate)│   │
│  └──────────┘  └──────────────┘  └──────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │ WebRTC (LiveKit)
┌───────────────────────▼─────────────────────────────────┐
│                   LiveKit Cloud / Self-Hosted             │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Room + Egress (approved server-side recording)  │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket
┌───────────────────────▼─────────────────────────────────┐
│       AI Worker (region selected after residency review) │
│  ┌────────────┐ ┌──────────┐ ┌───────────────────────┐  │
│  │ Sarvam STT │ │ Silero   │ │ LiveKit Multilingual  │  │
│  │ saaras:v3  │ │ VAD      │ │ Turn Detector         │  │
│  └────────────┘ └──────────┘ └───────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐   │
│  │  LLM (Haiku; Gemini 2.5 Flash-Lite evaluated,    │   │
│  │        gated by LLM-03 eval suite)                │   │
│  │  Prompt: Gopu system prompt + role/resume ctx    │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌────────────┐                                        │
│  │ Sarvam TTS │  bulbul:v3 / shubh                     │
│  └────────────┘                                        │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│  Job Queue   │ │  Scoring     │ │  Audit / Log     │
│  (durable)   │ │  Worker      │ │  Aggregator      │
│  durable +   │ │  (provider    │ │  (structured,    │
│  idempotency │ │   evaluated,  │ │  redacted,       │
│              │ │   gated by    │ │  correlated)     │
│              │ │   LLM-04)     │ │                  │
└──────┬───────┘ └──────┬───────┘ └────────┬─────────┘
       │                │                  │
       ▼                ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│               Supabase (Production Project)               │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ Auth/RBAC │ │ Database │ │ Storage  │ │ Realtime   │ │
│  │ (MFA)     │ │ (RLS)    │ │ (private)│ │ (scoped)   │ │
│  └───────────┘ └──────────┘ └──────────┘ └────────────┘ │
│  Backups/PITR per approved plan | private storage | region evidenced │
└─────────────────────────────────────────────────────────┘
       ▲                              ▲
       │                              │
┌──────┴──────────────────────────────┴───────────────────┐
│                    Recruiter Dashboard                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Approved │ │ Sessions │ │ Scorecard│ │ Admin      │  │
│  │ auth+MFA │ │ List     │ │ Review   │ │ Panel      │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘  │
│  HTTPS | CSP | authorized API calls | CSRF if cookies    │
└──────────────────────────────────────────────────────────┘
```

**Key changes from MVP:**
- All privileged and data-changing API endpoints require authentication and authorization. Only explicitly public endpoints (for example health and one-time candidate invite exchange) remain narrow, rate-limited, and non-enumerable.
- Candidate join uses short-lived JWT (not open LiveKit token endpoint).
- Scoring is async via durable queue, not synchronous POST from agent close.
- Recording uses a spiked and approved server-side Egress format/destination with integrity/provenance; browser upload is an optional hardened secondary path.
- Supabase moves to the new production project with tenancy-appropriate RLS, approved backup/PITR capability, verified private storage and authorized short-TTL access.
- Structured logging/metrics/traces to observability platform.

### 4.2 Future Telephony Architecture (Separately Gated)

```
┌──────────────────────────────────────────┐
│           PSTN / SIP Network              │
│  ┌──────────────┐  ┌───────────────────┐  │
│  │ Selected SIP │  │ Approved India   │  │
│  │ provider     │  │ carrier route    │  │
│  └──────┬───────┘  └────────┬──────────┘  │
│         │                   │             │
│         └────────┬──────────┘             │
│                  │ SIP                    │
└──────────────────┼───────────────────────┘
                   │
┌──────────────────▼───────────────────────┐
│ LiveKit deployment (Cloud or self-hosted; region evidenced) │
│  ┌──────────────────────────────────┐    │
│  │ SIP Trunk → Room → AI Worker     │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
         (rest same as browser path)
```

**Non-negotiable telephony gates (see §6.17):**
1.  Written Legal/vendor confirmation of the applicable DLT/UCC registration, consent, DND and evidence requirements for automated voice screening.
2.  Legal DPDP and recording review complete for outbound calling.
3.  Approved telephony provider account, India-capable route/number, verified business and tested SIP security.
4.  Legal-approved AI/recording disclosure and consent or opt-out flow validated before substantive screening begins.
5.  DND/opt-out controls maintained and checked before every outbound call.
6.  Calling-window enforcement defaults to the project's existing 10:00–19:00 IST constraint; days and final window require Legal approval.
7.  Emergency disable switch (authorized admin stops new calls and safely terminates active calls).
8.  Number reputation and carrier-failure monitoring.
9.  All browser-production gates in §4.1 remain green.

---

## 5. Phased Roadmap

### Phase Dependency Graph

```
Phase 0: Foundation + policy inputs
  ├─► Phase 1: Security Core ───────────────┐
  ├─► Phase 4: Reliability ─────────────┐   │
  ├─► Phase 5: Observability ─────────┐ │   │
  └─► Phase 6: Test/CI foundation ──┐ │ │   │
                                    │ │ │   ▼
Phase 1 + approved tenancy ─────────┼─┼─┴─► Phase 2: Supabase migration
Phase 1 + Phase 2 + Legal ──────────┼─┴────► Phase 3: Data governance
Phase 2 + Phase 4 ──────────────────┼──────► Phase 7: Recording
Phase 3 + Phase 5 + Phase 6 ────────┼──────► Phase 8: Voice quality
Phase 1 + Phase 3 ──────────────────┼──────► Phase 9: Product operations
Phase 3 + evaluation foundation ────┼──────► Phase 10: Model governance
Phase 5 + Phase 6 + load evidence ──┴──────► Phase 11: Deployment/capacity

All P0 tasks and evidence from Phases 0–11 ─► Phase 12: Browser launch
Stable browser production + telecom gates ─► Phase 13: Telephony (future)
```

Workstreams may run in parallel, but **Phase 12 has no shortcut**: every P0 task and launch gate must be complete. Supabase provisioning waits for Foundation policy inputs; cutover waits for security and migration rehearsals. Telephony remains outside browser-launch scope.

### Legend

- **S**: Severity (P0/P1/P2/P3). P0 = blocks launch.
- **Effort**: S (<1 wk), M (1–3 wk), L (3–6 wk), XL (6+ wk). T-shirt only; no dates.
- **Dep**: Task IDs this depends on.
- **Par**: Can run in parallel with these phases.

---

### Phase 0: Foundation (P0 — Blocks Everything)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **FND-01** | Initialize the Git monorepo without committing; add `.gitignore`, `CODEOWNERS`, branch protections and review rules | P0 | Eng Lead | — | S | Working tree is inventoried; secret-bearing `.env`, virtualenv, build output and recordings are ignored before the first commit; protected remote is configured | N/A |
| **FND-02** | Scan the entire working tree, remove secret/PII artifacts, and rotate every credential currently stored in local env files before the first commit; then enable `gitleaks`/equivalent in pre-commit and CI | P0 | Eng Lead + Security | FND-01 | S | Old credentials are revoked; working-tree scan is clean; first commit contains no secret or candidate PII; a seeded-secret test is blocked by pre-commit and CI | Credential-specific rollback is prohibited; issue another rotated credential if needed |
| **FND-03** | Quarantine and sanitize every shareable/demo artifact before first commit: `docs/HELLO.html`, `docs/HELLO.md`, `docs/hello-assets/**`, generated PDFs, recordings/scorecards and candidate-specific values in env examples; replace with synthetic or explicitly consented data | P0 | Security + Product | FND-01 | M | PII inventory/DLP and manual review find no real candidate data in shareable artifacts or history; original evidence is retained only in approved restricted storage under retention policy | Do not restore PII to the repository; recover restricted evidence only through authorized storage |
| **FND-04** | Define isolated dev/staging/prod configuration contracts. Clean each `.env.example` so it contains names, safe descriptions/defaults and unmistakable placeholders—no current project URL, candidate data or key-shaped sample | P0 | Eng Lead | FND-02 | S | CI compares code-read variables with examples/schema, rejects unknown/missing production config and proves no environment identifier/secret crosses environments | Revert config-schema change, never restore sensitive examples |
| **FND-05** | Provision an approved secret manager/KMS and move secrets out of local production files using workload identity or controlled runtime injection | P0 | Eng Lead + Security | FND-04 | M | Access policy, rotation, revocation and audit tests pass; no persistent prod `.env`, image, client bundle or CI output contains secrets | Roll back application release while retaining managed secrets; do not return to local prod files |
| **FND-06** | Create service accounts with least privilege for each component: AI worker, API server, web build, CI/CD, scoring worker | P0 | Eng Lead | FND-05 | S | Each component has dedicated creds with minimal IAM; service_role key deleted from all clients | Re-issue creds |
| **FND-07** | Document architecture decisions (ADR format) for current and target states | P1 | Eng Lead | — | S | ADRs in `docs/adr/` cover LLM, queue, auth, tenancy, storage and deployment decisions with evidence and supersession rules | N/A |
| **FND-08** | Resolve launch-blocking policy inputs: tenancy (D-011), residency/data-flow constraints, initial RPO/RTO, launch concurrency and accountable owners | P0 | Product + Legal + Security + Eng Lead | — | S | Signed decision record gives MIG/SEC/DEP teams testable requirements; unresolved mandatory residency or ownership question is a no-go | Reopen decision under change control |
| **FND-09** | Replace stale `.gsd`/README/architecture status with one maintained current-state source, ADR links and evidence dates; clearly label current versus target providers/recording/telephony | P1 | Eng Lead + Product | FND-01 | S | A reviewer can identify deployed version, current providers, runbooks and open gates without contradictory docs; doc check runs in release process | Revert inaccurate doc change |

---

### Phase 1: Security Core (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **SEC-01** | Implement recruiter authentication (Supabase Auth or provider per D-001): email/password + SSO, MFA enforcement | P0 | Backend Eng | FND-06 | M | Login flow works; MFA required; session tokens short-lived. Test: unauthenticated API calls rejected 401 | Disable MFA (not recommended) |
| **SEC-02** | Implement RBAC middleware on API: roles (admin, interviewer, viewer) with least-privilege access to sessions, candidates, assessments | P0 | Backend Eng | SEC-01 | M | Viewer can read but not create/delete; interviewer can manage own sessions; admin can manage org. Test: authorization matrix pass | Revert to open (not allowed) |
| **SEC-03** | Decide tenancy model (D-011), then enforce it in API queries and RLS: single-org launch with authenticated roles, or `org_id` scoping if multi-tenancy is approved | P0 | Backend Eng + Product | SEC-01 | M | Automated authorization matrix proves users cannot access data outside their approved scope; if multi-tenant, org A cannot access org B at API or DB layers | N/A |
| **SEC-04** | Implement revocable, one-time candidate invite exchange and short-lived LiveKit join grants scoped to one candidate/session/room | P0 | Backend Eng | SEC-03 | M | Invite cannot enumerate a session, expires, is single-use or safely replay-protected, can be revoked, and cannot join another room; recruiter issuance is authorized | Revoke and reissue invite |
| **SEC-05** | Add explicit schemas for body, params and query on every endpoint that accepts input; reject unknown fields where safe | P0 | Backend Eng | — | M | Malformed or oversized input returns a stable 4xx response without stack traces; fuzz/property tests cover security-sensitive endpoints | N/A |
| **SEC-06** | Rate limiting: per-user (recruiter), per-IP, per-endpoint. Token bucket or sliding window. 429 with Retry-After | P0 | Backend Eng | SEC-01 | S | Exceeding limits returns 429; limits configurable. Test: scripted burst → 429 | Adjust limits |
| **SEC-07** | Allowlist production dashboard origins exactly; add CSP in report-only mode, remove violations, then enforce it without unsafe directives unless documented | P0 | Backend Eng | — | M | Automated browser test from an unapproved origin cannot read responses; CSP report set is clean before enforcement; approved media/connect sources still work | Roll back only the offending CSP directive to report-only under incident approval |
| **SEC-08** | Choose auth transport; if cookies are used, apply Secure/HttpOnly/SameSite and CSRF tokens/origin checks to state changes. If bearer tokens are used, document the CSRF threat decision and XSS controls | P0 | Backend Eng + Security | SEC-01 | S | Threat-model test demonstrates cross-site state changes fail for the selected transport | N/A |
| **SEC-09** | Security headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS | P0 | Backend Eng | — | S | `curl -I` shows all headers. Mozilla Observatory score ≥ B+ | N/A |
| **SEC-10** | Dependency scanning: lockfile-aware scanner/Dependabot-equivalent in CI; block unaccepted critical/high vulnerabilities | P0 | DevSecOps | FND-01 | S | CI produces SBOM and blocks a seeded policy-violating vulnerability; exceptions require owner, compensating control and expiry | Patch, pin or replace dependency |
| **SEC-11** | Container image scanning (if containerized): Trivy or Grype in CI | P0 | DevSecOps | — | S | Images scanned; critical CVEs block deploy | Fix base image |
| **SEC-12** | Implement append-only security/business audit events for authentication, authorization failure, consent, invite/token issuance, recording access, candidate status, admin, deletion and configuration changes | P0 | Backend + Security | SEC-01, OBS-01 | M | Events include actor/action/target/result/correlation/time without transcript/secret leakage; tamper/access controls and retention are tested; Security can answer who changed what | Disable affected privileged operation if audit sink fails according to policy |
| **SEC-13** | Remove candidate/resume/question/scoring context from client-visible LiveKit room, participant and token metadata; deliver worker-only context through an authenticated server-to-worker mechanism with minimized identifiers | P0 | Backend + Security | SEC-03, SEC-04 | M | Candidate client inspection cannot read resume facts, interview rubric or internal context; worker still receives authorized context; metadata leak regression test passes | Disable new-room creation and revert only to the last non-leaking context path |
| **SEC-14** | Harden resume ingestion: authenticated/session-authorized upload, streaming quotas, extension/MIME/magic validation, archive/decompression limits, sandboxed parsers with CPU/memory/time limits, malware scanning, private raw storage and untrusted-text handling | P0 | Backend + Security | SEC-05, SEC-06 | M | Polyglot, zip-bomb, oversized, malformed PDF/DOCX, parser-timeout and cross-role fixtures fail safely with bounded resources; valid supported files parse and retain correct provenance | Disable affected format or all uploads |

---

### Phase 2: Supabase Production Migration (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **MIG-01** | When credentials are provided, create a new production Supabase project in a company-controlled organization under the new production email. Select region, plan and backup/PITR tier only after Legal/Security requirements and vendor availability are evidenced | P0 | Infra/DB Admin + Security | FND-08 | S | Project reference is recorded only in the secret/config system; at least two MFA admins and a tested break-glass procedure exist; region and backup capabilities have written evidence | Delete only the unused new project; never alter the old project |
| **MIG-02** | Configure organization/team access with least privilege, MFA, billing alerts and audit ownership; avoid shared logins and single-person ownership | P0 | Infra/DB Admin | MIG-01 | S | Access review shows named users and minimum roles; unauthorized account test fails; break-glass use alerts Security | Remove incorrect memberships while preserving two admins |
| **MIG-03** | Produce and harden a versioned logical schema baseline covering schemas, extensions, types, tables, FK/delete behavior, NOT NULL/CHECK/unique constraints, indexes, sequences, functions, triggers, grants, RLS, publications, storage configuration and adopted Auth/Edge Functions | P0 | DB Admin | MIG-02, FND-02 | M | Fresh project builds from migrations; schema diff has no unexplained change; integrity/index review covers event IDs/order, lifecycle/status, speaker values and hot query/FK paths; forward and safe rollback/roll-forward behavior is documented | Recreate the new project from the last approved baseline |
| **MIG-04** | Apply least-privilege grants and RLS for the tenancy choice in D-011 across all exposed tables/views; remove current blanket anon-read policies | P0 | DB Admin + Security | MIG-03, SEC-03 | M | Role/tenancy policy test matrix passes using anon, authenticated role fixtures and backend service identities; no cross-scope read/write is possible | Roll back only in non-production; never disable RLS as a production fallback |
| **MIG-05** | Configure Realtime only for flows retained by the product, including session, transcript and assessment updates currently used by the dashboard; authorize and filter each channel/table | P0 | DB Admin + Frontend | MIG-04 | S | Authorized candidate/recruiter receives only its expected updates; unauthorized session/table subscriptions return no data; publication list matches documented consumers | Disable affected subscription and fall back to authorized polling |
| **MIG-06** | Verify every storage bucket is private and serve recordings through an authorized API using an owner-approved short TTL; test revocation and prevent durable signed URLs in database rows | P0 | DB Admin + Backend | MIG-01, SEC-02 | M | Public/direct object access fails; authorized access expires at configured TTL; revoked user cannot mint a URL; DB stores object key, not long-lived URL | Disable downloads while fixing access policy |
| **MIG-07** | Build a typed logical export/import process (for example custom-format `pg_dump`/`pg_restore` plus explicit storage/Auth tooling) that preserves UUIDs, JSON, timestamps, foreign keys and sequence values; encrypt temporary exports | P0 | DB Admin | MIG-03, GOV-01 | M | Export manifest records schema version, table counts, canonical per-table digest and sequence state; encrypted artifact access is audited and expires | Destroy temporary export and rerun from source |
| **MIG-08** | Import into an isolated rehearsal project in dependency-safe order, restore constraints/sequences, and reconcile canonical counts/digests plus representative relational queries | P0 | DB Admin + QA | MIG-07 | M | Automated reconciliation has zero unexplained differences; FK/orphan checks and application smoke queries pass; any accepted transformation is signed off | Reset rehearsal project and repeat |
| **MIG-09** | Migrate storage using a manifest of object key, size, content type and cryptographic digest; stream-copy objects and verify each destination object | P0 | DB Admin | MIG-06, MIG-08 | M | Source/destination manifests reconcile with zero missing or corrupt objects; failures are replayable without duplicates | Re-copy failed objects; source remains untouched |
| **MIG-10** | Rehearse the complete runbook at production-like volume until the owner-approved number of consecutive clean runs is achieved; measure freeze, cutover and rollback times | P0 | DB Admin + SRE | MIG-08, MIG-09 | M | Signed rehearsal report meets proposed RTO/RPO and records exact commands, owners, stop conditions and rollback decision point | N/A |
| **MIG-11** | Select and test final consistency strategy: maintenance/write freeze with final export, or initial copy plus controlled delta capture and final freeze. Block new calls before the final sync | P0 | DB Admin + Product | MIG-10 | M | Rehearsal proves no writes are omitted; final canonical reconciliation runs after freeze/delta drain; candidate-facing maintenance behavior is tested | Lift freeze and continue on old project |
| **MIG-12** | Deploy the new project's credentials from the secret manager to staging/prod configuration without revoking old-project credentials; validate key scope and service startup | P0 | DB Admin + SRE | MIG-11, FND-05 | S | New project keys work only in intended services; no secret appears in logs/builds; old project remains available for rollback during the approved window | Redeploy old configuration |
| **MIG-13** | Execute cutover under change control: block new calls, finalize data/object sync, reconcile, switch configuration, deploy, run E2E smoke call, then reopen traffic with enhanced monitoring | P0 | Eng Lead + DB Admin | MIG-11, MIG-12 | M | Signed no-data-loss report; reads/writes/realtime/recording/scoring use only new project; P0 monitors remain green through observation window | Stop new traffic, restore old configuration, reconcile any new-project writes back under the tested rollback runbook |
| **MIG-14** | Maintain a time-bounded rollback window in which the old project and credentials remain intact but tightly access-controlled; define how writes made after cutover are reversed or reconciled | P0 | Eng Lead + DB Admin | MIG-13 | S | Go/no-go owner closes rollback only after the configured stability window and reconciliation pass; rollback drill demonstrates bounded data recovery | Execute MIG-13 rollback procedure |
| **MIG-15** | After rollback closes, revoke old keys, export/archive or delete data according to Legal retention, remove integrations, and decommission the old project with dual approval | P1 | Security + DB Admin + Legal | MIG-14, GOV-04 | S | Dependency scan shows zero old-project traffic; old credentials fail; archive/deletion evidence and approval are retained | Decommission is irreversible; restore only from approved archive if legally permitted |

---

### Phase 3: Data Governance & PII (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **GOV-01** | Data classification inventory: classify every column in every table (PII, sensitive, internal, public). Document in `docs/data-classification.md` | P0 | Eng Lead + Legal | MIG-03 | S | Every column classified; rationale documented | N/A |
| **GOV-02** | PII minimization review: identify columns that can be omitted, truncated, or tokenized. Apply to schema | P0 | Eng Lead | GOV-01 | M | Schema changes made; data migration validated | Schema rollback |
| **GOV-03** | Verify vendor encryption at rest/in transit, then threat-model whether field encryption or tokenization is required for phone/email; design key rotation and search/index trade-offs before implementation | P0 | Security + Backend Eng | FND-05, GOV-01 | M | Encryption evidence and threat-model decision approved; if field encryption is chosen, plaintext is unavailable to unauthorized DB roles and key access/rotation is tested | Restore prior schema only through reviewed migration |
| **GOV-04** | Define retention, legal-hold and backup-aging rules per data class; implement idempotent restriction/soft-delete/hard-delete jobs with processor propagation | P0 | Backend Eng + Legal | GOV-01, REL-01 | M | Synthetic expired and held records follow different approved paths; deletions complete within policy SLA and remain auditable without retaining deleted content | Pause job; restore only an erroneous deletion within approved grace and policy |
| **GOV-05** | Implement a legally approved data-subject access/correction/deletion workflow with identity verification, legal-hold checks, processor propagation, audit evidence and backup-expiry handling | P0 | Backend Eng + Legal | GOV-01, GOV-04 | M | Synthetic request exports all in-scope data, deletes or restricts it according to policy, propagates to storage/processors, records exceptions/legal holds, and ages out of backups on schedule | Restore only an erroneous deletion during approved grace period |
| **GOV-06** | Anonymized demo data: create seed script with synthetic candidates, roles, sessions, transcripts, and assessments. All demo/screenshot data uses this | P0 | Eng Lead | — | S | Running seed script populates DB with zero real PII. Demo screenshots verified clean | N/A |
| **GOV-07** | DPDP compliance review: engage legal counsel for DPDP Act 2023 applicability. Review consent mechanisms, data processing agreements (DPAs) with vendors (LiveKit, Sarvam, Anthropic, Supabase) | P0 | Legal | — | L | Legal memo confirming compliance posture or listing remediation items. All vendor DPAs signed | N/A |
| **GOV-08** | Implement Legal-approved, accessible AI/recording/data-use consent or acknowledgement before room join; no pre-ticked consent. Store minimal evidence: policy version, session/actor, timestamp, method and outcome | P0 | Frontend + Backend + Legal | GOV-07 | M | Without required evidence the join exchange fails; decline works without dark patterns; evidence is queryable and changes are audited; extra device/IP data is collected only if justified | Disable screening/recording |
| **GOV-09** | Publish versioned, accessible privacy notice and candidate/recruiter terms; implement cookie consent only where legally applicable | P0 | Legal + Product | GOV-07 | M | Legal-approved pages are linked before data collection; accepted version is evidenced; withdrawal/contact path works | Revert to prior approved version |
| **GOV-10** | Separate application/resume lawful basis from AI interview, recording and future outbound-call permissions; remove the current assumption that a job application itself proves all downstream consent | P0 | Legal + Backend + Product | GOV-07, GOV-08 | M | Purpose/consent matrix maps each processing activity to approved basis and evidence; `job_application` alone cannot unlock recording or outbound dialing; withdrawal/expiry tests pass | Disable affected processing purpose |

---

### Phase 4: Reliability Engineering (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **REL-01** | Durable job queue: provision queue infrastructure (per D-002). All async work (scoring, recording processing, notifications, data deletion) goes through queue | P0 | Backend Eng | FND-06 | L | Queue provisioned; dead-letter queue configured; message persistence confirmed. Test: kill worker mid-job → job retried, not lost | N/A |
| **REL-02** | Make transcript ingestion durable and ordered: assign stable event IDs and source sequence, enforce uniqueness/order constraints, use idempotent inserts/upserts, buffer transient events durably, and reconcile against LiveKit/session history where available | P0 | Backend Eng | REL-01, MIG-03 | L | Duplicate/out-of-order event tests produce one correctly ordered transcript; worker/network termination test stays within approved data-loss objective; reconciliation repairs a seeded gap | Disable ingestion and preserve source events for replay |
| **REL-03** | Use a transactional outbox when a committed DB state transition must emit scoring, recording-processing or notification jobs; make all consumers idempotent and accept at-least-once delivery | P0 | Backend Eng | REL-01 | M | Kill process between commit and publish: outbox publishes later; duplicate delivery produces one effective score/notification while preserving audit evidence | Pause consumers and replay from outbox/DLQ |
| **REL-04** | Retry policy with exponential backoff + jitter. Max retries per job type. Dead-letter queue for exhausted retries with alert | P0 | Backend Eng | REL-01 | S | Fail worker 3 times → job lands in DLQ → Slack/email alert. DLQ replay tool available | N/A |
| **REL-05** | Provider timeouts: Sarvam STT/TTS, Anthropic/Gemini, DeepSeek — all calls have explicit timeouts (configurable). Circuit breaker after N consecutive failures, half-open probe | P0 | Backend Eng | — | M | Sarvam down → circuit opens → graceful degradation (log, alert, inform candidate). Circuit closes after provider recovers | N/A |
| **REL-06** | Fallback decisions: document fallback chains for each provider. E.g., Sarvam STT fails → alternative STT or graceful session end. LLM fails → scripted close message. No silent failures | P0 | Eng Lead | REL-05 | S | Fallback decision tree documented; each branch tested | N/A |
| **REL-07** | Define and enforce session states/transitions, terminal reasons and ownership for created, waiting, in-progress, completed, failed, cancelled and expired states | P0 | Backend Eng | — | M | Invalid transitions fail safely; normal and failure paths reach one audited terminal state; force-killed sessions are resolved by reconciliation within SLO | Roll back state-machine release with compatible DB migration |
| **REL-08** | On SIGTERM stop accepting work, drain within a configured grace period, persist/flush durable state, safely close or mark active sessions, then terminate; never wait indefinitely to finish a conversational turn | P0 | Backend Eng | REL-02, REL-07 | M | Termination tests at each lifecycle state meet the approved shutdown budget and leave no silent stuck session or unacknowledged job | Roll back deployment; reconciliation repairs state |
| **REL-09** | Reconcile stuck sessions, orphaned rooms, transcript gaps, missing recordings and overdue scorecards on an owner-approved cadence with alert and safe replay tools | P0 | Backend Eng | REL-02, REL-03, REL-07 | M | Seeded inconsistencies are detected within the SLO and repaired or quarantined with complete audit trail | Pause automated repair and run read-only detection |

---

### Phase 5: Observability (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **OBS-01** | Structured logging: JSON-formatted logs with correlation ID, session ID, component, level, message. PII redaction at log emission (never logged) | P0 | Backend Eng | — | M | Every log line has `correlationId`. Grep logs for known PII pattern → zero results. Redaction tested | N/A |
| **OBS-02** | Correlation ID propagation: API → Worker → Queue → Scoring and relevant persisted event metadata. Passed via trace context/HTTP headers and queue metadata | P0 | Backend Eng | OBS-01 | M | One session → one correlation ID across all services. Query logs by correlation ID → complete trace | N/A |
| **OBS-03** | Metrics: request rate, error rate, latency (p50/p95/p99), queue depth, circuit breaker state, provider latency, session duration, STT/TTS latency, scoring time. Export to metrics platform | P0 | Backend Eng | — | M | Metrics dashboard shows all indicators. Test: generate load → metrics reflect | N/A |
| **OBS-04** | Distributed tracing: spans for each service boundary (API→Worker, Worker→STT, Worker→LLM, Worker→Queue, Queue→Scoring). Export to tracing backend | P0 | Backend Eng | OBS-02 | M | Trace view shows waterfall for one session end-to-end | N/A |
| **OBS-05** | SLI/SLO definition: define SLIs (availability, latency, transcript accuracy proxy, scoring freshness). Set SLOs (e.g., 99.5% session completion, p95 latency < X). Error budgets | P0 | Eng Lead + Product | OBS-03 | S | SLI/SLO document approved. Error budget dashboard live | N/A |
| **OBS-06** | Alerting: P0 alerts (service down, high error rate, queue backed up, circuit open, PII leak detected) → on-call. P1 alerts (latency degradation, approaching error budget) → Slack. Alert runbooks | P0 | DevSecOps | OBS-05 | M | Trigger each alert condition → notification received within SLA. Runbook exists for each alert | N/A |
| **OBS-07** | Run synthetic browser calls with synthetic data on a cadence selected from cost, quota and detection-time objectives; measure room → transcript → recording → scorecard | P1 | QA/Backend | OBS-06 | M | Approved schedule is documented; success rate and cost are visible; a seeded failure alerts within the detection SLO | Reduce cadence or disable under change control if vendor cost/abuse risk rises |
| **OBS-08** | Error budget policy: when budget is exhausted, freeze risky feature deploys and prioritize recovery/reliability according to an approved policy | P1 | Eng Lead | OBS-05 | S | Policy, exception authority and CI/release integration are documented and exercised | N/A |
| **OBS-09** | Create incident response and breach/privacy escalation runbooks with severity, roles, evidence preservation, vendor contacts, candidate/regulator communication decision points and postmortem process; run a tabletop | P0 | Security + SRE + Legal | OBS-01, OBS-06, SEC-12 | M | Tabletop for auth compromise, PII exposure and provider outage meets response/notification decision SLO; actions are tracked to closure | N/A |

---

### Phase 6: Testing & CI/CD (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **TST-01** | Add risk-based unit/property tests for auth, RBAC, validation, state transitions, scoring determinism, consent and token issuance; set and ratchet owner-approved coverage thresholds without using coverage alone as quality evidence | P0 | All Eng | SEC-05, REL-07 | L | Critical branch/mutation criteria are met, known security boundary cases pass, and CI blocks regressions below the approved baseline | N/A |
| **TST-02** | Contract tests: API endpoints tested against OpenAPI schema. Worker ⇄ Queue message schema. DB schema migration tests | P0 | Backend Eng | — | M | Schema change PR includes contract test; breaking change detected in CI | N/A |
| **TST-03** | Integration tests: API ↔ DB ↔ Queue ↔ Worker with emulated providers. Test happy path + error paths | P0 | Backend Eng | REL-01 | M | Full session flow test passes: create → join → transcript → score. Provider errors tested with mock | N/A |
| **TST-04** | E2E voice tests: automated browser (Playwright/Puppeteer + WebRTC) makes real voice call with synthetic audio. Verifies transcript, recording, scorecard | P0 | QA/Backend | TST-03 | L | E2E test passes in CI; recording and scorecard validated | N/A |
| **TST-05** | Run authenticated/unauthenticated DAST, SAST, dependency/container, secret, authorization/RLS and upload-abuse tests on staging | P0 | DevSecOps + Security | SEC-10 | M | No unaccepted critical/high finding; every exception has owner, compensating control and expiry; seeded auth/upload/secret defects are detected | Block release |
| **TST-06** | Privacy tests: log/trace redaction, RLS/Realtime/storage authorization, consent versioning, data-subject export/correction/deletion, legal hold and backup aging | P0 | QA/Backend + Legal | GOV-04, GOV-05, GOV-08 | M | Automated suite and approved manual review pass using synthetic data; no secret/PII leaks through errors, URLs or telemetry | Block release |
| **TST-07** | Accessibility tests: WCAG 2.1 AA on dashboard (axe-core plus manual assistive-technology checks). Candidate consent/call flow accessible | P0 | Frontend | — | M | Axe audit clean. Lighthouse accessibility ≥ 90 | N/A |
| **TST-08** | Browser/device matrix tests: Product-approved supported browsers/OS/devices plus representative network and permission conditions | P0 | QA | — | M | Test matrix executed; issues filed; no P0/P1 issues remain | N/A |
| **TST-09** | Load, spike and soak test at the approved launch concurrency plus documented safety headroom for long enough to expose leaks/queue growth; measure latency, errors, saturation and cost | P0 | QA/Backend | REL-01, OBS-03 | L | Signed report meets approved SLO/error budget with stable resources and no unbounded backlog; exact concurrency, headroom and duration come from Product/SRE capacity objectives | N/A |
| **TST-10** | Failure-injection tests: terminate worker at lifecycle boundaries, fail DB/queue/provider/network, duplicate/reorder events and verify bounded loss, reconciliation and safe candidate UX | P0 | Backend Eng | REL-08, REL-09 | M | Chaos test runbook executed; all recovery mechanisms verified | N/A |
| **TST-11** | Restore drill using the approved database backup/PITR mechanism and the separate recording/object backup strategy; verify schema, policies, data, object manifests and deletion/hold semantics | P0 | DB Admin + SRE | MIG-01, MIG-06 | M | Restore into isolation reconciles integrity manifests and meets approved RPO/RTO; runbook identifies unavailable PITR/storage guarantees and compensating controls | N/A |
| **TST-12** | DR drill: simulate total region failure. Fail over to DR plan (if any). Document findings | P1 | Infra | TST-11 | L | DR drill executed; findings documented; remediation items filed | N/A |
| **TST-13** | CI/CD pipeline: GitHub Actions (or equivalent). Stages: lint → typecheck → unit → contract → integration → security scan → build → deploy to staging → E2E → deploy to prod (with approval gate) | P0 | DevSecOps | FND-01 | L | CI pipeline green on main. Deployment to prod requires manual approval. Canary/blue-green mechanism tested | Revert deploy |
| **TST-14** | Reproducible builds: lockfiles committed, hermetic inputs where practical, and signed artifact provenance at the approved maturity | P0 | DevSecOps | TST-13 | M | Build inputs/toolchain are pinned; repeated builds are reproducible where supported and any nondeterminism is documented; provenance verifies commit, builder and dependencies | Reject artifact and rebuild |
| **TST-15** | Migration CI gate: DB migrations run in CI against ephemeral database. Migration tested for forward and rollback | P0 | DB Admin | TST-13 | M | Migration PR includes forward + rollback; both pass in CI | N/A |
| **TST-16** | Branch protection: require PR, ≥1 review, CI green, no unresolved conversations before merge to main. Protected branch rules enforced | P0 | DevSecOps | FND-01 | S | Attempt direct push to main → rejected. Attempt merge without review → rejected | N/A |

---

### Phase 7: Recording Productionization (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **REC-01** | Replace/separate browser WebM upload: browser path becomes secondary (kept for browser-only candidates with reduced size limit). Primary recording via LiveKit Egress (server-side MP3) | P0 | Backend Eng | REL-01 | L | Egress MP3 recording lands in private storage after session close. File integrity verified (SHA-256) | Fall back to browser upload |
| **REC-02** | Spike the provider-supported Egress formats/destinations and residency path. If direct private Supabase/S3-compatible upload is unsupported, use supported private object storage then copy through a verified worker | P0 | Backend Eng + Security | REC-01, MIG-06 | M | End-to-end recording lands in approved region/storage with encryption, object metadata and playable output; failure callback and retry are demonstrated | Keep hardened browser capture temporarily if its launch risk is explicitly accepted |
| **REC-03** | If browser upload remains, stream it through an authenticated session-owned endpoint with configurable duration/size limits, MIME plus magic-byte/media parsing, quota and malware/content scanning appropriate to audio; remove in-memory 100 MB buffering | P0 | Backend Eng | SEC-05, SEC-06 | M | Oversize/spoofed/cross-session uploads fail before memory exhaustion; valid supported formats pass; load test demonstrates bounded memory | Disable browser upload |
| **REC-04** | Record cryptographic digest, object version, size, duration and provenance; verify during processing/download and alert/quarantine mismatch | P1 | Backend Eng | REC-01 | S | Tampered fixture is blocked and alerted; valid object verifies throughout retention | Quarantine object and recover from source/backup |
| **REC-05** | Mint recording URLs only from an authorized API with an owner-approved short TTL; store object keys rather than durable signed URLs and support immediate authorization revocation | P0 | Backend Eng | MIG-06, SEC-02 | S | Direct access fails; configured TTL expiry and user/session revocation tests pass; logs do not contain URLs/tokens | Disable downloads |
| **REC-06** | Apply GOV-04 retention/legal-hold/backup-aging to recording objects and metadata with idempotent deletion and processor propagation | P0 | Backend Eng | GOV-04 | M | Expired versus held fixtures behave correctly; deleted object cannot be reminted/downloaded and ages out of backups per policy | Pause job; restore erroneous deletion only within approved grace |

---

### Phase 8: Voice Quality (P0 — Launch Quality Gate)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **VOI-01** | Instrument end-of-user-turn → first-agent-audio and component latency, establish representative baselines, then have Product/SRE approve p50/p95/p99 budgets by network/device cohort | P0 | Eng Lead + Product | OBS-03 | M | Dataset, measurement points and approved budgets are versioned; dashboards separate network, STT, LLM, TTS and endpointing contributions | N/A |
| **VOI-02** | Measure barge-in, candidate cutoff, false interruption, double-talk and response-delay rates on representative calls; tune VAD/turn settings against approved quality thresholds | P0 | Backend Eng + QA | VOI-01 | M | Human-reviewed test set and automated metrics meet approved thresholds without regressing soft speakers/noisy cohorts | Revert versioned parameters |
| **VOI-03** | Measure STT WER plus screening-task/entity accuracy on a statistically justified, consented representative Indian-English/accent/noise dataset | P0 | QA/Backend | GOV-07 | M | Sample-size rationale, baseline, confidence intervals and acceptance thresholds are approved; PII is de-identified and access-controlled | N/A |
| **VOI-04** | Measure TTS naturalness, intelligibility and pronunciation for representative Indian names/roles using an approved MOS/A-B protocol and sample size | P0 | QA/Backend | GOV-07 | M | Baseline and acceptance criteria are approved and reproducible; pronunciation defects have regression fixtures | N/A |
| **VOI-05** | Test approved noise/reverberation/double-talk profiles representative of candidate environments and measure STT/turn degradation plus recovery UX | P0 | QA | TST-04 | M | Each profile meets approved cohort thresholds or invokes a clear repeat/fallback/accommodation path without scoring the technical failure against the candidate | Revert tuning/provider change |
| **VOI-06** | Test approved bandwidth, latency, jitter, packet-loss and reconnect profiles using WebRTC network conditioning | P0 | QA | TST-04 | M | Completion/latency/reconnect meet approved thresholds and degraded media is surfaced to operations and candidate | Revert media/config change |
| **VOI-07** | Execute a Product-approved browser/OS/device/accessibility matrix based on candidate usage and support policy | P0 | QA + Frontend | TST-08 | M | Supported matrix is published; every supported combination passes consent, mic, call, reconnect and completion tests; unsupported devices get clear guidance | Narrow support matrix with Product approval |
| **VOI-08** | Handle silence, short/long answers, repetition, candidate questions, decline, disconnect/rejoin and explicit end-call through a tested lifecycle | P0 | Backend Eng + QA | REL-07 | M | No scenario hangs/loops or scores an incomplete call; terminal-state timing meets approved SLO; transcript/recording/scoring behavior matches policy | Revert prompt/lifecycle release |

---

### Phase 9: Product Operations (P0–P2)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **OPS-01** | Admin dashboard: view/override sessions, view audit logs, manage users, view system health, toggle maintenance mode | P0 | Frontend | SEC-02 | L | Admin can perform all listed operations. Non-admin cannot access admin pages | N/A |
| **OPS-02** | Recruiter controls: create session, upload role/requirements, invite candidate (generate join link), view transcript, review scorecard, add human notes, change candidate status | P0 | Frontend | SEC-02 | L | Full recruiter flow works end-to-end | N/A |
| **OPS-03** | Candidate consent UX: clear, multi-language consent page before room join. Explains recording, AI, data usage. Records consent | P0 | Frontend + Legal | GOV-08 | M | Consent page renders on mobile and desktop. Consent recorded in DB. Candidate can decline | N/A |
| **OPS-04** | Notify recruiters on completion and candidates only through approved, consented channels/templates; make delivery idempotent and observable | P2 | Backend Eng | REL-01 | M | Notifications meet the Product-approved freshness SLO; duplicates, provider retry and opt-out tests pass | Disable affected channel |
| **OPS-05** | Cost/quota guardrails: per-recruiter session quota, provider cost cap, alert on approaching limits. Hard stop when cap hit (configurable override) | P0 | Backend Eng | — | M | Exceeding quota blocks new sessions. Alert sent. Admin can override | N/A |
| **OPS-06** | Status page: public or internal status page showing service health (optionally: statuspage.io or custom) | P2 | DevSecOps | OBS-06 | M | Status page reflects alert state | N/A |
| **OPS-07** | Export/report: recruiter can export session data (transcript, scorecard) as PDF/CSV | P2 | Backend + Frontend | — | M | Export produces valid PDF/CSV. Test: export with non-Latin characters | N/A |
| **OPS-08** | Candidate correction/appeal: provide an accessible route to flag identity/transcript/assessment inaccuracies; require human review and preserve original plus correction audit evidence | P0 | Backend + Frontend + Product | GOV-05, SEC-12 | M | Synthetic request is identity-verified, routed within approved SLA, never silently overwrites evidence, and can prevent an unresolved disputed score from driving status | Disable automated score display/status use while issue is unresolved |

---

### Phase 10: Model Governance & Optional Provider Changes (P0–P1)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **LLM-01** | Provider abstraction layer: define interface for LLM (chat), STT, TTS, scoring. Implement adapters for current and planned providers | P1 | Backend Eng | — | M | Switching provider requires config change only, no code change. Test: swap STT adapter → system works | N/A |
| **LLM-02** | Build a versioned evaluation framework for the current live/interview and scoring models using consented/de-identified, human-annotated calls; cover question coverage, factuality, safety, disclosure, score validity/calibration and variance | P0 | Backend Eng + Product + Legal | GOV-07 | L | Current Haiku/Claude baselines and launch thresholds are approved; held-out regression suite is reproducible; model change cannot bypass it | Keep scores advisory/disable automated scoring display |
| **LLM-03** | Haiku → Gemini 2.5 Flash-Lite: run full evaluation suite. Compare latency, cost, quality. Only migrate if eval passes | P1 | Backend Eng | LLM-02 | M | Eval report: Gemini meets or exceeds Haiku on all metrics. Latency and cost documented | Revert to Haiku |
| **LLM-04** | claude → DeepSeek scoring: run full evaluation suite. Compare score quality, explainability, consistency. Only migrate if eval passes | P1 | Backend Eng | LLM-02 | M | Eval report: DeepSeek meets or exceeds Claude on scoring accuracy and consistency | Revert to Claude |
| **LLM-05** | For every provider used at launch or proposed later, obtain contractual/vendor evidence of processing and storage regions and validate endpoint configuration; latency/IP observations alone do not prove residency | P0 | Eng Lead + Legal + Security | GOV-07 | M | DPA/subprocessor/retention/region evidence and configured endpoint screenshots are approved; any unmet mandatory residency requirement blocks provider selection | Keep approved current provider or choose compliant alternative |
| **LLM-06** | Store model/provider, prompt/template version, safety configuration and relevant inference parameters per session without storing secrets | P0 | Backend Eng | — | S | Assessment/session can be reproduced within documented model limitations and traced to an immutable prompt/eval artifact | N/A |
| **LLM-07** | Run legally approved fairness testing across accents/languages and other relevant cohorts using only voluntary, consented, de-identified labels; never infer protected traits such as gender from voice | P0 | QA + Product + Legal | LLM-02, GOV-07 | L | Methodology protects small cohorts, reports uncertainty and material disparities, has human review and defined remediation/launch thresholds; unresolved harmful disparity blocks launch | Keep scores advisory/hidden or revert model while remediating |
| **LLM-08** | Treat resumes, job descriptions, speech and transcripts as untrusted model input: delimit data, prohibit instruction override/data exfiltration, minimize tools, validate structured output and add prompt-injection/adversarial regression tests | P0 | Backend + Security + QA | LLM-02, SEC-14 | M | Seeded resume/transcript injection cannot reveal system prompt/secrets, alter rubric/weights, invoke unauthorized action or bypass human review; malformed output is rejected/quarantined | Disable affected model workflow and use manual review |

---

### Phase 11: Deployment & Capacity (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **DEP-01** | Benchmark representative candidate infrastructure with realistic concurrent voice sessions; find saturation/failure points and resource/network/cost per session | P0 | Backend Eng + SRE | TST-09 | M | Reproducible benchmark identifies safe concurrency under approved SLOs; no free-tier/vendor capacity claim is accepted without measurement | N/A |
| **DEP-02** | Based on benchmark, provision target concurrency plus SRE-approved safety headroom; isolate independently scaling/failing worker, API/web, queue and media responsibilities as architecture requires; document scale triggers | P0 | Infra | DEP-01 | M | Capacity model and failure domains are approved; infrastructure handles target/headroom without SLO breach or unbounded cost | Scale down within tested minimum |
| **DEP-03** | HA decision: document whether HA (multi-zone, multi-instance) is needed for launch. Based on SLO and cost. If single-instance, document RTO/RPO and acceptance | P0 | Infra + Eng Lead | DEP-02 | S | HA decision document approved. If HA, tested failover. If not, risk accepted in writing | N/A |
| **DEP-04** | IaC: all infrastructure defined as code (Terraform, Pulumi, or provider-native). No manual console changes in prod | P0 | DevSecOps | DEP-02, DEP-03 | L | `terraform plan` shows no drift. Destroy + recreate produces identical environment | N/A |
| **DEP-05** | Environment parity: staging is scaled-down but functionally identical to prod (same services, same config structure, different scale) | P0 | DevSecOps | DEP-04 | M | Staging passes full E2E test suite. No "works on staging, fails on prod" issues | N/A |
| **DEP-06** | Canary/blue-green deployment: deploy to an SRE-approved controlled cohort, verify technical and voice-quality health, then promote. Rollback mechanism tested | P0 | DevSecOps | DEP-04, TST-13 | M | Configured canary cohort and observation window pass; rollback meets approved recovery SLO and preserves schema/data compatibility | Roll back application and compatible config |
| **DEP-07** | Artifact provenance: builds produce signed attestations at an approved SLSA maturity. Verify provenance before deploy | P0 | DevSecOps | TST-14 | M | Deploy pipeline verifies attestation; rejects unsigned artifacts | N/A |

---

### Phase 12: Production Launch (P0)

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **LCH-01** | Production launch checklist (see §8) completed, all P0 gates green, go/no-go authority signed off | P0 | Eng Lead | All P0 tasks | S | Checklist signed. Go decision documented | Abort launch |
| **LCH-02** | Launch: deploy to production. Monitor dashboards. On-call engineer active | P0 | DevSecOps | LCH-01 | S | Production live; first real session completes successfully | Rollback deploy |
| **LCH-03** | Run heightened post-launch monitoring for an SRE-approved window based on traffic volume (not merely elapsed hours), with active on-call, issue cadence and explicit rollback authority | P0 | All | LCH-02 | M | Minimum approved number of real/synthetic sessions completes without P0 incident and error budget remains healthy through the configured window | Extend hypercare or roll back |
| **LCH-04** | Post-launch review: retrospective. What went well, what broke, what to improve before telephony phase | P1 | Eng Lead | LCH-03 | S | Retro doc published; action items filed | N/A |

---

### Phase 13: Telephony (Future, Separately Gated)

This phase is **not** in scope for browser-first production launch. All tasks here are gated by §6.17 legal/privacy gates.

| ID | Task | S | Owner | Dep | Effort | Acceptance / Verification | Rollback |
|----|------|---|-------|-----|--------|--------------------------|----------|
| **TEL-01** | Obtain written Indian telecom counsel and carrier guidance identifying the exact DLT/UCC, consent, DND, number, caller-ID, evidence and audit obligations for this automated voice use case; complete all applicable registrations | P0 | Legal + Product | GOV-07 | L | Legal sign-off and provider acceptance evidence map each obligation to a control; no SMS-template/header assumption is reused without voice-specific confirmation | Do not launch outbound |
| **TEL-02** | Select and onboard an India-capable telephony provider only after route quality, lawful use, pricing, support, number availability and DPA/security review | P0 | Infra + Legal | TEL-01 | M | Verified business account and approved route/number complete inbound/outbound test calls; commercial claims are backed by current quote | Disable account/routes |
| **TEL-03** | Integrate provider SIP with LiveKit using authenticated/encrypted signaling/media where supported, IP/network controls, credential rotation, fraud limits and call/session correlation | P0 | Backend Eng + Security | TEL-02 | M | Authorized calls connect; spoofed/unauthorized SIP fails; credential rotation, spend cap and fraud alert tests pass | Disable trunk and rotate credentials |
| **TEL-04** | Implement Legal-approved AI identity, recording disclosure and consent/decline flow before substantive screening; choose speech/DTMF/hang-up behavior after usability and legal review | P0 | Product + Backend + Legal | TEL-03 | M | Multilingual test proves disclosure is heard, consent evidence is persisted, decline ends safely, and no recording/screening proceeds contrary to policy | Disable outbound calling |
| **TEL-05** | Enforce consent source, suppression/DND/opt-out and retry-frequency policies before every dial; propagate opt-out within the Legal-approved SLA | P0 | Backend Eng + Legal | TEL-01 | M | Seeded suppressed/expired/no-consent numbers cannot be dialed; opt-out propagates to every dial path and is auditable | Emergency disable outbound |
| **TEL-06** | Enforce timezone-aware calling schedule defaulting to the existing 10:00–19:00 IST project constraint; Legal/Product must approve permitted days, holidays and any narrower window | P0 | Backend Eng + Legal | TEL-01 | S | Boundary/DST/timezone/holiday tests pass and config changes require approval; outside-window jobs remain queued or expire per policy | Disable scheduler |
| **TEL-07** | Provide dual-controlled emergency stop that blocks new dials immediately and safely terminates or winds down active calls according to incident policy | P0 | Backend Eng + SRE | TEL-03 | M | Authorized drill meets approved stop SLO, creates audit event and prevents automatic restart until cleared | Manual provider/trunk shutdown |
| **TEL-08** | Monitor answer rate, carrier errors, spam/reputation reports, fraud and complaint rates; define pause thresholds and remediation without unsafe automatic number rotation | P1 | Infra + Compliance | TEL-02 | M | Threshold breach alerts and pauses campaign according to approved runbook | Pause all dialing |
| **TEL-09** | Benchmark LiveKit Cloud versus self-hosting in an approved region for latency, resilience, security, recording, operations and cost before deciding | P1 | Infra + Security | DEP-01 | L | Reproducible benchmark and threat/ops review produce an ADR; no location or savings claim is accepted without evidence | Keep browser-production deployment |

---

## 6. Detailed Workstreams

### 6.1 Repository / Git Governance & Environment Separation

**Current state:** No Git repository exists, so nothing is tracked yet. Secret-bearing local env files and a shareable HTML file containing real candidate PII are present in the working tree; only a local environment is evidenced.

**Target state:**
- Monorepo: `web/` (React dashboard), `api/` (Node/Express), `worker/` (Python/LiveKit agent), `infra/` (IaC), `docs/`
- `main` branch protected; feature branches; PR reviews required
- Pre-commit hooks: lint, format, secret detection (gitleaks), typecheck
- CI runs on every PR; merge blocked on failure
- Three environments: dev (ephemeral, per-branch optional), staging (persistent, pre-prod mirror), production
- Environment config is injected from an approved secret manager/platform identity; production secrets are never committed, baked into images, exposed to the web build, or printed by CI
- `.env.example` lists all required vars with descriptions, no values

**Key tasks:** FND-01 through FND-09

---

### 6.2 Identity, Authentication, RBAC, Tenant Isolation

**Current state:** No authentication. LiveKit tokens are issued by unauthenticated API. Browser uses Supabase anon key. No RBAC or tenant concept.

**Target state:**
- Recruiters authenticate with MFA; SSO and session policy are selected in D-001 from threat model and operational needs
- Roles: admin, interviewer and viewer, enforced consistently at API and database boundaries
- D-011 decides single-org versus multi-tenant launch. Add `org_id` only if multi-tenancy is approved; otherwise enforce the single organization explicitly and avoid pretending blanket anon reads are isolation
- Candidate receives a revocable, non-enumerable, one-time invite that exchanges for a short-lived session/room-scoped LiveKit grant; no recruiter credential is exposed to the candidate
- Browser Realtime uses only public client credentials and RLS-authorized channels; no service-role credential enters the browser
- Sensitive resume, rubric, prompt and scoring context never appears in client-visible LiveKit room/participant/token metadata; the worker retrieves it through an authenticated server channel

**Key tasks:** SEC-01 through SEC-04

---

### 6.3 API & Web Security

**Current state:** No rate limiting, request IDs or CSP. CORS allows the configured web origin plus any localhost port. The recording route uses 100 MB in-memory multer; validation is inconsistent and not centralized.

**Target state:**
- Privileged/data-changing endpoints require authentication and authorization. Health and candidate invite exchange are explicitly public, narrowly scoped, non-enumerable and rate-limited
- Zod/JSON Schema validation on accepted inputs; stable size limits and errors; reject unknown fields where compatibility permits
- Distributed rate limits/quotas by user, invite/session, IP and high-cost endpoint with trusted-proxy configuration and abuse alerts
- Exact CORS allowlist; CSP introduced report-only then enforced after LiveKit/Supabase/media sources are validated
- CSRF controls match the selected cookie or bearer-token transport; XSS and token-storage risks are documented
- Security headers and cache-control appropriate to pages containing PII
- Upload streams with configurable duration/size quotas, media parsing and cross-session ownership checks; memory remains bounded
- Server-generated correlation/request ID on responses and downstream jobs
- Dependency/SAST/secret/container scanning and signed SBOM/provenance in CI

**Key tasks:** SEC-05 through SEC-14

---

### 6.4 Secrets/KMS/Rotation & Least Privilege

**Current state:** Service-role credentials in local `.env` files. No rotation.

**Target state:**
- Secrets are held in the selected provider's secret manager/KMS (deployment decision D-003), with platform identity or controlled runtime injection
- No secrets in source, images, web bundles, shell history or CI logs; existing local keys are rotated before first commit
- Service accounts per component with least privilege:
  - AI worker: DB read/write (RLS-bypassed for its org scope), queue publish, STT/TTS/LLM API keys
  - API server: DB read/write (user-scoped via RLS), token signing key, queue publish
  - Scoring worker: DB read/write, LLM API key
  - CI/CD: deploy-only IAM, no DB access
- Rotation: automated or documented manual rotation for all keys; rotation rehearsal before launch
- Break-glass: emergency admin account with MFA; access logged and alerted

**Key tasks:** FND-05, FND-06

---

### 6.5 Supabase Production Migration Runbook

**Current state:** One Supabase project is configured through local anon/service-role env files. Migration `0002_realtime_rls.sql` grants blanket anon read to five `screening_v2` tables and publishes transcript/session/assessment changes; this is acceptable only for the current internal prototype. The API creates one-year recording signed URLs. Bucket privacy and dashboard-level backup/PITR configuration were not observed and must be checked rather than assumed.

**Detailed migration runbook (see Phase 2):**

1. **Ownership and prerequisites (MIG-01–02):** When the user supplies the new project, place it in a company-controlled organization under the new production email, add a second MFA administrator, configure least-privilege team access/billing alerts, document break-glass ownership, and record project identifiers only in approved secret/config systems. Obtain Legal/Security decisions on region, retention, backup/PITR and tenancy before provisioning.
2. **Reproducible platform baseline (MIG-03–06):** Version extensions, schemas, constraints, indexes, sequences, functions/triggers, grants, RLS, Realtime publications, storage buckets/policies and any adopted Auth/Edge Functions. Replace blanket anon reads with tested role/scope policies. Keep only Realtime feeds required by session, transcript and assessment UI. Verify private storage and authorized short-TTL URL minting; store object keys rather than durable URLs.
3. **Typed data and object tooling (MIG-07–09):** Use a logical database format that preserves UUID/JSON/time/FK/sequence semantics. Encrypt temporary artifacts. Produce canonical row/digest/sequence manifests and relational integrity reports. Stream-copy storage with key/size/type/digest manifests. Include Auth users only if Supabase Auth is selected, using a vendor-supported secure process.
4. **Rehearsal (MIG-10):** Run at production-like volume in an isolated project until the DB owner, SRE and Security approve consecutive clean results. Measure freeze, copy, verification and rollback times and compare with proposed RTO/RPO.
5. **Final consistency (MIG-11):** Block new calls and choose tested maintenance/final export or initial copy plus controlled delta and final freeze. Drain writes, run final canonical reconciliation and stop on any unexplained mismatch.
6. **Credential deployment and cutover (MIG-12–13):** New project credentials are distinct by design. Deploy them from the secret manager without revoking old credentials, run preflight, execute final sync, switch config, run a full E2E call, and reopen traffic gradually under enhanced monitoring.
7. **Rollback window (MIG-14):** Keep the old project intact and tightly controlled for an approved technical rollback window. The runbook must reconcile post-cutover writes if rollback occurs. Do not force read-only mode if that makes tested rollback impossible.
8. **Decommission (MIG-15):** Only after rollback closure and Legal retention approval, revoke old keys, remove integrations and archive/delete/decommission with dual approval. Technical rollback duration and legal data-retention duration are separate decisions.

**No-secret gate:** No key/value appears in source, plan, build, log or client bundle except explicitly public client credentials; old local keys are rotated; project references remain in controlled config.

**No-data-loss gate:** After the final freeze/delta drain, canonical DB counts/digests, FK/orphan/sequence checks and storage manifests have zero unexplained differences. A signed reconciliation report and tested rollback are required before traffic reopens.

---

### 6.6 Data Governance, Encryption, Retention, DSAR, PII Minimization

**Current state:** Real PII in `docs/HELLO.html` (candidate name, voice, assessment). No retention policy. No deletion mechanism. No consent records beyond AI disclosure in prompt.

**Target state:**
- Data classified and inventoried (GOV-01)
- PII minimized: only what's needed for screening (GOV-02)
- Vendor encryption is evidenced; field encryption/tokenization is applied only where the approved threat model requires it (GOV-03)
- Retention policy per data class, legal hold and backup aging; automated deletion/restriction (GOV-04)
- Legally approved data-subject export/correction/deletion procedure with identity verification and processor propagation (GOV-05)
- All demo/screenshot data is synthetic (GOV-06)
- DPDP compliance review complete; vendor DPAs signed (GOV-07)
- Recording consent with explicit opt-in, timestamped record (GOV-08)

**DPDP/Vendor/DPA/Residency Review:**
- Identify all current and proposed processors: Sarvam, Anthropic, Supabase, LiveKit, deployment/observability providers, and any future scoring or telephony provider
- For each: confirm data sent, residency, DPA status, sub-processor list
- Legal must review each vendor's DPA and confirm DPDP compliance
- **Assumption required:** Confirm whether DPDP Act 2023 rules are notified and enforceable at launch date. If yes, full compliance required. If not, document mitigation for anticipated requirements.

**Key tasks:** GOV-01 through GOV-10

---

### 6.7 Responsible Hiring

**Current state:** AI disclosure exists in Gopu's prompt and scoring runs automatically via `claude -p`, with no enforced human review or fairness validation. Resume ingestion also writes a `job_application` consent record; that must not be treated as recording, AI-screening or outbound-call permission without Legal approval.

**Target state:**

- **Human-in-loop:** Scorecard is a recommendation. Recruiter must review and confirm before any candidate decision. System must not auto-reject.
- **No sole automated rejection:** Code-level enforcement: the API that updates candidate status to "rejected" must be authenticated as a human recruiter action, not an automated callback.
- **Fairness testing:** Evaluate accents/languages and legally relevant cohorts only with voluntary, consented, de-identified labels and small-cohort privacy controls. Never infer gender or another protected trait from voice. Report uncertainty and block launch/model rollout on unresolved material disparity.
- **Score calibration:** Periodic review of score distributions. Calibrate if drift detected.
- **Explainability:** Scorecard includes breakdown by competency with supporting transcript excerpts. Recruiter can click to jump to transcript.
- **Appeal/correction:** Candidate flagging mechanism; recruiter annotation; all changes audited.
- **Accommodations:** Candidates can request extra time, repetition, or text-based alternative during screening.
- **Model/prompt versioning:** Every session records versions. Enables audit: "this score was produced by model X, prompt Y."

**Key tasks:** GOV-10, LLM-06 through LLM-08, OPS-08

---

### 6.8 Voice Quality

**Current state:** Working voice loop demonstrated. No measured latency budget. No systematic quality testing.

**Target state:**

**Latency budget:** Instrument end-of-user-turn to first-agent-audio and the endpointing, network, STT, LLM and TTS spans separately. Establish p50/p95/p99 baselines by device/network cohort, then Product and SRE approve release thresholds. Browser/network measurements use WebRTC/LiveKit telemetry and application spans—not ICMP. The earlier ≤2-second target is a hypothesis to validate, not a production SLO.

**Turn-taking quality:** Measure barge-in success, mid-utterance cutoff, false interruption, double-talk, silence and completion rates against a human-reviewed representative corpus. Version thresholds and tuning parameters only after baseline/confidence analysis; aggregate metrics must not hide failures for soft speakers, accents, noisy rooms or degraded networks.

**Device/Browser/Network Matrix:**
- Chrome, Firefox, Safari, Edge (latest 2 versions)
- Android Chrome (low-end, mid-range, flagship), iOS Safari
- Network: WiFi (20ms/50Mbps), 4G (50ms/10Mbps), 3G (100ms/1Mbps)

**Key tasks:** VOI-01 through VOI-08

---

### 6.9 Reliability Engineering

**Current state:** Synchronous POST to scoring endpoint from agent close. No queue. No retry. No dead-letter. No circuit breakers. No session state machine enforcement.

**Target state:**
- Durable job queue for all async work (REL-01)
- Transcript events have stable IDs/source sequence, DB uniqueness/order constraints, idempotent writes, durable buffering and reconciliation (REL-02)
- Transactional outbox emits post-session jobs from committed state; consumers are idempotent under at-least-once delivery (REL-03)
- Retry with exponential backoff + jitter; dead-letter queue (REL-04)
- Provider circuit breakers with half-open probe (REL-05)
- Documented fallback chains (REL-06)
- Session lifecycle state machine (REL-07)
- Graceful shutdown (REL-08)
- Reconciliation job (REL-09)

**Queue topology:**
```
Main Queue: session.close → scoring job
           recording.egress_complete → process recording
           retention.cron → delete expired data
           notification.* → send email/Slack

Dead Letter Queue: all exhausted retries → alert → manual replay
```

**Key tasks:** REL-01 through REL-09

---

### 6.10 Recording Productionization

**Current state:** Browser `AudioContext` + `MediaRecorder` mixes local/remote audio, uploads WebM via unauthenticated POST (100 MB in-memory multer) to Supabase Storage, one-year signed URL.

**Problems with current approach:**
1.  Browser-driven: fails if tab closes, network drops, or JS errors
2.  Unauthenticated upload: anyone can POST recordings
3.  100 MB in-memory: trivial DoS vector
4.  One-year signed URL: too long; effectively public if URL leaks
5.  WebM container: less universally playable than MP3

**Target state:**
1. **Primary target:** Spike and verify LiveKit Egress format, callback, region and supported private destination. Use supported object storage plus a controlled copy worker if direct Supabase/S3-compatible delivery is not supported.
2. **Secondary decision:** Retain browser capture only if its failure model is accepted; stream through an authenticated session-owned endpoint with configured duration/size quotas and media validation.
3. **Integrity/access:** Store object key, digest, size, duration, provenance and version. Mint owner-approved short-TTL URLs only after authorization; support revocation.
4. **Consent/retention:** Do not record before the approved consent event. Apply legal hold, deletion and backup-aging policy from GOV-04.

**Key tasks:** REC-01 through REC-06

---

### 6.11 Observability

**Current state:** `console.log`. No structured logs. No metrics. No traces. No alerts. No dashboards.

**Target state:**
- Structured JSON logs with correlation ID, session ID, component, level, message. PII redacted at emission.
- Correlation ID propagated across all services.
- Metrics: RED (Rate, Errors, Duration) for all services. Queue depth. Circuit breaker state. Provider latency.
- Distributed traces for end-to-end session visibility.
- SLI/SLO defined and measured. Error budgets.
- Alerts: P0 → on-call (PagerDuty/Opsgenie), P1 → Slack, P2 → dashboard.
- Synthetic calls use synthetic data on a cost/quota-aware cadence selected to meet the approved detection SLO.
- Dashboards: service health, business metrics (sessions/day, completion rate), latency, error budget.

**Key tasks:** OBS-01 through OBS-09

---

### 6.12 Testing

**Current state:** Manual voice test only. Web lint fails due to missing oxlint dependency. TypeScript typechecks pass.

**Target state:**
- Risk-based unit/property/mutation tests on critical paths with an approved, ratcheted coverage baseline (coverage is not the sole quality gate)
- Contract tests for API, queue messages, DB schema
- Integration tests with emulated providers
- E2E voice tests with synthetic audio (automated browser + WebRTC)
- Security tests (ZAP, CVE scan, SAST, secret detection)
- Privacy tests (PII redaction, RLS, DSAR, consent)
- Accessibility tests (WCAG 2.1 AA)
- Browser/device/network matrix
- Load/spike/soak tests at approved concurrency, safety headroom and duration
- Chaos tests (kill worker, kill DB, network issues)
- Backup/restore drill
- DR drill

**Key tasks:** TST-01 through TST-12

---

### 6.13 CI/CD & IaC

**Current state:** None.

**Target state:**
- CI pipeline: lint → typecheck → unit → contract → integration → security → build → deploy staging → E2E → deploy prod (with approval gate)
- IaC: all infrastructure as code. Reproducible environments.
- Branch protection: PR + review + CI green.
- Canary/blue-green deploys with rollback.
- Artifact provenance (SLSA L2+).
- Migration CI gate: forward + rollback tested.

**Key tasks:** TST-13 through TST-16, DEP-04 through DEP-07

---

### 6.14 Deployment & Capacity

**Current state:** Not running. Capacity unknown.

**Target state:**
- Benchmark first: measure actual concurrency limits, not assumptions.
- Separate worker instances from API/web server.
- Capacity plan based on benchmark and SRE-approved safety headroom; no fixed multiplier is assumed.
- HA decision documented: single-instance acceptable only if RTO/RPO explicitly accepted.
- Scaling triggers defined and automated (or manual runbook).

**Do not accept free-tier or vendor concurrency assumptions.** Any claimed concurrency ceiling (e.g., Oracle ARM, cloud VM, or LiveKit Cloud) must be measured under realistic load. Worker CPU/memory per session must be profiled. Network bandwidth for audio streaming must be measured.

**Key tasks:** DEP-01 through DEP-03

---

### 6.15 Product Operations

**Current state:** No admin interface. No recruiter controls beyond browser join. No notifications. No quotas.

**Target state (see Phase 9 tasks):**
- Admin dashboard: user management, session override, system health, maintenance mode
- Recruiter dashboard: full session lifecycle management
- Candidate consent UX: clear, multi-language, recorded
- Notifications for session completion
- Cost/quota guardrails
- Status page
- Export/report functionality
- Candidate appeal/correction workflow

**Key tasks:** OPS-01 through OPS-08

---

### 6.16 LLM / Provider Changes

**Current state:** Anthropic Haiku is the live LLM and `claude -p` performs scoring. Gemini and DeepSeek appear only as proposed alternatives in planning documents; neither migration is approved or implemented.

**Do not change providers without evaluation evidence.** Every provider change must:
1.  Pass the evaluation suite (LLM-02)
2.  Show comparable or better metrics on all dimensions (latency, quality, cost, safety)
3.  Have region pinning technically and contractually validated (LLM-05)
4.  Be a config-level change, not a code change (LLM-01)

**Key tasks:** LLM-01 through LLM-08

---

### 6.17 Telephony Phase (Separately Gated)

**All telephony work is blocked until these gates are green:**

1. **Legal/telecom gate:** Indian telecom counsel and the selected carrier identify the exact voice-specific DLT/UCC, consent, DND, caller-ID, evidence and audit obligations; all applicable registrations are complete.
2. **Privacy gate:** DPDP, AI disclosure and call-recording language/process have written Legal approval and versioned evidence.
3. **Provider gate:** The approved India-capable provider route/number and LiveKit SIP path pass security, quality, fraud-limit, DPA and cost review; Plivo remains an option, not a pre-commitment.
4. **Consent gate:** The approved multilingual disclosure and consent/decline UX is validated before substantive screening; DTMF is used only if testing and Legal select it.
5. **Suppression gate:** Consent source, DND/suppression, retry and opt-out checks run before every dial and propagate within the approved SLA.
6. **Calling-window gate:** Default 10:00–19:00 IST; Legal/Product approve days, holidays and any stricter limits before configuration is enabled.
7. **Safety gate:** Authorized emergency stop, fraud/spend caps, active-call handling and restart approval are drill-tested.
8. **Operations gate:** Carrier quality, complaints, reputation and failure monitoring have pause thresholds and runbooks.

**Key tasks:** TEL-01 through TEL-09

---

## 7. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Trigger |
|----|------|-----------|--------|------------|-------|---------|
| R-01 | PII leak via logs, errors, or storage misconfiguration | Medium | Critical (P0) | PII redaction at log emission; private storage; RLS; privacy test suite; periodic audit | Security Lead | PII found in log query or public bucket |
| R-02 | Service-role/provider secret exposed through source, client bundle, logs or CI | Medium | Critical (P0) | Rotate existing keys; secret manager/platform identity; deny secrets to web builds; scanning and egress-aware incident runbook | Security + Backend | Any secret-like value detected outside its approved runtime boundary |
| R-03 | Supabase migration loses, corrupts or forks data | Medium | Critical (P0) | Typed migration tooling; approved rehearsals; final freeze/delta drain; canonical reconciliation; bounded rollback; old project preserved until closure | DB Admin | Any unexplained DB/object manifest difference or post-cutover write divergence |
| R-04 | Provider outage (STT/TTS/LLM) during live session | Medium | High (P1) | Circuit breakers; fallback chains; graceful degradation; alerting; provider status monitoring | Backend Eng | Provider error rate > threshold |
| R-05 | Lost/duplicated/out-of-order events create missing transcript or scorecard | Medium | High (P1) | Stable IDs/sequence constraints; durable buffering; transactional outbox for jobs; idempotent consumers; reconciliation and replay | Backend Eng | Gap/duplicate monitor fires or completed session misses an artifact beyond SLO |
| R-06 | Scoring or voice quality causes discriminatory outcomes | Medium | Critical (P0) | Advisory-only scores; human decision; legally approved fairness/quality datasets; calibration, explainability, accommodations and appeal | Product + Legal | Material disparity, harmful cohort failure or recruiter override drift exceeds threshold |
| R-07 | Privacy/DPDP obligations are misunderstood or unmet | Medium | Critical (P0) | Legal review at launch date; data map; vendor DPAs; consent; retention/deletion/legal holds; data-subject workflow | Legal | Legal gap, complaint, regulator notice or failed privacy control test |
| R-08 | Voice-telecom/DLT/UCC obligation is unmet | Medium | Critical (P0) | Voice-specific counsel/carrier evidence; registrations; suppression and consent checks; emergency stop | Legal + Product | Any dial lacks required evidence or carrier/legal approval |
| R-09 | Insufficient capacity under load | Medium | High (P1) | Benchmark first; capacity plan with headroom; scaling runbook; load test | Infra | Load test shows concurrency limit below target |
| R-10 | Browser/device incompatibility blocking candidates | Medium | Medium (P2) | Browser/device matrix test; graceful fallback messaging; support contact | QA + Frontend | Candidate reports cannot join from device |
| R-11 | Cost/quota exhaustion causes overspend or outage | Medium | High (P1) | Per-user/session quotas; provider budgets and rate-limit telemetry; alert/stop thresholds; capacity-cost test | Eng Lead + FinOps | Forecast or quota consumption crosses configured warning/stop threshold |
| R-12 | Recording consent not properly recorded | Low | High (P1) | Mandatory consent gate before join; consent record with timestamp; audit; privacy test | Backend Eng | Session exists but no consent record |

---

## 8. Production Launch Checklist

### Non-Negotiable P0 Gates (Must Be Green Before Launch)

- [ ] **PII-GATE:** Zero real PII in docs, demo data, logs, or public storage. `gitleaks` scan clean. `docs/HELLO.html` sanitized.
- [ ] **AUTH-GATE:** Every privileged/data-changing endpoint enforces authentication and authorization. Intentionally public health/invite-exchange endpoints are documented, non-enumerable where applicable, narrowly scoped, abuse-tested and rate-limited.
- [ ] **KEY-GATE:** Existing local keys are rotated before first commit. No service-role/provider secret appears in source, image, client bundle, logs or CI; production secrets use an approved manager/runtime identity.
- [ ] **UPLOAD-GATE:** No unauthenticated file upload endpoints. Recording upload authenticated, size-limited, content-validated.
- [ ] **AI-GATE:** No sole automated rejection. Human action required for candidate status change to "rejected." Enforced in code.
- [ ] **CONSENT-GATE:** Recording consent mandatory before room join. Consent record stored with timestamp.
- [ ] **MIGRATION-GATE:** Migration to the new company-controlled Supabase production project is complete under the new production email; tenancy-appropriate RLS/Realtime tests pass; storage is verified private; final DB/object reconciliation is signed; rollback remains available; region/backup evidence satisfies Legal/Security decisions.
- [ ] **BACKUP-GATE:** Database and recording restore drills complete successfully; approved RPO/RTO are measured, including backup-expiry behavior for deletion requests.
- [ ] **LOAD-GATE:** Load/spike/soak tests pass at approved launch concurrency and safety headroom for the approved duration; latency, error, saturation, backlog and cost remain within SLO/error budget.
- [ ] **OBSERVABILITY-GATE:** Logs, metrics, traces flowing to observability platform. Alerts configured and tested. On-call rotation active.
- [ ] **CI-GATE:** CI pipeline green on main. Branch protection enforced. Deployment approval gate active.
- [ ] **E2E-GATE:** Automated and human-reviewed E2E voice suites pass across the approved browser/device/network/accent matrix; transcript ordering, consent, recording and asynchronous scorecard are validated.
- [ ] **RELIABILITY-GATE:** Lifecycle, stable transcript IDs/order, durable post-session jobs, retries/DLQ, idempotency, graceful shutdown and reconciliation pass failure-injection tests.
- [ ] **SECURITY-GATE:** Threat model and security test suite have no unaccepted critical/high finding; dependency/SAST/DAST/secret/upload/RLS/authorization tests pass; any exception has named owner, compensating control and expiry.
- [ ] **FAIRNESS-GATE:** Human-oversight enforcement, calibration and legally approved fairness/accommodation tests meet launch thresholds; unresolved material disparity blocks launch.
- [ ] **LEGAL-GATE:** Legal signs privacy notice/terms, AI and recording consent, DPDP posture, retention/legal holds, data-subject process, vendor DPAs/subprocessors and residency decisions.
- [ ] **DATA-GATE:** Retention, legal-hold, deletion/backup aging and data-subject export/correction/deletion are implemented and tested.

### Go/No-Go Authority

- **Go required from:** Engineering Lead, Security Lead, Product Manager
- **No-go veto from:** Any of the above, or Legal Counsel

### Rollback Triggers During Launch

- Any confirmed P0 event: data loss/corruption, PII exposure, auth bypass, unlawful processing or uncontrolled outage
- Launch error budget, completion, voice-quality, queue-backlog or saturation crosses the approved rollback threshold/window
- Supabase reconciliation diverges, recording/consent evidence is missing, or rollback safety is threatened
- Any Security or Legal incident commander declares stop-processing necessary

### Post-Launch Hypercare

- SRE/Product define the window by both elapsed time and a minimum representative session volume.
- On-call actively monitors technical, voice-quality, privacy, fairness and support signals.
- Check frequency and issue triage cadence are documented in the launch runbook.
- Rollback authority: on-call incident commander plus any one go/no-go authority; Security or Legal may independently stop processing for their domain.

---

## 9. Definition of Done

### 9.1 Browser-First Production — Definition of Done

The browser-first system is **done** when:

1.  **All P0 launch checklist gates are green** (see §8).
2.  A real (or synthetic) candidate can:
    - Receive a join link
    - See a consent page in their language
    - Explicitly consent to recording
    - Join a LiveKit room
    - Complete a full screening interview with the AI agent
    - Have their transcript stored with correct ordering and session attribution
    - Have their recording captured through the approved server-side Egress/storage path, in an approved format, with provenance and integrity metadata
    - Have their scorecard generated asynchronously and available within [SLO]
3.  A recruiter can:
    - Log in through the approved authentication provider with enforced MFA (SSO if D-001 selects it)
    - Create a screening session with role requirements
    - Invite a candidate (generate join link)
    - View the transcript (read-only)
    - View the scorecard with explainability (competency breakdown + excerpts)
    - Add human notes
    - Change candidate status (human action required)
    - Export session data
4.  An admin can:
    - View all sessions in their org
    - Override stuck sessions
    - Manage users and roles
    - View audit logs
    - Use the emergency disable (telephony phase)
5.  The system:
    - Has no unauthenticated privileged/data-changing endpoint; explicitly public endpoints pass abuse and scope tests
    - Has structured logs, metrics, traces, alerts
    - Has a CI/CD pipeline with automated tests
    - Has IaC for all infrastructure
    - Has been load-tested at target concurrency
    - Has completed a backup restore drill
    - Has PII retention/deletion operational
    - Has a DSAR procedure tested

### 9.2 Telephony Production — Definition of Done

All of §9.1 **plus:**

1. Written Legal/carrier evidence confirms all applicable voice-specific DLT/UCC, consent, DND, calling-window, caller-ID and audit obligations are implemented.
2. Legal signs off outbound AI and recording behavior and evidence retention.
3. A representative PSTN candidate cohort completes screening at approved quality/SLO thresholds.
4. Approved AI/recording disclosure and consent/decline mechanisms work across supported languages and routes.
5. Consent, suppression/DND, retries, opt-out and timezone/holiday windows are enforced in every dial path.
6. SIP security, fraud/spend limits, emergency stop and recovery are drill-tested.
7. Telephony load/soak, carrier-failure, recording and reconciliation tests pass.
8. Browser-production gates remain green.

---

## 10. Appendix

### A. Environment / Config Inventory (Names Only, Never Values)

The names below are inventory only. **Observed** means the current code/example reads it; **gap** means code reads it but examples/config coverage must be fixed; **proposed** names are not contracts and must be finalized after the relevant provider decision.

| Component | Variable names | Status / purpose |
|-----------|----------------|------------------|
| API / Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SCHEMA`, `RECORDINGS_BUCKET` | Observed; service-role is server-only and must come from secret manager |
| API / scoring | `CLAUDE_MODEL`, `CLAUDE_SCORING_MODEL`, `CLAUDE_BIN`, `CLAUDE_TIMEOUT_MS`, `COMPANY_NAME` | Observed current `claude -p` path |
| API / server | `PORT`, `WEB_ORIGIN` | Observed |
| API + worker / LiveKit | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Observed; key/secret are server-only |
| Voice / providers | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `SARVAM_API_KEY`, `SARVAM_STT_MODEL`, `SARVAM_LANGUAGE`, `SARVAM_TTS_MODEL`, `SARVAM_TTS_VOICE` | Observed current worker |
| Voice / endpointing | `LIVEKIT_VAD_ACTIVATION_THRESHOLD`, `LIVEKIT_VAD_MIN_SPEECH_DURATION`, `LIVEKIT_VAD_MIN_SILENCE_DURATION`, `LIVEKIT_VAD_PREFIX_PADDING_DURATION`, `LIVEKIT_MIN_ENDPOINTING_DELAY`, `LIVEKIT_MAX_ENDPOINTING_DELAY`, `LIVEKIT_MIN_INTERRUPTION_DURATION`, `LIVEKIT_MIN_INTERRUPTION_WORDS`, `LIVEKIT_FALSE_INTERRUPTION_TIMEOUT` | Observed; version and validate as release config |
| Voice / persistence | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SCHEMA`, `API_BASE` | Read by worker; missing/incomplete example coverage is a configuration-contract gap |
| Local demo only | `GOPU_CANDIDATE_NAME`, `GOPU_ROLE_TITLE`, `GOPU_ROLE_FOCUS`, `GOPU_RESUME_FACTS`, `GOPU_CONTEXT_JSON` | Observed; production context must come from authorized session metadata, not local env |
| Web | `VITE_API_BASE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Observed public build-time values; RLS and domain restrictions are mandatory |
| Auth | `AUTH_ISSUER_URL`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` or provider equivalents | Proposed; finalize after D-001; never invent a separate JWT signing secret if provider verification is sufficient |
| Queue | `QUEUE_URL` and provider-specific workload identity/config | Proposed; finalize after D-002; avoid generic serialized credential blobs where workload identity exists |
| Observability | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `LOG_LEVEL` or selected-platform equivalents | Proposed; finalize with OBS workstream |
| Egress/storage | Provider-specific Egress destination, callback and encryption variables | Proposed; names follow REC-02 spike—`LIVEKIT_EGRESS_CONFIG` is not yet an observed contract |
| Future LLM/scoring | Provider-specific Gemini/DeepSeek credentials, model, region and endpoint variables | Proposed only after LLM-03/04/05 approval |
| Future telephony | Selected carrier SIP/auth, number, fraud-limit and emergency-disable variables | Proposed only after TEL-01/02; do not assume Plivo names before selection |

### B. Vendor / Account Prerequisites

| Vendor | Accounts/Resources Needed | Owner |
|--------|--------------------------|-------|
| Supabase | New project supplied later under the company production email/org; second MFA admin; approved region/plan/backups; migration access | Infra + DB Admin |
| LiveKit | Existing Cloud project for MVP; production Cloud/self-host and Egress decision requires region, DPA, quota and benchmark evidence | Infra + Security |
| Sarvam | Production account, DPA/subprocessors/retention review, quotas/support and STT/TTS quality/rate evidence | Backend + Legal |
| Anthropic | Current provider production account, DPA/retention/region evidence, limits and billing guardrails | Backend + Legal |
| Google (future) | Only after evaluation: approved Vertex/Gemini account and contractual/technical region evidence; a generic API key is not residency proof | Backend + Legal |
| DeepSeek/alternative scoring (future) | Only after evaluation and cross-border/DPA/hosting review; API versus approved hosted deployment remains open | Backend + Legal |
| Auth provider | MFA and lifecycle provisioning; SSO if selected; security/DPA review | Infra + Backend |
| Cloud/queue/observability | Approved compute, secret manager/KMS, durable queue, logs/metrics/traces and support plan | Infra + Security |
| Telephony provider (future) | Selected only after voice-specific Legal/carrier validation, India route/number, SIP security, DPA, fraud and cost review | Infra + Legal |
| Email/SMS provider | For notifications | Backend Eng |
| Domain/DNS | Production domain, SSL certificates | Infra |

### C. Evidence Artifacts (to be produced and stored)

| Artifact | Phase | Location |
|----------|-------|----------|
| Architecture decision records (ADRs) | 0 | `docs/adr/` |
| Data classification inventory | 3 | `docs/data-classification.md` |
| Schema with RLS policies | 2 | `infra/migrations/` |
| Migration manifest (export → import validation) | 2 | Signed artifact in secure storage |
| DPDP legal memo | 3 | Legal shared drive |
| Vendor DPA register | 3 | Legal shared drive |
| Penetration test report | 6 | Security shared drive |
| Load test report | 11 | `docs/load-test-report.md` |
| Fairness evaluation report | 10 | `docs/fairness-report.md` |
| Latency budget baseline | 8 | `docs/voice-quality.md` |
| Backup restore drill report | 6 | `docs/dr-drill-report.md` |
| Production launch checklist (signed) | 12 | `docs/launch-checklist-signed.pdf` |
| Retrospective document | 12 | `docs/post-launch-retro.md` |

### D. Open Decisions & Questions

| ID | Question | For | Urgency |
|----|----------|-----|---------|
| Q-01 | Which auth provider? (WorkOS, Supabase Auth, Clerk, other) | Eng Lead + Product | Before SEC-01 |
| Q-02 | What processing/storage residency is legally and commercially required, and which provider/region can evidence it while meeting measured capacity and support needs? | Legal + Security + Infra | Before MIG-01/DEP-02 |
| Q-03 | Queue technology? (Cloud Tasks, BullMQ+Redis, SQS, RabbitMQ) | Backend Eng | Before REL-01 |
| Q-04 | LiveKit Cloud versus self-host: which passes region/DPA, latency, Egress, resilience, operational and cost benchmarks? | Infra + Security | Before DEP-02/REC-02 |
| Q-05 | DeepSeek: API vs self-host? (hosting platform TBD per D-004; do not pre-commit to specific vendor) | Backend Eng | Before LLM-04 |
| Q-06 | PII retention period for call recordings and transcripts? | Legal | Before GOV-04 |
| Q-07 | What privacy/DPDP, employment, consent, retention, legal-hold, data-subject and automated-decision obligations apply at launch? | Legal | Before GOV-07 |
| Q-08 | What exact voice-specific DLT/UCC, consent, DND, caller-ID, recording and calling-window obligations apply to this use case and provider? | Legal + telecom counsel/carrier | Before TEL-01 |
| Q-09 | Browser recording upload: retain as fallback or remove entirely? | Eng Lead + Product | Before REC-03 |
| Q-10 | Target concurrency for launch? (How many simultaneous sessions?) | Product | Before DEP-01 |
| Q-11 | Which SIEM/log aggregator? | DevSecOps | Before OBS-01 |
| Q-12 | On-call rotation and incident response provider? (PagerDuty, Opsgenie, other) | DevSecOps | Before OBS-06 |
| Q-13 | Metrics/tracing backend? (Grafana, Datadog, SigNoz, other) | DevSecOps | Before OBS-03 |
| Q-14 | Break-glass account: who holds physical token? | Eng Lead + Security Lead | Before MIG-02 |

---

## 11. "Not Before Production" Prohibitions

The following are **prohibited** until the listed gate is satisfied:

| # | Prohibition | Gate |
|---|-------------|------|
| 1 | No real candidate PII in any shareable document, demo, screenshot, or public storage | PII-GATE |
| 2 | No service-role key in any browser bundle, public config, or client-side code | KEY-GATE |
| 3 | No unauthenticated privileged/data-changing API; any public candidate invite exchange must be one-time, narrow, non-enumerable, revocable and abuse-controlled | AUTH-GATE |
| 4 | No unauthenticated recording upload endpoint | UPLOAD-GATE |
| 5 | No automated rejection of candidates without human review and action | AI-GATE |
| 6 | No untested migration to production Supabase | MIGRATION-GATE |
| 7 | No production deployment without backup restore drill completed | BACKUP-GATE |
| 8 | No provider change (LLM, STT, TTS) without evaluation suite evidence | LLM evaluation |
| 9 | No outbound calling without written voice-specific Legal/carrier approval and all applicable registration, consent, suppression/DND, schedule, recording, fraud and emergency-stop controls | Telephony gates (§6.17) |
| 10 | No production data in dev or staging environments | Environment separation |

---

*End of document.*

**Next step:** Review with Engineering Lead, Security Lead, Product Manager, and Legal Counsel. Collect answers to open questions (Appendix D). Begin Phase 0 execution.
