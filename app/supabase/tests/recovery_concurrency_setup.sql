-- =====================================================================
-- 0040 concurrency fixture — ONE machine-class `failed_review` ingestion,
-- created under CALLER-SUPPLIED identifiers and COMMITTED by this script
-- so that independent backends can each attempt to recover it.
--
-- The serialisation that 0040 relies on is a ROW LOCK — on the
-- application link first, then the ingestion. A row lock cannot be
-- observed from a single session, so this fixture exists to be contended
-- by `scripts/supabase-test.sh`, which parks a blocker on one of those
-- rows, waits until three `recover_ashby_ingestion_parse` sessions are
-- provably blocked on it, then releases them and runs
-- `recovery_concurrency_assert.sql`.
--
-- PARAMETERISED, because the harness runs one phase per lock and
-- `audit_events` is append-only (0007): a second phase reusing the first
-- phase's link id would inherit its audit row and make "exactly one
-- audit" unassertable. Each phase therefore gets its own link id and its
-- own external identifiers.
--
--   psql -v link_id=<uuid> -v tag=<slug> -f recovery_concurrency_setup.sql
--
-- psql does not interpolate `:vars` inside dollar-quoted bodies, so the
-- values are handed to the DO block through session GUCs.
--
-- Synthetic identifiers only; no candidate, no email, no real document.
-- =====================================================================

-- `\g /dev/null` keeps the parameter plumbing out of the suite's output.
select set_config('pol40c.link', :'link_id', false),
       set_config('pol40c.tag',  :'tag',     false) \g /dev/null

do $$
declare
  v_role uuid;
  v_map  uuid;
  v_link constant uuid := current_setting('pol40c.link')::uuid;
  v_tag  constant text := current_setting('pol40c.tag');
  v_res  jsonb;
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    raise exception 'pol40c: no seed role available';
  end if;

  -- Idempotent teardown first, so a re-run of the suite starts clean.
  -- Match on the fixture's stable EXTERNAL id as well as its uuid, so a
  -- half-finished earlier run cannot leave a row the unique
  -- (provider, external_application_id) constraint then rejects.
  delete from screening_v2.job_queue
   where dedup_key in (
     select 'ashby:ingestion:' || l.id::text
       from screening_v2.ashby_application_links l
      where l.id = v_link or l.external_application_id = v_tag || '-app');
  delete from screening_v2.ashby_operations
   where application_link_id in (
     select l.id from screening_v2.ashby_application_links l
      where l.id = v_link or l.external_application_id = v_tag || '-app');
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (
     select l.id from screening_v2.ashby_application_links l
      where l.id = v_link or l.external_application_id = v_tag || '-app');
  delete from screening_v2.ashby_application_links
   where id = v_link or external_application_id = v_tag || '-app';
  delete from screening_v2.ashby_job_mappings where external_job_id = v_tag || '-job';

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values (v_tag || '-job', v_role, '00000000-0000-4000-8000-0000000000ad',
          v_tag || '-ai', v_tag || '-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (id, external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle)
  values (v_link, v_tag || '-app', v_tag || '-job', v_map, repeat('h', 64));

  perform screening_v2.advance_ashby_ingestion(v_link, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'failed_review', null, null, null,
                                                'parse_timeout');
  if v_res->>'status' <> 'ok' then
    raise exception 'pol40c: fixture could not be rested in failed_review: %', v_res;
  end if;

  if (select attempts from screening_v2.ashby_resume_ingestions
       where application_link_id = v_link) <> 0 then
    raise exception 'pol40c: fixture must start with an unspent attempt budget';
  end if;

  -- Append-only audit rows from an earlier phase or run would make the
  -- "exactly one audit" assertion unfalsifiable, so refuse to start a
  -- phase whose link id has already been recovered.
  if exists (
    select 1 from screening_v2.audit_events
     where action = 'ashby_ingestion_parse_recovery'
       and metadata->>'application_link_id' = v_link::text
  ) then
    raise exception 'pol40c: link % already carries a recovery audit row; each phase needs a fresh link id', v_link;
  end if;

  raise notice 'pol40c: fixture % ready at % (failed_review / parse_timeout / attempts=0)', v_tag, v_link;
end;
$$;
