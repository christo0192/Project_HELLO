-- 0058 — candidate-scoped booking through the existing appointment authority.
--
-- The recruiter profile needs to book a candidate without knowing an internal
-- engagement id. This wrapper resolves the current application/cycle and then
-- delegates slot legality, versioning, audit, and state promotion to the
-- existing schedule_phone_appointment RPC. It never writes a table directly,
-- creates a call attempt, or contacts a provider.

create or replace function screening_v2.schedule_candidate_phone_appointment(
  p_candidate_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link_id uuid;
  v_eng_id uuid;
  v_result jsonb;
  v_status text;
  v_schedule jsonb;
begin
  if p_candidate_id is null or p_actor_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phone_candidate_schedule'),
    hashtext(p_candidate_id::text)
  );

  select id into v_link_id
    from screening_v2.ashby_application_links
   where provider = 'ashby'
     and candidate_id = p_candidate_id
     and terminal_state is null
     and lifecycle not in ('completed', 'cancelled')
   order by updated_at desc, id desc
   limit 1;
  if not found then
    -- The candidate is known to the caller, but no live Ashby application can
    -- author a phone screen. Keep the answer stable and non-sensitive.
    if exists (select 1 from screening_v2.candidates where id = p_candidate_id) then
      return jsonb_build_object('status', 'application_not_found');
    end if;
    return jsonb_build_object('status', 'candidate_not_found');
  end if;

  v_result := screening_v2.ensure_ashby_phone_engagement(v_link_id, p_now);
  v_status := coalesce(v_result->>'status', 'unknown_status');
  v_eng_id := nullif(v_result->>'engagement_id', '')::uuid;

  if v_status = 'engagement_terminal' or v_status = 'application_terminal' then
    return jsonb_build_object('status', 'rescreen_required');
  end if;
  if v_status = 'application_not_live' then
    return jsonb_build_object('status', 'application_not_live');
  end if;
  if v_eng_id is null then
    return jsonb_build_object('status', 'prerequisites_unavailable');
  end if;

  -- A pending prerequisite is still a valid calendar intention. The existing
  -- RPC returns ok_prereqs_pending, which tells HR that the slot exists but no
  -- dial is promised until admission re-checks every prerequisite.
  v_schedule := screening_v2.schedule_phone_appointment(
    v_eng_id, p_starts_at, p_ends_at, 'hr_manual', p_actor_id, null, p_now
  );
  return v_schedule || jsonb_build_object('engagement_id', v_eng_id);
end;
$$;

revoke all on function screening_v2.schedule_candidate_phone_appointment(uuid, timestamptz, timestamptz, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.schedule_candidate_phone_appointment(uuid, timestamptz, timestamptz, uuid, timestamptz)
  to service_role;

comment on function screening_v2.schedule_candidate_phone_appointment is
  'Candidate-scoped atomic booking wrapper. Resolves a live application and '
  'active phone cycle, then delegates to schedule_phone_appointment. It never '
  'reopens a terminal cycle, creates a dial attempt, or contacts a provider. '
  'Service-role-only.';
