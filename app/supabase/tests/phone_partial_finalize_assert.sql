-- =====================================================================
-- 0072 partial-finalize assertions — run AFTER phone_partial_finalize_setup.sql.
--
-- Runs `finalize_phone_partial_sessions` once at the fixture's frozen
-- instant and proves the DURABLE consequences a partial disconnect owes:
--
--   * the STRANDED session is SELECTED and driven terminal
--     (status='completed', terminal_reason='conversation_complete') — the
--     transition that fires the 0038 recording-finalize trigger — and is
--     returned with transitioned=true / disconnect_reason='candidate_hangup'
--     / covered=2 / total=3;
--   * the CRASH residue (attempt `abandoned`, session already
--     `expired`/`grace_timeout`) is ALSO selected but NOT re-transitioned
--     (it stays expired/grace_timeout — the illegal `expired -> completed`
--     edge is never attempted), and is returned with transitioned=false and
--     disconnect_reason='worker_crash';
--   * the CONTROL session (attempt inside the grace) is NOT selected and
--     stays in_progress;
--   * the top-level status is 'ok', finalized=1 (only the stranded session
--     transitioned this pass), and the sweep does NOT error on the crash
--     residue's illegal re-transition;
--   * idempotency / no-re-score: once an assessment row exists for the crash
--     session, a re-run no longer selects it.
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
  v_crash    uuid;
  v_sess_status text;
  v_sess_reason text;
  v_ctrl_status text;
  v_crash_status text;
  v_crash_reason text;
  v_finalized integer;
  v_picked   jsonb;
  v_covered  integer;
  v_total    integer;
  v_reason   text;
  v_str_entry   jsonb;
  v_crash_entry jsonb;
  v_cand     uuid;
begin
  select id into v_stranded from screening_v2.call_sessions
   where external_call_id = 'phone-pf72-stranded';
  select id into v_control  from screening_v2.call_sessions
   where external_call_id = 'phone-pf72-control';
  select id into v_crash    from screening_v2.call_sessions
   where external_call_id = 'phone-pf72-crash';
  if v_stranded is null or v_control is null or v_crash is null then
    raise exception 'pf72: fixture sessions missing — run the setup first';
  end if;

  -- Run the selector at the frozen instant. grace=180s; the stranded + crash
  -- attempts ended 600s ago (both selected), the control attempt 10s ago (not
  -- selected). The crash residue is ALREADY expired/grace_timeout, so the sweep
  -- must select it WITHOUT erroring on the illegal expired->completed edge.
  v_res := screening_v2.finalize_phone_partial_sessions(25, 180, v_now);

  if v_res->>'status' <> 'ok' then
    raise exception 'pf72: expected status ok, got %', v_res->>'status';
  end if;

  -- Exactly one session was driven terminal (the stranded in_progress one);
  -- the crash residue was selected but NOT transitioned.
  v_finalized := (v_res->>'finalized')::integer;
  if v_finalized <> 1 then
    raise exception 'pf72: expected finalized=1 (only stranded transitions), got %', v_finalized;
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

  -- The CRASH residue was NOT re-transitioned: still expired/grace_timeout
  -- (the illegal expired->completed edge is never attempted).
  select status, terminal_reason into v_crash_status, v_crash_reason
    from screening_v2.call_sessions where id = v_crash;
  if v_crash_status <> 'expired' then
    raise exception 'pf72: crash session status = %, expected expired (never re-transitioned)', v_crash_status;
  end if;
  if v_crash_reason <> 'grace_timeout' then
    raise exception 'pf72: crash terminal_reason = %, expected grace_timeout', v_crash_reason;
  end if;

  -- The CONTROL session was untouched: still in_progress.
  select status into v_ctrl_status
    from screening_v2.call_sessions where id = v_control;
  if v_ctrl_status <> 'in_progress' then
    raise exception 'pf72: control session status = %, expected in_progress (still within grace)', v_ctrl_status;
  end if;

  -- The returned sessions array names BOTH the stranded and the crash session
  -- (the control is inside the grace and absent).
  if jsonb_array_length(v_res->'sessions') <> 2 then
    raise exception 'pf72: expected 2 returned sessions (stranded + crash), got %',
      jsonb_array_length(v_res->'sessions');
  end if;

  -- Pull each entry out by session id (order is by started_at asc, so do not
  -- rely on position).
  select e into v_str_entry
    from jsonb_array_elements(v_res->'sessions') e
   where (e->>'session_id')::uuid = v_stranded;
  select e into v_crash_entry
    from jsonb_array_elements(v_res->'sessions') e
   where (e->>'session_id')::uuid = v_crash;
  if v_str_entry is null or v_crash_entry is null then
    raise exception 'pf72: returned array missing stranded or crash entry';
  end if;

  -- ── STRANDED entry: transitioned=true, candidate_hangup, covered 2/plan. ──
  v_covered := (v_str_entry->>'covered')::integer;
  v_total   := (v_str_entry->>'total')::integer;
  v_reason  := v_str_entry->>'disconnect_reason';
  if v_covered <> 2 then
    raise exception 'pf72: stranded covered = %, expected 2 (cursor)', v_covered;
  end if;
  declare
    v_expected_total integer;
  begin
    select question_count into v_expected_total
      from screening_v2.phone_session_plans where session_id = v_stranded;
    if v_total is distinct from v_expected_total then
      raise exception 'pf72: stranded total = %, expected % (plan question_count)', v_total, v_expected_total;
    end if;
  end;
  if v_reason <> 'candidate_hangup' then
    raise exception 'pf72: stranded disconnect_reason = %, expected candidate_hangup', v_reason;
  end if;
  if (v_str_entry->>'transitioned')::boolean is not true then
    raise exception 'pf72: expected transitioned=true for the stranded session';
  end if;

  -- ── CRASH entry: transitioned=false, worker_crash. ──
  if (v_crash_entry->>'transitioned')::boolean is not false then
    raise exception 'pf72: expected transitioned=false for the crash residue (already terminal)';
  end if;
  if v_crash_entry->>'disconnect_reason' <> 'worker_crash' then
    raise exception 'pf72: crash disconnect_reason = %, expected worker_crash',
      v_crash_entry->>'disconnect_reason';
  end if;

  -- ── Idempotency / no-re-score for the CRASH residue ──────────────────────
  -- Insert a phone assessment row for the crash session, then re-run: the
  -- `not exists (phone assessment)` guard must exclude it. (The stranded
  -- session is now `completed` so a second pass would try to score IT; give it
  -- an assessment too so the whole sweep is a clean no-op and we isolate the
  -- crash idempotency.)
  -- The legacy provenance sentinel satisfies the assessments provenance CHECK
  -- (valid_model_provenance) without pinning a live model id; recommendation
  -- must be one of advance|hold|reject (0004 CHECK).
  select candidate_id into v_cand from screening_v2.call_sessions where id = v_crash;
  insert into screening_v2.assessments
    (session_id, candidate_id, english, tone, communication, motivation,
     role_fit, overall_score, recommendation, summary, source, partial, provenance)
  values (v_crash, v_cand, '3'::jsonb, '3'::jsonb, '3'::jsonb, '3'::jsonb, '3'::jsonb,
          60, 'advance', 'pf72 crash partial', 'phone', true,
          '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb);
  select candidate_id into v_cand from screening_v2.call_sessions where id = v_stranded;
  insert into screening_v2.assessments
    (session_id, candidate_id, english, tone, communication, motivation,
     role_fit, overall_score, recommendation, summary, source, partial, provenance)
  values (v_stranded, v_cand, '3'::jsonb, '3'::jsonb, '3'::jsonb, '3'::jsonb, '3'::jsonb,
          60, 'advance', 'pf72 stranded partial', 'phone', true,
          '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb);

  v_res := screening_v2.finalize_phone_partial_sessions(25, 180, v_now);
  if (v_res->>'finalized')::integer <> 0 then
    raise exception 'pf72: re-run finalized % — an assessed session must not be re-driven', v_res->>'finalized';
  end if;
  if jsonb_array_length(v_res->'sessions') <> 0 then
    raise exception 'pf72: re-run returned % sessions — an assessed session must not be re-selected',
      jsonb_array_length(v_res->'sessions');
  end if;

  raise notice 'pf72: PASS — stranded->completed, crash residue selected (transitioned=false, worker_crash) not re-transitioned, control untouched, idempotent after assessment';
end;
$$;
