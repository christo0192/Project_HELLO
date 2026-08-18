-- =====================================================================
-- 0034 — Ashby reconciliation: durable PAGE-ANCHORED full-resync
--        continuation (partial checkpointing).
--
-- Forward-only and additive (C-1): guarded ALTER ... ADD COLUMN IF NOT
-- EXISTS, guarded CHECK constraints, one NEW function, and CREATE OR
-- REPLACE of two existing functions with UNCHANGED signatures. No table is
-- dropped, no column is dropped or retyped, no data is deleted, and no
-- browser-role grant or policy is added anywhere.
--
-- Security posture (mirrors 0029/0030/0031/0032/0033): every SECURITY
-- DEFINER RPC pins search_path, is revoked from public/anon/authenticated,
-- and is granted to service_role only. The continuation cursor is an OPAQUE
-- provider black box held in the same service-role-only table as the sync
-- token — never logged, never returned to a browser role.
--
-- WHY THIS MIGRATION EXISTS (production-exposed finding, PR64 review H1):
--   A forced full resync had to drain in ONE run or the cursor never moved.
--   The per-run bounds are maxPages 50 x pageLimit 100 and maxItems 5000, so
--   a tenant whose application corpus exceeds ~5,000 ended EVERY full sweep
--   on page_cap/item_cap, advanced nothing, and re-paged the same 5,000-row
--   prefix on every tick. Runtime evidence: with the mapping paused and the
--   backlog cleaned, repeated full resyncs stopped on `page_cap` at 50x100
--   and the checkpoint stayed `full_resync_required` forever. Reconciliation
--   — the dropped-webhook safety net — could never come up for that tenant.
--
--   The fix is a durable PAGE ANCHOR. A full resync now persists the opaque
--   provider page cursor after EVERY page whose every item was durably
--   handled, and the next run resumes from it instead of page 1:
--
--   H-1  Anchor-after-handle ordering. The cursor is saved only once every
--        item on that page has a committed receipt (and, where applicable, a
--        live queued job). A crash BEFORE the save replays that page — which
--        is dedup-safe — so no item can ever be skipped. A crash AFTER the
--        save resumes at the next page. Never the other way round.
--
--   H-2  Epoch-guarded invalidation. Enabling/repointing a mapping, or any
--        other mark_ashby_sync_full_resync, NULLS the continuation cursor and
--        bumps resync_epoch in the same transaction. A run that was already
--        paging under the old epoch cannot overwrite that reset: every
--        continuation save compare-and-sets the epoch and refuses on a
--        mismatch, so the stale run fails closed with no advancement.
--
--   H-3  Lease-guarded writes. The save also compare-and-sets the live
--        single-flight lease owner, so a runner whose lease expired (and
--        whose stream another runner now owns) cannot move the anchor.
--
--   H-4  Atomic finish. Draining the final page installs the sync token AND
--        clears the continuation AND returns the stream to idle in ONE
--        statement, so there is no window in which a stale anchor coexists
--        with a fresh incremental token.
--
--   H-6  EARLIEST-token install. The sweep token is first-write-wins, not
--        last-write-wins. If the provider issues a token per page, installing
--        the LAST one anchors "changes since" at the END of a sweep, and every
--        change that landed on an already-scanned page during the sweep is
--        permanently invisible to reconciliation. Installing the EARLIEST
--        token observed is safe under every issuance hypothesis: at worst it
--        re-delivers changes (idempotent), never skips them. Latent today at
--        50 pages; under multi-run sweeps the window is hours.
--
--   H-8  The storm breaker's compensating control. Page-aligning the enqueue
--        breaker (so pages stay atomic and anchorable) converts it from a WEDGE
--        into a RATE LIMIT: it bounds one run, and a sweep runs every few
--        seconds. Combined, the guarded rate moves from <=200 jobs / 15 min to
--        <=300 jobs / 5-10 s. `sweep_enqueued` therefore accumulates durable
--        work across the WHOLE sweep, and exceeding the absolute per-sweep
--        budget HALTS the sweep outright — reconciliation stops until an
--        operator clears it. Reconciliation stopping is the conservative
--        failure: webhook delivery is unaffected and nothing is lost, whereas
--        an unbounded rate is how the 2,000-job incident happened.
--
--   H-7  Anchor binding and freshness. An anchor is usable only when it was
--        written under the CURRENT resync_epoch and for the SAME sweep mode,
--        and only while it is fresh. Provider cursor lifetime is not a
--        documented guarantee, so an anchor older than the caller's freshness
--        bound is discarded and the sweep restarts from page 1 rather than
--        being fed to the provider and failing in an unknown way.
--
-- PRODUCTION PROBE (read-only, informs the bounds here): application.list
-- ignored a requested limit of 500 and returned ~100 per page, had NOT drained
-- after 1,200 pages / 118,909 items, and returned NO syncToken on any page. So
-- a raised one-run cap is NOT sufficient at this tenant's scale, multi-run
-- sweeps are the only viable shape, and a sweep may legitimately end with no
-- token to install at all. A follow-up probe confirmed a nextCursor stayed
-- VALID across separate processes after 120 seconds and resumed successfully
-- (HTTP 200, 100 items, a further cursor), so page-anchored resume is viable;
-- the freshness bound below is a conservative guard, not the mechanism. No
-- token appeared in 1,200 pages, so final-page-only issuance is likely — under
-- which earliest-wins and last-wins coincide, and earliest-wins stays correct
-- if that ever changes.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Continuation columns — the durable page anchor
-- ═══════════════════════════════════════════════════════════════════════
-- resync_cursor is the opaque provider page cursor to RESUME a full resync
-- from. NULL means "no continuation in flight" — start at page 1. The two
-- counters are bounded, non-identifying progress totals ACROSS the whole
-- continuation (so an operator can see a multi-run sweep making progress);
-- they carry no ids and are safe to surface as counts.

alter table screening_v2.ashby_sync_checkpoints
  add column if not exists resync_cursor       text,
  add column if not exists resync_cursor_epoch bigint,
  add column if not exists resync_cursor_at    timestamptz,
  add column if not exists sweep_mode          text,
  add column if not exists sweep_token         text,
  add column if not exists sweep_restarts      integer not null default 0,
  add column if not exists sweep_enqueued      integer not null default 0,
  add column if not exists sweep_halted_at     timestamptz,
  add column if not exists sweep_halt_reason   text,
  add column if not exists resync_pages_done   integer not null default 0,
  add column if not exists resync_items_done   integer not null default 0,
  add column if not exists resync_started_at   timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_resync_cursor'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_resync_cursor
        check (resync_cursor is null or length(resync_cursor) between 1 and 4096);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_resync_progress'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_resync_progress
        check (resync_pages_done >= 0 and resync_items_done >= 0
               and sweep_restarts >= 0 and sweep_enqueued >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_halt_reason'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_halt_reason
        check (sweep_halt_reason is null or length(sweep_halt_reason) <= 64);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_sweep_mode'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_sweep_mode
        check (sweep_mode is null or sweep_mode in ('full','incremental'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_sweep_token'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_sweep_token
        check (sweep_token is null or length(sweep_token) between 1 and 4096);
  end if;
end;
$$;

comment on column screening_v2.ashby_sync_checkpoints.resync_cursor is
  'Opaque provider PAGE cursor a full resync resumes from. Written only '
  'after every item on the preceding page was durably handled, under a '
  'resync_epoch AND lease-owner compare-and-set. NULL means no continuation '
  'is in flight. A black box like sync_token — never logged, never exposed '
  'to a browser role.';
comment on column screening_v2.ashby_sync_checkpoints.resync_pages_done is
  'Pages fully handled so far in the CURRENT continuation, across all of its '
  'runs. Reset when the continuation ends (drained) or is invalidated by a '
  'forced resync. A bounded count — never an id.';
comment on column screening_v2.ashby_sync_checkpoints.resync_items_done is
  'Applications fully handled so far in the CURRENT continuation, across all '
  'of its runs. Reset with the continuation. A bounded count — never an id.';
comment on column screening_v2.ashby_sync_checkpoints.resync_started_at is
  'When the current continuation first anchored a page. NULL when none is in '
  'flight. Lets an operator see a multi-run sweep is progressing, not stuck.';
comment on column screening_v2.ashby_sync_checkpoints.resync_cursor_epoch is
  'The resync_epoch the anchor was written under. An anchor whose epoch no '
  'longer matches was scanned under a STALE admission index and must not be '
  'resumed — the newly enabled mapping admits rows the scanned prefix skipped.';
comment on column screening_v2.ashby_sync_checkpoints.resync_cursor_at is
  'When the anchor was last written. Provider cursor lifetime is not a '
  'documented guarantee, so a caller discards an anchor older than its '
  'freshness bound and restarts the sweep instead of replaying a dead cursor.';
comment on column screening_v2.ashby_sync_checkpoints.sweep_mode is
  'Which sweep the anchor belongs to (full | incremental). A full anchor must '
  'never be fed to an incremental request or vice versa.';
comment on column screening_v2.ashby_sync_checkpoints.sweep_token is
  'EARLIEST opaque sync token observed during the current sweep, installed on '
  'completion. First-write-wins: anchoring "changes since" at the START of a '
  'sweep can only re-deliver (idempotent), while the end of a sweep would '
  'permanently hide changes that landed on already-scanned pages. Opaque — '
  'never logged, never exposed to a browser role.';
comment on column screening_v2.ashby_sync_checkpoints.sweep_enqueued is
  'Signal jobs this SWEEP has created, across all of its runs. The per-run '
  'breaker bounds one pass; page-aligning it and sweeping every few seconds '
  'turned that bound into a rate, so this is the figure that actually bounds '
  'blast radius. Exceeding the absolute per-sweep budget halts the sweep. A '
  'bounded count — never an id.';
comment on column screening_v2.ashby_sync_checkpoints.sweep_halted_at is
  'When reconciliation HALTED itself on this stream (per-sweep enqueue budget '
  'or restart budget exhausted). While set, every run returns immediately '
  'without a single provider call. Cleared by mark_ashby_sync_full_resync — '
  'i.e. by a deliberate operator action. Reconciliation stopping is the '
  'conservative failure: webhook delivery is unaffected.';
comment on column screening_v2.ashby_sync_checkpoints.sweep_halt_reason is
  'Sanitized code for why the sweep halted. Never an id, token, or message.';
comment on column screening_v2.ashby_sync_checkpoints.sweep_restarts is
  'How many times a sweep was abandoned and restarted from page 1 (stale or '
  'invalidated anchor). A climbing value means resume is not holding — the '
  'operator signal that the continuation is not working. A bounded count.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. save_ashby_resync_cursor — the page anchor, epoch- and lease-guarded
-- ═══════════════════════════════════════════════════════════════════════
-- Called by a full-resync run ONLY after every item on the page preceding
-- p_cursor has been durably handled. Two compare-and-sets make it fail
-- closed rather than corrupt the stream:
--
--   epoch  — p_resync_epoch is the generation the run observed before it
--            started paging. A forced resync raised meanwhile (mapping
--            enable/repoint/resume, token rejection, drift abort) has bumped
--            it and NULLED the cursor; the mismatch returns 'epoch_changed'
--            and NOTHING is written, so the stale run cannot resurrect an
--            anchor into a generation that must restart from page 1.
--   lease  — the caller must still hold the live single-flight lease. A
--            runner whose lease expired (and whose stream another runner now
--            owns, or which is now unowned) gets 'not_owned'/'lease_expired'
--            and writes nothing.
--
-- The progress counters only ever move FORWARD (greatest), so an out-of-
-- order or replayed save can never make a continuation look younger than it
-- is. The function is deliberately NOT idempotent-by-cursor: re-anchoring
-- the same cursor is harmless (same value, counters unchanged by greatest).

create or replace function screening_v2.save_ashby_resync_cursor(
  p_checkpoint_key text,
  p_cursor         text,
  p_owner          text,
  p_pages_done     integer default 0,
  p_items_done     integer default 0,
  p_resync_epoch   bigint  default null,
  p_now            timestamptz default now(),
  p_mode           text    default null,
  p_sweep_token    text    default null,
  p_first          boolean default false,
  p_enqueued       integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row      screening_v2.ashby_sync_checkpoints%rowtype;
  v_owner    text := left(coalesce(p_owner, 'reconciler'), 128);
  v_pages    integer;
  v_items    integer;
  v_token    text;
  v_restarts integer;
  v_started  timestamptz;
  v_enq      integer;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  -- A null/empty cursor would silently mean "restart from page 1" on the
  -- next run, which is exactly the bug this migration exists to remove.
  if p_cursor is null or length(p_cursor) < 1 or length(p_cursor) > 4096 then
    return jsonb_build_object('status', 'invalid_cursor');
  end if;
  if p_mode is not null and p_mode not in ('full','incremental') then
    return jsonb_build_object('status', 'invalid_mode');
  end if;
  if p_sweep_token is not null and (length(p_sweep_token) < 1 or length(p_sweep_token) > 4096) then
    return jsonb_build_object('status', 'invalid_sweep_token');
  end if;

  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- H-3: the anchor may only be moved by the runner that currently holds the
  -- stream's single-flight lease.
  if v_row.lease_expires_at is null or v_row.lease_expires_at <= p_now then
    return jsonb_build_object('status', 'lease_expired');
  end if;
  if v_row.lease_owner is distinct from v_owner then
    return jsonb_build_object('status', 'not_owned');
  end if;

  -- H-2: a forced resync raised after this run started invalidates it.
  if p_resync_epoch is not null and v_row.resync_epoch is distinct from p_resync_epoch then
    return jsonb_build_object('status', 'epoch_changed');
  end if;

  if coalesce(p_first, false) then
    -- The FIRST anchor of a new sweep. Any anchor still standing belonged to a
    -- sweep the caller decided not to resume (stale, wrong mode, invalidated),
    -- so this is a restart: reset the sweep's own state and count it.
    v_pages    := greatest(0, coalesce(p_pages_done, 0));
    v_items    := greatest(0, coalesce(p_items_done, 0));
    v_token    := p_sweep_token;
    v_started  := p_now;
    v_restarts := coalesce(v_row.sweep_restarts, 0)
                  + case when v_row.resync_cursor is not null then 1 else 0 end;
    -- A new sweep starts its durable-work budget over.
    v_enq      := greatest(0, coalesce(p_enqueued, 0));
  else
    -- Continuing the same sweep: counters only move forward, and the sweep
    -- token is FIRST-write-wins (H-6).
    v_pages    := greatest(coalesce(v_row.resync_pages_done, 0), greatest(0, coalesce(p_pages_done, 0)));
    v_items    := greatest(coalesce(v_row.resync_items_done, 0), greatest(0, coalesce(p_items_done, 0)));
    v_token    := coalesce(v_row.sweep_token, p_sweep_token);
    v_started  := coalesce(v_row.resync_started_at, p_now);
    v_restarts := coalesce(v_row.sweep_restarts, 0);
    -- H-8: durable work accumulates across the WHOLE sweep, monotonically.
    v_enq      := greatest(coalesce(v_row.sweep_enqueued, 0), greatest(0, coalesce(p_enqueued, 0)));
  end if;

  -- I7: this statement deliberately touches NO stream-level field — not
  -- status, not full_resync_reason, not sync_token, token_issued_at,
  -- last_success_at, or no_progress_runs. A pending forced resync, and the
  -- meaning of `status`, survive every anchor write untouched.
  update screening_v2.ashby_sync_checkpoints
     set resync_cursor       = p_cursor,
         resync_cursor_epoch = v_row.resync_epoch,
         resync_cursor_at    = p_now,
         sweep_mode          = coalesce(p_mode, v_row.sweep_mode),
         sweep_token         = v_token,
         sweep_restarts      = v_restarts,
         resync_pages_done   = v_pages,
         resync_items_done   = v_items,
         resync_started_at   = v_started,
         sweep_enqueued      = v_enq,
         updated_at          = p_now
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key;

  return jsonb_build_object('status', 'ok',
                            'resync_pages_done', v_pages,
                            'resync_items_done', v_items,
                            'sweep_restarts', v_restarts,
                            'sweep_enqueued', v_enq);
end;
$$;

revoke all on function screening_v2.save_ashby_resync_cursor(text, text, text, integer, integer, bigint, timestamptz, text, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function screening_v2.save_ashby_resync_cursor(text, text, text, integer, integer, bigint, timestamptz, text, text, boolean, integer)
  to service_role;

comment on function screening_v2.save_ashby_resync_cursor is
  'Persists the durable PAGE ANCHOR for an in-flight full resync, so the '
  'next run resumes there instead of page 1. Called only after every item '
  'on the preceding page was durably handled, and refused (nothing written) '
  'when the resync_epoch moved or the caller no longer holds the '
  'single-flight lease. The cursor is an opaque provider black box — never '
  'logged or exposed to a browser role. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2b. halt_ashby_sync_sweep — the circuit breaker with teeth (H-8)
-- ═══════════════════════════════════════════════════════════════════════
-- Page-aligning the enqueue breaker made it a RATE limit rather than a wedge,
-- and the sweep cadence multiplied that rate. The compensating control is an
-- ABSOLUTE per-sweep budget that, when exhausted, stops reconciliation on this
-- stream entirely until an operator intervenes — restoring the "wedge"
-- property the per-run breaker used to provide, at sweep granularity.
--
-- Also used when a sweep restarts from page 1 too many times: a resume that
-- never holds would otherwise re-page the whole corpus forever.
--
-- Deliberately does NOT touch `status` (D-3: `status` is a single encoding
-- slot and holds the forced-resync demand). The halt is its own field, so a
-- pending resync survives it and is honoured once the halt is cleared.
-- Clearing is `mark_ashby_sync_full_resync` — a deliberate operator action,
-- which is also what enabling or repointing a mapping performs.

create or replace function screening_v2.halt_ashby_sync_sweep(
  p_checkpoint_key text,
  p_owner          text,
  p_reason         text,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.ashby_sync_checkpoints%rowtype;
  v_owner text := left(coalesce(p_owner, 'reconciler'), 128);
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_reason is null or length(p_reason) < 1 or length(p_reason) > 64 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.lease_owner is distinct from v_owner then
    return jsonb_build_object('status', 'not_owned');
  end if;

  update screening_v2.ashby_sync_checkpoints
     set sweep_halted_at   = coalesce(sweep_halted_at, p_now),
         sweep_halt_reason = coalesce(sweep_halt_reason, p_reason),
         -- Drop the anchor: whatever this sweep was doing must not resume.
         resync_cursor       = null,
         resync_cursor_epoch = null,
         resync_cursor_at    = null,
         updated_at          = p_now
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key;

  return jsonb_build_object('status', 'ok', 'halted_at', p_now);
end;
$$;

revoke all on function screening_v2.halt_ashby_sync_sweep(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.halt_ashby_sync_sweep(text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.halt_ashby_sync_sweep is
  'HALTS reconciliation on one stream after a sweep exhausted its absolute '
  'per-sweep enqueue budget or restart budget. While halted every run returns '
  'before any provider call, so a page-aligned breaker cannot become an '
  'unbounded rate. Does not touch status, so a pending forced resync '
  'survives. Cleared by mark_ashby_sync_full_resync (a deliberate operator '
  'action). Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. mark_ashby_sync_full_resync — invalidate the continuation
-- ═══════════════════════════════════════════════════════════════════════
-- Signature and existing semantics unchanged from 0033 (null the token, flag
-- the stream, bump the epoch). ADDED: the continuation is invalidated in the
-- SAME statement — cursor nulled and progress zeroed — so a newly forced
-- resync can never resume from a page anchor that belonged to the previous
-- generation and therefore skip applications the new mapping admits.

create or replace function screening_v2.mark_ashby_sync_full_resync(
  p_checkpoint_key text,
  p_reason         text,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id    uuid;
  v_epoch bigint;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_reason is not null and length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     full_resync_reason, resync_epoch, resync_cursor, resync_cursor_epoch,
     resync_cursor_at, sweep_mode, sweep_token, sweep_restarts, sweep_enqueued,
     sweep_halted_at, sweep_halt_reason,
     resync_pages_done, resync_items_done, resync_started_at, updated_at)
  values
    ('ashby', p_checkpoint_key, null, 'full_resync_required', null, p_reason, 1,
     null, null, null, null, null, 0, 0, null, null, 0, 0, null, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = null,
     status             = 'full_resync_required',
     token_issued_at    = null,
     full_resync_reason = p_reason,
     resync_epoch       = screening_v2.ashby_sync_checkpoints.resync_epoch + 1,
     -- Invalidate any in-flight continuation: the new generation must sweep
     -- from page 1, and the old anchor is meaningless (and unsafe) for it.
     resync_cursor       = null,
     resync_cursor_epoch = null,
     resync_cursor_at    = null,
     sweep_mode          = null,
     sweep_token         = null,
     -- An anchor standing at this moment means a sweep was abandoned mid-way.
     sweep_restarts      = screening_v2.ashby_sync_checkpoints.sweep_restarts
                           + case when screening_v2.ashby_sync_checkpoints.resync_cursor
                                       is not null then 1 else 0 end,
     sweep_enqueued      = 0,
     -- A forced resync IS the operator action that clears a halt.
     sweep_halted_at     = null,
     sweep_halt_reason   = null,
     resync_pages_done   = 0,
     resync_items_done   = 0,
     resync_started_at   = null,
     updated_at          = p_now
  returning id, resync_epoch into v_id, v_epoch;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'resync_epoch', v_epoch);
end;
$$;

revoke all on function screening_v2.mark_ashby_sync_full_resync(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_ashby_sync_full_resync(text, text, timestamptz)
  to service_role;

comment on function screening_v2.mark_ashby_sync_full_resync is
  'Forces a safe full resync: nulls the opaque sync token, flags the stream '
  'full_resync_required, bumps the monotonic resync_epoch so a run already '
  'paging cannot clear the flag, and INVALIDATES any in-flight page-anchored '
  'continuation so the new generation sweeps from page 1. Used on token '
  'expiry/rejection, on a dropped-signal audit, and — in the same '
  'transaction as the mapping write — when enabling a mapping opens new '
  'admission. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. advance_ashby_sync_checkpoint — atomic finish of a continuation
-- ═══════════════════════════════════════════════════════════════════════
-- Signature unchanged from 0033. ADDED (H-4): a run that DRAINED ends the
-- continuation in the same statement that installs the sync token — cursor
-- nulled, counters zeroed, status idle — so there is never a window where a
-- stale page anchor coexists with a fresh incremental token.
--
-- ADDED (H-5): an optional p_owner lease compare-and-set. Before 0034 a stale
-- runner's advance was merely a redundant token install; with a continuation
-- in play it is destructive. Consider runner A, whose lease expired mid-sweep,
-- and runner B, which took the stream over and is anchoring pages: if A then
-- drains and advances, it installs a sync token and clears B's continuation.
-- The stream is now `idle` with a valid token, so the NEXT run goes
-- incremental and B's unread pages are never swept — applications silently
-- missed. Refusing an advance from a non-owner closes that. p_owner null keeps
-- the pre-0034 behaviour for callers that hold no lease.
--
-- The other case where the continuation is deliberately LEFT ALONE is the
-- epoch-mismatch branch (v_keep). There the stream is still
-- full_resync_required for a NEWER generation whose anchor this stale run
-- must not touch: clearing it would discard another generation's durable
-- progress, and writing to it would resurrect this one's. So: advance the
-- cursor this run genuinely earned, preserve the forced-resync demand, and
-- leave the continuation exactly as the newer generation left it.

create or replace function screening_v2.advance_ashby_sync_checkpoint(
  p_checkpoint_key text,
  p_sync_token     text,
  p_pages          integer,
  p_items          integer,
  p_full           boolean default false,
  p_now            timestamptz default now(),
  p_resync_epoch   bigint default null,
  p_owner          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id      uuid;
  v_row     screening_v2.ashby_sync_checkpoints%rowtype;
  v_keep    boolean := false;
  v_status  text;
  v_token   text;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_sync_token is not null and (length(p_sync_token) < 1 or length(p_sync_token) > 4096) then
    return jsonb_build_object('status', 'invalid_sync_token');
  end if;

  -- Lock the row (when it exists) so the epoch compare-and-set, the cursor
  -- write, and the continuation reset are one atomic decision.
  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;

  -- H-5: a caller that names itself must still hold the LIVE lease — both the
  -- owner and the expiry. Checking only the owner would let a runner whose
  -- lease lapsed unclaimed still install a token, which is the same hazard one
  -- step removed.
  if found and p_owner is not null then
    if v_row.lease_owner is distinct from left(p_owner, 128) then
      return jsonb_build_object('status', 'not_owned');
    end if;
    if v_row.lease_expires_at is null or v_row.lease_expires_at <= p_now then
      return jsonb_build_object('status', 'lease_expired');
    end if;
  end if;

  if found and p_resync_epoch is not null
     and v_row.resync_epoch is distinct from p_resync_epoch then
    -- A forced resync was raised AFTER this run read the checkpoint. Advance
    -- the cursor, but do not let this run's completion clear that demand,
    -- and do not touch the newer generation's continuation.
    v_keep := true;
  end if;

  v_status := case when v_keep then 'full_resync_required' else 'idle' end;

  -- H-6: EARLIEST-wins. A token banked earlier in THIS sweep anchors "changes
  -- since" at the sweep's START, so a change that landed on an already-scanned
  -- page is re-delivered (idempotent) rather than permanently hidden.
  --
  -- On the epoch-mismatch branch the banked token belongs to a DIFFERENT,
  -- still-running generation and must not be installed as this stream's token;
  -- that branch installs the caller's own token, preserving 0033's behaviour
  -- exactly (the cursor advances, the forced-resync demand stands).
  v_token := case when v_keep then p_sync_token
                  else coalesce(v_row.sweep_token, p_sync_token) end;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     last_success_at, last_full_sync_at, pages_last_run, items_last_run,
     full_resync_reason, no_progress_runs, resync_cursor, resync_cursor_epoch,
     resync_cursor_at, sweep_mode, sweep_token, resync_pages_done,
     resync_items_done, resync_started_at, sweep_enqueued, updated_at)
  values
    ('ashby', p_checkpoint_key, v_token, 'idle',
     case when v_token is null then null else p_now end,
     p_now,
     case when p_full then p_now else null end,
     greatest(0, coalesce(p_pages, 0)), greatest(0, coalesce(p_items, 0)),
     null, 0, null, null, null, null, null, 0, 0, null, 0, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = v_token,
     status             = v_status,
     token_issued_at    = case when v_token is null then null else p_now end,
     last_success_at    = p_now,
     last_full_sync_at  = case when p_full then p_now
                               else screening_v2.ashby_sync_checkpoints.last_full_sync_at end,
     pages_last_run     = greatest(0, coalesce(p_pages, 0)),
     items_last_run     = greatest(0, coalesce(p_items, 0)),
     full_resync_reason = case when v_keep
                               then screening_v2.ashby_sync_checkpoints.full_resync_reason
                               else null end,
     no_progress_runs   = 0,
     -- H-4: a drained run ends its own continuation atomically. On the
     -- epoch-mismatch branch the anchor belongs to a newer generation and is
     -- left untouched.
     resync_cursor       = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.resync_cursor
                                else null end,
     resync_cursor_epoch = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.resync_cursor_epoch
                                else null end,
     resync_cursor_at    = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.resync_cursor_at
                                else null end,
     sweep_mode          = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.sweep_mode
                                else null end,
     sweep_token         = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.sweep_token
                                else null end,
     resync_pages_done   = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.resync_pages_done
                                else 0 end,
     resync_items_done   = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.resync_items_done
                                else 0 end,
     resync_started_at   = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.resync_started_at
                                else null end,
     -- A completed sweep releases its durable-work budget for the next one.
     sweep_enqueued      = case when v_keep
                                then screening_v2.ashby_sync_checkpoints.sweep_enqueued
                                else 0 end,
     updated_at          = p_now
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'id', v_id,
                            'resync_pending', v_keep);
end;
$$;

-- The 0033 seven-argument overload would otherwise remain callable and bypass
-- the lease guard entirely. Drop it: the eighth parameter has a default, so
-- every existing call site keeps working against this function unchanged.
drop function if exists screening_v2.advance_ashby_sync_checkpoint(
  text, text, integer, integer, boolean, timestamptz, bigint);

revoke all on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz, bigint, text)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz, bigint, text)
  to service_role;

comment on function screening_v2.advance_ashby_sync_checkpoint is
  'Persists a reconciliation cursor after a SUCCESSFUL run: sets the opaque '
  'sync token, stamps the 14-day expiry anchor + last_success_at, resets '
  'no_progress_runs, and ATOMICALLY ends the page-anchored full-resync '
  'continuation (cursor nulled, counters zeroed, status idle). When the '
  'caller supplies the resync_epoch it observed and that epoch has moved on, '
  'the cursor still advances but full_resync_required is PRESERVED and the '
  'newer generation''s continuation is left untouched. A caller that supplies '
  'p_owner must still hold the live single-flight lease, so a stale runner '
  'cannot install a token over another runner''s in-flight sweep. '
  'A partial/failed run '
  'never calls this — it anchors a page with save_ashby_resync_cursor '
  'instead. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. begin_ashby_sync_run — expose the continuation to the run
-- ═══════════════════════════════════════════════════════════════════════
-- Unchanged except that the returned cursor state now carries the page
-- anchor and its progress counters, so a run that acquires the lease learns
-- in the SAME call whether it is resuming a continuation and from where.

create or replace function screening_v2.begin_ashby_sync_run(
  p_checkpoint_key text,
  p_owner          text,
  p_lease_seconds  integer,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.ashby_sync_checkpoints%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 1), 3600);
  v_owner text := left(coalesce(p_owner, 'scheduler'), 128);
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;

  -- Create the row on first use so the very first run is also single-flight.
  insert into screening_v2.ashby_sync_checkpoints (provider, checkpoint_key, status)
  values ('ashby', p_checkpoint_key, 'idle')
  on conflict (provider, checkpoint_key) do nothing;

  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > p_now then
    return jsonb_build_object('status', 'locked');
  end if;

  update screening_v2.ashby_sync_checkpoints
     set lease_owner = v_owner,
         lease_expires_at = p_now + make_interval(secs => v_lease),
         updated_at = p_now
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key;

  -- `status` intentionally keeps its own meaning (idle | full_resync_required)
  -- so a pending forced resync survives the lease acquisition untouched.
  return jsonb_build_object(
    'status', 'ok',
    'lease_owner', v_owner,
    'sync_token', v_row.sync_token,
    'checkpoint_status', v_row.status,
    'token_issued_at', v_row.token_issued_at,
    'last_success_at', v_row.last_success_at,
    'no_progress_runs', v_row.no_progress_runs,
    'resync_epoch', v_row.resync_epoch,
    'resync_cursor', v_row.resync_cursor,
    'resync_cursor_epoch', v_row.resync_cursor_epoch,
    'resync_cursor_at', v_row.resync_cursor_at,
    'sweep_mode', v_row.sweep_mode,
    'sweep_restarts', v_row.sweep_restarts,
    'sweep_enqueued', v_row.sweep_enqueued,
    'sweep_halted_at', v_row.sweep_halted_at,
    'sweep_halt_reason', v_row.sweep_halt_reason,
    'resync_pages_done', v_row.resync_pages_done,
    'resync_items_done', v_row.resync_items_done
  );
end;
$$;

revoke all on function screening_v2.begin_ashby_sync_run(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.begin_ashby_sync_run(text, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.begin_ashby_sync_run is
  'Single-flight lease acquisition for one reconciliation stream. Returns '
  'locked when a live lease is held, so two schedulers (or an overlapping '
  'slow run) can never both page and both advance the cursor. Returns the '
  'opaque cursor state — sync token, resync_epoch, and the page-anchored '
  'continuation — for the caller''s sync-mode and resume decision. '
  'Service-role-only.';
