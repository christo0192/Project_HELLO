-- =====================================================================
-- 0109 — a candidate who hangs up is not a worker crash.
--
-- WHY THIS EXISTS
-- ---------------
-- `finalize_phone_partial_sessions` labels the disconnect that ended a partial
-- screening, and that label rides into the scorecard's provenance and into
-- every operator view of why a call ended. It had three tokens and one of them
-- was being applied to the wrong population:
--
--   * `candidate_hangup` — the attempt ended with outcome `disconnected`;
--   * `worker_crash`     — the attempt is `abandoned`, or its lease expired in
--                          a live state with no terminal outcome;
--   * `disconnected`     — anything else.
--
-- The worker deliberately posts NO terminal when the participant disconnects:
-- it preserves the room for re-dispatch, because the 2026-08-29 X2 incident
-- proved that tearing it down kills calls whose SIP participant is still
-- active. The cost of that correct decision is that an ordinary hangup looks
-- exactly like a dead worker — the attempt simply sits until its lease expires
-- and reclaim marks it `abandoned` with a null outcome.
--
-- Proven on 2026-09-27: an owner test hung up at question 2 and the resulting
-- assessment recorded `disconnect_reason: "worker_crash"`. Nobody crashed.
--
-- THE DISCRIMINATOR
-- -----------------
-- A worker that crashed cannot have finalized its own recording. The teardown
-- uploads the object, verifies it, and marks the egress `complete`; a killed
-- process leaves it `active`. So an `abandoned` attempt carrying a READY
-- recording and a COMPLETE egress ended because the far end went away, and is
-- now labelled `candidate_hangup`. Everything else is untouched: a genuine
-- crash still reads `worker_crash`, and the `disconnected` fallback is
-- unchanged.
--
-- This changes a LABEL only. No state transition, no admission decision, and
-- no scoring behaviour depends on it — `assessment-handler.ts` passes it
-- through to the assessment record for humans to read.
--
-- Forward-only `create or replace`; the signature is byte-identical to 0095,
-- so there is no overload and PostgREST keeps resolving one candidate.
-- =====================================================================

create or replace function screening_v2.finalize_phone_partial_sessions(
  p_limit         integer     default 25,
  p_grace_seconds integer     default 180,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit    integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_grace    integer := greatest(30, least(coalesce(p_grace_seconds, 180), 7200));
  v_row      record;
  v_att      screening_v2.phone_call_attempts%rowtype;
  v_updated  integer;
  v_examined integer := 0;
  v_finalized integer := 0;
  v_skipped  integer := 0;
  v_total    integer;
  v_reason   text;
  v_has_assessment boolean;
  v_never_started  boolean;
  v_recording_present boolean;
  v_sessions jsonb := '[]'::jsonb;
begin
  for v_row in
    select s.id as session_id,
           s.current_question_index as covered,
           s.recording_object_key,
           a.id            as attempt_id,
           -- 0095: reported so an operator reading the sweep's output can tie
           -- a finalized session to its engagement without a second query.
           -- Nothing ACTS on it — the draft that posted an engagement event
           -- from the caller is gone with edge #31.
           a.engagement_id as engagement_id,
           a.state         as attempt_state,
           a.outcome_class as attempt_outcome,
           -- 0109: the attempt's OWN recording finalization. A worker that
           -- crashed cannot have finished its upload, so these two columns
           -- separate "the far end hung up" from "our process died" without
           -- needing a new signal from the worker.
           a.egress_status as attempt_egress_status,
           a.recording_ready as attempt_recording_ready,
           a.ended_at      as attempt_ended_at,
           a.lease_expires_at
      from screening_v2.call_sessions s
      -- The LATEST attempt on this session decides whether the call is over.
      -- A session is adopted across a no-answer ladder, so join the newest by
      -- admitted_at rather than any row.
      join lateral (
        select att.*
          from screening_v2.phone_call_attempts att
         where att.session_id = s.id
         order by att.admitted_at desc
         limit 1
      ) a on true
     where s.mode = 'live'
       and s.started_at is not null
       -- Idempotency + no-re-score, in one predicate: a session that already
       -- carries a phone assessment is NEVER re-selected. This self-terminates
       -- the sweep for a scored session and makes a redundant enqueue
       -- impossible from the SQL side (belt to the dedup-key braces).
       and not exists (
         select 1 from screening_v2.assessments a2
          where a2.session_id = s.id and a2.source = 'phone'
       )
       -- The session must be ENDABLE-but-unscored. Either it is still
       -- `in_progress` (hangup / network drop / crash before 0071's reclaim),
       -- or it is the crash residue 0071 already terminalized to
       -- `expired`/`grace_timeout` (MP3 finalized, scoring never enqueued).
       and (
         s.status = 'in_progress'
         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout')
       )
       -- The call is genuinely over, not merely briefly quiet: the attempt is
       -- terminal with an ended_at, OR its lease lapsed in a live state (crash
       -- before reclaim), OR it is `abandoned` (reclaim's crash terminal) with
       -- an ended_at/lease past. In EVERY case the deciding instant must be
       -- older than the grace so a live leg that touched a moment ago is never
       -- taken.
       and (
         (a.state in ('ended','human','machine')
            and a.ended_at is not null
            and a.ended_at <= p_now - (v_grace * interval '1 second'))
         or
         (a.lease_expires_at is not null
            and a.lease_expires_at <= p_now - (v_grace * interval '1 second')
            and a.state in ('admitted','ringing','answered_unclassified','human','machine'))
         or
         (a.state = 'abandoned'
            and coalesce(a.ended_at, a.lease_expires_at) is not null
            and coalesce(a.ended_at, a.lease_expires_at)
                  <= p_now - (v_grace * interval '1 second'))
       )
     order by s.started_at asc
     limit v_limit
     for update of s skip locked
  loop
    v_examined := v_examined + 1;

    -- Coverage: the cursor is the count of questions covered; the plan's
    -- question_count is the total. A session with no plan row yet (should not
    -- happen for a screening that started, but must not abort the sweep)
    -- reports total=null and is still scored.
    select p.question_count into v_total
      from screening_v2.phone_session_plans p
     where p.session_id = v_row.session_id;

    -- disconnect_reason (no PII, one of three fixed tokens):
    --   * 'candidate_hangup' — the attempt ended with outcome 'disconnected'
    --     (the deliberate-hangup path);
    --   * 'worker_crash' — the residue 0071's reclaim produced: the attempt is
    --     `abandoned` (reclaim nulls its outcome_class) or its lease expired in
    --     a live state without a terminal outcome. This is the mode where the
    --     session is already `expired`/`grace_timeout` (or was, before this
    --     sweep saw it) and the MP3 was finalized by reclaim, not by us;
    --   * 'disconnected' — any other genuine end (e.g. an `ended` attempt with
    --     a non-'disconnected' outcome).
    v_reason := case
      when v_row.attempt_outcome = 'disconnected' then 'candidate_hangup'
      -- 0109: A WORKER THAT CRASHED CANNOT HAVE FINALIZED ITS OWN RECORDING.
      --
      -- The arm below classifies every `abandoned` attempt as `worker_crash`,
      -- because reclaim nulls `outcome_class` and nothing else was left to
      -- read. But `abandoned` is also what reclaim writes when a candidate
      -- simply HANGS UP mid-interview: the worker deliberately posts no
      -- terminal on a participant disconnect (it preserves the room for
      -- re-dispatch — the 2026-08-29 X2 incident proved that deleting it kills
      -- live calls), so the attempt sits until its lease expires and reclaim
      -- marks it abandoned. The 2026-09-27 owner test is the evidence: a
      -- deliberate hangup at Q2 was recorded as `worker_crash`.
      --
      -- That is not cosmetic. `worker_crash` is the signal an operator uses to
      -- decide whether the FLEET is broken, and every ordinary hangup was
      -- inflating it. The discriminator costs nothing: the worker's teardown
      -- uploads the object and marks the egress complete, so a verified
      -- recording is proof the process ran to the end.
      when v_row.attempt_state = 'abandoned'
       and coalesce(v_row.attempt_recording_ready, false)
       and v_row.attempt_egress_status = 'complete'
        then 'candidate_hangup'
      when v_row.attempt_state = 'abandoned'
        or (v_row.lease_expires_at is not null
            and v_row.attempt_state in
                ('admitted','ringing','answered_unclassified','human','machine'))
        then 'worker_crash'
      else 'disconnected'
    end;

    -- ── 0095 / issue #286: DID A SCREENING ACTUALLY HAPPEN? ───────────
    -- The sweep already knew — it selects `covered` and reads the plan's
    -- `question_count` — and used neither to decide the terminal state, so
    -- "crashed after eight answers" and "hung up before asking anything"
    -- both landed on `completed` / `conversation_complete`.
    --
    -- The test is DIRECT evidence, not a coverage threshold: did the
    -- CANDIDATE ever say anything outside the gate?
    --
    -- Gate turns (identity, consent) are excluded because they are exactly
    -- what a never-started call DOES have. And the speaker filter is
    -- load-bearing: `commit_phone_item_turn` (0071:179) writes BOTH 'bot'
    -- and 'candidate' turns with is_gate = false, so testing for any
    -- non-gate turn would count the bot ASKING question one as evidence the
    -- candidate answered it. A call that died the instant Q1 was asked would
    -- then be a completed screening — the precise defect this migration
    -- exists to remove, reintroduced one turn later.
    --
    -- Keyed on the candidate it is also the SAFE direction for scoring: if
    -- the candidate contributed no non-gate turn there is, by construction,
    -- nothing to score, so skipping the enqueue can never cost a real
    -- scorecard. Any candidate answer at all — even one — takes the
    -- `completed` branch and scores exactly as it did before 0095.
    select not exists (
      select 1 from screening_v2.transcript_turns t
       where t.session_id = v_row.session_id
         and t.is_gate = false
         and t.speaker = 'candidate'
    ) into v_never_started;

    -- Already-present signals — reported, never gating. The caller's dedup key
    -- makes a redundant enqueue a no-op; the recording flag is for the log.
    select exists (
      select 1 from screening_v2.assessments a
       where a.session_id = v_row.session_id and a.source = 'phone'
    ) into v_has_assessment;
    v_recording_present := v_row.recording_object_key is not null;

    -- Drive the session terminal, RE-VERIFYING under the lock that it is still
    -- in_progress (the unlocked-ish scan may have raced a live completion).
    -- The SAME transition the worker's happy path uses: completed /
    -- conversation_complete. It fires trg_enqueue_recording_finalize (0038) in
    -- THIS transaction and makes the session eligible for scoring. A row that
    -- is no longer in_progress is left untouched — this covers BOTH the
    -- idempotent re-run (a session already completed) AND the worker-crash
    -- residue this sweep also selects (`expired`/`grace_timeout`, MP3 already
    -- finalized by 0071's reclaim): re-transitioning `expired -> completed` is
    -- not a legal 0006 edge, so we deliberately leave it terminal and report
    -- `transitioned=false`. Its scoring is still owed and still returned below.
    -- ── THE SESSION TRANSITION IS UNCHANGED BY 0095 ───────────────────
    --
    -- An earlier draft drove a never-started session to `failed` /
    -- `screening_never_started`. Three reviews and the repo's own
    -- `phone_partial_finalize_assert.sql` all rejected it, and they were
    -- right. `never_started` is now REPORTED and never acted on here.
    --
    -- Why the status must not move:
    --   * THE SWEEP STARVES ITSELF. The selection admits
    --     `expired`/`grace_timeout` as well as `in_progress`, but this UPDATE
    --     is guarded `status = 'in_progress'`, so that arm is never
    --     re-stamped. It leaves the set only once an assessment row exists.
    --     Skipping the scoring enqueue for these sessions meant no row was
    --     ever written, so they were re-selected for ever — and with
    --     `limit 25` and `order by started_at asc`, 25 of them displace every
    --     REAL partial screening from the window. Those lose both the
    --     scorecard and the terminal transition that drives the MP3.
    --   * THE MP3 LOSES A RECOVERY PATH. The 0038 trigger and the sweeper do
    --     treat `failed` like `completed`, but the download route's
    --     on-demand finalize backstop is `status = 'completed'` only.
    --   * SCORING CHANGES FOR A CLASS THAT HAD IT. The crash-partial pair
    --     (`expired` + `grace_timeout`) is admitted by the eligibility gate,
    --     so such a session was scored before; withholding the enqueue takes
    --     that away without touching the gate, which is what made the change
    --     invisible.
    --   * THE EVIDENCE IS NOT SAFE TO ACT ON. The per-item transcript writer
    --     is fire-and-forget (`agent.py`, `asyncio.create_task`, never
    --     awaited, failures swallowed) and the boundary writer SUPPRESSES its
    --     own insert when any per-item row exists (0086). If the bot's write
    --     lands and the candidate's does not, a real screening reads as
    --     never-started. Good enough to REPORT; not good enough to withhold a
    --     scorecard or redirect a call on.
    --
    -- So the transition below is byte-for-byte what 0072 shipped: the SAME
    -- transition the worker's happy path uses. MP3 and scorecard generation
    -- are therefore untouched by this migration, which is the owner's
    -- explicit constraint.
    update screening_v2.call_sessions s
       set status          = 'completed',
           terminal_reason = 'conversation_complete',
           ended_at        = coalesce(s.ended_at, p_now),
           updated_at      = p_now
     where s.id = v_row.session_id
       and s.status = 'in_progress';
    get diagnostics v_updated = row_count;
    if v_updated = 1 then
      v_finalized := v_finalized + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    -- The selection is returned WHETHER OR NOT the transition landed on this
    -- pass, so the caller enqueues scoring independently of the transition.
    v_sessions := v_sessions || jsonb_build_object(
      'session_id',         v_row.session_id,
      'attempt_id',         v_row.attempt_id,
      'engagement_id',      v_row.engagement_id,
      'covered',            v_row.covered,
      'total',              v_total,
      'disconnect_reason',  v_reason,
      -- The caller reads this to decide whether to enqueue scoring at all.
      -- A never-started session has no non-gate turns; enqueuing it would DLQ
      -- against the eligibility guard and look like a scoring failure rather
      -- than a call that never happened.
      'never_started',      v_never_started,
      'transitioned',       v_updated = 1,
      'assessment_present', v_has_assessment,
      'recording_present',  v_recording_present);

    v_total := null;
  end loop;

  return jsonb_build_object(
    'status',        'ok',
    'examined',      v_examined,
    'finalized',     v_finalized,
    'skipped',       v_skipped,
    'limit',         v_limit,
    'grace_seconds', v_grace,
    'sessions',      v_sessions);
end;
$$;

notify pgrst, 'reload schema';
