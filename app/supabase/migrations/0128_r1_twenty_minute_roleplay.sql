-- R1 20-minute role-play (owner decision 2026-10-16). The role-play grows from 14:00 to 20:00 of
-- role-play time, so an interview now runs about 28-30 minutes (normal path S <= 28:27, forced close
-- S = 30:00) and the worker's residency backstop rises from 1800 s to 2160 s
-- (R1_SESSION_MAX_RESIDENCY_SEC). Two things in the database were sized for the 22-minute session:
--
--   1. The usage-ledger bound. A candidate/agent ledger row may report at most 1830 s (residency
--      1800 + the closing line and drain). It becomes 2190 s (residency 2160 + 30): the CHECK
--      chk_r1_usage_event_bounds and r1_record_usage's own refusal move together, and the API's
--      R1_USAGE_MAX_SECONDS (routes/r1.ts) mirrors it.
--
--   2. The admission hold. A Send reserved 55 participant-minutes (plan 3.1: ~45 typical / 55
--      planning for a 22-minute, two-participant session). A ~28-30 minute session is ~57-60
--      typical and ~70 worst, so the hold becomes 65 (owner decision). The 55 was a literal in
--      every capacity writer; each body below is the latest definition (0119, or 0126 for
--      r1_transition_round) VERBATIM except that literal 55 -> 65, so the 0119 capacity rule is
--      otherwise unchanged:
--        v_webrtc_minutes_estimate   the live-unmetered floor greatest(65, minutes)
--        r1_capacity_snapshot        c_hold (uncounted charges kept for the link)
--        r1_refund_uncounted_charge  the refunded charge
--        r1_send_round               the Send hold and its capacity check
--        r1_admit_attempt            the converted/fresh charge, its floor and capacity check
--        r1_transition_round         the reissue re-check of a lapsed hold
--      r1_settings.admission_hold_minutes (which the API reads and shows) becomes 65 and
--      interview_rounds.held_minutes may be 0 or 65.
--
-- Re-pricing what is outstanding. A round can still carry a 55 from before this migration: a
-- Send hold (held_minutes = 55) or an uncounted charge kept for the link (held_minutes = 0,
-- charged_attempt_number > attempts_counted), both booked in the round's hold_month. After this
-- migration they are released / refunded as 65, so each is re-priced to 65 here, in the same
-- transaction, and its month's counter gets the 10-minute difference (minutes_reserved for a
-- hold, minutes_used for an uncounted charge). A release or refund then removes exactly what was
-- booked; a counted charge (spent, never refunded) is left alone. A LIVE R1 session would break
-- this (its 55 is booked, its floor would read 65, and whether it counts is not yet known), so
-- the migration refuses to run while one exists: pause R1 and let it finish first, as the
-- runbook's merge gate already requires (docs/runbooks/r1-operations.md).
--
-- Forward-only. CREATE OR REPLACE keeps the ACLs; they are restated at the end.
set local lock_timeout = '10s';

do $$
declare v_live integer;
begin
  select count(*) into v_live from screening_v2.call_sessions s
   where s.interview_round_id is not null and s.status in ('created', 'waiting', 'in_progress');
  if v_live > 0 then
    raise exception '0128 refused: % live R1 session(s); pause R1 (r1_settings.paused) and let them finish before deploying (docs/runbooks/r1-operations.md)', v_live;
  end if;
end;
$$;

-- 1. The usage-ledger bound: 1830 -> 2190 s for candidate / agent / manual_test rows.
alter table screening_v2.r1_usage_ledger drop constraint if exists chk_r1_usage_event_bounds;
alter table screening_v2.r1_usage_ledger
  add constraint chk_r1_usage_event_bounds check (
    (participant_kind = 'preflight' and seconds <= 15) or
    (participant_kind in ('candidate','agent','manual_test') and seconds <= 2190)
  );

-- 0117 verbatim except the bound 1830 -> 2190.
create or replace function screening_v2.r1_record_usage(p_session_id uuid,p_round_id uuid,p_participant_kind text,p_event text,p_seconds numeric,p_event_key text,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_session record;
begin
 if p_event_key is null or p_event_key !~ '^[A-Za-z0-9:_-]{1,128}$' or p_seconds < 0 or (p_participant_kind='preflight' and p_seconds>15) or (p_participant_kind <> 'preflight' and p_seconds>2190) then return jsonb_build_object('status','invalid_usage'); end if;
 select id,interview_round_id,status,mode,updated_at into v_session from screening_v2.call_sessions where id=p_session_id;
 if not found or v_session.interview_round_id is distinct from p_round_id or v_session.mode <> 'browser' or v_session.status not in ('waiting','in_progress') then return jsonb_build_object('status','session_invalid'); end if;
 insert into screening_v2.r1_usage_ledger(session_id,round_id,participant_kind,event,seconds,event_key,occurred_at) values(p_session_id,p_round_id,p_participant_kind,p_event,p_seconds,p_event_key,p_now) on conflict(session_id,event_key) do nothing;
 if not found then return jsonb_build_object('status','ok','duplicate',true); end if;
 return jsonb_build_object('status','ok','duplicate',false);
end; $$;

-- 2. The admission hold: 55 -> 65.
-- The column CHECKs were declared inline (0115, 0117), so their names are Postgres's defaults;
-- drop them by definition, never touching chk_interview_round_hold_month.
do $$
declare r record;
begin
  for r in select c.conname, c.conrelid::regclass as rel from pg_constraint c
            where c.contype = 'c'
              and ((c.conrelid = 'screening_v2.interview_rounds'::regclass
                    and c.conname <> 'chk_interview_round_hold_month'
                    and pg_get_constraintdef(c.oid) ~ 'held_minutes'
                    and pg_get_constraintdef(c.oid) !~ 'hold_month')
                or (c.conrelid = 'screening_v2.r1_settings'::regclass
                    and pg_get_constraintdef(c.oid) ~ 'admission_hold_minutes')) loop
    execute format('alter table %s drop constraint %I', r.rel, r.conname);
  end loop;
end;
$$;

-- Re-price outstanding Send holds: the hold month's reservation grows by the difference.
update screening_v2.r1_budget_month b
   set minutes_reserved = b.minutes_reserved + 10 * h.n, updated_at = now()
  from (select hold_month, count(*) as n from screening_v2.interview_rounds
         where held_minutes = 55 and hold_month is not null group by hold_month) h
 where b.month_start = h.hold_month;
update screening_v2.interview_rounds set held_minutes = 65 where held_minutes = 55;
-- Re-price uncounted charges kept for the link (refunded as 65 from now on).
update screening_v2.r1_budget_month b
   set minutes_used = b.minutes_used + 10 * u.n, updated_at = now()
  from (select hold_month, count(*) as n from screening_v2.interview_rounds
         where held_minutes = 0 and charged_attempt_number > attempts_counted and hold_month is not null
         group by hold_month) u
 where b.month_start = u.hold_month;

alter table screening_v2.interview_rounds
  add constraint chk_interview_round_held_minutes check (held_minutes in (0, 65));
update screening_v2.r1_settings set admission_hold_minutes = 65 where admission_hold_minutes <> 65;
alter table screening_v2.r1_settings alter column admission_hold_minutes set default 65;
alter table screening_v2.r1_settings
  add constraint chk_r1_settings_admission_hold_minutes check (admission_hold_minutes = 65);

-- 0119 verbatim except the live-unmetered floor 55 -> 65.
create or replace view screening_v2.v_webrtc_minutes_estimate
with (security_invoker = true) as
with ledger as (
  select date_trunc('month', occurred_at)::date as month_start, sum(seconds) / 60.0 as minutes,
         coalesce(sum(seconds) filter (where participant_kind in ('preflight', 'manual_test')), 0) / 60.0 as test_minutes
  from screening_v2.r1_usage_ledger group by 1
), r1_unmetered as (
  select date_trunc('month', coalesce(s.ended_at, s.updated_at, s.started_at, s.created_at))::date as month_start,
    greatest(0, extract(epoch from (coalesce(s.ended_at, s.updated_at, now()) - coalesce(s.started_at, s.created_at)))) * 2 / 60.0 as minutes,
    s.status in ('created', 'waiting', 'in_progress') as live
  from screening_v2.call_sessions s
  where s.interview_round_id is not null
    and not exists (select 1 from screening_v2.r1_usage_ledger l
                     where l.session_id = s.id and l.seconds > 0 and l.participant_kind in ('candidate', 'agent'))
), r1_session_fallback as (
  select month_start, sum(case when live then greatest(65, minutes) else minutes end) as minutes,
         sum(case when live then greatest(65, minutes) else 0 end) as live_minutes
  from r1_unmetered group by 1
), legacy_browser as (
  select date_trunc('month', coalesce(ended_at, started_at, updated_at))::date as month_start,
    sum((greatest(0, extract(epoch from (coalesce(ended_at, updated_at) - coalesce(started_at, updated_at)))) * 2 + 60) / 60.0) as minutes
  from screening_v2.call_sessions where mode = 'browser' and interview_round_id is null group by 1
), phone as (
  select date_trunc('month', coalesce(a.ended_at, a.created_at))::date as month_start,
    sum((greatest(0, extract(epoch from (coalesce(a.ended_at, a.created_at) - a.created_at))) + 60) / 60.0) as minutes
  from screening_v2.phone_call_attempts a group by 1
), months as (select month_start from ledger union select month_start from r1_session_fallback union select month_start from legacy_browser union select month_start from phone)
select m.month_start, coalesce(l.minutes,0) + coalesce(f.minutes,0) as r1_minutes, coalesce(p.minutes,0) as phone_minutes,
       coalesce(b.minutes,0) as legacy_browser_minutes,
       -- Same rule as the snapshot's pool_estimate: estimates carry the 1.15 margin, the live floors (booked charges) do not.
       (coalesce(l.minutes,0)+coalesce(f.minutes,0)+coalesce(p.minutes,0)+coalesce(b.minutes,0)-coalesce(f.live_minutes,0))*1.15 + coalesce(f.live_minutes,0) as estimated_minutes,
       coalesce(l.test_minutes,0) as r1_test_minutes,
       coalesce(f.live_minutes,0) as r1_live_unmetered_minutes
from months m left join ledger l using(month_start) left join r1_session_fallback f using(month_start)
left join phone p using(month_start) left join legacy_browser b using(month_start);

-- 0119 verbatim except c_hold 55 -> 65.
create or replace function screening_v2.r1_capacity_snapshot(
  p_now timestamptz default now(),
  p_extra_hold numeric default 0,
  p_extra_used numeric default 0,
  p_extra_actual numeric default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  c_mult constant numeric := 1.15;
  c_hold constant numeric := 65;
  v_month date := date_trunc('month', p_now)::date;
  v_month_start timestamptz := date_trunc('month', p_now);
  v_settings screening_v2.r1_settings%rowtype;
  v_d_hold numeric := coalesce(p_extra_hold, 0);
  v_d_used numeric := greatest(coalesce(p_extra_used, 0), 0);
  v_d_actual numeric := greatest(coalesce(p_extra_actual, 0), 0);
  v_ledger numeric; v_r1_all numeric; v_r1_test numeric; v_live_floor numeric; v_phone numeric; v_legacy numeric;
  v_live_unmetered integer; v_stored_holds numeric; v_ghost_month integer; v_ghost_live integer;
  v_restored numeric; v_outstanding numeric; v_booked numeric; v_used numeric;
  v_actual numeric; v_pool_pure numeric; v_pool_settled numeric; v_baseline numeric;
  v_floor numeric; v_r1_est numeric; v_pool_est numeric;
  v_pool_guard numeric; v_dashboard_applies boolean;
  v_used_post numeric; v_holds_post numeric; v_r1_committed numeric; v_pool_committed numeric;
  v_cloud boolean; v_r1_ok boolean; v_pool_ok boolean;
begin
  select * into v_settings from screening_v2.r1_settings where singleton;
  -- Fail closed: callers read the verdict, and a missing row must not admit.
  if not found then raise exception 'r1_settings row is missing'; end if;

  select coalesce(max(e.r1_minutes), 0), coalesce(max(e.r1_test_minutes), 0), coalesce(max(e.r1_live_unmetered_minutes), 0),
         coalesce(max(e.phone_minutes), 0), coalesce(max(e.legacy_browser_minutes), 0)
    into v_r1_all, v_r1_test, v_live_floor, v_phone, v_legacy
    from screening_v2.v_webrtc_minutes_estimate e where e.month_start = v_month;
  select coalesce(sum(l.seconds) / 60.0, 0) into v_ledger
    from screening_v2.r1_usage_ledger l
   where l.occurred_at >= v_month_start and l.occurred_at < v_month_start + interval '1 month';
  select count(*) into v_live_unmetered
    from screening_v2.call_sessions s
   where s.interview_round_id is not null and s.status in ('created', 'waiting', 'in_progress')
     and not exists (select 1 from screening_v2.r1_usage_ledger l
                      where l.session_id = s.id and l.seconds > 0 and l.participant_kind in ('candidate', 'agent'));

  select coalesce(sum(r.held_minutes), 0) into v_stored_holds
    from screening_v2.interview_rounds r
   where r.held_minutes > 0 and r.status in ('invited', 'in_progress') and r.expires_at > p_now;
  select count(*) filter (where g.hold_month = v_month),
         count(*) filter (where g.status in ('invited', 'in_progress') and g.expires_at > p_now and g.starts_used < 3)
    into v_ghost_month, v_ghost_live
    from (select r.hold_month, r.status, r.expires_at, r.starts_used
            from screening_v2.interview_rounds r
           where r.held_minutes = 0 and r.charged_attempt_number > r.attempts_counted
             and not exists (select 1 from screening_v2.call_sessions s
                              where s.interview_round_id = r.id and s.status in ('created', 'waiting', 'in_progress'))) g;
  v_restored := v_ghost_live * c_hold;
  v_outstanding := v_stored_holds + v_restored;
  select coalesce(max(b.minutes_used), 0) into v_booked
    from screening_v2.r1_budget_month b where b.month_start = v_month;
  v_used := greatest(0, v_booked - v_ghost_month * c_hold);

  v_actual := (v_r1_all - v_r1_test) + v_d_actual;
  v_pool_pure := v_r1_all + v_phone + v_legacy + v_d_actual;
  v_pool_settled := v_r1_all + v_phone + v_legacy - v_live_floor;
  -- The floors are booked charges: counted once, outside the x1.15 estimate margin.
  v_floor := v_live_floor + v_d_actual;
  v_r1_est := (v_actual - v_floor) * c_mult + v_floor;
  v_pool_est := (v_pool_pure - v_floor) * c_mult + v_floor;
  v_dashboard_applies := v_settings.dashboard_read_at is not null
    and date_trunc('month', v_settings.dashboard_read_at)::date = v_month;
  if v_dashboard_applies then
    v_baseline := coalesce(v_settings.dashboard_estimate_baseline, v_pool_settled);
    v_pool_guard := greatest(v_settings.dashboard_minutes,
                             v_settings.dashboard_minutes + (v_pool_pure - v_floor - v_baseline) * c_mult + v_floor,
                             v_pool_est);
  else
    v_pool_guard := v_pool_est;
  end if;

  v_used_post := v_used + v_d_used;
  v_holds_post := greatest(0, v_outstanding + v_d_hold);
  v_r1_committed := greatest(v_used_post, v_r1_est) + v_holds_post;
  v_pool_committed := v_pool_guard + greatest(0, v_used_post - v_r1_est) + v_holds_post;

  v_cloud := v_settings.livekit_target = 'cloud';
  v_r1_ok := v_r1_committed <= v_settings.monthly_cap_minutes;
  v_pool_ok := (not v_cloud) or v_pool_committed <= v_settings.pause_line_minutes;

  return jsonb_build_object(
    'month_start', v_month,
    'extra_hold', v_d_hold,
    'extra_used', v_d_used,
    'extra_actual', v_d_actual,
    'livekit_target', v_settings.livekit_target,
    'monthly_cap_minutes', v_settings.monthly_cap_minutes,
    'pause_line_minutes', v_settings.pause_line_minutes,
    'dashboard_minutes', v_settings.dashboard_minutes,
    'dashboard_read_at', v_settings.dashboard_read_at,
    'dashboard_estimate_baseline', v_settings.dashboard_estimate_baseline,
    'dashboard_applies', v_dashboard_applies,
    'r1_ledger_minutes', v_ledger,
    'r1_test_minutes', v_r1_test,
    'live_unmetered_sessions', v_live_unmetered,
    'live_unmetered_minutes', v_live_floor,
    'r1_actual', v_r1_all - v_r1_test,
    'phone_minutes', v_phone,
    'legacy_browser_minutes', v_legacy,
    'pool_pure', v_r1_all + v_phone + v_legacy,
    'pool_settled', v_pool_settled,
    'booked_minutes_used', v_booked,
    'uncounted_charges', v_ghost_month,
    'minutes_used', v_used,
    'restored_holds', v_restored,
    'outstanding_holds', v_outstanding,
    'r1_estimate', v_r1_est,
    'pool_estimate', v_pool_est,
    'pool_guard', v_pool_guard,
    'r1_committed', v_r1_committed,
    'pool_committed', v_pool_committed,
    'r1_headroom', v_settings.monthly_cap_minutes - v_r1_committed,
    'pool_headroom', v_settings.pause_line_minutes - v_pool_committed,
    'pool_check_applies', v_cloud,
    'r1_ok', v_r1_ok,
    'pool_ok', v_pool_ok,
    'admits', v_r1_ok and v_pool_ok
  );
end;
$$;

-- 0119 verbatim except the refunded charge 55 -> 65.
create or replace function screening_v2.r1_refund_uncounted_charge(p_round_id uuid, p_now timestamptz default now())
returns numeric language plpgsql set search_path = pg_catalog, screening_v2 as $$
declare v_round screening_v2.interview_rounds%rowtype;
begin
  select * into v_round from screening_v2.interview_rounds where id = p_round_id;
  if not found or v_round.held_minutes <> 0 or v_round.charged_attempt_number <= v_round.attempts_counted
     or v_round.hold_month is null then return 0; end if;
  -- A live session may still be counted: the worker counts at TRANSITION, while the
  -- session is live (plan D1), so its 65 is not yet known to be uncounted. Without
  -- this guard a cancel during a live session would refund a real session's 65.
  if exists (select 1 from screening_v2.call_sessions s
              where s.interview_round_id = v_round.id and s.status in ('created', 'waiting', 'in_progress')) then return 0; end if;
  update screening_v2.r1_budget_month
     set minutes_used = greatest(0, minutes_used - 65), updated_at = p_now
   where month_start = v_round.hold_month;
  update screening_v2.interview_rounds set charged_attempt_number = attempts_counted where id = v_round.id;
  return 65;
end;
$$;

-- 0119 verbatim except the hold 55 -> 65.
create or replace function screening_v2.r1_send_round(
  p_candidate_id uuid, p_role_id uuid, p_created_by uuid, p_link_token_digest text,
  p_candidate_status_at_send text, p_expires_at timestamptz, p_now timestamptz default now()
) returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare
  v_settings screening_v2.r1_settings%rowtype;
  v_month date := date_trunc('month', p_now)::date;
  v_round uuid := gen_random_uuid();
begin
  if p_link_token_digest is null or p_link_token_digest !~ '^[a-f0-9]{64}$' or p_expires_at <= p_now then return jsonb_build_object('status','invalid_request'); end if;
  -- Same lock order in every capacity writer: settings, then month.
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found or not v_settings.enabled then return jsonb_build_object('status','disabled'); end if;
  if v_settings.paused then return jsonb_build_object('status','paused'); end if;
  insert into screening_v2.r1_budget_month(month_start) values(v_month) on conflict do nothing;
  perform 1 from screening_v2.r1_budget_month where month_start=v_month for update;
  if not exists (select 1 from screening_v2.candidates c where c.id=p_candidate_id and c.decision_use_blocked_at is null) then return jsonb_build_object('status','candidate_ineligible'); end if;
  if not exists (select 1 from screening_v2.roles r where r.id=p_role_id and r.interview_kind='sales_r1') then return jsonb_build_object('status','role_not_configured'); end if;
  if exists (select 1 from screening_v2.interview_rounds r where r.candidate_id=p_candidate_id and r.kind='sales_r1' and r.status in ('invited','in_progress')) then return jsonb_build_object('status','round_active'); end if;
  if exists (select 1 from screening_v2.phone_engagements e where e.candidate_id=p_candidate_id and e.state in ('pending_prereqs','eligible','scheduled','dialing','in_call','reconnecting','awaiting_retry')) then return jsonb_build_object('status','phone_engagement_active'); end if;
  if exists (select 1 from screening_v2.call_sessions s join screening_v2.job_queue j on j.payload->>'session_id'=s.id::text where s.candidate_id=p_candidate_id and s.mode='live' and j.name='phone.assessment' and j.status in ('pending','active','delayed')) then return jsonb_build_object('status','phone_assessment_pending'); end if;
  -- Fail closed: anything but an explicit true refuses.
  if coalesce((screening_v2.r1_capacity_snapshot(p_now, 65)->>'admits')::boolean, false) is not true then return jsonb_build_object('status','capacity_exhausted'); end if;
  insert into screening_v2.interview_rounds(id,candidate_id,role_id,kind,link_token_digest,expires_at,candidate_status_at_send,created_by,held_minutes,hold_month) values(v_round,p_candidate_id,p_role_id,'sales_r1',p_link_token_digest,p_expires_at,p_candidate_status_at_send,p_created_by,65,v_month);
  update screening_v2.r1_budget_month set minutes_reserved=minutes_reserved+65,updated_at=p_now where month_start=v_month;
  return jsonb_build_object('status','ok','id',v_round,'round_status','invited','expires_at',p_expires_at);
end;
$$;

-- 0119 verbatim except the charge 55 -> 65.
create or replace function screening_v2.r1_admit_attempt(p_round_id uuid,p_nonce_digest text,p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare
  v_round screening_v2.interview_rounds%rowtype; v_settings screening_v2.r1_settings%rowtype;
  v_month date:=date_trunc('month',p_now)::date; v_hold_month date; v_charge_month date; v_existing_hold numeric;
  v_attempt integer; v_persona text; v_session uuid:=gen_random_uuid();
  v_live_r1 integer; v_live_phone integer; v_restart boolean; v_fresh_charge boolean;
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
  select count(*) into v_live_r1 from screening_v2.call_sessions s where s.interview_round_id is not null and s.status in ('created','waiting','in_progress');
  if v_live_r1>=1 then return jsonb_build_object('status','r1_in_flight'); end if;
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

-- 0126 verbatim except the reissue re-check 55 -> 65.
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
   -- A lapsed link's hold stopped counting before any sweep; reviving it adds 65 back.
   if v.held_minutes > 0 and v.expires_at <= p_now
      and coalesce((screening_v2.r1_capacity_snapshot(p_now, 65)->>'admits')::boolean, false) is not true then
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

revoke all on function screening_v2.r1_record_usage(uuid,uuid,text,text,numeric,text,timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_record_usage(uuid,uuid,text,text,numeric,text,timestamptz) to service_role;
revoke all on function screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric) from public, anon, authenticated;
grant execute on function screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric) to service_role;
revoke all on function screening_v2.r1_refund_uncounted_charge(uuid,timestamptz) from public, anon, authenticated, service_role;
revoke all on function screening_v2.r1_send_round(uuid,uuid,uuid,text,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_send_round(uuid,uuid,uuid,text,text,timestamptz,timestamptz) to service_role;
revoke all on function screening_v2.r1_admit_attempt(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_admit_attempt(uuid,text,timestamptz) to service_role;
revoke all on function screening_v2.r1_transition_round(uuid,text,integer,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_transition_round(uuid,text,integer,text,timestamptz,timestamptz) to service_role;
-- CREATE OR REPLACE VIEW keeps the ACL; restated so the contract is local (read-only).
revoke all on screening_v2.v_webrtc_minutes_estimate from public, anon, authenticated, service_role;
grant select on screening_v2.v_webrtc_minutes_estimate to service_role;
notify pgrst, 'reload schema';
