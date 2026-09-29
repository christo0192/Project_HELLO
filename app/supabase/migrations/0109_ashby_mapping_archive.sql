-- =====================================================================
-- 0109 — "Delete" an Ashby job mapping without deleting its history
--
-- Owner decision (2026-09-29): Mission Control gets a Delete action for job
-- mappings. A HARD delete is wrong here, for two independent reasons:
--   * ashby_application_links.job_mapping_id is ON DELETE SET NULL, so a
--     delete silently strips the mapping (and through it the role) from every
--     candidate that job ever imported. Funnel attribution, rescreen cycles
--     and scorecard binding all read that pointer.
--   * ashby_mapping_snapshot_imports.mapping_id is ON DELETE RESTRICT, so any
--     mapping that ever ran a backlog import cannot be deleted at all.
-- So "delete" ARCHIVES: the row stays, its history stays linked to it — with
-- the role and scorecard configuration it was screened under — and it drops
-- out of Mission Control. An archived row is frozen: it can never be enabled
-- (a CHECK makes that true for every writer, not only the functions below)
-- and the upsert refuses to edit it.
--
-- Deleting an ENABLED mapping is refused (the owner chose "pause first"), so
-- live screening can never be switched off by one click.
--
-- RE-ADDING a deleted job creates a NEW mapping row. It does not revive the
-- archived one: reviving would re-point every historical link at whatever
-- role and scorecard form the admin picks today, which is exactly the silent
-- history rewrite that archiving exists to prevent. That needs uniqueness
-- over LIVE rows only, so the table-wide UNIQUE (provider, external_job_id)
-- becomes a partial unique index WHERE archived_at IS NULL. The guarantee the
-- runtime depends on — one live mapping per Ashby job, which the two
-- by-job-id resolvers read with maybeSingle — is unchanged; archived rows
-- are exempt. Every SQL reader resolves a mapping by id through
-- ashby_application_links.job_mapping_id, never by job id, so an archived row
-- sitting beside a live one for the same job is invisible to them.
--
-- TST-15 SANCTION: dropping uq_ashby_job_mappings_provider_job is the
-- sanctioned uniqueness narrowing in this migration (see
-- scripts/migrate-rollback.test.mjs). The partial index is created FIRST and
-- covers every existing row (archived_at is null everywhere at this point),
-- so there is no instant without the guarantee.
-- =====================================================================

-- Fail fast rather than queue: every statement below takes a table lock on a
-- table phone admission and webhooks read constantly. A long-held lock should
-- fail this deploy (it retries cleanly), not stall live screening behind it.
set lock_timeout = '10s';

alter table screening_v2.ashby_job_mappings
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid;

alter table screening_v2.ashby_job_mappings
  drop constraint if exists chk_ashby_job_mappings_archived_not_enabled;
alter table screening_v2.ashby_job_mappings
  add constraint chk_ashby_job_mappings_archived_not_enabled
  check (archived_at is null or status <> 'enabled');

create unique index if not exists uq_ashby_job_mappings_live_job
  on screening_v2.ashby_job_mappings (provider, external_job_id)
  where archived_at is null;
alter table screening_v2.ashby_job_mappings
  drop constraint if exists uq_ashby_job_mappings_provider_job;

comment on column screening_v2.ashby_job_mappings.archived_at is
  'Set when an admin deletes the mapping in Mission Control. The row is kept, frozen, so candidate history stays linked to the configuration it ran under; an archived mapping is hidden and can never be enabled or edited. Re-adding the job creates a new row.';
comment on column screening_v2.ashby_job_mappings.archived_by is
  'Auth UUID of the admin who archived the mapping. Opaque id only.';
comment on index screening_v2.uq_ashby_job_mappings_live_job is
  'One LIVE mapping per Ashby job (0109). Archived (deleted) mappings are exempt so a job can be re-added without reviving and re-pointing its history.';

create or replace function screening_v2.archive_ashby_job_mapping(p_mapping_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,screening_v2 as $$
declare v screening_v2.ashby_job_mappings%rowtype; v_now timestamptz := now();
begin
  if p_actor_id is null then return jsonb_build_object('status','actor_required'); end if;
  if p_mapping_id is null then return jsonb_build_object('status','not_found'); end if;
  select * into v from screening_v2.ashby_job_mappings where id=p_mapping_id and provider='ashby' for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  -- Idempotent: a second click, or two admins racing, is not an error.
  if v.archived_at is not null then return jsonb_build_object('status','ok','already_archived',true); end if;
  if v.status = 'enabled' then return jsonb_build_object('status','mapping_enabled'); end if;
  -- config_version moves so any open backlog preview bound to this mapping
  -- can no longer be confirmed (confirm also requires `enabled`, which an
  -- archived row can never be — this is belt and braces).
  update screening_v2.ashby_job_mappings
     set archived_at=v_now, archived_by=p_actor_id, config_version=config_version+1, updated_at=v_now
   where id=p_mapping_id;
  insert into screening_v2.audit_events(actor_id,actor_type,action,target_type,target_id,result,metadata)
    values(p_actor_id,'recruiter','ashby_mapping_update','ashby_job_mapping',p_mapping_id::text,'success',
           jsonb_build_object('mapping_id',p_mapping_id,'action','archive','status',v.status));
  return jsonb_build_object('status','ok','already_archived',false);
end; $$;

-- 0106 body, plus: an archived mapping answers `archived` to every status
-- change. Pausing one would be harmless, but "frozen" is the simpler rule to
-- reason about.
create or replace function screening_v2.set_ashby_mapping_status(p_mapping_id uuid,p_status text,p_reason text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,screening_v2 as $$
declare v screening_v2.ashby_job_mappings%rowtype; v_open boolean := false; v_now timestamptz := now();
begin
  if p_actor_id is null then return jsonb_build_object('status','actor_required'); end if;
  if p_status not in ('paused','enabled') then return jsonb_build_object('status','invalid_status'); end if;
  select * into v from screening_v2.ashby_job_mappings where id=p_mapping_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v.archived_at is not null then return jsonb_build_object('status','archived'); end if;
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

-- 0106 body, plus ONE line: an update addressed to an archived row answers
-- `archived` and changes nothing. A create for a job whose only mapping is
-- archived simply inserts a new row (the partial unique index allows it); a
-- create for a job with a LIVE mapping still raises unique_violation.
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
  if p_mapping_id is not null then select * into v from screening_v2.ashby_job_mappings where id=p_mapping_id for update; if not found then return jsonb_build_object('status','not_found'); end if; if v.archived_at is not null then return jsonb_build_object('status','archived'); end if; v_ai:=coalesce(v_ai,v.ai_screening_stage_id); v_ta:=coalesce(v_ta,v.ta_screening_stage_id); end if;
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

revoke all on function screening_v2.archive_ashby_job_mapping(uuid,uuid) from public,anon,authenticated;
revoke all on function screening_v2.set_ashby_mapping_status(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function screening_v2.upsert_ashby_job_mapping(uuid,text,uuid,text,text,text,text,text,uuid,text,integer,text,text,uuid) from public,anon,authenticated;
grant execute on function screening_v2.archive_ashby_job_mapping(uuid,uuid) to service_role;
grant execute on function screening_v2.set_ashby_mapping_status(uuid,text,text,uuid) to service_role;
grant execute on function screening_v2.upsert_ashby_job_mapping(uuid,text,uuid,text,text,text,text,text,uuid,text,integer,text,text,uuid) to service_role;

notify pgrst, 'reload schema';
