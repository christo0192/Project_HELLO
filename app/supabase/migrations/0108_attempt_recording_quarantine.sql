-- =====================================================================
-- 0108 — make the attempt-recording quarantine executable, and give the
-- integrity log somewhere to record it.
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
-- row was never quarantined, no audit or integrity evidence was written, and
-- the candidate page kept offering a download button for an object whose bytes
-- no longer match their digest. The containment mechanism did not exist.
--
-- The session-side equivalent has been right since 0014: `quarantine_recording`
-- locks the row, CAS-checks the flag so evidence is written exactly once, flips
-- it, and appends a `mismatch_quarantined` row. This migration gives attempts
-- the same thing rather than patching the UPDATE at the call site, because the
-- flag flip and the evidence row must not be able to drift apart.
-- =====================================================================

-- ── The integrity log can name an attempt ────────────────────────────
-- `session_id` stays NOT NULL: every integrity event is still anchored to a
-- session, and a gate-death attempt has `recording_session_id` (0107's
-- evidence-only binding) even when consent never bound `session_id`. The new
-- column says WHICH attempt's object the event is about, which the session
-- alone cannot express now that one reused session spans several attempts.
alter table screening_v2.recording_integrity_events
  add column if not exists attempt_id uuid
    references screening_v2.phone_call_attempts(id) on delete cascade;

create index if not exists idx_recording_integrity_events_attempt
  on screening_v2.recording_integrity_events (attempt_id)
  where attempt_id is not null;

comment on column screening_v2.recording_integrity_events.attempt_id is
  '0108: the phone attempt whose object this event describes. NULL for the '
  'session-scoped events 0014 already wrote. Set for attempt-scoped '
  'quarantine, where one reused session spans several attempts and the '
  'session id alone cannot say which recording failed verification.';

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
  v_session_id uuid;
begin
  if p_attempt_id is null then
    return jsonb_build_object('status', 'attempt_not_found');
  end if;

  -- Serialise concurrent download clicks on the same attempt.
  select id, session_id, recording_session_id, recording_quarantined
    into v_att
    from screening_v2.phone_call_attempts
   where id = p_attempt_id
   for update;

  if not found then
    return jsonb_build_object('status', 'attempt_not_found');
  end if;

  -- CAS: a second click writes no second piece of evidence.
  if coalesce(v_att.recording_quarantined, false) then
    return jsonb_build_object('status', 'already_quarantined');
  end if;

  -- BOTH flags, in one statement. `recording_ready = false` is not cosmetic:
  -- it is what makes the write legal under 0107's CHECK, and it is what stops
  -- the candidate page from continuing to offer the object.
  update screening_v2.phone_call_attempts
     set recording_quarantined = true,
         recording_ready = false
   where id = p_attempt_id;

  -- Evidence. The event is anchored to whichever session the attempt is bound
  -- to; a pre-consent attempt has only the evidence-only pointer.
  v_session_id := coalesce(v_att.session_id, v_att.recording_session_id);
  if v_session_id is not null then
    insert into screening_v2.recording_integrity_events
      (session_id, attempt_id, event_type, sha256_expected, sha256_actual,
       size_bytes, detail, correlation_id)
    values
      (v_session_id, p_attempt_id, 'mismatch_quarantined', p_expected_sha256,
       p_actual_sha256, p_size_bytes, p_reason, p_correlation_id);
    return jsonb_build_object('status', 'quarantined', 'evidence', true);
  end if;

  -- An attempt bound to no session at all cannot carry an integrity row
  -- (`session_id` is NOT NULL by 0014). Containment still wins: the flags are
  -- flipped and the caller is told the log entry was skipped, rather than the
  -- whole quarantine failing for want of a log line.
  return jsonb_build_object('status', 'quarantined', 'evidence', false);
end;
$$;

comment on function screening_v2.quarantine_phone_attempt_recording(uuid, text, text, text, bigint, text) is
  '0108: attempt-scoped mirror of 0014 `quarantine_recording`. Flips '
  'recording_quarantined AND clears recording_ready in one statement (0107''s '
  'chk_phone_call_attempts_recording_ready forbids ready+quarantined, which is '
  'why the previous flag-only UPDATE could never execute), and appends exactly '
  'one mismatch_quarantined integrity event under a row lock.';

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
-- does exactly the right thing (CAS + readback through
-- `markWorkerRecordingFailed`), it was simply wired to one event type. The
-- event type cannot decide this on its own — an ORDINARY pre-disclosure
-- deferral posts the same event and its audio IS deliberately kept (0105) — so
-- the worker now states the discard explicitly and the route latches on that
-- flag. No new SQL is needed for it, and none is added: a second latch
-- function would have been a second thing to keep in step with the first.

notify pgrst, 'reload schema';
