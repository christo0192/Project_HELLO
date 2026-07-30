-- =====================================================================
-- 0009 — L1 queue infrastructure (REL-01/04).
--
-- Creates two tables in screening_v2:
--   1. job_queue       — main queue with status, dedup, retry/backoff
--   2. job_dlq         — dead-letter queue for exhausted-retry jobs
--
-- Also creates:
--   - Partial unique index on dedup_key (active-only) for idempotent enqueue
--   - dequeue_job(p_queue_name, p_now) RPC for lock-free atomic dequeue
--   - Indexes for efficient dequeue queries
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. job_queue table
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.job_queue (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  payload       jsonb not null default '{}',
  status        text not null default 'pending'
                check (status in ('pending', 'active', 'completed', 'failed', 'delayed')),
  dedup_key     text,                           -- optional; enqueue idempotency
  attempts      integer not null default 0,
  max_attempts  integer not null default 3,
  priority      integer not null default 0,
  scheduled_at  timestamptz not null default now(),
  started_at    timestamptz,                    -- set by dequeue
  completed_at  timestamptz,
  failed_at     timestamptz,
  error_message text,
  created_at    timestamptz not null default now()
);

-- ── 1a. Idempotent-enqueue index ──────────────────────────────────────
-- Prevents duplicate active (pending/active/delayed) jobs with the same
-- dedup_key.  Completed/failed jobs with the same key are NOT blocked,
-- allowing reuse of dedup keys across cycles.
create unique index if not exists uq_job_queue_dedup_active
  on screening_v2.job_queue(dedup_key)
  where dedup_key is not null
    and status in ('pending', 'active', 'delayed');

-- ── 1b. Dequeue performance indexes ───────────────────────────────────
-- For the common dequeue pattern: WHERE name=$1 AND status IN (...) AND scheduled_at <= now()
-- ORDER BY priority DESC, scheduled_at ASC LIMIT N
create index if not exists idx_job_queue_dequeue
  on screening_v2.job_queue(name, status, priority desc, scheduled_at asc)
  where status in ('pending', 'delayed');

-- For priority-based ordering
create index if not exists idx_job_queue_priority_scheduled
  on screening_v2.job_queue(priority desc, scheduled_at asc)
  where status in ('pending', 'delayed');

-- For DLQ management queries
create index if not exists idx_job_queue_status_name
  on screening_v2.job_queue(name, status);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. job_dlq table
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.job_dlq (
  id            uuid primary key,                -- same id as original job
  name          text not null,
  payload       jsonb not null default '{}',
  dedup_key     text,
  attempts      integer not null,
  max_attempts  integer not null,
  error_message text,
  failed_at     timestamptz not null default now(),
  moved_at      timestamptz not null default now(),
  replay_count  integer not null default 0
);

create index if not exists idx_job_dlq_moved
  on screening_v2.job_dlq(moved_at desc);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. dequeue_job RPC
-- ═══════════════════════════════════════════════════════════════════════
-- Lock-free single-job dequeue using UPDATE … FROM (subquery … FOR UPDATE
-- SKIP LOCKED) … RETURNING.  This is the production-grade pattern that
-- avoids contention between concurrent workers.
--
-- Returns a single job row, or NULL if no eligible job is available.
-- The job is atomically transitioned to 'active' and its attempt counter
-- is incremented.

create or replace function screening_v2.dequeue_job(
  p_queue_name text,
  p_now        timestamptz default now()
)
returns setof screening_v2.job_queue
language sql
set search_path = pg_catalog
as $$
  update screening_v2.job_queue
    set status = 'active',
        started_at = p_now,
        attempts  = attempts + 1
    where id = (
      select id
      from screening_v2.job_queue
      where name = p_queue_name
        and status in ('pending', 'delayed')
        and scheduled_at <= p_now
      order by priority desc, scheduled_at asc
      limit 1
      for update skip locked
    )
    returning *;
$$;

-- Grant usage to the application role (role name varies by deployment).
-- The synthetic/local setup uses the authenticated/service-role user
-- which is a superuser, so no explicit grant is needed for local dev.
-- In production, uncomment and adjust the role name:
-- grant execute on function screening_v2.dequeue_job(text, timestamptz)
--   to app_service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Permissions (synthetic-safe defaults)
-- ═══════════════════════════════════════════════════════════════════════
-- No explicit grants needed for synthetic/local setup where the
-- connecting user is a superuser (service_role).  In production, grant
-- INSERT/SELECT/UPDATE/DELETE on job_queue and INSERT/SELECT/DELETE on
-- job_dlq to the application service role.

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Statement-level invariants
-- ═══════════════════════════════════════════════════════════════════════
-- These INSERT-only invariants are enforced at the application layer by
-- the Queue class and adapters — the SQL layer provides the structural
-- guardrails (CHECK constraints, unique indexes, SKIP LOCKED dequeue).
-- All Postgres-side constraints are forward-only and additive.
