-- 0050 — phone authoritative recordings are MP3 artifacts.
-- Existing phone recording rows are not rewritten; this changes the forward
-- contract for new attachment and keeps the manifest/purge derivation exact.

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_object_key;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_object_key check (
    recording_object_key is null
    or recording_object_key ~ '^phone-[0-9a-f-]{36}-egress\.(ogg|mp3)$')
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_object_key;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_manifest_key;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_manifest_key check (
    recording_manifest_key is null
    or recording_manifest_key ~ '^phone-[0-9a-f-]{36}-egress\.(ogg|mp3)\.json$')
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_manifest_key;

create or replace function screening_v2.attach_phone_attempt_recording(
  p_attempt_id   uuid,
  p_object_key   text,
  p_manifest_key text,
  p_role         text,
  p_egress_id    text        default null,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
begin
  if p_role is null or p_role not in ('authoritative','supplementary') then
    return jsonb_build_object('status', 'invalid_role');
  end if;
  if p_attempt_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_object_key is distinct from ('phone-' || p_attempt_id::text || '-egress.mp3') then
    return jsonb_build_object('status', 'invalid_object_key');
  end if;
  if p_manifest_key is not null
     and p_manifest_key is distinct from (p_object_key || '.json') then
    return jsonb_build_object('status', 'invalid_manifest_key');
  end if;
  if p_egress_id is not null and p_egress_id !~ '^EG_[A-Za-z0-9_-]{4,200}$' then
    return jsonb_build_object('status', 'invalid_egress_id');
  end if;

  select e.* into v_eng
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
   where a.id = p_attempt_id
     for update of e;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_att from screening_v2.phone_call_attempts
   where id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state <> 'in_call' then
    return jsonb_build_object('status', 'disclosure_not_delivered',
                              'engagement_state', v_eng.state);
  end if;
  if v_att.state not in ('answered_unclassified','human') then
    return jsonb_build_object('status', 'attempt_not_recordable',
                              'attempt_state', v_att.state);
  end if;
  if v_att.recording_object_key is not null then
    if v_att.recording_object_key = p_object_key
       and v_att.recording_role = p_role
       and v_att.recording_manifest_key is not distinct from p_manifest_key then
      return jsonb_build_object('status', 'ok', 'duplicate', true,
                                'attempt_id', v_att.id, 'role', v_att.recording_role);
    end if;
    return jsonb_build_object('status', 'already_bound', 'role', v_att.recording_role);
  end if;

  begin
    update screening_v2.phone_call_attempts
       set recording_object_key   = p_object_key,
           recording_manifest_key = p_manifest_key,
           recording_role         = p_role,
           egress_id              = coalesce(p_egress_id, egress_id),
           egress_status          = case when p_egress_id is not null
                                         then 'active' else egress_status end
     where id = v_att.id;
  exception when unique_violation then
    return jsonb_build_object('status', 'authoritative_exists');
  end;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_recording_attached', 'phone_call_attempt', v_att.id::text, 'success',
     jsonb_build_object('engagement_id', v_eng.id, 'role', p_role,
                        'has_manifest', p_manifest_key is not null));

  return jsonb_build_object('status', 'ok', 'duplicate', false,
                            'attempt_id', v_att.id, 'role', p_role);
end;
$$;

revoke all on function screening_v2.attach_phone_attempt_recording(
  uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.attach_phone_attempt_recording(
  uuid, text, text, text, text, timestamptz) to service_role;
