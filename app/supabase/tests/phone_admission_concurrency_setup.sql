-- =====================================================================
-- 0042 concurrency fixture — N phone engagements, each fully eligible
-- and COMMITTED by this script so independent backends can contend for
-- them.
--
-- Two invariants in 0042 are only observable under real contention, and
-- neither can be seen from a single session:
--
--   * the ADVISORY lock, which serialises admission so the ≤10 fleet cap
--     cannot be beaten by a count-then-insert race. `scripts/supabase-
--     test.sh` parks a blocker ON THAT LOCK, waits until every racer is
--     provably parked behind it, and only then releases them. If the RPC
--     did not take the lock the racers would sail straight past and the
--     wait would TIME OUT — which fails the run. That wait is the proof.
--   * the engagement ROW lock plus uq_phone_attempts_one_live, which
--     together make admission exactly-once for one engagement.
--
-- The relative ORDER of those locks (advisory first, then the
-- application link, then the engagement, then the attempt) is proven
-- separately and statically by the pg_get_functiondef assertions in
-- policy_tests.sql, because an order is a property of the code and not
-- of any one race.
--
--   psql -v tag=<slug> -v count=<n> -v ts=<timestamptz> \
--        -f phone_admission_concurrency_setup.sql
--
-- psql does not interpolate :vars inside dollar-quoted bodies, so the
-- values are handed to the DO block through session GUCs.
--
-- Synthetic identities only. No real candidate, no real number, and
-- nothing in 0042 can place a call.
-- =====================================================================

select set_config('pol42c.tag',   :'tag',   false),
       set_config('pol42c.count', :'count', false),
       set_config('pol42c.ts',    :'ts',    false) \g /dev/null

create schema if not exists _phone_race;
create table if not exists _phone_race.fixtures (
  tag           text    not null,
  idx           integer not null,
  engagement_id uuid    not null,
  primary key (tag, idx)
);

-- Removes one tagged race fixture and everything hanging off it. Lives
-- here rather than in the assert script so setup and teardown cannot
-- drift apart, and is called by BOTH: setup runs it first so a re-run
-- starts clean, and the assert script runs it last so the GOV-06
-- cardinality suite three sections later still sees an unpolluted
-- database.
create or replace function _phone_race.teardown(p_tag text, p_count integer)
returns void language plpgsql as $prt$
declare v_i integer; v_slug text; v_links uuid[]; v_engs uuid[]; v_cands uuid[];
begin
  for v_i in 1..p_count loop
    v_slug := p_tag || '-' || v_i;
    select coalesce(array_agg(id), '{}') into v_links
      from screening_v2.ashby_application_links where external_application_id = v_slug || '-app';
    select coalesce(array_agg(id), '{}') into v_engs
      from screening_v2.phone_engagements where application_link_id = any(v_links);
    select coalesce(array_agg(id), '{}') into v_cands
      from screening_v2.candidates where email = v_slug || '@example.test';

    perform set_config('app.allow_phone_event_mutation', 'true', true);
    delete from screening_v2.phone_call_events
     where engagement_id = any(v_engs)
        or attempt_id in (select id from screening_v2.phone_call_attempts
                           where engagement_id = any(v_engs));
    perform set_config('app.allow_phone_event_mutation', 'false', true);

    delete from screening_v2.job_queue
     where dedup_key in (select 'phone.dial:' || id::text
                           from screening_v2.phone_call_attempts
                          where engagement_id = any(v_engs));
    delete from screening_v2.phone_call_attempts where engagement_id = any(v_engs);
    delete from screening_v2.phone_appointments  where engagement_id = any(v_engs);
    delete from screening_v2.phone_engagements   where id = any(v_engs);
    delete from screening_v2.ashby_resume_ingestions where application_link_id = any(v_links);
    delete from screening_v2.ashby_operations        where application_link_id = any(v_links);
    delete from screening_v2.ashby_application_links where id = any(v_links);
    delete from screening_v2.ashby_job_mappings where external_job_id = v_slug || '-job';
    delete from screening_v2.consent_records where candidate_id = any(v_cands);
    delete from screening_v2.candidates where id = any(v_cands);
  end loop;
  delete from _phone_race.fixtures where tag = p_tag;
end;
$prt$;

do $$
declare
  v_tag   constant text        := current_setting('pol42c.tag');
  v_count constant integer     := current_setting('pol42c.count')::integer;
  v_ts    constant timestamptz := current_setting('pol42c.ts')::timestamptz;
  v_role  uuid;
  v_i     integer;
  v_slug  text;
  v_cand  uuid; v_map uuid; v_link uuid; v_eng uuid;
  v_states text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_s     text;
begin
  select id into v_role from screening_v2.roles order by id limit 1;
  if v_role is null then
    raise exception 'pol42c: no seed role available';
  end if;

  -- Idempotent teardown first, so a re-run starts clean and cannot trip
  -- the unique (provider, external_application_id) constraint.
  perform _phone_race.teardown(v_tag, v_count);

  -- Every lease left behind by an earlier section is drained, so the
  -- fleet the racers contend for starts genuinely empty and a capacity
  -- assertion means what it says.
  perform screening_v2.reclaim_phone_attempt_leases(500, v_ts);

  for v_i in 1..v_count loop
    v_slug := v_tag || '-' || v_i;

    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'race ' || v_slug, v_slug || '@example.test',
            '+91999' || lpad((7000000 + v_i)::text, 7, '0'), true)
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

    foreach v_s in array v_states loop
      perform screening_v2.advance_ashby_ingestion(v_link, v_s, null, null, null, null);
    end loop;

    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, state)
    values (v_link, v_cand, v_role, 'eligible')
    returning id into v_eng;

    insert into _phone_race.fixtures (tag, idx, engagement_id) values (v_tag, v_i, v_eng);
  end loop;

  raise notice 'pol42c: % eligible engagement(s) ready for tag % at %', v_count, v_tag, v_ts;
end;
$$;
