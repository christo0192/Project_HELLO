-- 0062 — converge the attempt egress projection from session authority.
-- Session finalization is authoritative; this trigger only mirrors the exact
-- bound session/egress onto its attempt and never invents an association.

create or replace function screening_v2.sync_phone_attempt_egress_projection()
returns trigger language plpgsql security definer
set search_path = pg_catalog, screening_v2
as $$
begin
  if new.recording_egress_id is null
     or new.recording_egress_status is null then
    return new;
  end if;

  update screening_v2.phone_call_attempts
     set egress_id = new.recording_egress_id,
         egress_status = case
           when new.recording_egress_status in ('active', 'complete', 'failed')
           then new.recording_egress_status else egress_status end
   where session_id = new.id
     and (egress_id is null or egress_id = new.recording_egress_id);
  return new;
end;
$$;

drop trigger if exists trg_sync_phone_attempt_egress_projection
  on screening_v2.call_sessions;
create trigger trg_sync_phone_attempt_egress_projection
after update of recording_egress_id, recording_egress_status
on screening_v2.call_sessions
for each row execute function screening_v2.sync_phone_attempt_egress_projection();

comment on function screening_v2.sync_phone_attempt_egress_projection is
  'Mirrors an exact session-bound recording egress onto its phone attempt. '
  'No session_id match means no write; conflicting egress ids are never '
  'overwritten. Session finalization remains authoritative.';
