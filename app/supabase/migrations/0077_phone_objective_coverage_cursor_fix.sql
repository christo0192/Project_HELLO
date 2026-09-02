-- 0077 — fix coverage cursor persistence.
--
-- 0075 correctly returned the cursor after the current objective plus its
-- volunteered contiguous objectives, but persisted a cursor that omitted the
-- current objective. That left the session one objective behind the worker and
-- caused the next boundary to fail closed with stale_cursor.

create or replace function screening_v2.commit_phone_question_boundary_with_coverage(
  p_session_id             uuid,
  p_question_key           text,
  p_expected_index         integer,
  p_source_event_id        text,
  p_turns                  jsonb,
  p_covered_question_keys  text[] default '{}'::text[],
  p_now                    timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess screening_v2.call_sessions%rowtype;
  v_plan screening_v2.phone_session_plans%rowtype;
  v_key text;
  v_idx integer;
  v_cursor integer;
  v_first integer;
  v_last integer;
  v_count integer;
  v_result jsonb;
  v_source text;
begin
  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'unknown_session'); end if;
  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then return jsonb_build_object('status', 'plan_missing'); end if;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  if p_expected_index is null or p_expected_index <> v_cursor then
    return jsonb_build_object('status', 'stale_cursor', 'cursor', v_cursor,
      'question_count', v_plan.question_count);
  end if;
  if p_covered_question_keys is null or cardinality(p_covered_question_keys) > 3 then
    return jsonb_build_object('status', 'invalid_coverage');
  end if;

  -- Validate that every volunteered key is the next contiguous plan key. This
  -- happens before the base commit so the operation cannot partially apply.
  if cardinality(p_covered_question_keys) > 0 then
    for v_idx in 1..cardinality(p_covered_question_keys) loop
      v_key := p_covered_question_keys[v_idx];
      if v_key is null or v_key !~ '^[A-Za-z0-9_.:-]{1,100}$' then
        return jsonb_build_object('status', 'invalid_coverage');
      end if;
      if v_key <> ((v_plan.questions -> (v_cursor + v_idx)) ->> 'key') then
        return jsonb_build_object('status', 'invalid_coverage', 'cursor', v_cursor);
      end if;
    end loop;
  end if;

  v_result := screening_v2.commit_phone_question_boundary(
    p_session_id, p_question_key, p_expected_index, p_source_event_id,
    p_turns, p_now
  );
  if coalesce(v_result ->> 'status', 'unknown_session') <> 'applied'
     or coalesce((v_result ->> 'duplicate')::boolean, false) then
    return v_result;
  end if;

  v_first := coalesce((v_result ->> 'first_turn_index')::integer, 0);
  v_last := coalesce((v_result ->> 'last_turn_index')::integer, v_first);
  v_count := v_last - v_first + 1;
  for v_idx in 1..coalesce(cardinality(p_covered_question_keys), 0) loop
    v_key := p_covered_question_keys[v_idx];
    v_source := left(p_source_event_id || ':coverage:' || md5(v_key), 200);
    insert into screening_v2.phone_session_progress
      (session_id, question_key, question_index, source_event_id,
       first_turn_index, last_turn_index, turn_count, committed_at)
    values
      (p_session_id, v_key, v_cursor + v_idx, v_source,
       v_first, v_last, v_count, p_now);
  end loop;

  -- The base RPC already advanced to v_cursor + 1. Persist the same cursor
  -- returned to the worker, including the current objective and all coverage.
  if cardinality(p_covered_question_keys) > 0 then
    update screening_v2.call_sessions
       set current_question_index = v_cursor + 1 + cardinality(p_covered_question_keys)
     where id = p_session_id;
  end if;
  return jsonb_set(
    jsonb_set(v_result, '{cursor}', to_jsonb(v_cursor + 1 + coalesce(cardinality(p_covered_question_keys), 0))),
    '{plan_complete}', to_jsonb(v_cursor + 1 + coalesce(cardinality(p_covered_question_keys), 0) >= v_plan.question_count)
  );
exception when unique_violation then
  return jsonb_build_object('status', 'duplicate', 'duplicate', true,
    'applied', true, 'cursor', greatest(coalesce(v_sess.current_question_index, 0), 0));
end;
$$;

revoke all on function screening_v2.commit_phone_question_boundary_with_coverage(uuid, text, integer, text, jsonb, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_question_boundary_with_coverage(uuid, text, integer, text, jsonb, text[], timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_question_boundary_with_coverage is
  'Commits one real exchange and atomically advances the durable cursor through the current objective and contiguous future objectives already answered by that exchange.';
