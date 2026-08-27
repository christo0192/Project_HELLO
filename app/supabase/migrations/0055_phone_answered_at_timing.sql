-- 0055 — record answer time for direct classification paths.
--
-- Some LiveKit/telephony paths can deliver classify.human or classify.machine
-- directly while the engagement is still dialing. The existing event RPC stamps
-- classified_at for those paths but only stamps answered_at for the separate
-- answered_unclassified transition. A trigger keeps answer timing truthful
-- without changing the event state machine: classification after dialing is
-- evidence that a call was answered, while pre-answer end states remain null.

create or replace function screening_v2.stamp_phone_answered_at()
returns trigger
language plpgsql
set search_path = pg_catalog, screening_v2
as $$
begin
  if new.answered_at is null
     and new.state in ('answered_unclassified', 'human', 'machine') then
    new.answered_at := coalesce(new.classified_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_phone_attempt_answered_at
  on screening_v2.phone_call_attempts;
create trigger trg_phone_attempt_answered_at
before insert or update of state, classified_at, answered_at
on screening_v2.phone_call_attempts
for each row execute function screening_v2.stamp_phone_answered_at();

revoke all on function screening_v2.stamp_phone_answered_at() from public, anon, authenticated;
