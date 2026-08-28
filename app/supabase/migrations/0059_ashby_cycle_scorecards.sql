-- 0059 — cycle-specific Ashby scorecard operation identity.
--
-- The application link remains the provider workflow identity, but a phone
-- re-screen is a distinct internal assessment. Each operation records the
-- exact source session so a delayed worker cannot publish a later cycle's
-- score. The provider adapter remains unchanged; the feature is opt-in until
-- tenant verification confirms that multiple feedback submissions are allowed.

alter table screening_v2.ashby_operations
  add column if not exists source_session_id uuid
  references screening_v2.call_sessions(id) on delete set null;

create unique index if not exists uq_ashby_scorecard_operation_cycle
  on screening_v2.ashby_operations(application_link_id, source_session_id)
  where operation_type = 'scorecard_write' and source_session_id is not null;

comment on column screening_v2.ashby_operations.source_session_id is
  'Exact session/phone cycle whose assessment supplies this operation. NULL for legacy browser/link-scoped operations.';

create or replace function screening_v2.enqueue_ashby_cycle_scorecard(
  p_application_link_id uuid,
  p_session_id uuid,
  p_operation_key text,
  p_marker text,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link screening_v2.ashby_application_links%rowtype;
  v_existing screening_v2.ashby_operations%rowtype;
  v_engagement_id uuid;
  v_result jsonb;
  v_status text;
begin
  if p_application_link_id is null or p_session_id is null or p_operation_key is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  select * into v_link from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby' for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal');
  end if;
  select e.id into v_engagement_id
    from screening_v2.phone_engagements e
   where e.application_link_id = p_application_link_id
     and e.session_id = p_session_id
   order by e.cycle_number desc, e.id desc
   limit 1;
  if not found then return jsonb_build_object('status', 'session_mismatch'); end if;

  select * into v_existing from screening_v2.ashby_operations
   where provider = 'ashby'
     and operation_type = 'scorecard_write'
     and (operation_key = p_operation_key or
          (application_link_id = p_application_link_id and source_session_id = p_session_id))
   order by created_at, id limit 1;
  if found then
    return jsonb_build_object('status', 'duplicate', 'id', v_existing.id,
      'source_session_id', v_existing.source_session_id);
  end if;

  v_result := screening_v2.enqueue_ashby_operation(
    p_application_link_id, 'scorecard_write', p_operation_key,
    null, p_marker, p_actor_id);
  v_status := coalesce(v_result->>'status', 'unknown_status');
  if v_status = 'inserted' then
    update screening_v2.ashby_operations
       set source_session_id = p_session_id, updated_at = p_now
     where id = (v_result->>'id')::uuid;
  end if;
  return v_result;
end;
$$;

revoke all on function screening_v2.enqueue_ashby_cycle_scorecard(uuid, uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.enqueue_ashby_cycle_scorecard(uuid, uuid, text, text, uuid, timestamptz)
  to service_role;

create or replace function screening_v2.claim_ashby_operation(
  p_operation_type text,
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
  v_op    screening_v2.ashby_operations%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 30), 1), 900);
  v_token uuid := gen_random_uuid();
begin
  if p_operation_type is not null
     and p_operation_type not in ('invite_delivery','scorecard_write','stage_move') then
    return jsonb_build_object('status', 'invalid_operation_type');
  end if;

  select o.* into v_op
    from screening_v2.ashby_operations o
    join screening_v2.ashby_application_links l on l.id = o.application_link_id
   where o.provider = 'ashby'
     and o.state = 'pending'
     and o.scheduled_at <= p_now
     and l.terminal_state is null
     and (p_operation_type is null or o.operation_type = p_operation_type)
     and (o.lease_expires_at is null or o.lease_expires_at <= p_now)
     and (
       o.depends_on_operation_id is null
       or exists (
         select 1 from screening_v2.ashby_operations d
          where d.id = o.depends_on_operation_id and d.state = 'succeeded'
       )
     )
     -- ── 0035 prerequisite gate for invite delivery ────────────────────
     and (
       o.operation_type <> 'invite_delivery'
       or (
         -- (b) an ENABLED mapping is what authorizes contacting a candidate.
         exists (
           select 1 from screening_v2.ashby_job_mappings m
            where m.id = l.job_mapping_id and m.status = 'enabled'
         )
         -- (c) a resume-backed link waits for its OWN ingestion to be ready.
         and (
           l.external_resume_file_handle is null
           or exists (
             select 1 from screening_v2.ashby_resume_ingestions i
              where i.application_link_id = l.id and i.state = 'ready'
           )
         )
       )
     )
   order by o.scheduled_at, o.id
   for update of o skip locked
   limit 1;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  update screening_v2.ashby_operations
     set state = 'running',
         attempts = attempts + 1,
         lease_token = v_token,
         lease_owner = left(coalesce(p_owner, 'worker'), 128),
         lease_expires_at = p_now + make_interval(secs => v_lease),
         updated_at = p_now
   where id = v_op.id;

  return jsonb_build_object(
    'status', 'claimed',
    'id', v_op.id,
    'operation_type', v_op.operation_type,
    'operation_key', v_op.operation_key,
    'application_link_id', v_op.application_link_id,
    'lease_token', v_token,
    'attempts', v_op.attempts + 1,
    'max_attempts', v_op.max_attempts,
    'marker', v_op.marker,
    'source_session_id', v_op.source_session_id
  );
end;
$$;
revoke all on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  to service_role;
