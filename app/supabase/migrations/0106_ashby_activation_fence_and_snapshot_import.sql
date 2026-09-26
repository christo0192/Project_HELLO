-- =====================================================================
-- 0106 — timestamp-based Ashby intake admission + explicit backlog runs
--
-- Mapping enable/re-enable/repoint is future-stage-entry only. The provider's
-- application.listHistory enteredStageAt is the admission evidence; this
-- migration never uses application createdAt, updatedAt, or submittedAt.
-- Backlog imports are separate, counted, mapping-scoped, admin-confirmed
-- runs. All objects are service-role-only and carry opaque ids only.
-- =====================================================================

alter table screening_v2.ashby_job_mappings
  add column if not exists activation_at timestamptz,
  add column if not exists activation_epoch bigint not null default 0;

-- Existing enabled mappings are initialized at rollout. Their prior stage
-- history is therefore outside the fence; a later real enable/re-enable or
-- job/stage repoint stamps a new instant and increments the epoch.
update screening_v2.ashby_job_mappings
   set activation_at = coalesce(activation_at, now()),
       activation_epoch = greatest(activation_epoch, 1)
 where provider = 'ashby' and status = 'enabled';

comment on column screening_v2.ashby_job_mappings.activation_at is
  'Instant from which application.listHistory current-stage entries may be admitted. Stamped only on real enable/re-enable/job/stage repoint.';
comment on column screening_v2.ashby_job_mappings.activation_epoch is
  'Monotonic activation generation. Snapshot confirmations bind this generation and config version.';

-- Explicit previews are immutable exact-id snapshots. A snapshot is bounded
-- by the API and checked again here; it is never tenant-global permission.
create table if not exists screening_v2.ashby_mapping_snapshot_imports (
  id                  uuid primary key default gen_random_uuid(),
  mapping_id          uuid not null references screening_v2.ashby_job_mappings(id) on delete restrict,
  external_job_id     text not null,
  stage_id            text not null,
  config_version      integer not null,
  activation_epoch    bigint not null,
  actor_id            uuid not null,
  snapshot            jsonb not null,
  expected_count      integer not null,
  status              text not null default 'preview',
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  confirmed_actor_id  uuid,
  queued_count        integer not null default 0,
  constraint chk_ashby_snapshot_status check (status in ('preview','queued','expired','failed')),
  constraint chk_ashby_snapshot_count check (expected_count between 0 and 500),
  constraint chk_ashby_snapshot_queue_count check (queued_count between 0 and 500)
);

alter table screening_v2.ashby_mapping_snapshot_imports enable row level security;
revoke all on screening_v2.ashby_mapping_snapshot_imports from anon, authenticated, public;
grant all privileges on screening_v2.ashby_mapping_snapshot_imports to service_role;

create or replace function screening_v2.create_ashby_snapshot_preview(
  p_mapping_id uuid, p_external_job_id text, p_stage_id text,
  p_config_version integer, p_activation_epoch bigint, p_actor_id uuid,
  p_snapshot jsonb, p_expected_count integer, p_expires_at timestamptz
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, screening_v2 as $$
declare v_id uuid; v_item jsonb; v_seen text[] := '{}'; v_app text; v_job text; v_stage text;
begin
  if p_mapping_id is null or p_actor_id is null or p_snapshot is null
     or jsonb_typeof(p_snapshot) <> 'array' or p_expected_count is null
     or p_expected_count < 0 or p_expected_count > 500
     or jsonb_array_length(p_snapshot) <> p_expected_count
     or p_expires_at is null or p_expires_at <= now()
     or p_external_job_id is null or p_stage_id is null then
    return jsonb_build_object('status','invalid_preview');
  end if;
  if not exists (select 1 from screening_v2.ashby_job_mappings m where m.id = p_mapping_id and m.provider = 'ashby'
                 and m.status = 'enabled' and m.external_job_id = p_external_job_id
                 and m.ai_screening_stage_id = p_stage_id and m.config_version = p_config_version
                 and m.activation_epoch = p_activation_epoch) then
    return jsonb_build_object('status','mapping_changed');
  end if;
  for v_item in select value from jsonb_array_elements(p_snapshot) loop
    v_app := v_item->>'applicationId'; v_job := v_item->>'jobId'; v_stage := v_item->>'stageId';
    if v_app is null or length(v_app) < 1 or length(v_app) > 256
       or v_job is distinct from p_external_job_id or v_stage is distinct from p_stage_id
       or v_app = any(v_seen) then return jsonb_build_object('status','invalid_snapshot'); end if;
    v_seen := array_append(v_seen, v_app);
  end loop;
  insert into screening_v2.ashby_mapping_snapshot_imports
    (mapping_id, external_job_id, stage_id, config_version, activation_epoch, actor_id, snapshot, expected_count, expires_at)
  values (p_mapping_id, p_external_job_id, p_stage_id, p_config_version, p_activation_epoch, p_actor_id, p_snapshot, p_expected_count, p_expires_at)
  returning id into v_id;
  return jsonb_build_object('status','ok','run_id',v_id,'expected_count',p_expected_count,'expires_at',p_expires_at);
end; $$;

create or replace function screening_v2.confirm_ashby_snapshot_import(
  p_run_id uuid, p_mapping_id uuid, p_expected_count integer, p_actor_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, screening_v2 as $$
declare r screening_v2.ashby_mapping_snapshot_imports%rowtype; m screening_v2.ashby_job_mappings%rowtype;
  v_item jsonb; v_app text; v_stage text; v_dedup text; v_status text; v_queued integer := 0; v_receipt uuid; v_job_id uuid;
  v_payload jsonb; v_now timestamptz := now();
begin
  if p_run_id is null or p_actor_id is null then return jsonb_build_object('status','invalid_confirmation'); end if;
  select * into r from screening_v2.ashby_mapping_snapshot_imports where id = p_run_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if r.actor_id is distinct from p_actor_id then return jsonb_build_object('status','actor_mismatch'); end if;
  if r.status = 'queued' then return jsonb_build_object('status','already_confirmed','run_id',r.id,'queued_count',r.queued_count); end if;
  if r.status <> 'preview' then return jsonb_build_object('status',r.status); end if;
  if r.expires_at <= v_now then update screening_v2.ashby_mapping_snapshot_imports set status='expired' where id=r.id; return jsonb_build_object('status','expired'); end if;
  if p_mapping_id is distinct from r.mapping_id then return jsonb_build_object('status','mapping_changed'); end if;
  if p_expected_count is distinct from r.expected_count then return jsonb_build_object('status','count_mismatch'); end if;
  select * into m from screening_v2.ashby_job_mappings where id=r.mapping_id for update;
  if not found or m.status <> 'enabled' or m.external_job_id is distinct from r.external_job_id
     or m.ai_screening_stage_id is distinct from r.stage_id or m.config_version <> r.config_version
     or m.activation_epoch <> r.activation_epoch then return jsonb_build_object('status','mapping_changed'); end if;
  for v_item in select value from jsonb_array_elements(r.snapshot) loop
    v_app := v_item->>'applicationId'; v_stage := v_item->>'stageId';
    -- Same bounded stageDedupId identity as webhook/reconciliation producers.
    v_dedup := left('stage:' || v_app || ':' || v_stage, 256);
    insert into screening_v2.ashby_event_receipts(provider, webhook_action_id, action, metadata)
      values ('ashby', v_dedup, 'candidateStageChange', jsonb_build_object('source','explicit_backlog','run_id',r.id,'mapping_id',r.mapping_id))
      on conflict (provider, webhook_action_id, action) do nothing;
    select id, status into v_receipt, v_status from screening_v2.ashby_event_receipts
      where provider='ashby' and webhook_action_id=v_dedup and action='candidateStageChange';
    -- A processed receipt proves only that a previous signal handed off (or
    -- conditionally skipped); it does not prove an import materialized. A
    -- confirmed snapshot reopens that handoff, including when its old queue
    -- job has completed. The worker must still recheck mapping and snapshot.
    if v_status = 'processed' then
      update screening_v2.ashby_event_receipts set status='received', processed_at=null
        where id=v_receipt and status='processed';
    end if;
    v_payload := jsonb_build_object('provider','ashby','webhookActionId',v_dedup,'action','candidateStageChange',
                                    'externalApplicationId',v_app,'source','explicit_backlog','explicitImportRunId',r.id);
    if not exists (select 1 from screening_v2.job_queue where dedup_key = 'ashby:signal:candidateStageChange:' || v_dedup and status in ('pending','active','delayed')) then
      v_job_id := null;
      begin
        insert into screening_v2.job_queue(name,payload,status,dedup_key,attempts,max_attempts,priority,scheduled_at,created_at)
        values ('ashby.signal',v_payload,'pending','ashby:signal:candidateStageChange:' || v_dedup,0,5,0,v_now,v_now)
        returning id into v_job_id;
      exception when unique_violation then v_job_id := null; end;
      if v_job_id is not null then v_queued := v_queued + 1; end if;
    end if;
  end loop;
  update screening_v2.ashby_mapping_snapshot_imports set status='queued', confirmed_at=v_now, confirmed_actor_id=p_actor_id, queued_count=v_queued where id=r.id;
  insert into screening_v2.audit_events(actor_id,actor_type,action,target_type,target_id,result,metadata)
    values(p_actor_id,'recruiter','ashby_mapping_update','ashby_mapping_snapshot_import',r.id::text,'success',
           jsonb_build_object('mapping_id',r.mapping_id,'action','snapshot_confirm','count',r.expected_count));
  return jsonb_build_object('status','ok','run_id',r.id,'queued_count',v_queued);
end; $$;

create or replace function screening_v2.authorize_ashby_snapshot_entry(
  p_run_id uuid, p_application_id text, p_job_id text, p_stage_id text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, screening_v2 as $$
declare r screening_v2.ashby_mapping_snapshot_imports%rowtype; m screening_v2.ashby_job_mappings%rowtype;
begin
  select * into r from screening_v2.ashby_mapping_snapshot_imports where id=p_run_id;
  if not found or r.status <> 'queued' then return jsonb_build_object('authorized',false); end if;
  select * into m from screening_v2.ashby_job_mappings where id=r.mapping_id;
  if not found or m.status <> 'enabled' or m.config_version <> r.config_version or m.activation_epoch <> r.activation_epoch
     or m.external_job_id <> p_job_id or m.ai_screening_stage_id <> p_stage_id then return jsonb_build_object('authorized',false); end if;
  return jsonb_build_object('authorized', exists (select 1 from jsonb_array_elements(r.snapshot) x
    where x->>'applicationId'=p_application_id and x->>'jobId'=p_job_id and x->>'stageId'=p_stage_id));
end; $$;

create or replace function screening_v2.authorize_ashby_snapshot_application(
  p_application_id text, p_job_id text, p_stage_id text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, screening_v2 as $$
begin
  return jsonb_build_object('authorized', exists (
    select 1 from screening_v2.ashby_mapping_snapshot_imports r
    join screening_v2.ashby_job_mappings m on m.id = r.mapping_id
    cross join lateral jsonb_array_elements(r.snapshot) x
    where r.status = 'queued' and m.status = 'enabled'
      and m.config_version = r.config_version and m.activation_epoch = r.activation_epoch
      and m.external_job_id = p_job_id and m.ai_screening_stage_id = p_stage_id
      and x->>'applicationId' = p_application_id
      and x->>'jobId' = p_job_id and x->>'stageId' = p_stage_id));
end; $$;

revoke all on function screening_v2.create_ashby_snapshot_preview(uuid,text,text,integer,bigint,uuid,jsonb,integer,timestamptz) from public,anon,authenticated;
revoke all on function screening_v2.confirm_ashby_snapshot_import(uuid,uuid,integer,uuid) from public,anon,authenticated;
revoke all on function screening_v2.authorize_ashby_snapshot_entry(uuid,text,text,text) from public,anon,authenticated;
revoke all on function screening_v2.authorize_ashby_snapshot_application(text,text,text) from public,anon,authenticated;
grant execute on function screening_v2.create_ashby_snapshot_preview(uuid,text,text,integer,bigint,uuid,jsonb,integer,timestamptz) to service_role;
grant execute on function screening_v2.confirm_ashby_snapshot_import(uuid,uuid,integer,uuid) to service_role;
grant execute on function screening_v2.authorize_ashby_snapshot_entry(uuid,text,text,text) to service_role;
grant execute on function screening_v2.authorize_ashby_snapshot_application(text,text,text) to service_role;

-- The old functions remain the validation/audit authority, but their global
-- resync side effect is replaced here so ordinary enable is future-only.
create or replace function screening_v2.set_ashby_mapping_status(p_mapping_id uuid,p_status text,p_reason text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,screening_v2 as $$
declare v screening_v2.ashby_job_mappings%rowtype; v_open boolean := false; v_now timestamptz := now();
begin
  if p_actor_id is null then return jsonb_build_object('status','actor_required'); end if;
  if p_status not in ('paused','enabled') then return jsonb_build_object('status','invalid_status'); end if;
  select * into v from screening_v2.ashby_job_mappings where id=p_mapping_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if p_status='enabled' and (v.ai_screening_stage_id is null or v.ta_screening_stage_id is null) then return jsonb_build_object('status','incomplete_cannot_enable'); end if;
  if p_status='enabled' and v.status='drift' then return jsonb_build_object('status','drifted_cannot_enable'); end if;
  v_open := p_status='enabled' and v.status is distinct from 'enabled';
  update screening_v2.ashby_job_mappings set status=p_status,
    status_reason=case when p_status='enabled' then null else left(coalesce(p_reason,'paused'),200) end,
    config_version=config_version+1, activation_at=case when v_open then v_now else activation_at end,
    activation_epoch=case when v_open then activation_epoch+1 else activation_epoch end, updated_at=v_now
    where id=p_mapping_id;
  insert into screening_v2.audit_events(actor_id,actor_type,action,target_type,target_id,result,metadata)
    values(p_actor_id,'recruiter','ashby_mapping_update','ashby_job_mapping',p_mapping_id::text,'success',
           jsonb_build_object('mapping_id',p_mapping_id,'status',p_status,'action','set_status','forced_full_resync',false,'activation_epoch',case when v_open then v.activation_epoch+1 else v.activation_epoch end));
  return jsonb_build_object('status','ok','mapping_status',p_status,'forced_full_resync',false,'activation_epoch',case when v_open then v.activation_epoch+1 else v.activation_epoch end);
end; $$;

create or replace function screening_v2.upsert_ashby_job_mapping(
  p_mapping_id uuid,p_external_job_id text,p_role_id uuid,p_ai_screening_stage_id text,p_ta_screening_stage_id text,
  p_feedback_form_id text,p_interview_id text,p_attribution_user_id text,p_owner_id uuid,p_delivery_mode text,
  p_invite_ttl_hours integer,p_status text,p_label text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,screening_v2 as $$
declare v screening_v2.ashby_job_mappings%rowtype; v_id uuid; v_created boolean:=false; v_open boolean:=false; v_ai text:=p_ai_screening_stage_id; v_ta text:=p_ta_screening_stage_id; v_status text:=lower(coalesce(p_status,'paused')); v_now timestamptz:=now();
begin
  if p_actor_id is null then return jsonb_build_object('status','actor_required'); end if;
  if p_owner_id is null then return jsonb_build_object('status','owner_required'); end if;
  if p_role_id is null then return jsonb_build_object('status','role_required'); end if;
  if p_external_job_id is null or length(p_external_job_id) not between 1 and 256 then return jsonb_build_object('status','invalid_external_job_id'); end if;
  if coalesce(p_delivery_mode,'manual') not in ('email','manual','both') then return jsonb_build_object('status','invalid_delivery_mode'); end if;
  if coalesce(p_invite_ttl_hours,24)<>24 then return jsonb_build_object('status','invalid_invite_ttl'); end if;
  if v_status not in ('paused','enabled') then return jsonb_build_object('status','invalid_status'); end if;
  if p_label is not null and length(p_label)>120 then return jsonb_build_object('status','invalid_label'); end if;
  if p_mapping_id is not null then select * into v from screening_v2.ashby_job_mappings where id=p_mapping_id for update; if not found then return jsonb_build_object('status','not_found'); end if; v_ai:=coalesce(v_ai,v.ai_screening_stage_id); v_ta:=coalesce(v_ta,v.ta_screening_stage_id); end if;
  if v_status='enabled' and (v_ai is null or v_ta is null) then return jsonb_build_object('status','incomplete_cannot_enable'); end if;
  if v_status='enabled' and p_mapping_id is not null and v.status='drift' then return jsonb_build_object('status','drifted_cannot_enable'); end if;
  v_open:=v_status='enabled' and (p_mapping_id is null or v.status is distinct from 'enabled' or v.ai_screening_stage_id is distinct from v_ai or v.external_job_id is distinct from p_external_job_id);
  if p_mapping_id is null then
    insert into screening_v2.ashby_job_mappings(provider,external_job_id,role_id,ai_screening_stage_id,ta_screening_stage_id,feedback_form_id,interview_id,attribution_user_id,owner_id,delivery_mode,invite_ttl_hours,status,label,activation_at,activation_epoch)
    values('ashby',p_external_job_id,p_role_id,v_ai,v_ta,p_feedback_form_id,p_interview_id,p_attribution_user_id,p_owner_id,coalesce(p_delivery_mode,'manual'),24,v_status,p_label,case when v_open then v_now else null end,case when v_open then 1 else 0 end) returning id into v_id; v_created:=true;
  else
    update screening_v2.ashby_job_mappings set external_job_id=p_external_job_id,role_id=p_role_id,ai_screening_stage_id=v_ai,ta_screening_stage_id=v_ta,feedback_form_id=p_feedback_form_id,interview_id=p_interview_id,attribution_user_id=p_attribution_user_id,owner_id=p_owner_id,delivery_mode=coalesce(p_delivery_mode,'manual'),invite_ttl_hours=24,status=v_status,status_reason=case when v_status='enabled' then null else v.status_reason end,label=p_label,config_version=v.config_version+1,activation_at=case when v_open then v_now else activation_at end,activation_epoch=case when v_open then activation_epoch+1 else activation_epoch end,updated_at=v_now where id=p_mapping_id returning id into v_id;
  end if;
  insert into screening_v2.audit_events(actor_id,actor_type,action,target_type,target_id,result,metadata)
    values(p_actor_id,'recruiter','ashby_mapping_update','ashby_job_mapping',v_id::text,'success',jsonb_build_object('mapping_id',v_id,'status',v_status,'created',v_created,'forced_full_resync',false,'activation_epoch',case when v_open then case when v_created then 1 else v.activation_epoch+1 end else case when v_created then 0 else v.activation_epoch end end));
  return jsonb_build_object('status','ok','id',v_id,'created',v_created,'forced_full_resync',false,'activation_epoch',case when v_open then case when v_created then 1 else v.activation_epoch+1 end else case when v_created then 0 else v.activation_epoch end end);
end; $$;

revoke all on function screening_v2.set_ashby_mapping_status(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function screening_v2.upsert_ashby_job_mapping(uuid,text,uuid,text,text,text,text,text,uuid,text,integer,text,text,uuid) from public,anon,authenticated;
grant execute on function screening_v2.set_ashby_mapping_status(uuid,text,text,uuid) to service_role;
grant execute on function screening_v2.upsert_ashby_job_mapping(uuid,text,uuid,text,text,text,text,text,uuid,text,integer,text,text,uuid) to service_role;

notify pgrst, 'reload schema';
