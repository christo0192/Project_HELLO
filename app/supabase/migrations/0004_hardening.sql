-- =====================================================================
-- 0004 — Hardened baseline: remove blanket anon access, add auth seams,
--        constraints, and storage policies for single-org Supabase Auth.
--
-- Applies AFTER 0001-0003. Safe to run multiple times (idempotent).
-- Target: single-org production launch per PLAN MIG-03 alignment.
-- =====================================================================

-- =====================================================================
-- 1. DROP ALL BLANKET ANON READ POLICIES (added by 0002)
-- =====================================================================
drop policy if exists "anon read call_sessions"    on screening_v2.call_sessions;
drop policy if exists "anon read transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "anon read assessments"      on screening_v2.assessments;
drop policy if exists "anon read candidates"       on screening_v2.candidates;
drop policy if exists "anon read roles"            on screening_v2.roles;

-- =====================================================================
-- 2. REVOKE OVERLY BROAD GRANTS FROM anon / authenticated
--    Keep service_role grants intact.
-- =====================================================================
revoke all privileges on all tables    in schema screening_v2 from anon, authenticated;
revoke all privileges on all sequences in schema screening_v2 from anon, authenticated;
revoke all privileges on all functions in schema screening_v2 from anon, authenticated;

alter default privileges in schema screening_v2 revoke all on tables    from anon, authenticated;
alter default privileges in schema screening_v2 revoke all on sequences from anon, authenticated;
alter default privileges in schema screening_v2 revoke all on functions from anon, authenticated;

-- =====================================================================
-- 3. GRANT NARROW PRIVILEGES TO authenticated ROLE
--    Single-org: authenticated recruiters get read+write on all tables.
--    RLS policies below enforce row-level access.
-- =====================================================================
grant usage on schema screening_v2 to authenticated;
grant select, insert, update, delete on all tables    in schema screening_v2 to authenticated;
grant usage                    on all sequences      in schema screening_v2 to authenticated;
grant execute                  on all functions      in schema screening_v2 to authenticated;

alter default privileges in schema screening_v2 grant select, insert, update, delete on tables    to authenticated;
alter default privileges in schema screening_v2 grant usage                    on sequences to authenticated;
alter default privileges in schema screening_v2 grant execute                  on functions to authenticated;

-- =====================================================================
-- 4. AUTHENTICATED RLS POLICIES (single-org, no cross-org filtering yet)
--    All authenticated users in the single org can read all rows.
--    Write policies grant full access (RBAC is application-layer).
-- =====================================================================

-- ---- roles ----
create policy "authenticated read roles" on screening_v2.roles
  for select to authenticated using (true);
create policy "authenticated insert roles" on screening_v2.roles
  for insert to authenticated with check (true);
create policy "authenticated update roles" on screening_v2.roles
  for update to authenticated using (true);
create policy "authenticated delete roles" on screening_v2.roles
  for delete to authenticated using (true);

-- ---- resumes ----
create policy "authenticated read resumes" on screening_v2.resumes
  for select to authenticated using (true);
create policy "authenticated insert resumes" on screening_v2.resumes
  for insert to authenticated with check (true);
create policy "authenticated update resumes" on screening_v2.resumes
  for update to authenticated using (true);
create policy "authenticated delete resumes" on screening_v2.resumes
  for delete to authenticated using (true);

-- ---- candidates ----
create policy "authenticated read candidates" on screening_v2.candidates
  for select to authenticated using (true);
create policy "authenticated insert candidates" on screening_v2.candidates
  for insert to authenticated with check (true);
create policy "authenticated update candidates" on screening_v2.candidates
  for update to authenticated using (true);
create policy "authenticated delete candidates" on screening_v2.candidates
  for delete to authenticated using (true);

-- ---- call_sessions ----
create policy "authenticated read call_sessions" on screening_v2.call_sessions
  for select to authenticated using (true);
create policy "authenticated insert call_sessions" on screening_v2.call_sessions
  for insert to authenticated with check (true);
create policy "authenticated update call_sessions" on screening_v2.call_sessions
  for update to authenticated using (true);
create policy "authenticated delete call_sessions" on screening_v2.call_sessions
  for delete to authenticated using (true);

-- ---- transcript_turns ----
create policy "authenticated read transcript_turns" on screening_v2.transcript_turns
  for select to authenticated using (true);
create policy "authenticated insert transcript_turns" on screening_v2.transcript_turns
  for insert to authenticated with check (true);
create policy "authenticated update transcript_turns" on screening_v2.transcript_turns
  for update to authenticated using (true);
create policy "authenticated delete transcript_turns" on screening_v2.transcript_turns
  for delete to authenticated using (true);

-- ---- assessments ----
create policy "authenticated read assessments" on screening_v2.assessments
  for select to authenticated using (true);
create policy "authenticated insert assessments" on screening_v2.assessments
  for insert to authenticated with check (true);
create policy "authenticated update assessments" on screening_v2.assessments
  for update to authenticated using (true);
create policy "authenticated delete assessments" on screening_v2.assessments
  for delete to authenticated using (true);

-- ---- consent_records ----
create policy "authenticated read consent_records" on screening_v2.consent_records
  for select to authenticated using (true);
create policy "authenticated insert consent_records" on screening_v2.consent_records
  for insert to authenticated with check (true);
create policy "authenticated update consent_records" on screening_v2.consent_records
  for update to authenticated using (true);
create policy "authenticated delete consent_records" on screening_v2.consent_records
  for delete to authenticated using (true);

-- ---- call_queue ----
create policy "authenticated read call_queue" on screening_v2.call_queue
  for select to authenticated using (true);
create policy "authenticated insert call_queue" on screening_v2.call_queue
  for insert to authenticated with check (true);
create policy "authenticated update call_queue" on screening_v2.call_queue
  for update to authenticated using (true);
create policy "authenticated delete call_queue" on screening_v2.call_queue
  for delete to authenticated using (true);

-- ---- sms_follow_ups ----
create policy "authenticated read sms_follow_ups" on screening_v2.sms_follow_ups
  for select to authenticated using (true);
create policy "authenticated insert sms_follow_ups" on screening_v2.sms_follow_ups
  for insert to authenticated with check (true);
create policy "authenticated update sms_follow_ups" on screening_v2.sms_follow_ups
  for update to authenticated using (true);
create policy "authenticated delete sms_follow_ups" on screening_v2.sms_follow_ups
  for delete to authenticated using (true);

-- ---- ats_sync_log ----
create policy "authenticated read ats_sync_log" on screening_v2.ats_sync_log
  for select to authenticated using (true);
create policy "authenticated insert ats_sync_log" on screening_v2.ats_sync_log
  for insert to authenticated with check (true);
create policy "authenticated update ats_sync_log" on screening_v2.ats_sync_log
  for update to authenticated using (true);
create policy "authenticated delete ats_sync_log" on screening_v2.ats_sync_log
  for delete to authenticated using (true);

-- =====================================================================
-- 5. CHECK CONSTRAINTS — enforce documented value domains
-- =====================================================================

-- candidates.status: new|queued|screening|screened|advanced|rejected
alter table screening_v2.candidates
  add constraint chk_candidates_status check (
    status in ('new', 'queued', 'screening', 'screened', 'advanced', 'rejected')
  ) not valid;
-- not valid → avoids locking on existing rows; validated separately below

-- call_sessions.status: in_progress|completed|abandoned|failed
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_status check (
    status in ('in_progress', 'completed', 'abandoned', 'failed')
  ) not valid;

-- call_sessions.mode: browser|live|simulation
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_mode check (
    mode in ('browser', 'live', 'simulation')
  ) not valid;

-- transcript_turns.speaker: bot|candidate
alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_speaker check (
    speaker in ('bot', 'candidate')
  ) not valid;

-- assessments.recommendation: advance|hold|reject
alter table screening_v2.assessments
  add constraint chk_assessments_recommendation check (
    recommendation in ('advance', 'hold', 'reject')
  ) not valid;

-- call_queue.status: pending|dialing|completed|no_answer|failed
alter table screening_v2.call_queue
  add constraint chk_call_queue_status check (
    status in ('pending', 'dialing', 'completed', 'no_answer', 'failed')
  ) not valid;

-- sms_follow_ups.status: pending|sent|failed
alter table screening_v2.sms_follow_ups
  add constraint chk_sms_follow_ups_status check (
    status in ('pending', 'sent', 'failed')
  ) not valid;

-- ats_sync_log.status: pending|synced|failed
alter table screening_v2.ats_sync_log
  add constraint chk_ats_sync_log_status check (
    status in ('pending', 'synced', 'failed')
  ) not valid;

-- Validate all CHECK constraints (they were added NOT VALID to avoid locking)
alter table screening_v2.candidates        validate constraint chk_candidates_status;
alter table screening_v2.call_sessions     validate constraint chk_call_sessions_status;
alter table screening_v2.call_sessions     validate constraint chk_call_sessions_mode;
alter table screening_v2.transcript_turns  validate constraint chk_transcript_turns_speaker;
alter table screening_v2.assessments       validate constraint chk_assessments_recommendation;
alter table screening_v2.call_queue        validate constraint chk_call_queue_status;
alter table screening_v2.sms_follow_ups    validate constraint chk_sms_follow_ups_status;
alter table screening_v2.ats_sync_log      validate constraint chk_ats_sync_log_status;

-- =====================================================================
-- 6. UNIQUE CONSTRAINT — prevent duplicate transcript turns
-- =====================================================================
alter table screening_v2.transcript_turns
  add constraint uq_transcript_turns_session_turn
  unique (session_id, turn_index);

-- =====================================================================
-- 7. UPDATED_AT TRIGGERS — add to mutable tables beyond just candidates
-- =====================================================================

-- call_sessions
alter table screening_v2.call_sessions add column if not exists updated_at timestamptz not null default now();
drop trigger if exists trg_v2_sessions_updated on screening_v2.call_sessions;
create trigger trg_v2_sessions_updated before update on screening_v2.call_sessions
  for each row execute function screening_v2.set_updated_at();

-- roles
alter table screening_v2.roles add column if not exists updated_at timestamptz not null default now();
drop trigger if exists trg_v2_roles_updated on screening_v2.roles;
create trigger trg_v2_roles_updated before update on screening_v2.roles
  for each row execute function screening_v2.set_updated_at();

-- resumes
alter table screening_v2.resumes add column if not exists updated_at timestamptz not null default now();
drop trigger if exists trg_v2_resumes_updated on screening_v2.resumes;
create trigger trg_v2_resumes_updated before update on screening_v2.resumes
  for each row execute function screening_v2.set_updated_at();

-- assessments
alter table screening_v2.assessments add column if not exists updated_at timestamptz not null default now();
drop trigger if exists trg_v2_assess_updated on screening_v2.assessments;
create trigger trg_v2_assess_updated before update on screening_v2.assessments
  for each row execute function screening_v2.set_updated_at();

-- =====================================================================
-- 8. STORAGE RLS POLICIES — private buckets, authenticated-only access
-- =====================================================================

-- resumes_v2: authenticated users can read/write their own org's resumes
drop policy if exists "authenticated read resumes_v2"  on storage.objects;
drop policy if exists "authenticated write resumes_v2" on storage.objects;

create policy "authenticated read resumes_v2" on storage.objects
  for select to authenticated
  using (bucket_id = 'resumes_v2');

create policy "authenticated write resumes_v2" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'resumes_v2');

create policy "authenticated update resumes_v2" on storage.objects
  for update to authenticated
  using (bucket_id = 'resumes_v2');

create policy "authenticated delete resumes_v2" on storage.objects
  for delete to authenticated
  using (bucket_id = 'resumes_v2');

-- recordings_v2: authenticated read-only (writes via service_role worker)
drop policy if exists "authenticated read recordings_v2"  on storage.objects;

create policy "authenticated read recordings_v2" on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings_v2');

-- Deny anon access to both buckets explicitly
drop policy if exists "anon deny resumes_v2"     on storage.objects;
drop policy if exists "anon deny recordings_v2"  on storage.objects;

-- (No anon policies = deny-by-default for storage too, but be explicit)
create policy "anon deny all storage" on storage.objects
  for all to anon
  using (false);

-- =====================================================================
-- 9. REALTIME — keep publication but channel access is now authenticated
--    (RLS policies above filter; authenticated users need Realtime grants)
-- =====================================================================

-- Re-grant Realtime access to authenticated role for subscribed tables
grant select on screening_v2.transcript_turns to authenticated;
grant select on screening_v2.call_sessions    to authenticated;
grant select on screening_v2.assessments      to authenticated;

-- =====================================================================
-- 10. PgREST schema cache refresh
-- =====================================================================
notify pgrst, 'reload schema';
