\set ON_ERROR_STOP on
-- 0109: "Delete" archives a mapping. Every mock-backed API test stubs these
-- functions, so this file is where the archive rules first EXECUTE. Runs in
-- one rollback transaction against the fully migrated local database.
begin;
insert into screening_v2.roles (title) values ('0109 archive role A'), ('0109 archive role B');

do $$
declare
  v_role_a uuid := (select id from screening_v2.roles where title = '0109 archive role A');
  v_role_b uuid := (select id from screening_v2.roles where title = '0109 archive role B');
  v_actor uuid := '00000000-0000-4000-8000-000000000109';
  v_res jsonb; v_id uuid; v_new uuid; v_third uuid; v_row record; v_links integer;
begin
  -- A complete, ENABLED mapping cannot be archived: pause first.
  v_res := screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role_a, 'sql0109-ai', 'sql0109-ta',
    'sql0109-form', null, null, v_actor, 'manual', 24, 'paused', 'sql0109 label', v_actor);
  if v_res->>'status' <> 'ok' or (v_res->>'created')::boolean is not true then raise exception '0109 setup create failed: %', v_res; end if;
  v_id := (v_res->>'id')::uuid;
  v_res := screening_v2.set_ashby_mapping_status(v_id, 'enabled', null, v_actor);
  if v_res->>'status' <> 'ok' then raise exception '0109 setup enable failed: %', v_res; end if;

  v_res := screening_v2.archive_ashby_job_mapping(v_id, v_actor);
  if v_res->>'status' <> 'mapping_enabled' then raise exception '0109 archived an ENABLED mapping: %', v_res; end if;
  if (select archived_at from screening_v2.ashby_job_mappings where id = v_id) is not null then
    raise exception '0109 refused archive still stamped archived_at';
  end if;

  -- History that must survive: a linked application.
  insert into screening_v2.ashby_application_links (external_application_id, external_job_id, job_mapping_id)
    values ('sql0109-app', 'sql0109-job', v_id);

  -- Paused → archive succeeds, is audited, and is idempotent.
  perform screening_v2.set_ashby_mapping_status(v_id, 'paused', 'sql0109 pause', v_actor);
  v_res := screening_v2.archive_ashby_job_mapping(v_id, v_actor);
  if v_res->>'status' <> 'ok' or (v_res->>'already_archived')::boolean then raise exception '0109 archive failed: %', v_res; end if;
  select archived_at, archived_by into v_row from screening_v2.ashby_job_mappings where id = v_id;
  if v_row.archived_at is null or v_row.archived_by <> v_actor then raise exception '0109 archive did not stamp archived_at/by'; end if;
  if not exists (select 1 from screening_v2.audit_events where target_id = v_id::text and metadata->>'action' = 'archive') then
    raise exception '0109 archive was not audited';
  end if;
  v_res := screening_v2.archive_ashby_job_mapping(v_id, v_actor);
  if v_res->>'status' <> 'ok' or not (v_res->>'already_archived')::boolean then raise exception '0109 second archive not idempotent: %', v_res; end if;

  -- History stays linked (the whole reason this is not a DELETE).
  select count(*) into v_links from screening_v2.ashby_application_links where job_mapping_id = v_id;
  if v_links <> 1 then raise exception '0109 archive unlinked history (% links)', v_links; end if;

  -- An archived mapping is FROZEN: no status change through the function...
  v_res := screening_v2.set_ashby_mapping_status(v_id, 'enabled', null, v_actor);
  if v_res->>'status' <> 'archived' then raise exception '0109 set_status touched an archived mapping: %', v_res; end if;
  -- ...no edit addressed to it by id...
  v_res := screening_v2.upsert_ashby_job_mapping(v_id, 'sql0109-job', v_role_b, 'x', 'y',
    null, null, null, v_actor, 'manual', 24, 'paused', null, v_actor);
  if v_res->>'status' <> 'archived' then raise exception '0109 upsert edited an archived mapping: %', v_res; end if;
  -- ...and no direct writer can enable it (the CHECK).
  begin
    update screening_v2.ashby_job_mappings set status = 'enabled' where id = v_id;
    raise exception '0109 CHECK allowed an archived mapping to be enabled';
  exception when check_violation then null;
  end;

  -- Re-adding the same job under a DIFFERENT role creates a NEW row. The
  -- archived row keeps its role, form and history — nothing is re-pointed.
  v_res := screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role_b, 'sql0109-ai-2', 'sql0109-ta-2',
    null, null, null, v_actor, 'manual', 24, 'paused', 'sql0109 re-added', v_actor);
  if v_res->>'status' <> 'ok' or not (v_res->>'created')::boolean or (v_res->>'id')::uuid = v_id then
    raise exception '0109 re-add did not create a new row: %', v_res;
  end if;
  v_new := (v_res->>'id')::uuid;
  select role_id, feedback_form_id, archived_at, label into v_row from screening_v2.ashby_job_mappings where id = v_id;
  if v_row.role_id <> v_role_a or v_row.feedback_form_id <> 'sql0109-form' or v_row.archived_at is null or v_row.label <> 'sql0109 label' then
    raise exception '0109 re-add rewrote the archived row: %', row_to_json(v_row);
  end if;
  select count(*) into v_links from screening_v2.ashby_application_links where job_mapping_id = v_id;
  if v_links <> 1 then raise exception '0109 re-add moved history off the archived row'; end if;
  select archived_at, role_id, status into v_row from screening_v2.ashby_job_mappings where id = v_new;
  if v_row.archived_at is not null or v_row.role_id <> v_role_b or v_row.status <> 'paused' then
    raise exception '0109 re-added row is wrong: %', row_to_json(v_row);
  end if;
  -- The new row enables through the normal Resume path.
  v_res := screening_v2.set_ashby_mapping_status(v_new, 'enabled', null, v_actor);
  if v_res->>'status' <> 'ok' then raise exception '0109 re-added mapping could not be enabled: %', v_res; end if;

  -- Exactly one LIVE mapping per job: a second create for it still conflicts.
  begin
    perform screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role_a, 'x', 'y',
      null, null, null, v_actor, 'manual', 24, 'paused', null, v_actor);
    raise exception '0109 duplicate create of a live mapping did not conflict';
  exception when unique_violation then null;
  end;

  -- A job can be deleted and re-added more than once: archived rows are
  -- exempt from uniqueness, live rows are not.
  perform screening_v2.set_ashby_mapping_status(v_new, 'paused', 'sql0109 pause 2', v_actor);
  v_res := screening_v2.archive_ashby_job_mapping(v_new, v_actor);
  if v_res->>'status' <> 'ok' then raise exception '0109 second-generation archive failed: %', v_res; end if;
  v_res := screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role_a, 'sql0109-ai-3', 'sql0109-ta-3',
    null, null, null, v_actor, 'manual', 24, 'paused', null, v_actor);
  if v_res->>'status' <> 'ok' then raise exception '0109 third-generation create failed: %', v_res; end if;
  v_third := (v_res->>'id')::uuid;
  if (select count(*) from screening_v2.ashby_job_mappings where external_job_id = 'sql0109-job') <> 3
     or (select count(*) from screening_v2.ashby_job_mappings where external_job_id = 'sql0109-job' and archived_at is null) <> 1 then
    raise exception '0109 generations wrong: expected 3 rows, exactly 1 live';
  end if;
  if v_third in (v_id, v_new) then raise exception '0109 third generation reused an archived id'; end if;

  -- Unknown id and missing actor answer, they do not throw.
  if screening_v2.archive_ashby_job_mapping(gen_random_uuid(), v_actor)->>'status' <> 'not_found' then
    raise exception '0109 unknown id not reported as not_found';
  end if;
  if screening_v2.archive_ashby_job_mapping(v_third, null)->>'status' <> 'actor_required' then
    raise exception '0109 missing actor not refused';
  end if;
end $$;

-- Privilege posture: SECURITY DEFINER with a pinned search_path, executable
-- by service_role and by no browser role — the same posture as 0106.
do $$
declare v_fn text := 'screening_v2.archive_ashby_job_mapping(uuid,uuid)';
begin
  if not (select prosecdef from pg_proc where oid = v_fn::regprocedure) then
    raise exception '0109 archive_ashby_job_mapping is not SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_proc p, unnest(p.proconfig) c
                  where p.oid = v_fn::regprocedure and c like 'search_path=%') then
    raise exception '0109 archive_ashby_job_mapping does not pin search_path';
  end if;
  if not has_function_privilege('service_role', v_fn, 'execute') then
    raise exception '0109 archive_ashby_job_mapping is not executable by service_role';
  end if;
  if has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception '0109 archive_ashby_job_mapping is executable by a browser role';
  end if;
  -- The old table-wide UNIQUE is gone and the live-only index replaces it.
  if exists (select 1 from pg_constraint where conname = 'uq_ashby_job_mappings_provider_job') then
    raise exception '0109 left the table-wide unique constraint in place';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'screening_v2'
                  and indexname = 'uq_ashby_job_mappings_live_job'
                  and indexdef ilike '%unique%' and indexdef ilike '%archived_at is null%') then
    raise exception '0109 live-only unique index missing or not partial';
  end if;
end $$;
rollback;
