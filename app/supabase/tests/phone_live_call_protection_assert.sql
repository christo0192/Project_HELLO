-- =====================================================================
-- 0096 assertions — run AFTER phone_live_call_protection_setup.sql.
--
-- Proves the two halves of the live-call protection actually behave, on a
-- real Postgres, against the real functions. The vitest suites match these
-- migrations as TEXT; nothing there can tell a correct predicate from one
-- that compiles and selects the wrong rows.
--
-- Every assertion RAISES, so `psql -v ON_ERROR_STOP=1` exits non-zero on
-- any violation.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_now      constant timestamptz := '2026-09-10T12:00:00Z'::timestamptz;
  v_grace    interval;
  v_res      jsonb;
  v_state    text;
  v_status   text;
  v_reason   text;
  v_expired  integer;
  v_examined integer;
begin
  -- ── 0. The grace is a real, positive interval ─────────────────────
  -- A helper that returned zero (or null) would make every assertion below
  -- pass for the wrong reason: the "spared" leg would survive only because
  -- the reaper found nothing to do at all.
  select screening_v2.phone_answered_reclaim_grace() into v_grace;
  if v_grace is null or v_grace <= interval '0 seconds' then
    raise exception 'lcp96: phone_answered_reclaim_grace() is % — the grace must be positive', v_grace;
  end if;
  -- The fixture's two answered legs straddle it: 30s < grace < 300s. If the
  -- helper is ever retuned outside that band, this file must be retuned too,
  -- and it says so loudly instead of silently testing nothing.
  if not (v_grace > interval '30 seconds' and v_grace < interval '300 seconds') then
    raise exception 'lcp96: grace % no longer straddles the fixture (30s / 300s)', v_grace;
  end if;

  -- ═══════════════════════════════════════════════════════════════════
  -- A. THE REAPER SPARES A CONNECTED CALL — ONCE, NOT FOR EVER
  -- ═══════════════════════════════════════════════════════════════════
  select screening_v2.reclaim_phone_attempt_leases(50, v_now) into v_res;
  if coalesce(v_res ->> 'status', '') <> 'ok' then
    raise exception 'lcp96: reclaim returned % (expected ok)', v_res;
  end if;

  -- SPARED: answered, lease expired 30s ago — inside the grace. This is the
  -- row whose reclamation ended two live conversations on 2026-09-10.
  select a.state into v_state
    from screening_v2.phone_call_attempts a
    join screening_v2.phone_engagements e on e.id = a.engagement_id
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'lcp96-spared-app';
  if v_state is distinct from 'human' then
    raise exception 'lcp96: a CONNECTED call % inside the grace was reclaimed (state=%)',
      'lcp96-spared', v_state;
  end if;

  -- REAPED: answered, lease expired 300s ago — past the grace. A delay, not
  -- an exemption: a genuinely dead worker must still give its slot back.
  select a.state into v_state
    from screening_v2.phone_call_attempts a
    join screening_v2.phone_engagements e on e.id = a.engagement_id
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'lcp96-reaped-app';
  if v_state is distinct from 'abandoned' then
    raise exception 'lcp96: an answered leg PAST the grace was not reclaimed (state=%)', v_state;
  end if;

  -- UNANSWERED: never answered, lease expired 1s ago. No grace applies — a
  -- ringing leg that stopped heartbeating is holding up somebody else's call.
  select a.state into v_state
    from screening_v2.phone_call_attempts a
    join screening_v2.phone_engagements e on e.id = a.engagement_id
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'lcp96-unanswered-app';
  if v_state is distinct from 'abandoned' then
    raise exception 'lcp96: a NEVER-ANSWERED leg was given grace it must not get (state=%)', v_state;
  end if;

  -- And the spared leg is reclaimed once the grace HAS elapsed. Without this
  -- the fix would be indistinguishable from "answered legs are immortal",
  -- which would leak a fleet slot on every crashed call.
  perform screening_v2.reclaim_phone_attempt_leases(
    50, v_now + v_grace + interval '1 second');
  select a.state into v_state
    from screening_v2.phone_call_attempts a
    join screening_v2.phone_engagements e on e.id = a.engagement_id
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'lcp96-spared-app';
  if v_state is distinct from 'abandoned' then
    raise exception 'lcp96: the grace never EXPIRES — spared leg still % one grace later', v_state;
  end if;

  raise notice 'lcp96/A: PASS — answered+inside-grace spared, answered+past-grace reaped, '
               'never-answered reaped with no grace, and the grace does expire';

  -- ═══════════════════════════════════════════════════════════════════
  -- B. THE ORPHAN SESSION IS FINALLY VISIBLE
  -- ═══════════════════════════════════════════════════════════════════
  select screening_v2.sweep_phone_orphan_sessions(25, 900, v_now) into v_res;
  if coalesce(v_res ->> 'status', '') <> 'ok' then
    raise exception 'lcp96: orphan sweep returned % (expected ok)', v_res;
  end if;
  v_expired  := (v_res ->> 'expired')::integer;
  v_examined := (v_res ->> 'examined')::integer;

  -- ORPHAN: no attempt, no live engagement, past the grace → terminalized.
  select status, terminal_reason into v_status, v_reason
    from screening_v2.call_sessions where external_call_id = 'phone-lcp96-orphan';
  if v_status is distinct from 'expired' or v_reason is distinct from 'idle_timeout' then
    raise exception 'lcp96: the ORPHAN session was not terminalized (status=%, reason=%)',
      v_status, v_reason;
  end if;

  -- YOUNG: same shape, 60s old. Inside the grace, so untouched — taking it
  -- would race an admission that is still in flight.
  select status into v_status
    from screening_v2.call_sessions where external_call_id = 'phone-lcp96-young';
  if v_status is distinct from 'waiting' then
    raise exception 'lcp96: a session INSIDE the grace was expired (status=%)', v_status;
  end if;

  -- DIALLED: an attempt exists against it. A real call happened here.
  select status into v_status
    from screening_v2.call_sessions where external_call_id = 'phone-lcp96-dialled';
  if v_status is distinct from 'waiting' then
    raise exception 'lcp96: a session WITH an attempt was expired (status=%)', v_status;
  end if;

  -- ENGAGED: a non-terminal engagement points at it — a screening in flight.
  select status into v_status
    from screening_v2.call_sessions where external_call_id = 'phone-lcp96-engaged';
  if v_status is distinct from 'waiting' then
    raise exception 'lcp96: a session held by a LIVE engagement was expired (status=%)', v_status;
  end if;

  -- Exactly one of the four was taken. A sweep that terminalized more (or
  -- fewer) would still satisfy the four checks above if the counts lied, so
  -- the RETURNED numbers are asserted too — they are what the runtime
  -- publishes to the health surface.
  if v_expired < 1 then
    raise exception 'lcp96: orphan sweep reported expired=% (expected >= 1)', v_expired;
  end if;
  if v_examined < v_expired then
    raise exception 'lcp96: examined=% < expired=% — the counters disagree', v_examined, v_expired;
  end if;

  -- IDEMPOTENT: the second pass finds nothing left of ours. `expired` counts
  -- only rows this pass drove, and the orphan is now terminal and invisible
  -- to the `status = 'waiting'` selector.
  select screening_v2.sweep_phone_orphan_sessions(25, 900, v_now) into v_res;
  if (v_res ->> 'expired')::integer <> 0 then
    raise exception 'lcp96: a second pass expired % more sessions — not idempotent',
      v_res ->> 'expired';
  end if;

  -- `expired`/`idle_timeout`, NOT `grace_timeout`. The scoring eligibility
  -- gate admits the latter, and an orphan has no conversation to score —
  -- writing the wrong reason would turn a refused dial into a scorecard.
  if exists (
    select 1 from screening_v2.call_sessions
     where external_call_id = 'phone-lcp96-orphan'
       and terminal_reason = 'grace_timeout'
  ) then
    raise exception 'lcp96: the orphan was terminalized as grace_timeout — it would be scored';
  end if;

  raise notice 'lcp96/B: PASS — orphan expired/idle_timeout; young, dialled and engaged '
               'untouched; counts agree; second pass is a no-op';
end;
$$;

-- Teardown, so a suite re-run and any later fixture start clean.
do $$
begin
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'lcp96-%'));
  delete from screening_v2.phone_engagements
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'lcp96-%');
  delete from screening_v2.call_sessions where external_call_id like 'phone-lcp96-%';
  delete from screening_v2.ashby_application_links where external_application_id like 'lcp96-%';
  delete from screening_v2.ashby_job_mappings where external_job_id like 'lcp96-%';
  delete from screening_v2.candidates where email like 'lcp96-%@example.test';
  raise notice 'lcp96: teardown complete — all lcp96 fixtures removed';
end;
$$;
