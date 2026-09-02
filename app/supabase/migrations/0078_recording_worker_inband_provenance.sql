-- 0078: allow the in-worker recording provenance value.
--
-- PR A (in-worker recorder) records call audio INSIDE the LiveKit Agents worker
-- (RecorderIO taps candidate + bot TTS → mixed OGG → transcoded MP3 → uploaded
-- to the attempt-scoped object key), replacing LiveKit Cloud egress so the
-- Build-plan concurrent-egress limit (2) stops applying. The finalizer stamps
-- this new origin on the session exactly as it stamps 'livekit_egress' for the
-- egress path; the download/integrity/purge contract is otherwise unchanged.
--
-- ADDITIVE ONLY: this widens the existing CHECK domain by ONE value. No column
-- is added, nothing is backfilled, and the default recording provider stays
-- 'egress' (env RECORDING_PROVIDER) so this migration changes no behavior until
-- an operator opts a deployment into the worker path.
--
-- Idempotent, matching 0014's own drop/add/validate shape for this constraint.

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_provenance;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_provenance
    check (
      recording_provenance is null
      or recording_provenance in ('browser_upload','livekit_egress','worker_inband')
    )
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_provenance;

comment on column screening_v2.call_sessions.recording_provenance is
  'REC-01/04: origin of the recording object: browser_upload (secondary/'
  'degraded path), livekit_egress (LiveKit Cloud server-side egress), or '
  'worker_inband (PR A: recorded inside the agent worker via RecorderIO, mixed '
  'candidate+bot audio, uploaded to the attempt object key). Null before '
  'finalize.';
