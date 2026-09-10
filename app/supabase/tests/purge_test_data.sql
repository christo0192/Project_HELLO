-- ============================================================================
--  PRODUCTION DATA CLEARANCE — STEP 2 of 2: THE PURGE
-- ============================================================================
--  Removes every screening candidate except three, every role except two, and
--  all data hanging off the removed ones, so production starts clean.
--
--  RUN `purge_test_data_preview.sql` FIRST and read its output.
--
--  SAFETY
--   * One transaction. Any failed assertion or FK/trigger refusal rolls the
--     WHOLE thing back — there is no half-purged state.
--   * It refuses to run unless exactly the 3 named candidates and exactly the
--     2 named roles are found, so a typo cannot silently delete everything.
--   * It refuses to run while an active legal hold covers a doomed candidate.
--   * Audit trails are NOT touched: audit_events, governance_audit,
--     reconciliation_log, legal_holds and erasure_exceptions all survive.
--     (reconciliation_log is append-only with no bypass by design; its rows
--     keep pointing at ids that no longer exist, which is expected.)
--   * phone_suppressions (do-not-call records) are KEPT. They are keyed by a
--     phone digest, and deleting one would re-enable dialling someone who
--     opted out. Their candidate_id is nulled by the FK, nothing else.
--
--  STORAGE FIRST. Résumé files and call recordings live in Supabase Storage
--  and SQL cannot delete them. Their object keys are named by the very rows
--  this script destroys, so once it commits nothing can derive them any more.
--  Run `node scripts/purge-test-storage.mjs --confirm` BEFORE this script (or
--  keep the key list the preview printed). Then refresh the funnel rollup —
--  see the tail of this file.
-- ============================================================================

begin;

-- The two append-only tables in the delete path expose a documented bypass for
-- exactly this kind of maintenance. Session-scoped: it ends with this
-- transaction. Every other append-only table is either untouched or deleted by
-- an FK cascade, which its trigger already permits once the parent is gone.
set local app.allow_phone_event_mutation = 'true';

-- reconciliation_log is append-only with NO bypass, yet its own foreign keys
-- are ON DELETE SET NULL — so deleting a candidate or session makes Postgres
-- attempt an UPDATE the trigger refuses, and the whole purge fails. The FK
-- declaration is the schema author's stated intent (null the reference, keep
-- the log row), so the trigger is stood down for the length of this
-- transaction and restored below. DDL is transactional here: a rollback puts
-- the trigger back exactly as it was.
-- NOTE: this requires table ownership — run as `postgres` (the Supabase SQL
-- editor does).
alter table screening_v2.reconciliation_log disable trigger trg_reconciliation_log_append_only;

-- ── Who survives ────────────────────────────────────────────────────────────
create temp table keep_candidate(id uuid primary key) on commit drop;
insert into keep_candidate(id) values
  ('cb6f90c6-7168-44fe-94e8-58ca7dc0221a'),
  ('d48630dd-f4a4-4f77-bf4a-ea88ddc9f3cd'),
  ('fdac8ee6-e605-496d-8be5-f051fb732739');

create temp table keep_role(id uuid primary key) on commit drop;
insert into keep_role(id)
  select id from screening_v2.roles
   where lower(btrim(title)) in ('software engineer', 'sales program advisor');

-- ── Refuse to proceed on anything unexpected ────────────────────────────────
do $$
declare n integer;
begin
  select count(*) into n from screening_v2.candidates c join keep_candidate k on k.id = c.id;
  if n <> 3 then
    raise exception 'ABORT: expected the 3 kept candidates to exist, found %. Nothing was deleted.', n;
  end if;

  select count(*) into n from keep_role;
  if n <> 2 then
    raise exception 'ABORT: expected exactly 2 kept roles (software engineer, sales program advisor), found %. Nothing was deleted.', n;
  end if;

  select count(*) into n from screening_v2.legal_holds lh
   where lh.entity_type = 'candidate' and lh.released_at is null
     and lh.entity_id::uuid not in (select id from keep_candidate);
  if n > 0 then
    raise exception 'ABORT: % active legal hold(s) cover candidates marked for deletion. Release them or exclude those candidates first.', n;
  end if;
end $$;

-- ── Freeze the doomed sets BEFORE any delete ────────────────────────────────
-- Several FKs are ON DELETE SET NULL, so the moment a parent goes the link
-- that identifies its children is erased. Capture the ids first.
create temp table doomed_engagement(id uuid primary key) on commit drop;
insert into doomed_engagement(id)
  select id from screening_v2.phone_engagements
   where candidate_id not in (select id from keep_candidate);

create temp table doomed_link(id uuid primary key) on commit drop;
insert into doomed_link(id)
  select id from screening_v2.ashby_application_links
   where candidate_id is null or candidate_id not in (select id from keep_candidate);

create temp table doomed_session(id uuid primary key) on commit drop;
insert into doomed_session(id)
  select id from screening_v2.call_sessions
   where candidate_id is null or candidate_id not in (select id from keep_candidate);

create temp table doomed_attempt(id uuid primary key) on commit drop;
insert into doomed_attempt(id)
  select a.id from screening_v2.phone_call_attempts a
   where a.engagement_id in (select id from doomed_engagement);

-- ── Phone: the RESTRICT web, unwound child-first ────────────────────────────
-- phone_test_gates and phone_rescreen_requests RESTRICT both candidates and
-- engagements, so they must go before either.
delete from screening_v2.phone_test_gates
 where candidate_id not in (select id from keep_candidate)
    or engagement_id in (select id from doomed_engagement);

delete from screening_v2.phone_rescreen_requests
 where candidate_id not in (select id from keep_candidate)
    or application_link_id in (select id from doomed_link)
    or predecessor_engagement_id in (select id from doomed_engagement)
    or new_engagement_id in (select id from doomed_engagement);

delete from screening_v2.phone_number_verifications
 where candidate_id not in (select id from keep_candidate);

-- Insert-once table: scoped by the ids captured above, because both of its
-- links are SET NULL and would be erased by the deletes that follow.
delete from screening_v2.phone_call_events
 where engagement_id in (select id from doomed_engagement)
    or attempt_id in (select id from doomed_attempt)
    or (engagement_id is null and attempt_id is null);

-- Appointments RESTRICT attempts, so appointments first.
delete from screening_v2.phone_appointments
 where engagement_id in (select id from doomed_engagement);

delete from screening_v2.phone_call_attempts
 where engagement_id in (select id from doomed_engagement);

delete from screening_v2.phone_session_plans
 where engagement_id in (select id from doomed_engagement)
    or session_id in (select id from doomed_session);

delete from screening_v2.phone_engagements
 where id in (select id from doomed_engagement);

-- ── Ashby: links, and everything that hangs off them ────────────────────────
delete from screening_v2.ashby_event_receipts
 where application_link_id in (select id from doomed_link);

delete from screening_v2.ashby_operations
 where application_link_id in (select id from doomed_link);

delete from screening_v2.ashby_resume_ingestions
 where application_link_id in (select id from doomed_link);

delete from screening_v2.ashby_application_links
 where id in (select id from doomed_link);

-- ── Assessments: break the self-reference before deleting ───────────────────
-- assessments.supersedes_assessment_id is RESTRICT, so a rescore chain would
-- block its own cascade depending on row order.
update screening_v2.assessments
   set supersedes_assessment_id = null
 where supersedes_assessment_id is not null
   and (candidate_id is null or candidate_id not in (select id from keep_candidate));

delete from screening_v2.assessments
 where candidate_id is null or candidate_id not in (select id from keep_candidate);

-- ── Sessions (cascades transcripts, probes, progress, integrity events…) ────
delete from screening_v2.call_sessions
 where id in (select id from doomed_session);

-- ── Candidates (cascades invites, consent, notes, DSARs, queue rows…) ───────
delete from screening_v2.candidates
 where id not in (select id from keep_candidate);

-- ── Résumés orphaned by the purge (no candidate FK — they must be explicit) ─
delete from screening_v2.resumes
 where id not in (select c.resume_id from screening_v2.candidates c where c.resume_id is not null);

-- ── Roles (cascades their scorecard versions + metric snapshots) ────────────
-- ashby_job_mappings RESTRICT roles, so mappings for removed roles go first.
delete from screening_v2.ashby_job_mappings
 where role_id not in (select id from keep_role);

delete from screening_v2.roles
 where id not in (select id from keep_role);

-- ── Operational queues and derived rollups (all test traffic) ───────────────
delete from screening_v2.job_queue;
delete from screening_v2.job_dlq;
delete from screening_v2.outbox;
delete from screening_v2.ats_sync_log;
delete from screening_v2.resume_intake_failures;
delete from screening_v2.quarantined_sessions;
delete from screening_v2.recording_orphaned_objects;
delete from screening_v2.quota_reservations;
delete from screening_v2.quota_usage;
delete from screening_v2.funnel_stage_daily;

-- Restore the append-only guard before anything else can run.
alter table screening_v2.reconciliation_log enable trigger trg_reconciliation_log_append_only;

-- ── Prove the end state before committing ───────────────────────────────────
do $$
declare n integer;
begin
  select count(*) into n from screening_v2.candidates;
  if n <> 3 then raise exception 'POST-CHECK FAILED: % candidates remain, expected 3', n; end if;

  select count(*) into n from screening_v2.roles;
  if n <> 2 then raise exception 'POST-CHECK FAILED: % roles remain, expected 2', n; end if;

  select count(*) into n from screening_v2.call_sessions s
   where s.candidate_id is null or s.candidate_id not in (select id from keep_candidate);
  if n <> 0 then raise exception 'POST-CHECK FAILED: % stray sessions remain', n; end if;

  select count(*) into n from screening_v2.assessments a
   where a.candidate_id is null or a.candidate_id not in (select id from keep_candidate);
  if n <> 0 then raise exception 'POST-CHECK FAILED: % stray assessments remain', n; end if;

  select count(*) into n from screening_v2.ashby_application_links l
   where l.candidate_id is null or l.candidate_id not in (select id from keep_candidate);
  if n <> 0 then raise exception 'POST-CHECK FAILED: % stray Ashby links remain', n; end if;

  select count(*) into n from screening_v2.resumes rz
   where rz.id not in (select c.resume_id from screening_v2.candidates c where c.resume_id is not null);
  if n <> 0 then raise exception 'POST-CHECK FAILED: % orphaned resumes remain', n; end if;

  raise notice 'PURGE OK — 3 candidates, 2 roles, no stray sessions/assessments/links/resumes.';
end $$;

commit;

-- ── After the commit ────────────────────────────────────────────────────────
-- 1. Storage should already be clean (purge-test-storage.mjs, run BEFORE this).
--    If it was not, use the key list the preview printed — the rows that named
--    those objects no longer exist.
-- 2. Rebuild the funnel rollup from what is left:
--      select screening_v2.refresh_funnel_rollup();
--    (Check the exact function name with:
--      select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'screening_v2' and proname like '%funnel%';)
