-- =====================================================================
-- 0083 daily-cap infra-defer assertions — run AFTER
-- phone_daily_cap_infra_defer_setup.sql.
--
-- Proves the 0083 narrowing discriminates by `abandon_reason`, not by
-- `state='abandoned'` alone, on BOTH the INSERT-conflict path (the
-- narrowed uq_phone_attempts_one_per_ist_day index) and the two SELECT
-- daily pre-checks inside admit_phone_attempt:
--
--   (a) Engagement A (prior infra-deferred abandonment, EXCLUDED):
--       * INDEX path — a fresh admitted-shaped insert for A on the same
--         ist_date does NOT trip uq_phone_attempts_one_per_ist_day (the
--         excluded row does not occupy the day). Rolled back in a
--         sub-block so it leaves no residue.
--       * PRE-CHECK path — admit_phone_attempt(A,'initial',...) does NOT
--         return 'daily_attempt_exists'. With the full eligible seed and
--         the 24/7 window it returns 'ok' (re-admission works); we assert
--         'ok' and tolerate no daily refusal. (If admit returned 'ok' it
--         created a new attempt+lease+job — that is the proof, and the
--         teardown at the end removes it.)
--
--   (b) Engagement B (prior reclaim-abandoned, abandon_reason NULL):
--       admit_phone_attempt returns 'daily_attempt_exists'. The call
--       rang/answered; the day stays charged. The anti-harassment core.
--
--   (c) Engagement C (prior completed/ended attempt): admit_phone_attempt
--       returns 'daily_attempt_exists'. A real call still holds the day.
--
-- Raises (and therefore fails the suite under ON_ERROR_STOP) on any
-- violation. Every message is prefixed 'dcap83:'. Leaves the DB clean.
--
-- Run (wired into scripts/supabase-test.sh; standalone form below):
--   psql -v ON_ERROR_STOP=1 -f phone_daily_cap_infra_defer_assert.sql
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_now   constant timestamptz := '2026-09-06T12:00:00+05:30'::timestamptz;
  v_ist       date;
  v_eng_a     uuid;
  v_eng_b     uuid;
  v_eng_c     uuid;
  v_res       jsonb;
  v_status    text;
  v_unique    boolean;
begin
  v_ist := screening_v2.phone_ist_date(v_now);

  select e.id into v_eng_a
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'dcap83-a-infra-app';
  select e.id into v_eng_b
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'dcap83-b-reclaim-app';
  select e.id into v_eng_c
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'dcap83-c-ended-app';
  if v_eng_a is null or v_eng_b is null or v_eng_c is null then
    raise exception 'dcap83: fixture engagements missing — run the setup first';
  end if;

  -- ── (a) INDEX path: a fresh admitted-shaped row for A does NOT collide ──
  -- The prior A attempt (abandoned + infra_deferred) is EXCLUDED from
  -- uq_phone_attempts_one_per_ist_day, so a second same-day admitted row is
  -- accepted by the index. Attempt it inside a sub-block and roll it back so
  -- it cannot affect the admit pre-check that follows. If the index still
  -- charged the infra-deferred row, this insert would raise unique_violation
  -- and we re-raise a clear message.
  v_unique := false;
  begin
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, ist_date,
       prior_engagement_state, admitted_at, created_at)
    values (v_eng_a, 2, 0, 'initial', 'admitted', v_ist, 'eligible', v_now, v_now);
    -- Undo the probe row immediately; the admit call below must see the
    -- fixture exactly as seeded (only the infra-deferred prior attempt).
    delete from screening_v2.phone_call_attempts
     where engagement_id = v_eng_a and attempt_seq = 2 and state = 'admitted';
  exception
    when unique_violation then
      v_unique := true;
  end;
  if v_unique then
    raise exception 'dcap83(a-index): a same-day admitted insert for A tripped uq_phone_attempts_one_per_ist_day — the infra-deferred row was NOT excluded from the index';
  end if;

  -- ── (a) PRE-CHECK path: admit re-admits A (not 'daily_attempt_exists') ──
  -- The two narrowed daily pre-checks exclude the infra-deferred prior
  -- attempt, so admission proceeds. With the full eligible seed and the 0064
  -- 24/7 window (frozen instant on 2026-09-06), it reaches 'ok'.
  v_res    := screening_v2.admit_phone_attempt(v_eng_a, 'initial', 'dcap83-a', 60, v_now);
  v_status := v_res->>'status';
  if v_status = 'daily_attempt_exists' then
    raise exception 'dcap83(a-precheck): admit returned daily_attempt_exists for A — the infra-deferred prior attempt was NOT excluded from the daily pre-check';
  end if;
  if v_status <> 'ok' then
    raise exception 'dcap83(a-precheck): expected admit=ok for A (re-admission), got % (should reach ok on the full eligible 24/7 seed)', v_status;
  end if;

  -- ── (b) Engagement B: reclaim-abandoned (abandon_reason NULL) stays charged ──
  -- A call that rang/answered spends the anti-harassment budget; the day must
  -- stay charged even though the attempt is `abandoned`. admit must REFUSE.
  v_res    := screening_v2.admit_phone_attempt(v_eng_b, 'initial', 'dcap83-b', 60, v_now);
  v_status := v_res->>'status';
  if v_status <> 'daily_attempt_exists' then
    raise exception 'dcap83(b): expected daily_attempt_exists for B (reclaim-abandoned, abandon_reason NULL — day stays charged), got %', v_status;
  end if;

  -- ── (c) Engagement C: completed/ended attempt stays charged ───────────
  v_res    := screening_v2.admit_phone_attempt(v_eng_c, 'initial', 'dcap83-c', 60, v_now);
  v_status := v_res->>'status';
  if v_status <> 'daily_attempt_exists' then
    raise exception 'dcap83(c): expected daily_attempt_exists for C (completed/ended attempt still holds the day), got %', v_status;
  end if;

  raise notice 'dcap83: PASS — A re-admits (index + pre-check both exclude infra_deferred), B (reclaim NULL) and C (ended) both stay charged (daily_attempt_exists)';
end;
$$;

-- =====================================================================
-- Teardown — leave the DB clean (mirrors the setup teardown). Removes
-- every 'dcap83-%' fixture AND the extra attempt+lease+job the successful
-- A re-admission created above (its attempt_seq is 2+, its dial job carries
-- dedup_key 'phone.dial:<id>'). Runs unconditionally after the assertions.
-- =====================================================================
do $$
begin
  perform set_config('app.allow_phone_event_mutation', 'true', true);
  delete from screening_v2.phone_call_events
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'dcap83-%'))
      or attempt_id in (
     select id from screening_v2.phone_call_attempts
      where engagement_id in (
        select id from screening_v2.phone_engagements
         where application_link_id in (
           select id from screening_v2.ashby_application_links
            where external_application_id like 'dcap83-%')));
  perform set_config('app.allow_phone_event_mutation', 'false', true);

  delete from screening_v2.job_queue
   where dedup_key in (
     select 'phone.dial:' || id::text from screening_v2.phone_call_attempts
      where engagement_id in (
        select id from screening_v2.phone_engagements
         where application_link_id in (
           select id from screening_v2.ashby_application_links
            where external_application_id like 'dcap83-%')));
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'dcap83-%'));
  delete from screening_v2.phone_appointments
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'dcap83-%'));
  delete from screening_v2.phone_engagements
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'dcap83-%');
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'dcap83-%');
  delete from screening_v2.ashby_operations
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'dcap83-%');
  delete from screening_v2.ashby_application_links where external_application_id like 'dcap83-%';
  delete from screening_v2.ashby_job_mappings      where external_job_id like 'dcap83-%';
  delete from screening_v2.consent_records
   where candidate_id in (
     select id from screening_v2.candidates where email like 'dcap83-%@example.test');
  delete from screening_v2.candidates where email like 'dcap83-%@example.test';

  raise notice 'dcap83: teardown complete — all dcap83 fixtures removed';
end;
$$;
