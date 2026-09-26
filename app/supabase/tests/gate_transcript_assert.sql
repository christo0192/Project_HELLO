-- =====================================================================
-- 0105 assertions — by execution, against the real functions.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_sess  uuid;
  v_res   jsonb;
  v_state jsonb;
  v_n     integer;
  v_gate  integer;
  v_now   constant timestamptz := '2026-09-26T10:00:00Z'::timestamptz;
begin
  select id into v_sess from screening_v2.call_sessions
   where external_call_id like 'gt105-phone-%' limit 1;
  if v_sess is null then
    raise exception 'gt105: the fixture session is missing';
  end if;

  -- ── ONE overload, not two ──────────────────────────────────────────
  -- Two candidates that both accept the same named arguments make
  -- PostgREST refuse EVERY call as ambiguous. 0105 drops 0071's signature
  -- first; if it ever comes back, the whole per-item path dies at runtime
  -- while every test that mocks Supabase stays green.
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'screening_v2' and p.proname = 'commit_phone_item_turn';
  if v_n <> 1 then
    raise exception 'gt105: expected exactly one commit_phone_item_turn overload, found %', v_n;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2' and p.proname = 'commit_phone_item_turn'
       and pg_get_function_identity_arguments(p.oid)
           = 'p_session_id uuid, p_speaker text, p_text text, p_source_item_id text, p_turn_started_at_ms bigint, p_is_gate boolean, p_now timestamp with time zone') then
    raise exception 'gt105: the surviving overload does not carry p_is_gate in the expected position';
  end if;

  -- ── A gate turn on a WAITING session is written and flagged ────────
  v_res := screening_v2.commit_phone_item_turn(
             p_session_id => v_sess, p_speaker => 'bot',
             p_text => 'Hi, this is an AI voice assistant calling about your job application. This call is recorded. Is it okay to continue?',
             p_source_item_id => 'phone-gate-item-1',
             p_turn_started_at_ms => 1758880800000, p_is_gate => true, p_now => v_now);
  if v_res ->> 'status' <> 'applied' or (v_res ->> 'applied')::boolean is not true then
    raise exception 'gt105: gate write refused: %', v_res;
  end if;
  v_res := screening_v2.commit_phone_item_turn(
             p_session_id => v_sess, p_speaker => 'candidate',
             p_text => 'Who is this?',
             p_source_item_id => 'phone-gate-item-2', p_is_gate => true, p_now => v_now);
  if v_res ->> 'status' <> 'applied' then
    raise exception 'gt105: candidate gate write refused: %', v_res;
  end if;
  select count(*) filter (where is_gate is true) into v_gate
    from screening_v2.transcript_turns where session_id = v_sess;
  if v_gate <> 2 then
    raise exception 'gt105: expected 2 gate rows, found %', v_gate;
  end if;

  -- ── Omitting the flag still means a SCORED turn (0071 unchanged) ───
  v_res := screening_v2.commit_phone_item_turn(
             p_session_id => v_sess, p_speaker => 'bot', p_text => 'Question one?',
             p_source_item_id => 'phone-item-3', p_now => v_now);
  if v_res ->> 'status' <> 'applied' then
    raise exception 'gt105: default write refused: %', v_res;
  end if;
  if (select is_gate from screening_v2.transcript_turns
       where session_id = v_sess and source_item_id = 'phone-item-3') is not false then
    raise exception 'gt105: an unflagged turn was written as gate';
  end if;
  -- ...and an explicit NULL reads as false, never as gate.
  v_res := screening_v2.commit_phone_item_turn(
             p_session_id => v_sess, p_speaker => 'bot', p_text => 'Question two?',
             p_source_item_id => 'phone-item-4', p_is_gate => null, p_now => v_now);
  if (select is_gate from screening_v2.transcript_turns
       where session_id = v_sess and source_item_id = 'phone-item-4') is not false then
    raise exception 'gt105: a NULL flag was written as gate';
  end if;

  -- ── Dedup on the item key still converges, flag or no flag ─────────
  v_res := screening_v2.commit_phone_item_turn(
             p_session_id => v_sess, p_speaker => 'bot', p_text => 'redelivered',
             p_source_item_id => 'phone-gate-item-1', p_is_gate => true, p_now => v_now);
  if (v_res ->> 'duplicate')::boolean is not true then
    raise exception 'gt105: a redelivered gate item did not converge: %', v_res;
  end if;
  select count(*) into v_n from screening_v2.transcript_turns where session_id = v_sess;
  if v_n <> 4 then
    raise exception 'gt105: expected 4 rows after a duplicate delivery, found %', v_n;
  end if;

  -- ── THE INVARIANT: gate rows without a plan are NOT durable consent ──
  -- 0070's `gate_recorded` is derived from `is_gate = true` rows and the
  -- worker uses it to SKIP the consent ask on a re-dispatched leg. These rows
  -- now exist BEFORE consent. It is not a bypass because the read answers
  -- `plan_missing` first — the plan is snapshotted only behind `in_call`,
  -- which only `disclosure.delivered` reaches. Asserted here by execution,
  -- because it lives in two functions written a year apart.
  v_state := screening_v2.get_phone_assessment_state(v_sess);
  if v_state ->> 'status' <> 'plan_missing' then
    raise exception 'gt105: a consent-less session with gate rows did not read plan_missing: %', v_state;
  end if;
  if (v_state -> 'gate_recorded') is not null then
    raise exception 'gt105: CONSENT BYPASS — gate_recorded exposed without a plan: %', v_state;
  end if;

  -- ── The once-at-consent writer stands down cleanly ─────────────────
  -- With per-item gate rows already present it must answer `already_recorded`
  -- and write NOTHING — not append a second copy of the disclosure.
  v_res := screening_v2.commit_phone_gate_turns(
             v_sess, 'gate:' || v_sess::text,
             jsonb_build_array(
               jsonb_build_object('speaker','bot','text','the disclosure again'),
               jsonb_build_object('speaker','candidate','text','yes')),
             v_now);
  if v_res ->> 'status' <> 'already_recorded' then
    raise exception 'gt105: the once-writer did not stand down: %', v_res;
  end if;
  select count(*) into v_n from screening_v2.transcript_turns where session_id = v_sess;
  if v_n <> 4 then
    raise exception 'gt105: the once-writer appended % rows past the per-item ones', v_n - 4;
  end if;

  -- ── The transcript-gap detector sees THROUGH gate rows ──────────────
  -- A call that died at the gate now has rows. If the detector counted them
  -- it would go silent for exactly the population the 2026-09-25 incident
  -- was about. Remove the scored rows so only the gate rows remain, close the
  -- session, and it must still be reported as having no transcript.
  delete from screening_v2.transcript_turns
   where session_id = v_sess and coalesce(is_gate, false) = false;
  -- The transition trigger allows waiting → in_progress → completed only.
  update screening_v2.call_sessions set status = 'in_progress' where id = v_sess;
  update screening_v2.call_sessions set status = 'completed' where id = v_sess;
  if not exists (select 1 from screening_v2.sessions_without_transcripts() d
                  where d.session_id = v_sess) then
    raise exception 'gt105: a session with ONLY gate rows was not reported as missing its transcript';
  end if;
  -- ...and a single scored row is a transcript, so it drops off the report.
  insert into screening_v2.transcript_turns
    (session_id, turn_index, speaker, text, is_gate, created_at, source_item_id)
  values (v_sess, 99, 'candidate', 'Three years in sales.', false, v_now, 'gt105-scored');
  if exists (select 1 from screening_v2.sessions_without_transcripts() d
              where d.session_id = v_sess) then
    raise exception 'gt105: a session WITH a scored row was reported as missing its transcript';
  end if;

  -- ── Still refuses a closed session (0071 unchanged) ────────────────
  v_res := screening_v2.commit_phone_item_turn(
             p_session_id => v_sess, p_speaker => 'bot', p_text => 'too late',
             p_source_item_id => 'phone-gate-item-9', p_is_gate => true, p_now => v_now);
  if v_res ->> 'status' <> 'session_not_active' then
    raise exception 'gt105: a closed session accepted a write: %', v_res;
  end if;

  -- ── The attach RPC's live comment no longer describes the retired posture ──
  if (select obj_description(p.oid, 'pg_proc')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'screening_v2' and p.proname = 'attach_phone_attempt_recording')
     not ilike '%KEEP the recording regardless of consent%' then
    raise exception 'gt105: attach_phone_attempt_recording still carries the retired "keep only if consented" comment';
  end if;

  -- ── Posture, like every other phone RPC ────────────────────────────
  if has_function_privilege('anon', 'screening_v2.commit_phone_item_turn(uuid,text,text,text,bigint,boolean,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'screening_v2.commit_phone_item_turn(uuid,text,text,text,bigint,boolean,timestamptz)', 'EXECUTE') then
    raise exception 'gt105: the RPC is browser-executable';
  end if;
  if not has_function_privilege('service_role', 'screening_v2.commit_phone_item_turn(uuid,text,text,text,bigint,boolean,timestamptz)', 'EXECUTE') then
    raise exception 'gt105: service_role cannot execute the RPC';
  end if;

  raise notice 'gt105: PASS';
end $$;

select 'gt105 ALL ASSERTIONS PASSED' as result;
