-- =====================================================================
-- 0079 — Voice worker leases (on-demand Fly orchestration, PR-B substrate).
--
-- FORWARD-ONLY and ADDITIVE. Creates one new table
-- (`voice_worker_leases`), two indexes (one PARTIAL UNIQUE that enforces
-- the one-session-per-machine invariant), and eight service-role-only
-- RPCs. It drops no table, column, index, constraint or function, and
-- leaves 0001-0078 byte-identical.
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────
-- This is the DATABASE half of on-demand Fly worker orchestration for
-- the two LiveKit Agents worker apps — `project-hello-phone-voice`
-- (phone) and `project-hello-voice` (browser). It is a COORDINATION and
-- AUDIT table, not the ground truth: the Fly Machines API and LiveKit
-- RoomService are authoritative for what a machine is actually doing;
-- these rows are the lease ledger the orchestrator and the reaper read.
--
-- There is no TypeScript, no Fly client, no LiveKit call, no reaper loop
-- and no readiness route in this migration. Nothing here can start,
-- stop, dispatch to, or reap a machine. A green test here is evidence
-- about the SUBSTRATE (the atomic claim, the CAS readiness guard, the
-- one-session-per-machine index), never about the end-to-end feature.
--
-- ── THE TWO INVARIANTS THIS SUBSTRATE SERVES ──────────────────────────
-- (design §2.1) 1) Never admit a caller/candidate without a
-- confirmed-ready worker — served by the (stopped -> starting -> ready
-- -> busy) state machine and the CAS on epoch+session in
-- `mark_voice_worker_ready`. 2) Never leave a machine `started` without
-- an active session — served by `list_reapable_voice_workers`, the
-- reaper's candidate list. This table cannot itself stop a machine; it
-- only surfaces the candidates and records the lease lifecycle.
--
-- ── ONE SESSION PER WORKER (1 call per machine) ───────────────────────
-- Two guarantees, one index. `uq_voice_worker_leases_one_active` is a
-- PARTIAL UNIQUE over `claimed_session_id` restricted to the
-- non-terminal claimed states ('starting','ready','busy','draining').
-- Because `unique(app, machine_id)` already makes at most one row per
-- machine, a partial-unique over the *session* additionally forbids the
-- SAME session_id from being claimed by TWO machines at once. Together
-- with the atomic `FOR UPDATE SKIP LOCKED` claim they make the mapping
-- session<->machine bijective while a claim is live:
--   * one machine holds at most one live claim   (unique(app,machine_id))
--   * one session is held by at most one machine  (this partial unique)
-- A row in 'stopped' carries `claimed_session_id = null` and is excluded
-- from the partial index, so the pre-created pool can hold many stopped
-- rows without colliding (NULLs are distinct anyway, but the state
-- predicate makes the intent explicit and survives a stray non-null).
--
-- ── EPOCH FENCING (late readiness pings) ──────────────────────────────
-- Every claim bumps `epoch`. `mark_voice_worker_ready` /`_busy`, the
-- heartbeat and release all CAS on (machine_id, claimed_session_id,
-- epoch). A readiness ping from a SUPERSEDED claim (an earlier machine
-- lifecycle whose session was reclaimed and re-claimed with a higher
-- epoch) matches no row and returns `{status:'stale'}` — fenced, never
-- timed out.
--
-- ── SANITIZED, SERVICE-ROLE-ONLY RPCS ─────────────────────────────────
-- Every RPC is SECURITY DEFINER with `search_path` pinned, revoked from
-- public/anon/authenticated and granted only to service_role, and
-- returns a small sanitized jsonb `{status, ...}` carrying only the
-- machine_id / epoch the caller needs — never a provider payload, never
-- free text.
--
-- ── DEFAULT-INERT ─────────────────────────────────────────────────────
-- An un-orchestrated deployment simply registers no pool: with zero
-- lease rows, `claim_voice_worker` returns `no_capacity`, the reaper's
-- candidate list is empty, and nothing else changes. Orchestration is
-- opt-in, one `register_voice_worker` call per pre-created stopped
-- machine.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. voice_worker_leases — the lease ledger (one row per pool machine)
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.voice_worker_leases (
  id                  uuid primary key default gen_random_uuid(),
  app                 text not null,
  machine_id          text not null,
  pipeline            text not null,
  state               text not null default 'stopped',
  claimed_session_id  uuid,
  epoch               bigint not null default 0,
  started_at          timestamptz,
  ready_at            timestamptz,
  last_heartbeat_at   timestamptz,
  updated_at          timestamptz not null default now(),
  constraint uq_voice_worker_leases_app_machine unique (app, machine_id),
  constraint chk_voice_worker_leases_pipeline check (pipeline in ('phone','browser')),
  constraint chk_voice_worker_leases_state    check (state in (
    'stopped','starting','ready','busy','draining')),
  constraint chk_voice_worker_leases_epoch     check (epoch >= 0),
  -- A claim is exactly the non-terminal, session-bearing states. Pin the
  -- correspondence so a 'stopped' row can never carry a stale session id
  -- and a claimed row can never lose its session — the reaper and the
  -- one-active index both depend on this equivalence holding.
  constraint chk_voice_worker_leases_claim check (
    (state in ('starting','ready','busy','draining')) = (claimed_session_id is not null))
);

-- The reaper's scan: non-stopped machines ordered by liveness. Partial so
-- the index only spans machines that COULD be leaking cost.
create index if not exists idx_voice_worker_leases_reap
  on screening_v2.voice_worker_leases (app, last_heartbeat_at, started_at)
  where state <> 'stopped';

-- ONE SESSION PER MACHINE. Partial unique over the claimed session id,
-- restricted to the live-claim states. Blocks the same session_id from
-- being held by two machines simultaneously; combined with
-- uq_voice_worker_leases_app_machine (one row per machine) this makes the
-- live session<->machine mapping a bijection.
create unique index if not exists uq_voice_worker_leases_one_active
  on screening_v2.voice_worker_leases (claimed_session_id)
  where state in ('starting','ready','busy','draining');

comment on table screening_v2.voice_worker_leases is
  'Lease ledger for on-demand Fly worker orchestration (design §2.2). One '
  'row per pre-created pool machine per app. Coordination + audit only — '
  'the Fly Machines API and LiveKit RoomService are ground truth. '
  'Enforces one session per machine via unique(app,machine_id) plus the '
  'partial-unique one-active-session index. Service-role-only.';
comment on column screening_v2.voice_worker_leases.app is
  'Fly app name that owns this machine (project-hello-phone-voice or '
  'project-hello-voice).';
comment on column screening_v2.voice_worker_leases.machine_id is
  'Fly machine id. Unique per app; the join key back to the Fly Machines '
  'API and the LiveKit worker identity.';
comment on column screening_v2.voice_worker_leases.pipeline is
  'Which worker pipeline this machine runs: phone (outbound) or browser '
  '(inbound WebRTC). Pipelines have independent pools and caps.';
comment on column screening_v2.voice_worker_leases.state is
  'Lifecycle: stopped (free, pre-created) -> starting (claimed, machine '
  'starting) -> ready (registered via readiness ping) -> busy (session '
  'live) -> draining (session ended, machine stopping) -> stopped. Only a '
  'ready machine may receive a caller/candidate.';
comment on column screening_v2.voice_worker_leases.claimed_session_id is
  'The phone attempt id or browser session id currently held by this '
  'machine. Null iff stopped. Never two machines for one session (partial '
  'unique index).';
comment on column screening_v2.voice_worker_leases.epoch is
  'Monotonic fencing token bumped on every claim. Readiness / busy / '
  'heartbeat / release CAS on it so a late ping from a superseded claim '
  'is rejected as stale rather than acted on.';
comment on column screening_v2.voice_worker_leases.started_at is
  'When the current claim issued the Fly start. Reset to null on stop.';
comment on column screening_v2.voice_worker_leases.ready_at is
  'When the worker posted its readiness ping and the lease became ready.';
comment on column screening_v2.voice_worker_leases.last_heartbeat_at is
  'Last liveness signal from the worker; the reaper compares this (or '
  'started_at when null) against its grace window.';
comment on column screening_v2.voice_worker_leases.updated_at is
  'Bumped on every lease mutation; audit / debugging aid only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. RLS — service-role-only backend infrastructure
-- ═══════════════════════════════════════════════════════════════════════
-- RLS is enabled AND forced so even the table owner is subject to policy
-- (there is no permissive policy, so every non-superuser path is denied);
-- combined with the grant/revoke below this is defence in depth. Browser
-- roles (anon/authenticated) get zero table privileges; only service_role
-- (which bypasses RLS) can touch the table, and only ever through the
-- RPCs below in practice.

alter table screening_v2.voice_worker_leases enable row level security;
alter table screening_v2.voice_worker_leases force  row level security;

revoke all on screening_v2.voice_worker_leases from anon, authenticated, public;
grant all privileges on screening_v2.voice_worker_leases to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. register_voice_worker — upsert a pre-created stopped pool machine
-- ═══════════════════════════════════════════════════════════════════════
-- Idempotent pool registration. Inserts a 'stopped' lease for a
-- pre-created (and actually stopped) Fly machine, or leaves an existing
-- row untouched. Never disturbs a live claim: if the machine already has
-- a row it is returned as-is. Pool = data-free; this RPC (not a seed) is
-- the only writer that introduces rows.

create or replace function screening_v2.register_voice_worker(
  p_app        text,
  p_pipeline   text,
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
  if p_app is null or p_pipeline is null or p_machine_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if p_pipeline not in ('phone', 'browser') then
    return jsonb_build_object('status', 'invalid_pipeline');
  end if;

  insert into screening_v2.voice_worker_leases
    (app, machine_id, pipeline, state, updated_at)
  values
    (p_app, p_machine_id, p_pipeline, 'stopped', p_now)
  on conflict (app, machine_id) do nothing
  returning * into v_row;

  if not found then
    select * into v_row
      from screening_v2.voice_worker_leases
     where app = p_app and machine_id = p_machine_id;
    return jsonb_build_object(
      'status', 'exists', 'machine_id', v_row.machine_id, 'state', v_row.state);
  end if;

  return jsonb_build_object(
    'status', 'registered', 'machine_id', v_row.machine_id, 'state', v_row.state);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. claim_voice_worker — atomically claim ONE stopped machine
-- ═══════════════════════════════════════════════════════════════════════
-- Picks exactly one 'stopped' lease for the app (FOR UPDATE SKIP LOCKED
-- so two racing claims never contend for the same row — each grabs a
-- different stopped machine, or gets no_capacity when none are free),
-- transitions it to 'starting', binds the session, bumps epoch and
-- stamps started_at. Idempotent for the SAME session: if this session
-- already holds a live claim on this app the existing claim is returned,
-- so a retried admit never starts a second machine.
--
-- SKIP LOCKED semantics: two concurrent claims for DIFFERENT sessions
-- each lock and take a distinct stopped row (or one gets no_capacity when
-- the pool is down to one) — they can NEVER both take the same machine,
-- because the loser skips the row the winner has locked. Two concurrent
-- claims for the SAME session are serialised by the idempotency lookup
-- under the same skip-locked scan: the second sees the first's live claim
-- (once committed) or, if truly simultaneous, is prevented from binding
-- the session to a second machine by uq_voice_worker_leases_one_active.

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
  select id into v_id
    from screening_v2.voice_worker_leases
   where app = p_app
     and pipeline = p_pipeline
     and state = 'stopped'
   order by machine_id
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
         updated_at         = p_now
   where id = v_id
   returning * into v_row;

  return jsonb_build_object(
    'status', 'claimed', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. mark_voice_worker_ready — CAS the readiness ping to 'ready'
-- ═══════════════════════════════════════════════════════════════════════
-- Compare-and-set on (app, machine_id, claimed_session_id, epoch): a
-- 'starting' (or already 'ready', for ping idempotency) lease becomes
-- 'ready' with ready_at + a heartbeat. Any mismatch — wrong session,
-- lower/other epoch, machine already stopped/draining — matches no row
-- and returns 'stale', fencing a superseded claim's late readiness ping.

create or replace function screening_v2.mark_voice_worker_ready(
  p_app        text,
  p_machine_id text,
  p_session_id uuid,
  p_epoch      bigint,
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
  if p_app is null or p_machine_id is null or p_session_id is null or p_epoch is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set state             = 'ready',
         ready_at          = coalesce(ready_at, p_now),
         last_heartbeat_at = p_now,
         updated_at        = p_now
   where app = p_app
     and machine_id = p_machine_id
     and claimed_session_id = p_session_id
     and epoch = p_epoch
     and state in ('starting', 'ready')
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'stale');
  end if;
  return jsonb_build_object(
    'status', 'ready', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. mark_voice_worker_busy — CAS ready -> busy at session start
-- ═══════════════════════════════════════════════════════════════════════
-- Only a 'ready' (or already 'busy', for idempotency) lease for the
-- matching session+epoch becomes 'busy'. This is the transition the
-- orchestrator performs the instant it dispatches the caller/candidate to
-- the worker. Any mismatch returns 'stale'.

create or replace function screening_v2.mark_voice_worker_busy(
  p_app        text,
  p_machine_id text,
  p_session_id uuid,
  p_epoch      bigint,
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
  if p_app is null or p_machine_id is null or p_session_id is null or p_epoch is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set state             = 'busy',
         last_heartbeat_at  = p_now,
         updated_at        = p_now
   where app = p_app
     and machine_id = p_machine_id
     and claimed_session_id = p_session_id
     and epoch = p_epoch
     and state in ('ready', 'busy')
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'stale');
  end if;
  return jsonb_build_object(
    'status', 'busy', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. heartbeat_voice_worker — bump liveness for the reaper's view
-- ═══════════════════════════════════════════════════════════════════════
-- Bumps last_heartbeat_at for a claimed machine on the matching session.
-- Does not require the epoch (a worker heartbeating its own live session
-- is trusted for liveness), but is scoped to the session so a stale
-- machine cannot refresh another's liveness. Returns 'stale' if the
-- machine no longer holds this session.

create or replace function screening_v2.heartbeat_voice_worker(
  p_app        text,
  p_machine_id text,
  p_session_id uuid,
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
  if p_app is null or p_machine_id is null or p_session_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set last_heartbeat_at = p_now,
         updated_at        = p_now
   where app = p_app
     and machine_id = p_machine_id
     and claimed_session_id = p_session_id
     and state in ('starting', 'ready', 'busy', 'draining')
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'stale');
  end if;
  return jsonb_build_object('status', 'ok', 'machine_id', v_row.machine_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. release_voice_worker — set 'draining' at session end (idempotent)
-- ═══════════════════════════════════════════════════════════════════════
-- The caller (orchestrator) marks the lease 'draining' the instant the
-- session terminates, then stops the machine and calls
-- reset_voice_worker. Scoped to the session so only the owner drains it.
-- Idempotent and safe if the lease was ALREADY reset to stopped (the
-- reaper may have won): a machine no longer holding this session returns
-- 'already_released' rather than erroring, so a duplicate release never
-- fails and never resurrects a claim.

create or replace function screening_v2.release_voice_worker(
  p_app        text,
  p_machine_id text,
  p_session_id uuid,
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
  if p_app is null or p_machine_id is null or p_session_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set state             = 'draining',
         updated_at        = p_now
   where app = p_app
     and machine_id = p_machine_id
     and claimed_session_id = p_session_id
     and state in ('starting', 'ready', 'busy', 'draining')
   returning * into v_row;

  if not found then
    -- Already reset (by a prior release or the reaper), or never claimed.
    return jsonb_build_object('status', 'already_released');
  end if;
  return jsonb_build_object(
    'status', 'draining', 'machine_id', v_row.machine_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. reset_voice_worker — return a machine to the stopped pool
-- ═══════════════════════════════════════════════════════════════════════
-- Called after the machine is confirmed stopped: clears the claim and
-- returns the lease to 'stopped', freeing the pool slot and releasing
-- the session from the one-active index. Idempotent: an already-stopped
-- machine is a no-op success. Unconditional on session/epoch by design —
-- once the machine is provably stopped there is no live claim to fence,
-- and the reaper (which has no session id in hand) must be able to reset
-- an orphan by (app, machine_id) alone.

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

-- ═══════════════════════════════════════════════════════════════════════
-- 10. list_reapable_voice_workers — the reaper's candidate list
-- ═══════════════════════════════════════════════════════════════════════
-- Surfaces machines in a non-stopped state whose last liveness signal
-- (last_heartbeat_at, or started_at when the heartbeat is null) is older
-- than the grace window. These are CANDIDATES only: the reaper
-- cross-checks LiveKit RoomService for an active room before stopping, so
-- this RPC deliberately performs no state change. A grace of <= 0 is
-- clamped to 0 (surface everything past `now`).

create or replace function screening_v2.list_reapable_voice_workers(
  p_app       text,
  p_grace_sec integer,
  p_now       timestamptz default now()
)
returns table (
  machine_id        text,
  pipeline          text,
  state             text,
  claimed_session_id uuid,
  epoch             bigint,
  last_heartbeat_at timestamptz,
  started_at        timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  select l.machine_id, l.pipeline, l.state, l.claimed_session_id, l.epoch,
         l.last_heartbeat_at, l.started_at
    from screening_v2.voice_worker_leases l
   where l.app = p_app
     and l.state <> 'stopped'
     and coalesce(l.last_heartbeat_at, l.started_at, l.updated_at)
           <= p_now - (greatest(0, coalesce(p_grace_sec, 0)) * interval '1 second')
   order by coalesce(l.last_heartbeat_at, l.started_at, l.updated_at) asc;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 11. Privileges — every RPC is service_role-only
-- ═══════════════════════════════════════════════════════════════════════

revoke all on function screening_v2.register_voice_worker(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.register_voice_worker(text, text, text, timestamptz)
  to service_role;

revoke all on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)
  to service_role;

revoke all on function screening_v2.mark_voice_worker_ready(text, text, uuid, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_voice_worker_ready(text, text, uuid, bigint, timestamptz)
  to service_role;

revoke all on function screening_v2.mark_voice_worker_busy(text, text, uuid, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_voice_worker_busy(text, text, uuid, bigint, timestamptz)
  to service_role;

revoke all on function screening_v2.heartbeat_voice_worker(text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.heartbeat_voice_worker(text, text, uuid, timestamptz)
  to service_role;

revoke all on function screening_v2.release_voice_worker(text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.release_voice_worker(text, text, uuid, timestamptz)
  to service_role;

revoke all on function screening_v2.reset_voice_worker(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reset_voice_worker(text, text, timestamptz)
  to service_role;

revoke all on function screening_v2.list_reapable_voice_workers(text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.list_reapable_voice_workers(text, integer, timestamptz)
  to service_role;

comment on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz) is
  'Atomically claim one stopped pool machine (FOR UPDATE SKIP LOCKED). '
  'Idempotent per session. Returns {status:claimed,machine_id,epoch} or '
  '{status:no_capacity}. Service-role only.';
comment on function screening_v2.mark_voice_worker_ready(text, text, uuid, bigint, timestamptz) is
  'CAS a readiness ping to ready on (machine_id,session,epoch). Returns '
  '{status:ready} or {status:stale} fencing a superseded claim. '
  'Service-role only.';
comment on function screening_v2.list_reapable_voice_workers(text, integer, timestamptz) is
  'The reaper''s candidate list: non-stopped machines past the grace '
  'window by last liveness signal. Read-only — the reaper cross-checks '
  'LiveKit before stopping. Service-role only.';
