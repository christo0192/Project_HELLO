-- =====================================================================
-- 0038 — Durable authoritative-recording finalization convergence.
--
-- WHY
-- ---
-- `call_sessions.recording_egress_status` is written in four statements;
-- three of them live inside `finalizeAuthoritativeRecording()`, and that
-- function had exactly two production callers — the candidate browser's
-- `POST /api/livekit/:id/complete` and a recruiter pressing play. THREE
-- code paths write `status = 'completed'`, and only ONE of them is a
-- caller: the voice worker completes the session directly against this
-- table (`persistence.py` → `_cas_update`), and the text screening turn
-- route completes it in TypeScript without ever touching the finalizer.
--
-- A session completed by the worker therefore froze at
-- `recording_egress_status = 'active'` with a NULL object key, forever:
-- there was no webhook receiver, no sweeper, no cron, and no health
-- signal anywhere in the deployment. That is not a bug inside finalize —
-- it is the ABSENCE OF ANY ACTOR to call it.
--
-- The seam that covers all three writers, without editing the Python
-- worker, is a trigger on the terminal transition itself. It is in the
-- SAME TRANSACTION as the completing CAS, which structurally removes the
-- "process died between the CAS and the enqueue" gap that would otherwise
-- make the sweeper load-bearing rather than a backstop.
--
-- WHAT THIS MIGRATION ADDS
-- ------------------------
--   1. Observability columns — a deferral now says WHY, how many times,
--      when, and whether it has given up. `'pending'` previously wrote
--      nothing and logged nothing while collapsing five distinct causes.
--   2. A partial index matching the exact stuck shape, over the FULL
--      terminal set.
--   3. `enqueue_recording_finalize()` — the terminal-transition trigger.
--   4. `reopen_recording_finalize()` — the audited reset lifecycle for
--      a latched row, guarded by a reason allowlist.
--   5. `record_recording_finalize_deferral()` — atomic attempt/reason
--      bookkeeping with its own terminus.
--   6. `recording_finalize_control` + set/clear halt RPCs — the kill
--      switch, with a real substrate and a real CLEAR path.
--   7. `reap_completed_jobs()` — a bounded, general reaper for terminal
--      `job_queue` rows, because (3) enqueues one job per recorded
--      session and nothing in the repository ever deleted a completed
--      job row.
--   8. `residency_timeout` added to the `status='failed'` terminal-reason
--      set, so the voice worker's new wall-clock residency cap can be
--      persisted TRUTHFULLY instead of being mislabelled `worker_crash`.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
-- It does NOT widen `chk_call_sessions_recording_egress_status`. The
-- three-value domain (`active`/`complete`/`failed`) is kept exactly as
-- 0021 defined it, so no existing read gate — `recordings.ts`, the
-- candidate grant path — changes meaning. The new nuance lives entirely
-- in `recording_finalize_defer_reason`.
--
-- Forward-only and additive: guarded `add column if not exists`,
-- `create index if not exists`, `create or replace function`, and the
-- 0021/0025 house-style `drop constraint if exists` → `add constraint …
-- not valid` → `validate constraint`. No destructive DDL, no data loss,
-- no reverse SQL. Every new function is revoked from public/anon/
-- authenticated and granted only to service_role. No session ids and no
-- candidate data appear anywhere in this file.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Finalization observability on call_sessions
-- ═══════════════════════════════════════════════════════════════════════
-- Without these, "we have not tried yet" and "we tried five times and
-- gave up" are the same row, and "the storage gateway is misconfigured"
-- and "the egress is still flushing" are the same silence.

alter table screening_v2.call_sessions
  add column if not exists recording_finalize_attempts integer not null default 0;
alter table screening_v2.call_sessions
  add column if not exists recording_finalize_last_attempt_at timestamptz;
alter table screening_v2.call_sessions
  add column if not exists recording_finalize_defer_reason text;
alter table screening_v2.call_sessions
  add column if not exists recording_finalize_exhausted_at timestamptz;

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_finalize_attempts;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_finalize_attempts
  check (recording_finalize_attempts >= 0 and recording_finalize_attempts <= 1000)
  not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_finalize_attempts;

-- A BOUNDED ALLOWLIST, not free text. This column is written from a code
-- path that has already seen a provider response and a storage error
-- object; an enum is what keeps provider text out of a durable column.
-- It is also the AUTHORITATIVE list: the queue's own `defer_job` reason
-- gate is a looser shape regex (`^[a-z0-9_.:-]{1,64}$`), so a code added
-- to the worker but not here would defer the JOB normally while failing
-- this write — and, because the write is best-effort, failing SILENTLY.
-- The two must always move together; `recording-finalize-convergence`
-- has a test asserting every code the worker can emit satisfies this.
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_finalize_defer_reason;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_finalize_defer_reason
  check (
    recording_finalize_defer_reason is null
    or recording_finalize_defer_reason in (
      'poll_timeout',
      'object_unreadable',
      'object_absent',
      'provider_error',
      'egress_identity_mismatch',
      'provenance_conflict',
      'terminal_state',
      'rpc_unknown',
      'egress_disabled'
    )
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_finalize_defer_reason;

comment on column screening_v2.call_sessions.recording_finalize_attempts is
  'Count of finalization attempts that ended in a DEFERRAL (the work could '
  'not complete yet). Reset only by reopen_recording_finalize. Distinct '
  'from job_queue.attempts, which counts genuine handler throws — a '
  'deferral refunds that one and charges this one instead.';
comment on column screening_v2.call_sessions.recording_finalize_last_attempt_at is
  'When the most recent finalization deferral was recorded. Null means no '
  'attempt has ever been deferred, NOT that no attempt was ever made.';
comment on column screening_v2.call_sessions.recording_finalize_defer_reason is
  'Bounded reason code for the MOST RECENT finalization deferral; null '
  'when nothing is waiting. Never free text and never provider text — the '
  'CHECK is an allowlist, so an unanticipated message cannot be persisted.';
comment on column screening_v2.call_sessions.recording_finalize_exhausted_at is
  'TERMINUS for the finalization retry lifecycle. Stored rather than '
  'derived from `attempts >= :max` on purpose: a counter that GATES a '
  'control needs its own reset lifecycle, and a runtime env knob compared '
  'inside a WHERE clause is not one. The sweeper selects only rows where '
  'this is null; reopen_recording_finalize clears it.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. The sweeper index — the exact stuck shape, partial so it stays tiny
-- ═══════════════════════════════════════════════════════════════════════
-- The predicate enumerates the FULL terminal set from 0006 §6, not just
-- `completed`. `lib/reconciliation.ts` transitions a stale session to
-- `expired`/`idle_timeout` — a candidate who closed the tab and never
-- called `POST /:id/complete` — which is PRECISELY the population with a
-- live egress, a NULL key, and no actor to finalize it. A partial index
-- narrower than the query predicate would not be used at all, and would
-- silently change which rows are eligible.

create index if not exists idx_call_sessions_recording_finalize_pending
  on screening_v2.call_sessions (ended_at)
  where status in ('completed', 'failed', 'cancelled', 'expired')
    and recording_egress_id is not null
    and recording_object_key is null
    and recording_egress_status = 'active'
    and recording_finalize_exhausted_at is null;

comment on index screening_v2.idx_call_sessions_recording_finalize_pending is
  'Serves the recording finalization sweeper. Predicate is the stuck shape '
  'over the FULL 0006 terminal set. The sweeper query in '
  'lib/recording/sweeper.ts must remain a SUPERSET of this predicate — it '
  'additionally excludes deleted/revoked/quarantined rows, which is why a '
  'partial index narrower than the query would be unusable while a query '
  'narrower than the index is served fine. Widening this index predicate, or '
  'narrowing the query below it, would silently change which rows are '
  'eligible.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. enqueue_recording_finalize — the terminal-transition trigger
-- ═══════════════════════════════════════════════════════════════════════
-- SECURITY MODE: `security invoker`, deliberately. All three terminal
-- writers already act as the service role (`persistence.py` reads
-- SUPABASE_SERVICE_ROLE_KEY; the API uses the service-role client), and
-- 0001 grants service_role every table. It is stated rather than assumed
-- because `job_queue` is `revoke all … from anon, authenticated` (0009),
-- so any FUTURE path that completes a session under the `authenticated`
-- role would abort the terminal CAS on this insert.
--
-- That abort is the CORRECT outcome and the enqueue is deliberately NOT
-- wrapped in a `begin/exception` block: swallowing the failure would drop
-- the enqueue silently and make the sweeper load-bearing, which is
-- exactly the property this trigger exists to provide. The invariant —
-- terminal writers are service-role — is the control, not a catch.
--
-- The 60-second grace is a migration-level literal rather than an env
-- read: it exists so the enqueue does not race the egress's own flush,
-- and a value that can drift per machine is not a property of the data.

create or replace function screening_v2.enqueue_recording_finalize()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  -- `uq_job_queue_dedup_active` (0009) covers pending/active/delayed, so
  -- this is idempotent while a job is live AND permits a fresh enqueue
  -- once the previous job completed — exactly the retry lifecycle the
  -- sweeper needs. `on conflict do nothing` without a conflict target
  -- covers every unique index on the table.
  insert into screening_v2.job_queue
    (name, payload, dedup_key, max_attempts, scheduled_at)
  values
    ('recording.finalize',
     jsonb_build_object('session_id', new.id),
     'recording.finalize:' || new.id::text,
     5,
     now() + interval '60 seconds')
  on conflict do nothing;
  return new;
end;
$$;

comment on function screening_v2.enqueue_recording_finalize is
  'AFTER UPDATE trigger on call_sessions: durably records the INTENT to '
  'finalize an authoritative recording the moment a session becomes '
  'terminal with a linked egress and no object key. Runs inside the '
  'completing CAS transaction, so a process that dies immediately after '
  'the CAS still leaves the intent behind. security invoker: the terminal '
  'writers are service-role, and a non-service-role writer MUST fail the '
  'CAS rather than silently skip the enqueue.';

drop trigger if exists trg_enqueue_recording_finalize on screening_v2.call_sessions;
create trigger trg_enqueue_recording_finalize
  after update on screening_v2.call_sessions
  for each row
  when (
    new.status in ('completed', 'failed', 'cancelled', 'expired')
    and new.recording_egress_id is not null
    and new.recording_object_key is null
    -- Never resurrect a row whose recording is legally or operationally
    -- finished. Same terminal set finalize_authoritative_recording (0025)
    -- refuses with 'terminal_state'.
    and new.recording_deleted_at is null
    and new.recording_revoked_at is null
    and coalesce(new.recording_quarantined, false) = false
    -- A row that already gave up is not re-driven by an unrelated update.
    and new.recording_finalize_exhausted_at is null
    and (
      -- (a) the row BECAME terminal;
      old.status is distinct from new.status
      -- (b) defensive: the egress link landed AFTER the row was terminal.
      or (old.recording_egress_id is null and new.recording_egress_id is not null)
    )
  )
  execute function screening_v2.enqueue_recording_finalize();

-- ═══════════════════════════════════════════════════════════════════════
-- 4. record_recording_finalize_deferral — atomic bookkeeping + terminus
-- ═══════════════════════════════════════════════════════════════════════
-- One statement, so two machines racing the same session cannot lose an
-- increment to a read-modify-write. Returns the POST-increment attempt
-- count and whether the row has now exhausted its budget, because the
-- caller needs both: the count drives the geometric defer delay (the
-- job's own `attempts` cannot, since defer_job REFUNDS it), and the
-- exhaustion flag is what tells the handler to stop deferring forever.
--
-- Deliberately refuses to touch a row that is already linked or already
-- in a terminal recording state: a deferral marker on such a row would
-- be a lie about work that is finished.

create or replace function screening_v2.record_recording_finalize_deferral(
  p_session_id   uuid,
  p_reason       text,
  p_max_attempts integer     default 5,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_max      integer := least(greatest(coalesce(p_max_attempts, 5), 1), 20);
  v_attempts integer;
  v_exhausted timestamptz;
begin
  if p_reason is null or p_reason not in (
    'poll_timeout', 'object_unreadable', 'object_absent', 'provider_error',
    'egress_identity_mismatch', 'provenance_conflict', 'terminal_state',
    'rpc_unknown', 'egress_disabled'
  ) then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  update screening_v2.call_sessions
     set recording_finalize_attempts        = recording_finalize_attempts + 1,
         recording_finalize_last_attempt_at = p_now,
         recording_finalize_defer_reason    = p_reason,
         recording_finalize_exhausted_at    = case
           when recording_finalize_attempts + 1 >= v_max
             then coalesce(recording_finalize_exhausted_at, p_now)
           else recording_finalize_exhausted_at
         end
   where id = p_session_id
     and recording_object_key is null
     and recording_deleted_at is null
     and recording_revoked_at is null
     and coalesce(recording_quarantined, false) = false
  returning recording_finalize_attempts, recording_finalize_exhausted_at
       into v_attempts, v_exhausted;

  if v_attempts is null then
    return jsonb_build_object('status', 'not_applicable');
  end if;
  return jsonb_build_object('status', 'ok',
                            'attempts', v_attempts,
                            'max_attempts', v_max,
                            'exhausted', v_exhausted is not null);
end;
$$;

revoke all on function screening_v2.record_recording_finalize_deferral(uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.record_recording_finalize_deferral(uuid, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.record_recording_finalize_deferral is
  'Atomically records ONE finalization deferral: increments the attempt '
  'counter, stamps the reason and time, and sets the exhaustion terminus '
  'when the bounded budget is reached. Refuses rows that are already '
  'linked, deleted, revoked, or quarantined. Returns the post-increment '
  'attempt count so the caller can compute a geometric defer delay — the '
  'queue job''s own attempts cannot serve that purpose because defer_job '
  'refunds them. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. reopen_recording_finalize — the audited reset lifecycle
-- ═══════════════════════════════════════════════════════════════════════
-- `recording_egress_status = 'failed'` was a ONE-WAY LATCH: nothing in
-- the repository ever moved a row back to 'active', and both read gates
-- test it. 0038 also (deliberately) makes one former latch a deferral —
-- a zero-byte download is evidence about STORAGE, not about the egress —
-- and a weakening must ship WITH its mitigation. This RPC is the other
-- half: the only writer that moves 'failed' → 'active', guarded by a
-- reason allowlist so it cannot become a general-purpose unfail.

create or replace function screening_v2.reopen_recording_finalize(
  p_session_id uuid,
  p_reason     text,
  p_actor_id   uuid        default null,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row record;
  -- The ONLY justifications for reopening. Anything else is a request to
  -- retry work that already produced a real answer.
  v_reasons constant text[] := array[
    'storage_configuration_repaired',
    'provider_incident_resolved',
    'operator_review'
  ];
begin
  if p_reason is null or not (p_reason = any(v_reasons)) then
    return jsonb_build_object('status', 'invalid_reason',
                              'reason', coalesce(p_reason, 'null'));
  end if;

  select id,
         recording_object_key,
         recording_egress_id,
         recording_egress_status,
         recording_finalize_attempts,
         recording_finalize_defer_reason,
         recording_deleted_at,
         recording_revoked_at,
         recording_quarantined
    into v_row
    from screening_v2.call_sessions
   where id = p_session_id
     for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Same terminal set finalize_authoritative_recording refuses (I-3).
  if v_row.recording_deleted_at is not null
     or v_row.recording_revoked_at is not null
     or v_row.recording_quarantined = true then
    return jsonb_build_object('status', 'terminal_state');
  end if;

  -- Reopening a LINKED recording is never correct: the authoritative
  -- object already exists and re-finalizing could only displace it.
  if v_row.recording_object_key is not null then
    return jsonb_build_object('status', 'already_linked');
  end if;

  if v_row.recording_egress_id is null then
    return jsonb_build_object('status', 'no_egress');
  end if;

  update screening_v2.call_sessions
     set recording_finalize_attempts     = 0,
         recording_finalize_exhausted_at = null,
         recording_finalize_defer_reason = null,
         -- The ONLY writer that moves 'failed' back to 'active'.
         recording_egress_status         = 'active'
   where id = p_session_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     -- 'recruiter' is the actor_type the 0007 CHECK admits for a human
     -- operator; the ADMIN identity is carried by actor_id, which is what
     -- makes the reopen attributable. Mirrors reopen_ashby_invite_delivery.
     'recruiter',
     'admin_session_override', 'call_session', p_session_id::text, 'success',
     jsonb_build_object('override', 'recording_finalize_reopen',
                        'reason', p_reason,
                        'previous_egress_status',
                          coalesce(v_row.recording_egress_status, 'null'),
                        'previous_defer_reason',
                          coalesce(v_row.recording_finalize_defer_reason, 'null'),
                        'attempts_before', v_row.recording_finalize_attempts));

  return jsonb_build_object('status', 'ok',
                            'attempts_before', v_row.recording_finalize_attempts,
                            'previous_egress_status',
                              coalesce(v_row.recording_egress_status, 'null'));
end;
$$;

revoke all on function screening_v2.reopen_recording_finalize(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reopen_recording_finalize(uuid, text, uuid, timestamptz)
  to service_role;

comment on function screening_v2.reopen_recording_finalize is
  'Audited operator reopen of ONE session''s authoritative-recording '
  'finalization. The only writer that moves recording_egress_status from '
  '''failed'' back to ''active''. Guarded by a reason allowlist '
  '(storage_configuration_repaired / provider_incident_resolved / '
  'operator_review) so it cannot become a general-purpose unfail; refuses '
  'deleted/revoked/quarantined rows, an already-linked key, and a session '
  'with no egress. Resets the attempt counter and the exhaustion terminus. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. recording_finalize_control — the kill switch, with a real substrate
-- ═══════════════════════════════════════════════════════════════════════
-- The Ashby halt (`halt_ashby_sync_sweep`, 0034) is NOT an operator flag:
-- it is a function the reconciler calls on ITSELF, refused unless the
-- caller holds the live single-flight lease, writing onto an Ashby-only
-- checkpoint table. Recordings have no checkpoint row to hang a flag on,
-- and there is no operator-settable flag table anywhere in the schema.
-- This is that substrate: a singleton row, an audited SET, and — because
-- a gate with no reset is a one-way latch — an audited CLEAR.

create table if not exists screening_v2.recording_finalize_control (
  control_key       text primary key default 'default',
  sweep_halted_at   timestamptz,
  sweep_halt_reason text,
  updated_at        timestamptz not null default now(),
  constraint chk_recording_finalize_control_key
    check (control_key = 'default'),
  constraint chk_recording_finalize_control_reason
    check (
      sweep_halt_reason is null
      or sweep_halt_reason in (
        'operator_pause', 'storage_incident', 'provider_incident', 'backlog_control'
      )
    ),
  -- A halt is a reason AND a time, or neither. A half-written halt would
  -- be readable as "not halted" by one query and "halted" by another.
  constraint chk_recording_finalize_control_coherent
    check ((sweep_halted_at is null) = (sweep_halt_reason is null))
);

insert into screening_v2.recording_finalize_control (control_key)
values ('default')
on conflict (control_key) do nothing;

alter table screening_v2.recording_finalize_control enable row level security;
revoke all on screening_v2.recording_finalize_control from anon, authenticated;

comment on table screening_v2.recording_finalize_control is
  'Singleton operator control for the recording finalization runtime. '
  'Setting the halt freezes both the sweeper (no new enqueues) and the '
  'queue runner''s admission gate (no new claims) fleet-wide without a '
  'deploy. Service-role-only backend infrastructure; RLS blocks the '
  'browser roles outright.';

create or replace function screening_v2.set_recording_finalize_halt(
  p_reason   text,
  p_actor_id uuid        default null,
  p_now      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_prev timestamptz;
begin
  if p_reason is null or p_reason not in (
    'operator_pause', 'storage_incident', 'provider_incident', 'backlog_control'
  ) then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.recording_finalize_control (control_key)
  values ('default') on conflict (control_key) do nothing;

  select sweep_halted_at into v_prev
    from screening_v2.recording_finalize_control
   where control_key = 'default'
     for update;

  update screening_v2.recording_finalize_control
     -- Keep the ORIGINAL halt instant while a halt is already in force, so
     -- "how long has this been frozen" measures the real outage.
     set sweep_halted_at   = coalesce(sweep_halted_at, p_now),
         sweep_halt_reason = coalesce(sweep_halt_reason, p_reason),
         updated_at        = p_now
   where control_key = 'default';

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     'recruiter', 'admin_session_override', 'recording_finalize_control',
     'default', 'success',
     jsonb_build_object('override', 'recording_finalize_halt_set',
                        'reason', p_reason,
                        'already_halted', v_prev is not null));

  return jsonb_build_object('status', 'ok', 'already_halted', v_prev is not null);
end;
$$;

create or replace function screening_v2.clear_recording_finalize_halt(
  p_actor_id uuid        default null,
  p_now      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_prev_reason text;
  v_prev_at     timestamptz;
begin
  select sweep_halt_reason, sweep_halted_at into v_prev_reason, v_prev_at
    from screening_v2.recording_finalize_control
   where control_key = 'default'
     for update;

  update screening_v2.recording_finalize_control
     set sweep_halted_at   = null,
         sweep_halt_reason = null,
         updated_at        = p_now
   where control_key = 'default';

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     'recruiter', 'admin_session_override', 'recording_finalize_control',
     'default', 'success',
     jsonb_build_object('override', 'recording_finalize_halt_cleared',
                        'previous_reason', coalesce(v_prev_reason, 'null'),
                        'was_halted', v_prev_at is not null));

  return jsonb_build_object('status', 'ok', 'was_halted', v_prev_at is not null);
end;
$$;

revoke all on function screening_v2.set_recording_finalize_halt(text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_recording_finalize_halt(text, uuid, timestamptz)
  to service_role;
revoke all on function screening_v2.clear_recording_finalize_halt(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.clear_recording_finalize_halt(uuid, timestamptz)
  to service_role;

comment on function screening_v2.set_recording_finalize_halt is
  'Audited operator HALT of the recording finalization runtime. Freezes '
  'the sweeper and the queue runner''s admission gate fleet-wide with no '
  'deploy. Idempotent: re-halting keeps the original halt instant so the '
  'freeze duration stays truthful. Service-role-only.';
comment on function screening_v2.clear_recording_finalize_halt is
  'Audited operator CLEAR of the recording finalization halt. Exists '
  'because a gate with no reset path is a one-way latch, not a control. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. reap_completed_jobs — a bounded reaper for terminal job_queue rows
-- ═══════════════════════════════════════════════════════════════════════
-- The trigger in §3 fires for EVERY egress-recorded session at the moment
-- it becomes terminal, not only stuck ones: `routes/livekit.ts` commits
-- `status='completed'` before it calls the finalizer, so the guard
-- `recording_object_key is null` is true for all of them. That is the
-- right trade — it is what covers the Python worker — but it makes the
-- enqueue UNIVERSAL, and `complete_job` (0037) leaves the row at
-- `status='completed'` while nothing in this repository has ever deleted
-- a completed `job_queue` row (the only DELETEs are the DLQ/replay
-- paths). One permanent row per recorded session, forever, is not a
-- "safe accumulation".
--
-- Deliberately GENERAL (every queue name, not just recording.finalize):
-- the growth it bounds is a property of the queue, and a
-- recording-specific reaper would leave the identical problem for the
-- Ashby queues one table over.
--
-- Safe by construction: `uq_job_queue_dedup_active` covers only
-- pending/active/delayed, so removing a COMPLETED row can never resurrect
-- a duplicate or unblock a dedup key that was still doing work; and
-- replay reads `job_dlq`, which this never touches.

create or replace function screening_v2.reap_completed_jobs(
  p_older_than_seconds integer     default 604800,
  p_limit              integer     default 500,
  p_now                timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_age   integer := least(greatest(coalesce(p_older_than_seconds, 604800), 3600), 7776000);
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_deleted integer := 0;
begin
  with victims as (
    select id
      from screening_v2.job_queue
     where status = 'completed'
       and completed_at is not null
       and completed_at < p_now - make_interval(secs => v_age)
     order by completed_at asc
     limit v_limit
     for update skip locked
  )
  delete from screening_v2.job_queue q
   using victims v
   where q.id = v.id;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('status', 'ok',
                            'deleted', v_deleted,
                            'limit', v_limit,
                            'older_than_seconds', v_age,
                            -- A pass that filled its budget did NOT cover
                            -- everything; a silent cap reads as "done".
                            'truncated', v_deleted >= v_limit);
end;
$$;

revoke all on function screening_v2.reap_completed_jobs(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reap_completed_jobs(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.reap_completed_jobs is
  'Bounded, general reaper for COMPLETED job_queue rows older than a '
  'clamped retention window. Deliberately not queue-specific: unbounded '
  'terminal-row growth is a property of the queue. Safe because '
  'uq_job_queue_dedup_active covers only pending/active/delayed and the '
  'DLQ is never touched. FOR UPDATE SKIP LOCKED so concurrent reapers on '
  'several machines never contend. Reports `truncated` when the pass '
  'filled its budget. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. residency_timeout — a truthful code for the voice residency cap
-- ═══════════════════════════════════════════════════════════════════════
-- The voice worker awaits its close event with NO wall-clock cap. Capping
-- it raises `TimeoutError`, which is an `Exception`, so it lands in the
-- existing handler and would be persisted as `worker_crash` — a false
-- attribution that also pollutes the real crash signal. A truthful code
-- needs BOTH a widened CHECK here and a widened `_FAILED_REASONS`
-- frozenset in `persistence.py`; neither alone is sufficient.
--
-- The constraint is re-stated in full (0006 §8 wording plus one member)
-- because a CHECK cannot be extended in place.

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_terminal_reason;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_terminal_reason check (
    (
      status not in ('completed', 'failed', 'cancelled', 'expired')
      and terminal_reason is null
    )
    or
    (
      status = 'completed'
      and terminal_reason in ('conversation_complete', 'assessment_done')
    )
    or
    (
      status = 'failed'
      and terminal_reason in (
        'room_create_error', 'worker_crash', 'provider_error',
        'assessment_error', 'shutdown_forced', 'drain_timeout',
        -- 0038: the session outlived its bounded room residency. Not a
        -- crash: the worker was alive and the close event never fired.
        'residency_timeout'
      )
    )
    or
    (
      status = 'cancelled'
      and terminal_reason in (
        'recruiter_cancelled', 'migrated_abandoned',
        'duplicate_session', 'shutdown_drain'
      )
    )
    or
    (
      status = 'expired'
      and terminal_reason in ('idle_timeout', 'grace_timeout')
    )
    or
    (
      status in ('completed', 'failed', 'cancelled', 'expired')
      and terminal_reason = 'legacy_unknown'
    )
  ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_terminal_reason;

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
