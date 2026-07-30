# ADR-0009: Governance Field Protection (GOV-02)

**Status:** Proposed

**Decision owner:** Engineering Lead

**Plan references:** GOV-02, GOV-03, GOV-08, GOV-09, GOV-10

## Context

The system collects, processes, and stores candidate personal data including name, email, phone, resume content, voice recordings, transcripts, and assessment scorecards. Without explicit field-level protection, Confidential PII fields could be inadvertently exposed through API responses, logs, exports, or database queries.

This ADR defines the protection mechanism for governance-classified fields and establishes consent gating for sensitive operations.

## Decision

### 1. Field classification enforcement

All columns in `screening_v2` are classified per `docs/data-classification.md`. The following enforcement applies:

| Classification | Enforcement |
|----------------|-------------|
| **Public** (Level 1) | No restriction |
| **Internal** (Level 2) | Authenticated session required; safe to log without redaction |
| **Confidential PII** (Level 3) | Authenticated session + role check; MUST be redacted from logs, exports (non-essential), and error messages |
| **Secret** (Level 5) | Never logged, never returned in API responses, never exported |

### 2. Consent gating for sensitive operations (GOV-10)

Operations involving AI-conducted interviews or recording MUST check consent before proceeding. The `has_consent()` database function (migration 0013) enforces:

- `ai_interview` consent type required for AI screening sessions
- `recording` consent type required for recording capture
- `job_application` consent type alone is NOT sufficient for either (GOV-10)
- Consent must be in `granted` status and not expired

### 3. Consent is versioned (GOV-03)

Each consent record references a consent template version. This provides audit traceability:

- Template versions are stored in `consent_templates` table
- Each consent record captures the template version presented to the candidate
- Legal copy is placeholder-only until Legal approval (GOV-08)

### 4. Decline blocks sensitive operations (GOV-09)

- If a candidate declines consent, the join endpoint MUST refuse to create a session
- If a candidate withdraws consent, existing sessions SHOULD be terminated gracefully
- Decline/withdraw events are recorded as new consent_records rows (append-only)

## Consequences

### Positive

1. **Defense in depth**: Field classification provides a consistent framework for access control decisions
2. **Auditable consent**: Every consent grant, decline, and withdrawal is recorded with version and proof
3. **Clear gating**: Downstream code has a single `hasConsentFor()` helper to check permissions
4. **GOV-10 compliance**: Generic application consent cannot accidentally unlock AI/recording

### Negative

1. **Route mounting dependency**: Consent routes must be mounted in `app.ts` before they are reachable
2. **Template management**: Template content changes require new version rows and migration updates
3. **Legal dependency**: All privacy notice content is placeholder until Legal-approved copy is provided

### Security

1. **Consent is append-only**: No UPDATE or DELETE on consent records — withdrawal creates a new row
2. **Proof is Confidential PII**: The `proof` JSONB field is classified Level 3 and redacted from exports
3. **IP/user-agent captured**: Consent records include origin metadata for audit

### Migration

Migration 0013 is forward-only. Existing consent_records rows get default version '1.0' and empty consents array. No data backfill is required.

## Evidence

- Implementation: `app/api/src/routes/consent.ts`, `app/api/src/schemas/consent.ts`
- Database: `app/supabase/migrations/0013_consent_classification.sql`
- Tests: `app/api/src/__tests__/consent.test.ts`
- Frontend: `app/web/src/pages/PrivacyNoticePage.tsx`, updated `app/web/src/pages/CandidateJoinPage.tsx`
- Classification: `docs/data-classification.md` (GOV-01)

## Supersession

None.
