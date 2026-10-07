-- R1 capacity model (PR-2b). 0117 used ONE rule, least(monthly_cap_minutes,
-- pause_line_minutes) against the TOTAL Cloud pool estimate, for both Send and
-- admission. R1 has two controls with different meanings:
--
--   monthly_cap_minutes  the owner-approved R1 ALLOCATION (sessions x 55). It
--                        applies in BOTH livekit targets and is compared with
--                        R1's own committed minutes only. (The 0115 column
--                        default of 4000 predates this meaning and is left
--                        alone: the settings API refuses to enable R1 while it
--                        is still the untouched default, i.e. while
--                        allocation_set_at is NULL, see the runbook.)
--   pause_line_minutes   the total Cloud-pool pause line (4000 = 80%). It
--                        applies ONLY while livekit_target = 'cloud' (Mode B),
--                        and is compared with the whole pool (phone + legacy
--                        browser + R1 + preflight/test entries). A self-hosted
--                        R1 (Mode A) uses no Cloud minutes, so the pause line
--                        never gates it.
--
-- The rule lives once, in screening_v2.r1_capacity_snapshot. r1_send_round,
-- r1_admit_attempt, the reissue re-check and v_r1_budget_month all read it, so
-- Mission Control and the RPCs cannot disagree. Phone admission is never gated
-- by any of this. Lock order is unchanged everywhere: settings -> budget month
-- -> round.
set local lock_timeout = '10s';

-- The pool estimate (net of live-unmetered floors) when the dashboard figure was
-- entered. Guard = dashboard + 1.15 x (estimate growth since then); the
-- authoritative dashboard figure itself is never multiplied. NULL on a reading
-- is treated as "baseline = the estimate now" (see the snapshot).
alter table screening_v2.r1_settings
  add column if not exists dashboard_estimate_baseline numeric(10,2)
  check (dashboard_estimate_baseline is null or dashboard_estimate_baseline >= 0);

-- When the owner last SAVED the R1 allocation (monthly_cap_minutes). 0115 gave
-- that column a default of 4000, which then meant the total Cloud-pool pause
-- line; as the R1 allocation (sessions x 55) 4000 would be 72 sessions a month.
-- The settings API refuses to enable R1 while the allocation is the default AND
-- this is NULL. It is keyed on the allocation itself, not on updated_by: any
-- other settings write (a dashboard reading, a threshold, an empty save) records
-- updated_by and must not lift the guard. It is stamped by a trigger that fires
-- only when a write names monthly_cap_minutes (UPDATE OF), so a deliberate save
-- of an unchanged 4000 counts and nothing else does. NULL on every existing row:
-- an operator who had chosen 4000 re-saves it once after this migration.
alter table screening_v2.r1_settings add column if not exists allocation_set_at timestamptz;
create or replace function screening_v2.r1_stamp_allocation_set()
returns trigger language plpgsql set search_path = pg_catalog, screening_v2 as $$
begin
  new.allocation_set_at := now();
  return new;
end;
$$;
revoke all on function screening_v2.r1_stamp_allocation_set() from public, anon, authenticated;
drop trigger if exists trg_r1_settings_allocation_set on screening_v2.r1_settings;
create trigger trg_r1_settings_allocation_set
  before update of monthly_cap_minutes on screening_v2.r1_settings
  for each row execute function screening_v2.r1_stamp_allocation_set();

-- The highest attempt number whose 55 minutes are booked in minutes_used. A
-- charged attempt that ended without counting (no-show / technical failure, plan
-- 5.11) has charged_attempt_number > attempts_counted: its 55 is then a hold kept
-- for the link, not a spend (see "uncounted charges" in the snapshot). The
-- marker lives on the ROUND, so deleting an attempt row (retention purge)
-- cannot cause a second charge.
alter table screening_v2.interview_rounds
  add column if not exists charged_attempt_number integer not null default 0
  check (charged_attempt_number >= 0);
-- Upgrade guard. 0117 charged a fresh 55 for EVERY start, including the restart
-- of an uncounted attempt, which this model charges once. A restart left a second
-- attempt row with the same attempt number, so rows sharing (round, number) prove
-- a double charge that the backfill below cannot repair (the charged months are
-- not recorded). Production has no R1 rounds (R1 has never been enabled there),
-- so this is a stop for any environment that does: correct the budget months
-- first (runbook, "Deploying 0119"). It is only meaningful at upgrade time: from
-- 0119 on, restarts legitimately produce these rows.
create or replace function screening_v2.r1_count_0117_restart_double_charges()
returns integer language sql stable set search_path = pg_catalog, screening_v2 as $$
  select count(*)::integer from (
    select 1 from screening_v2.interview_round_attempts a
     group by a.round_id, a.attempt_number having count(*) > 1) d;
$$;
revoke all on function screening_v2.r1_count_0117_restart_double_charges() from public, anon, authenticated, service_role;
do $$
declare v_rounds integer := screening_v2.r1_count_0117_restart_double_charges();
begin
  if v_rounds > 0 then
    raise exception '0119 refused: % R1 round(s) were charged twice for a restarted attempt under 0117; correct their budget months first (docs/runbooks/r1-operations.md, "Deploying 0119")', v_rounds;
  end if;
end;
$$;
-- Every start admitted before this migration was charged (0115 reserved, 0117
-- converted or charged), so the existing attempt numbers are already charged.
-- The charge month is the latest attempt's creation month when the round never
-- recorded one.
update screening_v2.interview_rounds r
   set charged_attempt_number = a.latest,
       hold_month = coalesce(r.hold_month, a.charge_month)
  from (select distinct on (round_id) round_id, attempt_number as latest,
               date_trunc('month', created_at)::date as charge_month
          from screening_v2.interview_round_attempts
         order by round_id, attempt_number desc, created_at desc) a
 where a.round_id = r.id and r.charged_attempt_number = 0;

-- R1 actual minutes by month. Same first columns as 0117 (CREATE OR REPLACE
-- VIEW only allows appending). Corrections:
--  * the session fallback applies to a session with no POSITIVE candidate/agent
--    ledger row (a zero-second connect row, or a preflight row, must not hide
--    it) and counts candidate + agent, so x2 like legacy browser;
--  * a live session that has produced no metering yet counts at least its
--    55-minute admission charge (the "live floor");
--  * appended: r1_test_minutes (preflight + manual_test ledger minutes, which
--    belong to the Cloud pool but not to the R1 allocation) and
--    r1_live_unmetered_minutes (the live floors, which the dashboard baseline
--    must exclude).
-- Convention note: a metered session counts 1x elapsed in the ledger while the
-- fallback for a crashed one counts 2x; the ledger stays authoritative when the
-- worker supplies it (plan 3.3).
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
  select month_start, sum(case when live then greatest(55, minutes) else minutes end) as minutes,
         sum(case when live then greatest(55, minutes) else 0 end) as live_minutes
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

-- The single capacity rule. It locks nothing: every caller already holds the
-- settings, month and round locks in the established order, and the view is
-- observational. Terms (minutes, for the month of p_now unless said otherwise):
--   uncounted charges = rounds whose latest charged attempt ended without
--                       counting (charged_attempt_number > attempts_counted, no
--                       live session). Plan 5.11: the 55 is "kept for the link",
--                       so it is a HOLD, not a spend: it leaves minutes_used and
--                       joins the outstanding holds while the link lives and
--                       can still be started (fewer than 3 starts used). This
--                       is derived here, so it holds even before any sweep.
--   outstanding_holds = every round's held_minutes plus the uncounted charges
--                       above, in ANY month (holds are month-agnostic future
--                       minutes), counted only while the link can still be used
--                       (status invited/in_progress and expires_at > p_now), so
--                       an expired or cancelled link releases it before a sweep
--   minutes_used      = the month's booked minutes_used less its uncounted
--                       charges
--   r1_actual         = this month's R1 SESSION minutes: ledger (candidate +
--                       agent) + the corrected fallback. Preflight and
--                       manual_test minutes are pool-only: the plan formula
--                       already subtracts planned tests from the session cap.
--   floors            = the live-unmetered floors (a live session with no
--                       metering yet counts at its 55-minute charge) plus the
--                       change's own floor (p_extra_actual). A floor is a
--                       BOOKED CHARGE, like the Send hold it replaces, not an
--                       estimate, so it counts once, never x1.15. (A live
--                       session unmetered for more than ~27 minutes counts its
--                       elapsed x2 instead of 55, also unmultiplied: a few
--                       minutes under, until the metering replaces it.)
--   r1_estimate       = 1.15 x (r1_actual - floors) + floors
--   r1_committed      = greatest(minutes_used, r1_estimate) + holds
--   pool_pure         = r1_actual + preflight/test + phone + legacy browser
--   pool_settled      = pool_pure less the live-unmetered floors (the baseline
--                       a dashboard reading is stamped with)
--   pool_estimate     = 1.15 x (pool_pure - floors) + floors
--   pool_guard        = a dashboard reading from THIS month counts as
--                       greatest(dashboard, dashboard + 1.15 x (pool_pure -
--                       floors - baseline) + floors, pool_estimate) - never
--                       below the authoritative reading; a NULL baseline means
--                       "the estimate now" (pool_settled); otherwise
--                       pool_estimate
--   pool_committed    = pool_guard + greatest(0, minutes_used - r1_estimate)
--                       + holds
-- The checks run on the state AFTER the requested change. The three extras are
-- that change: p_extra_hold (the change in outstanding holds: +55 for a Send,
-- -55 when a hold is converted or an uncounted charge restarts), p_extra_used
-- (booked into this month's minutes_used) and p_extra_actual (the new live
-- session's 55-minute floor in r1_actual and pool_pure). A restart is charged
-- once: its floor joins r1_actual, its 55 returns from a hold to minutes_used.
-- Send and start agree: a Send reserves 55, and the start that converts it
-- exchanges that hold for a booked 55 and a 55 floor, which together count 55
-- (the greatest() of the booked and the floored terms), so a start that was
-- admitted at Send time fits again unless other usage grew in between. (Were the
-- floor multiplied it would need 63.25: an empty month, where 20 x 55 allocated
-- would admit 20 Sends and refuse all 20 starts.)
-- p_extra_used is 55 only when the start's charge belongs to p_now's month: a
-- hold converted in a LATER month than the one that booked it is a charge of the
-- Send month (its 55 is already in that month's minutes_used), so the later
-- month's allocation check does not add it; see r1_admit_attempt.
-- admits = R1 allocation holds AND (Mode A, or the Cloud pool holds).
-- STABLE: every term is read from one snapshot of the calling statement, so the
-- view and the RPCs see the same state.
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
  c_hold constant numeric := 55;
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

-- Migrate a current-month reading entered under 0117 (read_at set, no
-- baseline). Its estimate "at read time" is not computable: the estimate view
-- has no as-of dimension, so the stored rows cannot be rewound. The reading
-- therefore takes the estimate NOW (net of live floors) as its baseline: usage
-- before this migration is not added on top of it, usage after is. Re-entering
-- the dashboard figure after deploy re-stamps it exactly. A reading from an
-- earlier month is stale and is ignored by the snapshot regardless.
update screening_v2.r1_settings s
   set dashboard_estimate_baseline = (screening_v2.r1_capacity_snapshot(now(), 0)->>'pool_settled')::numeric
 where s.dashboard_estimate_baseline is null and s.dashboard_read_at is not null
   and date_trunc('month', s.dashboard_read_at) = date_trunc('month', now());

-- Same first eleven columns as 0117 (CREATE OR REPLACE VIEW only allows
-- appending); guarded_minutes now IS the RPC guard. The current month is always
-- present, even before its first Send creates a budget row (a prior-month hold
-- converted this month, or the first of the month), because the snapshot terms
-- are what Mission Control shows. Snapshot terms exist for the current month
-- only: holds and the dashboard reading describe "now".
-- The raw columns keep their 0117 meaning: minutes_used is the BOOKED column, and
-- starts_admitted counts CHARGED starts (a restart of an uncounted attempt is not
-- charged again, so it does not increment it). The derived terms the checks use
-- are appended, so the figures reconcile:
--   r1_committed = greatest(r1_minutes_used, r1_estimate) + outstanding_holds
--   r1_minutes_used = booked_minutes_used - 55 x uncounted_charges
--   outstanding_holds = every live Send hold + restored_holds (55 per uncounted
--   charge whose link can still be started).
create or replace view screening_v2.v_r1_budget_month
with (security_invoker = true) as
with months as (
  select month_start from screening_v2.r1_budget_month
  union
  select date_trunc('month', now())::date
)
select m.month_start,
       coalesce(b.minutes_reserved, 0::numeric(10,2)) as minutes_reserved,
       coalesce(b.minutes_used, 0::numeric(10,2)) as minutes_used,
       coalesce(b.starts_admitted, 0) as starts_admitted,
       coalesce(e.r1_minutes, 0) as ledger_minutes,
       coalesce(e.estimated_minutes, 0) as webrtc_estimated_minutes,
       s.monthly_cap_minutes, s.pause_line_minutes, s.dashboard_minutes, s.dashboard_read_at,
       coalesce((c.snapshot->>'pool_guard')::numeric, coalesce(e.estimated_minutes, 0)) as guarded_minutes,
       s.dashboard_estimate_baseline,
       s.livekit_target,
       (c.snapshot->>'r1_actual')::numeric as r1_actual,
       (c.snapshot->>'pool_pure')::numeric as pool_pure,
       (c.snapshot->>'pool_guard')::numeric as pool_guard,
       (c.snapshot->>'outstanding_holds')::numeric as outstanding_holds,
       (c.snapshot->>'r1_committed')::numeric as r1_committed,
       (c.snapshot->>'pool_committed')::numeric as pool_committed,
       (c.snapshot->>'r1_headroom')::numeric as r1_headroom,
       (c.snapshot->>'pool_headroom')::numeric as pool_headroom,
       (c.snapshot->>'pool_check_applies')::boolean as pool_check_applies,
       (c.snapshot->>'booked_minutes_used')::numeric as booked_minutes_used,
       (c.snapshot->>'uncounted_charges')::integer as uncounted_charges,
       (c.snapshot->>'restored_holds')::numeric as restored_holds,
       (c.snapshot->>'minutes_used')::numeric as r1_minutes_used,
       (c.snapshot->>'r1_estimate')::numeric as r1_estimate
  from months m
  left join screening_v2.r1_budget_month b on b.month_start = m.month_start
 cross join screening_v2.r1_settings s
  left join screening_v2.v_webrtc_minutes_estimate e on e.month_start = m.month_start
 cross join lateral (
   select case when m.month_start = date_trunc('month', now())::date
               then screening_v2.r1_capacity_snapshot(now(), 0) end as snapshot
 ) c;

-- Stamps a dashboard reconciliation atomically: the database clock and the
-- database's own pool estimate (net of live-unmetered floors, which the metering
-- later replaces and which would otherwise shrink the guard), under the settings
-- lock. The API never computes either value and a client can never supply them.
-- A reading counts as new when its value changes, when the stored one was never
-- stamped, or when the stored one is from an EARLIER month (the snapshot ignores
-- it there, so an unchanged figure re-entered in a new month must re-stamp);
-- re-saving other settings therefore cannot reset the baseline of an unchanged
-- current-month reading. dashboard_read_at is the ENTRY time: usage between
-- looking at the dashboard and entering the figure is not added (enter it
-- promptly).
create or replace function screening_v2.r1_stamp_dashboard_reading(
  p_dashboard_minutes numeric, p_updated_by uuid, p_now timestamptz default now()
) returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare
  v_settings screening_v2.r1_settings%rowtype; v_changed boolean; v_baseline numeric;
begin
  if p_dashboard_minutes is null or p_dashboard_minutes < 0 or p_dashboard_minutes >= 100000000 then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  if not found then return jsonb_build_object('status', 'disabled'); end if;
  v_changed := v_settings.dashboard_minutes is distinct from round(p_dashboard_minutes, 2)
    or v_settings.dashboard_read_at is null or v_settings.dashboard_estimate_baseline is null
    or date_trunc('month', v_settings.dashboard_read_at) <> date_trunc('month', p_now);
  if v_changed then
    v_baseline := (screening_v2.r1_capacity_snapshot(p_now, 0)->>'pool_settled')::numeric;
    update screening_v2.r1_settings
       set dashboard_minutes = p_dashboard_minutes, dashboard_read_at = p_now,
           dashboard_estimate_baseline = v_baseline, updated_by = p_updated_by, updated_at = p_now
     where singleton returning * into v_settings;
  end if;
  return jsonb_build_object('status', 'ok', 'changed', v_changed, 'settings', to_jsonb(v_settings));
end;
$$;

-- Internal: gives a round's uncounted charge back. The caller holds the settings,
-- hold-month and round locks. A charged attempt that ended without counting and
-- has no live session is a hold kept for the link; when the link ends it is
-- refunded from the originating month's minutes_used and the marker is reset, so
-- the refund can happen only once.
create or replace function screening_v2.r1_refund_uncounted_charge(p_round_id uuid, p_now timestamptz default now())
returns numeric language plpgsql set search_path = pg_catalog, screening_v2 as $$
declare v_round screening_v2.interview_rounds%rowtype;
begin
  select * into v_round from screening_v2.interview_rounds where id = p_round_id;
  if not found or v_round.held_minutes <> 0 or v_round.charged_attempt_number <= v_round.attempts_counted
     or v_round.hold_month is null then return 0; end if;
  -- A live session may still be counted: the worker counts at TRANSITION, while the
  -- session is live (plan D1), so its 55 is not yet known to be uncounted. Without
  -- this guard a cancel during a live session would refund a real session's 55.
  if exists (select 1 from screening_v2.call_sessions s
              where s.interview_round_id = v_round.id and s.status in ('created', 'waiting', 'in_progress')) then return 0; end if;
  update screening_v2.r1_budget_month
     set minutes_used = greatest(0, minutes_used - 55), updated_at = p_now
   where month_start = v_round.hold_month;
  update screening_v2.interview_rounds set charged_attempt_number = attempts_counted where id = v_round.id;
  return 55;
end;
$$;

-- Send R1: the R1 allocation always; the Cloud pause line only in Mode B. The
-- 55-minute hold is a fresh charge against both checks.
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
  if coalesce((screening_v2.r1_capacity_snapshot(p_now, 55)->>'admits')::boolean, false) is not true then return jsonb_build_object('status','capacity_exhausted'); end if;
  insert into screening_v2.interview_rounds(id,candidate_id,role_id,kind,link_token_digest,expires_at,candidate_status_at_send,created_by,held_minutes,hold_month) values(v_round,p_candidate_id,p_role_id,'sales_r1',p_link_token_digest,p_expires_at,p_candidate_status_at_send,p_created_by,55,v_month);
  update screening_v2.r1_budget_month set minutes_reserved=minutes_reserved+55,updated_at=p_now where month_start=v_month;
  return jsonb_build_object('status','ok','id',v_round,'round_status','invited','expires_at',p_expires_at);
end;
$$;

-- Admission. Send owns the first attempt's hold and admission converts it. The
-- checks run on the state AFTER the start (the new live session's 55-minute floor
-- joins r1_actual), so an admission can never leave R1 above either limit:
--   convert a Send hold         the hold leaves outstanding, 55 is booked, + floor
--   restart an uncounted        the attempt's 55 returns from a hold kept for the
--   attempt (same number)       link to booked, + floor: no new charge, charged once
--   retake, or a first start    a fresh 55 is booked, + floor
--   with no hold
-- Above either limit the candidate sees "temporarily unavailable" (plan D5).
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
  -- later month's allocation check adds no booked 55 for it (p_extra_used 0), and
  -- while the session is live it is absorbed by that month's greatest(booked,
  -- estimate). Mode A's allocation can therefore be exceeded by one session per
  -- link that straddles a month end, a bounded policy overshoot (links Sent in the
  -- last 72 hours of a month); the total across months is unchanged. The runbook
  -- states this, and the suite pins it.
  v_charge_month:=case when v_fresh_charge then v_month else coalesce(v_round.hold_month,v_month) end;
  if coalesce((screening_v2.r1_capacity_snapshot(p_now,
       case when v_fresh_charge then 0 else -55 end,
       case when v_charge_month=v_month then 55 else 0 end,
       55)->>'admits')::boolean, false) is not true then return jsonb_build_object('status','capacity_exhausted'); end if;
  if v_round.held_minutes>0 then
    update screening_v2.r1_budget_month set minutes_reserved=greatest(0,minutes_reserved-v_round.held_minutes),minutes_used=minutes_used+v_round.held_minutes,starts_admitted=starts_admitted+1,updated_at=p_now where month_start=v_hold_month;
    update screening_v2.interview_rounds set held_minutes=0 where id=v_round.id;
  elsif v_fresh_charge then
    update screening_v2.r1_budget_month set minutes_used=minutes_used+55,starts_admitted=starts_admitted+1,updated_at=p_now where month_start=v_hold_month;
  end if;
  select a.persona_id into v_persona from screening_v2.interview_round_attempts a where a.round_id=v_round.id and a.attempt_number=v_attempt and not a.counted order by a.created_at desc limit 1;
  if v_persona is null then select p.persona_id into v_persona from unnest(array['p1_career_switcher','p2_recent_grad','p3_data_analyst','p4_research_scholar']) p(persona_id) where not exists(select 1 from screening_v2.interview_round_attempts prior where prior.round_id=v_round.id and prior.counted and prior.persona_id=p.persona_id) order by random() limit 1; end if;
  insert into screening_v2.call_sessions(id,candidate_id,role_id,mode,provider,external_call_id,status,interview_round_id,owner_id) values(v_session,v_round.candidate_id,v_round.role_id,'browser','livekit','screening-'||v_session::text,'created',v_round.id,v_round.created_by);
  insert into screening_v2.interview_round_attempts(session_id,round_id,attempt_number,persona_id,nonce_digest) values(v_session,v_round.id,v_attempt,v_persona,p_nonce_digest);
  update screening_v2.interview_rounds set starts_used=starts_used+1,status='in_progress',version=version+1,charged_attempt_number=greatest(charged_attempt_number,v_attempt),hold_month=case when v_fresh_charge then v_hold_month else hold_month end,updated_at=p_now where id=v_round.id;
  return jsonb_build_object('status','ok','session_id',v_session,'attempt_number',v_attempt,'persona_id',v_persona);
end;
$$;

-- Release a round's capacity without changing its status: its stored hold, or
-- the uncounted charge of an attempt that ended without counting.
create or replace function screening_v2.r1_release_round_hold(p_round_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_settings screening_v2.r1_settings%rowtype; v_round screening_v2.interview_rounds%rowtype;
  v_hold_minutes numeric; v_hold_month date; v_uncounted boolean; v_refunded numeric;
begin
  -- Capacity writers always take settings -> hold month -> round.  Read the
  -- immutable hold metadata before taking the later locks; settings serializes
  -- all writers that can change it.
  select * into v_settings from screening_v2.r1_settings where singleton for update;
  select held_minutes, hold_month, charged_attempt_number > attempts_counted into v_hold_minutes, v_hold_month, v_uncounted
    from screening_v2.interview_rounds where id=p_round_id;
  if not found then return jsonb_build_object('status','round_not_found'); end if;
  if v_hold_minutes > 0 then
    if v_hold_month is null then return jsonb_build_object('status','hold_month_missing'); end if;
    perform 1 from screening_v2.r1_budget_month where month_start=v_hold_month for update;
    if not found then return jsonb_build_object('status','hold_month_missing'); end if;
  elsif v_uncounted and v_hold_month is not null then
    perform 1 from screening_v2.r1_budget_month where month_start=v_hold_month for update;
  end if;
  select * into v_round from screening_v2.interview_rounds where id=p_round_id for update;
  if v_round.held_minutes = 0 then
    v_refunded := screening_v2.r1_refund_uncounted_charge(p_round_id, p_now);
    return jsonb_build_object('status','ok','released',0,'refunded',v_refunded);
  end if;
  -- The month is persisted at hold creation; p_now is deliberately irrelevant.
  update screening_v2.r1_budget_month set minutes_reserved=greatest(0,minutes_reserved-v_round.held_minutes),updated_at=p_now where month_start=v_round.hold_month;
  update screening_v2.interview_rounds set held_minutes=0,updated_at=p_now where id=p_round_id;
  return jsonb_build_object('status','ok','released',v_round.held_minutes,'refunded',0);
end;
$$;

-- cancel / expire release the hold AND refund an uncounted charge; reissue of a
-- link that had already lapsed re-enters the hold, so it re-runs the capacity
-- check as a fresh 55. Everything else is as in 0117.
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
   -- A manual retake is only a final first attempt.  We require a completed,
   -- counted attempt; until score status is available this is intentionally the
   -- conservative gate rather than treating an active/invited row as final.
   if v.status <> 'completed' or v.attempts_counted <> 1 or v.attempts_allowed <= 1
      or (select count(*) from screening_v2.interview_round_attempts a join screening_v2.call_sessions s on s.id=a.session_id where a.round_id=v.id and a.counted and s.status='completed') <> 1 then return jsonb_build_object('status','retake_not_allowed'); end if;
   update screening_v2.interview_rounds set status='invited',expires_at=p_expires_at,version=version+1,updated_at=p_now where id=v.id; return jsonb_build_object('status','ok');
 end if;
 return jsonb_build_object('status','invalid_action');
end;
$$;

-- The sweep expires lapsed invited links (as in 0117) and now also gives back
-- what a dead link still holds: the hold, or the uncounted charge, of a round
-- that is in progress with a lapsed link or no starts left (3 used), or already
-- terminal, and has no live session. Its status is left to the round's own
-- workflow. The snapshot never
-- depends on this running (it filters lapsed links itself); the sweep keeps the
-- stored counters tidy.
create or replace function screening_v2.r1_sweep_expired_rounds(p_now timestamptz default now(),p_limit integer default 100)
returns integer language plpgsql security definer set search_path = pg_catalog, screening_v2 as $$
declare v_settings screening_v2.r1_settings%rowtype; r record; v_result jsonb; n integer:=0;
begin
 -- Do not lock rounds in the scan.  Each transition below takes settings ->
 -- originating month -> round, matching admission and Send.
 select * into v_settings from screening_v2.r1_settings where singleton for update;
 for r in select x.id,x.version,x.status from screening_v2.interview_rounds x
           where (x.status='invited' and x.expires_at<=p_now)
              or ((x.held_minutes>0 or (x.charged_attempt_number>x.attempts_counted and x.hold_month is not null))
                  and (x.status in ('completed','expired','cancelled') or x.expires_at<=p_now or x.starts_used>=3)
                  and not exists (select 1 from screening_v2.call_sessions s where s.interview_round_id=x.id and s.status in ('created','waiting','in_progress')))
           order by x.expires_at limit greatest(1,least(p_limit,1000)) loop
   if r.status='invited' then
     v_result := screening_v2.r1_transition_round(r.id,'expire',r.version,null,null,p_now);
   else
     v_result := screening_v2.r1_release_round_hold(r.id,p_now);
   end if;
   if v_result->>'status' = 'ok' then n:=n+1; end if;
 end loop; return n;
end;
$$;

revoke all on function screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric), screening_v2.r1_stamp_dashboard_reading(numeric,uuid,timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric), screening_v2.r1_stamp_dashboard_reading(numeric,uuid,timestamptz) to service_role;
-- Internal helper: only the SECURITY DEFINER functions above call it. 0001's
-- default privileges would otherwise hand it to service_role.
revoke all on function screening_v2.r1_refund_uncounted_charge(uuid,timestamptz) from public, anon, authenticated, service_role;
-- CREATE OR REPLACE FUNCTION keeps 0117's ACL for the replaced functions; the
-- new ones above are revoked explicitly. CREATE OR REPLACE VIEW keeps 0117's ACL
-- too; restate it so the contract is local: read-only (0001's default
-- privileges would otherwise leave INSERT/UPDATE/DELETE).
revoke all on screening_v2.v_webrtc_minutes_estimate, screening_v2.v_r1_budget_month from public, anon, authenticated, service_role;
grant select on screening_v2.v_webrtc_minutes_estimate, screening_v2.v_r1_budget_month to service_role;
notify pgrst, 'reload schema';
