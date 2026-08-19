-- =====================================================================
-- 0037 — Lease-safe queue DEFERRAL (Ashby scanner-readiness gating).
--
-- WHY
-- ---
-- The queue has exactly two post-claim outcomes: complete, or fail. Fail
-- charges the claim's attempt, writes a durable error message, and — once
-- attempts reach max_attempts — dead-letters the job. That is the correct
-- shape for WORK THAT FAILED. It is the wrong shape for WORK THAT COULD
-- NOT START YET.
--
-- Live evidence (canary, post-0036 deploy): a replayed `ashby.ingestion`
-- job was claimed on a cold boot seconds after the machine started, before
-- freshclam had established the ClamAV signature database. The scan failed
-- closed — correctly — and the ingestion landed in `failed_review` with
-- `scan_scanner_signatures_unavailable` and one attempt spent, on a resume
-- that was never actually screened. Nothing was wrong with the job, the
-- application, or the resume: the machine simply was not ready yet. That
-- recurs on EVERY deploy that has pending ingestion work.
--
-- A WAIT charged against a FAILURE budget is the same defect class already
-- repaired for the operation outbox in 0035 (`defer_ashby_operation`).
-- This is its generic queue counterpart.
--
-- CONTRACT
-- --------
--   * CAS on the LIVE lease, exactly like complete_job / fail_job: a stale,
--     mismatched, or expired lease mutates nothing and returns 'not_owned'.
--   * Refunds EXACTLY the attempt the claim charged (attempts - 1, floored
--     at 0). Never raises max_attempts.
--   * Reschedules behind a server-clamped delay (1..3600s) so a persistent
--     prerequisite gap costs one bounded poll per window, not a hot loop.
--   * NEVER dead-letters, never marks failed, never writes failure text:
--     `error_message` is CLEARED, `failed_at` is untouched. A deferred job
--     has no error, and reporting one would be untrue.
--   * The reason code is shape-validated (`^[a-z0-9_.:-]{1,64}$`) before it
--     reaches a durable column — an allowlist, not a denylist, so provider
--     text or row content can never be persisted here.
--
-- Forward-only and additive: guarded ADD COLUMN and CREATE OR REPLACE
-- FUNCTION only, no destructive DDL. `job_queue` stays service-role-only
-- backend infrastructure (0009 RLS preserved; the new RPC is revoked from
-- public/anon/authenticated and granted only to service_role).
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Deferral bookkeeping columns (additive, guarded)
-- ═══════════════════════════════════════════════════════════════════════
-- These exist so a deferral is OBSERVABLE. Without them, "120 jobs are
-- waiting for a scanner that never came back" and "the queue is quietly
-- idle" are the same picture, and the second one is the picture an
-- operator would have believed.

alter table screening_v2.job_queue
  add column if not exists defer_reason text;
alter table screening_v2.job_queue
  add column if not exists deferred_at timestamptz;
alter table screening_v2.job_queue
  add column if not exists defer_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_job_queue_defer_reason'
       and conrelid = 'screening_v2.job_queue'::regclass
  ) then
    alter table screening_v2.job_queue
      add constraint chk_job_queue_defer_reason
      check (defer_reason is null or defer_reason ~ '^[a-z0-9_.:-]{1,64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_job_queue_defer_count'
       and conrelid = 'screening_v2.job_queue'::regclass
  ) then
    alter table screening_v2.job_queue
      add constraint chk_job_queue_defer_count check (defer_count >= 0);
  end if;
end;
$$;

comment on column screening_v2.job_queue.defer_reason is
  'Sanitized reason code for the CURRENT deferral wait; null when the job '
  'is not waiting on a prerequisite. Never free text, never provider text.';
comment on column screening_v2.job_queue.deferred_at is
  'Start of the current uninterrupted deferral streak (unchanged while the '
  'same reason repeats), so "oldest waiting job" measures the real outage.';
comment on column screening_v2.job_queue.defer_count is
  'Monotonic count of deferrals this job has taken. Never resets a budget; '
  'purely diagnostic.';

-- Health reads "how many jobs are waiting on a prerequisite, and since
-- when" — one bounded index keeps that a count, not a scan.
create index if not exists idx_job_queue_deferred
  on screening_v2.job_queue(name, deferred_at)
  where status = 'delayed' and defer_reason is not null;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. defer_job — attempt-REFUNDING return to delayed under the live lease
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.defer_job(
  p_job_id        uuid,
  p_lease_token   uuid,
  p_reason_code   text,
  p_delay_seconds integer     default 60,
  p_now           timestamptz default now()
)
returns text
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_delay   integer := least(greatest(coalesce(p_delay_seconds, 60), 1), 3600);
  v_updated integer := 0;
begin
  -- Shape-validated BEFORE it can reach a durable column. An unanticipated
  -- message cannot pass; there is no denylist to outrun.
  if p_reason_code is null or p_reason_code !~ '^[a-z0-9_.:-]{1,64}$' then
    return 'invalid_reason_code';
  end if;

  update screening_v2.job_queue
     set status            = 'delayed',
         scheduled_at      = p_now + make_interval(secs => v_delay),
         -- Refund: the claim charged an attempt for work that never ran.
         attempts          = greatest(attempts - 1, 0),
         -- A deferral is not a failure. No error text, no failed_at.
         error_message     = null,
         started_at        = null,
         defer_reason      = p_reason_code,
         -- Keep the ORIGINAL wait start while the same reason repeats, so a
         -- job that has been deferred 120 times over an hour reports an
         -- hour of waiting rather than 45 seconds of it.
         deferred_at       = case
                               when defer_reason = p_reason_code and deferred_at is not null
                                 then deferred_at
                               else p_now
                             end,
         defer_count       = defer_count + 1,
         lease_token       = null,
         lease_owner       = null,
         lease_expires_at  = null,
         lease_deadline_at = null
   where id = p_job_id
     and status = 'active'
     and lease_token = p_lease_token
     and lease_expires_at is not null
     and lease_expires_at > p_now;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return 'not_owned';
  end if;
  return 'deferred';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. fail_job / complete_job — clear the deferral marker
-- ═══════════════════════════════════════════════════════════════════════
-- Identical signature and semantics to 0028, with ONE addition: the
-- deferral marker is cleared on every outcome that is not a deferral.
-- Without this, a job that was deferred once and later failed would sit in
-- `delayed` with a stale `defer_reason`, and the health surface would
-- count a retrying job as a job waiting on the scanner.

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
         defer_reason      = null,
         deferred_at       = null,
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
           -- A retry is not a wait: drop any deferral marker so health does
           -- not read a failing job as a job blocked on a prerequisite.
           defer_reason      = null,
           deferred_at       = null,
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
-- 4. Grants — service_role only, mirroring every other queue RPC (0028)
-- ═══════════════════════════════════════════════════════════════════════

revoke all on function screening_v2.defer_job(uuid, uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.defer_job(uuid, uuid, text, integer, timestamptz)
  to service_role;

revoke all on function screening_v2.complete_job(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.complete_job(uuid, uuid, timestamptz)
  to service_role;

revoke all on function screening_v2.fail_job(uuid, uuid, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.fail_job(uuid, uuid, timestamptz, text, timestamptz)
  to service_role;

comment on function screening_v2.defer_job(uuid, uuid, text, integer, timestamptz) is
  'CAS (under the live lease) DEFERRAL of an ACTIVE queue job back to '
  'delayed because a PREREQUISITE was not met — the work never started. '
  'Refunds exactly the attempt the claim charged, clears the lease, clears '
  'any error text, and reschedules behind a clamped delay (1..3600s). '
  'Never dead-letters, never marks failed, never raises max_attempts. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Ingestion retry edges — abandoning before a verdict returns to `queued`
-- ═══════════════════════════════════════════════════════════════════════
-- The 0029 machine has no way back from `fetching` or `scanning`. Forward or
-- `failed_review` were the only exits, so an ingestion that started and then
-- discovered the scanner could not screen had to be written off — the exact
-- conflation this migration exists to end. It also means a machine that died
-- mid-fetch strands its row in `fetching` forever (the pre-existing
-- `ingestionStuckFetching` health counter measures precisely that).
--
-- Two edges are added, and only these two:
--
--     fetching -> queued        scanning -> queued
--
-- Both mean the SAME narrow thing: the attempt was abandoned before any
-- statement about the file was produced, nothing was recorded, and the work
-- restarts from the beginning. They are `create or replace` on the existing
-- trigger FUNCTION — the trigger itself, the table, and every other edge are
-- untouched, and no state is added (the machine still has exactly eight).
--
-- These edges are NOT unbounded: `advance_ashby_ingestion` charges an attempt
-- against the 5-requeue ceiling (0032) for every transition into `queued`, so
-- a persistently racing scan rests in `failed_review` rather than looping.
-- `extracting` and `structuring` deliberately gain NO such edge: by then the
-- bytes have been parsed and a re-run is a re-download, not a resumption.

create or replace function screening_v2.enforce_ashby_ingestion_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  allowed text[];
begin
  if old.state = new.state then
    return new;   -- idempotent no-op
  end if;
  case old.state
    when 'queued'      then allowed := array['fetching','cancelled'];
    -- 0037: 'queued' is the abandon-before-verdict retry edge.
    when 'fetching'    then allowed := array['scanning','failed_review','cancelled','queued'];
    when 'scanning'    then allowed := array['extracting','failed_review','cancelled','queued'];
    when 'extracting'  then allowed := array['structuring','failed_review','cancelled'];
    when 'structuring' then allowed := array['ready','failed_review','cancelled'];
    when 'failed_review' then allowed := array['queued','cancelled'];  -- retriable
    when 'ready'       then allowed := '{}'::text[];   -- terminal
    when 'cancelled'   then allowed := '{}'::text[];   -- terminal
    else allowed := '{}'::text[];
  end case;
  if not (new.state = any(allowed)) then
    raise exception 'invalid ashby resume ingestion transition % -> %', old.state, new.state
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function screening_v2.enforce_ashby_ingestion_transition is
  'Enforces the legal ashby_resume_ingestions state machine on UPDATE; '
  'same-state is a no-op. Terminal states (ready, cancelled) reject all '
  'transitions. 0037: fetching/scanning may return to queued — an attempt '
  'abandoned BEFORE any verdict about the file, bounded by the 0032 requeue '
  'ceiling. extracting/structuring deliberately have no such edge.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. advance_ashby_ingestion — refuse requeue of a VERDICT-class failure
-- ═══════════════════════════════════════════════════════════════════════
-- Identical signature and behaviour to 0032 plus ONE refusal.
--
-- `failed_review` currently holds two opposite things: "we screened this file
-- and it is malware" and "we never screened this file". The first must never
-- be retried — `runImport` calls advance(link,'queued') unconditionally on
-- every import, `failed_review -> queued` is legal, and nothing distinguished
-- the two, so a redelivered webhook or a reconciliation re-observation would
-- re-resolve a presigned URL and re-DOWNLOAD a file already positively
-- identified as malware, up to the requeue ceiling.
--
-- Making the pipeline more willing to retry (the whole point of the deferral)
-- makes that path MORE reachable, which is why this ships in the same
-- migration rather than after it. Server-side allowlist, mirroring the
-- deferral-code allowlist `reopen_ashby_invite_delivery` already uses.
--
-- Availability-class reasons (`scan_scanner_*`) are deliberately NOT in the
-- allowlist: those rows never had a verdict and are exactly what must stay
-- recoverable.

create or replace function screening_v2.advance_ashby_ingestion(
  p_application_link_id uuid,
  p_next_state          text,
  p_content_sha256      text,
  p_extractor_version   text,
  p_structurer_version  text,
  p_failed_reason       text,
  p_now                 timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id       uuid;
  v_attempts integer;
  v_state    text;
  v_reason   text;
  v_max_attempts constant integer := 5;
begin
  if p_next_state not in ('queued','fetching','scanning','extracting','structuring','ready','failed_review','cancelled') then
    return jsonb_build_object('status', 'invalid_state');
  end if;
  if p_content_sha256 is not null and p_content_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_sha');
  end if;

  insert into screening_v2.ashby_resume_ingestions (application_link_id, provider, state)
  values (p_application_link_id, 'ashby', 'queued')
  on conflict (application_link_id) do nothing;

  if p_next_state = 'queued' then
    select attempts, state, failed_reason into v_attempts, v_state, v_reason
      from screening_v2.ashby_resume_ingestions
     where application_link_id = p_application_link_id
     for update;
    if v_attempts is null then
      return jsonb_build_object('status', 'not_found');
    end if;

    -- VERDICT-class refusal. A screening RESULT is permanent: re-running it
    -- can only produce the same answer, and for malware it means downloading
    -- the file again. Deterministic content faults (a rejected magic/MIME
    -- guard, an unparseable document, a document with no extractable fields)
    -- are verdicts about the file too, by the same argument.
    if v_state = 'failed_review'
       and v_reason is not null
       and (v_reason = 'scan_infected'
            or v_reason like 'guard_%'
            or v_reason = 'parse_error'
            or v_reason = 'no_extractable_fields') then
      return jsonb_build_object('status', 'not_requeueable',
                                'state', v_state,
                                'failed_reason', v_reason);
    end if;

    if v_state is distinct from 'queued' and v_attempts + 1 > v_max_attempts then
      return jsonb_build_object('status', 'retry_exhausted',
                                'state', v_state,
                                'attempts', v_attempts,
                                'max_attempts', v_max_attempts);
    end if;
  end if;

  begin
    update screening_v2.ashby_resume_ingestions
       set state = p_next_state,
           content_sha256 = coalesce(p_content_sha256, content_sha256),
           extractor_version = coalesce(p_extractor_version, extractor_version),
           structurer_version = coalesce(p_structurer_version, structurer_version),
           failed_reason = case
                             when p_next_state = 'failed_review'
                               then left(coalesce(p_failed_reason, 'failed'), 200)
                             -- A row returning to `queued` carries no failure:
                             -- leaving a stale reason behind would make the
                             -- verdict refusal above fire on the NEXT requeue
                             -- of a row that has since been cleared.
                             when p_next_state = 'queued' then null
                             else failed_reason
                           end,
           attempts = case when p_next_state = 'queued' and state is distinct from 'queued'
                           then attempts + 1 else attempts end,
           updated_at = p_now
     where application_link_id = p_application_link_id
    returning id, attempts into v_id, v_attempts;
  exception
    when raise_exception then
      return jsonb_build_object('status', 'invalid_transition');
  end;

  if v_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ok', 'state', p_next_state,
                            'attempts', v_attempts, 'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.advance_ashby_ingestion is
  'Restart-safe ingestion state transition with hash/version provenance. '
  '0032: a requeue past the bounded attempt ceiling (5) is refused with '
  'retry_exhausted. 0037: a requeue of a VERDICT-class failed_review '
  '(scan_infected, guard_%, parse_error, no_extractable_fields) is refused '
  'with not_requeueable, so a file already identified as malware is never '
  're-downloaded; availability-class failures stay requeueable. A row '
  'returning to queued has its failed_reason cleared. Service-role-only.';
