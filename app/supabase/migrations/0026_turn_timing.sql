-- =====================================================================
-- 0026 — Turn timing anchors + extended authoritative finalizer.
--
-- Enables turn-level seeking against the RoomComposite Egress recording
-- (see docs: candidate recording/transcript sync PR, Step 1):
--   1. call_sessions.recording_egress_started_at_ms — authoritative
--      recording-timeline origin, captured from EgressInfo.startedAt
--      (nanoseconds since epoch / 1e6) on the LiveKit server clock.
--   2. transcript_turns.turn_started_at_ms — per-turn epoch anchor on the
--      agent wall clock (metrics.started_speaking_at preferred, created_at
--      fallback), persisted by the voice worker (Step 3).
--
-- Both columns are NULLABLE bigint: legacy rows and non-egress fallback
-- recordings stay NULL, and the derived offset (turn_ms - egress_ms) is
-- computed at read time in the API (Step 2), not stored.
--
-- RPC CHANGE (compatibility-safe):
--   finalize_authoritative_recording gains a seventh, final argument
--   p_recording_egress_started_at_ms bigint DEFAULT NULL. The old six-arg
--   overload is DROPPED so that legacy callers resolve to this single
--   extended function through the DEFAULT — no lingering six-arg overload
--   that could silently bypass the timing-anchor capture. Existing callers
--   (the current 6-parameter API rpc) keep working unchanged.
--
-- The 0025 body is preserved verbatim in behaviour: identical input
-- validation, FOR UPDATE row lock, terminal-state gate
-- (deleted/revoked/quarantined), no_egress gate, provenance_conflict,
-- idempotent 'already_authoritative', first-writer 'uploaded' evidence,
-- browser→egress 'repointed' evidence, and identical return statuses.
-- The ONLY functional additions are:
--   a) new input validation for the egress-start anchor
--      (null, or 0 < v < 4102444800000 = year 2100 boundary), and
--   b) recording_egress_started_at_ms = coalesce(existing, incoming) in
--      both mutation branches — fill-once, never clobber an egress start
--      already captured at start time (Step 2) with a later finalize-time
--      value. Immutability: once set, the anchor is a property of the
--      egress and is never overwritten.
--
-- Grants mirror 0025 exactly, re-applied to the 7-arg signature:
-- service_role-only EXECUTE; revoked from public/anon/authenticated.
-- All DDL is additive / replaceable; no reverse SQL; no data.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. call_sessions.recording_egress_started_at_ms — nullable bigint anchor
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.call_sessions
  add column if not exists recording_egress_started_at_ms bigint;

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_egress_started_at_ms;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_egress_started_at_ms
    check (recording_egress_started_at_ms is null
           or (recording_egress_started_at_ms > 0
               and recording_egress_started_at_ms < 4102444800000))
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_egress_started_at_ms;

comment on column screening_v2.call_sessions.recording_egress_started_at_ms is
  'Unix milliseconds (LiveKit server clock) when the RoomComposite Egress '
  'recording actually started, from EgressInfo.startedAt/1e6. Null until '
  'captured; null for legacy and non-egress sessions. Bounded to a '
  'plausible epoch window (post-1970, pre-2100). Immutable once set.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. transcript_turns.turn_started_at_ms — nullable bigint turn anchor
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.transcript_turns
  add column if not exists turn_started_at_ms bigint;

alter table screening_v2.transcript_turns
  drop constraint if exists chk_transcript_turns_turn_started_at_ms;
alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_turn_started_at_ms
    check (turn_started_at_ms is null
           or (turn_started_at_ms > 0
               and turn_started_at_ms < 4102444800000))
    not valid;
alter table screening_v2.transcript_turns
  validate constraint chk_transcript_turns_turn_started_at_ms;

comment on column screening_v2.transcript_turns.turn_started_at_ms is
  'Unix milliseconds (agent wall clock) when this turn started speaking, '
  'preferring ChatMessage.metrics.started_speaking_at with a '
  'ChatMessage.created_at fallback. Null for legacy turns and the opening '
  'line (no conversation item anchor). Bounded to a plausible epoch window.';


-- ═══════════════════════════════════════════════════════════════════════
-- 3. finalize_authoritative_recording — extended with a default final arg
--
-- Replaces the 0025 six-arg function. The old overload is dropped so no
-- six-arg entry point remains that could bypass the timing-anchor capture;
-- legacy six-argument callers (including the current API rpc) resolve to
-- this function through the DEFAULT NULL final argument.
-- All 0025 behaviour is preserved exactly (validation order and messages,
-- FOR UPDATE, terminal-state gate, no_egress, provenance_conflict,
-- idempotency, 'uploaded'/'repointed' audit evidence, return statuses).
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text);

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
begin
  -- ═══════════════════════════════════════════════════════════════
  -- Input validation (defence in depth for service-role RPC)
  -- Unchanged from 0025, then extended with the timing-anchor check.
  -- ═══════════════════════════════════════════════════════════════

  if p_object_key is null
     or p_object_key <> (p_session_id::text || '-egress.ogg')
     or octet_length(p_object_key) > 512 then
    return jsonb_build_object('status', 'invalid_object_key');
  end if;

  if p_sha256 is null
     or not (p_sha256 ~ '^[a-f0-9]{64}$') then
    return jsonb_build_object('status', 'invalid_sha256');
  end if;

  if p_size_bytes is null
     or p_size_bytes <= 0
     or p_size_bytes > 52428800 then
    return jsonb_build_object('status', 'invalid_size_bytes');
  end if;

  if p_content_type is null
     or p_content_type <> 'audio/ogg' then
    return jsonb_build_object('status', 'invalid_content_type');
  end if;

  -- NEW (0026): egress-start anchor validation. NULL is legal (legacy
  -- callers that predate the timing contract). Non-null must fall inside
  -- the same bounded epoch window enforced by the column CHECK constraint.
  if p_recording_egress_started_at_ms is not null
     and (p_recording_egress_started_at_ms <= 0
          or p_recording_egress_started_at_ms >= 4102444800000) then
    return jsonb_build_object('status', 'invalid_egress_start');
  end if;

  -- ═══════════════════════════════════════════════════════════════
  -- Lock the session row to serialise concurrent finalizations.
  -- Unchanged from 0025 (the timing anchor is read for audit context).
  -- ═══════════════════════════════════════════════════════════════

  select recording_object_key,
         recording_provenance,
         recording_egress_id,
         recording_superseded_object_key,
         recording_deleted_at,
         recording_revoked_at,
         recording_quarantined,
         recording_egress_started_at_ms
    into v_row
    from screening_v2.call_sessions
   where id = p_session_id
     for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  -- I-3: terminal-state gate — never touch deleted, revoked, or quarantined.
  if v_row.recording_deleted_at is not null
     or v_row.recording_revoked_at is not null
     or v_row.recording_quarantined = true then
    return jsonb_build_object('status', 'terminal_state');
  end if;

  -- Require an egress to exist for this path.
  if v_row.recording_egress_id is null then
    return jsonb_build_object('status', 'no_egress');
  end if;

  -- Idempotent: already authoritative from livekit_egress.
  if v_row.recording_provenance = 'livekit_egress' then
    return jsonb_build_object('status', 'already_authoritative');
  end if;

  -- Only null or browser_upload provenance may transition to livekit_egress.
  -- Anything else (e.g., an unknown future provenance value) is a conflict.
  if v_row.recording_provenance is not null
     and v_row.recording_provenance <> 'browser_upload' then
    return jsonb_build_object('status', 'provenance_conflict',
      'detail', 'provenance is ' || v_row.recording_provenance);
  end if;

  -- ═══════════════════════════════════════════════════════════════
  -- Branch: no key yet → first-writer link (livekit_egress first upload).
  -- Timing anchor is filled with coalesce: a start-time-captured value
  -- (Step 2) is never clobbered by the later finalize-time value.
  -- ═══════════════════════════════════════════════════════════════

  if v_row.recording_object_key is null then
    update screening_v2.call_sessions
       set recording_object_key = p_object_key,
           recording_sha256 = p_sha256,
           recording_size_bytes = p_size_bytes,
           recording_content_type = p_content_type,
           recording_provenance = 'livekit_egress',
           recording_integrity_verified_at = now(),
           recording_egress_started_at_ms =
             coalesce(recording_egress_started_at_ms, p_recording_egress_started_at_ms)
     where id = p_session_id;

    insert into screening_v2.recording_integrity_events
      (session_id, event_type, sha256_expected, size_bytes, detail, correlation_id)
    values
      (p_session_id, 'uploaded', p_sha256, p_size_bytes,
       'livekit_egress verified sha256:' || left(p_sha256, 16) || chr(8230),
       p_correlation_id);

    return jsonb_build_object('status', 'ok');
  end if;

  -- ═══════════════════════════════════════════════════════════════
  -- Branch: browser key exists → repoint to livekit_egress (I-4).
  -- Move old key into superseded column for retention/GC.
  -- The browser_upload coherence constraint (0014 §7) is satisfied because
  -- provenance moves off 'browser_upload' while digest columns stay
  -- populated. Timing anchor fill-once as in the first-writer branch.
  -- ═══════════════════════════════════════════════════════════════

  -- Never overwrite a prior superseded key — evidence of a previous repoint.
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
         recording_egress_started_at_ms =
           coalesce(recording_egress_started_at_ms, p_recording_egress_started_at_ms)
   where id = p_session_id;

  -- Append 'repointed' evidence — distinct from 'uploaded', so the partial
  -- unique index on (session_id) where event_type='uploaded' does not fire.
  insert into screening_v2.recording_integrity_events
    (session_id, event_type, sha256_expected, size_bytes, detail, correlation_id)
  values
    (p_session_id, 'repointed', p_sha256, p_size_bytes,
     'browser_upload superseded by livekit_egress sha256:' || left(p_sha256, 16) || chr(8230),
     p_correlation_id);

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint) from public, anon, authenticated;
grant execute on function screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint) to service_role;

comment on function screening_v2.finalize_authoritative_recording is
  'Authoritative recording finalizer. Links a livekit_egress object to the '
  'session, atomically repointing a pre-existing browser_upload key to the '
  'superseded column when a browser upload won the race. Refuses '
  'deleted/revoked/quarantined rows (terminal_state). Idempotent '
  '(already_authoritative). Service-role-only. FOR UPDATE serialises '
  'concurrent finalizations. Produces an ''uploaded'' or ''repointed'' '
  'integrity event. Extended with an optional p_recording_egress_started_at_ms '
  '(DEFAULT NULL) that fills the recording-timeline origin once, never '
  'clobbering a start-time-captured value. Legacy six-argument callers '
  'remain compatible through the default.';


-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
