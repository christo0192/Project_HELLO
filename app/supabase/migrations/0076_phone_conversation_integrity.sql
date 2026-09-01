-- 0076 — phone conversation integrity terminal metadata.
--
-- Phone sessions can span reconnect attempts, so `ended_at - started_at` is not
-- a truthful call duration. Sum only answered phone-leg intervals. The final
-- live leg has no attempt `ended_at` yet when the session CAS completes; the
-- session's own terminal `ended_at` is its bounded end. Prior reconnect legs
-- use their persisted attempt end, excluding any between-leg/backoff time.

create or replace function screening_v2.set_phone_session_duration()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_duration integer;
begin
  if new.status <> 'completed'
     or old.status = 'completed'
     or new.duration_sec is not null
     or new.ended_at is null
     or new.external_call_id is null
     or new.external_call_id !~ '^phone-[0-9a-fA-F-]{36}$' then
    return new;
  end if;

  select least(
           86400,
           greatest(0, floor(coalesce(sum(
             extract(epoch from (
               least(coalesce(a.ended_at, new.ended_at), new.ended_at)
               - a.answered_at
             ))
           ), 0)))::integer
         )
    into v_duration
    from screening_v2.phone_call_attempts a
   where a.session_id = new.id
     and a.answered_at is not null
     and a.answered_at <= new.ended_at;

  if v_duration > 0 then
    new.duration_sec := v_duration;
  end if;
  return new;
end;
$$;

revoke all on function screening_v2.set_phone_session_duration()
  from public, anon, authenticated;
grant execute on function screening_v2.set_phone_session_duration()
  to service_role;

drop trigger if exists trg_set_phone_session_duration
  on screening_v2.call_sessions;
create trigger trg_set_phone_session_duration
before update of status, ended_at on screening_v2.call_sessions
for each row
when (new.status = 'completed' and old.status is distinct from new.status)
execute function screening_v2.set_phone_session_duration();

comment on function screening_v2.set_phone_session_duration() is
  'Sets phone call_sessions.duration_sec on first completion by summing answered attempt intervals through session ended_at. Excludes ring time and reconnect/backoff gaps; preserves an existing value; service-role-only.';
