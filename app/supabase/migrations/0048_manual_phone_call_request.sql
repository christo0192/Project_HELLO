-- 0048 — recruiter-confirmed manual phone request.
-- The route can request an application-scoped engagement, never a provider call.
-- `admit_phone_attempt` remains the sole dial authority.

create or replace function screening_v2.request_candidate_phone_call(
  p_candidate_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link_id uuid;
  v_result jsonb;
  v_status text;
  v_state text;
begin
  perform pg_advisory_xact_lock(
    hashtext('manual_phone_request'),
    hashtext(coalesce(p_candidate_id::text, ''))
  );

  select l.id into v_link_id
    from screening_v2.ashby_application_links l
   where l.provider = 'ashby'
     and l.candidate_id = p_candidate_id
   order by l.updated_at desc, l.id desc
   limit 1;

  if not found then
    return jsonb_build_object('status', 'application_not_found');
  end if;

  v_result := screening_v2.ensure_ashby_phone_engagement(v_link_id, p_now);
  v_status := coalesce(v_result->>'status', 'unknown');

  if v_status in ('eligible', 'scheduled_next_window') then
    return v_result || jsonb_build_object('status', v_status, 'request_source', 'manual');
  end if;

  if v_status = 'engagement_active' then
    v_state := v_result->>'state';
    if v_state in ('eligible', 'scheduled', 'dialing', 'in_call', 'reconnecting', 'awaiting_retry') then
      return jsonb_build_object(
        'status', 'already_requested',
        'state', v_state,
        'engagement_id', v_result->>'engagement_id'
      );
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function screening_v2.request_candidate_phone_call(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.request_candidate_phone_call(uuid, timestamptz)
  to service_role;

comment on function screening_v2.request_candidate_phone_call is
  'Recruiter-confirmed, idempotent manual request. It creates/adopts only the application-scoped engagement and never originates a provider call; admission remains the sole dial authority.';
