-- 0072 — server-side partial-finalize on a non-terminal-ending phone call.
--
-- FORWARD-ONLY and ADDITIVE. It adds ONE column to `assessments`
-- (`partial boolean not null default false`) and adds ONE new sweeper RPC
-- (`finalize_phone_partial_sessions`). It drops no table, retypes nothing,
-- rewrites no existing function body, and touches no other migration. The new
-- function is service-role-only. No candidate data (no phone number, no
-- transcript text, no name) appears anywhere here.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────
-- A candidate hangup / network drop / worker crash returns the voice worker's
-- `disconnect` branch, which is DELIBERATELY non-terminal (the session must be
-- able to survive a re-dispatch window). So `call_sessions` stays
-- `status='in_progress'` FOREVER, and the two existing safety nets do not
-- deliver a screening result:
--
--   * 0038's recording-finalize trigger fires ONLY on a terminal `status`, so
--     no MP3 is finalized.
--   * 0071's `sweep_phone_stranded_recordings` matches the stuck shape but
--     (a) waits ~7200s and (b) drives to `expired`/`grace_timeout` and NEVER
--     enqueues scoring — so the SCORECARD is never produced at all.
--
-- The owner's hard requirement is that on EVERY non-terminal-ending phone
-- session BOTH the MP3 and the scorecard must ALWAYS come through, guaranteed
-- INDEPENDENTLY. This migration is the SQL half: it selects the ended-but-not-
-- terminal sessions past a SHORT reconnect grace and drives each to a terminal
-- `completed`/`conversation_complete` — the SAME transition the worker's own
-- happy path uses (phone-worker.ts `completeSession`). That:
--
--   1. Fires 0038's `trg_enqueue_recording_finalize` in THIS transaction, so
--      the attempt MP3 is promoted to the session exactly as a clean hangup
--      would have promoted it.
--   2. Satisfies `runAssessment`'s eligibility preflight (which requires
--      `status='completed'` AND `terminal_reason='conversation_complete'`), so
--      the queued partial scoring the TS tick enqueues can succeed.
--
-- Scoring itself is NOT done here — it reads `transcript_turns` and calls the
-- LLM, which is a durable QUEUE job the runtime tick enqueues per returned
-- session. This RPC only SELECTS the eligible sessions, drives the transition,
-- and RETURNS the coverage/attempt facts the tick needs to enqueue. Returning
-- the full selection (not only the rows it transitioned) is what lets the tick
-- enqueue scoring INDEPENDENTLY of whether the transition landed on this pass.
--
-- ── DISTINCT FROM 0071 ────────────────────────────────────────────────
-- 0071 selects on the RECORDING shape (active egress, null object key) and
-- drives to `expired`. This selects on the SESSION being ended (its attempt is
-- terminal/dead) REGARDLESS of egress state — because the scorecard must land
-- even when egress never started or produced nothing — and drives to
-- `completed` so scoring is owed. The shorter grace (default 180s, always far
-- below 0071's 7200s) makes this WIN the race for a genuinely-ended call, and
-- the `status='in_progress'` guard on the UPDATE makes it a no-op the moment
-- any other path has already terminalized the session.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. assessments.partial — the partial-screening flag
-- ═══════════════════════════════════════════════════════════════════════
-- The coverage detail (`covered`/`total`) and the `disconnect_reason` live in
-- `assessments.raw` (already jsonb) so no further columns are needed; this one
-- boolean is a first-class column so a recruiter query can filter partials
-- without unpacking JSON. Defaulted false, so every existing row and every
-- clean browser/phone assessment is unaffected.
alter table screening_v2.assessments
  add column if not exists partial boolean not null default false;

comment on column screening_v2.assessments.partial is
  'True when this assessment scored a PARTIAL transcript because the phone '
  'call ended before the plan completed (candidate hangup, network drop or '
  'worker crash). The covered/total coverage and the disconnect_reason live '
  'in `raw`. Defaults false: every clean screening is unaffected.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. finalize_phone_partial_sessions — the partial-finalize selector/driver
-- ═══════════════════════════════════════════════════════════════════════
-- Selects phone sessions that ended non-terminally past a SHORT reconnect
-- grace, drives each to `completed`/`conversation_complete` (firing the 0038
-- finalize trigger and the attempt-MP3 promotion in THIS transaction), and
-- RETURNS the coverage/attempt facts for each SELECTED session so the caller
-- can enqueue partial scoring independently.
--
-- A session qualifies when ALL hold:
--   * `mode='live'`, `status='in_progress'`, `started_at` present (never
--     reached a terminal status).
--   * its LATEST attempt is genuinely over — EITHER terminal
--     (`state in ('ended','human','machine')` with `ended_at` set) OR its
--     lease has expired (the crash case, mirroring 0071's reclaim cursor) —
--     and that terminal/expiry instant is older than the grace.
--
-- Selection is on SESSION-ENDED, never on egress state: the scorecard must be
-- delivered even if egress never started or produced nothing. If egress did
-- produce nothing, 0038's finalize job defers `object_absent` (existing
-- behaviour) and the scorecard still lands — the two are independent.
--
-- Idempotent and self-limiting: a session already terminal is skipped by the
-- `status='in_progress'` guard on the UPDATE, a session already carrying a
-- phone assessment is reported `assessment_present=true` (the caller's dedup
-- key then makes the enqueue a no-op), and `for update skip locked` means a
-- concurrent live completion is never blocked. Safe to run every tick until
-- both the MP3 and the assessment exist.
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
  v_recording_present boolean;
  v_sessions jsonb := '[]'::jsonb;
begin
  for v_row in
    select s.id as session_id,
           s.current_question_index as covered,
           s.recording_object_key,
           a.id            as attempt_id,
           a.state         as attempt_state,
           a.outcome_class as attempt_outcome,
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
       and s.status = 'in_progress'
       and s.started_at is not null
       -- The call is genuinely over, not merely briefly quiet: either the
       -- attempt is terminal with an ended_at, or its lease has lapsed (the
       -- crash case). In BOTH cases the deciding instant must be older than
       -- the grace so a live leg that touched a moment ago is never taken.
       and (
         (a.state in ('ended','human','machine')
            and a.ended_at is not null
            and a.ended_at <= p_now - (v_grace * interval '1 second'))
         or
         (a.lease_expires_at is not null
            and a.lease_expires_at <= p_now - (v_grace * interval '1 second')
            and a.state in ('admitted','ringing','answered_unclassified','human','machine'))
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

    -- disconnect_reason: a candidate hangup is the attempt outcome
    -- 'disconnected'; anything else is a generic 'disconnected' bucket. No PII.
    v_reason := case
      when v_row.attempt_outcome = 'disconnected' then 'candidate_hangup'
      else 'disconnected'
    end;

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
    -- is no longer in_progress is left untouched — this is the idempotent
    -- re-run guard, not a failure.
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
      'covered',            v_row.covered,
      'total',              v_total,
      'disconnect_reason',  v_reason,
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

revoke all on function screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.finalize_phone_partial_sessions is
  'Partial-finalize sweeper (0072): finds phone sessions left in_progress '
  'whose call is genuinely over (latest attempt terminal or lease-expired) '
  'past a short reconnect grace, drives each to completed/conversation_complete '
  'so the 0038 finalize trigger promotes the attempt MP3, and returns the '
  'coverage/attempt facts so the caller can enqueue PARTIAL scoring '
  'independently. Selection is on session-ended, not egress state, so the '
  'scorecard lands even when egress produced nothing. Idempotent and '
  'self-limiting; charges no budget. Service-role-only.';
