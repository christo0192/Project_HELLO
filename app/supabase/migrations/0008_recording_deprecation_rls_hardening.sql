-- =====================================================================
-- 0008 — Phase 2 WS-A: recording_url deprecation, RLS matrix completion,
--        Realtime publication hardening, and local-reset guards
--        (MIG-03/04/05 + MIG-06 DB guard).
--
-- Forward-only: the recording_url column is NOT dropped — it is
-- constrained to always be NULL. This prevents any durable URL
-- persistence while preserving the schema for any legacy code paths
-- that reference the column.
--
-- DESIGN:
--   1. recording_url deprecation (MIG-03/04/05)
--      a. Ensure existing rows are NULL
--      b. Add validated CHECK constraint forcing recording_url IS NULL
--      c. Document recording_object_key as the authorized alternative
--   2. RLS matrix completion
--      a. Service-role/backend identity assertions (where locally testable)
--      b. Add policy coverage for transcript_turns, assessments,
--         consent_records, call_queue, sms_follow_ups, ats_sync_log
--      c. Preserve single-org D-011 posture and Phase1 behavior
--   3. Realtime publication membership assertions
--      a. Verify publication includes only expected dashboard tables
--      b. Add authorization/filter-oriented policy coverage
--      c. Honest about what SQL can prove locally
--   4. Hardening
--      a. Double-seed/idempotency: verify seed INSERTs are stable
--      b. Document forward/fail-forward/rollback boundaries
--      c. No hosted commands, no production claims
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. recording_url deprecation (MIG-03/04/05)
-- ═══════════════════════════════════════════════════════════════════════

-- Deprecation note on the existing column. This COMMENT serves as the
-- formal deprecation signal to developers and code generators.
comment on column screening_v2.call_sessions.recording_url is
  'DEPRECATED — MIG-03/04/05. Never populated. Use recording_object_key '
  'instead (REC-05). The recording_object_key column stores the S3 object '
  'key; signed/presigned URLs are generated on-demand by the backend with '
  'a short TTL and are NEVER persisted to the database. '
  'This column is constrained to always be NULL. '
  'It WILL be dropped in a future migration after all code paths that '
  'reference recording_url are removed.';

-- Step 1a: Fail-closed guard — abort if any non-null recording_url exists.
-- The migration MUST NOT silently destroy data. If a non-null value is
-- found, the migration halts and the operator must investigate and
-- resolve the data before re-applying. After this migration, the column
-- is constrained to always be NULL.
do $$
declare
  v_count bigint;
begin
  select count(*) into v_count
    from screening_v2.call_sessions
   where recording_url is not null;

  if v_count > 0 then
    raise exception 'MIG-03/04/05: % row(s) have non-null recording_url. This migration requires all recording_url values to be NULL. Investigate and resolve before re-applying.', v_count
      using errcode = 'P0001';
  end if;
end;
$$;

-- Step 1b: Add a validated CHECK forcing recording_url IS NULL.
-- This is a DDL constraint, not a soft application check. Any attempt
-- to INSERT or UPDATE recording_url to a non-null value will fail
-- at the database boundary regardless of which role or caller attempts it.
--
-- NOT VALID is used initially so the ALTER does not scan the table,
-- then VALIDATE confirms all rows satisfy the constraint. Step 1a above
-- already aborted if any non-null row existed, so VALIDATE will succeed.
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_url_null;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_url_null
    check (recording_url is null)
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_url_null;

comment on constraint chk_call_sessions_recording_url_null
  on screening_v2.call_sessions is
  'MIG-03/04/05: recording_url is deprecated and must always be NULL. '
  'Use recording_object_key for persisted storage references. '
  'This constraint will be removed when the column is dropped.';

-- Step 1c: Reinforce recording_object_key documentation.
-- The column was added in migration 0007 (REC-05). This comment
-- expansion explains the on-demand access pattern.
comment on column screening_v2.call_sessions.recording_object_key is
  'REC-05 / MIG-06: S3 object key for the recording file. NULL before '
  'recording is finalized. The backend resolves this key to a short-TTL '
  'signed URL at read time; no signed/presigned URL is ever persisted. '
  'Bounded to 512 chars and a restricted character set. '
  'Authorized on-demand access: the API validates the recruiter role '
  'and ownership scope before minting the signed URL. '
  'This is the ONLY column for recording storage references.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. RLS matrix completion
-- ═══════════════════════════════════════════════════════════════════════

-- ── 2a. Service-role / backend identity assertions ──────────────────
-- service_role is the only identity that should have INSERT/UPDATE/DELETE
-- on screening_v2 tables. This section ensures authenticated browser
-- sessions are read-only at the database boundary.
-- These are documented here; the actual negative tests live in
-- policy_tests.sql (see adversarial assertions section).

-- ── 2b. Policy coverage for remaining dashboard tables ───────────────
-- transcript_turns and assessments already have "active recruiter read"
-- policies from migration 0007. The following tables need explicit
-- membership-gated policies to prevent accidental implied access:
--   - consent_records (candidate consent audit log)
--   - call_queue (telephony scheduling queue — rows visible for monitoring)
--   - sms_follow_ups (SMS delivery history)
--   - ats_sync_log (Ashby sync log)
--   - resumes (metadata only — no file content exposed via PostgREST)

-- Drop any existing policies that might conflict; then create new ones
-- that mirror the Phase1 pattern for active-recruiter-gated SELECT.

drop policy if exists "active recruiter read consent_records"
  on screening_v2.consent_records;
drop policy if exists "active recruiter read call_queue"
  on screening_v2.call_queue;
drop policy if exists "active recruiter read sms_follow_ups"
  on screening_v2.sms_follow_ups;
drop policy if exists "active recruiter read ats_sync_log"
  on screening_v2.ats_sync_log;
drop policy if exists "active recruiter read resumes"
  on screening_v2.resumes;

-- An active recruiter can SELECT consent records (append-only audit log).
-- No writes via browser; consent is managed server-side through
-- consent_records table (service_role only).
create policy "active recruiter read consent_records"
  on screening_v2.consent_records for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- Call queue is read-only for active recruiters (monitoring).
-- Writes are service_role only (telephony scheduling).
create policy "active recruiter read call_queue"
  on screening_v2.call_queue for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- SMS follow-up history is read-only for active recruiters.
create policy "active recruiter read sms_follow_ups"
  on screening_v2.sms_follow_ups for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- ATS sync log is read-only for active recruiters.
create policy "active recruiter read ats_sync_log"
  on screening_v2.ats_sync_log for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- Resume metadata is read-only for active recruiters.
-- The actual file content is in storage.objects (server-only).
create policy "active recruiter read resumes"
  on screening_v2.resumes for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- ── 2c. Ensure service_role has full access to all tables ────────────
-- (This is the default via migration 0001's grants, but we re-assert
-- coverage for any tables that may have been added since.)
grant all privileges on screening_v2.consent_records  to service_role;
grant all privileges on screening_v2.call_queue        to service_role;
grant all privileges on screening_v2.sms_follow_ups    to service_role;
grant all privileges on screening_v2.ats_sync_log      to service_role;
grant all privileges on screening_v2.resumes           to service_role;

grant select on screening_v2.consent_records,
                screening_v2.call_queue,
                screening_v2.sms_follow_ups,
                screening_v2.ats_sync_log,
                screening_v2.resumes
  to authenticated;

-- ── 2d. Grants check: authenticated has no INSERT/UPDATE/DELETE on any
--       screening_v2 table. This is tested in policy_tests.sql.
--       Service role bypasses RLS, so no explicit policies needed.
--       Single-org D-011 posture preserved: no org_id column, no
--       multi-tenant branching in any policy or helper function.
--       Phase1 behavior preserved: is_active_recruiter(), recruiter_role(),
--       _is_admin_or_viewer(), _is_interviewer() unchanged.

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Realtime publication hardening
-- ═══════════════════════════════════════════════════════════════════════

-- ── 3a. Verify Realtime publication membership ──────────────────────
-- The supabase_realtime publication should contain only the three
-- dashboard tables: call_sessions, transcript_turns, assessments.
-- This is asserted in policy_tests.sql (count = 3, no extra tables).
-- Supabase's apply_sql() does NOT support ALTER PUBLICATION inside
-- a migration (publications are managed by the hosted platform).
-- What we can do locally:
--   1. Assert that no other screening_v2 tables are in the publication
--      (tested in policy_tests.sql).
--   2. Document the expected membership for production verification.
--
-- Honest local limitation: We cannot ALTER PUBLICATION in a migration.
-- The publication check in policy_tests.sql uses pg_publication_tables
-- which accurately reflects what Supabase has configured. If the
-- publication includes unexpected tables, the test catches it.

comment on schema screening_v2 is
  'Screening v2 schema. Realtime publication supabase_realtime includes '
  'only call_sessions, transcript_turns, and assessments. '
  'Publication membership is managed by Supabase hosted platform — '
  'ALTER PUBLICATION is not applied via migration. '
  'See policy_tests.sql for pg_publication_tables assertions.';

-- ── 3b. Authorization/filter-oriented policy coverage ───────────────
-- The existing RLS policies on published tables filter rows at the
-- database level. Realtime respects RLS — a subscriber sees only rows
-- they have SELECT access to. The RLS policies already in place
-- (migration 0004/0007) ensure:
--   - Anon subscribers have zero access (no anon policies)
--   - Non-recruiter authenticated users see zero rows
--   - Active recruiters see rows gated by membership
--
-- What SQL can prove locally:
--   - That RLS is enabled on published tables
--   - That no anon/authenticated-without-membership policies exist
--   - That membership-gated policies exist
--   - That is_active_recruiter() is SECURITY DEFINER with fixed search_path
--
-- What SQL CANNOT prove locally:
--   - That the Supabase Realtime server correctly enforces RLS
--     (this is a hosted platform behavior)
--   - That publication membership matches production configuration
--     (local Supabase may differ from hosted)
--   - That websocket-level authorization works correctly
--     (end-to-end test requires a real Realtime client)
--
-- This honest assessment prevents false confidence. The assertions
-- in policy_tests.sql are explicit about what they prove.

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Hardening: local reset/diff/drift guards
-- ═══════════════════════════════════════════════════════════════════════

-- ── 4a. Double-seed/idempotency guard ───────────────────────────────
-- The seed.sql file uses ON CONFLICT DO NOTHING for every INSERT,
-- making it idempotent by construction. Running it twice produces
-- exactly the same rows.
-- The supabase-test.sh script verifies this by:
--   1. Running db reset (which applies migrations + seed)
--   2. Recording GOV-06 namespace row counts
--   3. Re-applying seed.sql explicitly
--   4. Verifying cardinality is unchanged
--
-- This migration adds no new seed data. The existing GOV-06 seed
-- is the single source of truth for synthetic demo data.

-- ── 4b. Forward/fail-forward/rollback boundaries ────────────────────
-- Supabase migrations are forward-only. This migration (0008) adds
-- constraints and policies but does NOT drop columns or tables.
-- Rollback is not supported — the correct recovery procedure for
-- a failed apply is:
--
--   1. Stop traffic to the project (or use a freshly created one).
--   2. Run `supabase db reset` to recreate from scratch.
--   3. All constraints are re-applied by the migration sequence.
--
-- If this migration fails during APPLY (e.g., the DO-block abort finds
-- non-null recording_url values, or VALIDATE CONSTRAINT fails):
--   1. Identify the offending row(s) — this is a data integrity event.
--   2. If they are production data, STOP and investigate. The column
--      should never have been populated; non-null values indicate a
--      previous integration error or legacy backfill.
--   3. Only proceed after understanding the provenance of the value.
--      NEVER silently nullify production data.
--   4. If the values are confirmed safe to discard, set recording_url =
--      NULL manually, then re-run the migration.
--   5. NEVER skip the constraint or edit supabase_migrations.
--
-- Local drift detection:
--   `supabase db diff --use-pg-delta` from the app/ directory.
--   If the diff shows unexpected differences between local and
--   committed migrations, investigate before resetting.
--   Common sources of drift:
--     - Manual DDL applied via docker exec (fix: reset)
--     - Uncommitted migration changes (fix: commit or revert)
--     - Hosted Supabase schema drift (fix: production migration)
--
-- No hosted commands are executed by this migration.
-- No production claims or data references are made.

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
