-- 0061 — atomic consent authorization and assessment start.
-- The worker's deterministic classifier is the caller; this function owns the
-- durable order and rolls back all writes if any boundary cannot be completed.

create or replace function screening_v2.consent_and_start_phone_assessment(
  p_attempt_id uuid,
  p_session_id uuid,
  p_epoch integer,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_human jsonb;
  v_disclosure jsonb;
  v_state jsonb;
begin
  if p_attempt_id is null or p_session_id is null or p_epoch is null or p_epoch < 0 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- These are function calls inside one transaction. No result is accepted
  -- unless the transition explicitly applied; an ignored/stale result aborts
  -- the combined boundary and cannot authorize speech.
  v_human := screening_v2.apply_phone_event(
    'internal', 'classify.human', p_attempt_id, null, null, p_epoch, null, p_now);
  if v_human ->> 'status' <> 'applied' then
    return jsonb_build_object('status', 'consent_start_failed');
  end if;

  v_disclosure := screening_v2.apply_phone_event(
    'internal', 'disclosure.delivered', p_attempt_id, null, null, p_epoch, null, p_now);
  if v_disclosure ->> 'status' <> 'applied' then
    return jsonb_build_object('status', 'consent_start_failed');
  end if;

  v_state := screening_v2.start_phone_assessment(p_attempt_id, p_session_id, p_now);
  if v_state ->> 'status' <> 'ok' then
    -- The function must not return a refusal after committing consent. Raising
    -- rolls back both event writes and leaves the attempt retryable.
    raise exception 'phone_consent_start_failed' using errcode = 'P0001';
  end if;
  return v_state || jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.consent_and_start_phone_assessment(uuid,uuid,integer,timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.consent_and_start_phone_assessment(uuid,uuid,integer,timestamptz)
  to service_role;
