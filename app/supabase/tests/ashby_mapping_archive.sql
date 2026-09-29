\set ON_ERROR_STOP on
-- 0109: "Delete" archives a mapping. Every mock-backed API test stubs these
-- functions, so this file is where the archive rules first EXECUTE. Runs in
-- one rollback transaction against the fully migrated local database.
begin;
insert into screening_v2.roles (title) values ('0109 archive synthetic role');
select id as role_id from screening_v2.roles where title = '0109 archive synthetic role' \gset

do $$
declare
  v_role uuid := (select id from screening_v2.roles where title = '0109 archive synthetic role');
  v_actor uuid := '00000000-0000-4000-8000-000000000109';
  v_res jsonb; v_id uuid; v_row record; v_links integer;
begin
  -- A complete, ENABLED mapping cannot be archived: pause first.
  v_res := screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role, 'sql0109-ai', 'sql0109-ta',
    null, null, null, v_actor, 'manual', 24, 'paused', 'sql0109 label', v_actor);
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
  select archived_at, archived_by, status into v_row from screening_v2.ashby_job_mappings where id = v_id;
  if v_row.archived_at is null or v_row.archived_by <> v_actor then raise exception '0109 archive did not stamp archived_at/by'; end if;
  if not exists (select 1 from screening_v2.audit_events where target_id = v_id::text and metadata->>'action' = 'archive') then
    raise exception '0109 archive was not audited';
  end if;
  v_res := screening_v2.archive_ashby_job_mapping(v_id, v_actor);
  if v_res->>'status' <> 'ok' or not (v_res->>'already_archived')::boolean then raise exception '0109 second archive not idempotent: %', v_res; end if;

  -- History stays linked (the whole reason this is not a DELETE).
  select count(*) into v_links from screening_v2.ashby_application_links where job_mapping_id = v_id;
  if v_links <> 1 then raise exception '0109 archive unlinked history (% links)', v_links; end if;

  -- An archived mapping can never be enabled — by the function...
  v_res := screening_v2.set_ashby_mapping_status(v_id, 'enabled', null, v_actor);
  if v_res->>'status' <> 'archived' then raise exception '0109 set_status touched an archived mapping: %', v_res; end if;
  -- ...or by any direct writer (the CHECK).
  begin
    update screening_v2.ashby_job_mappings set status = 'enabled' where id = v_id;
    raise exception '0109 CHECK allowed an archived mapping to be enabled';
  exception when check_violation then null;
  end;

  -- Re-adding the same job RESTORES the archived row: same id, paused,
  -- un-archived, new role/stages applied, no unique violation.
  v_res := screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role, 'sql0109-ai-2', 'sql0109-ta-2',
    null, null, null, v_actor, 'manual', 24, 'paused', 'sql0109 restored', v_actor);
  if v_res->>'status' <> 'ok' or (v_res->>'id')::uuid <> v_id
     or (v_res->>'created')::boolean or not (v_res->>'restored')::boolean then
    raise exception '0109 re-add did not restore the archived row: %', v_res;
  end if;
  select archived_at, archived_by, status, ai_screening_stage_id, label into v_row from screening_v2.ashby_job_mappings where id = v_id;
  if v_row.archived_at is not null or v_row.archived_by is not null then raise exception '0109 restore left the row archived'; end if;
  if v_row.status <> 'paused' or v_row.ai_screening_stage_id <> 'sql0109-ai-2' or v_row.label <> 'sql0109 restored' then
    raise exception '0109 restore did not apply the new config: %', row_to_json(v_row);
  end if;
  -- A restored mapping enables through the normal Resume path again.
  v_res := screening_v2.set_ashby_mapping_status(v_id, 'enabled', null, v_actor);
  if v_res->>'status' <> 'ok' then raise exception '0109 restored mapping could not be enabled: %', v_res; end if;

  -- A create for a job with a LIVE (non-archived) mapping is still a conflict.
  begin
    perform screening_v2.upsert_ashby_job_mapping(null, 'sql0109-job', v_role, 'x', 'y',
      null, null, null, v_actor, 'manual', 24, 'paused', null, v_actor);
    raise exception '0109 duplicate create of a live mapping did not conflict';
  exception when unique_violation then null;
  end;

  -- Unknown id and missing actor answer, they do not throw.
  if screening_v2.archive_ashby_job_mapping(gen_random_uuid(), v_actor)->>'status' <> 'not_found' then
    raise exception '0109 unknown id not reported as not_found';
  end if;
  if screening_v2.archive_ashby_job_mapping(v_id, null)->>'status' <> 'actor_required' then
    raise exception '0109 missing actor not refused';
  end if;
end $$;

-- Browser roles can never call it.
do $$
begin
  if has_function_privilege('anon', 'screening_v2.archive_ashby_job_mapping(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'screening_v2.archive_ashby_job_mapping(uuid,uuid)', 'execute') then
    raise exception '0109 archive_ashby_job_mapping is executable by a browser role';
  end if;
end $$;
rollback;
