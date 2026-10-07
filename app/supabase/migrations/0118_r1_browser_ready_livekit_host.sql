-- =====================================================================
-- 0118 - R1 browser ready LiveKit host.
--
-- The R1-opted-in browser worker (R1_READINESS_HOST=on) reports the hostname
-- of the LiveKit endpoint it actually registered with.  This is lease state,
-- rather than API-process state, so an API restart cannot make an already-idle
-- R1 worker appear unready.
--
-- FORWARD-ONLY and ADDITIVE: one nullable column, two CHECKs, one new
-- service-role RPC, and two phone-shared RPCs re-declared with ONE extra
-- assignment each (section 4).  It drops nothing.
--
-- BOOT-SCOPED.  The host describes ONE boot of ONE machine, exactly like
-- registered_agent_name (0112), so it is nulled wherever that name is: on every
-- NEW claim and on every reset.  A fresh claim can therefore never inherit the
-- host a previous boot reported, and a host-less report (the Cloud lane, or an
-- R1 worker whose LIVEKIT_URL is not a DNS name) leaves the lease host NULL,
-- which the R1 API gate refuses.
--
-- BROWSER ONLY.  The phone lane has no host: the CHECK in section 2 forbids a
-- non-null host on a phone lease and the RPC in section 3 refuses a non-browser
-- lease, so phone readiness and the phone lease reader never depend on 0118.
-- =====================================================================

set local lock_timeout = '10s';

-- 1. The column.  Nullable, no default: every existing row reads NULL.
alter table screening_v2.voice_worker_leases
  add column if not exists livekit_host text;

-- 2. Constraints.  Both are added NOT VALID and then validated (every existing
-- row is NULL, so validation is immediate and holds no long lock).
--   * format: a lowercase DNS hostname, mirrored by the worker and the API.
--   * browser-only: a phone lease can never carry a host.
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
          and livekit_host ~ (
            '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
            || '([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
          )
        )
      ) not valid;
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'voice_worker_leases_livekit_host_browser_only'
       and conrelid = 'screening_v2.voice_worker_leases'::regclass
  ) then
    alter table screening_v2.voice_worker_leases
      add constraint voice_worker_leases_livekit_host_browser_only
      check (livekit_host is null or pipeline = 'browser') not valid;
  end if;
end
$$;

alter table screening_v2.voice_worker_leases
  validate constraint voice_worker_leases_livekit_host_format;
alter table screening_v2.voice_worker_leases
  validate constraint voice_worker_leases_livekit_host_browser_only;

comment on column screening_v2.voice_worker_leases.livekit_host is
  'Lowercase DNS hostname of the LiveKit endpoint a browser worker registered '
  'with for its CURRENT boot (R1 only; browser leases only). NULL = no host '
  'reported. Nulled on every new claim and on reset (0118), so it can never '
  'outlive its boot.';

-- 3. The host RPC.  BROWSER leases only: a phone lease answers invalid_pipeline
-- and is never written.
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
       and p_livekit_host ~ (
         '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
         || '([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
       )
     ) then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set livekit_host = p_livekit_host,
         updated_at   = p_now
   where app = p_app
     and machine_id = p_machine_id
     and pipeline = 'browser'
     and state in ('starting', 'ready');
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    return jsonb_build_object('status', 'ok', 'updated', v_updated);
  end if;

  -- Reject (never silently treat as stale) a call that names a PHONE lease.
  if exists (
    select 1
      from screening_v2.voice_worker_leases
     where app = p_app
       and machine_id = p_machine_id
       and pipeline <> 'browser'
  ) then
    return jsonb_build_object('status', 'invalid_pipeline');
  end if;
  return jsonb_build_object('status', 'stale');
end;
$$;

revoke all on function screening_v2.set_voice_worker_livekit_host(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_voice_worker_livekit_host(text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.set_voice_worker_livekit_host(text, text, text, timestamptz) is
  'Record or clear the LiveKit hostname reported by a starting/ready BROWSER '
  'worker. Returns {status:ok,updated}, {status:stale}, {status:invalid_pipeline} '
  '(a phone lease: never written) or {status:invalid_request}. Service-role only.';

-- 4. Boot scoping.  claim_voice_worker and reset_voice_worker are shared with
-- the phone lane, so each is re-declared VERBATIM from 0112 (their latest
-- definition; 0114 only names them in a comment) with exactly ONE added
-- assignment: livekit_host = null, next to registered_agent_name = null.  The
-- phone lane is unaffected: a phone lease never carries a host (section 2), so
-- for phone rows the added assignment is a no-op, and the idempotent
-- existing-claim branch below is untouched (it returns the same live lease,
-- i.e. the same boot).  Signatures, security posture and privileges are
-- unchanged and re-issued at the end of this section.

-- ── claim_voice_worker ──────────────────────────────────────────────

create or replace function screening_v2.claim_voice_worker(
  p_app        text,
  p_pipeline   text,
  p_session_id uuid,
  p_epoch      bigint      default null,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.voice_worker_leases%rowtype;
  v_id    uuid;
begin
  if p_app is null or p_pipeline is null or p_session_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if p_pipeline not in ('phone', 'browser') then
    return jsonb_build_object('status', 'invalid_pipeline');
  end if;

  -- Idempotency: a live claim for this session on this app is returned
  -- as-is. A retried admit must never start a second machine.
  select * into v_row
    from screening_v2.voice_worker_leases
   where app = p_app
     and claimed_session_id = p_session_id
     and state in ('starting', 'ready', 'busy', 'draining')
   limit 1;
  if found then
    return jsonb_build_object(
      'status', 'claimed', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
  end if;

  -- Atomically select and lock ONE stopped machine for this app.
  --
  -- M009: LEAST-RECENTLY-STOPPED first (updated_at, then machine_id as the
  -- tie-break), no longer always the lowest machine_id. Every stop path
  -- (reaper, cleanupClaim, terminal drain) POSTs a Fly stop — which only
  -- BEGINS the stop — and resets the lease to `stopped` at once. With the
  -- phone app's kill_timeout now 300 s, the machine can still be `stopping`
  -- (draining) for minutes after its lease reads `stopped`; a start on it
  -- fails and the dial defers. Lowest-id-first handed that same draining
  -- machine to EVERY due dial while other stopped machines sat idle. Picking
  -- the row reset longest ago makes a just-stopped machine the LAST choice,
  -- and a failed start (cleanup resets it again, bumping updated_at) rotates
  -- the next claim onto another machine.
  select id into v_id
    from screening_v2.voice_worker_leases
   where app = p_app
     and pipeline = p_pipeline
     and state = 'stopped'
   order by updated_at, machine_id
   limit 1
   for update skip locked;

  if v_id is null then
    return jsonb_build_object('status', 'no_capacity');
  end if;

  update screening_v2.voice_worker_leases
     set state              = 'starting',
         claimed_session_id = p_session_id,
         epoch              = case when p_epoch is not null and p_epoch > epoch
                                   then p_epoch else epoch + 1 end,
         started_at         = p_now,
         ready_at           = null,
         last_heartbeat_at  = p_now,
         registered_agent_name = null,
         livekit_host       = null,
         updated_at         = p_now
   where id = v_id
   returning * into v_row;

  return jsonb_build_object(
    'status', 'claimed', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
end;
$$;

-- ── reset_voice_worker ──────────────────────────────────────────────

create or replace function screening_v2.reset_voice_worker(
  p_app        text,
  p_machine_id text,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row screening_v2.voice_worker_leases%rowtype;
begin
  if p_app is null or p_machine_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set state              = 'stopped',
         claimed_session_id = null,
         started_at         = null,
         ready_at           = null,
         last_heartbeat_at  = null,
         registered_agent_name = null,
         livekit_host       = null,
         updated_at         = p_now
   where app = p_app
     and machine_id = p_machine_id
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'unknown_machine');
  end if;
  return jsonb_build_object(
    'status', 'stopped', 'machine_id', v_row.machine_id);
end;
$$;

revoke all on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)
  to service_role;

revoke all on function screening_v2.reset_voice_worker(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reset_voice_worker(text, text, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
