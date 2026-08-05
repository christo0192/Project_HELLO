-- Server-authoritative LiveKit Egress tracking. Credentials remain in the API
-- secret store; only the provider's opaque egress identifier and bounded state
-- are persisted.

alter table screening_v2.call_sessions
  add column if not exists recording_egress_id text,
  add column if not exists recording_egress_status text;

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_egress_id;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_egress_id
  check (
    recording_egress_id is null
    or recording_egress_id ~ '^EG_[A-Za-z0-9_-]{4,200}$'
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_egress_id;

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_egress_status;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_egress_status
  check (
    recording_egress_status is null
    or recording_egress_status in ('active', 'complete', 'failed')
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_egress_status;

comment on column screening_v2.call_sessions.recording_egress_id is
  'Opaque LiveKit Egress identifier; never a credential or recording URL.';
comment on column screening_v2.call_sessions.recording_egress_status is
  'Bounded authoritative recording lifecycle: active, complete, or failed.';
