-- =====================================================================
-- 0072 partial-finalize assertions — run AFTER phone_partial_finalize_setup.sql.
--
-- Runs `finalize_phone_partial_sessions` once at the fixture's frozen
-- instant and proves the DURABLE consequences a partial disconnect owes:
--
--   * the STRANDED session is SELECTED and driven terminal
--     (status='completed', terminal_reason='conversation_complete') — the
--     transition that fires the 0038 recording-finalize trigger;
--   * the CONTROL session (attempt inside the grace) is NOT selected and
--     stays in_progress;
--   * the returned coverage is covered=2 / total=3 and the
--     disconnect_reason is 'candidate_hangup' (attempt outcome
--     'disconnected');
--   * the top-level status is 'ok'.
--
-- Raises (and therefore fails the suite) on any violation.
--
-- Run (standalone; not yet wired into scripts/supabase-test.sh):
--   psql -v ON_ERROR_STOP=1 -f phone_partial_finalize_assert.sql
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_now   constant timestamptz := '2026-08-24T06:00:00Z'::timestamptz;
  v_res   jsonb;
  v_stranded uuid;
  v_control  uuid;
  v_sess_status text;
  v_sess_reason text;
  v_ctrl_status text;
  v_finalized integer;
  v_picked   jsonb;
  v_covered  integer;
  v_total    integer;
  v_reason   text;
begin
  select id into v_stranded from screening_v2.call_sessions
   where external_call_id = 'phone-pf72-stranded';
  select id into v_control  from screening_v2.call_sessions
   where external_call_id = 'phone-pf72-control';
  if v_stranded is null or v_control is null then
    raise exception 'pf72: fixture sessions missing — run the setup first';
  end if;

  -- Run the selector at the frozen instant. grace=180s; the stranded attempt
  -- ended 600s ago (selected), the control attempt 10s ago (not selected).
  v_res := screening_v2.finalize_phone_partial_sessions(25, 180, v_now);

  if v_res->>'status' <> 'ok' then
    raise exception 'pf72: expected status ok, got %', v_res->>'status';
  end if;

  -- Exactly one session was driven terminal.
  v_finalized := (v_res->>'finalized')::integer;
  if v_finalized <> 1 then
    raise exception 'pf72: expected finalized=1, got %', v_finalized;
  end if;

  -- The STRANDED session is now completed / conversation_complete: the exact
  -- transition the 0038 finalize trigger fires on.
  select status, terminal_reason into v_sess_status, v_sess_reason
    from screening_v2.call_sessions where id = v_stranded;
  if v_sess_status <> 'completed' then
    raise exception 'pf72: stranded session status = %, expected completed', v_sess_status;
  end if;
  if v_sess_reason <> 'conversation_complete' then
    raise exception 'pf72: stranded terminal_reason = %, expected conversation_complete', v_sess_reason;
  end if;

  -- The CONTROL session was untouched: still in_progress.
  select status into v_ctrl_status
    from screening_v2.call_sessions where id = v_control;
  if v_ctrl_status <> 'in_progress' then
    raise exception 'pf72: control session status = %, expected in_progress (still within grace)', v_ctrl_status;
  end if;

  -- The returned sessions array names exactly the stranded session, with the
  -- correct coverage and disconnect reason.
  if jsonb_array_length(v_res->'sessions') <> 1 then
    raise exception 'pf72: expected 1 returned session, got %', jsonb_array_length(v_res->'sessions');
  end if;
  v_picked := v_res->'sessions'->0;
  if (v_picked->>'session_id')::uuid <> v_stranded then
    raise exception 'pf72: returned session_id % <> stranded %', v_picked->>'session_id', v_stranded;
  end if;
  v_covered := (v_picked->>'covered')::integer;
  v_total   := (v_picked->>'total')::integer;
  v_reason  := v_picked->>'disconnect_reason';
  if v_covered <> 2 then
    raise exception 'pf72: covered = %, expected 2 (cursor)', v_covered;
  end if;
  -- total is the plan's question_count, derived rather than hardcoded so the
  -- assert follows the default plan if its length ever changes.
  declare
    v_expected_total integer;
  begin
    select question_count into v_expected_total
      from screening_v2.phone_session_plans where session_id = v_stranded;
    if v_total is distinct from v_expected_total then
      raise exception 'pf72: total = %, expected % (plan question_count)', v_total, v_expected_total;
    end if;
  end;
  if v_reason <> 'candidate_hangup' then
    raise exception 'pf72: disconnect_reason = %, expected candidate_hangup', v_reason;
  end if;
  if (v_picked->>'transitioned')::boolean is not true then
    raise exception 'pf72: expected transitioned=true for the stranded session';
  end if;

  -- Idempotent re-run: the stranded session is now terminal, so a second pass
  -- selects nothing and drives nothing (the status='in_progress' guard).
  v_res := screening_v2.finalize_phone_partial_sessions(25, 180, v_now);
  if (v_res->>'finalized')::integer <> 0 then
    raise exception 'pf72: re-run finalized % — a terminal session must not be re-driven', v_res->>'finalized';
  end if;

  raise notice 'pf72: PASS — stranded finalized to completed, control untouched, coverage %/%', v_covered, v_total;
end;
$$;
