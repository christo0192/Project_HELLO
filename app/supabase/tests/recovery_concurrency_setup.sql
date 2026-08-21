-- =====================================================================
-- 0040 concurrency fixture — ONE machine-class `failed_review` ingestion,
-- created under FIXED identifiers and COMMITTED by this script so that
-- three independent backends can each attempt to recover it.
--
-- The serialisation that 0040 relies on is a ROW LOCK on the application
-- link. A row lock cannot be observed from a single session, so this
-- fixture exists to be raced by `scripts/supabase-test.sh`, which fires
-- three concurrent `recover_ashby_ingestion_parse` calls against it and
-- then runs `recovery_concurrency_assert.sql`.
--
-- Synthetic identifiers only; no candidate, no email, no real document.
-- =====================================================================

do $$
declare
  v_role uuid;
  v_map  uuid;
  v_link constant uuid := '40000000-0000-4000-8000-0000000000c1';
  v_res  jsonb;
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    raise exception 'pol40c: no seed role available';
  end if;

  -- Idempotent teardown first, so a re-run of the suite starts clean.
  -- Match on the fixture's stable EXTERNAL id as well as its fixed uuid, so a
  -- half-finished earlier run cannot leave a row the unique
  -- (provider, external_application_id) constraint then rejects.
  delete from screening_v2.job_queue
   where dedup_key in (
     select 'ashby:ingestion:' || l.id::text
       from screening_v2.ashby_application_links l
      where l.id = v_link or l.external_application_id = 'pol40c-app');
  delete from screening_v2.ashby_operations
   where application_link_id in (
     select l.id from screening_v2.ashby_application_links l
      where l.id = v_link or l.external_application_id = 'pol40c-app');
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (
     select l.id from screening_v2.ashby_application_links l
      where l.id = v_link or l.external_application_id = 'pol40c-app');
  delete from screening_v2.ashby_application_links
   where id = v_link or external_application_id = 'pol40c-app';
  delete from screening_v2.ashby_job_mappings where external_job_id = 'pol40c-job';

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('pol40c-job', v_role, '00000000-0000-4000-8000-0000000000ad',
          'pol40c-ai', 'pol40c-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (id, external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle)
  values (v_link, 'pol40c-app', 'pol40c-job', v_map, repeat('h', 64));

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

  raise notice 'pol40c: fixture ready at % (failed_review / parse_timeout / attempts=0)', v_link;
end;
$$;
