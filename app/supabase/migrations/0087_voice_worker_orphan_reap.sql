-- =====================================================================
-- 0087 — Voice-worker orphan-reap candidate list (T2③, Call D 2026-09-08).
--
-- FORWARD-ONLY and ADDITIVE. Adds exactly ONE service-role, read-only,
-- STABLE function `list_orphaned_voice_worker_leases`. It creates no table,
-- alters no column, changes no existing function, and reads no row it did not
-- already have RLS access to. Every pre-existing 0079..0086 object is
-- byte-unchanged.
--
-- ── WHY THIS EXISTS — THE REAPER BLIND SPOT ───────────────────────────
-- The reaper's candidate list `list_reapable_voice_workers` (0079 §10) filters
-- `state <> 'stopped'`. That is correct for the leak it was built for: a
-- machine that CLAIMED a session (lease non-stopped) but whose LiveKit room
-- died. But it is BLIND to a second, observed (≥4×) leak class:
--
--   A pool machine that Fly reports `started` while its LEASE reads `stopped`.
--
-- This happens when a machine is brought up OUTSIDE the claim path — a manual
-- `fly machine start`, a prewarm, or the restart side-effect of a
-- `fly secrets set` — so the DB lease was never transitioned out of `stopped`.
-- Because `list_reapable_voice_workers` skips `stopped` rows, the reaper NEVER
-- sees it, and the machine burns VM-hours indefinitely. The prompt-release and
-- terminal-release passes are equally blind (they key on a claimed session).
--
-- This function surfaces the ONLY safe candidate set for that class: rows that
--   (1) EXIST as a lease for this app — so they are MANAGED pool machines, not
--       the unmanaged always-on browser/API machines (which have NO lease row
--       and therefore can NEVER appear here — the structural app-scoping guard),
--   (2) are in state 'stopped' — the DB believes this machine is not running,
--   (3) have not been TOUCHED (updated_at) for at least the grace window — so a
--       machine mid-claim (whose lease just moved stopped→starting, or was just
--       reset by a release) is EXCLUDED: its updated_at is recent. This is the
--       race guard against reaping a machine another process is bringing up.
--
-- It is a CANDIDATE list, exactly like `list_reapable_voice_workers`: it
-- performs NO state change and knows NOTHING about Fly's actual machine state.
-- The reaper cross-checks each candidate against the live Fly Machines API and
-- stops ONLY those Fly actually reports `started` (transitional states like
-- `starting`/`stopping` are skipped by the caller), then resets the row through
-- the SAME `reset_voice_worker` path a normal reap uses. A candidate Fly reports
-- `stopped` is a false alarm (the DB was right) and is left untouched.
--
-- SECURITY: service_role-only, mirroring every 0079 RPC. Read-only + STABLE.
-- =====================================================================

create or replace function screening_v2.list_orphaned_voice_worker_leases(
  p_app       text,
  p_grace_sec integer,
  p_now       timestamptz default now()
)
returns table (
  machine_id text,
  pipeline   text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  -- Pool machines the DB believes are STOPPED but that may have leaked
  -- `started` on Fly out-of-band. Long-idle only: a row touched within the
  -- grace window is EXCLUDED so a concurrent claim/reset is never reaped.
  -- A grace of <= 0 is clamped to 0 (surface everything at/before `now`).
  select l.machine_id, l.pipeline, l.updated_at
    from screening_v2.voice_worker_leases l
   where l.app = p_app
     and l.state = 'stopped'
     and l.updated_at
           <= p_now - (greatest(0, coalesce(p_grace_sec, 0)) * interval '1 second')
   order by l.updated_at asc;
$$;

revoke all on function screening_v2.list_orphaned_voice_worker_leases(text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.list_orphaned_voice_worker_leases(text, integer, timestamptz)
  to service_role;

comment on function screening_v2.list_orphaned_voice_worker_leases(text, integer, timestamptz) is
  'Orphan-reap candidate list (T2③): MANAGED pool machines whose lease reads '
  'stopped but which may have leaked started on Fly out-of-band (manual start, '
  'prewarm, secret-update restart). Long-idle only (updated_at past grace) so a '
  'concurrent claim/reset is excluded. Read-only — the reaper cross-checks the '
  'live Fly machine state and stops only those Fly reports started, via the '
  'normal reset path. Unmanaged always-on machines have no lease row and can '
  'never appear here. Service-role only.';
