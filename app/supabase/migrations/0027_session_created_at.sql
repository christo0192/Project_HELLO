-- =====================================================================
-- 0027 — Persisted call_sessions.created_at (real session creation time).
--
-- Prior state: call_sessions had NO created_at column. started_at
-- (NOT NULL DEFAULT now(), set once at row insert and never updated — see
-- session-lifecycle.createSession, which omits started_at so the default
-- fires) was the only creation-time evidence, and the API/UI aliased it at
-- read time. This migration records a real creation timestamp so the value
-- is stored, not synthesized on every read.
--
-- Correctness constraints:
--   * The column is added WITHOUT a default first, so existing rows are NOT
--     silently backfilled to now() (that would fabricate a historical
--     timestamp). Existing rows start NULL.
--   * Legacy rows are then backfilled from trustworthy existing evidence in
--     a deterministic precedence, only where still NULL:
--       (a) the earliest 'session_created' audit event for the session, then
--       (b) started_at — set once at insert, never mutated, so it is the
--           exact creation instant (and at minimum a true upper bound).
--     Migration time is NEVER used; a row with no recoverable evidence is
--     left NULL and renders as "Not available" in the UI.
--   * Only AFTER backfill does the column gain DEFAULT now(), so every future
--     INSERT (all creation paths flow through the DB default) records its own
--     creation instant without touching existing rows.
--   * The column stays NULLABLE to honour genuinely unrecoverable legacy
--     rows; in practice started_at guarantees a non-null backfill for all
--     current rows.
--
-- Additive, idempotent, forward-only (no destructive DDL): re-running is a
-- no-op (add if not exists; backfill only where null; set default; index if
-- not exists).
--
-- Recording/transcript timestamps are intentionally NOT changed: their
-- authoritative anchors already exist and are correct —
-- transcript_turns.created_at (NOT NULL), and the epoch-ms egress/turn
-- anchors (0026). No redundant columns are added.
-- =====================================================================

-- 1. Nullable column, no default (existing rows -> NULL, not now()).
alter table screening_v2.call_sessions
  add column if not exists created_at timestamptz;

-- 2. Deterministic backfill of legacy rows from existing evidence only.
update screening_v2.call_sessions cs
set created_at = coalesce(
  (
    select min(ae.created_at)
    from screening_v2.audit_events ae
    where ae.action = 'session_created'
      and ae.target_id = cs.id::text
  ),
  cs.started_at
)
where cs.created_at is null;

-- 3. Future inserts get their own creation instant from the DB default.
alter table screening_v2.call_sessions
  alter column created_at set default now();

create index if not exists idx_v2_sessions_created_at
  on screening_v2.call_sessions(created_at);

comment on column screening_v2.call_sessions.created_at is
  'Session creation instant. DEFAULT now() for new rows. Legacy rows '
  'backfilled from the earliest session_created audit event, else '
  'started_at (set once at insert, never updated). NULLABLE: rows with no '
  'recoverable evidence stay NULL and render as "Not available". Never set '
  'to migration time.';

notify pgrst, 'reload schema';
