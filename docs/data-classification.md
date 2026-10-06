# GOV-01: Column-by-Column Data Classification

**Status:** Local implementation document (GOV-01 enabler)
**Evidence date:** 2026-07-30
**Schema:** `screening_v2` (all columns from migrations 0001–0007)

## Classification levels

| Level | Label | Description |
|-------|-------|-------------|
| 1 | Public | Non-sensitive metadata; safe to log, export, display without restriction |
| 2 | Internal | Operational data; safe within authenticated sessions; no PII |
| 3 | Confidential PII | Personal data that identifies or can identify an individual candidate |
| 4 | Confidential Special | Special category data (health, biometrics, criminal history, etc.) — N/A |
| 5 | Secret | Credentials, tokens, keys, digests that grant access |
| PENDING | Legal review required | Retention/erasure/portability obligations not yet determined |

> **Owner direction (D-009, 2026-07-30):** Retain by default indefinitely; offload to object storage near free cap. NOT Legal-approved. Legal DPDP storage-limitation/lawful-basis document is in preparation and gates go-live. Valid erasure requests MUST still delete via GOV-04/GOV-05. All `PENDING` retention classifications below remain pending until Legal document is completed. See `docs/decisions/fnd-08-owner-approval.md`.

## Column classification

### `screening_v2.roles`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `title` | Internal | Job title; not PII |
| `jd` | Internal | Job description text; may contain org-specific info but no candidate PII |
| `required_skills` | Internal | JSON array of skill names |
| `screening_template` | Internal | JSON array of question/weight/follow_up_hint objects |
| `is_active` | Public | Boolean flag |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |
| `owner_id` | Public | UUID auth.users reference (opaque, no PII) |

### `screening_v2.resumes`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `file_path` | Internal | May reveal local filesystem paths; redact in manifest output |
| `file_name` | Internal | Original filename; may contain candidate name |
| `mime_type` | Public | Content type string |
| `text_extracted` | **Confidential PII** | Full resume text — may contain name, email, phone, education, work history |
| `parsed` | **Confidential PII** | Structured parsed data; may contain PII |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |

**Retention decision:** PENDING — legal review required for GDPR right-to-erasure and data-minimization obligations. Owner direction (D-009): retain indefinitely; NOT Legal-approved.

> **Owner direction (D-009, 2026-07-30):** Retain by default indefinitely; offload to object storage near free cap. NOT Legal-approved. Legal DPDP storage-limitation document gates go-live. Valid erasure requests MUST still delete via GOV-04/GOV-05. See `docs/decisions/fnd-08-owner-approval.md`.

### `screening_v2.candidates`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `role_id` | Public | FK to roles (opaque UUID) |
| `resume_id` | Public | FK to resumes (opaque UUID) |
| `name` | **Confidential PII** | Candidate full name |
| `email` | **Confidential PII** | Email address; direct identifier |
| `phone_raw` | **Confidential PII** | Raw phone number |
| `phone_e164` | **Confidential PII** | Normalized E.164 phone |
| `phone_valid` | Internal | Boolean validation flag |
| `skills` | Internal | JSON array of skill names |
| `experience_years` | Internal | Numeric years |
| `parsed` | **Confidential PII** | Structured parsed data from resume |
| `status` | Internal | Lifecycle status string |
| `consent_source` | Internal | Origin string (e.g. "job_application") |
| `consent_at` | Public | Timestamp of consent |
| `ats_external_id` | Internal | ATS reference ID (deferred Ashby integration) |
| `ats_source` | Internal | ATS source string |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |
| `owner_id` | Public | UUID auth.users reference |

**Retention decision:** PENDING — GDPR right-to-erasure, data portability, and storage limitation obligations not yet legally determined. Current synthetic-only posture means no real candidate data is at risk.

### `screening_v2.call_sessions`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates (opaque UUID) |
| `role_id` | Public | FK to roles (opaque UUID) |
| `mode` | Public | "browser", "live", or "simulation" |
| `provider` | Public | Provider string |
| `external_call_id` | Internal | External telephony provider call ID |
| `status` | Internal | Lifecycle status |
| `recording_url` | Internal | URL to recording; may contain signed URLs — handle with care |
| `recording_object_key` | Internal | Storage object key |
| `current_question_index` | Public | Zero-based question index |
| `started_at` | Public | Timestamp |
| `ended_at` | Public | Timestamp |
| `duration_sec` | Public | Integer seconds |
| `waiting_at` | Public | Timestamp |
| `terminal_reason` | Internal | Terminal state reason code |
| `owner_id` | Public | UUID auth.users reference |
| `updated_at` | Public | Timestamp |
| `provenance` | Internal | Model provenance JSON (LLM-06) |
| `interview_round_id` | Internal | Opaque R1 interview-round reference; only populated for R1 browser sessions |

### `screening_v2.transcript_turns`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `session_id` | Public | FK to call_sessions |
| `turn_index` | Public | Integer |
| `speaker` | Public | "bot" or "candidate" |
| `text` | **Confidential PII** | Turn text — candidate speech may contain PII |
| `created_at` | Public | Timestamp |
| `phase` | Internal | R1 conversation phase label |
| `interrupted` | Internal | Whether the turn was interrupted |

### R1 interview-round tables

| Column(s) | Classification | Notes |
|--------|---------------|-------|
| `interview_rounds.id`, `candidate_id`, `role_id`, `kind`, `status`, attempt counters, timestamps, `created_by`, `version` | Internal | R1 lifecycle and opaque references |
| `interview_rounds.link_token_digest` | **Secret** | One-time-link digest; never returned to browser roles or logs |
| `interview_rounds.candidate_status_at_send`, `recommendation`, `overall`, `assessment_id`, status-effect timestamps | Internal | Hiring workflow and scoring metadata |
| `interview_round_attempts.session_id`, `round_id`, attempt/persona/version/variant, `counted`, `outcome`, timestamps | Internal | R1 attempt administration metadata |
| `interview_round_attempts.content_sha` | Internal | Versioned R1 content-integrity digest |
| `interview_round_attempts.nonce_digest` | **Secret** | Reconnect nonce digest; never browser-readable |
| `interview_round_consent_templates` fields | Internal | Legal consent-copy versioning; immutable R1-only templates |
| `interview_round_consents.round_id`, `template_id`, consent timestamps | Internal | Consent lifecycle metadata |
| `interview_round_consents.consents`, `proof` | **Confidential PII** | Candidate consent declaration and proof may identify the candidate/device |
| `r1_settings` and `r1_budget_month` fields | Internal | R1 operating capacity, scoring thresholds and aggregate cost controls |

**Retention decision:** PENDING — legal review required. Transcript data may be subject to different retention periods than candidate profile data.

### `screening_v2.assessments`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `session_id` | Public | FK to call_sessions |
| `candidate_id` | Public | FK to candidates |
| `english` | Internal | JSON scorecard — language assessment |
| `tone` | Internal | JSON scorecard — tone assessment |
| `communication` | Internal | JSON scorecard — optional communication dimension |
| `motivation` | Internal | JSON scorecard — optional motivation dimension |
| `role_fit` | Internal | JSON scorecard — role fit assessment |
| `resume_conflicts` | Internal | JSON scorecard — optional resume conflicts |
| `overall_score` | Internal | Numeric 0–100 |
| `recommendation` | Internal | "advance", "hold", or "reject" |
| `summary` | **Confidential PII** | May contain references to PII or candidate-specific details |
| `raw` | **Confidential PII** | Raw assessment output; may contain transcript excerpts |
| `provenance` | Internal | Model provenance JSON |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |

**Retention decision:** PENDING — assessment data may have separate retention requirements under applicable employment law.

### `screening_v2.consent_records`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates |
| `source` | Internal | Consent source string |
| `version` | Public | GOV-03: Semver consent template version |
| `consents` | Internal | GOV-03: Array of consent_type enums granted/declined |
| `status` | Internal | GOV-09: granted, declined, or withdrawn |
| `proof` | **Confidential PII** | GOV-03: May contain evidence of consent with PII |
| `expires_at` | Public | GOV-03: Optional consent expiry |
| `classification_level` | Public | GOV-01: Data classification of this record (default 3) |
| `ip_address` | Internal | IP address of consent submission |
| `user_agent` | Internal | User agent of consent submission |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |

### `screening_v2.consent_templates`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `version` | Public | GOV-03: Template version string |
| `locale` | Public | Locale string (e.g. en-IN) |
| `title` | Internal | Privacy notice title |
| `body_md` | Internal | GOV-08: Markdown body — NOT Legal-approved placeholder |
| `required_consents` | Internal | Array of consent types required by this template version |
| `is_active` | Public | Whether this template is currently active |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |

### `screening_v2.call_queue`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates |
| `role_id` | Public | FK to roles |
| `status` | Internal | Queue status string |
| `attempts` | Public | Integer |
| `next_attempt_at` | Public | Timestamp |
| `created_at` | Public | Timestamp |

### `screening_v2.sms_follow_ups`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates |
| `template_id` | Internal | Template reference ID |
| `body` | **Confidential PII** | SMS message body; may contain candidate name/details |
| `status` | Internal | Status string |
| `created_at` | Public | Timestamp |

### `screening_v2.ats_sync_log`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates |
| `provider` | Internal | ATS provider name |
| `payload` | Internal | Sync payload; may contain candidate info |
| `status` | Internal | Status string |
| `created_at` | Public | Timestamp |

### `screening_v2.recruiter_memberships`

| Column | Classification | Notes |
|--------|---------------|-------|
| `user_id` | Public | UUID auth.users reference |
| `role` | Internal | "admin", "interviewer", or "viewer" |
| `active` | Internal | Boolean |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |

### `screening_v2.candidate_invites`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates |
| `session_id` | Public | FK to call_sessions |
| `token_digest` | **Secret** | SHA-256 hex digest; secret token equivalent |
| `expires_at` | Public | Timestamp |
| `revoked_at` | Public | Nullable timestamp |
| `consumed_at` | Public | Nullable timestamp |
| `created_by` | Public | UUID of creator |
| `created_at` | Public | Timestamp |
| `updated_at` | Public | Timestamp |

### `screening_v2.candidate_access_grants`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `candidate_id` | Public | FK to candidates |
| `session_id` | Public | FK to call_sessions |
| `room_name` | Internal | Room name string |
| `token_digest` | **Secret** | SHA-256 hex digest; secret token equivalent |
| `grant_type` | Internal | "view" or "screening" |
| `expires_at` | Public | Timestamp |
| `revoked_at` | Public | Nullable timestamp |
| `consumed_at` | Public | Nullable timestamp |
| `created_at` | Public | Timestamp |

### `screening_v2.audit_events`

| Column | Classification | Notes |
|--------|---------------|-------|
| `id` | Public | UUID primary key |
| `actor_id` | Public | Opaque UUID reference |
| `actor_type` | Internal | "recruiter", "system", "candidate", or "api_key" |
| `action` | Internal | Audit action string |
| `target_type` | Internal | Target entity type |
| `target_id` | Internal | Opaque reference ID |
| `result` | Internal | "success", "failure", or "pending" |
| `correlation_id` | Public | UUID for correlation |
| `metadata` | Internal | Bounded JSONB; by policy contains no PII |
| `created_at` | Public | Timestamp |

## Classification summary

| Level | Count | Examples |
|-------|-------|----------|
| Public | 61 | UUIDs, timestamps, booleans, integers, FK references |
| Internal | 46 | Status strings, JSON scorecards, job descriptions, provider names, consent arrays |
| Confidential PII | 8 | `name`, `email`, `phone_raw`, `phone_e164`, `text_extracted`, `text`, `body`, `summary`, `proof`, `parsed`, `raw` |
| Secret | 2 | `token_digest` (candidate_invites and candidate_access_grants) |
| PENDING legal | 5 | Resume content, transcript text, assessment summary, consent proof, SMS body |

## Machine verification

All columns in `screening_v2` tables (migrations 0001–0013) are classified above. The export tool (`scripts/migrate-export.mjs`) redacts all Confidential PII and Secret columns in its manifest output. The classification matrix can be automatically verified by scanning canonical column lists defined in `scripts/check-synthetic-seed.mjs` and `scripts/migrate-export.mjs`.

## Gaps and exceptions

1. **No legal determination** has been made regarding retention periods, right-to-erasure workflows, data portability, or cross-border transfer safeguards. All such columns are marked PENDING.
2. **Storage objects** (resumes_v2, recordings_v2) are not classified column-by-column here; their content types are constrained by `scripts/storage-manifest.mjs` allowlists, and the files themselves may contain PII. The manifest tool redacts content but does not classify individual storage objects.
3. **Audit metadata** is classified Internal because the system enforces a data-minimization policy; but if that policy is violated in a future change, metadata could become PII. The classification depends on the enforcement remaining in place.
