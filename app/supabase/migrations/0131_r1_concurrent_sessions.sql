-- R1 concurrent sessions (M019, PR #378): let up to 25 R1 browser interviews run at the same time.
--
-- SHIPS INERT. The new limit defaults to 1, so admission is exactly 0128's until an operator raises
-- it, and the Cloud target (livekit_target = 'cloud') keeps 0128's rule whatever the setting says.
--
--   1. r1_settings.max_concurrent_sessions (integer, default 1, CHECK 1..25): the most live R1
--      sessions the self-hosted target ('r1') admits at once.
--
--   2. r1_admit_attempt: 0128 verbatim (its latest definition; 0129 and 0130 do not touch it)
--      except three marked hunks (`-- ▼ 0131 <id>` ... `-- ▲ 0131 <id>`) and the one 0128 line
--      the gate hunk replaces, `if v_live_r1>=1 then return ... 'r1_in_flight' ...`:
--        concurrent-declare  two locals, v_pool and v_limit.
--        concurrent-limit    the limit, then the same-round check, both before the live count.
--        concurrent-gate     the live count is compared with v_limit instead of 1.
--      On target 'r1' the limit is least(max_concurrent_sessions, greatest(P, 1)), where P is the
--      browser worker pool: every voice_worker_leases row of app project-hello-voice (the API's
--      BROWSER_FLY_APP) and pipeline browser, whatever its state. A machine runs one session
--      (0079), so admission never lets in more live sessions than there are machines, and a
--      deployment with no registered pool (P = 0) keeps one slot. On target 'cloud' the limit is 1
--      and the live-phone check under it is unchanged.
--      Above a limit of 1, a round that already has a live session (a second tab opened without
--      the rejoin nonce) is refused as round_live, before uq_call_sessions_interview_round_live
--      (0116) would fail the INSERT with a unique violation. At a limit of 1 the live count refuses
--      that admission first as r1_in_flight, exactly as 0128 did, so round_live cannot appear until
--      the limit is raised.
--      The count still runs under the settings-row lock that every admission takes first, so
--      racing admissions cannot overshoot the limit. Capacity is unchanged: the 65-minute charge
--      and the live floor are per session, and r1_capacity_snapshot already sums them.
--
--   3. retire_voice_worker(app, machine_id): deletes a pool machine's lease row, and only while it
--      is `stopped`, never a claimed one, so the pool can shrink. Without it a destroyed machine
--      whose stopped row stayed would still be handed out by claim_voice_worker.
--
-- Raising the limit above 1 needs more than this migration (docs/runbooks/r1-operations.md):
-- per-machine browser agent names (PR-C2; with the shared name a session's job can land on another
-- session's machine, which is then stopped mid-interview), a provisioned pool, and the SFU, API and
-- provider sizing.
--
-- The settings audit trigger (0115) is not changed. Like the columns 0119, 0122 and 0127 added, the
-- new setting is carried by the settings route's own audit (routes/r1.ts, the recording_mode
-- precedent), not by the trigger.
--
-- Additive: nothing is re-priced, so unlike 0128 this may run while an R1 session is live.
-- Forward-only. CREATE OR REPLACE keeps the ACLs; they are restated at the end.
set local lock_timeout = '10s';

-- 1. The setting. NOT NULL with a constant default is a metadata-only change, and the singleton row
-- reads 1: 0128's single slot.
alter table screening_v2.r1_settings
  add column if not exists max_concurrent_sessions integer not null default 1
    constraint chk_r1_settings_max_concurrent_sessions check (max_concurrent_sessions between 1 and 25);
comment on column screening_v2.r1_settings.max_concurrent_sessions is
  'The most live R1 sessions the self-hosted target admits at once (1..25, default 1), capped by '
  'the browser worker pool size (0131). The Cloud target admits one whatever this says.';

-- 2. Admission. 0128 verbatim except the marked 0131 hunks and the one line concurrent-gate replaces.
create or replace function screening_v2.r1_admit_attempt(p_round_id uuid,p_nonce_digest text,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare
  v_round screening_v2.interview_rounds%rowtype; v_settings screening_v2.r1_settings%rowtype;
  v_month date:=date_trunc('month',p_now)::date; v_hold_month date; v_charge_month date; v_existing_hold numeric;
  v_attempt integer; v_persona text; v_session uuid:=gen_random_uuid();
  v_live_r1 integer; v_live_phone integer; v_restart boolean; v_fresh_charge boolean;
  -- ▼ 0131 concurrent-declare
  v_pool integer; v_limit integer;
  -- ▲ 0131 concurrent-declare
begin
  if p_nonce_digest is null or p_nonce_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status','invalid_nonce'); end if;
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found or not v_settings.enabled then return jsonb_build_object('status','disabled'); end if;
  if v_settings.paused then return jsonb_build_object('status','paused'); end if;
  -- Determine the immutable originating month before the budget/round locks.
  -- A retake creates its charge at admission, so its origin is now.
  select held_minutes, hold_month into v_existing_hold, v_hold_month from screening_v2.interview_rounds where id=p_round_id;
  if not found then return jsonb_build_object('status','round_not_found'); end if;
  if v_existing_hold = 0 then v_hold_month:=v_month;
  elsif v_hold_month is null then return jsonb_build_object('status','hold_month_missing'); end if;
  insert into screening_v2.r1_budget_month(month_start) values(v_hold_month) on conflict do nothing;
  perform 1 from screening_v2.r1_budget_month where month_start=v_hold_month for update;
  select * into v_round from screening_v2.interview_rounds where id=p_round_id for update;
  if not found then return jsonb_build_object('status','round_not_found'); end if;
  if v_round.status not in ('invited','in_progress') then return jsonb_build_object('status','round_not_admissible'); end if;
  if v_round.expires_at<=p_now then return jsonb_build_object('status','round_expired'); end if;
  if v_round.starts_used>=3 then return jsonb_build_object('status','starts_exhausted'); end if;
  if v_round.attempts_counted>=v_round.attempts_allowed then return jsonb_build_object('status','attempts_exhausted'); end if;
  if not exists(select 1 from screening_v2.roles r where r.id=v_round.role_id and r.interview_kind=v_round.kind) then return jsonb_build_object('status','r1_role_invalid'); end if;
  if not exists(select 1 from screening_v2.interview_round_consents c join screening_v2.interview_round_consent_templates t on t.id=c.template_id where c.round_id=v_round.id and c.withdrawn_at is null and c.granted_at<=p_now and t.is_active and t.version=(select max(x.version) from screening_v2.interview_round_consent_templates x where x.is_active) and t.required_consents <@ c.consents) then return jsonb_build_object('status','consent_missing'); end if;
  -- ▼ 0131 concurrent-limit
  -- The live R1 limit. Self-hosted: max_concurrent_sessions, never more than the browser worker
  -- pool has machines (one session per machine, 0079) and never less than 1, so a deployment with
  -- no registered pool keeps 0128's single slot. Cloud: 1 whatever the setting (its agent sessions
  -- are shared with phone; the live-phone check below is unchanged).
  if v_settings.livekit_target='r1' then
    select count(*) into v_pool from screening_v2.voice_worker_leases l where l.app='project-hello-voice' and l.pipeline='browser';
    v_limit:=least(coalesce(v_settings.max_concurrent_sessions,1),greatest(v_pool,1));
  else
    v_limit:=1;
  end if;
  -- Above 1, a round that already has a live session (a second tab without the rejoin nonce) is
  -- refused here, before uq_call_sessions_interview_round_live (0116) fails the INSERT below. At 1
  -- the live count refuses it first as r1_in_flight, exactly as 0128 did.
  if v_limit>1 and exists(select 1 from screening_v2.call_sessions s where s.interview_round_id=v_round.id and s.status in ('created','waiting','in_progress')) then return jsonb_build_object('status','round_live'); end if;
  -- ▲ 0131 concurrent-limit
  select count(*) into v_live_r1 from screening_v2.call_sessions s where s.interview_round_id is not null and s.status in ('created','waiting','in_progress');
  -- ▼ 0131 concurrent-gate
  if v_live_r1>=v_limit then return jsonb_build_object('status','r1_in_flight'); end if;
  -- ▲ 0131 concurrent-gate
  if v_settings.livekit_target='cloud' then
    select count(*) into v_live_phone from screening_v2.phone_call_attempts p where p.state in ('admitted','ringing','answered_unclassified','human','machine') and p.lease_expires_at>p_now;
    if v_live_phone>=4 then return jsonb_build_object('status','cloud_capacity_exhausted'); end if;
  end if;
  v_attempt:=v_round.attempts_counted+1;
  -- The marker, not the attempt rows, says whether this attempt number is charged.
  v_restart:=v_round.held_minutes=0 and v_round.charged_attempt_number>=v_attempt;
  v_fresh_charge:=v_round.held_minutes=0 and not v_restart;
  -- A hold or an uncounted charge belongs to the month that booked it; a fresh
  -- charge belongs to this one. So a link Sent in one month and started in the
  -- next converts a charge that is ALREADY in the Send month's minutes_used: the
  -- later month's allocation check adds no booked 65 for it (p_extra_used 0), and
  -- while the session is live it is absorbed by that month's greatest(booked,
  -- estimate). Mode A's allocation can therefore be exceeded by one session per
  -- link that straddles a month end, a bounded policy overshoot (links Sent in the
  -- last 72 hours of a month); the total across months is unchanged. The runbook
  -- states this, and the suite pins it.
  v_charge_month:=case when v_fresh_charge then v_month else coalesce(v_round.hold_month,v_month) end;
  if coalesce((screening_v2.r1_capacity_snapshot(p_now,
       case when v_fresh_charge then 0 else -65 end,
       case when v_charge_month=v_month then 65 else 0 end,
       65)->>'admits')::boolean, false) is not true then return jsonb_build_object('status','capacity_exhausted'); end if;
  if v_round.held_minutes>0 then
    update screening_v2.r1_budget_month set minutes_reserved=greatest(0,minutes_reserved-v_round.held_minutes),minutes_used=minutes_used+v_round.held_minutes,starts_admitted=starts_admitted+1,updated_at=p_now where month_start=v_hold_month;
    update screening_v2.interview_rounds set held_minutes=0 where id=v_round.id;
  elsif v_fresh_charge then
    update screening_v2.r1_budget_month set minutes_used=minutes_used+65,starts_admitted=starts_admitted+1,updated_at=p_now where month_start=v_hold_month;
  end if;
  select a.persona_id into v_persona from screening_v2.interview_round_attempts a where a.round_id=v_round.id and a.attempt_number=v_attempt and not a.counted order by a.created_at desc limit 1;
  if v_persona is null then select p.persona_id into v_persona from unnest(array['p1_career_switcher','p2_recent_grad','p3_data_analyst','p4_research_scholar']) p(persona_id) where not exists(select 1 from screening_v2.interview_round_attempts prior where prior.round_id=v_round.id and prior.counted and prior.persona_id=p.persona_id) order by random() limit 1; end if;
  insert into screening_v2.call_sessions(id,candidate_id,role_id,mode,provider,external_call_id,status,interview_round_id,owner_id) values(v_session,v_round.candidate_id,v_round.role_id,'browser','livekit','screening-'||v_session::text,'created',v_round.id,v_round.created_by);
  insert into screening_v2.interview_round_attempts(session_id,round_id,attempt_number,persona_id,nonce_digest) values(v_session,v_round.id,v_attempt,v_persona,p_nonce_digest);
  update screening_v2.interview_rounds set starts_used=starts_used+1,status='in_progress',version=version+1,charged_attempt_number=greatest(charged_attempt_number,v_attempt),hold_month=case when v_fresh_charge then v_hold_month else hold_month end,updated_at=p_now where id=v_round.id;
  return jsonb_build_object('status','ok','session_id',v_session,'attempt_number',v_attempt,'persona_id',v_persona);
end;
$$;

-- 3. Pool shrink. Deletes ONE lease row, and only a `stopped` one: a claimed row (starting, ready,
-- busy, draining) is never removed, so a live session can never lose its machine's lease. The
-- DELETE re-checks the state under the row lock, so a claim that wins the race keeps the row
-- (not_stopped). Retire the row BEFORE destroying the stopped Fly machine: once the row is gone no
-- claim can hand that machine out. Returns {status: retired | not_stopped (+ state) |
-- unknown_machine | invalid_request}. Service-role only.
create or replace function screening_v2.retire_voice_worker(
  p_app        text,
  p_machine_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_state text;
begin
  if p_app is null or p_machine_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  delete from screening_v2.voice_worker_leases
   where app = p_app
     and machine_id = p_machine_id
     and state = 'stopped';
  if found then
    return jsonb_build_object('status', 'retired', 'machine_id', p_machine_id);
  end if;

  select state into v_state
    from screening_v2.voice_worker_leases
   where app = p_app
     and machine_id = p_machine_id;
  if not found then
    return jsonb_build_object('status', 'unknown_machine');
  end if;
  return jsonb_build_object(
    'status', 'not_stopped', 'machine_id', p_machine_id, 'state', v_state);
end;
$$;

comment on function screening_v2.retire_voice_worker(text, text) is
  'Delete a pool machine''s lease row, only while it is stopped (0131). Returns '
  '{status:retired}, {status:not_stopped,state}, {status:unknown_machine} or '
  '{status:invalid_request}. Service-role only.';

revoke all on function screening_v2.r1_admit_attempt(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_admit_attempt(uuid,text,timestamptz) to service_role;
revoke all on function screening_v2.retire_voice_worker(text, text)
  from public, anon, authenticated;
grant execute on function screening_v2.retire_voice_worker(text, text)
  to service_role;
notify pgrst, 'reload schema';
