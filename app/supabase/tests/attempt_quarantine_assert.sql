-- =====================================================================
-- 0108 assertions — the attempt-recording quarantine, by execution.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- 0107 added `chk_phone_call_attempts_recording_ready` (ready ⇒ not
-- quarantined, not deleted, fully described) and the download route's
-- integrity handler wrote `recording_quarantined = true` ALONE on a row it
-- had already proven ready. That is a guaranteed 23514, so the quarantine
-- could not execute even once: 500 to the caller, no containment, no
-- evidence, and a download button still on screen.
--
-- A unit test with a Supabase fake cannot catch that — the fake has no CHECK
-- constraint, so asserting "the code sent recording_quarantined: true" passes
-- against a write the database refuses. Only the real table can answer, so
-- this runs against it.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_role   uuid;
  v_cand   uuid;
  v_sess   uuid;
  v_eng    uuid;
  v_att    uuid;
  v_map    uuid;
  v_link   uuid;
  v_res    jsonb;
  v_ready  boolean;
  v_quar   boolean;
  v_reason text;
  v_att2   uuid;
  -- The same fixture owner the harness seeds into `auth.users`; roles.owner_id
  -- is a real FK, so a fresh uuid here fails the insert.
  v_owner  constant uuid := '00000000-0000-4000-8000-0000000000ad';
  v_now    constant timestamptz := '2026-09-27T10:00:00Z'::timestamptz;
begin
  -- ── Fixture: one attempt with a verified, ready recording ──────────
  delete from screening_v2.phone_call_attempts
   where room_name like 'q108-%';
  delete from screening_v2.phone_engagements
   where candidate_id in (select id from screening_v2.candidates
                           where email like 'q108-%@example.test');
  delete from screening_v2.call_sessions where external_call_id like 'q108-%';
  delete from screening_v2.ashby_application_links where external_application_id like 'q108-%';
  delete from screening_v2.ashby_job_mappings where external_job_id like 'q108-%';
  delete from screening_v2.candidates where email like 'q108-%@example.test';
  delete from screening_v2.roles where title like 'q108 %';

  insert into screening_v2.roles (title, jd, required_skills, screening_template, owner_id)
  values ('q108 role', 'Sell to enterprise buyers.', '["Outbound calling"]'::jsonb,
          jsonb_build_array(jsonb_build_object('id','q1','question','Tell me about yourself?','weight',1)),
          v_owner)
  returning id into v_role;

  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'q108 candidate', 'q108-a@example.test', '+919986700108', true)
  returning id into v_cand;

  -- `phone_engagements.application_link_id` is NOT NULL and a real FK, so the
  -- Ashby chain is built even though this file is about a recording flag.
  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('q108-job', v_role, v_owner, 'q108-ai', 'q108-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle, candidate_id)
  values ('q108-app', 'q108-job', v_map, repeat('h', 64), v_cand)
  returning id into v_link;

  insert into screening_v2.call_sessions (candidate_id, role_id, mode, provider, status)
  values (v_cand, v_role, 'live', 'livekit', 'created')
  returning id into v_sess;
  update screening_v2.call_sessions
     set status = 'waiting', external_call_id = 'q108-phone-' || v_sess::text
   where id = v_sess;

  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, state)
  values (v_link, v_cand, v_role, 'in_call')
  returning id into v_eng;

  -- The attempt is inserted bare and then stamped, because the object key is
  -- derived from the attempt's own id and the key format is constrained
  -- (`phone-<uuid>-egress.ogg`).
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, prior_engagement_state,
     ist_date, room_name, egress_id, egress_status, admitted_at)
  values
    (v_eng, 1, 1, 'initial', 'ended', 'eligible', '2026-09-27', 'q108-room-1',
     'EG_worker_q108', 'complete', v_now)
  returning id into v_att;

  update screening_v2.phone_call_attempts
     set recording_object_key   = 'phone-' || v_att::text || '-egress.ogg',
         recording_manifest_key = 'phone-' || v_att::text || '-egress.ogg.json',
         recording_role         = 'authoritative',
         recording_sha256       = repeat('a', 64),
         recording_size_bytes   = 1024,
         recording_content_type = 'audio/ogg',
         recording_session_id   = v_sess,
         recording_ready        = true
   where id = v_att;

  -- ── THE BUG, REPRODUCED. The flag-only write the route used to do ──
  -- It must be refused by the constraint. If this ever stops raising, the
  -- CHECK has been weakened and the route's old shape would silently work
  -- again — in which case this whole migration is pointless.
  begin
    update screening_v2.phone_call_attempts
       set recording_quarantined = true
     where id = v_att;
    raise exception 'q108: a ready+quarantined row was accepted — chk_phone_call_attempts_recording_ready is not enforcing';
  exception
    when check_violation then
      -- Pin the constraint: a future NOT NULL or trigger raising 23514 would
      -- otherwise let this pass for the wrong reason.
      if position('chk_phone_call_attempts_recording_ready' in sqlerrm) = 0 then
        raise exception 'q108: a check fired, but not the one under test: %', sqlerrm;
      end if;
  end;

  -- ── THE FIX. The RPC flips both flags and records the evidence ─────
  v_res := screening_v2.quarantine_phone_attempt_recording(
             v_att, 'download_reverify_mismatch', repeat('a', 64), repeat('b', 64),
             1024, 'corr-q108');
  if v_res ->> 'status' <> 'quarantined' then
    raise exception 'q108: quarantine refused: %', v_res;
  end if;

  select recording_ready, recording_quarantined into v_ready, v_quar
    from screening_v2.phone_call_attempts where id = v_att;
  if v_quar is not true then
    raise exception 'q108: the attempt was not quarantined';
  end if;
  if v_ready is not false then
    raise exception 'q108: recording_ready was left true — the row still advertises a download';
  end if;

  select recording_quarantine_reason into v_reason
    from screening_v2.phone_call_attempts where id = v_att;
  if v_reason <> 'download_reverify_mismatch' then
    raise exception 'q108: the quarantine reason was not recorded: %', v_reason;
  end if;

  -- ── CAS: a second click changes nothing and says so ────────────────
  v_res := screening_v2.quarantine_phone_attempt_recording(
             v_att, 'download_reverify_oversize', repeat('a', 64), repeat('c', 64),
             1024, 'corr-q108-again');
  if v_res ->> 'status' <> 'already_quarantined' then
    raise exception 'q108: a repeat quarantine did not report already_quarantined: %', v_res;
  end if;
  select recording_quarantine_reason into v_reason
    from screening_v2.phone_call_attempts where id = v_att;
  if v_reason <> 'download_reverify_mismatch' then
    raise exception 'q108: a repeat quarantine overwrote the first reason: %', v_reason;
  end if;

  -- ── A SECOND ATTEMPT ON THE SAME SESSION ───────────────────────────
  -- Phone sessions are reused across attempts. The first draft of this
  -- migration appended a `mismatch_quarantined` row to
  -- recording_integrity_events, whose exactly-once index (0014) is keyed on
  -- session_id ALONE — so this second quarantine would have raised 23505,
  -- rolled back the flag flip, and reproduced the very 500 the migration
  -- exists to remove. It must simply work.
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, prior_engagement_state,
     ist_date, ist_day_seq, room_name, egress_id, egress_status, admitted_at)
  values
    (v_eng, 2, 1, 'no_answer_retry', 'ended', 'eligible', '2026-09-27', 2,
     'q108-room-2', 'EG_worker_q108b', 'complete', v_now)
  returning id into v_att2;

  update screening_v2.phone_call_attempts
     set recording_object_key   = 'phone-' || v_att2::text || '-egress.ogg',
         recording_manifest_key = 'phone-' || v_att2::text || '-egress.ogg.json',
         recording_role         = 'supplementary',
         recording_sha256       = repeat('d', 64),
         recording_size_bytes   = 2048,
         recording_content_type = 'audio/ogg',
         recording_session_id   = v_sess,
         recording_ready        = true
   where id = v_att2;

  v_res := screening_v2.quarantine_phone_attempt_recording(
             v_att2, 'download_reverify_mismatch', repeat('d', 64), repeat('e', 64),
             2048, 'corr-q108-second');
  if v_res ->> 'status' <> 'quarantined' then
    raise exception 'q108: the SECOND attempt on the same session could not be quarantined: %', v_res;
  end if;
  select recording_ready, recording_quarantined into v_ready, v_quar
    from screening_v2.phone_call_attempts where id = v_att2;
  if v_quar is not true or v_ready is not false then
    raise exception 'q108: the second attempt was not contained (ready=%, quarantined=%)', v_ready, v_quar;
  end if;

  -- ── And 0014's SESSION-side quarantine still works afterwards ──────
  -- The discarded design would have poisoned it: an attempt-scoped evidence
  -- row occupies the session's exactly-once slot, so the session route's own
  -- quarantine would then 23505 forever.
  update screening_v2.call_sessions
     set recording_object_key = 'sessions/q108/rec.ogg',
         recording_sha256 = repeat('f', 64)
   where id = v_sess;
  v_res := screening_v2.quarantine_recording(
             v_sess, 'download_reverify_mismatch', repeat('f', 64), repeat('0', 64),
             4096, 'corr-q108-session');
  if v_res ->> 'status' <> 'quarantined' then
    raise exception 'q108: the SESSION-side quarantine was poisoned by the attempt path: %', v_res;
  end if;

  -- ── An erased recording is not resurrected ─────────────────────────
  update screening_v2.phone_call_attempts
     set recording_deleted_at = v_now, recording_ready = false,
         recording_quarantined = false
   where id = v_att2;
  v_res := screening_v2.quarantine_phone_attempt_recording(
             v_att2, 'download_reverify_mismatch');
  if v_res ->> 'status' <> 'already_deleted' then
    raise exception 'q108: a deleted recording was re-quarantined: %', v_res;
  end if;

  -- ── A missing attempt is answered, not raised ──────────────────────
  v_res := screening_v2.quarantine_phone_attempt_recording(
             '00000000-0000-4000-8000-00000000dead'::uuid, 'download_reverify_mismatch');
  if v_res ->> 'status' <> 'attempt_not_found' then
    raise exception 'q108: an unknown attempt was not reported as such: %', v_res;
  end if;

  -- ── Posture, like every other phone RPC ────────────────────────────
  if has_function_privilege('anon', 'screening_v2.quarantine_phone_attempt_recording(uuid,text,text,text,bigint,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'screening_v2.quarantine_phone_attempt_recording(uuid,text,text,text,bigint,text)', 'EXECUTE') then
    raise exception 'q108: the RPC is browser-executable';
  end if;
  if not has_function_privilege('service_role', 'screening_v2.quarantine_phone_attempt_recording(uuid,text,text,text,bigint,text)', 'EXECUTE') then
    raise exception 'q108: service_role cannot execute the RPC';
  end if;

  raise notice 'q108: PASS';
end $$;

select 'q108 ALL ASSERTIONS PASSED' as result;
