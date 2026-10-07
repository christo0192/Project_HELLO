-- R1 candidate-route primitives (PR-3). Additive and backward compatible: one
-- column on the R1-owned interview_rounds table (with a trigger that locks it
-- once the round has a consent record), one partial index and three
-- SECURITY DEFINER functions over R1-owned tables only. No shared table is
-- altered and no existing function is replaced; the phone lane, the legacy
-- browser lane and `r1_admit_attempt` are untouched.
set local lock_timeout = '10s';

-- Which consent notice a round is shown (PR-CT audience contract, 0123).
--
-- 0123 ships two notices at ONE version so admission honours both: the candidate
-- notice (en-IN) and the staff dry-run notice (en-IN-x-staff). Admission cannot
-- tell the audiences apart, and the staff notice says no hiring decision is made
-- about the person, so the audience must be owned by the server and never chosen
-- by the client. It lives here, on the round: the candidate routes read it to pick
-- the template and never accept a locale. The default is the candidate notice, so
-- a round nobody marked can only ever show the stricter wording. It is set by
-- service_role only (the Send R1 path, or an operator for a staff dry run); the
-- candidate routes never write it. Constant default and a two-value check on a
-- table that is empty until R1 ships: no rewrite, no long lock.
alter table screening_v2.interview_rounds
  add column if not exists consent_locale text not null default 'en-IN'
  constraint chk_interview_rounds_consent_locale
  check (consent_locale in ('en-IN', 'en-IN-x-staff'));

-- The audience is fixed once the round has a consent record or has left `invited`.
--
-- Staff dry runs are marked by an operator with plain SQL, so a wrong mark is a
-- realistic mistake. Without this guard the repair (setting the round back to
-- en-IN) would leave the consent the person gave to the STAFF notice ("no hiring
-- decision is made about you") standing: `r1_admit_attempt` cannot tell the two
-- notices apart, so the interview would run and its AI evaluation could change the
-- application status of someone who was told it would not. A wrong mark is fixed
-- BEFORE the person opens the link (no consent row yet, round still `invited`),
-- or by cancelling the round and sending a new one. The check is on the value
-- changing, so a no-op write of the same locale is never refused. SECURITY
-- DEFINER so the consent lookup is not hidden from the writer by row level
-- security: a guard that cannot see the row would pass.
create or replace function screening_v2.reject_interview_round_audience_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
begin
  if new.consent_locale is distinct from old.consent_locale
     and (
       old.status <> 'invited'
       or exists (
         select 1 from screening_v2.interview_round_consents c where c.round_id = old.id
       )
     ) then
    raise exception 'interview_rounds.consent_locale of round % cannot change once it has a consent record or has left invited',
      old.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger trg_interview_rounds_audience_locked
  before update of consent_locale on screening_v2.interview_rounds
  for each row execute function screening_v2.reject_interview_round_audience_change();

-- Preflight cap lookups: "how many preflights has this link used, and how many
-- in the last minute" (plan 3.3 savers: at most 10 per link, 3 per minute).
create index if not exists idx_r1_usage_ledger_round_preflight
  on screening_v2.r1_usage_ledger (round_id, occurred_at)
  where participant_kind = 'preflight';

-- Reserve one A/V preflight for a link, atomically.
--
-- The caps live here, not in the API, because count-then-insert from two API
-- requests (or two API machines) would let a burst overshoot. The round row is
-- the per-link mutex: every caller serializes on it, so the count each caller
-- reads already includes every earlier reservation. Lock order: this function
-- takes ONLY the round row, so it cannot deadlock against the capacity writers
-- (settings -> month -> round).
--
-- A reservation is a ledger row of 10 s (`seconds` is capped at 15 for
-- preflight by chk_r1_usage_event_bounds), which is also what the minutes
-- estimate charges per preflight.
create or replace function screening_v2.r1_reserve_preflight(
  p_round_id uuid,
  p_event_key text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_round screening_v2.interview_rounds%rowtype;
  v_total integer;
  v_recent integer;
begin
  if p_event_key is null or p_event_key !~ '^[A-Za-z0-9:_-]{1,128}$' then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  select * into v_round from screening_v2.interview_rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('status', 'round_not_found');
  end if;
  if v_round.status not in ('invited', 'in_progress') or v_round.expires_at <= p_now then
    return jsonb_build_object('status', 'round_not_admissible');
  end if;

  select count(*) into v_total
    from screening_v2.r1_usage_ledger l
   where l.round_id = p_round_id and l.participant_kind = 'preflight';
  if v_total >= 10 then
    return jsonb_build_object('status', 'preflight_limit');
  end if;

  select count(*) into v_recent
    from screening_v2.r1_usage_ledger l
   where l.round_id = p_round_id
     and l.participant_kind = 'preflight'
     and l.occurred_at > p_now - interval '1 minute';
  if v_recent >= 3 then
    return jsonb_build_object('status', 'preflight_rate_limited');
  end if;

  insert into screening_v2.r1_usage_ledger
    (session_id, round_id, participant_kind, event, seconds, event_key, occurred_at)
  values
    (null, p_round_id, 'preflight', 'usage', 10, p_event_key, p_now);

  return jsonb_build_object('status', 'ok', 'remaining', 9 - v_total);
end;
$$;

-- Record a worker-reported attempt outcome and apply plan decision D1.
--
-- An attempt COUNTS (increments interview_rounds.attempts_counted) once it
-- reached TRANSITION: `complete` always, and `candidate_left` or
-- `residency_timeout` only when a transcript turn already carries a phase from
-- TRANSITION onward. No-shows, exits before TRANSITION and system failures
-- (provider_error, shutdown_forced, configuration_failed, context_failed)
-- never count. The decision and the increment are one transaction, so a retry
-- can neither double-count nor lose a count.
--
-- A counted attempt also CLOSES the round (`status = 'completed'`), in the same
-- statement as the count. The round then answers `round_not_admissible` to
-- r1_admit_attempt, so a second interview cannot start before the first one is
-- scored (D1: the retake is automatic only when attempt 1 has no valid gated
-- score, otherwise HR grants it), and it is the state r1_transition_round's
-- `grant-retake` requires. PR-5 reopens it (`completed` -> `invited`) for the
-- automatic retake. A round HR already cancelled or that already expired keeps
-- its status; only the count is recorded.
--
-- The outcome is only accepted for a SETTLED session: a browser session of this
-- very round that is already terminal (completed, failed, cancelled, expired),
-- and `complete` only for a `completed` one. The worker posts an outcome even
-- when its terminal write failed, and WORKER_CONTEXT_SECRET is shared with the
-- phone worker; counting an attempt whose session is still live, or "complete"
-- for a session that failed, would close the round with no score to read and no
-- retake HR could grant. `session_not_settled` changes nothing, so a later,
-- correct post (or PR-5's sweep) can still settle the attempt.
--
-- Idempotent: the first outcome wins. The same outcome again is a `duplicate`
-- (whatever the session state is by then); a different one is
-- `outcome_conflict` and changes nothing.
--
-- Not done here, deliberately: an UNCOUNTED outcome does not give the 55 minutes
-- that admission moved into `r1_budget_month.minutes_used` back to the link's
-- hold (plan 5.11: "the hold is kept for the link"). Restoring it needs the
-- settings -> month -> round lock order (this function takes only round ->
-- attempt) and a way for the round to be expired afterwards (r1_sweep_expired_
-- rounds only expires `invited` rounds), so it belongs to PR-5's r1.sweep, which
-- owns round lifecycle. Until then every uncounted restart charges the month
-- once more; the API refuses to admit while DeepSeek is unhealthy so the common
-- outage case does not burn starts.
--
-- Lock order: round, then attempt (the session is only read: a terminal session
-- is immutable). Settlement takes neither settings nor the budget month, so it
-- cannot deadlock against admission (settings -> month -> round).
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
  end if;

  return jsonb_build_object('status', 'ok', 'counted', v_counted);
end;
$$;

-- Withdraw a round's consent and report the sessions that must be stopped.
--
-- The round row is locked first, which serializes withdrawal against
-- `r1_admit_attempt`: either admission commits before this runs (the session
-- it created is returned below and the API stops it) or it runs after and
-- finds no live consent. A withdrawal can therefore never race past an
-- admission and leave a live interview behind. Idempotent: with no live
-- consent it changes nothing and still returns the live sessions.
--
-- `p_decision` is what the stored decision becomes: `withdrawn` (the default; the
-- candidate took a granted consent back) or `declined` (the candidate refused
-- the notice after granting it; PR-7 reads `proof.decision = 'declined'` to flag
-- the HR card).
--
-- The grant's own proof (captured_at, template_version, locale, ip_prefix,
-- user_agent) is DPDP consent evidence of who agreed, to what, and from where,
-- so it is never overwritten. Only the decision marker and the withdrawal time
-- are written over it, and the withdrawal request's own context (`p_proof`: IP
-- prefix, user agent) is nested under `proof.withdrawal`. The decision and the
-- timestamp are set by this function, so a caller cannot override them.
create or replace function screening_v2.r1_withdraw_consent(
  p_round_id uuid,
  p_proof jsonb default '{}'::jsonb,
  p_now timestamptz default now(),
  p_decision text default 'withdrawn'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_withdrawn integer;
  v_sessions jsonb;
begin
  if p_decision is null or p_decision not in ('withdrawn', 'declined') then
    return jsonb_build_object('status', 'invalid_decision');
  end if;

  perform 1 from screening_v2.interview_rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('status', 'round_not_found');
  end if;

  update screening_v2.interview_round_consents
     set withdrawn_at = p_now,
         proof = coalesce(proof, '{}'::jsonb)
           || jsonb_build_object(
                'decision', p_decision,
                'withdrawn_at', p_now,
                'withdrawal', coalesce(p_proof, '{}'::jsonb)
              )
   where round_id = p_round_id and withdrawn_at is null;
  get diagnostics v_withdrawn = row_count;

  select coalesce(
           jsonb_agg(jsonb_build_object('session_id', s.id, 'status', s.status)),
           '[]'::jsonb
         )
    into v_sessions
    from screening_v2.call_sessions s
   where s.interview_round_id = p_round_id
     and s.status in ('created', 'waiting', 'in_progress');

  return jsonb_build_object('status', 'ok', 'withdrawn', v_withdrawn, 'live_sessions', v_sessions);
end;
$$;

revoke all on function screening_v2.r1_reserve_preflight(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function screening_v2.r1_settle_attempt(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function screening_v2.r1_withdraw_consent(uuid, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_reserve_preflight(uuid, text, timestamptz)
  to service_role;
grant execute on function screening_v2.r1_settle_attempt(uuid, text, timestamptz)
  to service_role;
grant execute on function screening_v2.r1_withdraw_consent(uuid, jsonb, timestamptz, text)
  to service_role;
