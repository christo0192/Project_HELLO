-- Executed by scripts/test-r1-scorer.sh inside the complete Supabase schema
-- (0001..0122 applied; never stubs). Fixtures use unique ids in the
-- 22000000-... namespace and encode(sha256('<tag>'::bytea), 'hex') digests.
create schema if not exists _r1_scorer_tests;
create table if not exists _r1_scorer_tests.passed (label text primary key);
create or replace function _r1_scorer_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'R1 scorer FAIL: % (%)', p_label, p_detail; end if;
  insert into _r1_scorer_tests.passed (label) values (p_label) on conflict do nothing;
  raise notice 'R1 scorer PASS: %', p_label;
end;
$$;

-- Marks every resolved reject decision as no longer part of the override window,
-- so each scenario below controls its own monitor input.
create or replace function _r1_scorer_tests.reset_history()
returns void language sql as $$
  update screening_v2.interview_rounds
     set status_write = 'human_review', pending_reject_until = null
   where status_write in ('rejected', 'pending_reject_cancelled', 'pending_reject', 'pending_reject_dropped');
$$;

-- Switches auto-status on WITHOUT restarting the override window. The fixtures below simulate
-- their own clock (2026-10-06) while 0122 stamps `override_window_reset_at` from the real
-- now() on a false -> true flip, so scenarios that need the whole history counted clear it.
-- The window-reset scenario flips the flag directly instead.
create or replace function _r1_scorer_tests.enable_auto()
returns void language plpgsql as $$
begin
  update screening_v2.r1_settings set auto_status_enabled = true;
  update screening_v2.r1_settings set override_window_reset_at = null;
end;
$$;

-- A fresh candidate + in_progress round (sent from `screened`, one attempt counted).
create or replace function _r1_scorer_tests.fixture(p_tag text, p_role uuid, p_owner uuid)
returns jsonb language plpgsql as $$
declare c uuid := md5('fx-cand:' || p_tag)::uuid; r uuid := md5('fx-round:' || p_tag)::uuid;
begin
  insert into screening_v2.candidates (id, role_id, name, status)
    values (c, p_role, 'Fixture ' || p_tag, 'screened');
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status,
     candidate_status_at_send, attempts_counted)
  values (r, c, p_role, encode(sha256(('fx-digest:' || p_tag)::bytea), 'hex'),
          now() + interval '3 days', p_owner, 'in_progress', 'screened', 1);
  return jsonb_build_object('cand', c, 'round', r);
end;
$$;

-- One completed R1 attempt for a round: session, attempt row, and a v2 assessment.
create or replace function _r1_scorer_tests.attempt(
  p_round uuid, p_candidate uuid, p_role uuid, p_owner uuid, p_attempt integer, p_tag text,
  p_revision integer default 1
) returns jsonb language plpgsql as $$
declare v_session uuid := md5('session:' || p_tag)::uuid; v_assessment uuid := md5('assessment:' || p_tag)::uuid;
begin
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (v_session, p_candidate, p_role, 'browser', 'livekit', 'screening-' || v_session::text,
          'created', p_round, p_owner)
  on conflict (id) do nothing;
  update screening_v2.call_sessions set status = 'waiting' where id = v_session and status = 'created';
  update screening_v2.call_sessions set status = 'in_progress' where id = v_session and status = 'waiting';
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete'
   where id = v_session and status = 'in_progress';
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest, counted)
  values (v_session, p_round, p_attempt, 'p1_career_switcher',
          encode(sha256(('nonce:' || p_tag)::bytea), 'hex'), true)
  on conflict (session_id) do nothing;
  insert into screening_v2.assessments
    (id, session_id, candidate_id, schema_version, revision, metric_results, scoring_status,
     weighted_score_5, overall_score, recommendation, raw, provenance)
  values (v_assessment, v_session, p_candidate, 2, p_revision, '[]'::jsonb, 'complete', 3.0, 67, 'advance',
          '{}'::jsonb,
          '{"schema_version":1,"provider":"deepseek","requestedModel":"deepseek-v4-pro","workload":"scoring","prompt_template_version":"r1-scoring-2026-10.1","timestamp":"2026-10-06T10:00:00Z"}'::jsonb)
  on conflict (id) do nothing;
  return jsonb_build_object('session', v_session, 'assessment', v_assessment);
end;
$$;

do $$
declare
  owner constant uuid := '22000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '22000000-0000-4000-8000-000000000002';
  role_phone constant uuid := '22000000-0000-4000-8000-000000000003';
  cand uuid[] := array[]::uuid[];
  rnd uuid[] := array[]::uuid[];
  i integer;
  a jsonb; r jsonb; res jsonb; sa uuid; aa uuid; f jsonb;
  v_now constant timestamptz := timestamptz '2026-10-06 10:00:00+00';
  v_reset timestamptz;
  n integer;
begin
  insert into auth.users (id, email) values (owner, 'r1-scorer@example.test') on conflict (id) do nothing;
  insert into screening_v2.roles (id, title, interview_kind) values
    (role_r1, 'Sales Program Advisor R1 scorer test', 'sales_r1'),
    (role_phone, 'Phone role scorer test', null);
  -- 14 independent candidate/round pairs, all `screened` and sent from `screened`.
  for i in 1..14 loop
    cand := cand || md5('cand:' || i)::uuid;
    rnd := rnd || md5('round:' || i)::uuid;
    insert into screening_v2.candidates (id, role_id, name, status)
      values (cand[i], role_r1, 'Scorer fixture ' || i, 'screened');
    insert into screening_v2.interview_rounds
      (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status,
       candidate_status_at_send, attempts_counted)
    values (rnd[i], cand[i], role_r1, encode(sha256(('digest:' || i)::bytea), 'hex'),
            now() + interval '3 days', owner, 'in_progress', 'screened', 1);
  end loop;

  -- ===== Privileges, search_path and security-definer posture ================
  perform _r1_scorer_tests.assert('all five RPCs are security definer with a pinned search_path', (
    select count(*) = 5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('r1_attach_assessment', 'r1_apply_status_effect', 'r1_check_override_rate',
                         'r1_apply_due_pending_rejects', 'r1_cancel_pending_reject')
       and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, screening_v2']));
  perform _r1_scorer_tests.assert('no caller role can execute any status-effect RPC', (
    select bool_and(not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and has_function_privilege('service_role', p.oid, 'execute'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('r1_attach_assessment', 'r1_apply_status_effect', 'r1_check_override_rate',
                         'r1_apply_due_pending_rejects', 'r1_cancel_pending_reject')));

  -- ===== Admin-log vocabulary =================================================
  a := _r1_scorer_tests.attempt(rnd[1], cand[1], role_r1, owner, 1, 'vocab');
  sa := (a->>'session')::uuid;
  insert into screening_v2.r1_admin_log (session_id, round_id, event_type, payload)
    values (sa, rnd[1], 'session_facts', '{"roleplay_seconds":700}'::jsonb);
  begin
    insert into screening_v2.r1_admin_log (session_id, round_id, event_type) values (sa, rnd[1], 'bogus_event');
    perform _r1_scorer_tests.assert('an unknown admin-log event type is refused', false);
  exception when check_violation then
    perform _r1_scorer_tests.assert('an unknown admin-log event type is refused', true);
  end;
  perform _r1_scorer_tests.assert('session_facts is accepted and the CHECK is validated', (
    select convalidated from pg_constraint where conname = 'chk_r1_admin_log_event_type'));

  -- ===== Attach: valid advance, idempotency, flag OFF ==========================
  aa := (a->>'assessment')::uuid;
  r := screening_v2.r1_attach_assessment(rnd[1], sa, aa, 'advance', 78.5, true,
         '{"scorer_version":"r1-scoring-2026-10.1"}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('attach of a valid assessment succeeds', r->>'status' = 'ok' and (r->>'attached')::boolean, r::text);
  perform _r1_scorer_tests.assert('attach records the recommendation, score and completes the round', exists (
    select 1 from screening_v2.interview_rounds
     where id = rnd[1] and assessment_id = aa and recommendation = 'advance' and overall = 78.5
       and status = 'completed' and pending_reject_until is null));
  perform _r1_scorer_tests.assert('attach writes an assessment_recorded audit row with the scorer version', exists (
    select 1 from screening_v2.audit_events
     where action = 'assessment_recorded' and target_id = aa::text and actor_type = 'system'
       and metadata->>'scorer_version' = 'r1-scoring-2026-10.1' and metadata->>'actor' = 'system:r1'));
  r := screening_v2.r1_attach_assessment(rnd[1], sa, aa, 'advance', 78.5, true, '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('re-attaching the same assessment is an idempotent no-op',
    r->>'status' = 'ok' and (r->>'unchanged')::boolean and (
      select count(*) from screening_v2.audit_events where action = 'assessment_recorded' and target_id = aa::text) = 1, r::text);
  perform _r1_scorer_tests.assert('a session outside the round is refused',
    (screening_v2.r1_attach_assessment(rnd[2], sa, aa, 'advance', 70, true)->>'status') = 'session_not_in_round');

  perform _r1_scorer_tests.assert('auto-status ships OFF', (select not auto_status_enabled from screening_v2.r1_settings));
  perform _r1_scorer_tests.assert('the override window has never been reset on a fresh install',
    (select override_window_reset_at is null from screening_v2.r1_settings));
  perform _r1_scorer_tests.assert('the settings trigger function is closed to every caller role',
    not has_function_privilege('anon', 'screening_v2.r1_settings_stamp_override_reset()', 'execute')
    and not has_function_privilege('authenticated', 'screening_v2.r1_settings_stamp_override_reset()', 'execute'));
  r := screening_v2.r1_apply_status_effect(rnd[1], aa, 'advance', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('flag OFF records flag_off and writes no candidate status',
    r->>'status' = 'ok' and r->>'status_write' = 'flag_off'
    and (select status from screening_v2.candidates where id = cand[1]) = 'screened', r::text);
  perform _r1_scorer_tests.assert('a second apply is already_applied',
    (screening_v2.r1_apply_status_effect(rnd[1], aa, 'advance', '{}'::jsonb, v_now)->>'status') = 'already_applied');
  perform _r1_scorer_tests.assert('a stale assessment id is refused as superseded',
    (screening_v2.r1_apply_status_effect(rnd[1], md5('nope')::uuid, 'advance')->>'status') = 'superseded');

  -- ===== Flag ON: advance CAS, human change wins, appeal block, hold, human_review =====
  perform _r1_scorer_tests.enable_auto();

  a := _r1_scorer_tests.attempt(rnd[2], cand[2], role_r1, owner, 1, 'adv');
  perform screening_v2.r1_attach_assessment(rnd[2], (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, true);
  r := screening_v2.r1_apply_status_effect(rnd[2], (a->>'assessment')::uuid, 'advance',
         '{"scorer_version":"r1-scoring-2026-10.1","thresholds":{"advance":65,"hold":45}}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('advance writes advanced via CAS',
    r->>'status_write' = 'advanced' and (select status from screening_v2.candidates where id = cand[2]) = 'advanced'
    and exists (select 1 from screening_v2.interview_rounds where id = rnd[2] and status_write = 'advanced' and status_written_at = v_now), r::text);
  perform _r1_scorer_tests.assert('the status write is audited with prior/new status, versions and thresholds', exists (
    select 1 from screening_v2.audit_events
     where action = 'candidate_status_changed' and target_id = cand[2]::text and result = 'success'
       and metadata->>'prior_status' = 'screened' and metadata->>'new_status' = 'advanced'
       and metadata->>'assessment_id' = (a->>'assessment') and metadata->>'actor' = 'system:r1'
       and metadata->>'scorer_version' = 'r1-scoring-2026-10.1' and metadata #>> '{thresholds,advance}' = '65'));

  a := _r1_scorer_tests.attempt(rnd[3], cand[3], role_r1, owner, 1, 'cas');
  perform screening_v2.r1_attach_assessment(rnd[3], (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, true);
  update screening_v2.candidates set status = 'rejected' where id = cand[3];   -- a human acted after sending
  r := screening_v2.r1_apply_status_effect(rnd[3], (a->>'assessment')::uuid, 'advance', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('CAS respects a human change after sending',
    r->>'status_write' = 'cas_lost' and (select status from screening_v2.candidates where id = cand[3]) = 'rejected'
    and not exists (select 1 from screening_v2.audit_events where action = 'candidate_status_changed' and target_id = cand[3]::text), r::text);

  a := _r1_scorer_tests.attempt(rnd[4], cand[4], role_r1, owner, 1, 'blocked');
  perform screening_v2.r1_attach_assessment(rnd[4], (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, true);
  update screening_v2.candidates set decision_use_blocked_at = now() where id = cand[4];
  r := screening_v2.r1_apply_status_effect(rnd[4], (a->>'assessment')::uuid, 'advance', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('an appeal block (decision_use_blocked_at) prevents any write',
    r->>'status_write' = 'decision_blocked' and (select status from screening_v2.candidates where id = cand[4]) = 'screened', r::text);

  a := _r1_scorer_tests.attempt(rnd[5], cand[5], role_r1, owner, 1, 'hold');
  perform screening_v2.r1_attach_assessment(rnd[5], (a->>'session')::uuid, (a->>'assessment')::uuid, 'hold', 55, true);
  r := screening_v2.r1_apply_status_effect(rnd[5], (a->>'assessment')::uuid, 'hold');
  perform _r1_scorer_tests.assert('hold is a flag only: no candidate write',
    r->>'status_write' = 'hold_flag' and (select status from screening_v2.candidates where id = cand[5]) = 'screened', r::text);

  -- A score that did not pass the gate can never carry a recommendation, whatever the caller
  -- passes; and only the recommendation attach stored may be applied.
  a := _r1_scorer_tests.attempt(rnd[13], cand[13], role_r1, owner, 1, 'invalid-rec');
  perform screening_v2.r1_attach_assessment(rnd[13], (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, false);
  perform _r1_scorer_tests.assert('a not-valid score stores no recommendation even if one is passed',
    (select recommendation from screening_v2.interview_rounds where id = rnd[13]) is null);
  r := screening_v2.r1_apply_status_effect(rnd[13], (a->>'assessment')::uuid, 'advance', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('applying a recommendation the round does not hold is refused',
    r->>'status' = 'recommendation_mismatch'
    and (select status from screening_v2.candidates where id = cand[13]) = 'screened'
    and (select status_write from screening_v2.interview_rounds where id = rnd[13]) is null, r::text);
  r := screening_v2.r1_apply_status_effect(rnd[13], (a->>'assessment')::uuid, null, '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('the not-valid score applies only as human_review', r->>'status_write' = 'human_review', r::text);

  a := _r1_scorer_tests.attempt(rnd[14], cand[14], role_r1, owner, 1, 'mismatch');
  res := screening_v2.r1_attach_assessment(rnd[14], (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, true,
           jsonb_build_object('blob', rpad('', 5000, 'x')), v_now);
  perform _r1_scorer_tests.assert('an oversized audit input is truncated, never a failed RPC', res->>'status' = 'ok'
    and exists (select 1 from screening_v2.audit_events
                 where action = 'assessment_recorded' and target_id = (a->>'assessment')
                   and metadata->>'audit_input' = 'truncated' and metadata->>'actor' = 'system:r1'), res::text);
  r := screening_v2.r1_apply_status_effect(rnd[14], (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('a reject cannot be applied to a round holding an advance',
    r->>'status' = 'recommendation_mismatch' and (select status from screening_v2.candidates where id = cand[14]) = 'screened', r::text);

  -- A gated-out attempt with a retake still available keeps the round open (D1).
  a := _r1_scorer_tests.attempt(rnd[6], cand[6], role_r1, owner, 1, 'human');
  update screening_v2.interview_rounds set attempts_counted = 1, attempts_allowed = 2 where id = rnd[6];
  r := screening_v2.r1_attach_assessment(rnd[6], (a->>'session')::uuid, (a->>'assessment')::uuid, null, 61, false);
  perform _r1_scorer_tests.assert('a not-valid score with a retake left keeps the round in_progress and null recommendation', exists (
    select 1 from screening_v2.interview_rounds where id = rnd[6] and status = 'in_progress' and recommendation is null and overall = 61));
  r := screening_v2.r1_apply_status_effect(rnd[6], (a->>'assessment')::uuid, null);
  perform _r1_scorer_tests.assert('human_review is recorded and never touches the candidate',
    r->>'status_write' = 'human_review' and (select status from screening_v2.candidates where id = cand[6]) = 'screened', r::text);
  -- ... and a not-valid score with the retake used up is final.
  a := _r1_scorer_tests.attempt(rnd[7], cand[7], role_r1, owner, 1, 'exhausted');
  update screening_v2.interview_rounds set attempts_counted = 2, attempts_allowed = 2 where id = rnd[7];
  perform screening_v2.r1_attach_assessment(rnd[7], (a->>'session')::uuid, (a->>'assessment')::uuid, null, null, false);
  perform _r1_scorer_tests.assert('a not-valid score with the retake used up completes the round',
    (select status from screening_v2.interview_rounds where id = rnd[7]) = 'completed');

  -- ===== Reject: 24 h pending window, due sweep, human cancel, CAS at close =====
  perform _r1_scorer_tests.reset_history();
  a := _r1_scorer_tests.attempt(rnd[8], cand[8], role_r1, owner, 1, 'rej');
  perform screening_v2.r1_attach_assessment(rnd[8], (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  r := screening_v2.r1_apply_status_effect(rnd[8], (a->>'assessment')::uuid, 'reject',
         '{"scorer_version":"r1-scoring-2026-10.1","thresholds":{"advance":65,"hold":45}}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('reject opens a 24 h pending window and leaves the candidate untouched',
    r->>'status_write' = 'pending_reject'
    and (select pending_reject_until from screening_v2.interview_rounds where id = rnd[8]) = v_now + interval '24 hours'
    and (select status from screening_v2.candidates where id = cand[8]) = 'screened', r::text);
  perform _r1_scorer_tests.assert('the pending reject is audited as pending', exists (
    select 1 from screening_v2.audit_events
     where action = 'candidate_status_changed' and target_id = cand[8]::text and result = 'pending'
       and metadata->>'stage' = 'pending_reject_opened'));
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '23 hours 59 minutes');
  perform _r1_scorer_tests.assert('nothing is due before 24 h',
    n = 0 and (select status from screening_v2.candidates where id = cand[8]) = 'screened');
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '24 hours');
  perform _r1_scorer_tests.assert('the due sweep executes the reject after 24 h and audits it',
    n = 1
    and (select status from screening_v2.candidates where id = cand[8]) = 'rejected'
    and exists (select 1 from screening_v2.interview_rounds where id = rnd[8] and status_write = 'rejected' and status_written_at is not null)
    and exists (select 1 from screening_v2.audit_events where action = 'candidate_status_changed' and target_id = cand[8]::text
                 and result = 'success' and metadata->>'new_status' = 'rejected'),
    format('applied=%s candidate=%s round=%s flag=%s', n,
           (select status from screening_v2.candidates where id = cand[8]),
           (select status_write from screening_v2.interview_rounds where id = rnd[8]),
           (select auto_status_enabled from screening_v2.r1_settings)));
  perform _r1_scorer_tests.assert('the executed reject carries the versions the window was opened with', exists (
    select 1 from screening_v2.audit_events
     where action = 'candidate_status_changed' and target_id = cand[8]::text and result = 'success'
       and metadata->>'stage' = 'applied' and metadata->>'actor' = 'system:r1'
       and metadata->>'scorer_version' = 'r1-scoring-2026-10.1' and metadata #>> '{thresholds,advance}' = '65'));
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '48 hours');
  perform _r1_scorer_tests.assert('the due sweep is idempotent', n = 0);

  perform _r1_scorer_tests.reset_history();
  a := _r1_scorer_tests.attempt(rnd[9], cand[9], role_r1, owner, 1, 'cancel');
  perform screening_v2.r1_attach_assessment(rnd[9], (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect(rnd[9], (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('cancelling needs an actor', (screening_v2.r1_cancel_pending_reject(rnd[9], null)->>'status') = 'actor_required');
  r := screening_v2.r1_cancel_pending_reject(rnd[9], owner, v_now + interval '1 hour');
  perform _r1_scorer_tests.assert('the first HR override trips the early monitor (1 of 1 resolved reject)',
    (r->'override'->>'disabled')::boolean and not (select auto_status_enabled from screening_v2.r1_settings), r::text);
  perform _r1_scorer_tests.assert('HR cancels the pending reject',
    r->>'status' = 'ok' and exists (
      select 1 from screening_v2.interview_rounds
       where id = rnd[9] and status_write = 'pending_reject_cancelled' and pending_reject_until is null
         and pending_reject_cancelled_by = owner and pending_reject_cancelled_at = v_now + interval '1 hour')
    and (select status from screening_v2.candidates where id = cand[9]) = 'screened', r::text);
  perform _r1_scorer_tests.assert('the cancellation is audited with the recruiter as actor', exists (
    select 1 from screening_v2.audit_events
     where action = 'candidate_status_changed' and target_id = cand[9]::text and actor_id = owner
       and actor_type = 'recruiter' and metadata->>'stage' = 'pending_reject_cancelled'));
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '72 hours');
  perform _r1_scorer_tests.assert('a cancelled window is never executed',
    n = 0 and (select status from screening_v2.candidates where id = cand[9]) = 'screened');
  perform _r1_scorer_tests.assert('cancelling twice answers not_pending',
    (screening_v2.r1_cancel_pending_reject(rnd[9], owner)->>'status') = 'not_pending');

  -- A human changing the candidate during the window wins at close.
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  a := _r1_scorer_tests.attempt(rnd[10], cand[10], role_r1, owner, 1, 'human-wins');
  perform screening_v2.r1_attach_assessment(rnd[10], (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect(rnd[10], (a->>'assessment')::uuid, 'reject',
    '{"scorer_version":"r1-scoring-2026-10.1"}'::jsonb, v_now);
  update screening_v2.candidates set status = 'advanced' where id = cand[10];
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '25 hours');
  perform _r1_scorer_tests.assert('a human change during the window drops the reject',
    n = 0
    and (select status from screening_v2.candidates where id = cand[10]) = 'advanced'
    and exists (select 1 from screening_v2.interview_rounds where id = rnd[10] and status_write = 'pending_reject_dropped')
    and exists (select 1 from screening_v2.audit_events where target_id = cand[10]::text and result = 'failure'
                 and metadata->>'reason' = 'status_changed_by_human'
                 and metadata->>'scorer_version' = 'r1-scoring-2026-10.1'));

  -- A window that closes with auto-status OFF is dropped, never executed.
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  a := _r1_scorer_tests.attempt(rnd[11], cand[11], role_r1, owner, 1, 'flag-off-at-close');
  perform screening_v2.r1_attach_assessment(rnd[11], (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect(rnd[11], (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  update screening_v2.r1_settings set auto_status_enabled = false;
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '25 hours');
  perform _r1_scorer_tests.assert('auto-status turned off before the window closes drops the reject',
    n = 0
    and (select status from screening_v2.candidates where id = cand[11]) = 'screened'
    and exists (select 1 from screening_v2.audit_events where target_id = cand[11]::text and metadata->>'reason' = 'auto_status_off'));

  -- ===== A newer attempt supersedes the deciding assessment ===================
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  a := _r1_scorer_tests.attempt(rnd[12], cand[12], role_r1, owner, 1, 'att1');
  perform screening_v2.r1_attach_assessment(rnd[12], (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect(rnd[12], (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  r := _r1_scorer_tests.attempt(rnd[12], cand[12], role_r1, owner, 2, 'att2');
  res := screening_v2.r1_attach_assessment(rnd[12], (r->>'session')::uuid, (r->>'assessment')::uuid, 'hold', 55, true);
  perform _r1_scorer_tests.assert('a later attempt replaces the deciding assessment and drops the unresolved reject',
    res->>'status' = 'ok'
    and exists (select 1 from screening_v2.interview_rounds
                 where id = rnd[12] and assessment_id = (r->>'assessment')::uuid and recommendation = 'hold'
                   and pending_reject_until is null and status_write = 'pending_reject_dropped'));
  perform _r1_scorer_tests.assert('the older attempt can no longer attach',
    (screening_v2.r1_attach_assessment(rnd[12], (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true)->>'status') = 'superseded_by_newer');
  perform _r1_scorer_tests.assert('the older assessment can no longer apply a status effect',
    (screening_v2.r1_apply_status_effect(rnd[12], (a->>'assessment')::uuid, 'reject')->>'status') = 'superseded');
  perform _r1_scorer_tests.assert('the replacing assessment applies on its own',
    (screening_v2.r1_apply_status_effect(rnd[12], (r->>'assessment')::uuid, 'hold')->>'status_write') = 'hold_flag');
  -- A higher revision of the same attempt wins; a lower one does not.
  insert into screening_v2.assessments
    (id, session_id, candidate_id, schema_version, revision, metric_results, scoring_status, weighted_score_5,
     overall_score, supersedes_assessment_id, raw, provenance)
  values (md5('assessment:att2-r2')::uuid, (r->>'session')::uuid, cand[12], 2, 2, '[]'::jsonb, 'complete', 3.0, 67,
          (r->>'assessment')::uuid, '{}'::jsonb,
          '{"schema_version":1,"provider":"deepseek","requestedModel":"deepseek-v4-pro","workload":"scoring","prompt_template_version":"r1-scoring-2026-10.1","timestamp":"2026-10-06T10:00:00Z"}'::jsonb);
  res := screening_v2.r1_attach_assessment(rnd[12], (r->>'session')::uuid, md5('assessment:att2-r2')::uuid, 'advance', 70, true);
  perform _r1_scorer_tests.assert('a higher revision of the same attempt replaces the lower',
    res->>'status' = 'ok'
    and (select assessment_id from screening_v2.interview_rounds where id = rnd[12]) = md5('assessment:att2-r2')::uuid);
  perform _r1_scorer_tests.assert('the lower revision cannot take it back',
    (screening_v2.r1_attach_assessment(rnd[12], (r->>'session')::uuid, (r->>'assessment')::uuid, 'hold', 55, true)->>'status') = 'superseded_by_newer');

  -- ===== Override monitor: >10 % over a rolling 20 =============================
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  -- 10 executed rejects the human left alone, then one HR cancellation: 1/11 = 9.09 % -> stays on.
  for i in 1..11 loop
    declare c uuid := md5('mon-cand:' || i)::uuid; rd uuid := md5('mon-round:' || i)::uuid; begin
      insert into screening_v2.candidates (id, role_id, name, status) values (c, role_r1, 'Monitor ' || i, 'rejected');
      insert into screening_v2.interview_rounds
        (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, candidate_status_at_send,
         recommendation, status_write, status_written_at, pending_reject_cancelled_at)
      values (rd, c, role_r1, encode(sha256(('mon-digest:' || i)::bytea), 'hex'), now() + interval '3 days', owner,
              'completed', 'screened', 'reject',
              case when i = 11 then 'pending_reject_cancelled' else 'rejected' end,
              case when i = 11 then null else v_now + (i || ' minutes')::interval end,
              case when i = 11 then v_now + (i || ' minutes')::interval else null end);
    end;
  end loop;
  r := screening_v2.r1_check_override_rate(v_now + interval '1 hour');
  perform _r1_scorer_tests.assert('1 override in 11 (9.09 %) does not trip the monitor',
    (r->>'window')::int = 11 and (r->>'overrides')::int = 1 and not (r->>'disabled')::boolean
    and (select auto_status_enabled from screening_v2.r1_settings), r::text);
  -- Add a second cancellation: 2/12 = 16.7 % -> auto-status is switched off and audited.
  declare c uuid := md5('mon-cand:12')::uuid; rd uuid := md5('mon-round:12')::uuid; begin
    insert into screening_v2.candidates (id, role_id, name, status) values (c, role_r1, 'Monitor 12', 'screened');
    insert into screening_v2.interview_rounds
      (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, candidate_status_at_send,
       recommendation, status_write, pending_reject_cancelled_at)
    values (rd, c, role_r1, encode(sha256('mon-digest:12'::bytea), 'hex'), now() + interval '3 days', owner,
            'completed', 'screened', 'reject', 'pending_reject_cancelled', v_now + interval '12 minutes');
  end;
  r := screening_v2.r1_check_override_rate(v_now + interval '1 hour');
  perform _r1_scorer_tests.assert('2 overrides in 12 (16.7 %) trip the monitor and disable auto-status',
    (r->>'disabled')::boolean and not (select auto_status_enabled from screening_v2.r1_settings), r::text);
  perform _r1_scorer_tests.assert('the auto-disable is audited with its reason', exists (
    select 1 from screening_v2.audit_events
     where action = 'config_changed' and target_type = 'r1_settings' and metadata->>'reason' = 'override_rate_exceeded'
       and (metadata->>'overrides')::int = 2 and (metadata->>'window')::int = 12));
  -- An executed reject later reversed by a human is an override too.
  perform _r1_scorer_tests.enable_auto();
  update screening_v2.candidates set status = 'screened' where id in (md5('mon-cand:1')::uuid, md5('mon-cand:2')::uuid);
  r := screening_v2.r1_check_override_rate(v_now + interval '1 hour');
  perform _r1_scorer_tests.assert('a reversed executed reject counts as an override', (r->>'overrides')::int = 4, r::text);
  -- Rolling window: 30 newer clean rejects push the old overrides out of the 20.
  for i in 100..129 loop
    declare c uuid := md5('mon-cand:' || i)::uuid; rd uuid := md5('mon-round:' || i)::uuid; begin
      insert into screening_v2.candidates (id, role_id, name, status) values (c, role_r1, 'Monitor ' || i, 'rejected');
      insert into screening_v2.interview_rounds
        (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, candidate_status_at_send,
         recommendation, status_write, status_written_at)
      values (rd, c, role_r1, encode(sha256(('mon-digest:' || i)::bytea), 'hex'), now() + interval '3 days', owner,
              'completed', 'screened', 'reject', 'rejected', v_now + interval '1 day' + (i || ' minutes')::interval);
    end;
  end loop;
  perform _r1_scorer_tests.enable_auto();
  r := screening_v2.r1_check_override_rate(v_now + interval '2 days');
  perform _r1_scorer_tests.assert('the monitor only looks at the latest 20 decisions',
    (r->>'window')::int = 20 and (r->>'overrides')::int = 0 and not (r->>'disabled')::boolean
    and (select auto_status_enabled from screening_v2.r1_settings), r::text);
  update screening_v2.r1_settings set auto_status_enabled = false;
  r := screening_v2.r1_check_override_rate(v_now, 200);
  perform _r1_scorer_tests.assert('with auto-status already off the monitor changes nothing',
    not (r->>'disabled')::boolean and not (select auto_status_enabled from screening_v2.r1_settings), r::text);

  -- ===== Re-enabling auto-status restarts the override window ====================
  -- Without this the monitor judges the window that tripped it again on the very next status
  -- tick (nothing can resolve while auto-status is off, so the window never refills).
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  f := _r1_scorer_tests.fixture('reenable-1', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'reenable-1');
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'reject', '{}'::jsonb, now() - interval '3 hours');
  r := screening_v2.r1_cancel_pending_reject((f->>'round')::uuid, owner, now() - interval '2 hours');
  perform _r1_scorer_tests.assert('HR cancelling the only resolved reject trips the monitor',
    (r->'override'->>'disabled')::boolean and not (select auto_status_enabled from screening_v2.r1_settings), r::text);
  -- The owner reviews the override and switches auto-status back on.
  update screening_v2.r1_settings set auto_status_enabled = true;
  perform _r1_scorer_tests.assert('switching auto-status back on stamps the window reset',
    (select override_window_reset_at is not null and override_window_reset_at <= now() from screening_v2.r1_settings));
  n := screening_v2.r1_apply_due_pending_rejects(now());
  perform _r1_scorer_tests.assert('the next status tick does not re-trip the monitor on the unchanged window',
    (select auto_status_enabled from screening_v2.r1_settings), n::text);
  r := screening_v2.r1_check_override_rate(now() + interval '1 day');
  perform _r1_scorer_tests.assert('the window restarts empty after a re-enable and stays enabled a day later',
    (r->>'window')::int = 0 and (r->>'overrides')::int = 0 and not (r->>'disabled')::boolean
    and (select auto_status_enabled from screening_v2.r1_settings), r::text);
  v_reset := (select override_window_reset_at from screening_v2.r1_settings);
  update screening_v2.r1_settings set dashboard_minutes = dashboard_minutes + 1;
  perform _r1_scorer_tests.assert('an unrelated settings change does not restart the window again',
    (select override_window_reset_at = v_reset from screening_v2.r1_settings));
  -- An override resolved AFTER the re-enable counts and trips it again.
  f := _r1_scorer_tests.fixture('reenable-2', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'reenable-2');
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'reject', '{}'::jsonb, now() + interval '1 hour');
  r := screening_v2.r1_cancel_pending_reject((f->>'round')::uuid, owner, now() + interval '2 hours');
  perform _r1_scorer_tests.assert('an override resolved after the re-enable trips the monitor again',
    (r->'override'->>'disabled')::boolean and (r->'override'->>'window')::int = 1
    and not (select auto_status_enabled from screening_v2.r1_settings), r::text);

  -- ===== A candidate status is written only when the round is final (D1) =========
  -- (a) HR grants the manual retake while a pending reject window is open.
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  f := _r1_scorer_tests.fixture('retake-window', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'retake-window');
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  r := screening_v2.r1_transition_round((f->>'round')::uuid, 'grant-retake',
         (select version from screening_v2.interview_rounds where id = (f->>'round')::uuid),
         null, now() + interval '3 days', v_now + interval '1 hour');
  perform _r1_scorer_tests.assert('HR can grant the manual retake while the window is open',
    r->>'status' = 'ok' and (select status from screening_v2.interview_rounds where id = (f->>'round')::uuid) = 'invited', r::text);
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '25 hours');
  perform _r1_scorer_tests.assert('a window whose round a manual retake re-opened is dropped, never executed',
    n = 0
    and (select status from screening_v2.candidates where id = (f->>'cand')::uuid) = 'screened'
    and exists (select 1 from screening_v2.interview_rounds
                 where id = (f->>'round')::uuid and status_write = 'pending_reject_dropped' and status_written_at is null)
    and exists (select 1 from screening_v2.audit_events
                 where target_id = (f->>'cand') and result = 'failure' and metadata->>'reason' = 'round_not_final'),
    format('n=%s candidate=%s', n, (select status from screening_v2.candidates where id = (f->>'cand')::uuid)));
  -- (b) The retake is granted before the apply of attempt 1 ran (a late replay).
  f := _r1_scorer_tests.fixture('retake-apply', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'retake-apply');
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, true);
  perform screening_v2.r1_transition_round((f->>'round')::uuid, 'grant-retake',
    (select version from screening_v2.interview_rounds where id = (f->>'round')::uuid),
    null, now() + interval '3 days', v_now);
  r := screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'advance', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('an advance applied after a retake re-opened the round writes nothing',
    r->>'status_write' = 'round_not_final'
    and (select status from screening_v2.candidates where id = (f->>'cand')::uuid) = 'screened'
    and exists (select 1 from screening_v2.interview_rounds
                 where id = (f->>'round')::uuid and status_write = 'round_not_final' and status_written_at is null), r::text);
  -- (c) HR cancels the still-in_progress round before the scorer attaches.
  f := _r1_scorer_tests.fixture('cancelled', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'cancelled');
  r := screening_v2.r1_transition_round((f->>'round')::uuid, 'cancel',
         (select version from screening_v2.interview_rounds where id = (f->>'round')::uuid), null, null, v_now);
  perform _r1_scorer_tests.assert('HR can cancel a round whose session is done but not yet scored', r->>'status' = 'ok', r::text);
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'advance', 80, true);
  r := screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'advance', '{}'::jsonb, v_now);
  perform _r1_scorer_tests.assert('a cancelled round is never advanced by a late score',
    r->>'status_write' = 'round_not_final'
    and (select status from screening_v2.interview_rounds where id = (f->>'round')::uuid) = 'cancelled'
    and (select status from screening_v2.candidates where id = (f->>'cand')::uuid) = 'screened'
    and not exists (select 1 from screening_v2.audit_events
                     where action = 'candidate_status_changed' and target_id = (f->>'cand')), r::text);
  perform _r1_scorer_tests.assert('a second apply on the cancelled round is already_applied',
    (screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'advance', '{}'::jsonb, v_now)->>'status') = 'already_applied');

  -- ===== A window that closed long ago is dropped, not executed late ============
  perform _r1_scorer_tests.reset_history();
  perform _r1_scorer_tests.enable_auto();
  f := _r1_scorer_tests.fixture('stale', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'stale');
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '25 hours 1 minute');
  perform _r1_scorer_tests.assert('a window overdue by more than an hour (R1 was switched off) is dropped as stale',
    n = 0
    and (select status from screening_v2.candidates where id = (f->>'cand')::uuid) = 'screened'
    and exists (select 1 from screening_v2.audit_events
                 where target_id = (f->>'cand') and result = 'failure' and metadata->>'reason' = 'window_stale'),
    format('n=%s', n));
  f := _r1_scorer_tests.fixture('stale-edge', role_r1, owner);
  a := _r1_scorer_tests.attempt((f->>'round')::uuid, (f->>'cand')::uuid, role_r1, owner, 1, 'stale-edge');
  perform screening_v2.r1_attach_assessment((f->>'round')::uuid, (a->>'session')::uuid, (a->>'assessment')::uuid, 'reject', 20, true);
  perform screening_v2.r1_apply_status_effect((f->>'round')::uuid, (a->>'assessment')::uuid, 'reject', '{}'::jsonb, v_now);
  n := screening_v2.r1_apply_due_pending_rejects(v_now + interval '25 hours');
  perform _r1_scorer_tests.assert('a window exactly one hour overdue (the grace period) still executes',
    n = 1 and (select status from screening_v2.candidates where id = (f->>'cand')::uuid) = 'rejected',
    format('n=%s', n));

  -- ===== Funnel views (M3) =====================================================
  perform _r1_scorer_tests.reset_history();
  declare
    cp uuid := md5('view-phone')::uuid; cr uuid := md5('view-r1')::uuid; cb uuid := md5('view-both')::uuid;
    sp uuid := md5('view-phone-session')::uuid; sb uuid := md5('view-both-phone-session')::uuid;
    rr uuid := md5('view-r1-round')::uuid; rb uuid := md5('view-both-round')::uuid;
    prov constant jsonb := '{"schema_version":1,"provider":"deepseek","requestedModel":"deepseek-v4-pro","workload":"scoring","prompt_template_version":"2026-08-05.1","timestamp":"2026-10-06T10:00:00Z"}'::jsonb;
  begin
    insert into screening_v2.candidates (id, role_id, name, status) values
      (cp, role_phone, 'View phone', 'screened'), (cr, role_r1, 'View r1', 'screened'), (cb, role_phone, 'View both', 'screened');
    -- A phone-lane candidate with a scored v2 assessment: must stay `scored`.
    insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status, owner_id)
      values (sp, cp, role_phone, 'live', 'livekit', 'view-phone-room', 'created', owner);
    insert into screening_v2.assessments (session_id, candidate_id, schema_version, revision, metric_results, scoring_status,
                                          weighted_score_5, overall_score, recommendation, raw, provenance)
      values (sp, cp, 2, 1, '[]'::jsonb, 'complete', 3.0, 67, 'advance', '{}'::jsonb, prov);
    -- An R1-only candidate: its assessment must not count as a phone "latest assessment".
    insert into screening_v2.interview_rounds (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
      values (rr, cr, role_r1, encode(sha256('view-r1-digest'::bytea), 'hex'), now() + interval '1 day', owner, 'in_progress');
    a := _r1_scorer_tests.attempt(rr, cr, role_r1, owner, 1, 'view-r1');
    -- A candidate with an OLDER phone assessment and a NEWER R1 one: the phone one stays "latest".
    insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status, owner_id)
      values (sb, cb, role_phone, 'live', 'livekit', 'view-both-room', 'created', owner);
    insert into screening_v2.assessments (session_id, candidate_id, schema_version, revision, metric_results, scoring_status,
                                          weighted_score_5, overall_score, recommendation, raw, provenance, created_at)
      values (sb, cb, 2, 1, '[]'::jsonb, 'complete', 2.0, 33, 'reject', '{}'::jsonb, prov, now() - interval '2 days');
    insert into screening_v2.interview_rounds (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
      values (rb, cb, role_r1, encode(sha256('view-both-digest'::bytea), 'hex'), now() + interval '1 day', owner, 'in_progress');
    a := _r1_scorer_tests.attempt(rb, cb, role_r1, owner, 1, 'view-both');

    perform _r1_scorer_tests.assert('a phone assessment is still the candidate''s latest assessment',
      (select scored and recommendation = 'advance' from screening_v2.v_funnel_candidate where candidate_id = cp));
    perform _r1_scorer_tests.assert('an R1-only assessment is excluded from the phone funnel',
      (select not scored and recommendation is null from screening_v2.v_funnel_candidate where candidate_id = cr));
    perform _r1_scorer_tests.assert('a newer R1 assessment never displaces the older phone one',
      (select scored and recommendation = 'reject' from screening_v2.v_funnel_candidate where candidate_id = cb));
    -- v_funnel_hr_state states that its latest assessment agrees with v_funnel_candidate's `scored`.
    perform _r1_scorer_tests.assert('an R1-only candidate has no hr_state: it is not scored in the phone funnel',
      (select hr_state is null from screening_v2.v_funnel_hr_state where candidate_id = cr));
    perform _r1_scorer_tests.assert('a phone-scored candidate still has an hr_state (R1 or not)',
      (select hr_state is not null from screening_v2.v_funnel_hr_state where candidate_id = cp)
      and (select hr_state is not null from screening_v2.v_funnel_hr_state where candidate_id = cb));
    perform _r1_scorer_tests.assert('v_funnel_hr_state and v_funnel_candidate agree on who is scored', not exists (
      select 1 from screening_v2.v_funnel_candidate c
        join screening_v2.v_funnel_hr_state h using (candidate_id)
       where c.candidate_id in (cp, cr, cb) and c.scored <> (h.hr_state is not null)));
  end;

  -- v_funnel_failures: phone DLQ rows unchanged, r1.* DLQ rows visible with their own prefix.
  insert into screening_v2.job_dlq (id, name, payload, dedup_key, attempts, max_attempts, error_message) values
    (md5('dlq-phone')::uuid, 'phone.assessment', '{}'::jsonb, 'k1', 5, 5, 'scorecard_invalid:result_count'),
    (md5('dlq-r1-score')::uuid, 'r1.assessment', '{}'::jsonb, 'k2', 5, 5, 'scorecard_invalid:result_count'),
    (md5('dlq-r1-rec')::uuid, 'r1.recording.finalize', '{}'::jsonb, 'k3', 5, 5, 'upload_failed'),
    (md5('dlq-r1-sweep')::uuid, 'r1.sweep', '{}'::jsonb, 'k4', 5, 5, 'Some Long Message With Spaces'),
    (md5('dlq-other')::uuid, 'other.queue', '{}'::jsonb, 'k5', 5, 5, 'x_failed');
  perform _r1_scorer_tests.assert('a phone DLQ row is unchanged in v_funnel_failures', exists (
    select 1 from screening_v2.v_funnel_failures
     where entity_id = md5('dlq-phone')::uuid::text and stage = 'scoring' and code = 'scorecard_invalid:result_count'));
  perform _r1_scorer_tests.assert('an r1.assessment DLQ row is a scoring failure with an r1: code', exists (
    select 1 from screening_v2.v_funnel_failures
     where entity_id = md5('dlq-r1-score')::uuid::text and stage = 'scoring' and code = 'r1:scorecard_invalid:result_count'));
  perform _r1_scorer_tests.assert('r1.recording.* maps to recording and r1.sweep to call', exists (
    select 1 from screening_v2.v_funnel_failures where entity_id = md5('dlq-r1-rec')::uuid::text and stage = 'recording' and code = 'r1:upload_failed')
    and exists (
    select 1 from screening_v2.v_funnel_failures where entity_id = md5('dlq-r1-sweep')::uuid::text and stage = 'call' and code = 'r1:failed'));
  perform _r1_scorer_tests.assert('non-phone, non-R1 DLQ rows stay out of the funnel',
    not exists (select 1 from screening_v2.v_funnel_failures where entity_id = md5('dlq-other')::uuid::text));
  perform _r1_scorer_tests.assert('every v_funnel_failures code stays inside the sanitized grammar',
    not exists (select 1 from screening_v2.v_funnel_failures where code !~ '^[a-z0-9_.:-]{1,64}$'));
  perform _r1_scorer_tests.assert('the funnel views stay service_role-only',
    not has_table_privilege('anon', 'screening_v2.v_funnel_failures', 'select')
    and not has_table_privilege('authenticated', 'screening_v2.v_funnel_candidate', 'select')
    and has_table_privilege('service_role', 'screening_v2.v_funnel_failures', 'select'));

  raise notice 'R1 scorer: ALL PASS';
end;
$$;
