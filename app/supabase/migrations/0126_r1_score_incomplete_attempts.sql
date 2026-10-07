-- R1 smoke readiness (PR-B): a COUNTED attempt that did not complete is scored, and HR can
-- retake it. Two function re-declarations, nothing else: no table, column, index, trigger or
-- constraint changes, and the capacity model is untouched.
--
--   1. r1_settle_attempt (0120 verbatim + one enqueue). r1_settle_attempt counts a
--      candidate_left or residency_timeout attempt once TRANSITION began (plan D1) and closes
--      the round, but only a COMPLETED session ever enqueued r1.assessment (the 0116 trigger), so
--      such an attempt was counted, the round showed "Completed" and no scorecard ever existed.
--      It now enqueues the same job, in the same transaction, for a counted attempt whose
--      session ended `failed` while the round still holds a live consent. The scorer
--      (services/r1-assessment.ts) accepts exactly that session and the gate can never pass it
--      (session_not_completed), so HR gets a real scorecard and a human_review recommendation.
--
--   2. r1_transition_round (0119 verbatim except grant-retake). Grant retake required the
--      counted attempt's session to be `completed`; a counted failed attempt (the same rounds)
--      could therefore never be retaken although HR's button was offered. It now requires
--      exactly one counted attempt, whatever the session's terminal status.
--
-- CREATE OR REPLACE keeps the functions' ACLs; they are restated so the contract is local.
-- Forward-only and idempotent: re-applying the same text is a no-op.
set local lock_timeout = '10s';

-- 1. r1_settle_attempt: see the header. The decision rules, locking order, idempotency and the
-- session-must-be-settled guard are 0120's, unchanged; the only addition is the enqueue marked (0126).
create or replace function screening_v2.r1_settle_attempt(
  p_session_id uuid,
  p_outcome text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_round_id uuid;
  v_round screening_v2.interview_rounds%rowtype;
  v_attempt screening_v2.interview_round_attempts%rowtype;
  v_session_status text;
  v_session_mode text;
  v_session_round uuid;
  v_counted boolean := false;
begin
  if p_outcome is null or p_outcome not in (
    'complete', 'candidate_left', 'no_show', 'provider_error',
    'residency_timeout', 'shutdown_forced', 'configuration_failed', 'context_failed'
  ) then
    return jsonb_build_object('status', 'invalid_outcome');
  end if;

  select a.round_id into v_round_id
    from screening_v2.interview_round_attempts a
   where a.session_id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'attempt_not_found');
  end if;

  select * into v_round from screening_v2.interview_rounds where id = v_round_id for update;
  select * into v_attempt
    from screening_v2.interview_round_attempts
   where session_id = p_session_id
     for update;

  if v_attempt.outcome is not null then
    if v_attempt.outcome = p_outcome then
      return jsonb_build_object('status', 'duplicate', 'counted', v_attempt.counted);
    end if;
    return jsonb_build_object('status', 'outcome_conflict');
  end if;

  select s.status, s.mode, s.interview_round_id
    into v_session_status, v_session_mode, v_session_round
    from screening_v2.call_sessions s
   where s.id = p_session_id;
  if not found
     or v_session_mode is distinct from 'browser'
     or v_session_round is distinct from v_attempt.round_id
     or v_session_status not in ('completed', 'failed', 'cancelled', 'expired')
     or (p_outcome = 'complete' and v_session_status <> 'completed') then
    return jsonb_build_object('status', 'session_not_settled');
  end if;

  v_counted := p_outcome = 'complete'
    or (
      p_outcome in ('candidate_left', 'residency_timeout')
      and exists (
        select 1
          from screening_v2.transcript_turns t
         where t.session_id = p_session_id
           and t.phase in ('transition', 'roleplay', 'aside', 'roleplay_exit', 'wrapup', 'closing')
      )
    );
  -- chk_interview_rounds_attempts: the count can never pass what was allowed.
  if v_counted and v_round.attempts_counted >= v_round.attempts_allowed then
    v_counted := false;
  end if;

  update screening_v2.interview_round_attempts
     set outcome = p_outcome, counted = v_counted
   where session_id = p_session_id;
  if v_counted then
    update screening_v2.interview_rounds
       set attempts_counted = attempts_counted + 1,
           status = case
             when status in ('invited', 'in_progress') then 'completed'
             else status
           end,
           version = version + 1,
           updated_at = p_now
     where id = v_round_id;
    -- (0126) A counted attempt whose session ended `failed` (the candidate left, the role-play
    -- silence ladder ran out, or the residency cap hit) is scored too. The 0116 trigger enqueues
    -- r1.assessment only when a session COMPLETES, so before this the attempt was counted, the
    -- round closed, and nothing was ever scored. Same queue name, dedup key and attempts as the
    -- trigger, in this very transaction, and only on the FIRST settlement (a replay returns
    -- `duplicate` above). A round whose consent was withdrawn is never scored: a withdrawal stops
    -- all processing of the interview, and that is exactly how a mid-role-play exit usually looks.
    if v_session_status = 'failed'
       and exists (
         select 1
           from screening_v2.interview_round_consents c
          where c.round_id = v_attempt.round_id
            and c.withdrawn_at is null
       ) then
      insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
      values ('r1.assessment', jsonb_build_object('session_id', p_session_id),
              'r1.assessment:' || p_session_id::text, 5)
      on conflict do nothing;
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'counted', v_counted);
end;
$$;

-- 2. r1_transition_round: see the header. Cancel, expire, reissue and the lock order
-- (settings -> hold month -> round) are 0119's, unchanged; the only change is the grant-retake count (0126).
create or replace function screening_v2.r1_transition_round(p_round_id uuid,p_action text,p_expected_version integer,p_link_token_digest text default null,p_expires_at timestamptz default null,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_settings screening_v2.r1_settings%rowtype; v screening_v2.interview_rounds%rowtype;
  v_hold_minutes numeric; v_hold_month date; v_uncounted boolean;
begin
 -- This includes cancel and expiry, which release capacity.  Do not take the
 -- round lock first: admission takes settings -> budget -> round.
 select * into v_settings from screening_v2.r1_settings where singleton for update;
 select held_minutes, hold_month, charged_attempt_number > attempts_counted into v_hold_minutes, v_hold_month, v_uncounted
   from screening_v2.interview_rounds where id=p_round_id;
 if not found then return jsonb_build_object('status','version_conflict'); end if;
 if v_hold_minutes > 0 then
   if v_hold_month is null then return jsonb_build_object('status','hold_month_missing'); end if;
   perform 1 from screening_v2.r1_budget_month where month_start=v_hold_month for update;
   if not found then return jsonb_build_object('status','hold_month_missing'); end if;
 elsif v_uncounted and v_hold_month is not null then
   perform 1 from screening_v2.r1_budget_month where month_start=v_hold_month for update;
 end if;
 select * into v from screening_v2.interview_rounds where id=p_round_id for update;
 if not found or v.version <> p_expected_version then return jsonb_build_object('status','version_conflict'); end if;
 if p_action in ('cancel','expire') then
   if v.status in ('completed','expired','cancelled') then return jsonb_build_object('status','round_terminal'); end if;
   update screening_v2.interview_rounds set status=case when p_action='cancel' then 'cancelled' else 'expired' end,version=version+1,updated_at=p_now where id=v.id;
   if v.held_minutes > 0 then
     update screening_v2.r1_budget_month set minutes_reserved=greatest(0,minutes_reserved-v.held_minutes),updated_at=p_now where month_start=v.hold_month;
     update screening_v2.interview_rounds set held_minutes=0,updated_at=p_now where id=v.id;
   else
     perform screening_v2.r1_refund_uncounted_charge(v.id, p_now);
   end if;
   return jsonb_build_object('status','ok');
 end if;
 if p_action='reissue' then
   if v.status <> 'invited' or p_link_token_digest is null or p_expires_at <= p_now then return jsonb_build_object('status','round_terminal'); end if;
   -- A lapsed link's hold stopped counting before any sweep; reviving it adds 55 back.
   if v.held_minutes > 0 and v.expires_at <= p_now
      and coalesce((screening_v2.r1_capacity_snapshot(p_now, 55)->>'admits')::boolean, false) is not true then
     return jsonb_build_object('status','capacity_exhausted');
   end if;
   update screening_v2.interview_rounds set link_token_digest=p_link_token_digest,expires_at=p_expires_at,version=version+1,updated_at=p_now where id=v.id; return jsonb_build_object('status','ok');
 end if;
 if p_action='grant-retake' then
   -- A manual retake is only a final first attempt.  We require a completed round
   -- with exactly one COUNTED attempt; until score status is available this is intentionally
   -- the conservative gate rather than treating an active/invited row as final.
   -- (0126) The counted attempt's session no longer has to be `completed`. r1_settle_attempt
   -- counts a candidate_left or residency_timeout attempt that reached TRANSITION, its session
   -- ends `failed`, and the round closes with it; requiring a completed session answered
   -- retake_not_allowed for exactly the rounds that most need one, while HR's Grant retake
   -- button (which checks only the round status and the counts) was still offered.
   if v.status <> 'completed' or v.attempts_counted <> 1 or v.attempts_allowed <= 1
      or (select count(*) from screening_v2.interview_round_attempts a where a.round_id=v.id and a.counted) <> 1 then return jsonb_build_object('status','retake_not_allowed'); end if;
   update screening_v2.interview_rounds set status='invited',expires_at=p_expires_at,version=version+1,updated_at=p_now where id=v.id; return jsonb_build_object('status','ok');
 end if;
 return jsonb_build_object('status','invalid_action');
end;
$$;

revoke all on function screening_v2.r1_settle_attempt(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_settle_attempt(uuid, text, timestamptz)
  to service_role;
revoke all on function screening_v2.r1_transition_round(uuid, text, integer, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_transition_round(uuid, text, integer, text, timestamptz, timestamptz)
  to service_role;
notify pgrst, 'reload schema';
