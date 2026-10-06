-- =====================================================================
-- 0118 - R1 browser ready LiveKit host.
--
-- The browser worker reports the hostname of the LiveKit endpoint it actually
-- registered with.  This is lease state, rather than API-process state, so an
-- API restart cannot make an already-idle R1 worker appear unready.
-- =====================================================================

set local lock_timeout = '10s';

alter table screening_v2.voice_worker_leases
  add column if not exists livekit_host text;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'voice_worker_leases_livekit_host_format'
       and conrelid = 'screening_v2.voice_worker_leases'::regclass
  ) then
    alter table screening_v2.voice_worker_leases
      add constraint voice_worker_leases_livekit_host_format
      check (
        livekit_host is null
        or (
          char_length(livekit_host) between 1 and 253
          and livekit_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
        )
      ) not valid;
  end if;
end
$$;

alter table screening_v2.voice_worker_leases
  validate constraint voice_worker_leases_livekit_host_format;

comment on column screening_v2.voice_worker_leases.livekit_host is
  'Lowercase DNS hostname of the LiveKit endpoint a browser worker registered '
  'with for its current ready post. NULL is an explicit host-less report and '
  'clears any earlier value (0118).';

create or replace function screening_v2.set_voice_worker_livekit_host(
  p_app          text,
  p_machine_id   text,
  p_livekit_host text,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_updated integer;
begin
  if p_app is null or p_machine_id is null or p_now is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if p_livekit_host is not null
     and not (
       char_length(p_livekit_host) between 1 and 253
       and p_livekit_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
     ) then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set livekit_host = p_livekit_host,
         updated_at   = p_now
   where app = p_app
     and machine_id = p_machine_id
     and state in ('starting', 'ready');
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    return jsonb_build_object('status', 'ok', 'updated', v_updated);
  end if;
  return jsonb_build_object('status', 'stale');
end;
$$;

revoke all on function screening_v2.set_voice_worker_livekit_host(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_voice_worker_livekit_host(text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.set_voice_worker_livekit_host(text, text, text, timestamptz) is
  'Record or clear the LiveKit hostname reported by a starting/ready browser '
  'worker. Returns {status:ok,updated}, {status:stale}, or '
  '{status:invalid_request}. Service-role only.';

notify pgrst, 'reload schema';
