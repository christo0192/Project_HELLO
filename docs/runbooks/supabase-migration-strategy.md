# Supabase Migration Strategy

**Date:** 2026-07-28

**Target:** Newly created, unused production project

**Decision:** Fresh safe history plus a forward hardening migration

## Strategy

The production project applies migrations `0001` through `0004` only after a local reset and review. Historical migrations `0001` and `0002` are corrected in source because the new project has never applied them: they no longer grant browser roles broad privileges or create anonymous read policies. This prevents an unsafe intermediate production state.

Migration `0004` is also a forward hardening path for prototype development databases that previously applied the old history. Such databases are non-production and must be reset or reconciled explicitly; this PR does not migrate old candidate data.

## Final database boundary

- `anon` has no schema/table policy or privilege in `screening_v2`.
- A valid Supabase Auth account alone has no data access.
- `screening_v2.recruiter_memberships` is a server-provisioned single-org allowlist with `admin`, `interviewer`, and `viewer` role values.
- An active member receives read-only access to all dashboard tables: roles, candidates, sessions, transcript turns, assessments, consent records, call queue, SMS follow-ups, ATS sync log, and resume metadata.
- Browser roles receive no direct database writes and no direct resume/recording storage access.
- Server-only `service_role` performs all writes.
- Realtime publishes only call_sessions, transcript_turns, and assessments; existing RLS policies still apply to subscriptions.
- Public recruiter signup is disabled in local parity configuration.
- **recording_url is deprecated** (MIG-03/04/05): the column is constrained to always be NULL. Use `recording_object_key` for persisted storage references. Signed/presigned URLs are generated on-demand with a short TTL and are NEVER persisted to the database.

## Why this is intentionally limited

This is a production-safe database seam, not completion of SEC-01 through SEC-04 or MIG-04 through MIG-06. The application still needs MFA, RBAC middleware, authorized candidate invitations, role-sensitive API behavior, storage URL minting, and production Supabase configuration evidence before launch.

## Migration 0008 — Phase 2 WS-A

Migration 0008 (`0008_recording_deprecation_rls_hardening.sql`) is forward-only and:

1. **Deprecates recording_url** without dropping the column:
   - Aborts with an exception if any non-null `recording_url` values exist (fail-closed — no silent data loss).
   - Adds a validated CHECK constraint (`chk_call_sessions_recording_url_null`) forcing `recording_url IS NULL`.
   - Documents `recording_object_key` as the authorized alternative.
   - The column WILL be dropped in a future migration after all code paths referencing it are removed.

2. **Completes the RLS matrix** for all screening_v2 tables:
   - Adds `active recruiter read` SELECT policies for `consent_records`, `call_queue`, `sms_follow_ups`, `ats_sync_log`, and `resumes`.
   - Verifies `service_role` has full access to all tables.
   - Verifies `authenticated` has no INSERT/UPDATE/DELETE grants.
   - Preserves single-org D-011 posture (no org_id/organization_id/tenant_id columns).
   - Preserves all Phase1 behavior (is_active_recruiter, recruiter_role, helpers unchanged).

3. **Realtime publication assertions** (in policy_tests.sql):
   - Verifies `supabase_realtime` publication exists.
   - Verifies it contains only `call_sessions`, `transcript_turns`, `assessments`.
   - Verifies all published tables have RLS enabled.
   - Verifies no anon/PUBLIC policies on published tables.
   - Honest about local limitations: cannot prove hosted Realtime RLS enforcement.

4. **Adversarial assertions** (in policy_tests.sql):
   - INSERT with non-null recording_url is REJECTED (live test).
   - UPDATE to set recording_url is REJECTED (live test).
   - No USING(true) or WITH CHECK(true) policies exist.
   - All SECURITY DEFINER functions have fixed `search_path=pg_catalog`.
   - No anon/PUBLIC can execute SECURITY DEFINER functions.
   - No authenticated INSERT/UPDATE/DELETE grants on user-facing tables.
   - `candidate_invites` and `candidate_access_grants` have zero authenticated policies.

## Compatibility and stop conditions

Before any non-empty database receives `0004`, check for invalid status values and duplicate `(session_id, turn_index)` rows. Stop rather than deleting or transforming unexplained data. The new production project should be empty, so any pre-existing application row is a no-go signal.

Before migration `0008`, verify that all `recording_url` values are already NULL. The migration aborts (fail-closed) if any non-null value exists — this is a data integrity event that must be investigated before proceeding.

Supabase migrations are forward-only. Do not edit `supabase_migrations.schema_migrations` to simulate rollback. Before traffic, a failed apply is recovered by correcting the migration and recreating/resetting the unused project under owner approval. After traffic or data exists, recovery requires the approved backup/restore and roll-forward process.

## Forward/fail-forward/rollback boundaries for 0008

- **Forward**: Migration 0008 adds constraints and policies only — no column drops, no data transformations beyond nullifying recording_url.
- **Fail-forward**: If 0008 fails (e.g., a row violates recording_url IS NULL), identify the offending row, set recording_url = NULL, and re-run.
- **Rollback**: Not supported by Supabase. Recovery requires `db reset` from clean migrations or a full backup/restore.
- **Drift detection**: Run `supabase db diff --use-pg-delta` from `app/`. Unexpected differences between local and committed migrations should be investigated before reset.
