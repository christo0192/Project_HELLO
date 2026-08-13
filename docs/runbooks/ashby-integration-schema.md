# Runbook — Ashby integration schema (0029)

Scope: the normalized Ashby integration schema and paused-by-default
configuration added by migration `0029_ashby_integration.sql` and the domain
model in `app/api/src/integrations/ashby/integration-schema.ts`. This is
**schema/config foundation only** (Ashby Wave 2, plan Step 3). No Ashby API
calls, credentials, webhook route, reconciliation worker, resume processing,
invitation send, scorecard payload, stage movement, or Mission Control UI are
introduced. No real IDs or candidate data are seeded.

## Model

Five `screening_v2` tables, all service-role-only (RLS enabled; browser roles
revoked; no anon/authenticated/public policy):

| Table | Purpose | Identity / key |
|-------|---------|----------------|
| `ashby_job_mappings` | Paused-by-default per-job mapping | unique `(provider, external_job_id)` |
| `ashby_application_links` | Application-centric workflow identity | unique `(provider, external_application_id)` |
| `ashby_event_receipts` | Sanitized webhook/event receipts | unique `(provider, webhook_action_id, action)` |
| `ashby_resume_ingestions` | Ephemeral ingestion state machine | unique `(application_link_id)` |
| `ashby_operations` | Delivery + write-back outbox | unique `(provider, operation_key)` |

### Guarantees

- **Paused by default.** A mapping is `paused` on creation. It can only be
  `enabled` when both the AI and TA screening stage IDs are present
  (completeness CHECK) and it is not in `drift`. Stage IDs are per-mapping —
  never global or display-name routing. The invite TTL is fixed to 24h (Phase 1).
- **Drift auto-pauses.** `mark_ashby_mapping_drift` sets `status = 'drift'` with a
  sanitized reason and audits it; a drifted mapping is not enabled, so
  processing fails closed. `upsert_ashby_job_mapping` refuses to enable an
  incomplete or drifted mapping.
- **One identity per application.** The Ashby application ID is the workflow
  identity; links are never deduplicated by email/phone.
- **Idempotent receipts.** Duplicate and self-generated events converge to one
  receipt via the unique `(provider, webhook_action_id, action)`.
- **Ingestion state machine.** `queued → fetching → scanning → extracting →
  structuring → ready`, with `failed_review` (retriable to `queued`) and
  `cancelled` branches. Illegal transitions are rejected by a trigger. Only
  hash/version/provenance **references** are stored — never bytes or signed URLs.
- **Scorecard-before-stage.** A `stage_move` operation carrying a
  `depends_on_operation_id` cannot become `running`/`succeeded` until its
  dependency (`scorecard_write`) has succeeded (trigger).
- **Terminal blocks write-back.** Once an application link is
  `withdrawn`/`deleted`/`manual_stage_cancel`, creating any new operation is
  rejected (trigger). Terminal markers are modeled without deciding local
  erasure policy.
- **No PII in operational contracts.** Contact fields (email/phone), resume
  text/bytes/URLs, invite tokens, and raw webhook bodies live only in the
  existing sensitive candidate/invite model. These tables carry opaque IDs,
  an opaque resume file **handle** reference, sanitized codes, and bounded
  non-PII metadata (≤2 KiB).

## Administration

Two SECURITY DEFINER, service-role-only RPCs (pinned `search_path`, revoked from
`public/anon/authenticated`), each auditing in the same transaction:

- `upsert_ashby_job_mapping(...)` — race-safe create/update; fails closed on
  invalid delivery mode, non-24h TTL, or enabling an incomplete/drifted mapping;
  audits `ashby_mapping_update`.
- `mark_ashby_mapping_drift(mapping_id, reason, actor_id)` — idempotent
  auto-pause; audits `ashby_mapping_drift`.

No routes/OpenAPI/UI are added in this PR; administration is a later, separately
authorized surface.

## Verification

- Domain + structural: `app/api/src/__tests__/ashby-integration-schema.test.ts`
  (state machine, dependency ordering, enable/drift/terminal gates, forbidden
  operational keys; and migration proofs of unique identities, fail-closed RLS,
  service-role-only RPCs, fixed 24h TTL, triggers, and no PII/token columns).
- SQL policy tests: `app/supabase/tests/policy_tests.sql` (RLS/privilege +
  live functional controls: duplicate-application, incomplete-cannot-enable,
  invalid-transition, scorecard-before-stage, terminal-block, RPC gates).
- Migration gate: `node scripts/migrate-rollback.test.mjs` (forward-only,
  non-destructive, contract-continuous) and the real Docker Supabase clean apply
  of `0001–0029` with zero drift and restore rehearsal.

## Non-goals / residual gates

No real Ashby connectivity, credentials, webhook signature route, file fetch,
resume worker, invitation delivery, scorecard payload/stage saga, Plivo, or
deployment. Tenant probe must still pin real per-job stage/form/interview IDs
before any mapping is enabled with production data; privacy/legal must decide
the local erasure policy for withdrawn/deleted applications.
