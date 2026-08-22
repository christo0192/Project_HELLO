-- =====================================================================
-- 0042 lock-order worker — ONE session of a mixed concurrent workload.
--
-- Six sessions calling `admit_phone_attempt` cannot deadlock with each
-- other no matter how the row locks are ordered, because the advisory
-- lock is that function's FIRST statement and serialises them
-- completely. A phase built only from admissions therefore proves
-- nothing about lock ORDER — it would stay green with the link and
-- engagement locks inverted.
--
-- The cycles that are actually plausible are BETWEEN functions:
--
--   * `admit_phone_attempt` holds the engagement and then waits on the
--     `uq_phone_attempts_one_live` index entry of an attempt another
--     transaction is updating;
--   * `reclaim_phone_attempt_leases` sweeps attempts belonging to OTHER
--     sessions' engagements and must take engagement-then-attempt;
--   * `apply_phone_event` takes engagement-then-attempt for a third.
--
-- Invert the sweeper's two locks and this workload deadlocks. That is
-- what this worker exists to provoke, under a deliberately tiny
-- `deadlock_timeout` so a cycle surfaces as 40P01 in milliseconds rather
-- than as an unexplained slow test.
--
--   psql -v idx=<n> -v tag=<slug> -v count=<n> -v ts=<timestamptz> \
--        -f phone_lock_order_worker.sql
--
-- Every status is acceptable — `ok`, `attempt_in_flight`,
-- `daily_attempt_exists`, `at_capacity`, `state_not_admissible` are all
-- legitimate outcomes of a contended workload. The ONLY thing asserted
-- is the absence of a deadlock, which psql reports as an error and the
-- shell harness greps for.
-- =====================================================================

set deadlock_timeout = '50ms';

select set_config('pol42l.idx',   :'idx',   false),
       set_config('pol42l.tag',   :'tag',   false),
       set_config('pol42l.count', :'count', false),
       set_config('pol42l.ts',    :'ts',    false) \g /dev/null

do $$
declare
  v_idx   constant integer     := current_setting('pol42l.idx')::integer;
  v_tag   constant text        := current_setting('pol42l.tag');
  v_count constant integer     := current_setting('pol42l.count')::integer;
  v_ts    constant timestamptz := current_setting('pol42l.ts')::timestamptz;
  v_eng   uuid;
  v_res   jsonb;
  v_att   uuid;
  v_now   timestamptz;
  v_i     integer;
begin
  select engagement_id into v_eng
    from _phone_race.fixtures where tag = v_tag and idx = v_idx;
  if v_eng is null then
    raise exception 'pol42l: worker % has no fixture', v_idx;
  end if;

  for v_i in 0..9 loop
    -- A distinct IST day per iteration, so the per-day index refuses
    -- because of contention rather than because of the calendar.
    v_now := v_ts + (v_i * interval '1 day');

    -- 1. Take engagement -> attempt through the admission door.
    v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', 'pol42l-' || v_idx, 30, v_now);
    v_att := (v_res->>'attempt_id')::uuid;

    -- 2. Take engagement -> attempt again through the ingress door.
    if v_att is not null then
      perform screening_v2.apply_phone_event(
        'provider_poll', 'sip.participant_joined', v_att, null,
        'poll:' || v_att::text || ':' || v_i::text, null, null, v_now);
    end if;

    -- 3. Sweep EVERY session's expired attempts, which is where an
    --    inverted lock order in the sweeper closes the cycle against the
    --    two calls above running in another backend.
    perform screening_v2.reclaim_phone_attempt_leases(
      greatest(1, v_count * 2), v_now + interval '1 hour');
  end loop;

  raise notice 'pol42l: worker % completed 10 mixed iterations with no deadlock', v_idx;
end;
$$;
