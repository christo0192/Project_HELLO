-- =====================================================================
-- 0033 — Ashby reconciliation admission: forced full resync on mapping
--        enable, guarded against being cleared by an in-flight run.
--
-- Forward-only and additive (C-1): one guarded ALTER ... ADD COLUMN IF NOT
-- EXISTS and CREATE OR REPLACE of three existing functions. No table is
-- dropped, no column is dropped or retyped, no data is deleted, and no
-- browser-role grant or policy is added anywhere.
--
-- Security posture (mirrors 0029/0030/0031/0032): every SECURITY DEFINER
-- RPC pins search_path, is revoked from public/anon/authenticated, and is
-- granted to service_role only. All audit metadata stays opaque ids +
-- sanitized codes — never PII, tokens, presigned URLs, or raw bodies.
--
-- WHY THIS MIGRATION EXISTS (production-exposed finding):
--   The first runtime reconciliation pass, against a tenant whose ONLY
--   mapping was paused, created exactly 2,000 pending `ashby.signal` jobs
--   and zero links, operations, or imports: `runReconciliation` recorded a
--   receipt and enqueued a signal for EVERY application it observed, and
--   the mapping/stage gate only ran later, inside the worker — after a
--   tenant-wide fan-out had already been durably queued.
--
--   The primary fix is in application code: reconciliation now admits an
--   application.list row ONLY when it positively exposes a job id and a
--   current stage id that match an ENABLED mapping's configured AI stage,
--   using ONE bounded enabled-mapping load per run instead of a per-
--   application lookup. This migration closes the correctness hole that
--   admission opens:
--
--   R-1  With admission in place, an application that reached the trigger
--        stage while its mapping was paused is (correctly) skipped. When
--        an operator later ENABLES or RESUMES that mapping, an incremental
--        cursor would never show that application again, so it would never
--        be screened. `upsert_ashby_job_mapping` therefore forces the
--        `application.list` checkpoint to `full_resync_required` in the
--        SAME transaction as the mapping write, whenever the mapping
--        becomes (or stays) enabled with a NEW AI screening stage. A
--        mapping write that does not open new admission (a pause, or an
--        enabled row edited without touching its AI stage) forces nothing.
--
--   R-2  A forced resync could be silently erased by a reconciliation run
--        that was ALREADY PAGING when the mapping was enabled: that run's
--        own `advance_ashby_sync_checkpoint` reset status to 'idle'. A
--        monotonic `resync_epoch`, bumped by every forced resync and
--        compare-and-set by `advance`, means such a run advances its
--        cursor but LEAVES the forced-resync flag standing for the next
--        pass. Passing no epoch preserves the pre-0033 behaviour exactly.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. resync_epoch — monotonic forced-resync generation counter
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.ashby_sync_checkpoints
  add column if not exists resync_epoch bigint not null default 0;

comment on column screening_v2.ashby_sync_checkpoints.resync_epoch is
  'Monotonic generation counter bumped by every forced full resync. A '
  'reconciliation run reads it before paging and hands it back to '
  'advance_ashby_sync_checkpoint, which then refuses to clear a '
  'full_resync_required flag raised after the run started. Never an id, a '
  'token, or anything tenant-identifying.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. mark_ashby_sync_full_resync — bump the epoch on every forced resync
-- ═══════════════════════════════════════════════════════════════════════
-- Semantics are otherwise identical to 0030: null the opaque token and flag
-- the stream. Idempotent in effect (repeat calls leave the stream forced);
-- the epoch advances on each call, which is what makes the CAS in section 3
-- able to distinguish "flag raised before this run" from "raised during it".

create or replace function screening_v2.mark_ashby_sync_full_resync(
  p_checkpoint_key text,
  p_reason         text,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id    uuid;
  v_epoch bigint;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_reason is not null and length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     full_resync_reason, resync_epoch, updated_at)
  values
    ('ashby', p_checkpoint_key, null, 'full_resync_required', null, p_reason, 1, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = null,
     status             = 'full_resync_required',
     token_issued_at    = null,
     full_resync_reason = p_reason,
     resync_epoch       = screening_v2.ashby_sync_checkpoints.resync_epoch + 1,
     updated_at         = p_now
  returning id, resync_epoch into v_id, v_epoch;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'resync_epoch', v_epoch);
end;
$$;

revoke all on function screening_v2.mark_ashby_sync_full_resync(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_ashby_sync_full_resync(text, text, timestamptz)
  to service_role;

comment on function screening_v2.mark_ashby_sync_full_resync is
  'Forces a safe full resync: nulls the opaque sync token, flags the stream '
  'full_resync_required, and bumps the monotonic resync_epoch so a run that '
  'is already paging cannot clear the flag when it completes. Used on token '
  'expiry/rejection, on a dropped-signal audit, and — in the same '
  'transaction as the mapping write — when enabling a mapping opens new '
  'admission. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. advance_ashby_sync_checkpoint — epoch-guarded clearing of the flag
-- ═══════════════════════════════════════════════════════════════════════
-- Same signature/semantics as 0032 (cursor advance + progress-counter reset;
-- the single-flight lease stays owned by end_ashby_sync_run) with ONE
-- addition: the optional p_resync_epoch the caller
-- observed before paging. When it is supplied and no longer matches, the run
-- still advances its cursor (the pages it read were genuinely processed) but
-- the stream STAYS full_resync_required with its reason intact, so the next
-- pass performs the full sweep the newly enabled mapping requires.
-- p_resync_epoch null ⇒ pre-0033 behaviour: unconditionally clear.

create or replace function screening_v2.advance_ashby_sync_checkpoint(
  p_checkpoint_key text,
  p_sync_token     text,
  p_pages          integer,
  p_items          integer,
  p_full           boolean default false,
  p_now            timestamptz default now(),
  p_resync_epoch   bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id      uuid;
  v_row     screening_v2.ashby_sync_checkpoints%rowtype;
  v_keep    boolean := false;
  v_status  text;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_sync_token is not null and (length(p_sync_token) < 1 or length(p_sync_token) > 4096) then
    return jsonb_build_object('status', 'invalid_sync_token');
  end if;

  -- Lock the row (when it exists) so the epoch compare-and-set and the
  -- cursor write are one atomic decision.
  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;

  if found and p_resync_epoch is not null
     and v_row.resync_epoch is distinct from p_resync_epoch then
    -- A forced resync was raised AFTER this run read the checkpoint. Advance
    -- the cursor, but do not let this run's completion clear that demand.
    v_keep := true;
  end if;

  v_status := case when v_keep then 'full_resync_required' else 'idle' end;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     last_success_at, last_full_sync_at, pages_last_run, items_last_run,
     full_resync_reason, no_progress_runs, updated_at)
  values
    ('ashby', p_checkpoint_key, p_sync_token, 'idle',
     case when p_sync_token is null then null else p_now end,
     p_now,
     case when p_full then p_now else null end,
     greatest(0, coalesce(p_pages, 0)), greatest(0, coalesce(p_items, 0)),
     null, 0, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = excluded.sync_token,
     status             = v_status,
     token_issued_at    = case when excluded.sync_token is null then null else p_now end,
     last_success_at    = p_now,
     last_full_sync_at  = case when p_full then p_now
                               else screening_v2.ashby_sync_checkpoints.last_full_sync_at end,
     pages_last_run     = greatest(0, coalesce(p_pages, 0)),
     items_last_run     = greatest(0, coalesce(p_items, 0)),
     full_resync_reason = case when v_keep
                               then screening_v2.ashby_sync_checkpoints.full_resync_reason
                               else null end,
     no_progress_runs   = 0,
     updated_at         = p_now
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'id', v_id,
                            'resync_pending', v_keep);
end;
$$;

-- The 0030/0032 six-argument overload would otherwise remain callable and
-- silently bypass the epoch guard. Drop it: the seventh parameter has a
-- default, so every existing six-argument call site keeps working against
-- this function unchanged.
drop function if exists screening_v2.advance_ashby_sync_checkpoint(
  text, text, integer, integer, boolean, timestamptz);

revoke all on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz, bigint)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz, bigint)
  to service_role;

comment on function screening_v2.advance_ashby_sync_checkpoint is
  'Persists a reconciliation cursor after a SUCCESSFUL run: sets the opaque '
  'sync token, stamps the 14-day expiry anchor + last_success_at, and resets '
  'no_progress_runs (the single-flight lease is released by '
  'end_ashby_sync_run). When the caller '
  'supplies the resync_epoch it observed and that epoch has moved on, the '
  'cursor still advances but full_resync_required is PRESERVED, so a '
  'mapping enabled mid-run still gets its full sweep. A partial/failed run '
  'never calls this. Service-role-only.';


-- ═══════════════════════════════════════════════════════════════════════
-- 4. begin_ashby_sync_run — expose the epoch to the run
-- ═══════════════════════════════════════════════════════════════════════
-- Unchanged except that the returned cursor state now carries resync_epoch,
-- so a run that reads its checkpoint through the lease acquisition observes
-- the same generation it will later compare-and-set against.

create or replace function screening_v2.begin_ashby_sync_run(
  p_checkpoint_key text,
  p_owner          text,
  p_lease_seconds  integer,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.ashby_sync_checkpoints%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 1), 3600);
  v_owner text := left(coalesce(p_owner, 'scheduler'), 128);
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;

  -- Create the row on first use so the very first run is also single-flight.
  insert into screening_v2.ashby_sync_checkpoints (provider, checkpoint_key, status)
  values ('ashby', p_checkpoint_key, 'idle')
  on conflict (provider, checkpoint_key) do nothing;

  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > p_now then
    return jsonb_build_object('status', 'locked');
  end if;

  update screening_v2.ashby_sync_checkpoints
     set lease_owner = v_owner,
         lease_expires_at = p_now + make_interval(secs => v_lease),
         updated_at = p_now
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key;

  -- `status` intentionally keeps its own meaning (idle | full_resync_required)
  -- so a pending forced resync survives the lease acquisition untouched.
  return jsonb_build_object(
    'status', 'ok',
    'lease_owner', v_owner,
    'sync_token', v_row.sync_token,
    'checkpoint_status', v_row.status,
    'token_issued_at', v_row.token_issued_at,
    'last_success_at', v_row.last_success_at,
    'no_progress_runs', v_row.no_progress_runs,
    'resync_epoch', v_row.resync_epoch
  );
end;
$$;

revoke all on function screening_v2.begin_ashby_sync_run(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.begin_ashby_sync_run(text, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.begin_ashby_sync_run is
  'Single-flight lease acquisition for one reconciliation stream. Returns '
  'locked when a live lease is held, so two schedulers (or an overlapping '
  'slow run) can never both page and both advance the cursor. Returns the '
  'opaque cursor state — including resync_epoch — for the caller''s '
  'sync-mode decision. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. upsert_ashby_job_mapping — force a resync when admission widens
-- ═══════════════════════════════════════════════════════════════════════
-- Identical to 0029 in validation and audit behaviour, plus R-1: when the
-- write leaves the mapping ENABLED with an AI screening stage that was not
-- already admitting (a newly created enabled mapping, a paused mapping
-- resumed, or an enabled mapping repointed at a different AI stage), the
-- `application.list` checkpoint is forced to full_resync_required IN THE
-- SAME TRANSACTION. Either both land or neither does: a mapping can never
-- become enabled while the cursor still hides the applications it admits.
--
-- Deliberately NOT forced: pausing a mapping (admission only narrows — the
-- next pass skips those applications with no resync needed) and re-saving an
-- enabled mapping whose AI stage is unchanged (the same rows were already
-- admitted). Forcing on those would make every routine admin save trigger a
-- full provider sweep.

create or replace function screening_v2.upsert_ashby_job_mapping(
  p_mapping_id            uuid,
  p_external_job_id       text,
  p_role_id               uuid,
  p_ai_screening_stage_id text,
  p_ta_screening_stage_id text,
  p_feedback_form_id      text,
  p_interview_id          text,
  p_attribution_user_id   text,
  p_owner_id              uuid,
  p_delivery_mode         text,
  p_invite_ttl_hours      integer,
  p_status                text,
  p_label                 text,
  p_actor_id              uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
  v_created boolean := false;
  v_current screening_v2.ashby_job_mappings%rowtype;
  v_ttl integer := coalesce(p_invite_ttl_hours, 24);
  v_status text := lower(coalesce(p_status, 'paused'));
  v_ai text := p_ai_screening_stage_id;
  v_ta text := p_ta_screening_stage_id;
  v_resync boolean := false;
  v_resync_result jsonb;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_owner_id is null then
    return jsonb_build_object('status', 'owner_required');
  end if;
  if p_role_id is null then
    return jsonb_build_object('status', 'role_required');
  end if;
  if p_external_job_id is null or length(p_external_job_id) < 1 or length(p_external_job_id) > 256 then
    return jsonb_build_object('status', 'invalid_external_job_id');
  end if;
  if coalesce(p_delivery_mode, 'manual') not in ('email','manual','both') then
    return jsonb_build_object('status', 'invalid_delivery_mode');
  end if;
  if v_ttl <> 24 then
    return jsonb_build_object('status', 'invalid_invite_ttl');   -- Phase 1: 24h only
  end if;
  if v_status not in ('paused','enabled') then
    -- Drift is set only by mark_ashby_mapping_drift, never via upsert.
    return jsonb_build_object('status', 'invalid_status');
  end if;
  if p_label is not null and length(p_label) > 120 then
    return jsonb_build_object('status', 'invalid_label');
  end if;

  -- Lock the existing row (if any) so concurrent upserts serialise.
  if p_mapping_id is not null then
    select * into v_current
      from screening_v2.ashby_job_mappings
     where id = p_mapping_id
     for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    -- Preserve unspecified stage IDs on update (coalesce to current).
    v_ai := coalesce(v_ai, v_current.ai_screening_stage_id);
    v_ta := coalesce(v_ta, v_current.ta_screening_stage_id);
  end if;

  -- Completeness gate for ENABLE (defense in depth beyond the CHECK).
  if v_status = 'enabled' and (v_ai is null or v_ta is null) then
    return jsonb_build_object('status', 'incomplete_cannot_enable');
  end if;
  -- A drifted mapping must be repaired (its drift cleared to 'paused') before
  -- it can be enabled again; refuse to enable straight from drift.
  if v_status = 'enabled' and p_mapping_id is not null and v_current.status = 'drift' then
    return jsonb_build_object('status', 'drifted_cannot_enable');
  end if;

  -- R-1: does this write OPEN admission that reconciliation was not already
  -- performing? Decided from the pre-write state, before the row changes.
  if v_status = 'enabled' and v_ai is not null then
    if p_mapping_id is null then
      v_resync := true;                                   -- created enabled
    elsif v_current.status is distinct from 'enabled' then
      v_resync := true;                                   -- paused/drift → enabled
    elsif v_current.ai_screening_stage_id is distinct from v_ai then
      v_resync := true;                                   -- repointed AI stage
    end if;
  end if;

  if p_mapping_id is not null then
    update screening_v2.ashby_job_mappings set
      external_job_id = p_external_job_id,
      role_id = p_role_id,
      ai_screening_stage_id = v_ai,
      ta_screening_stage_id = v_ta,
      feedback_form_id = p_feedback_form_id,
      interview_id = p_interview_id,
      attribution_user_id = p_attribution_user_id,
      owner_id = p_owner_id,
      delivery_mode = coalesce(p_delivery_mode, 'manual'),
      invite_ttl_hours = 24,
      status = v_status,
      status_reason = case when v_status = 'enabled' then null else v_current.status_reason end,
      label = p_label,
      config_version = v_current.config_version + 1,
      updated_at = now()
    where id = p_mapping_id
    returning id into v_id;
  else
    insert into screening_v2.ashby_job_mappings (
      provider, external_job_id, role_id, ai_screening_stage_id, ta_screening_stage_id,
      feedback_form_id, interview_id, attribution_user_id, owner_id, delivery_mode,
      invite_ttl_hours, status, label
    ) values (
      'ashby', p_external_job_id, p_role_id, v_ai, v_ta,
      p_feedback_form_id, p_interview_id, p_attribution_user_id, p_owner_id,
      coalesce(p_delivery_mode, 'manual'), 24, v_status, p_label
    )
    returning id into v_id;
    v_created := true;
  end if;

  -- Same transaction as the mapping write. A failure here rolls the mapping
  -- write back too, which is the intended fail-closed behaviour: a mapping
  -- that is enabled but whose backlog can never be reconsidered would screen
  -- only future stage changes and silently strand everyone already waiting.
  if v_resync then
    v_resync_result := screening_v2.mark_ashby_sync_full_resync(
      'application.list', 'mapping_enabled');
    if coalesce(v_resync_result ->> 'status', '') <> 'ok' then
      raise exception 'ashby_resync_force_failed';
    end if;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'ashby_mapping_update', 'ashby_job_mapping', v_id::text,
     'success',
     jsonb_build_object('mapping_id', v_id, 'status', v_status,
                        'delivery_mode', coalesce(p_delivery_mode, 'manual'),
                        'created', v_created,
                        'forced_full_resync', v_resync));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'created', v_created,
                            'forced_full_resync', v_resync);
end;
$$;

revoke all on function screening_v2.upsert_ashby_job_mapping(uuid, text, uuid, text, text, text, text, text, uuid, text, integer, text, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.upsert_ashby_job_mapping(uuid, text, uuid, text, text, text, text, text, uuid, text, integer, text, text, uuid)
  to service_role;

comment on function screening_v2.upsert_ashby_job_mapping is
  'Race-safe admin create/update of an Ashby job mapping with an '
  'ashby_mapping_update audit row in the same transaction. Fails closed on '
  'invalid delivery mode, non-24h TTL, or enabling an incomplete/drifted '
  'mapping. Drift status is never set here (see mark_ashby_mapping_drift). '
  'When the write OPENS admission (created enabled, resumed, or repointed '
  'AI stage) it also forces the application.list checkpoint to '
  'full_resync_required in the same transaction, so applications already at '
  'the trigger stage are reconsidered under the new mapping. '
  'Service-role-only.';
