-- =====================================================================
-- 0004 — Production hardening for single-org Supabase Auth.
--
-- Browser access is deny-by-default. An authenticated JWT is necessary
-- but not sufficient: the user must have an active recruiter_memberships
-- row. Browser roles receive read-only access to the five dashboard tables.
-- All writes and all storage access remain server-only until SEC-02/03/06,
-- MIG-06, SEC-14, and REC-03/05 add their authorized API paths.
-- =====================================================================

-- Remove historical prototype policies before changing grants.
drop policy if exists "anon read call_sessions"    on screening_v2.call_sessions;
drop policy if exists "anon read transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "anon read assessments"      on screening_v2.assessments;
drop policy if exists "anon read candidates"       on screening_v2.candidates;
drop policy if exists "anon read roles"            on screening_v2.roles;

-- Remove any policies created by an earlier development-only draft.
drop policy if exists "authenticated read roles"            on screening_v2.roles;
drop policy if exists "authenticated insert roles"          on screening_v2.roles;
drop policy if exists "authenticated update roles"          on screening_v2.roles;
drop policy if exists "authenticated delete roles"          on screening_v2.roles;
drop policy if exists "authenticated read resumes"          on screening_v2.resumes;
drop policy if exists "authenticated insert resumes"        on screening_v2.resumes;
drop policy if exists "authenticated update resumes"        on screening_v2.resumes;
drop policy if exists "authenticated delete resumes"        on screening_v2.resumes;
drop policy if exists "authenticated read candidates"       on screening_v2.candidates;
drop policy if exists "authenticated insert candidates"     on screening_v2.candidates;
drop policy if exists "authenticated update candidates"     on screening_v2.candidates;
drop policy if exists "authenticated delete candidates"     on screening_v2.candidates;
drop policy if exists "authenticated read call_sessions"    on screening_v2.call_sessions;
drop policy if exists "authenticated insert call_sessions"  on screening_v2.call_sessions;
drop policy if exists "authenticated update call_sessions"  on screening_v2.call_sessions;
drop policy if exists "authenticated delete call_sessions"  on screening_v2.call_sessions;
drop policy if exists "authenticated read transcript_turns"   on screening_v2.transcript_turns;
drop policy if exists "authenticated insert transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "authenticated update transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "authenticated delete transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "authenticated read assessments"      on screening_v2.assessments;
drop policy if exists "authenticated insert assessments"    on screening_v2.assessments;
drop policy if exists "authenticated update assessments"    on screening_v2.assessments;
drop policy if exists "authenticated delete assessments"    on screening_v2.assessments;
drop policy if exists "authenticated read consent_records"  on screening_v2.consent_records;
drop policy if exists "authenticated insert consent_records" on screening_v2.consent_records;
drop policy if exists "authenticated update consent_records" on screening_v2.consent_records;
drop policy if exists "authenticated delete consent_records" on screening_v2.consent_records;
drop policy if exists "authenticated read call_queue"       on screening_v2.call_queue;
drop policy if exists "authenticated insert call_queue"     on screening_v2.call_queue;
drop policy if exists "authenticated update call_queue"     on screening_v2.call_queue;
drop policy if exists "authenticated delete call_queue"     on screening_v2.call_queue;
drop policy if exists "authenticated read sms_follow_ups"   on screening_v2.sms_follow_ups;
drop policy if exists "authenticated insert sms_follow_ups" on screening_v2.sms_follow_ups;
drop policy if exists "authenticated update sms_follow_ups" on screening_v2.sms_follow_ups;
drop policy if exists "authenticated delete sms_follow_ups" on screening_v2.sms_follow_ups;
drop policy if exists "authenticated read ats_sync_log"     on screening_v2.ats_sync_log;
drop policy if exists "authenticated insert ats_sync_log"   on screening_v2.ats_sync_log;
drop policy if exists "authenticated update ats_sync_log"   on screening_v2.ats_sync_log;
drop policy if exists "authenticated delete ats_sync_log"   on screening_v2.ats_sync_log;

-- Revoke broad historical grants and defaults from browser roles.
revoke all on schema screening_v2 from anon, authenticated;
revoke all privileges on all tables    in schema screening_v2 from anon, authenticated;
revoke all privileges on all sequences in schema screening_v2 from anon, authenticated;
revoke all privileges on all functions in schema screening_v2 from anon, authenticated;
alter default privileges in schema screening_v2 revoke all on tables    from anon, authenticated;
alter default privileges in schema screening_v2 revoke all on sequences from anon, authenticated;
alter default privileges in schema screening_v2 revoke all on functions from anon, authenticated;

-- Active-membership allowlist. There is one launch organization, so no
-- org_id is introduced. Memberships are provisioned by a trusted backend.
create table if not exists screening_v2.recruiter_memberships (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_recruiter_membership_role
    check (role in ('admin', 'interviewer', 'viewer'))
);
alter table screening_v2.recruiter_memberships enable row level security;

grant all privileges on screening_v2.recruiter_memberships to service_role;
grant usage on schema screening_v2 to authenticated;
grant select on screening_v2.recruiter_memberships to authenticated;
grant select on screening_v2.roles,
                screening_v2.candidates,
                screening_v2.call_sessions,
                screening_v2.transcript_turns,
                screening_v2.assessments
  to authenticated;

-- Fixed-search-path SECURITY DEFINER helper prevents RLS recursion while
-- checking the server-provisioned membership table.
create or replace function screening_v2.is_active_recruiter()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
      from screening_v2.recruiter_memberships as membership
     where membership.user_id = (select auth.uid())
       and membership.active
  );
$$;
revoke all on function screening_v2.is_active_recruiter() from public, anon;
grant execute on function screening_v2.is_active_recruiter() to authenticated, service_role;

create policy "recruiter read own membership"
  on screening_v2.recruiter_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) and active);

create policy "active recruiter read roles"
  on screening_v2.roles for select to authenticated
  using ((select screening_v2.is_active_recruiter()));
create policy "active recruiter read candidates"
  on screening_v2.candidates for select to authenticated
  using ((select screening_v2.is_active_recruiter()));
create policy "active recruiter read call_sessions"
  on screening_v2.call_sessions for select to authenticated
  using ((select screening_v2.is_active_recruiter()));
create policy "active recruiter read transcript_turns"
  on screening_v2.transcript_turns for select to authenticated
  using ((select screening_v2.is_active_recruiter()));
create policy "active recruiter read assessments"
  on screening_v2.assessments for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- Enforce documented value domains.
alter table screening_v2.candidates
  add constraint chk_candidates_status check (
    status in ('new', 'queued', 'screening', 'screened', 'advanced', 'rejected')
  ) not valid;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_status check (
    status in ('in_progress', 'completed', 'abandoned', 'failed')
  ) not valid;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_mode check (
    mode in ('browser', 'live', 'simulation')
  ) not valid;
alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_speaker check (
    speaker in ('bot', 'candidate')
  ) not valid;
alter table screening_v2.assessments
  add constraint chk_assessments_recommendation check (
    recommendation in ('advance', 'hold', 'reject')
  ) not valid;
alter table screening_v2.call_queue
  add constraint chk_call_queue_status check (
    status in ('pending', 'dialing', 'completed', 'no_answer', 'failed')
  ) not valid;
alter table screening_v2.sms_follow_ups
  add constraint chk_sms_follow_ups_status check (
    status in ('pending', 'sent', 'failed')
  ) not valid;
alter table screening_v2.ats_sync_log
  add constraint chk_ats_sync_log_status check (
    status in ('pending', 'synced', 'failed')
  ) not valid;

alter table screening_v2.candidates       validate constraint chk_candidates_status;
alter table screening_v2.call_sessions    validate constraint chk_call_sessions_status;
alter table screening_v2.call_sessions    validate constraint chk_call_sessions_mode;
alter table screening_v2.transcript_turns validate constraint chk_transcript_turns_speaker;
alter table screening_v2.assessments      validate constraint chk_assessments_recommendation;
alter table screening_v2.call_queue       validate constraint chk_call_queue_status;
alter table screening_v2.sms_follow_ups   validate constraint chk_sms_follow_ups_status;
alter table screening_v2.ats_sync_log     validate constraint chk_ats_sync_log_status;

alter table screening_v2.transcript_turns
  add constraint uq_transcript_turns_session_turn unique (session_id, turn_index);

-- Add updated_at coverage to mutable records.
alter table screening_v2.call_sessions add column if not exists updated_at timestamptz not null default now();
alter table screening_v2.roles         add column if not exists updated_at timestamptz not null default now();
alter table screening_v2.resumes       add column if not exists updated_at timestamptz not null default now();
alter table screening_v2.assessments   add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_v2_sessions_updated on screening_v2.call_sessions;
create trigger trg_v2_sessions_updated before update on screening_v2.call_sessions
  for each row execute function screening_v2.set_updated_at();
drop trigger if exists trg_v2_roles_updated on screening_v2.roles;
create trigger trg_v2_roles_updated before update on screening_v2.roles
  for each row execute function screening_v2.set_updated_at();
drop trigger if exists trg_v2_resumes_updated on screening_v2.resumes;
create trigger trg_v2_resumes_updated before update on screening_v2.resumes
  for each row execute function screening_v2.set_updated_at();
drop trigger if exists trg_v2_assess_updated on screening_v2.assessments;
create trigger trg_v2_assess_updated before update on screening_v2.assessments
  for each row execute function screening_v2.set_updated_at();
drop trigger if exists trg_v2_memberships_updated on screening_v2.recruiter_memberships;
create trigger trg_v2_memberships_updated before update on screening_v2.recruiter_memberships
  for each row execute function screening_v2.set_updated_at();

-- Storage remains private and server-only. A logged-in account alone must
-- never grant direct resume/recording access; MIG-06/REC-05 add authorized
-- short-TTL API access after SEC-02 exists.
drop policy if exists "authenticated read resumes_v2"    on storage.objects;
drop policy if exists "authenticated write resumes_v2"   on storage.objects;
drop policy if exists "authenticated update resumes_v2"  on storage.objects;
drop policy if exists "authenticated delete resumes_v2"  on storage.objects;
drop policy if exists "authenticated read recordings_v2" on storage.objects;
drop policy if exists "anon deny resumes_v2"             on storage.objects;
drop policy if exists "anon deny recordings_v2"          on storage.objects;
drop policy if exists "anon deny all storage"            on storage.objects;

-- Publication membership remains limited to the three dashboard streams;
-- RLS and membership-gated SELECT policies filter browser subscriptions.
grant select on screening_v2.transcript_turns,
                screening_v2.call_sessions,
                screening_v2.assessments
  to authenticated;

notify pgrst, 'reload schema';
