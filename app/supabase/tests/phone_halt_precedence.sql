\set ON_ERROR_STOP on
-- 0110: the phone kill switch records the MOST RESTRICTIVE reason in force.
--
-- Every API test mocks set_phone_halt, so this file is where the precedence
-- rule first EXECUTES. Runs in ONE rollback transaction against the fully
-- migrated local database: the control singleton is global state, and nothing
-- this file does to it (or to audit_events, which is append-only) survives.
--
-- The defect it pins: 0042 kept the FIRST reason while halted, so a legal
-- hold raised during an operator pause left `operator_pause` on the row, and
-- every reader that trusts that column (Mission Control's Resume, the
-- /halt/clear interlock, the owner-test gate) acted on the weaker reason.
begin;

do $$
declare
  -- Ascending restrictiveness, restated here ON PURPOSE rather than read from
  -- the function: a test that derived the order from the code under test
  -- would agree with any order the code chose.
  v_order constant text[] := array[
    'operator_pause','cost_control','provider_incident','legal_hold','emergency_stop'];
  v_sys  constant uuid := '00000000-0000-4000-8000-000000000001';
  v_a1   constant uuid := '00000000-0000-4000-8000-0000000110a1';
  v_a2   constant uuid := '00000000-0000-4000-8000-0000000110a2';
  v_a3   constant uuid := '00000000-0000-4000-8000-0000000110a3';
  v_a4   constant uuid := '00000000-0000-4000-8000-0000000110a4';
  v_a5   constant uuid := '00000000-0000-4000-8000-0000000110a5';
  v_ga   constant uuid := '00000000-0000-4000-8000-0000000110b1';
  v_gb   constant uuid := '00000000-0000-4000-8000-0000000110b2';
  -- Random ids for the gate probe: no engagement exists, so a gate that got
  -- PAST the halt check would answer engagement_not_found.
  v_cand constant uuid := '00000000-0000-4000-8000-0000000110c1';
  v_eng  constant uuid := '00000000-0000-4000-8000-0000000110c2';
  t0     constant timestamptz := '2026-10-01T04:00:00Z';
  v_res   jsonb;
  v_audit jsonb;
  v_row   record;
  v_n     integer;
  v_i     integer;
  v_j     integer;
  v_want  text;
begin
  -- ── Start from a clear switch, whatever earlier suites left ───────────
  insert into screening_v2.phone_control (control_key) values ('default')
  on conflict (control_key) do nothing;
  update screening_v2.phone_control
     set halted_at = null, halt_reason = null, halt_actor_id = null
   where control_key = 'default';

  -- ── 1. Not halted: exactly 0042 ───────────────────────────────────────
  v_res := screening_v2.set_phone_halt('operator_pause', v_a1, t0);
  if v_res->>'status' <> 'ok'
     or (v_res->>'already_halted')::boolean is not false
     or v_res->>'halt_reason' is distinct from 'operator_pause'
     or (v_res->>'reason_escalated')::boolean is not false then
    raise exception '0110 first halt answered wrongly: %', v_res;
  end if;
  select halted_at, halt_reason, halt_actor_id, updated_at into v_row
    from screening_v2.phone_control where control_key = 'default';
  if v_row.halted_at <> t0 or v_row.halt_reason <> 'operator_pause'
     or v_row.halt_actor_id <> v_a1 or v_row.updated_at <> t0 then
    raise exception '0110 first halt wrote the wrong row: %', row_to_json(v_row);
  end if;
  -- Counted separately: SELECT INTO without STRICT stops at the first row,
  -- so its row_count could never reveal a duplicate.
  select count(*) into v_n from screening_v2.audit_events
   where actor_id = v_a1 and metadata->>'override' = 'phone_admission_halt_set';
  select metadata into v_audit from screening_v2.audit_events
   where actor_id = v_a1 and action = 'admin_session_override'
     and target_type = 'phone_control' and target_id = 'default'
     and metadata->>'override' = 'phone_admission_halt_set';
  if v_n <> 1 or v_audit->>'reason' <> 'operator_pause'
     or (v_audit->>'already_halted')::boolean is not false
     or v_audit->>'previous_reason' <> 'none'
     or v_audit->>'reason_in_force' <> 'operator_pause'
     or (v_audit->>'reason_escalated')::boolean is not false then
    raise exception '0110 first halt audit is wrong (% rows): %', v_n, v_audit;
  end if;

  -- CONTROL for the gate probe below: under an operator pause the gate gets
  -- PAST the halt check (and fails later, on the made-up engagement). Without
  -- this, "refused after escalation" could be a refusal for any reason.
  v_res := screening_v2.arm_phone_test_gate(v_cand, v_eng, v_a1, 'sql0110-gate',
                                            t0 + interval '5 minutes', t0);
  if v_res->>'status' is distinct from 'engagement_not_found' then
    raise exception '0110 gate control did not pass the operator_pause check: %', v_res;
  end if;

  -- ── 2. operator_pause -> legal_hold ESCALATES ─────────────────────────
  v_res := screening_v2.set_phone_halt('legal_hold', v_a2, t0 + interval '1 minute');
  if v_res->>'status' <> 'ok'
     or (v_res->>'already_halted')::boolean is not true
     or v_res->>'halt_reason' is distinct from 'legal_hold'
     or (v_res->>'reason_escalated')::boolean is not true then
    raise exception '0110 legal hold during a pause did not escalate: %', v_res;
  end if;
  select halted_at, halt_reason, halt_actor_id, updated_at into v_row
    from screening_v2.phone_control where control_key = 'default';
  if v_row.halted_at <> t0 then
    raise exception '0110 escalation moved the halt instant: %', row_to_json(v_row);
  end if;
  if v_row.halt_reason <> 'legal_hold' or v_row.halt_actor_id <> v_a2 then
    raise exception '0110 escalation did not record the legal hold and its actor: %',
      row_to_json(v_row);
  end if;
  select count(*) into v_n from screening_v2.audit_events
   where actor_id = v_a2 and metadata->>'override' = 'phone_admission_halt_set';
  select metadata into v_audit from screening_v2.audit_events
   where actor_id = v_a2 and metadata->>'override' = 'phone_admission_halt_set';
  if v_n <> 1 or v_audit->>'reason' <> 'legal_hold'
     or (v_audit->>'already_halted')::boolean is not true
     or v_audit->>'previous_reason' <> 'operator_pause'
     or v_audit->>'reason_in_force' <> 'legal_hold'
     or (v_audit->>'reason_escalated')::boolean is not true then
    raise exception '0110 escalation audit is wrong (% rows): %', v_n, v_audit;
  end if;

  -- The readers that trust the column now see the legal hold.
  if screening_v2.phone_backlog(t0 + interval '1 minute')->'admission'->>'halt_reason'
       is distinct from 'legal_hold' then
    raise exception '0110 phone_backlog still reports the weaker reason';
  end if;
  -- ...and the owner-test gate, which may bypass ONLY an operator pause,
  -- refuses — at the halt check, not later.
  v_res := screening_v2.arm_phone_test_gate(v_cand, v_eng, v_a1, 'sql0110-gate',
                                            t0 + interval '5 minutes', t0 + interval '1 minute');
  if v_res->>'status' is distinct from 'test_gate_halt_not_permitted' then
    raise exception '0110 the owner-test gate armed through a legal hold: %', v_res;
  end if;

  -- ── 3. legal_hold -> operator_pause is a NO-OP (never a downgrade) ────
  v_res := screening_v2.set_phone_halt('operator_pause', v_a3, t0 + interval '2 minutes');
  if v_res->>'status' <> 'ok'
     or (v_res->>'already_halted')::boolean is not true
     or v_res->>'halt_reason' is distinct from 'legal_hold'
     or (v_res->>'reason_escalated')::boolean is not false then
    raise exception '0110 a pause downgraded a legal hold: %', v_res;
  end if;
  select halted_at, halt_reason, halt_actor_id into v_row
    from screening_v2.phone_control where control_key = 'default';
  if v_row.halted_at <> t0 or v_row.halt_reason <> 'legal_hold' or v_row.halt_actor_id <> v_a2 then
    raise exception '0110 a weaker request changed the row: %', row_to_json(v_row);
  end if;
  select count(*) into v_n from screening_v2.audit_events
   where actor_id = v_a3 and metadata->>'override' = 'phone_admission_halt_set';
  select metadata into v_audit from screening_v2.audit_events
   where actor_id = v_a3 and metadata->>'override' = 'phone_admission_halt_set';
  if v_n <> 1 or v_audit->>'reason' <> 'operator_pause'
     or v_audit->>'previous_reason' <> 'legal_hold'
     or v_audit->>'reason_in_force' <> 'legal_hold'
     or (v_audit->>'reason_escalated')::boolean is not false then
    raise exception '0110 no-op audit is wrong (% rows): %', v_n, v_audit;
  end if;

  -- ── 4. An EQUAL request changes nothing either ────────────────────────
  v_res := screening_v2.set_phone_halt('legal_hold', v_a4, t0 + interval '3 minutes');
  select halt_reason, halt_actor_id into v_row
    from screening_v2.phone_control where control_key = 'default';
  if (v_res->>'reason_escalated')::boolean is not false or v_row.halt_actor_id <> v_a2 then
    raise exception '0110 an equal request re-attributed the halt: % %', v_res, row_to_json(v_row);
  end if;

  -- ── 5. emergency_stop beats everything; an anonymous escalation is the
  --       system actor's, exactly as 0042 attributes an anonymous halt ─────
  v_res := screening_v2.set_phone_halt('emergency_stop', null, t0 + interval '4 minutes');
  select halted_at, halt_reason, halt_actor_id into v_row
    from screening_v2.phone_control where control_key = 'default';
  if v_res->>'halt_reason' is distinct from 'emergency_stop'
     or (v_res->>'reason_escalated')::boolean is not true
     or v_row.halt_actor_id <> v_sys or v_row.halted_at <> t0 then
    raise exception '0110 emergency stop did not take over: % %', v_res, row_to_json(v_row);
  end if;
  for v_i in 1..4 loop
    v_res := screening_v2.set_phone_halt(v_order[v_i], v_a1, t0 + interval '5 minutes');
    if v_res->>'halt_reason' is distinct from 'emergency_stop'
       or (v_res->>'reason_escalated')::boolean is not false then
      raise exception '0110 % displaced an emergency stop: %', v_order[v_i], v_res;
    end if;
  end loop;

  -- ── 6. cost_control <-> provider_incident, both directions ────────────
  perform screening_v2.clear_phone_halt(v_a1, t0 + interval '6 minutes');
  perform screening_v2.set_phone_halt('cost_control', v_a1, t0 + interval '7 minutes');
  v_res := screening_v2.set_phone_halt('provider_incident', v_a2, t0 + interval '8 minutes');
  if v_res->>'halt_reason' is distinct from 'provider_incident'
     or (v_res->>'reason_escalated')::boolean is not true then
    raise exception '0110 provider incident did not outrank cost control: %', v_res;
  end if;
  v_res := screening_v2.set_phone_halt('cost_control', v_a3, t0 + interval '9 minutes');
  select halted_at, halt_reason into v_row
    from screening_v2.phone_control where control_key = 'default';
  if v_res->>'halt_reason' is distinct from 'provider_incident'
     or (v_res->>'reason_escalated')::boolean is not false
     or v_row.halt_reason <> 'provider_incident'
     or v_row.halted_at <> t0 + interval '7 minutes' then
    raise exception '0110 cost control downgraded a provider incident: % %', v_res, row_to_json(v_row);
  end if;

  -- ── 7. A refused request touches nothing and writes no audit row ──────
  v_res := screening_v2.set_phone_halt('because', v_a5, t0 + interval '10 minutes');
  if v_res->>'status' <> 'invalid_reason' then
    raise exception '0110 accepted a reason outside the vocabulary: %', v_res;
  end if;
  v_res := screening_v2.set_phone_halt(null, v_a5, t0 + interval '10 minutes');
  if v_res->>'status' <> 'invalid_reason' then
    raise exception '0110 accepted a null reason: %', v_res;
  end if;
  select count(*) into v_n from screening_v2.audit_events where actor_id = v_a5;
  if v_n <> 0 then raise exception '0110 a refused halt wrote % audit rows', v_n; end if;
  if (select halt_reason from screening_v2.phone_control where control_key = 'default')
       <> 'provider_incident' then
    raise exception '0110 a refused halt changed the row';
  end if;

  -- ── 8. The WHOLE order, every ordered pair ────────────────────────────
  for v_i in 1..5 loop
    for v_j in 1..5 loop
      -- 0114: a NULL-actor clear is refused actor_required; the drill sentinel
      -- keeps every clear attributable.
      perform screening_v2.clear_phone_halt('00000000-0000-4000-8000-0000000000d1', t0 + interval '20 minutes');
      perform screening_v2.set_phone_halt(v_order[v_i], v_ga, t0 + interval '21 minutes');
      v_res := screening_v2.set_phone_halt(v_order[v_j], v_gb, t0 + interval '22 minutes');
      v_want := v_order[greatest(v_i, v_j)];
      select halted_at, halt_reason, halt_actor_id into v_row
        from screening_v2.phone_control where control_key = 'default';
      if v_res->>'halt_reason' is distinct from v_want
         or v_row.halt_reason <> v_want
         or (v_res->>'reason_escalated')::boolean is distinct from (v_j > v_i)
         -- Parenthesised: PL/pgSQL ends an IF condition at the first bare THEN.
         or v_row.halt_actor_id <> (case when v_j > v_i then v_gb else v_ga end)
         or v_row.halted_at <> t0 + interval '21 minutes' then
        raise exception '0110 % then % gave % (row %), want %',
          v_order[v_i], v_order[v_j], v_res, row_to_json(v_row), v_want;
      end if;
    end loop;
  end loop;

  -- ── 9. Posture is 0042's, re-issued ───────────────────────────────────
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'screening_v2' and p.proname = 'set_phone_halt';
  select p.prosecdef, p.proconfig into v_row
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'screening_v2' and p.proname = 'set_phone_halt';
  if v_n <> 1 or not v_row.prosecdef
     or not ('search_path=pg_catalog, screening_v2' = any (v_row.proconfig)) then
    raise exception '0110 set_phone_halt posture drifted (% overloads): %', v_n, row_to_json(v_row);
  end if;
  if not has_function_privilege('service_role',
       'screening_v2.set_phone_halt(text, uuid, timestamptz)', 'execute')
     or has_function_privilege('anon',
       'screening_v2.set_phone_halt(text, uuid, timestamptz)', 'execute')
     or has_function_privilege('authenticated',
       'screening_v2.set_phone_halt(text, uuid, timestamptz)', 'execute') then
    raise exception '0110 set_phone_halt grants drifted';
  end if;

  raise notice '0110: precedence holds — escalates to the most restrictive reason, never downgrades, keeps the original instant, re-attributes only on escalation, and the owner-test gate refuses an escalated halt.';
end;
$$;

rollback;
