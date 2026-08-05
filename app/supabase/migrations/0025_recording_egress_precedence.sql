-- =====================================================================
-- 0025 — Recording egress precedence / repoint (I‑1 through I‑5).
--
-- Fixes four root-cause defects that compose into "browser-only audio
-- wins over a completed room-composite egress":
--   RC‑1: client uploads fallback on pending, not only on failure
--   RC‑2: upload route has no egress-precedence gate
--   RC‑3: pending never converges server-side
--   RC‑4: finalize short-circuits on any key, regardless of provenance
--
-- DESIGN:
--   1. call_sessions gains recording_superseded_object_key (tracks
--      displaced browser object for retention/GC, not orphaned).
--   2. recording_integrity_events event_type CHECK widened to accept
--      'repointed' (additive; existing 'uploaded' unique partial index
--      is untouched — 'repointed' does not trigger it).
--   3. finalize_authoritative_recording(p_session_id, p_object_key,
--      p_sha256, p_size_bytes, p_content_type, p_correlation_id) —
--      security-definer, service-role-only, FOR UPDATE lock,
--      returning jsonb. Permits browser→egress upgrade under CAS;
--      refuses terminal_state (deleted/revoked/quarantined, I‑3);
--      idempotent via 'already_authoritative'.
--   4. All columns/constraints are additive; no reverse SQL.
--   5. No session IDs or real candidate data in this file.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. recording_superseded_object_key — tracks displaced browser object
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_superseded_object_key;
alter table screening_v2.call_sessions
  add column if not exists recording_superseded_object_key text;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_superseded_object_key
    check (recording_superseded_object_key is null
           or length(recording_superseded_object_key) <= 512)
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_superseded_object_key;

comment on column screening_v2.call_sessions.recording_superseded_object_key is
  'When a browser_upload object is displaced by an authoritative livekit_egress '
  'finalization, the old key is recorded here so retention/GC can target it. '
  'Null in all other cases. Bounded to 512 characters.';


-- ═══════════════════════════════════════════════════════════════════════
-- 2. Widen chk_recording_integrity_events_event_type with 'repointed'
--
-- Additive only: 'uploaded' is still unique-per-session via the existing
-- partial index uq_v2_recording_integrity_events_uploaded_once, so the
-- 'repointed' event cannot collide with it. The widened CHECK is
-- backwards-compatible — existing rows only include the prior set.
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.recording_integrity_events
  drop constraint if exists chk_recording_integrity_events_event_type;
alter table screening_v2.recording_integrity_events
  add constraint chk_recording_integrity_events_event_type
    check (event_type in (
      'uploaded','verified','mismatch_quarantined','revoked','deleted','restored',
      'repointed'
    ))
    not valid;
alter table screening_v2.recording_integrity_events
  validate constraint chk_recording_integrity_events_event_type;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. finalize_authoritative_recording RPC
--
-- Atomically links an authoritative egress object to a session.
-- Permitted paths:
--   a) No key yet → link as livekit_egress + 'uploaded' event (normal)
--   b) Browser key exists → repoint to livekit_egress + 'repointed' event
--      (the displaced browser key goes into recording_superseded_object_key)
--   c) Already livekit_egress → 'already_authoritative' (idempotent)
-- Refused paths:
--   - deleted / revoked / quarantined row → 'terminal_state', NO mutation
--   - No recording_egress_id → 'no_egress'
-- Service-role-only. FOR UPDATE serialises concurrent finalizations.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.finalize_authoritative_recording(
  p_session_id uuid,
  p_object_key text,
  p_sha256 text,
  p_size_bytes bigint,
  p_content_type text,
  p_correlation_id text
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

  -- ═══════════════════════════════════════════════════════════════
  -- Lock the session row to serialise concurrent finalizations.
  -- ═══════════════════════════════════════════════════════════════

  select recording_object_key,
         recording_provenance,
         recording_egress_id,
         recording_superseded_object_key,
         recording_deleted_at,
         recording_revoked_at,
         recording_quarantined
    into v_row
    from screening_v2.call_sessions
   where id = p_session_id
     for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  -- I‑3: terminal-state gate — never touch deleted, revoked, or quarantined.
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
  -- ═══════════════════════════════════════════════════════════════

  if v_row.recording_object_key is null then
    update screening_v2.call_sessions
       set recording_object_key = p_object_key,
           recording_sha256 = p_sha256,
           recording_size_bytes = p_size_bytes,
           recording_content_type = p_content_type,
           recording_provenance = 'livekit_egress',
           recording_integrity_verified_at = now()
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
  -- Branch: browser key exists → repoint to livekit_egress (I‑4).
  -- Move old key into superseded column for retention/GC.
  -- The browser_upload coherence constraint (0014 §7) is satisfied because
  -- provenance moves off 'browser_upload' while digest columns stay populated.
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
         recording_integrity_verified_at = now()
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

revoke all on function screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text) from public, anon, authenticated;
grant execute on function screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text) to service_role;

comment on function screening_v2.finalize_authoritative_recording is
  'Authoritative recording finalizer. Links a livekit_egress object to the '
  'session, atomically repointing a pre-existing browser_upload key to the '
  'superseded column when a browser upload won the race. Refuses '
  'deleted/revoked/quarantined rows (terminal_state). Idempotent '
  '(already_authoritative). Service-role-only. FOR UPDATE serialises '
  'concurrent finalizations. Produces an ''uploaded'' or ''repointed'' '
  'integrity event.';


-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
