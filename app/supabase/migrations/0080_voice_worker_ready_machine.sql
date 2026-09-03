-- =====================================================================
-- 0080 — Machine-level readiness for the BROWSER on-demand worker.
--
-- FORWARD-ONLY and ADDITIVE. Adds ONE new service-role-only RPC
-- (`mark_voice_worker_ready_machine`) and nothing else. It drops no
-- table, column, index, constraint or function, changes no existing
-- RPC, and leaves 0001-0079 byte-identical.
--
-- ── WHY A SECOND READINESS RPC EXISTS ─────────────────────────────────
-- 0079's `mark_voice_worker_ready` is SESSION- and EPOCH-keyed: it CASes
-- on (app, machine_id, claimed_session_id, epoch). That is exactly right
-- for the PHONE pipeline, where the worker learns its session from the
-- dispatch it already received and posts a session-scoped ping AFTER
-- `ctx.connect()`. Phone is dispatch-before-ready: LiveKit holds the
-- explicit dispatch until the cold worker boots, and the session-keyed
-- ping fences a superseded re-dispatch.
--
-- The BROWSER pipeline is the mirror image (design §2.3b B-i + the impl
-- doc's "PR B RISK" note): the candidate is a human waiting live, so the
-- cold start must be hidden BEHIND readiness, and the API must confirm a
-- worker READY *before* it dispatches — READY-BEFORE-DISPATCH. But a
-- named browser worker only learns its session FROM the dispatch, which
-- has not happened yet. At registration/prewarm the worker knows only
-- {app, machine_id}. So the browser worker cannot post a session-keyed
-- ping; it posts a MACHINE-LEVEL ping ("this machine's process is up and
-- registered with LiveKit"), and the API flips the row it ALREADY claimed
-- (which already carries the session + epoch, bound by `claim_voice_worker`
-- at claim time) from 'starting' to 'ready'.
--
-- ── WHY THIS IS SAFE (no wrong-session flip) ──────────────────────────
-- `uq_voice_worker_leases_app_machine` guarantees exactly ONE row per
-- (app, machine_id). `claim_voice_worker` sets state='starting', binds
-- the NEW session, bumps epoch and resets ready_at on every claim. So the
-- instant the API claims machine M for session S at epoch N, the single
-- row reads (starting, S, N). A machine-level ready that CASes
-- 'starting'→'ready' on (app, machine_id) can therefore match ONLY the
-- current claim — "starting on the one row" IS the current claim. There
-- is no stale 'starting' row for a superseded claim to satisfy: a prior
-- claim was either advanced past 'starting' or reset to 'stopped' (which
-- also clears claimed_session_id). Readiness is a property of the
-- machine/process, not of a session; whatever session the row currently
-- holds is exactly the one the API is waiting on, and the dispatch (which
-- carries the session) is what actually binds the work. This is why the
-- phone RPC KEEPS its 4-key CAS and we add a SEPARATE machine RPC rather
-- than overloading — a session-less flip is correct here and would be
-- wrong on the phone path.
--
-- ── DEFAULT-INERT ─────────────────────────────────────────────────────
-- Like 0079, an un-orchestrated deployment registers no pool, so there is
-- never a 'starting' row for this RPC to flip; it is reachable only when
-- an operator turns orchestration on and registers browser pool machines.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- mark_voice_worker_ready_machine — CAS a session-less ready to 'ready'
-- ═══════════════════════════════════════════════════════════════════════
-- Compare-and-set on (app, machine_id) alone: a 'starting' (or already
-- 'ready', for ping idempotency) lease becomes 'ready' with ready_at + a
-- heartbeat, WITHOUT naming the session or epoch — the row already carries
-- them from the claim. Any state other than starting/ready (stopped,
-- busy, draining) or an unknown machine matches no row and returns
-- 'stale', so a late ping never resurrects a finished claim and never
-- pre-empts a live one.

create or replace function screening_v2.mark_voice_worker_ready_machine(
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
     set state             = 'ready',
         ready_at          = coalesce(ready_at, p_now),
         last_heartbeat_at = p_now,
         updated_at        = p_now
   where app = p_app
     and machine_id = p_machine_id
     and state in ('starting', 'ready')
   returning * into v_row;

  if not found then
    -- No claimed-and-starting row for this machine: stopped (no live
    -- claim to ready), busy/draining (past readiness), or unknown machine.
    -- Fenced, exactly like the session-keyed RPC's 'stale'.
    return jsonb_build_object('status', 'stale');
  end if;
  return jsonb_build_object(
    'status', 'ready', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Privileges — service_role-only, mirroring every 0079 RPC
-- ═══════════════════════════════════════════════════════════════════════

revoke all on function screening_v2.mark_voice_worker_ready_machine(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_voice_worker_ready_machine(text, text, timestamptz)
  to service_role;

comment on function screening_v2.mark_voice_worker_ready_machine(text, text, timestamptz) is
  'Machine-level (session-less) readiness for the browser pipeline: CAS '
  'the row already claimed for (app,machine_id) from starting to ready, so '
  'ready-before-dispatch works when the worker does not yet know its '
  'session. Returns {status:ready} or {status:stale}. Service-role only.';
