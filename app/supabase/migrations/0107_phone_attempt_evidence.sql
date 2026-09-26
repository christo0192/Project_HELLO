-- 0107_phone_attempt_evidence.sql
--
-- Item 3: make phone-call evidence truthful and clickable at attempt scope.
-- Forward-only. 0106 is intentionally reserved for the independent Ashby
-- lane and is not present in this worktree.
--
-- Object/manifest keys already existed on phone_call_attempts, but a key is
-- not proof that an upload completed or that its bytes were verified.  These
-- fields are written only after the server has read the object, checked its
-- magic bytes, calculated its digest and written the canonical manifest.

alter table screening_v2.phone_call_attempts
  add column if not exists recording_sha256 text,
  add column if not exists recording_size_bytes bigint,
  add column if not exists recording_content_type text,
  add column if not exists recording_ready boolean not null default false,
  add column if not exists recording_quarantined boolean not null default false,
  add column if not exists recording_deleted_at timestamptz,
  add column if not exists recording_session_id uuid references screening_v2.call_sessions(id) on delete set null;

-- A gate clip must be attributable before consent binds `phone_call_attempts.session_id`.
-- This is deliberately a separate pointer: it does not activate the assessment,
-- snapshot a plan, or claim the reusable session's recording slot.
alter table screening_v2.call_sessions
  add column if not exists phone_engagement_id uuid references screening_v2.phone_engagements(id) on delete set null;

create unique index if not exists uq_call_sessions_phone_engagement
  on screening_v2.call_sessions (phone_engagement_id)
  where phone_engagement_id is not null;

create index if not exists idx_phone_attempts_recording_session
  on screening_v2.phone_call_attempts (recording_session_id);

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_sha256;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_sha256 check (
    recording_sha256 is null or recording_sha256 ~ '^[a-f0-9]{64}$'
  ) not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_sha256;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_size_bytes;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_size_bytes check (
    recording_size_bytes is null or recording_size_bytes > 0
  ) not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_size_bytes;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_content_type;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_content_type check (
    recording_content_type is null
    or recording_content_type in ('audio/ogg', 'audio/mpeg')
  ) not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_content_type;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_ready;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_ready check (
    recording_ready = false
    or (
      recording_object_key is not null
      and recording_manifest_key is not null
      and recording_sha256 is not null
      and recording_size_bytes is not null
      and recording_content_type is not null
      and recording_deleted_at is null
      and recording_quarantined = false
    )
  ) not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_ready;

create index if not exists idx_phone_attempts_evidence_history
  on screening_v2.phone_call_attempts (engagement_id, admitted_at desc, id desc);
create index if not exists idx_phone_attempts_evidence_session
  on screening_v2.phone_call_attempts (session_id);

comment on column screening_v2.phone_call_attempts.recording_session_id is
  'Evidence-only session binding. Set by bind_phone_attempt_recording_session after candidate, engagement, role and deterministic phone-room checks; independent of consent session_id.';
comment on column screening_v2.call_sessions.phone_engagement_id is
  'Validated phone engagement claim used to prevent arbitrary worker session cross-binding before consent; does not imply assessment start or recording-slot ownership.';

-- Bind an attempt to its reusable phone session before consent. The attempt's
-- engagement is authoritative; the worker-provided session id is accepted only
-- after the database verifies candidate, role, deterministic room, answered
-- lifecycle and the one-to-one phone-engagement claim. This never writes
-- phone_call_attempts.session_id or phone_engagements.session_id.
create or replace function screening_v2.bind_phone_attempt_recording_session(
  p_attempt_id uuid,
  p_session_id uuid,
  p_engagement_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
  v_sess screening_v2.call_sessions%rowtype;
  v_other_live integer;
begin
  if p_attempt_id is null or p_session_id is null or p_engagement_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  select * into v_eng
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;
  if not found then
    return jsonb_build_object('status', 'unknown_engagement');
  end if;

  select * into v_att
    from screening_v2.phone_call_attempts
   where id = p_attempt_id
   for update;
  if not found or v_att.engagement_id <> v_eng.id then
    return jsonb_build_object('status', 'attempt_engagement_mismatch');
  end if;
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal');
  end if;
  if v_eng.state not in ('dialing', 'in_call') then
    return jsonb_build_object('status', 'not_answered', 'engagement_state', v_eng.state);
  end if;
  if v_att.state not in ('answered_unclassified', 'human') then
    return jsonb_build_object('status', 'attempt_not_answered', 'attempt_state', v_att.state);
  end if;

  select * into v_sess
    from screening_v2.call_sessions
   where id = p_session_id
   for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;
  if v_sess.external_call_id is distinct from ('phone-' || p_session_id::text) then
    return jsonb_build_object('status', 'session_room_mismatch');
  end if;
  if v_sess.candidate_id <> v_eng.candidate_id then
    return jsonb_build_object('status', 'session_candidate_mismatch');
  end if;
  if v_sess.role_id is not null and v_eng.role_id is not null
     and v_sess.role_id <> v_eng.role_id then
    return jsonb_build_object('status', 'session_role_mismatch');
  end if;
  if v_sess.status not in ('created', 'waiting', 'in_progress') then
    return jsonb_build_object('status', 'session_not_active');
  end if;
  if v_sess.phone_engagement_id is not null
     and v_sess.phone_engagement_id <> v_eng.id then
    return jsonb_build_object('status', 'session_engagement_mismatch');
  end if;
  -- A pre-migration unclaimed reusable session can be adopted only when this
  -- is the candidate's sole live engagement. That is the database equivalent
  -- of ensureSession's unambiguous-adoption guard; it prevents a worker id
  -- from cross-binding one application to another while allowing an old,
  -- safely reusable session to gain its evidence-only claim.
  if v_sess.phone_engagement_id is null and v_eng.session_id is distinct from p_session_id then
    select count(*) into v_other_live
      from screening_v2.phone_engagements e
     where e.candidate_id = v_eng.candidate_id
       and e.terminal_at is null
       and e.id <> v_eng.id;
    if v_other_live > 0 then
      return jsonb_build_object('status', 'session_engagement_unbound');
    end if;
  end if;
  if v_att.recording_session_id is not null
     and v_att.recording_session_id <> p_session_id then
    return jsonb_build_object('status', 'attempt_session_mismatch');
  end if;

  update screening_v2.call_sessions
     set phone_engagement_id = coalesce(phone_engagement_id, v_eng.id)
   where id = p_session_id;
  update screening_v2.phone_call_attempts
     set recording_session_id = coalesce(recording_session_id, p_session_id)
   where id = p_attempt_id;

  return jsonb_build_object(
    'status', 'ok',
    'attempt_id', p_attempt_id,
    'session_id', p_session_id,
    'engagement_id', v_eng.id,
    'bound', true
  );
exception when unique_violation then
  return jsonb_build_object('status', 'session_engagement_race');
end;
$$;

revoke all on function screening_v2.bind_phone_attempt_recording_session(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.bind_phone_attempt_recording_session(uuid, uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.bind_phone_attempt_recording_session(uuid, uuid, uuid, timestamptz) is
  'Binds attempt evidence to a validated reusable phone session before consent without setting assessment session_id or session recording slot. Service-role-only.';

comment on column screening_v2.phone_call_attempts.recording_sha256 is
  'Server-calculated SHA-256 of the attempt object. Null until byte verification.';
comment on column screening_v2.phone_call_attempts.recording_size_bytes is
  'Server-observed byte size of the attempt object. Null until byte verification.';
comment on column screening_v2.phone_call_attempts.recording_content_type is
  'Server-sniffed audio container type; never copied from a worker or manifest.';
comment on column screening_v2.phone_call_attempts.recording_ready is
  'True only after object bytes, magic, size, digest and canonical manifest pass.';
comment on column screening_v2.phone_call_attempts.recording_quarantined is
  'Fail-closed attempt artifact quarantine flag; parent session gates also apply.';
comment on column screening_v2.phone_call_attempts.recording_deleted_at is
  'Forward-compatible attempt tombstone. Parent session tombstones already deny reads.';

-- 0043 predates the readiness columns and clears only object keys. Replacing
-- its verified-purge writer forward-only keeps that operation compatible with
-- the 0107 ready check: a purged artifact is explicitly unavailable, never a
-- ready row with missing keys. This is not the DSAR erase/export overhaul;
-- parent lifecycle gates remain the read-time authority in this scope.
create or replace function screening_v2.clear_phone_attempt_recordings(
  p_engagement_id uuid,
  p_actor_id uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_cleared integer := 0;
begin
  if p_engagement_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from screening_v2.phone_engagements where id = p_engagement_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  with cleared as (
    update screening_v2.phone_call_attempts
       set recording_object_key = null,
           recording_manifest_key = null,
           recording_role = null,
           recording_sha256 = null,
           recording_size_bytes = null,
           recording_content_type = null,
           recording_ready = false,
           recording_quarantined = false,
           recording_deleted_at = coalesce(recording_deleted_at, p_now)
     where engagement_id = p_engagement_id
       and (recording_object_key is not null or recording_ready = true)
     returning 1
  )
  select count(*) into v_cleared from cleared;

  if v_cleared > 0 then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
       case when p_actor_id is null then 'system' else 'recruiter' end,
       'phone_recording_purged', 'phone_engagement', p_engagement_id::text, 'success',
       jsonb_build_object('cleared', v_cleared));
  end if;

  return jsonb_build_object('status', 'ok', 'cleared', v_cleared);
end;
$$;

revoke all on function screening_v2.clear_phone_attempt_recordings(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.clear_phone_attempt_recordings(uuid, uuid, timestamptz)
  to service_role;
