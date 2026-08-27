-- 0054 — make authoritative finalization aware of phone MP3 artifacts.
--
-- Phone recording egress is attempt-scoped and writes
-- phone-<attempt-id>-egress.mp3. The generic finalizer previously accepted
-- only <session-id>-egress.ogg, so a completed phone session could retry until
-- exhaustion even though its MP3 existed. Browser OGG behavior remains
-- unchanged. The phone key is accepted only when it is the key bound to an
-- attempt for this session and the bound session egress.

create or replace function screening_v2.finalize_authoritative_recording(
  p_session_id uuid,
  p_object_key text,
  p_sha256 text,
  p_size_bytes bigint,
  p_content_type text,
  p_correlation_id text,
  p_recording_egress_started_at_ms bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row record;
  v_superseded_key text;
  v_phone_key boolean := false;
begin
  select recording_object_key,
         recording_provenance,
         recording_egress_id,
         recording_superseded_object_key,
         recording_deleted_at,
         recording_revoked_at,
         recording_quarantined,
         mode
    into v_row
    from screening_v2.call_sessions
   where id = p_session_id
     for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  if v_row.recording_deleted_at is not null
     or v_row.recording_revoked_at is not null
     or v_row.recording_quarantined = true then
    return jsonb_build_object('status', 'terminal_state');
  end if;

  if v_row.recording_egress_id is null then
    return jsonb_build_object('status', 'no_egress');
  end if;

  -- Phone egress is attempt-scoped. Require the exact session/egress/key
  -- binding rather than accepting any UUID-shaped MP3 path.
  if v_row.mode = 'live' then
    select exists (
      select 1
        from screening_v2.phone_call_attempts a
       where a.session_id = p_session_id
         and a.egress_id = v_row.recording_egress_id
         and a.recording_object_key = p_object_key
         and p_object_key ~ '^phone-[0-9a-f-]{36}-egress\.mp3$'
    ) into v_phone_key;
    if not v_phone_key then
      return jsonb_build_object('status', 'invalid_object_key');
    end if;
  elsif p_object_key is distinct from (p_session_id::text || '-egress.ogg') then
    return jsonb_build_object('status', 'invalid_object_key');
  end if;

  if p_object_key is null or octet_length(p_object_key) > 512 then
    return jsonb_build_object('status', 'invalid_object_key');
  end if;

  if p_sha256 is null or not (p_sha256 ~ '^[a-f0-9]{64}$') then
    return jsonb_build_object('status', 'invalid_sha256');
  end if;

  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 52428800 then
    return jsonb_build_object('status', 'invalid_size_bytes');
  end if;

  if p_recording_egress_started_at_ms is not null
     and (p_recording_egress_started_at_ms <= 0
          or p_recording_egress_started_at_ms >= 4102444800000) then
    return jsonb_build_object('status', 'invalid_egress_start');
  end if;

  if (v_phone_key and p_content_type <> 'audio/mpeg')
     or (not v_phone_key and p_content_type <> 'audio/ogg') then
    return jsonb_build_object('status', 'invalid_content_type');
  end if;

  if v_row.recording_provenance = 'livekit_egress' then
    return jsonb_build_object('status', 'already_authoritative');
  end if;

  if v_row.recording_provenance is not null
     and v_row.recording_provenance <> 'browser_upload' then
    return jsonb_build_object('status', 'provenance_conflict',
      'detail', 'provenance is ' || v_row.recording_provenance);
  end if;

  if v_row.recording_object_key is null then
    update screening_v2.call_sessions
       set recording_object_key = p_object_key,
           recording_sha256 = p_sha256,
           recording_size_bytes = p_size_bytes,
           recording_content_type = p_content_type,
           recording_provenance = 'livekit_egress',
           recording_integrity_verified_at = now(),
           recording_egress_started_at_ms = coalesce(
             recording_egress_started_at_ms, p_recording_egress_started_at_ms)
     where id = p_session_id;

    insert into screening_v2.recording_integrity_events
      (session_id, event_type, sha256_expected, size_bytes, detail, correlation_id)
    values
      (p_session_id, 'uploaded', p_sha256, p_size_bytes,
       'livekit_egress verified sha256:' || left(p_sha256, 16) || chr(8230),
       p_correlation_id);

    return jsonb_build_object('status', 'ok');
  end if;

  if v_row.recording_superseded_object_key is not null then
    return jsonb_build_object('status', 'already_authoritative');
  end if;

  v_superseded_key := v_row.recording_object_key;

  update screening_v2.call_sessions
     set recording_superseded_object_key = v_superseded_key,
         recording_object_key = p_object_key,
         recording_sha256 = p_sha256,
         recording_size_bytes = p_size_bytes,
         recording_content_type = p_content_type,
         recording_provenance = 'livekit_egress',
         recording_integrity_verified_at = now(),
         recording_egress_started_at_ms = coalesce(
           recording_egress_started_at_ms, p_recording_egress_started_at_ms)
   where id = p_session_id;

  insert into screening_v2.recording_integrity_events
    (session_id, event_type, sha256_expected, size_bytes, detail, correlation_id)
  values
    (p_session_id, 'repointed', p_sha256, p_size_bytes,
     'browser_upload superseded by livekit_egress sha256:' || left(p_sha256, 16) || chr(8230),
     p_correlation_id);

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint)
  from public, anon, authenticated;
grant execute on function screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint)
  to service_role;

comment on function screening_v2.finalize_authoritative_recording is
  'Authoritative recording finalizer for browser OGG and bound phone MP3 '
  'egress artifacts. Phone keys must match the attempt bound to this session '
  'and egress. Validates provenance, integrity, and terminal recording gates. '
  'Service-role-only and idempotent.';
