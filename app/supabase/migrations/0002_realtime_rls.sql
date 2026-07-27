-- =====================================================================
-- Live dashboard: enable Supabase Realtime on the screening_v2 tables and
-- grant the dashboard (anon key) READ access so it can subscribe.
--
-- Security note: single-tenant INTERNAL tool. anon gets READ-ONLY on
-- screening_v2; all writes happen via the voice service's direct Postgres
-- connection (table owner, bypasses RLS). Add real auth before any external
-- exposure. Apply only through the reviewed migration workflow.
-- =====================================================================

-- 1. Realtime change feeds (idempotent-ish: ignore "already member" errors)
do $$
begin
  begin alter publication supabase_realtime add table screening_v2.transcript_turns; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table screening_v2.call_sessions;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table screening_v2.assessments;     exception when duplicate_object then null; end;
end $$;

-- Realtime needs full row data on UPDATE/DELETE for filters to work.
alter table screening_v2.transcript_turns replica identity full;
alter table screening_v2.call_sessions    replica identity full;
alter table screening_v2.assessments      replica identity full;

-- 2. Read-only RLS policies for the dashboard (anon). Writes are unaffected
--    (backend connects as table owner and bypasses RLS).
drop policy if exists "anon read call_sessions"    on screening_v2.call_sessions;
drop policy if exists "anon read transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "anon read assessments"      on screening_v2.assessments;
drop policy if exists "anon read candidates"       on screening_v2.candidates;
drop policy if exists "anon read roles"            on screening_v2.roles;

create policy "anon read call_sessions"    on screening_v2.call_sessions    for select to anon using (true);
create policy "anon read transcript_turns" on screening_v2.transcript_turns for select to anon using (true);
create policy "anon read assessments"      on screening_v2.assessments      for select to anon using (true);
create policy "anon read candidates"       on screening_v2.candidates       for select to anon using (true);
create policy "anon read roles"            on screening_v2.roles            for select to anon using (true);

-- 3. Refresh PostgREST's schema cache so REST writes see screening_v2 columns
--    (kills the recurring "Could not find the 'provider' column ... in schema cache").
notify pgrst, 'reload schema';
