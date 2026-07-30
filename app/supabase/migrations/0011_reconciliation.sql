-- =====================================================================
-- 0011 — Reconciliation & quarantine foundation (REL-09).
--
-- Provides:
--   1. reconciliation_log — append-only audit trail for detected issues
--      and auto-repair actions.
--   2. quarantined_sessions — sessions that were moved to a terminal
--      state by the reconciler and flagged for human review.
--   3. reconciliation config defaults table (synthetic).
--   4. Helper indexes for the detection queries in reconciliation.ts.
--   5. RLS: service_role only; no anon/authenticated access.
--
-- DESIGN PRINCIPLES:
--   - Read-only detect: reconciliation.ts SCANS tables and INSERTs into
--     reconciliation_log and quarantined_sessions; it NEVER mutates
--     call_sessions, transcript_turns, assessments, or recordings directly.
--   - Repair plans are idempotent: running detect() twice produces the
--     same issues (upsert semantics on issue_signature).
--   - Every repair action is audited with a stable error-code category.
--   - Quarantine is a soft isolation: the row stays in call_sessions
--     (terminal state) and is cross-referenced in quarantined_sessions.
--   - Seeded inconsistencies can be introspected at any time.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. reconciliation_log — append-only audit for issues & repairs
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.reconciliation_log (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null,               -- groups issues from one reconcile() call
  detected_at       timestamptz not null default now(),
  issue_category    text not null,               -- stuck_session|orphan_room|transcript_gap|missing_recording|overdue_scorecard
  severity          text not null default 'info', -- info|warning|error|critical
  session_id        uuid references screening_v2.call_sessions(id) on delete set null,
  candidate_id      uuid references screening_v2.candidates(id) on delete set null,
  issue_signature   text not null,               -- deterministic hash for idempotent re-detection
  details           jsonb not null default '{}'::jsonb,
  -- Repair fields (populated after repair action)
  repaired          boolean not null default false,
  repair_action     text,                        -- transition_to_expired|transition_to_failed|quarantine_session|noop
  repair_reason     text,                        -- human-readable summary of what was done
  quarantined       boolean not null default false,
  created_at        timestamptz not null default now()
);

comment on table screening_v2.reconciliation_log is
  'REL-09: Append-only audit log for reconciliation detection and repair actions.';

comment on column screening_v2.reconciliation_log.issue_signature is
  'Deterministic hash (MD5 of category+session_id+state) for idempotent re-detection. '
  'INSERT uses ON CONFLICT DO NOTHING so re-running detect() is safe.';

comment on column screening_v2.reconciliation_log.run_id is
  'UUID generated per reconcile() call. Groups all issues found in one run.';

comment on column screening_v2.reconciliation_log.repaired is
  'Set to true when a repair action has been applied to this issue.';

comment on column screening_v2.reconciliation_log.quarantined is
  'Set to true when the session has been placed in quarantined_sessions.';

-- Unique constraint on issue_signature for idempotent re-detection.
alter table screening_v2.reconciliation_log
  drop constraint if exists uq_reconciliation_log_signature;

alter table screening_v2.reconciliation_log
  add constraint uq_reconciliation_log_signature
    unique (issue_signature);

-- Append-only guard: no UPDATE or DELETE on reconciliation_log.
create or replace function screening_v2.prevent_reconciliation_log_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception
      'reconciliation_log is append-only — no % permitted',
      lower(tg_op)
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reconciliation_log_append_only on screening_v2.reconciliation_log;

create trigger trg_reconciliation_log_append_only
  before update or delete on screening_v2.reconciliation_log
  for each row
  execute function screening_v2.prevent_reconciliation_log_mutation();

-- ═══════════════════════════════════════════════════════════════════════
-- 2. quarantined_sessions — sessions flagged for human review
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.quarantined_sessions (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references screening_v2.call_sessions(id) on delete cascade,
  candidate_id      uuid references screening_v2.candidates(id) on delete set null,
  quarantined_at    timestamptz not null default now(),
  quarantined_by    text not null default 'reconciler', -- reconciler|manual|system
  reason            text not null,                     -- human-readable explanation
  details           jsonb not null default '{}'::jsonb,
  resolved          boolean not null default false,
  resolved_at       timestamptz,
  resolved_by       text,
  resolution_note   text,
  created_at        timestamptz not null default now()
);

comment on table screening_v2.quarantined_sessions is
  'REL-09: Sessions flagged for human review after reconciliation detected anomalies.';

comment on column screening_v2.quarantined_sessions.resolved is
  'Set to true when a human has reviewed and resolved the quarantine.';

-- Unique on session_id — a session can only be quarantined once.
alter table screening_v2.quarantined_sessions
  drop constraint if exists uq_quarantined_sessions_session;

alter table screening_v2.quarantined_sessions
  add constraint uq_quarantined_sessions_session
    unique (session_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Helper indexes for detection queries
-- ═══════════════════════════════════════════════════════════════════════

-- Stuck sessions: index on status + waiting_at for sessions that have been
-- in waiting too long (no worker attached).
create index if not exists idx_v2_sessions_stuck_waiting
  on screening_v2.call_sessions(waiting_at)
  where status = 'waiting';

-- Stuck sessions: index on status + started_at for long-running in_progress.
create index if not exists idx_v2_sessions_stuck_progress
  on screening_v2.call_sessions(started_at)
  where status = 'in_progress';

-- Stuck sessions: index on status + started_at for stale created sessions.
create index if not exists idx_v2_sessions_stuck_created
  on screening_v2.call_sessions(started_at)
  where status = 'created';

-- Missing recordings: sessions that completed but have no recording_object_key.
create index if not exists idx_v2_sessions_missing_recording
  on screening_v2.call_sessions(status, recording_object_key)
  where status = 'completed' and recording_object_key is null;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. RLS: service_role only, deny anon/authenticated
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.reconciliation_log enable row level security;
alter table screening_v2.quarantined_sessions enable row level security;

-- No policies granted to anon or authenticated — only service_role can
-- access these tables (bypasses RLS).

revoke all on screening_v2.reconciliation_log from anon, authenticated;
revoke all on screening_v2.quarantined_sessions from anon, authenticated;

grant all privileges on screening_v2.reconciliation_log    to service_role;
grant all privileges on screening_v2.quarantined_sessions  to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Reconciler state query helpers
-- ═══════════════════════════════════════════════════════════════════════

-- Returns open (non-terminal) sessions that may be stuck, along with
-- wall-clock duration in each state. Used by reconciliation.ts to
-- detect stuck sessions without fetching all rows.
create or replace function screening_v2.stuck_sessions(
  waiting_timeout_sec int default 300,    -- 5 min
  created_timeout_sec int default 1800,   -- 30 min
  progress_timeout_sec int default 7200   -- 2 hours
)
returns table (
  session_id        uuid,
  status            text,
  state_duration_sec double precision,
  candidate_id      uuid,
  reason_hint       text
)
language sql
stable
set search_path = pg_catalog
as $$
  -- Waiting sessions that have been waiting too long (no worker attached)
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.waiting_at))::double precision,
    s.candidate_id,
    'stuck_in_waiting'::text
  from screening_v2.call_sessions s
  where s.status = 'waiting'
    and s.waiting_at is not null
    and extract(epoch from (now() - s.waiting_at)) > waiting_timeout_sec

  union all

  -- Created sessions that never transitioned (canonical start time is started_at)
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.started_at))::double precision,
    s.candidate_id,
    'stuck_in_created'::text
  from screening_v2.call_sessions s
  where s.status = 'created'
    and extract(epoch from (now() - s.started_at)) > created_timeout_sec

  union all

  -- In-progress sessions that have been running too long
  select
    s.id,
    s.status,
    extract(epoch from (now() - s.started_at))::double precision,
    s.candidate_id,
    'stuck_in_progress'::text
  from screening_v2.call_sessions s
  where s.status = 'in_progress'
    and extract(epoch from (now() - s.started_at)) > progress_timeout_sec
  order by state_duration_sec desc;
$$;

revoke all on function screening_v2.stuck_sessions(int, int, int) from anon, authenticated;
grant execute on function screening_v2.stuck_sessions(int, int, int) to service_role;

-- Returns completed sessions that are missing assessments (overdue scorecards).
create or replace function screening_v2.missing_assessment_sessions()
returns table (
  session_id        uuid,
  candidate_id      uuid,
  completed_at      timestamptz,
  status            text
)
language sql
stable
set search_path = pg_catalog
as $$
  select
    s.id,
    s.candidate_id,
    s.ended_at,
    s.status
  from screening_v2.call_sessions s
  where s.status = 'completed'
    and not exists (
      select 1
      from screening_v2.assessments a
      where a.session_id = s.id
    );
$$;

revoke all on function screening_v2.missing_assessment_sessions() from anon, authenticated;
grant execute on function screening_v2.missing_assessment_sessions() to service_role;

-- Returns completed sessions with no transcript turns (transcript gap).
create or replace function screening_v2.sessions_without_transcripts()
returns table (
  session_id        uuid,
  candidate_id      uuid,
  ended_at          timestamptz,
  status            text
)
language sql
stable
set search_path = pg_catalog
as $$
  select
    s.id,
    s.candidate_id,
    s.ended_at,
    s.status
  from screening_v2.call_sessions s
  where s.status in ('completed', 'failed')
    and not exists (
      select 1
      from screening_v2.transcript_turns t
      where t.session_id = s.id
    );
$$;

revoke all on function screening_v2.sessions_without_transcripts() from anon, authenticated;
grant execute on function screening_v2.sessions_without_transcripts() to service_role;

-- Returns completed sessions missing a recording_object_key (missing recording).
create or replace function screening_v2.sessions_missing_recording()
returns table (
  session_id        uuid,
  candidate_id      uuid,
  ended_at          timestamptz,
  status            text
)
language sql
stable
set search_path = pg_catalog
as $$
  select
    s.id,
    s.candidate_id,
    s.ended_at,
    s.status
  from screening_v2.call_sessions s
  where s.status = 'completed'
    and s.recording_object_key is null;
$$;

revoke all on function screening_v2.sessions_missing_recording() from anon, authenticated;
grant execute on function screening_v2.sessions_missing_recording() to service_role;

notify pgrst, 'reload schema';
