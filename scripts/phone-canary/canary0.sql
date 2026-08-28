-- ═══════════════════════════════════════════════════════════════════════
--  canary0.sql — the Canary-0 substrate rehearsal
-- ═══════════════════════════════════════════════════════════════════════
--
-- Run with, IN THIS ORDER:
--   psql ... -f - < fixtures.sql     -- the shared substrate, emits nothing
--   psql ... -f - < canary0.sql      -- this file, emits the protocol
--   ...the runner's halt RACE, driven from Node through the same helpers...
--   psql ... -f - < teardown.sql     -- removes the substrate
--
-- WHAT THIS IS. Nine scenarios driven against a REAL Postgres carrying
-- 0001..0045, at fixed instants, through the real service-role RPCs. It is
-- the half of Canary-0 that proves the SUBSTRATE, which is where every
-- invariant this lane cares about is actually enforced. The Node runner
-- (`canary0.mjs`) owns the halt RACE, the zero-PSTN negative control and the
-- sanitized manifest; this file owns the state machine.
--
-- WHY THERE IS NO PROVIDER HERE. A "LiveKit/SIP event" in this file is an
-- `apply_phone_event` call shaped exactly like the real ingress and produced
-- by this script. There is no SDK to import and no socket to open: the
-- fake is structural, not a mock that could be swapped for a real client.
--
-- DETERMINISM. Every RPC is passed an explicit `p_now`. Nothing calls
-- `now()`. Every scenario owns its own IST date, so the per-IST-day unique
-- index cannot make one scenario's fixture refuse another's. 09:00–21:00
-- IST is 03:30–15:30 UTC; every instant below is 10:00 IST = 04:30 UTC
-- unless a scenario is deliberately testing a boundary.
--
-- OUTPUT. Stdout carries ONLY the four line shapes in PROTOCOL.md. Query
-- output is redirected to /dev/null for the whole body and restored just
-- for the emit block, so psql's command tags cannot reach the parser.
--
-- FAILURE MODEL. A failed CHECK records `ok = false` and keeps going; it
-- never raises. A genuine SQL error raises, ON_ERROR_STOP aborts, no
-- CANARYDONE is emitted, and the runner fails the run. A scenario that
-- cannot continue records `scenario_aborted` and returns, so a truncated
-- scenario is visibly failed rather than quietly short.

\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset footer off
\o /dev/null

-- Only real problems reach stderr. A `drop ... cascade` notice is not one,
-- and a runner that has to filter chatter to find a failure will one day
-- filter a failure.
set client_min_messages = warning;

-- ── This file OWNS no substrate ───────────────────────────────────────
-- `fixtures.sql` must already be applied in this database. Recreating the
-- helpers here would mean two definitions of the same thing in two files,
-- and the one that ran last would win silently.
--
-- The two report tables ARE reset, and only they: without this a second run
-- would append a fresh set of verdicts to the first run's and report every
-- check twice, which reads as a suite that grew rather than one that ran
-- again. `restart identity` keeps `ord` — and therefore the emitted order —
-- identical between runs.
truncate _phone_canary.verdict, _phone_canary.metric restart identity;


-- ═══════════════════════════════════════════════════════════════════════
-- 1. human_screening_end_to_end
-- ═══════════════════════════════════════════════════════════════════════
-- The consenting path, end to end, plus the two gates that make it safe:
-- nothing may be recorded and nothing may be screened before the spoken
-- disclosure, and a completion claim must be backed by a real score.
do $$
declare
  s        constant text := 'human_screening_end_to_end';
  tag      constant text := 'canary0-s1';
  tag2     constant text := 'canary0-s1neg';
  t        constant timestamptz := '2026-11-02T04:30:00Z';   -- 10:00 IST
  eng uuid; att uuid; cand uuid; sess uuid; r jsonb; st jsonb;
  okey text; mkey text;
  qcount integer; cursor_now integer; committed integer := 0;
  ev_before bigint; ev_after bigint;
  eng2 uuid; att2 uuid; cand2 uuid; sess2 uuid;
  eng_epoch integer; att_epoch integer;
begin
  eng  := _phone_canary.fixture(tag, '10001');
  select candidate_id into cand from screening_v2.phone_engagements where id = eng;

  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180, t);
  perform _phone_canary.chk(s, 'admission_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'admission_refused');
    return;
  end if;
  att  := (r->>'attempt_id')::uuid;
  sess := _phone_canary.new_session(cand, t);
  okey := 'phone-' || att::text || '-egress.mp3';
  mkey := okey || '.json';

  -- ── The gate, BEFORE the ANSWER ────────────────────────────────────
  -- 0067 inverted the recording posture: audio may exist from the moment a
  -- human ANSWERS (kept only if they consent), but never before. Here the
  -- attempt is still `admitted` — nobody has answered — so the ATTEMPT gate
  -- refuses. The assessment gate below is unchanged: screening still starts
  -- only at the disclosure edge.
  r := screening_v2.attach_phone_attempt_recording(att, okey, mkey, 'authoritative', null, t);
  perform _phone_canary.chk(s, 'recording_refused_before_answer',
                            r->>'status' = 'attempt_not_recordable',
                            _phone_canary.code(r->>'status'));
  r := screening_v2.start_phone_assessment(att, sess, t);
  perform _phone_canary.chk(s, 'assessment_refused_before_disclosure',
                            r->>'status' = 'disclosure_not_delivered',
                            _phone_canary.code(r->>'status'));

  -- ── The call ───────────────────────────────────────────────────────
  r := _phone_canary.sip(att, 'sip.participant_joined', t + interval '5 seconds', 1);
  perform _phone_canary.chk(s, 'join_applied', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'join_is_not_answer',
    (select state from screening_v2.phone_call_attempts where id = att)
      = 'answered_unclassified',
    _phone_canary.code((select state from screening_v2.phone_call_attempts where id = att)));

  -- ── Recording binds FROM THE ANSWER (0067) ─────────────────────────
  -- An answered, not-yet-classified leg may now carry a recording, so the
  -- greeting and the consent exchange are on the tape; every non-consent
  -- exit purges it before its event posts.
  r := screening_v2.attach_phone_attempt_recording(att, okey, mkey, 'authoritative', null,
                                                   t + interval '6 seconds');
  perform _phone_canary.chk(s, 'recording_allowed_from_answer', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));

  r := _phone_canary.sip(att, 'classify.human', t + interval '8 seconds', 2);
  perform _phone_canary.chk(s, 'classified_human',
    (select state from screening_v2.phone_call_attempts where id = att) = 'human',
    _phone_canary.code((select state from screening_v2.phone_call_attempts where id = att)));

  select epoch into eng_epoch from screening_v2.phone_engagements where id = eng;
  r := _phone_canary.sip(att, 'disclosure.delivered', t + interval '20 seconds', 3);
  perform _phone_canary.chk(s, 'disclosure_applied', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'engagement_in_call',
    (select state from screening_v2.phone_engagements where id = eng) = 'in_call',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  perform _phone_canary.chk(s, 'engagement_epoch_bumped',
    (select epoch from screening_v2.phone_engagements where id = eng) = eng_epoch + 1,
    'epoch');
  select epoch into att_epoch from screening_v2.phone_call_attempts where id = att;
  perform _phone_canary.chk(s, 'attempt_epoch_bumped', att_epoch = eng_epoch + 1, 'epoch');

  -- ── The gate, AFTER the disclosure ─────────────────────────────────
  r := screening_v2.attach_phone_attempt_recording(att, okey, mkey, 'authoritative', null,
                                                   t + interval '21 seconds');
  perform _phone_canary.chk(s, 'recording_allowed_after_disclosure', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  r := screening_v2.finalize_phone_attempt_recording(att, 'complete', null,
                                                     t + interval '22 seconds');
  perform _phone_canary.chk(s, 'recording_finalized', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));

  -- ── The screening ──────────────────────────────────────────────────
  r := screening_v2.start_phone_assessment(att, sess, t + interval '25 seconds');
  perform _phone_canary.chk(s, 'assessment_started', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'assessment_start_refused');
    return;
  end if;

  st := screening_v2.get_phone_assessment_state(sess);
  qcount := (st->>'question_count')::integer;
  perform _phone_canary.chk(s, 'plan_snapshotted',
                            st->>'status' = 'ok' and qcount >= 1,
                            _phone_canary.code(st->>'status'));
  perform _phone_canary.chk(s, 'cursor_starts_at_zero',
                            (st->>'cursor')::integer = 0, 'cursor');

  -- Every boundary, driven by the plan itself rather than by a literal.
  while (st->>'plan_complete')::boolean is not true loop
    cursor_now := (st->>'cursor')::integer;
    r := screening_v2.commit_phone_question_boundary(
           sess, st->>'next_key', cursor_now,
           'canary0-evt-' || cursor_now::text,
           jsonb_build_array(
             jsonb_build_object('speaker','bot','text','Asking the question.'),
             jsonb_build_object('speaker','candidate','text','Answering the question.')),
           t + interval '30 seconds' + (cursor_now * interval '10 seconds'));
    if r->>'status' <> 'applied' then
      perform _phone_canary.chk(s, 'boundary_applied', false,
                                _phone_canary.code(r->>'status'));
      perform _phone_canary.chk(s, 'scenario_aborted', false, 'boundary_refused');
      return;
    end if;
    committed := committed + 1;
    st := screening_v2.get_phone_assessment_state(sess);
    exit when committed > 100;   -- a loop bound, not a business rule
  end loop;
  perform _phone_canary.chk(s, 'every_boundary_committed', committed = qcount, 'boundaries');
  perform _phone_canary.chk(s, 'cursor_reached_plan_end',
                            (st->>'cursor')::integer = qcount, 'cursor');
  perform _phone_canary.chk(s, 'completed_keys_match_plan',
                            jsonb_array_length(st->'completed_keys') = qcount, 'keys');

  -- A retry of the LAST boundary under its own event id must be answered
  -- with the ORIGINAL success, not refused. A worker whose ack was lost
  -- has to be able to tell "already recorded" from "never recorded".
  r := screening_v2.commit_phone_question_boundary(
         sess, (st->'completed_keys'->>(qcount - 1)), qcount - 1,
         'canary0-evt-' || (qcount - 1)::text,
         jsonb_build_array(
           jsonb_build_object('speaker','bot','text','Asking the question.'),
           jsonb_build_object('speaker','candidate','text','Answering the question.')),
         t + interval '5 minutes');
  perform _phone_canary.chk(s, 'boundary_replay_is_idempotent',
                            r->>'status' = 'applied' and (r->>'duplicate')::boolean,
                            _phone_canary.code(r->>'status'));

  -- ── The completion, backed by a real score ─────────────────────────
  perform _phone_canary.score(sess, cand, t + interval '6 minutes');
  r := screening_v2.apply_phone_event('internal', 'assessment.completed', att, null,
                                      null, att_epoch, null, t + interval '7 minutes');
  perform _phone_canary.chk(s, 'completion_applied', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'engagement_completed',
    (select state from screening_v2.phone_engagements where id = eng) = 'completed',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  perform _phone_canary.chk(s, 'engagement_terminal_at_set',
    (select terminal_at is not null from screening_v2.phone_engagements where id = eng),
    'terminal_at');
  perform _phone_canary.chk(s, 'attempt_outcome_completed',
    (select state = 'ended' and outcome_class = 'completed'
       from screening_v2.phone_call_attempts where id = att), 'outcome');

  -- ── The interlock is real, and it writes NOTHING ───────────────────
  -- A completion claim with no score behind it must be refused BEFORE the
  -- ledger insert. Recording it would be read back verbatim by every later
  -- delivery of the same deterministic id and wedge the call forever.
  perform _phone_canary.teardown(tag2);
  cand2 := _phone_canary.new_candidate(tag2, '10002');
  eng2  := _phone_canary.new_engagement(tag2, '', cand2);
  r := screening_v2.admit_phone_attempt(eng2, 'initial', 'canary0', 180, t);
  att2 := (r->>'attempt_id')::uuid;
  sess2 := _phone_canary.new_session(cand2, t);
  perform _phone_canary.sip(att2, 'sip.participant_joined', t + interval '5 seconds', 1);
  perform _phone_canary.sip(att2, 'classify.human', t + interval '8 seconds', 2);
  perform _phone_canary.sip(att2, 'disclosure.delivered', t + interval '20 seconds', 3);
  select count(*) into ev_before from screening_v2.phone_call_events
   where attempt_id = att2 or engagement_id = eng2;
  r := screening_v2.apply_phone_event('internal', 'assessment.completed', att2, null,
                                      null,
                                      (select epoch from screening_v2.phone_call_attempts
                                        where id = att2),
                                      null, t + interval '30 seconds');
  select count(*) into ev_after from screening_v2.phone_call_events
   where attempt_id = att2 or engagement_id = eng2;
  perform _phone_canary.chk(s, 'unscored_completion_refused',
                            r->>'status' = 'assessment_missing',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'unscored_completion_wrote_no_event',
                            ev_after = ev_before, 'ledger');
  perform _phone_canary.chk(s, 'unscored_engagement_not_completed',
    (select state from screening_v2.phone_engagements where id = eng2) = 'in_call',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng2)));

  perform _phone_canary.cnt(s, 'questions_committed', committed);
  perform _phone_canary.cnt(s, 'boundaries_idempotent', 1);
end;
$$;
do $$ begin
  perform _phone_canary.teardown('canary0-s1');
  perform _phone_canary.teardown('canary0-s1neg');
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. voicemail_no_recording_no_score
-- ═══════════════════════════════════════════════════════════════════════
-- A machine answered. It must charge a no-answer attempt and must produce
-- NO recording, NO plan, NO turns and NO score — the whole point of #15.
do $$
declare
  s   constant text := 'voicemail_no_recording_no_score';
  tag constant text := 'canary0-s2';
  t   constant timestamptz := '2026-11-03T04:30:00Z';
  eng uuid; att uuid; cand uuid; sess uuid; r jsonb;
  okey text; mkey text; n integer;
begin
  eng := _phone_canary.fixture(tag, '20001');
  select candidate_id into cand from screening_v2.phone_engagements where id = eng;

  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180, t);
  perform _phone_canary.chk(s, 'admission_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'admission_refused');
    return;
  end if;
  att := (r->>'attempt_id')::uuid;
  okey := 'phone-' || att::text || '-egress.mp3';
  mkey := okey || '.json';

  r := _phone_canary.sip(att, 'classify.machine', t + interval '30 seconds', 1);
  perform _phone_canary.chk(s, 'voicemail_applied', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'attempt_ended_voicemail',
    (select state = 'ended' and outcome_class = 'voicemail'
       from screening_v2.phone_call_attempts where id = att), 'outcome');
  perform _phone_canary.chk(s, 'engagement_awaiting_retry',
    (select state from screening_v2.phone_engagements where id = eng) = 'awaiting_retry',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  select no_answer_attempts into n from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'no_answer_charged_once', n = 1, 'budget');

  -- Nothing may be recorded and nothing may be screened. The engagement
  -- never reached `in_call`, so both gates refuse for the same reason.
  r := screening_v2.attach_phone_attempt_recording(att, okey, mkey, 'authoritative', null, t);
  perform _phone_canary.chk(s, 'recording_refused', r->>'status' = 'disclosure_not_delivered',
                            _phone_canary.code(r->>'status'));
  sess := _phone_canary.new_session(cand, t);
  r := screening_v2.start_phone_assessment(att, sess, t);
  perform _phone_canary.chk(s, 'assessment_refused', r->>'status' = 'disclosure_not_delivered',
                            _phone_canary.code(r->>'status'));

  perform _phone_canary.chk(s, 'no_assessment_row',
    (select count(*) from screening_v2.assessments a
      where a.candidate_id = cand and a.source = 'phone') = 0, 'assessments');
  perform _phone_canary.chk(s, 'no_session_plan',
    (select count(*) from screening_v2.phone_session_plans p
      where p.engagement_id = eng) = 0, 'plans');
  perform _phone_canary.chk(s, 'no_session_progress',
    (select count(*) from screening_v2.phone_session_progress p
      where p.session_id = sess) = 0, 'progress');
  perform _phone_canary.chk(s, 'no_recording_bound',
    (select recording_object_key is null and recording_role is null
       from screening_v2.phone_call_attempts where id = att), 'recording');

  perform _phone_canary.cnt(s, 'no_answer_attempts', n);
end;
$$;
do $$ begin perform _phone_canary.teardown('canary0-s2'); end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. refusal_purge_and_suppression
-- ═══════════════════════════════════════════════════════════════════════
-- A refusal at the disclosure is terminal, and the suppression that must
-- accompany it is written in the SAME transaction, keyed on the DIGEST of
-- the line — so the obligation follows the number across applications.
do $$
declare
  s   constant text := 'refusal_purge_and_suppression';
  tag constant text := 'canary0-s3';
  t   constant timestamptz := '2026-11-04T04:30:00Z';
  eng uuid; att uuid; cand uuid; eng2 uuid; r jsonb;
  supp integer; cleared_first integer; cleared_second integer;
begin
  eng := _phone_canary.fixture(tag, '30001');
  select candidate_id into cand from screening_v2.phone_engagements where id = eng;

  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180, t);
  perform _phone_canary.chk(s, 'admission_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'admission_refused');
    return;
  end if;
  att := (r->>'attempt_id')::uuid;

  perform _phone_canary.sip(att, 'sip.participant_joined', t + interval '5 seconds', 1);
  r := _phone_canary.sip(att, 'disclosure.refused', t + interval '15 seconds', 2);
  perform _phone_canary.chk(s, 'refusal_applied', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'engagement_opted_out',
    (select state from screening_v2.phone_engagements where id = eng) = 'opted_out',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  perform _phone_canary.chk(s, 'engagement_terminal_at_set',
    (select terminal_at is not null from screening_v2.phone_engagements where id = eng),
    'terminal_at');
  perform _phone_canary.chk(s, 'attempt_ended_opt_out',
    (select state = 'ended' and outcome_class = 'opt_out'
       from screening_v2.phone_call_attempts where id = att), 'outcome');

  -- EXISTENCE only. The digest is the whole reason this table can hold a
  -- do-not-call obligation without holding a phone number, and printing it
  -- would undo that.
  select count(*) into supp
    from screening_v2.phone_suppressions ps, screening_v2.candidates c
   where c.id = cand
     and ps.phone_sha256 = screening_v2.sha256_hex(c.phone_e164)
     and ps.reason = 'candidate_opt_out';
  perform _phone_canary.chk(s, 'suppression_written_for_the_line', supp = 1, 'suppression');
  perform _phone_canary.chk(s, 'suppression_holds_no_number',
    (select count(*) from screening_v2.phone_suppressions ps, screening_v2.candidates c
      where c.id = cand and ps.candidate_id = cand
        and ps.phone_sha256 ~ '^[a-f0-9]{64}$') = 1, 'digest');

  -- The purge enumeration and the clear both work on a TERMINAL
  -- engagement: the engagement is immutable, its attempts are not.
  r := screening_v2.list_phone_engagement_recordings(eng);
  perform _phone_canary.chk(s, 'recording_enumeration_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  r := screening_v2.clear_phone_attempt_recordings(eng, null, t + interval '1 minute');
  cleared_first := coalesce((r->>'cleared')::integer, -1);
  perform _phone_canary.chk(s, 'recording_clear_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  r := screening_v2.clear_phone_attempt_recordings(eng, null, t + interval '2 minutes');
  cleared_second := coalesce((r->>'cleared')::integer, -1);
  perform _phone_canary.chk(s, 'recording_clear_is_idempotent',
                            r->>'status' = 'ok' and cleared_second = 0,
                            _phone_canary.code(r->>'status'));

  -- The point of digest-keyed suppression: a SECOND application by the
  -- same person, with its own engagement and its own budgets, is refused.
  eng2 := _phone_canary.new_engagement(tag, '-b', cand);
  r := screening_v2.admit_phone_attempt(eng2, 'initial', 'canary0', 180,
                                        t + interval '3 minutes');
  perform _phone_canary.chk(s, 'second_application_suppressed',
                            r->>'status' = 'suppressed',
                            _phone_canary.code(r->>'status'));

  perform _phone_canary.cnt(s, 'suppressions_written', supp);
  perform _phone_canary.cnt(s, 'recordings_cleared_second_call',
                            greatest(cleared_second, 0));
end;
$$;
do $$ begin perform _phone_canary.teardown('canary0-s3'); end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. disconnect_then_reconnect_same_session
-- ═══════════════════════════════════════════════════════════════════════
-- A dropped line is redialled into the SAME session and resumes at the
-- SAME cursor, and the reconnect budget is not silently refilled by the
-- second conversation's own disclosure.
do $$
declare
  s   constant text := 'disconnect_then_reconnect_same_session';
  tag constant text := 'canary0-s4';
  t   constant timestamptz := '2026-11-05T04:30:00Z';
  eng uuid; att uuid; att2 uuid; cand uuid; sess uuid; r jsonb; st jsonb;
  used integer; cur integer; epoch_before integer;
begin
  eng := _phone_canary.fixture(tag, '40001');
  select candidate_id into cand from screening_v2.phone_engagements where id = eng;

  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180, t);
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false,
                              _phone_canary.code(r->>'status'));
    return;
  end if;
  att  := (r->>'attempt_id')::uuid;
  sess := _phone_canary.new_session(cand, t);
  perform _phone_canary.sip(att, 'sip.participant_joined', t + interval '5 seconds', 1);
  perform _phone_canary.sip(att, 'classify.human', t + interval '8 seconds', 2);
  perform _phone_canary.sip(att, 'disclosure.delivered', t + interval '20 seconds', 3);
  r := screening_v2.start_phone_assessment(att, sess, t + interval '25 seconds');
  perform _phone_canary.chk(s, 'first_leg_started', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));

  st := screening_v2.get_phone_assessment_state(sess);
  r := screening_v2.commit_phone_question_boundary(
         sess, st->>'next_key', 0, 'canary0-s4-evt-0',
         jsonb_build_array(
           jsonb_build_object('speaker','bot','text','Asking the first question.'),
           jsonb_build_object('speaker','candidate','text','Answering the first question.')),
         t + interval '40 seconds');
  perform _phone_canary.chk(s, 'first_boundary_committed', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));

  -- ── The line drops, inside the window ──────────────────────────────
  r := _phone_canary.sip(att, 'sip.participant_left', t + interval '60 seconds', 4);
  perform _phone_canary.chk(s, 'disconnect_applied', r->>'status' = 'applied',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'attempt_ended_disconnected',
    (select state = 'ended' and outcome_class = 'disconnected'
       from screening_v2.phone_call_attempts where id = att), 'outcome');
  perform _phone_canary.chk(s, 'engagement_reconnecting',
    (select state from screening_v2.phone_engagements where id = eng) = 'reconnecting',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  select reconnects_used into used from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'reconnect_charged_at_the_grant', used = 1, 'budget');

  -- ── 120 seconds later, the redial ──────────────────────────────────
  r := screening_v2.admit_phone_attempt(eng, 'reconnect', 'canary0', 180,
                                        t + interval '180 seconds');
  perform _phone_canary.chk(s, 'reconnect_admitted', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'reconnect_refused');
    return;
  end if;
  att2 := (r->>'attempt_id')::uuid;
  select epoch into epoch_before from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.sip(att2, 'sip.participant_joined', t + interval '185 seconds', 1);
  perform _phone_canary.sip(att2, 'classify.human', t + interval '188 seconds', 2);
  r := _phone_canary.sip(att2, 'disclosure.delivered', t + interval '200 seconds', 3);
  perform _phone_canary.chk(s, 'second_leg_in_call',
    (select state from screening_v2.phone_engagements where id = eng) = 'in_call',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  perform _phone_canary.chk(s, 'second_leg_epoch_bumped',
    (select epoch from screening_v2.phone_engagements where id = eng) = epoch_before + 1,
    'epoch');

  -- THE budget invariant. Resetting `reconnects_used` on a RECONNECT's
  -- own disclosure would make "max three reconnects" unenforceable: the
  -- counter could never exceed one and the exhaustion edge would be dead
  -- code. On a billable dialer that is the bound that must actually hold.
  select reconnects_used into used from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'reconnect_budget_not_refilled', used = 1, 'budget');

  -- ── The resume ─────────────────────────────────────────────────────
  st := screening_v2.get_phone_assessment_state(sess);
  cur := (st->>'cursor')::integer;
  perform _phone_canary.chk(s, 'same_session_resumed',
    (select session_id from screening_v2.phone_engagements where id = eng) = sess,
    'session');
  perform _phone_canary.chk(s, 'cursor_preserved', cur = 1, 'cursor');
  perform _phone_canary.chk(s, 'one_key_completed',
                            jsonb_array_length(st->'completed_keys') = 1, 'keys');
  perform _phone_canary.chk(s, 'plan_not_complete',
                            (st->>'plan_complete')::boolean is false, 'plan');

  r := screening_v2.start_phone_assessment(att2, sess, t + interval '205 seconds');
  perform _phone_canary.chk(s, 'second_leg_resumes_assessment', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));

  perform _phone_canary.cnt(s, 'reconnects_used', used);
  perform _phone_canary.cnt(s, 'cursor_after_resume', cur);
end;
$$;
do $$ begin perform _phone_canary.teardown('canary0-s4'); end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. three_no_answer_ist_days_then_terminal
-- ═══════════════════════════════════════════════════════════════════════
-- The anti-harassment ladder: at most one cold call per IST day, at most
-- three of them, and then the engagement is over.
do $$
declare
  s    constant text := 'three_no_answer_ist_days_then_terminal';
  tag  constant text := 'canary0-s5';
  tag2 constant text := 'canary0-s5day';
  d1 constant timestamptz := '2026-11-09T04:30:00Z';
  d2 constant timestamptz := '2026-11-10T04:30:00Z';
  d3 constant timestamptz := '2026-11-11T04:30:00Z';
  d4 constant timestamptz := '2026-11-12T04:30:00Z';
  eng uuid; att uuid; r jsonb; n integer;
  engb uuid; attb uuid; candb uuid;
begin
  eng := _phone_canary.fixture(tag, '50001');

  -- Day 1
  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180, d1);
  perform _phone_canary.chk(s, 'day1_admitted', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'day1_refused');
    return;
  end if;
  att := (r->>'attempt_id')::uuid;
  perform _phone_canary.sip(att, 'sip.originate_timeout', d1 + interval '45 seconds', 1);
  select no_answer_attempts into n from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'day1_charged', n = 1, 'budget');
  perform _phone_canary.chk(s, 'day1_awaiting_retry',
    (select state from screening_v2.phone_engagements where id = eng) = 'awaiting_retry',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));

  -- The rolls are driven through the PRODUCTION sweep, not through a bare
  -- `apply_phone_event`. That is not a stylistic choice: the `internal`
  -- source mints a DETERMINISTIC event id, `internal:<eng>:day.rolled:-1`,
  -- which is identical every day, so a hand-posted roll wedges the ladder
  -- after the first one -- every later day answered as a duplicate of the
  -- first. `sweep_phone_day_rolled` scopes the id by IST DATE, which is the
  -- whole reason it exists, so the canary drives the mechanism that will
  -- actually run rather than a hand-rolled substitute for it.
  --
  -- A sweep on the SAME IST day must not advance the ladder. The sweep
  -- pre-applies the edge's own day comparison and so does not even post,
  -- deliberately: posting would burn today's dedup id on a no-op and block
  -- the real roll.
  r := screening_v2.sweep_phone_day_rolled(25, d1 + interval '3 hours');
  perform _phone_canary.chk(s, 'same_day_sweep_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'same_day_roll_left_state_alone',
    (select state from screening_v2.phone_engagements where id = eng) = 'awaiting_retry',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));

  -- Day 2
  r := screening_v2.sweep_phone_day_rolled(25, d2);
  perform _phone_canary.chk(s, 'day2_roll_applied',
                            r->>'status' = 'ok' and (r->>'rolled')::integer >= 1,
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'day2_eligible',
    (select state from screening_v2.phone_engagements where id = eng) = 'eligible',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  r := screening_v2.admit_phone_attempt(eng, 'no_answer_retry', 'canary0', 180, d2);
  perform _phone_canary.chk(s, 'day2_admitted', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  att := (r->>'attempt_id')::uuid;
  perform _phone_canary.sip(att, 'sip.originate_timeout', d2 + interval '45 seconds', 1);
  select no_answer_attempts into n from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'day2_charged', n = 2, 'budget');

  -- Day 3 — the charge that lands on three goes STRAIGHT to terminal.
  perform screening_v2.sweep_phone_day_rolled(25, d3);
  r := screening_v2.admit_phone_attempt(eng, 'no_answer_retry', 'canary0', 180, d3);
  perform _phone_canary.chk(s, 'day3_admitted', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  att := (r->>'attempt_id')::uuid;
  perform _phone_canary.sip(att, 'sip.originate_timeout', d3 + interval '45 seconds', 1);
  select no_answer_attempts into n from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'day3_charged', n = 3, 'budget');
  perform _phone_canary.chk(s, 'ladder_ends_abandoned',
    (select state from screening_v2.phone_engagements where id = eng)
      = 'abandoned_no_answer',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));
  perform _phone_canary.chk(s, 'ladder_reason_is_budget',
    (select state_reason from screening_v2.phone_engagements where id = eng)
      = 'no_answer_budget_exhausted',
    _phone_canary.code((select state_reason from screening_v2.phone_engagements where id = eng)));
  perform _phone_canary.chk(s, 'ladder_terminal_at_set',
    (select terminal_at is not null from screening_v2.phone_engagements where id = eng),
    'terminal_at');

  -- Day 4 — the fourth call never happens.
  r := screening_v2.admit_phone_attempt(eng, 'no_answer_retry', 'canary0', 180, d4);
  perform _phone_canary.chk(s, 'fourth_call_refused', r->>'status' = 'engagement_terminal',
                            _phone_canary.code(r->>'status'));

  -- ── The per-IST-day index, on its own fixture ──────────────────────
  -- Two independent refusals guard the same day. A candidate who picks up
  -- and hangs up before the disclosure is charged NOTHING, and the row is
  -- deferred to the next day's window — so a same-day recall is refused
  -- `not_yet_eligible` first. With the deferral removed, the attempt row's
  -- own `ist_date` still refuses it through the unique index, which is the
  -- bound that holds even if a clock or a caller is wrong.
  perform _phone_canary.teardown(tag2);
  candb := _phone_canary.new_candidate(tag2, '50002');
  engb  := _phone_canary.new_engagement(tag2, '', candb);
  r := screening_v2.admit_phone_attempt(engb, 'initial', 'canary0', 180, d1);
  attb := (r->>'attempt_id')::uuid;
  perform _phone_canary.sip(attb, 'sip.participant_joined', d1 + interval '10 seconds', 1);
  r := _phone_canary.sip(attb, 'sip.participant_left', d1 + interval '15 seconds', 2);
  perform _phone_canary.chk(s, 'pre_disclosure_hangup_charges_nothing',
    (select no_answer_attempts = 0 and reconnects_used = 0 and provider_failures = 0
       from screening_v2.phone_engagements where id = engb), 'budget');
  perform _phone_canary.chk(s, 'pre_disclosure_hangup_returns_eligible',
    (select state from screening_v2.phone_engagements where id = engb) = 'eligible',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = engb)));
  r := screening_v2.admit_phone_attempt(engb, 'initial', 'canary0', 180,
                                        d1 + interval '2 hours');
  perform _phone_canary.chk(s, 'same_day_recall_deferred',
                            r->>'status' = 'not_yet_eligible',
                            _phone_canary.code(r->>'status'));
  -- Construct the precondition the INDEX exists for: eligible now, with a
  -- cold call already recorded against today's IST date.
  update screening_v2.phone_engagements set next_eligible_at = null where id = engb;
  r := screening_v2.admit_phone_attempt(engb, 'initial', 'canary0', 180,
                                        d1 + interval '2 hours');
  perform _phone_canary.chk(s, 'same_day_cold_call_refused_by_index',
                            r->>'status' = 'daily_attempt_exists',
                            _phone_canary.code(r->>'status'));

  perform _phone_canary.cnt(s, 'no_answer_attempts', 3);
  perform _phone_canary.cnt(s, 'ist_days_used', 3);
end;
$$;
do $$ begin
  perform _phone_canary.teardown('canary0-s5');
  perform _phone_canary.teardown('canary0-s5day');
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. appointment_lifecycle
-- ═══════════════════════════════════════════════════════════════════════
do $$
declare
  s    constant text := 'appointment_lifecycle';
  tag  constant text := 'canary0-s6';
  tag2 constant text := 'canary0-s6exp';
  t     constant timestamptz := '2026-11-16T04:30:00Z';               -- 10:00 IST
  slot  constant timestamptz := '2026-11-17T05:30:00Z';               -- 11:00 IST next day
  slot2 constant timestamptz := '2026-11-17T06:30:00Z';               -- 12:00 IST next day
  tag3 constant text := 'canary0-s6bad';
  eng uuid; eng2 uuid; cand2 uuid; eng3 uuid; cand3 uuid; r jsonb; ver integer;
  fulfilled integer := 0; missed integer := 0;
begin
  eng := _phone_canary.fixture(tag, '60001');

  r := screening_v2.schedule_phone_appointment(
         eng, slot, slot + interval '30 minutes', 'hr_manual', null, null, t);
  perform _phone_canary.chk(s, 'appointment_scheduled',
                            r->>'status' in ('ok','ok_prereqs_pending'),
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'engagement_scheduled',
    (select state from screening_v2.phone_engagements where id = eng) = 'scheduled',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng)));

  -- The substrate's optimistic-concurrency mechanism, exercised in the
  -- direction that must refuse: a caller holding a stale version.
  select version into ver from screening_v2.phone_appointments
   where engagement_id = eng and status in ('scheduled','confirmed');
  r := screening_v2.schedule_phone_appointment(
         eng, slot2, slot2 + interval '30 minutes', 'hr_manual', null, ver + 7,
         t + interval '1 minute');
  perform _phone_canary.chk(s, 'stale_version_refused', r->>'status' = 'version_conflict',
                            _phone_canary.code(r->>'status'));

  -- ── Slot shapes that must never book ───────────────────────────────
  -- On their OWN fixture. `appointment_exists` is evaluated before the
  -- shape checks, so running these against an engagement that already
  -- holds a live slot answers every one of them with the same refusal and
  -- proves nothing about the shape at all.
  perform _phone_canary.teardown(tag3);
  cand3 := _phone_canary.new_candidate(tag3, '60003');
  eng3  := _phone_canary.new_engagement(tag3, '', cand3);

  r := screening_v2.schedule_phone_appointment(
         eng3, '2026-11-17T17:00:00Z', '2026-11-17T17:30:00Z', 'hr_manual', null, null, t);
  perform _phone_canary.chk(s, 'slot_outside_window_refused',
                            r->>'status' = 'window_closed',
                            _phone_canary.code(r->>'status'));

  -- A slot that would cross IST midnight cannot book. It is refused by the
  -- WINDOW rather than by the straddle guard, and that is not an accident:
  -- with the window closing at 21:00 IST and the duration capped at one
  -- hour, no bookable slot can reach midnight, so
  -- `slot_straddles_ist_midnight` is unreachable while the window stands.
  -- The safety property still holds -- this asserts the refusal that
  -- actually fires rather than the one the vocabulary advertises, because a
  -- check written against an unreachable status is a check that can never
  -- fail. See the runbook's residual note.
  r := screening_v2.schedule_phone_appointment(
         eng3, '2026-11-17T18:29:00Z', '2026-11-17T18:59:00Z', 'hr_manual', null, null, t);
  perform _phone_canary.chk(s, 'slot_crossing_ist_midnight_cannot_book',
                            r->>'status' = 'window_closed',
                            _phone_canary.code(r->>'status'));

  r := screening_v2.schedule_phone_appointment(
         eng3, slot, slot + interval '5 minutes', 'hr_manual', null, null, t);
  perform _phone_canary.chk(s, 'short_slot_refused', r->>'status' = 'slot_duration_invalid',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'no_slot_booked_by_a_refusal',
    (select count(*) from screening_v2.phone_appointments where engagement_id = eng3) = 0,
    'appointment');

  -- The dial fulfils the slot AT THE DIAL, not at the answer.
  r := screening_v2.admit_phone_attempt(eng, 'scheduled', 'canary0', 180, slot);
  perform _phone_canary.chk(s, 'scheduled_dial_admitted', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  select count(*) into fulfilled from screening_v2.phone_appointments
   where engagement_id = eng and status = 'fulfilled';
  perform _phone_canary.chk(s, 'appointment_fulfilled_at_dial', fulfilled = 1, 'appointment');

  -- ── The slot nobody kept ───────────────────────────────────────────
  perform _phone_canary.teardown(tag2);
  cand2 := _phone_canary.new_candidate(tag2, '60002');
  eng2  := _phone_canary.new_engagement(tag2, '', cand2);
  r := screening_v2.schedule_phone_appointment(
         eng2, slot, slot + interval '30 minutes', 'hr_manual', null, null, t);
  perform _phone_canary.chk(s, 'second_appointment_scheduled',
                            r->>'status' in ('ok','ok_prereqs_pending'),
                            _phone_canary.code(r->>'status'));
  r := screening_v2.expire_phone_appointments(900, 50, slot + interval '2 hours');
  perform _phone_canary.chk(s, 'expiry_sweep_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  select count(*) into missed from screening_v2.phone_appointments
   where engagement_id = eng2 and status = 'missed';
  perform _phone_canary.chk(s, 'appointment_missed', missed = 1, 'appointment');
  perform _phone_canary.chk(s, 'engagement_returned_to_eligible',
    (select state from screening_v2.phone_engagements where id = eng2) = 'eligible',
    _phone_canary.code((select state from screening_v2.phone_engagements where id = eng2)));
  perform _phone_canary.chk(s, 'missed_reason_recorded',
    (select state_reason from screening_v2.phone_engagements where id = eng2)
      = 'appointment_missed',
    _phone_canary.code((select state_reason from screening_v2.phone_engagements where id = eng2)));

  perform _phone_canary.cnt(s, 'appointments_fulfilled', fulfilled);
  perform _phone_canary.cnt(s, 'appointments_missed', missed);
end;
$$;
do $$ begin
  perform _phone_canary.teardown('canary0-s6');
  perform _phone_canary.teardown('canary0-s6exp');
  perform _phone_canary.teardown('canary0-s6bad');
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. halt_admission_fail_closed
-- ═══════════════════════════════════════════════════════════════════════
-- The kill switch, single-session. The concurrent race belongs to the Node
-- runner; what is proved here is that an unreadable switch STOPS the lane
-- rather than being read as permission — the deliberate inverse of the
-- recording lane, because the thing on the other side of this gate is a
-- telephone call to a person.
--
-- The singleton is deleted and restored inside ONE transaction, so an
-- abort rolls the deletion back with everything else. There is no window
-- in which a crash could leave the control row missing.
do $$
declare
  s    constant text := 'halt_admission_fail_closed';
  tag  constant text := 'canary0-s7';
  tag2 constant text := 'canary0-s7b';
  t   constant timestamptz := '2026-11-18T04:30:00Z';
  eng uuid; eng2 uuid; cand2 uuid; r jsonb; bl jsonb; refusals integer := 0;
  saved screening_v2.phone_control%rowtype;
begin
  eng := _phone_canary.fixture(tag, '70001');
  -- A SECOND, untouched engagement for the unreadable-switch probe. The
  -- first one is `dialing` by the time that probe runs, and an admission
  -- refused `state_not_admissible` would never reach the kill switch at
  -- all -- a check that passes through the wrong gate proves nothing about
  -- the gate it names.
  perform _phone_canary.teardown(tag2);
  cand2 := _phone_canary.new_candidate(tag2, '70002');
  eng2  := _phone_canary.new_engagement(tag2, '', cand2);

  r := screening_v2.set_phone_halt('operator_pause', null, t);
  perform _phone_canary.chk(s, 'halt_raised', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'halt_was_not_already_up',
                            (r->>'already_halted')::boolean is false, 'halt');

  -- A second halt does not overwrite the first. That is precisely why
  -- clearing has to NAME the reason in force: the reason on the row is
  -- the one the first operator gave, not the last.
  r := screening_v2.set_phone_halt('cost_control', null, t + interval '1 minute');
  perform _phone_canary.chk(s, 'second_halt_is_a_noop',
                            (r->>'already_halted')::boolean is true, 'halt');
  perform _phone_canary.chk(s, 'original_halt_reason_preserved',
    (select halt_reason from screening_v2.phone_control where control_key = 'default')
      = 'operator_pause',
    _phone_canary.code((select halt_reason from screening_v2.phone_control
                         where control_key = 'default')));

  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180,
                                        t + interval '2 minutes');
  perform _phone_canary.chk(s, 'admission_refused_while_halted', r->>'status' = 'halted',
                            _phone_canary.code(r->>'status'));
  if r->>'status' = 'halted' then refusals := refusals + 1; end if;

  r := screening_v2.clear_phone_halt(null, t + interval '3 minutes');
  perform _phone_canary.chk(s, 'halt_cleared', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'clear_reports_it_was_halted',
                            (r->>'was_halted')::boolean is true, 'halt');
  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180,
                                        t + interval '4 minutes');
  perform _phone_canary.chk(s, 'admission_resumes_after_clear', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));

  -- ── The unreadable switch ──────────────────────────────────────────
  select * into saved from screening_v2.phone_control where control_key = 'default';
  delete from screening_v2.phone_control where control_key = 'default';

  r := screening_v2.admit_phone_attempt(eng2, 'initial', 'canary0', 180,
                                        t + interval '5 minutes');
  perform _phone_canary.chk(s, 'missing_control_stops_admission',
                            r->>'status' = 'halt_unreadable',
                            _phone_canary.code(r->>'status'));
  bl := screening_v2.phone_backlog(t + interval '5 minutes');
  perform _phone_canary.chk(s, 'backlog_reports_halted',
                            (bl->'admission'->>'halted')::boolean is true, 'backlog');
  perform _phone_canary.chk(s, 'backlog_names_the_unreadable_switch',
                            bl->'admission'->>'halt_reason' = 'halt_unreadable',
                            _phone_canary.code(bl->'admission'->>'halt_reason'));
  r := screening_v2.clear_phone_halt(null, t + interval '6 minutes');
  perform _phone_canary.chk(s, 'clear_refuses_to_invent_a_cleared_row',
                            r->>'status' = 'halt_unreadable',
                            _phone_canary.code(r->>'status'));

  insert into screening_v2.phone_control
    (control_key, halted_at, halt_reason, halt_actor_id, updated_at)
  values (saved.control_key, saved.halted_at, saved.halt_reason,
          saved.halt_actor_id, saved.updated_at);
  perform _phone_canary.chk(s, 'control_singleton_restored',
    (select count(*) from screening_v2.phone_control where control_key = 'default') = 1
      and (select halted_at is null from screening_v2.phone_control
            where control_key = 'default'),
    'control');

  perform _phone_canary.cnt(s, 'halt_refusals', refusals);
end;
$$;
do $$ begin
  perform _phone_canary.teardown('canary0-s7');
  perform _phone_canary.teardown('canary0-s7b');
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. attempt_lease_heartbeat_and_reclaim
-- ═══════════════════════════════════════════════════════════════════════
-- The fleet-slot lease outlives its original window only because somebody
-- beats it, and when nobody does, the reclaim charges the candidate
-- nothing — a dead worker is our failure, not their attempt.
do $$
declare
  s   constant text := 'attempt_lease_heartbeat_and_reclaim';
  tag constant text := 'canary0-s8';
  t   constant timestamptz := '2026-11-19T04:30:00Z';
  eng uuid; att uuid; cand uuid; sess uuid; r jsonb;
  ep integer; lease_end timestamptz; renewed timestamptz;
  na integer; rc integer; pf integer;
  na2 integer; rc2 integer; pf2 integer;
  reclaimed integer;
begin
  eng := _phone_canary.fixture(tag, '80001');
  select candidate_id into cand from screening_v2.phone_engagements where id = eng;

  r := screening_v2.admit_phone_attempt(eng, 'initial', 'canary0', 180, t);
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false,
                              _phone_canary.code(r->>'status'));
    return;
  end if;
  att  := (r->>'attempt_id')::uuid;
  sess := _phone_canary.new_session(cand, t);
  select lease_expires_at into lease_end
    from screening_v2.phone_call_attempts where id = att;

  perform _phone_canary.sip(att, 'sip.participant_joined', t + interval '5 seconds', 1);
  perform _phone_canary.sip(att, 'classify.human', t + interval '8 seconds', 2);
  perform _phone_canary.sip(att, 'disclosure.delivered', t + interval '20 seconds', 3);
  r := screening_v2.start_phone_assessment(att, sess, t + interval '25 seconds');
  perform _phone_canary.chk(s, 'session_bound_for_heartbeat', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  select epoch into ep from screening_v2.phone_call_attempts where id = att;

  -- ── The beat that carries the lease past its original end ──────────
  r := screening_v2.heartbeat_phone_attempt_by_epoch(att, ep, sess, 180,
                                                     t + interval '170 seconds');
  perform _phone_canary.chk(s, 'heartbeat_ok', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  select lease_expires_at into renewed
    from screening_v2.phone_call_attempts where id = att;
  perform _phone_canary.chk(s, 'lease_extended_beyond_original_window',
                            renewed > lease_end, 'lease');

  -- THE FENCE, in both directions. The agent beats with the DISPATCH
  -- epoch, which `disclosure.delivered` has already left BEHIND — so a
  -- strictly-equal fence answered `lease_lost` to the first beat of every
  -- consented call and hung up on the candidate. `>=` is the fix, and the
  -- cross-leg fence is the attempt id, which the equality never carried.
  r := screening_v2.heartbeat_phone_attempt_by_epoch(att, ep - 1, sess, 180,
                                                     t + interval '175 seconds');
  perform _phone_canary.chk(s, 'stale_dispatch_epoch_still_beats', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  r := screening_v2.heartbeat_phone_attempt_by_epoch(att, ep + 1, sess, 180,
                                                     t + interval '176 seconds');
  perform _phone_canary.chk(s, 'future_epoch_is_refused', r->>'status' = 'lease_lost',
                            _phone_canary.code(r->>'status'));

  -- ── Nobody beats it again ──────────────────────────────────────────
  select no_answer_attempts, reconnects_used, provider_failures
    into na, rc, pf from screening_v2.phone_engagements where id = eng;
  r := screening_v2.reclaim_phone_attempt_leases(50, t + interval '600 seconds');
  reclaimed := coalesce((r->>'reclaimed')::integer, 0);
  perform _phone_canary.chk(s, 'reclaim_ran', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  perform _phone_canary.chk(s, 'lapsed_lease_reclaimed', reclaimed >= 1, 'reclaim');
  perform _phone_canary.chk(s, 'attempt_abandoned_without_outcome',
    (select state = 'abandoned' and outcome_class is null
       from screening_v2.phone_call_attempts where id = att), 'attempt');
  perform _phone_canary.chk(s, 'lease_released',
    (select lease_token is null and lease_owner is null
       from screening_v2.phone_call_attempts where id = att), 'lease');
  perform _phone_canary.chk(s, 'engagement_restored_to_prior_state',
    (select e.state from screening_v2.phone_engagements e where e.id = eng)
      = (select a.prior_engagement_state from screening_v2.phone_call_attempts a
          where a.id = att),
    _phone_canary.code((select e.state from screening_v2.phone_engagements e where e.id = eng)));

  select no_answer_attempts, reconnects_used, provider_failures
    into na2, rc2, pf2 from screening_v2.phone_engagements where id = eng;
  perform _phone_canary.chk(s, 'reclaim_charges_no_budget',
                            na2 = na and rc2 = rc and pf2 = pf, 'budget');

  r := screening_v2.heartbeat_phone_attempt_by_epoch(att, ep, sess, 180,
                                                     t + interval '610 seconds');
  perform _phone_canary.chk(s, 'heartbeat_after_reclaim_is_lost',
                            r->>'status' = 'lease_lost',
                            _phone_canary.code(r->>'status'));

  perform _phone_canary.cnt(s, 'reclaimed', reclaimed);
end;
$$;
do $$ begin perform _phone_canary.teardown('canary0-s8'); end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. cross_engagement_candidate_guard
-- ═══════════════════════════════════════════════════════════════════════
-- Every 0042 index is keyed by ENGAGEMENT and a person is not. One
-- candidate applying to two roles has two engagements with two independent
-- budgets — and one telephone. These two guards live inside admission,
-- under a per-candidate advisory lock, because the cross-pass and
-- cross-replica halves cannot be closed anywhere else.
do $$
declare
  s   constant text := 'cross_engagement_candidate_guard';
  tag constant text := 'canary0-s9';
  d1 constant timestamptz := '2026-11-23T04:30:00Z';
  d2 constant timestamptz := '2026-11-24T04:30:00Z';
  cand uuid; eng1 uuid; eng2 uuid; att1 uuid; r jsonb;
  guard_a integer := 0; guard_b integer := 0;
begin
  perform _phone_canary.teardown(tag);
  cand := _phone_canary.new_candidate(tag, '90001');
  eng1 := _phone_canary.new_engagement(tag, '-a', cand);
  eng2 := _phone_canary.new_engagement(tag, '-b', cand);

  r := screening_v2.admit_phone_attempt(eng1, 'initial', 'canary0', 180, d1);
  perform _phone_canary.chk(s, 'first_engagement_admitted', r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));
  if r->>'status' <> 'ok' then
    perform _phone_canary.chk(s, 'scenario_aborted', false, 'first_admission_refused');
    return;
  end if;
  att1 := (r->>'attempt_id')::uuid;

  -- GUARD A — nobody is on the phone with this person right now.
  r := screening_v2.admit_phone_attempt(eng2, 'initial', 'canary0', 180,
                                        d1 + interval '1 second');
  perform _phone_canary.chk(s, 'guard_a_call_in_flight',
                            r->>'status' = 'candidate_call_in_flight',
                            _phone_canary.code(r->>'status'));
  if r->>'status' = 'candidate_call_in_flight' then guard_a := guard_a + 1; end if;

  -- End the first leg so no lease is live, and the guard that remains is
  -- the DAY one rather than the concurrency one.
  perform _phone_canary.sip(att1, 'sip.originate_timeout', d1 + interval '45 seconds', 1);
  perform _phone_canary.chk(s, 'first_leg_ended',
    (select state = 'ended' from screening_v2.phone_call_attempts where id = att1),
    'attempt');

  -- GUARD B — this person has already been cold-called today, on some
  -- other application. `scheduled` is excluded from the guard's kind
  -- filter on purpose: a booked slot is not a cold call.
  r := screening_v2.admit_phone_attempt(eng2, 'initial', 'canary0', 180,
                                        d1 + interval '2 hours');
  perform _phone_canary.chk(s, 'guard_b_daily_attempt_exists',
                            r->>'status' = 'candidate_daily_attempt_exists',
                            _phone_canary.code(r->>'status'));
  if r->>'status' = 'candidate_daily_attempt_exists' then guard_b := guard_b + 1; end if;

  -- A PACE, NOT A LATCH. The day supplies the reset lifecycle, which is
  -- exactly what a gating counter would have lacked.
  r := screening_v2.admit_phone_attempt(eng2, 'initial', 'canary0', 180, d2);
  perform _phone_canary.chk(s, 'guard_b_releases_on_the_next_ist_day',
                            r->>'status' = 'ok',
                            _phone_canary.code(r->>'status'));

  perform _phone_canary.cnt(s, 'guard_a_refusals', guard_a);
  perform _phone_canary.cnt(s, 'guard_b_refusals', guard_b);
end;
$$;
do $$ begin perform _phone_canary.teardown('canary0-s9'); end $$;

-- ═══════════════════════════════════════════════════════════════════════
--  Emit — the only thing that reaches stdout
-- ═══════════════════════════════════════════════════════════════════════
\o

select 'CANARY|' || scenario || '|' || check_name || '|'
       || case when ok then 'PASS' else 'FAIL' end || '|' || code
  from _phone_canary.verdict order by ord;

select 'CANARYCOUNT|' || scenario || '|' || key || '|' || value::text
  from _phone_canary.metric order by ord;

select 'CANARYDONE|' || count(distinct scenario)::text from _phone_canary.verdict;

-- Nothing is dropped here. The runner still has the tenth scenario to
-- drive through `_phone_canary.fixture` / `_phone_canary.teardown`, and
-- `teardown.sql` is what finally removes the substrate.
