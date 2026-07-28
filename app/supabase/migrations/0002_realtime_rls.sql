-- =====================================================================
-- Realtime publication baseline for the screening dashboard.
--
-- SECURITY: this migration intentionally creates NO anon/authenticated
-- policies or grants. Migration 0004 adds membership-gated authenticated
-- SELECT policies. Backend writes remain server-only through service_role.
-- =====================================================================

-- Realtime change feeds (ignore an existing publication membership).
do $$
begin
  begin alter publication supabase_realtime add table screening_v2.transcript_turns; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table screening_v2.call_sessions;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table screening_v2.assessments;     exception when duplicate_object then null; end;
end $$;

-- Realtime needs full row data on UPDATE/DELETE for filtered consumers.
alter table screening_v2.transcript_turns replica identity full;
alter table screening_v2.call_sessions    replica identity full;
alter table screening_v2.assessments      replica identity full;

-- Remove policies from the historical prototype if this migration is used
-- against a development project that previously applied the unsafe version.
drop policy if exists "anon read call_sessions"    on screening_v2.call_sessions;
drop policy if exists "anon read transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "anon read assessments"      on screening_v2.assessments;
drop policy if exists "anon read candidates"       on screening_v2.candidates;
drop policy if exists "anon read roles"            on screening_v2.roles;

notify pgrst, 'reload schema';
