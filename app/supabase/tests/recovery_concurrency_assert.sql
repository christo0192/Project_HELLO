-- =====================================================================
-- 0040 concurrency assertions — run AFTER three `recover_ashby_ingestion_parse`
-- sessions, proven blocked on the same row lock, have been released to
-- contend for the fixture created by `recovery_concurrency_setup.sql`.
--
-- The shell harness asserts two things this script cannot see: that all
-- three sessions were genuinely PARKED on a lock before the blocker was
-- released (the proof that the lock exists and is the serialiser), and
-- the three RETURNED statuses (exactly one `ok`, two `not_recoverable`).
--
-- This script asserts the DURABLE consequences, which is where a
-- serialisation defect would actually show up:
--
--   * ONE attempt charged — not three; the bounded budget is the whole
--     point of the audited door;
--   * ONE audit row — a second would make the retry history untrue;
--   * ONE live `ashby.ingestion` job — a duplicate would re-download,
--     re-scan and re-parse the same resume;
--   * the row genuinely `queued`, i.e. the winner really did the work.
--
-- Parameterised to match the setup, one link id per phase:
--   psql -v link_id=<uuid> -v tag=<slug> -f recovery_concurrency_assert.sql
--
-- Raises (and therefore fails the suite) on any violation.
-- =====================================================================

-- `\g /dev/null` keeps the parameter plumbing out of the suite's output.
select set_config('pol40c.link', :'link_id', false),
       set_config('pol40c.tag',  :'tag',     false) \g /dev/null

do $$
declare
  v_link  constant uuid := current_setting('pol40c.link')::uuid;
  v_tag   constant text := current_setting('pol40c.tag');
  v_att   integer;
  v_state text;
  v_jobs  integer;
  v_audits integer;
  v_payload jsonb;
begin
  select attempts, state into v_att, v_state
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  if v_att is null then
    raise exception 'pol40c: the concurrency fixture is missing';
  end if;

  select count(*) into v_jobs
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link::text
     and status in ('pending', 'active', 'delayed');

  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link::text;

  select payload into v_payload
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link::text
   limit 1;

  if v_state <> 'queued' then
    raise exception 'pol40c FAIL: expected state=queued after the race, got %', v_state;
  end if;
  if v_att <> 1 then
    raise exception 'pol40c FAIL: expected exactly ONE attempt charged, got %', v_att;
  end if;
  if v_audits <> 1 then
    raise exception 'pol40c FAIL: expected exactly ONE audit row, got %', v_audits;
  end if;
  if v_jobs <> 1 then
    raise exception 'pol40c FAIL: expected exactly ONE live ashby.ingestion job, got %', v_jobs;
  end if;
  if v_payload <> jsonb_build_object('provider', 'ashby', 'applicationLinkId', v_link::text) then
    raise exception 'pol40c FAIL: the raced job carries an unexpected payload: %', v_payload;
  end if;

  raise notice 'pol40c PASS (%): three CONTENDING recoveries charged 1 attempt, wrote 1 audit row and admitted exactly 1 live ashby.ingestion job', v_tag;

  -- Teardown. Audit rows are append-only (0007) and deliberately left
  -- behind — which is exactly why each phase uses its own link id.
  delete from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link::text;
  delete from screening_v2.ashby_operations where application_link_id = v_link;
  delete from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  delete from screening_v2.ashby_application_links where id = v_link;
  delete from screening_v2.ashby_job_mappings where external_job_id = v_tag || '-job';
end;
$$;
