-- =====================================================================
-- 0083 daily-cap infra-defer fixture — THREE fully-eligible phone
-- engagements on the SAME IST day, each carrying a prior same-day
-- `initial` attempt that differs ONLY in its terminal shape, so
-- phone_daily_cap_infra_defer_assert.sql can prove the 0083 narrowing
-- discriminates by `abandon_reason`, not by `state='abandoned'` alone:
--
--   * Engagement A — an INFRA-DEFERRED abandoned attempt
--     (state='abandoned', abandon_reason='infra_deferred'). This is the
--     ONE row the narrowed per-IST-day index AND admission's two daily
--     pre-checks EXCLUDE. So A can redial the SAME IST day: a fresh
--     admitted-shaped insert must NOT trip uq_phone_attempts_one_per_ist_day,
--     and admit_phone_attempt must NOT return 'daily_attempt_exists'.
--
--   * Engagement B — a RECLAIM-abandoned attempt (state='abandoned',
--     abandon_reason=NULL — exactly what 0071 reclaim_phone_attempt_leases
--     leaves: it never writes abandon_reason). A call that rang/answered
--     and whose worker then crashed: the anti-harassment budget is SPENT,
--     so the day STAYS charged. A second same-day admit is REFUSED
--     'daily_attempt_exists'.
--
--   * Engagement C — a COMPLETED/ended attempt (state='ended'). A real
--     call still holds the day. A second same-day admit is REFUSED
--     'daily_attempt_exists'.
--
-- Each engagement is seeded fully eligible via the known-good concurrency
-- recipe (candidate -> consent -> job mapping -> application link ->
-- ingestion `ready` -> engagement `eligible`), so admit_phone_attempt can
-- reach every gate. The IST window is 24/7 through 2026-09-06 (0064), and
-- the frozen instant is fixed inside that window so the assert's admit
-- calls are not refused `window_closed`.
--
-- Run (wired into scripts/supabase-test.sh; standalone form below):
--   psql -v ON_ERROR_STOP=1 -f phone_daily_cap_infra_defer_setup.sql
--   psql -v ON_ERROR_STOP=1 -f phone_daily_cap_infra_defer_assert.sql
--
-- Synthetic identities only. No real candidate, number, or document.
-- =====================================================================
\set ON_ERROR_STOP on

-- The frozen instant every fixture and assertion shares. Fixed on the last
-- inclusive day of the 0064 temporary 24/7 window (2026-09-06, Asia/Kolkata),
-- so phone_ist_window_open(now) is true no matter the wall-clock hour when CI
-- runs and admit_phone_attempt reaches 'ok' rather than 'window_closed'.
select set_config('dcap83.now', '2026-09-06T12:00:00+05:30', false) \g /dev/null

do $$
declare
  v_now   constant timestamptz := current_setting('dcap83.now')::timestamptz;
  v_role  uuid;
  v_slug  text;
  v_cand  uuid; v_map uuid; v_link uuid; v_eng uuid;
  v_ist   date;
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_s     text;
  v_state text;
begin
  select id into v_role from screening_v2.roles order by id limit 1;
  if v_role is null then
    raise exception 'dcap83: no seed role available';
  end if;

  v_ist := screening_v2.phone_ist_date(v_now);

  -- ── Idempotent teardown first, so a re-run starts clean. ──────────────
  -- Order: attempts+events before jobs before engagements before links
  -- before mappings before consent before candidates. Mirrors the
  -- concurrency teardown; scoped to the 'dcap83-%' slug family.
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

  -- ── Build each engagement's fully-eligible chain, then its prior
  --    same-day attempt in the terminal shape its slug names. ───────────
  for v_s in select unnest(array['a-infra','b-reclaim','c-ended']) loop
    v_slug := 'dcap83-' || v_s;

    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'dcap83 ' || v_s, v_slug || '@example.test',
            '+91999' || lpad((8100000 + (abs(hashtext(v_s)) % 800000))::text, 7, '0'), true)
    returning id into v_cand;

    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, 'granted',
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1');

    insert into screening_v2.ashby_job_mappings
      (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
       status, delivery_mode)
    values (v_slug || '-job', v_role, '00000000-0000-4000-8000-0000000000ad',
            v_slug || '-ai', v_slug || '-ta', 'enabled', 'manual')
    returning id into v_map;

    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id,
       external_resume_file_handle, candidate_id)
    values (v_slug || '-app', v_slug || '-job', v_map, repeat('h', 64), v_cand)
    returning id into v_link;

    -- Drive ingestion to `ready` through every legal state, IN ORDER (the
    -- ingestion state machine rejects an out-of-order jump), exactly as the
    -- concurrency setup does.
    foreach v_state in array v_states loop
      perform screening_v2.advance_ashby_ingestion(v_link, v_state, null, null, null, null);
    end loop;

    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, state)
    values (v_link, v_cand, v_role, 'eligible')
    returning id into v_eng;

    -- The prior same-day attempt. Every NOT NULL column is set explicitly:
    -- engagement_id, attempt_seq(=1), epoch(=engagement epoch, 0), kind,
    -- state, ist_date, prior_engagement_state('eligible'), admitted_at,
    -- created_at. There is NO insert trigger on phone_call_attempts (only
    -- phone_call_events / engagement-transition / appointment triggers), so
    -- a direct insert — the same shape admit itself writes — is legal.
    --   * a-infra : abandoned + abandon_reason='infra_deferred'  (EXCLUDED)
    --   * b-reclaim: abandoned + abandon_reason=NULL             (charged)
    --   * c-ended : ended                                        (charged)
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, outcome_class,
       abandon_reason, ist_date, prior_engagement_state,
       admitted_at, ended_at, created_at)
    values (
      v_eng, 1, 0, 'initial',
      case when v_slug = 'dcap83-c-ended' then 'ended' else 'abandoned' end,
      case when v_slug = 'dcap83-c-ended' then 'completed' else null end,
      case when v_slug = 'dcap83-a-infra' then 'infra_deferred' else null end,
      v_ist, 'eligible',
      v_now - interval '600 seconds',
      v_now - interval '540 seconds',
      v_now - interval '600 seconds');
  end loop;

  raise notice 'dcap83: 3 eligible engagements + prior same-day attempts ready (ist_date %) at %', v_ist, v_now;
end;
$$;
