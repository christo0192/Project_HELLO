-- =====================================================================
-- 0108 — make the attempt-recording quarantine executable.
--
-- WHY THIS EXISTS
-- ---------------
-- 0107 added `chk_phone_call_attempts_recording_ready`, which requires
--
--     recording_ready = false
--     or (… and recording_quarantined = false)
--
-- and the only code path that sets `recording_quarantined = true` — the
-- attempt download route's integrity re-verify — wrote that flag ALONE, on a
-- row it had already proven `recording_ready = true`. Every execution was
-- therefore a guaranteed 23514 check violation: the route returned 500, the
-- row was never quarantined, no audit evidence was written, and the candidate
-- page kept offering a download button for an object whose bytes no longer
-- match their digest. The containment mechanism did not exist.
--
-- The session-side equivalent has been right since 0014: `quarantine_recording`
-- locks the row, CAS-checks the flag so the deny is reported exactly once, and
-- flips it. This gives attempts the same thing rather than patching the UPDATE
-- at the call site, because the flag flip and the reason must not drift apart.
-- =====================================================================

-- ── Why the evidence lives HERE and not in recording_integrity_events ──
-- The obvious move was to append a `mismatch_quarantined` row like 0014 does.
-- It is a trap. 0014:557 declares
--
--     create unique index uq_v2_recording_integrity_events_mismatch_once
--       on screening_v2.recording_integrity_events (session_id)
--       where event_type = 'mismatch_quarantined';
--
-- keyed on the SESSION alone. Phone sessions are deliberately REUSED across
-- attempts, so a second attempt's evidence row would raise 23505, abort the
-- function, roll back the flag flip in the same transaction, and hand the
-- route a 500 with nothing quarantined — the very defect this migration
-- exists to remove, with a different SQLSTATE. Worse, an attempt-scoped row
-- written first would then make 0014's own session-side `quarantine_recording`
-- collide, breaking a path that works today.
--
-- Re-keying that index would mean dropping it, which the forward-only rollback
-- gate refuses (and rightly: it is a live exactly-once guarantee). So the
-- attempt carries its own reason column, mirroring `call_sessions`
-- `recording_quarantine_reason`, and the route writes its `recording.quarantined`
-- audit event as it already did.
alter table screening_v2.phone_call_attempts
  add column if not exists recording_quarantine_reason text;

comment on column screening_v2.phone_call_attempts.recording_quarantine_reason is
  '0108: why this attempt''s recording was quarantined at download-time '
  're-verification (digest mismatch, oversize). Mirrors '
  '`call_sessions.recording_quarantine_reason`. Attempt-scoped evidence is NOT '
  'written to recording_integrity_events: its exactly-once index is keyed on '
  'session_id alone, and phone sessions are reused across attempts.';

-- ── Quarantine an attempt's recording, atomically and exactly once ───
create or replace function screening_v2.quarantine_phone_attempt_recording(
  p_attempt_id      uuid,
  p_reason          text,
  p_expected_sha256 text default null,
  p_actual_sha256   text default null,
  p_size_bytes      bigint default null,
  p_correlation_id  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att record;
begin
  if p_attempt_id is null then
    return jsonb_build_object('status', 'attempt_not_found');
  end if;

  -- Serialise concurrent download clicks on the same attempt. A second click
  -- BLOCKS here and re-reads only after the first commits, so it can never
  -- observe an uncommitted `already_quarantined`.
  select id, recording_quarantined, recording_deleted_at
    into v_att
    from screening_v2.phone_call_attempts
   where id = p_attempt_id
   for update;

  if not found then
    return jsonb_build_object('status', 'attempt_not_found');
  end if;

  -- An erased recording is already unreachable; do not resurrect a reason for
  -- an object that no longer exists.
  if v_att.recording_deleted_at is not null then
    return jsonb_build_object('status', 'already_deleted');
  end if;

  -- CAS: the deny is reported once, and the reason of the FIRST detection is
  -- the one kept.
  if coalesce(v_att.recording_quarantined, false) then
    return jsonb_build_object('status', 'already_quarantined');
  end if;

  -- BOTH flags, in one statement. `recording_ready = false` is not cosmetic:
  -- it is what makes the write legal under 0107's CHECK, and it is what stops
  -- the candidate page from continuing to offer the object.
  update screening_v2.phone_call_attempts
     set recording_quarantined = true,
         recording_ready = false,
         recording_quarantine_reason = p_reason
   where id = p_attempt_id;

  return jsonb_build_object(
    'status', 'quarantined',
    -- Echoed so the caller can log what was compared without a second read.
    -- Deliberately not persisted: the digests belong to the download attempt,
    -- not to the row, and the route already audits them.
    'expected_sha256', p_expected_sha256,
    'actual_sha256', p_actual_sha256,
    'size_bytes', p_size_bytes,
    'correlation_id', p_correlation_id
  );
end;
$$;

comment on function screening_v2.quarantine_phone_attempt_recording(uuid, text, text, text, bigint, text) is
  '0108: attempt-scoped mirror of 0014 `quarantine_recording`. Flips '
  'recording_quarantined AND clears recording_ready in ONE statement (0107''s '
  'chk_phone_call_attempts_recording_ready forbids ready+quarantined, which is '
  'why the previous flag-only UPDATE could never execute), under a row lock, '
  'with a CAS so a repeat click changes nothing.';

revoke all on function screening_v2.quarantine_phone_attempt_recording(uuid, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function screening_v2.quarantine_phone_attempt_recording(uuid, text, text, text, bigint, text)
  to service_role;

-- ── NOTE on the other half of this PR, which needs no SQL ────────────
-- 0107's discard latch is reached only from `candidate.wrong_number`, but
-- `phone_identity_mismatch_suppresses()` defaults to NO, so the DEFAULT
-- confirmed-identity-mismatch path posts `candidate.deferred_pre_disclosure`
-- with `not_the_candidate=True` and was never latched — the attempt kept its
-- prepared object key and reported "processing" forever for a call whose audio
-- the worker had deliberately destroyed.
--
-- That is fixed in the API, not here: `latchDiscardedWorkerRecording` already
-- does the right thing (CAS + readback through `markWorkerRecordingFailed`),
-- it was simply wired to one event type. The event type cannot decide it — an
-- ORDINARY pre-disclosure deferral posts the same event and its audio IS
-- deliberately kept (0105) — so the worker now states the discard explicitly
-- and the route latches on that flag.

notify pgrst, 'reload schema';
