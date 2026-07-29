-- =====================================================================
-- 0006 — Canonical session lifecycle (REL-07).
--
-- Expands call_sessions.status from the legacy 4-value set
-- {in_progress, completed, abandoned, failed}
-- to the canonical 7-state set:
-- {created, waiting, in_progress, completed, failed, cancelled, expired}
--
-- Maps legacy `abandoned` → `cancelled` with reason `migrated_abandoned`.
-- Backfills any terminal rows with null terminal_reason → `legacy_unknown`.
-- Adds terminal_reason REQUIRED for terminal states (conditional NOT NULL).
-- Every NEW terminal transition MUST supply a state-compatible fixed reason.
-- Cross-state assignments are rejected at the DB CHECK level.
--
-- **legacy_unknown is migration-only**: The per-state CHECK constraint below
-- allows `legacy_unknown` for any terminal state (backfilled rows). New or
-- updated rows may SET terminal_reason = 'legacy_unknown' but the application
-- layer (persistence.py, session-lifecycle.ts) NEVER accepts it for live
-- transitions. This keeps backfilled rows valid while preventing new use.
--
-- The CHECK constraint is CONDITIONAL (per-state), NOT a column NOT NULL:
-- terminal states MUST have a terminal_reason; non-terminal MUST have NULL.
-- This allows legacy backfilled rows with 'legacy_unknown' while enforcing
-- that every new terminal write supplies a state-compatible reason code.
--
-- Default status for NEW rows is 'created' (enforced at column DEFAULT and
-- at the application layer). Only new INSERTs can create rows; triggers
-- enforce that no transition from any other state can set status='created'.
--
-- Non-lifecycle metadata (ended_at, duration_sec) on terminal rows remains
-- mutable — the transition trigger only fires when status changes.
-- No speculative SECURITY DEFINER reopening seam.
-- =====================================================================

-- ── 1. Drop the legacy status constraint ────────────────────────────
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_status;

-- ── 2. Add new columns ───────────────────────────────────────────────
alter table screening_v2.call_sessions
  add column if not exists waiting_at timestamptz;
alter table screening_v2.call_sessions
  add column if not exists terminal_reason text;

-- ── 3. Change default status to 'created' ─────────────────────────────
alter table screening_v2.call_sessions
  alter column status set default 'created';

-- ── 4. Migrate legacy `abandoned` → `cancelled` ──────────────────────
update screening_v2.call_sessions
  set status = 'cancelled',
      terminal_reason = 'migrated_abandoned'
  where status = 'abandoned';

-- ── 5. Backfill null terminal_reason on terminal rows → legacy_unknown ──
update screening_v2.call_sessions
  set terminal_reason = 'legacy_unknown'
  where status in ('completed', 'failed', 'cancelled', 'expired')
    and terminal_reason is null;

-- ── 6. Add 7-state status constraint ─────────────────────────────────
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_status check (
    status in (
      'created', 'waiting', 'in_progress',
      'completed', 'failed', 'cancelled', 'expired'
    )
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_status;

-- ── 7. Enforce new INSERTs start only at 'created' ──────────────────
-- This trigger prevents INSERTs from bypassing 'created' as the start state.
create or replace function screening_v2.enforce_insert_created()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  -- GOV-06's three immutable, reserved synthetic fixtures are loaded after all
  -- migrations and intentionally represent historical lifecycle states. This
  -- narrow exception cannot be used by runtime UUIDs and requires the exact
  -- demo provider/mode tuple; every other insert must begin at created.
  if new.id in (
       '60000000-0000-4000-a000-000000000031'::uuid,
       '60000000-0000-4000-a000-000000000032'::uuid,
       '60000000-0000-4000-a000-000000000033'::uuid
     )
     and new.provider = 'pipecat'
     and new.mode = 'browser' then
    return new;
  end if;

  if new.status is distinct from 'created' then
    raise exception
      'new sessions must start in status ''created'''
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_insert_created on screening_v2.call_sessions;
create trigger trg_insert_created
  before insert on screening_v2.call_sessions
  for each row
  execute function screening_v2.enforce_insert_created();

-- ── 8. terminal_reason: per-state CONDITIONAL constraint ─────────────
-- Terminal states MUST have a reason (state-compatible, or legacy_unknown).
-- Non-terminal states MUST have null terminal_reason.
-- Cross-state assignments (e.g. completed/provider_error) are rejected.
--
-- This is NOT a column NOT NULL — it is a per-state conditional constraint.
-- The constraint wording:
--   (status NOT terminal AND terminal_reason IS NULL)
--   OR (status=completed AND terminal_reason IN (...))
--   OR (... etc)
--   OR (status=terminal AND terminal_reason='legacy_unknown')  -- backfill
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_terminal_reason;

alter table screening_v2.call_sessions
  add constraint chk_call_sessions_terminal_reason check (
    -- Non-terminal: reason must be absent
    (
      status not in ('completed', 'failed', 'cancelled', 'expired')
      and terminal_reason is null
    )
    or
    -- completed: only conversation_complete or assessment_done (never null)
    (
      status = 'completed'
      and terminal_reason in ('conversation_complete', 'assessment_done')
    )
    or
    -- failed: only failed-family codes (never null)
    (
      status = 'failed'
      and terminal_reason in (
        'room_create_error', 'worker_crash', 'provider_error',
        'assessment_error', 'shutdown_forced', 'drain_timeout'
      )
    )
    or
    -- cancelled: only cancelled-family codes + migrated_abandoned (never null)
    (
      status = 'cancelled'
      and terminal_reason in (
        'recruiter_cancelled', 'migrated_abandoned',
        'duplicate_session', 'shutdown_drain'
      )
    )
    or
    -- expired: only expiry codes (never null)
    (
      status = 'expired'
      and terminal_reason in ('idle_timeout', 'grace_timeout')
    )
    or
    -- Legacy catch-all: legacy_unknown is allowed for any terminal state
    -- (backfilled rows from 0006 migration). Application layer rejects it
    -- for live transitions.
    (
      status in ('completed', 'failed', 'cancelled', 'expired')
      and terminal_reason = 'legacy_unknown'
    )
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_terminal_reason;

-- ── 9. Transition-enforcement trigger ────────────────────────────────
-- Rejects any update FROM a terminal state (terminal immutable) or
-- any update TO a status not in the per-state allowed-next set.
-- Non-lifecycle metadata (ended_at, duration_sec) on terminal rows
-- remains mutable.
create or replace function screening_v2.enforce_session_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  allowed_next text[];
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status in ('completed', 'failed', 'cancelled', 'expired') then
    raise exception
      'session is in terminal state % — no further transitions are permitted',
      old.status
      using errcode = 'P0001';
  end if;

  case old.status
    when 'created'     then allowed_next := array['waiting', 'in_progress', 'cancelled', 'failed'];
    when 'waiting'     then allowed_next := array['in_progress', 'cancelled', 'failed', 'expired'];
    when 'in_progress' then allowed_next := array['completed', 'failed', 'cancelled', 'expired'];
    else allowed_next := '{}'::text[];
  end case;

  if not (new.status = any(allowed_next)) then
    raise exception
      'invalid session transition % → %',
      old.status, new.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_session_lifecycle on screening_v2.call_sessions;
create trigger trg_session_lifecycle
  before update on screening_v2.call_sessions
  for each row
  when (old.status is distinct from new.status)
  execute function screening_v2.enforce_session_transition();

-- ── 10. terminal_reason immutability trigger ──────────────────────────
-- Once terminal_reason is set it cannot be changed.
-- Other lifecycle metadata (ended_at, duration_sec) remain mutable.
create or replace function screening_v2.enforce_terminal_reason_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.terminal_reason is not null
     and new.terminal_reason is distinct from old.terminal_reason then
    raise exception
      'terminal_reason is immutable once set'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_terminal_reason_immutable on screening_v2.call_sessions;
create trigger trg_terminal_reason_immutable
  before update on screening_v2.call_sessions
  for each row
  when (old.terminal_reason is not null
        and new.terminal_reason is distinct from old.terminal_reason)
  execute function screening_v2.enforce_terminal_reason_immutable();

-- ── 11. Index for open-session reconciliation (REL-09 future use) ────
create index if not exists idx_v2_sessions_status
  on screening_v2.call_sessions(status)
  where status in ('created', 'waiting', 'in_progress');

-- ── RLS / grants: unchanged ──────────────────────────────────────────
-- All existing policies on call_sessions remain valid.
-- service_role retains all-access.  authenticated retains SELECT.
-- No new grants required.

notify pgrst, 'reload schema';
