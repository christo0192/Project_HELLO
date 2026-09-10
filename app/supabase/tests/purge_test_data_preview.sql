-- ============================================================================
--  PRODUCTION DATA CLEARANCE — STEP 1 of 2: PREVIEW (READ ONLY)
-- ============================================================================
--  Paste into the Supabase SQL editor and run. It DELETES NOTHING. It reports
--  what step 2 (purge_test_data.sql) would remove, and the storage object keys
--  that SQL cannot remove for you.
--
--  Read the CHECK rows first. If "KEEP candidates found" is not 3, or
--  "KEEP roles found" is not 2, the purge will refuse to run — fix the ids or
--  the role titles before going further.
-- ============================================================================

with keep_candidate(id) as (
  values ('cb6f90c6-7168-44fe-94e8-58ca7dc0221a'::uuid),
         ('d48630dd-f4a4-4f77-bf4a-ea88ddc9f3cd'::uuid),
         ('fdac8ee6-e605-496d-8be5-f051fb732739'::uuid)
),
keep_role as (
  select id, title from screening_v2.roles
   where lower(btrim(title)) in ('software engineer', 'sales program advisor')
),
checks(ord, section, item, detail) as (
  select 1, 'CHECK', 'KEEP candidates found (must be 3)',
         (select count(*)::text from screening_v2.candidates c join keep_candidate k on k.id = c.id)
  union all
  select 1, 'CHECK', 'KEEP roles found (must be 2)', (select count(*)::text from keep_role)
  union all
  select 1, 'CHECK', 'KEEP role titles',
         coalesce((select string_agg(title, ' | ' order by title) from keep_role), '(none)')
  union all
  select 1, 'CHECK', 'Roles that WILL BE DELETED',
         coalesce((select string_agg(title, ' | ' order by title) from screening_v2.roles r
                    where r.id not in (select id from keep_role)), '(none)')
  union all
  select 1, 'CHECK', 'Active legal holds blocking the purge (must be 0)',
         (select count(*)::text from screening_v2.legal_holds lh
           where lh.entity_type = 'candidate' and lh.released_at is null
             and lh.entity_id::uuid not in (select id from keep_candidate))
  union all
  select 1, 'CHECK', 'Kept candidates and their current role',
         coalesce((select string_agg(coalesce(c.name, '(unnamed)') || ' → ' || coalesce(r.title, '(no role)'), '  |  ')
                     from screening_v2.candidates c
                     join keep_candidate k on k.id = c.id
                     left join screening_v2.roles r on r.id = c.role_id), '(none)')
),
counts(ord, section, item, detail) as (
  select 2, 'DELETE', t.item, t.n::text from (
    select 'candidates' as item, count(*) as n from screening_v2.candidates
      where id not in (select id from keep_candidate)
    union all select 'call_sessions', count(*) from screening_v2.call_sessions
      where candidate_id is null or candidate_id not in (select id from keep_candidate)
    union all select 'assessments', count(*) from screening_v2.assessments
      where candidate_id is null or candidate_id not in (select id from keep_candidate)
    union all select 'transcript_turns', count(*) from screening_v2.transcript_turns t2
      where not exists (select 1 from screening_v2.call_sessions s
                        join keep_candidate k on k.id = s.candidate_id where s.id = t2.session_id)
    union all select 'resumes (incl. never-linked orphans)', count(*) from screening_v2.resumes rz
      where rz.id not in (select c.resume_id from screening_v2.candidates c
                           join keep_candidate k on k.id = c.id where c.resume_id is not null)
    union all select 'candidate_invites', count(*) from screening_v2.candidate_invites
      where candidate_id not in (select id from keep_candidate)
    union all select 'consent_records', count(*) from screening_v2.consent_records
      where candidate_id not in (select id from keep_candidate)
    union all select 'recruiter_notes', count(*) from screening_v2.recruiter_notes
      where candidate_id not in (select id from keep_candidate)
    union all select 'phone_engagements', count(*) from screening_v2.phone_engagements
      where candidate_id not in (select id from keep_candidate)
    union all select 'phone_call_attempts', count(*) from screening_v2.phone_call_attempts a
      where not exists (select 1 from screening_v2.phone_engagements e
                        join keep_candidate k on k.id = e.candidate_id where e.id = a.engagement_id)
    union all select 'phone_appointments', count(*) from screening_v2.phone_appointments p
      where not exists (select 1 from screening_v2.phone_engagements e
                        join keep_candidate k on k.id = e.candidate_id where e.id = p.engagement_id)
    union all select 'phone_call_events', count(*) from screening_v2.phone_call_events ev
      where (ev.engagement_id is null and ev.attempt_id is null)
         or not exists (select 1 from screening_v2.phone_engagements e
                        join keep_candidate k on k.id = e.candidate_id where e.id = ev.engagement_id)
    union all select 'phone_test_gates', count(*) from screening_v2.phone_test_gates
      where candidate_id not in (select id from keep_candidate)
    union all select 'phone_rescreen_requests', count(*) from screening_v2.phone_rescreen_requests
      where candidate_id not in (select id from keep_candidate)
    union all select 'phone_number_verifications', count(*) from screening_v2.phone_number_verifications
      where candidate_id not in (select id from keep_candidate)
    union all select 'ashby_application_links (incl. orphans)', count(*) from screening_v2.ashby_application_links
      where candidate_id is null or candidate_id not in (select id from keep_candidate)
    union all select 'ashby_operations', count(*) from screening_v2.ashby_operations o
      where not exists (select 1 from screening_v2.ashby_application_links l
                        join keep_candidate k on k.id = l.candidate_id where l.id = o.application_link_id)
    union all select 'ashby_resume_ingestions', count(*) from screening_v2.ashby_resume_ingestions i
      where not exists (select 1 from screening_v2.ashby_application_links l
                        join keep_candidate k on k.id = l.candidate_id where l.id = i.application_link_id)
    union all select 'ashby_job_mappings (for removed roles)', count(*) from screening_v2.ashby_job_mappings
      where role_id not in (select id from keep_role)
    union all select 'roles', count(*) from screening_v2.roles
      where id not in (select id from keep_role)
    union all select 'role_scorecard_versions (for removed roles)', count(*) from screening_v2.role_scorecard_versions
      where role_id not in (select id from keep_role)
    union all select 'job_queue (cleared entirely)', count(*) from screening_v2.job_queue
    union all select 'job_dlq (cleared entirely)', count(*) from screening_v2.job_dlq
    union all select 'outbox (cleared entirely)', count(*) from screening_v2.outbox
    union all select 'funnel_stage_daily (cleared, rebuilt on refresh)', count(*) from screening_v2.funnel_stage_daily
  ) t where t.n > 0
),
kept(ord, section, item, detail) as (
  select 3, 'KEPT', 'audit_events', count(*)::text from screening_v2.audit_events
  union all select 3, 'KEPT', 'governance_audit', count(*)::text from screening_v2.governance_audit
  union all select 3, 'KEPT', 'reconciliation_log (references nulled)', count(*)::text from screening_v2.reconciliation_log
  union all select 3, 'KEPT', 'phone_suppressions (do-not-call)', count(*)::text from screening_v2.phone_suppressions
  union all select 3, 'KEPT', 'legal_holds', count(*)::text from screening_v2.legal_holds
),
storage(ord, section, item, detail) as (
  select 4, 'STORAGE — delete these objects by hand', 'resume file', rz.file_path
    from screening_v2.resumes rz
   where rz.file_path is not null
     and rz.id not in (select c.resume_id from screening_v2.candidates c
                        join keep_candidate k on k.id = c.id where c.resume_id is not null)
  union all
  select 4, 'STORAGE — delete these objects by hand', 'recording object', s.recording_object_key
    from screening_v2.call_sessions s
   where s.recording_object_key is not null
     and (s.candidate_id is null or s.candidate_id not in (select id from keep_candidate))
)
select section, item, detail
from (select * from checks union all select * from counts
      union all select * from kept union all select * from storage) x
order by ord, item;
