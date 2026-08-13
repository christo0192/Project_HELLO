-- =====================================================================
-- 0028 — Lease-safe queue foundation (Ashby Phase 1, plan Step 2).
--
-- Hardens the L1 queue (0009) with worker leases, bounded visibility,
-- heartbeat extension, expired-lease reclaim, compare-and-set completion
-- and failure, single-transaction DLQ movement, and concurrent-safe
-- replay. No Ashby product code is introduced here — payloads remain
-- generic opaque identifiers.
--
-- Forward-only and additive: guarded ADD COLUMN / CREATE INDEX and
-- CREATE OR REPLACE FUNCTION only. No destructive DDL. Queue and DLQ
-- remain service-role-only backend infrastructure (RLS from 0009 is
-- preserved; every RPC is revoked from public/anon/authenticated and
-- granted only to service_role).
--
-- Lease model:
--   * A claim grants an unguessable lease_token, an owner, a bounded
--     lease_expires_at, and an absolute lease_deadline_at.
--   * Heartbeat extends only a live matching lease and never past the
--     absolute deadline (bounded maximum visibility).
--   * complete/fail are compare-and-set on (id + active + live lease).
--   * Expired active jobs are reclaimed: requeued while attempts remain,
--     dead-lettered once attempts are exhausted (never bypassing
--     max_attempts; no job silently lost).
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Lease columns on job_queue (additive, guarded)
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.job_queue
  add column if not exists lease_token uuid;
alter table screening_v2.job_queue
  add column if not exists lease_owner text;
alter table screening_v2.job_queue
  add column if not exists lease_expires_at timestamptz;
alter table screening_v2.job_queue
  add column if not exists lease_deadline_at timestamptz;

comment on column screening_v2.job_queue.lease_token is
  'Unguessable owner token for the current active claim; never logged.';
comment on column screening_v2.job_queue.lease_expires_at is
  'When the current lease expires and the job becomes reclaimable.';
comment on column screening_v2.job_queue.lease_deadline_at is
  'Absolute maximum visibility deadline; heartbeats cannot extend past it.';

-- Reclaim scan index: find active jobs whose lease has expired.
create index if not exists idx_job_queue_active_lease
  on screening_v2.job_queue(lease_expires_at)
  where status = 'active';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. claim_job — atomic lease-safe claim (FOR UPDATE SKIP LOCKED)
-- ═══════════════════════════════════════════════════════════════════════
-- Claims exactly one eligible (pending/delayed, due) job, transitions it
-- to active, increments attempts (a claim is a delivery), and grants a
-- fresh unguessable lease bounded by both a lease window (clamped to
-- [1, 900] seconds) and an absolute visibility deadline (3600 seconds).
-- FOR UPDATE SKIP LOCKED guarantees two racing workers cannot claim the
-- same job — exactly one wins.

create or replace function screening_v2.claim_job(
  p_queue_name    text,
  p_now           timestamptz default now(),
  p_lease_seconds integer     default 30,
  p_owner         text        default null
)
returns setof screening_v2.job_queue
language sql
set search_path = pg_catalog
as $$
  update screening_v2.job_queue
     set status            = 'active',
         started_at        = p_now,
         attempts          = attempts + 1,
         lease_token       = gen_random_uuid(),
         lease_owner       = p_owner,
         lease_expires_at  = p_now + (greatest(1, least(p_lease_seconds, 900)) * interval '1 second'),
         lease_deadline_at = p_now + (3600 * interval '1 second')
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

-- ═══════════════════════════════════════════════════════════════════════
-- 3. heartbeat_job — extend a live matching lease (bounded)
-- ═══════════════════════════════════════════════════════════════════════
-- Extends lease_expires_at only when the caller holds the live matching
-- lease. Never extends past lease_deadline_at, so total visibility is
-- bounded. A stale/mismatched/expired lease matches no row and returns
-- nothing (fails closed).

create or replace function screening_v2.heartbeat_job(
  p_job_id        uuid,
  p_lease_token   uuid,
  p_now           timestamptz default now(),
  p_lease_seconds integer     default 30
)
returns setof screening_v2.job_queue
language sql
set search_path = pg_catalog
as $$
  update screening_v2.job_queue
     set lease_expires_at = least(
           p_now + (greatest(1, least(p_lease_seconds, 900)) * interval '1 second'),
           lease_deadline_at
         )
   where id = p_job_id
     and status = 'active'
     and lease_token = p_lease_token
     and lease_expires_at > p_now
   returning *;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. complete_job — compare-and-set completion under a live lease
-- ═══════════════════════════════════════════════════════════════════════
-- Marks the job completed and clears lease fields only when the caller
-- holds the live matching lease. Returns true on success, false when the
-- lease is lost (a reclaimed job cannot be completed by the old worker).

create or replace function screening_v2.complete_job(
  p_job_id      uuid,
  p_lease_token uuid,
  p_now         timestamptz default now()
)
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_count integer;
begin
  update screening_v2.job_queue
     set status            = 'completed',
         completed_at      = p_now,
         lease_token       = null,
         lease_owner       = null,
         lease_expires_at  = null,
         lease_deadline_at = null
   where id = p_job_id
     and status = 'active'
     and lease_token = p_lease_token
     and lease_expires_at > p_now;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. fail_job — lease-guarded retry-or-DLQ in one transaction
-- ═══════════════════════════════════════════════════════════════════════
-- Under the live matching lease: retries (clearing the lease, scheduling
-- p_retry_at) while attempts remain; otherwise moves the job to the DLQ
-- in the SAME transaction (insert DLQ + delete queue row — no
-- insert-then-delete client gap). A stale worker returns 'not_owned' and
-- mutates nothing. Never bypasses max_attempts.

create or replace function screening_v2.fail_job(
  p_job_id      uuid,
  p_lease_token uuid,
  p_now         timestamptz default now(),
  p_error       text        default null,
  p_retry_at    timestamptz default now()
)
returns text
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_job screening_v2.job_queue%rowtype;
begin
  select * into v_job
    from screening_v2.job_queue
   where id = p_job_id
   for update;

  if not found
     or v_job.status <> 'active'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= p_now then
    return 'not_owned';
  end if;

  if v_job.attempts < v_job.max_attempts then
    update screening_v2.job_queue
       set status            = 'delayed',
           scheduled_at      = p_retry_at,
           error_message     = p_error,
           lease_token       = null,
           lease_owner       = null,
           lease_expires_at  = null,
           lease_deadline_at = null
     where id = p_job_id;
    return 'retry_scheduled';
  end if;

  insert into screening_v2.job_dlq
    (id, name, payload, dedup_key, attempts, max_attempts, error_message,
     failed_at, moved_at, replay_count)
  values
    (v_job.id, v_job.name, v_job.payload, v_job.dedup_key, v_job.attempts,
     v_job.max_attempts, p_error, p_now, p_now, 0)
  on conflict (id) do nothing;

  delete from screening_v2.job_queue where id = p_job_id;
  return 'dead_lettered';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. reclaim_expired_jobs — recover expired active jobs
-- ═══════════════════════════════════════════════════════════════════════
-- For each active job whose lease has expired: requeue to pending while
-- attempts remain, else dead-letter deterministically. Uses FOR UPDATE
-- SKIP LOCKED so concurrent reclaimers never double-process a row.

create or replace function screening_v2.reclaim_expired_jobs(
  p_now   timestamptz default now(),
  p_limit integer     default 100
)
returns table(job_id uuid, outcome text)
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_job screening_v2.job_queue%rowtype;
begin
  for v_job in
    select *
      from screening_v2.job_queue
     where status = 'active'
       and lease_expires_at is not null
       and lease_expires_at <= p_now
     order by lease_expires_at asc
     limit greatest(0, p_limit)
     for update skip locked
  loop
    if v_job.attempts < v_job.max_attempts then
      update screening_v2.job_queue
         set status            = 'pending',
             scheduled_at      = p_now,
             lease_token       = null,
             lease_owner       = null,
             lease_expires_at  = null,
             lease_deadline_at = null
       where id = v_job.id;
      job_id := v_job.id;
      outcome := 'requeued';
      return next;
    else
      insert into screening_v2.job_dlq
        (id, name, payload, dedup_key, attempts, max_attempts, error_message,
         failed_at, moved_at, replay_count)
      values
        (v_job.id, v_job.name, v_job.payload, v_job.dedup_key, v_job.attempts,
         v_job.max_attempts, 'lease_expired_attempts_exhausted', p_now, p_now, 0)
      on conflict (id) do nothing;
      delete from screening_v2.job_queue where id = v_job.id;
      job_id := v_job.id;
      outcome := 'dead_lettered';
      return next;
    end if;
  end loop;
  return;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. dlq_job — legacy transactional move-to-DLQ by id
-- ═══════════════════════════════════════════════════════════════════════
-- Fixes the previously non-transactional job_queue -> job_dlq movement:
-- lock the queue row, insert the DLQ row, delete the queue row, all in one
-- transaction so a crash can never leave both or neither record.

create or replace function screening_v2.dlq_job(
  p_job_id uuid,
  p_now    timestamptz default now(),
  p_error  text        default null
)
returns setof screening_v2.job_dlq
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_job screening_v2.job_queue%rowtype;
begin
  select * into v_job
    from screening_v2.job_queue
   where id = p_job_id
   for update;
  if not found then
    return;
  end if;

  insert into screening_v2.job_dlq
    (id, name, payload, dedup_key, attempts, max_attempts, error_message,
     failed_at, moved_at, replay_count)
  values
    (v_job.id, v_job.name, v_job.payload, v_job.dedup_key, v_job.attempts,
     v_job.max_attempts, p_error, p_now, p_now, 0)
  on conflict (id) do nothing;

  delete from screening_v2.job_queue where id = p_job_id;

  return query
    select * from screening_v2.job_dlq where id = p_job_id;
  return;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. replay_dlq_job — concurrent-safe transactional replay
-- ═══════════════════════════════════════════════════════════════════════
-- Locks the DLQ row with SKIP LOCKED so two racing replays cannot both
-- succeed; inserts exactly one new pending job and deletes the DLQ source
-- in the same transaction. A concurrent (or already-consumed) replay finds
-- no row and returns nothing — exactly one pending replacement is created.
-- dedup_key is reset (null) so replay never collides with the active-dedup
-- unique index.

create or replace function screening_v2.replay_dlq_job(
  p_dlq_id uuid,
  p_now    timestamptz default now()
)
returns setof screening_v2.job_queue
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_dlq screening_v2.job_dlq%rowtype;
  v_new screening_v2.job_queue%rowtype;
begin
  select * into v_dlq
    from screening_v2.job_dlq
   where id = p_dlq_id
   for update skip locked;
  if not found then
    return;
  end if;

  insert into screening_v2.job_queue
    (name, payload, status, dedup_key, attempts, max_attempts, priority,
     scheduled_at, created_at)
  values
    (v_dlq.name, v_dlq.payload, 'pending', null, 0, v_dlq.max_attempts, 0,
     p_now, p_now)
  returning * into v_new;

  delete from screening_v2.job_dlq where id = p_dlq_id;

  return next v_new;
  return;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Privileges — service-role-only backend infrastructure
-- ═══════════════════════════════════════════════════════════════════════
-- Every queue RPC (including the pre-existing dequeue_job from 0009) is
-- executable ONLY by service_role. Browser roles cannot execute them, and
-- even if they could, RLS + missing table grants block access. This keeps
-- the queue and DLQ strictly backend-only.

revoke all on function screening_v2.dequeue_job(text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.dequeue_job(text, timestamptz)
  to service_role;

revoke all on function screening_v2.claim_job(text, timestamptz, integer, text)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_job(text, timestamptz, integer, text)
  to service_role;

revoke all on function screening_v2.heartbeat_job(uuid, uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function screening_v2.heartbeat_job(uuid, uuid, timestamptz, integer)
  to service_role;

revoke all on function screening_v2.complete_job(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.complete_job(uuid, uuid, timestamptz)
  to service_role;

revoke all on function screening_v2.fail_job(uuid, uuid, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.fail_job(uuid, uuid, timestamptz, text, timestamptz)
  to service_role;

revoke all on function screening_v2.reclaim_expired_jobs(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function screening_v2.reclaim_expired_jobs(timestamptz, integer)
  to service_role;

revoke all on function screening_v2.dlq_job(uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function screening_v2.dlq_job(uuid, timestamptz, text)
  to service_role;

revoke all on function screening_v2.replay_dlq_job(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.replay_dlq_job(uuid, timestamptz)
  to service_role;

comment on function screening_v2.claim_job(text, timestamptz, integer, text) is
  'Lease-safe atomic claim (FOR UPDATE SKIP LOCKED). Service-role only. '
  'Grants an unguessable lease bounded by a window and an absolute '
  'visibility deadline; increments attempts.';
comment on function screening_v2.reclaim_expired_jobs(timestamptz, integer) is
  'Reclaims expired active jobs: requeue while attempts remain, else DLQ. '
  'Never bypasses max_attempts. Service-role only.';
