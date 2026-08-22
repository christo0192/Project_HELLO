-- =====================================================================
-- 0042 concurrency assertions — run AFTER a set of admit_phone_attempt
-- sessions, proven parked on a lock, has been released to contend for
-- the fixtures created by phone_admission_concurrency_setup.sql.
--
-- The shell harness asserts the two things this script cannot see: that
-- every racer was genuinely BLOCKED before the blocker was released (the
-- proof that the lock exists and is the serialiser), and the returned
-- statuses. This script asserts the DURABLE consequences, which is where
-- a serialisation defect actually shows up.
--
--   psql -v tag=<slug> -v mode=<admission|capacity> -v ts=<timestamptz> \
--        -f phone_admission_concurrency_assert.sql
--
-- Raises — and therefore fails the run — on any violation.
-- =====================================================================

select set_config('pol42c.tag',  :'tag',  false),
       set_config('pol42c.mode', :'mode', false),
       set_config('pol42c.ts',   :'ts',   false) \g /dev/null

do $$
declare
  v_tag  constant text        := current_setting('pol42c.tag');
  v_mode constant text        := current_setting('pol42c.mode');
  v_ts   constant timestamptz := current_setting('pol42c.ts')::timestamptz;
  v_engs uuid[];
  v_attempts integer; v_live integer; v_jobs integer; v_audits integer;
  v_leases integer; v_budgets integer; v_payload jsonb; v_res jsonb;
  v_eng uuid;
begin
  select coalesce(array_agg(engagement_id order by idx), '{}') into v_engs
    from _phone_race.fixtures where tag = v_tag;
  if array_length(v_engs, 1) is null then
    raise exception 'pol42c: fixture set % is missing', v_tag;
  end if;

  select count(*),
         count(*) filter (where state in ('admitted','ringing','answered_unclassified',
                                          'human','machine')),
         count(*) filter (where lease_token is not null and lease_expires_at > v_ts)
    into v_attempts, v_live, v_leases
    from screening_v2.phone_call_attempts where engagement_id = any(v_engs);

  select count(*) into v_jobs
    from screening_v2.job_queue
   where name = 'phone.dial'
     and status in ('pending', 'active', 'delayed')
     and (payload->>'attemptId')::uuid in (
       select id from screening_v2.phone_call_attempts where engagement_id = any(v_engs));

  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'phone_attempt_admitted'
     and (metadata->>'engagement_id')::uuid = any(v_engs);

  -- No admission, anywhere, ever charges a budget. A wait must cost the
  -- candidate nothing, and a race is a wait for everyone who loses it.
  select count(*) into v_budgets
    from screening_v2.phone_engagements
   where id = any(v_engs)
     and (no_answer_attempts <> 0 or reconnects_used <> 0 or provider_failures <> 0);
  if v_budgets <> 0 then
    raise exception 'pol42c FAIL (%): % engagement(s) had a budget charged by ADMISSION',
      v_tag, v_budgets;
  end if;

  if v_mode = 'admission' then
    -- One engagement, three contending admissions: exactly one attempt,
    -- one lease, one live job and one audit row.
    if v_attempts <> 1 then
      raise exception 'pol42c FAIL (%): expected exactly ONE attempt row, got %', v_tag, v_attempts;
    end if;
    if v_live <> 1 then
      raise exception 'pol42c FAIL (%): expected exactly ONE live attempt, got %', v_tag, v_live;
    end if;
    if v_leases <> 1 then
      raise exception 'pol42c FAIL (%): expected exactly ONE unexpired lease, got %', v_tag, v_leases;
    end if;
    if v_jobs <> 1 then
      raise exception 'pol42c FAIL (%): expected exactly ONE live phone.dial job, got %', v_tag, v_jobs;
    end if;
    if v_audits <> 1 then
      raise exception 'pol42c FAIL (%): expected exactly ONE admission audit row, got %', v_tag, v_audits;
    end if;

    select payload into v_payload from screening_v2.job_queue
     where name = 'phone.dial'
       and (payload->>'attemptId')::uuid in (
         select id from screening_v2.phone_call_attempts where engagement_id = any(v_engs))
     limit 1;
    if v_payload->>'provider' <> 'phone' or v_payload->>'attemptId' is null
       or (select count(*) from jsonb_object_keys(v_payload)) <> 2 then
      raise exception 'pol42c FAIL (%): the raced job carries an unexpected payload: %',
        v_tag, v_payload;
    end if;

    -- uq_phone_attempts_one_live is LOAD-BEARING, proven here rather
    -- than assumed. The engagement is put into an admissible state while
    -- its attempt is still live, and the one kind the per-day index does
    -- not cover is requested — so neither the state check nor the day
    -- index can refuse, and only the index can. Dropping the index turns
    -- this into an `ok` and a second live attempt.
    v_eng := v_engs[1];
    update screening_v2.phone_engagements set state = 'reconnecting' where id = v_eng;
    v_res := screening_v2.admit_phone_attempt(v_eng, 'reconnect', 'pol42c-onelive', 60,
                                              v_ts + interval '1 minute');
    select count(*) filter (where state in ('admitted','ringing','answered_unclassified',
                                            'human','machine'))
      into v_live from screening_v2.phone_call_attempts where engagement_id = v_eng;
    if v_res->>'status' <> 'attempt_in_flight' or v_live <> 1 then
      raise exception 'pol42c FAIL (%): uq_phone_attempts_one_live is not load-bearing — '
                      'admission returned % leaving % live attempt(s)',
        v_tag, v_res->>'status', v_live;
    end if;

    raise notice 'pol42c PASS (%): three CONTENDING admissions produced ONE attempt, '
                 'ONE lease, ONE live phone.dial job and ONE audit row, charged no budget, '
                 'and the one-live index refused a fourth', v_tag;

  elsif v_mode = 'capacity' then
    -- Eleven engagements, eleven contending admissions, a hard cap of
    -- ten. A count-then-insert race without the advisory lock admits
    -- more than ten; that is the entire reason the lock exists.
    if v_attempts <> 10 or v_live <> 10 then
      raise exception 'pol42c FAIL (%): the ≤10 fleet cap was breached — % attempt(s), % live',
        v_tag, v_attempts, v_live;
    end if;
    if v_jobs <> 10 then
      raise exception 'pol42c FAIL (%): expected exactly TEN live phone.dial jobs, got %',
        v_tag, v_jobs;
    end if;
    if v_audits <> 10 then
      raise exception 'pol42c FAIL (%): expected exactly TEN admission audit rows, got %',
        v_tag, v_audits;
    end if;
    raise notice 'pol42c PASS (%): eleven CONTENDING admissions filled exactly ten fleet '
                 'slots and refused the eleventh, charging nothing', v_tag;

  elsif v_mode = 'lock_order' then
    -- A contended mixed workload has no single correct status sequence:
    -- ok, attempt_in_flight, daily_attempt_exists and at_capacity are
    -- all legitimate. The shell asserts the absence of a deadlock; what
    -- is asserted HERE is that contention left nothing broken —
    -- every engagement is still non-terminal and still has an edge out,
    -- the fleet cap was never exceeded, and no budget was charged by a
    -- door that must charge none.
    if v_attempts = 0 then
      raise exception 'pol42c FAIL (%): the workload admitted nothing, so it contended for nothing',
        v_tag;
    end if;
    if v_live > 10 then
      raise exception 'pol42c FAIL (%): the fleet cap was breached under contention — % live',
        v_tag, v_live;
    end if;
    if exists (select 1 from screening_v2.phone_engagements
                where id = any(v_engs)
                  and (terminal_at is not null
                       or state not in ('eligible','scheduled','dialing','in_call',
                                        'reconnecting','awaiting_retry'))) then
      raise exception 'pol42c FAIL (%): contention left an engagement terminal or wedged', v_tag;
    end if;
    raise notice 'pol42c PASS (%): eight mixed admit/apply/reclaim workers made % attempt(s) '
                 'with no deadlock, no cap breach, no wedged engagement and no budget charged',
                 v_tag, v_attempts;
  else
    raise exception 'pol42c: unknown assertion mode %', v_mode;
  end if;

  -- Leave the database as we found it. The GOV-06 synthetic-seed suite
  -- asserts GLOBAL cardinality on candidates and consent_records a few
  -- sections later, and a leaked race fixture would fail it with a
  -- message pointing nowhere near this file.
  perform _phone_race.teardown(v_tag, array_length(v_engs, 1));
end;
$$;
