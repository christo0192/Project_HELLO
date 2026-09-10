-- =====================================================================
-- 0094 fixture — the fleet daily cap and the suppression write path.
--
-- Seeds FOUR fully-eligible phone engagements on ONE IST day, using the
-- house recipe (candidate -> consent -> job mapping -> application link ->
-- ingestion `ready` -> engagement `eligible`) so `admit_phone_attempt`
-- reaches the new gate rather than being refused earlier:
--
--   * fleet94-a, fleet94-b — spend the (overridden) fleet budget.
--   * fleet94-c            — the engagement the cap must REFUSE.
--   * fleet94-d            — parked in `reconnecting`, to prove a
--                            reconnect is EXCLUDED from the cap.
--   * fleet94-e            — SHARES fleet94-c's phone number. The
--                            household/reassigned-line case: proves a
--                            release scoped to one candidate cannot
--                            destroy the other's opt-out.
--   * fleet94-f            — a spare eligible engagement for the
--                            `scheduled` and `no_answer_retry` paths.
--
-- THE FROZEN INSTANT IS ON ITS OWN DATE. 2026-09-05 IST appears in no
-- other fixture in `scripts/supabase-test.sh` — 0083's daily-cap suite
-- sits on 2026-09-06 and the admission-concurrency fixtures on
-- 2026-09-10/11/12 — so the fleet-wide count this migration introduces
-- cannot be perturbed by another suite's rows, nor perturb theirs. The
-- real control is the exclusivity guard below, which FAILS the suite if
-- the date is ever shared; this note only records why it was chosen.
-- Noon IST is inside the 09:00-21:00 window 0092 restored, so the instant
-- stays valid without depending on the 0064/0085 temporary 24/7 extension.
--
-- Run (wired into scripts/supabase-test.sh; standalone form below):
--   psql -v ON_ERROR_STOP=1 -f phone_dial_scope_fleet_cap_setup.sql
--   psql -v ON_ERROR_STOP=1 -f phone_dial_scope_fleet_cap_assert.sql
--
-- Synthetic identities only. No real candidate, number, or document.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_now   constant timestamptz := '2026-09-05T12:00:00+05:30'::timestamptz;
  v_role  uuid;
  v_slug  text;
  v_cand  uuid; v_map uuid; v_link uuid; v_eng uuid;
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_s     text;
  v_state text;
begin
  select id into v_role from screening_v2.roles order by id limit 1;
  if v_role is null then
    raise exception 'fleet94: no seed role available';
  end if;

  -- ── Idempotent teardown first, so a re-run starts clean. ──────────────
  -- Same order as the dcap83 teardown: attempts+events before jobs before
  -- engagements before links before mappings before consent before
  -- candidates. Scoped to the 'fleet94-%' slug family.
  perform set_config('app.allow_phone_event_mutation', 'true', true);
  delete from screening_v2.phone_call_events
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'fleet94-%'))
      or attempt_id in (
     select id from screening_v2.phone_call_attempts
      where engagement_id in (
        select id from screening_v2.phone_engagements
         where application_link_id in (
           select id from screening_v2.ashby_application_links
            where external_application_id like 'fleet94-%')));
  perform set_config('app.allow_phone_event_mutation', 'false', true);

  delete from screening_v2.job_queue
   where dedup_key in (
     select 'phone.dial:' || id::text from screening_v2.phone_call_attempts
      where engagement_id in (
        select id from screening_v2.phone_engagements
         where application_link_id in (
           select id from screening_v2.ashby_application_links
            where external_application_id like 'fleet94-%')));
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'fleet94-%'));
  delete from screening_v2.phone_appointments
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'fleet94-%'));
  delete from screening_v2.phone_engagements
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'fleet94-%');
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'fleet94-%');
  delete from screening_v2.ashby_operations
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'fleet94-%');
  delete from screening_v2.ashby_application_links where external_application_id like 'fleet94-%';
  delete from screening_v2.ashby_job_mappings      where external_job_id like 'fleet94-%';
  delete from screening_v2.phone_suppressions
   where candidate_id in (
     select id from screening_v2.candidates where email like 'fleet94-%@example.test');
  delete from screening_v2.consent_records
   where candidate_id in (
     select id from screening_v2.candidates where email like 'fleet94-%@example.test');
  delete from screening_v2.candidates where email like 'fleet94-%@example.test';

  -- Nothing seeded on this IST date may survive from an earlier run, or the
  -- fleet count the assertions reason about would start above zero.
  if exists (select 1 from screening_v2.phone_call_attempts
              where ist_date = screening_v2.phone_ist_date(v_now)) then
    raise exception 'fleet94: IST date % is not exclusive to this suite (% attempts already present)',
      screening_v2.phone_ist_date(v_now),
      (select count(*) from screening_v2.phone_call_attempts
        where ist_date = screening_v2.phone_ist_date(v_now));
  end if;

  for v_s in select unnest(array['a','b','c','d','e','f']) loop
    v_slug := 'fleet94-' || v_s;

    -- Distinct, valid +91 mobiles — EXCEPT `e`, which deliberately shares
    -- `c`'s number. `phone_suppressions` is keyed on the digest, so that pair
    -- is the household/reassigned-line case 0042 says the keying exists for,
    -- and it is the only way to test that a release cannot reach across it.
    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'fleet94 ' || v_s, v_slug || '@example.test',
            '+91988' || lpad((7100000 + (
              abs(hashtext(case when v_s = 'e' then 'fleet94-c' else v_slug end)) % 800000
            ))::text, 7, '0'), true)
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

    foreach v_state in array v_states loop
      perform screening_v2.advance_ashby_ingestion(v_link, v_state, null, null, null, null);
    end loop;

    -- `d` is parked in `reconnecting` because `admit_phone_attempt` refuses
    -- a `reconnect` from any other state (`kind_not_admissible`), and the
    -- reconnect exclusion is exactly what this suite must prove.
    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, state)
    values (v_link, v_cand, v_role,
            case when v_s = 'd' then 'reconnecting' else 'eligible' end)
    returning id into v_eng;
  end loop;

  raise notice 'fleet94: 6 engagements ready (ist_date %) at %',
    screening_v2.phone_ist_date(v_now), v_now;
end;
$$;
