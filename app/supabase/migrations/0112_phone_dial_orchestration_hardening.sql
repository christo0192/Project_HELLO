-- =====================================================================
-- 0112 — Phone dial orchestration hardening (M009 / S01, PR-A).
--
-- FORWARD-ONLY. Three independent fixes, each in its own clearly delimited
-- block so none can interleave with another:
--
--   E1  The one-session-per-engagement UNIQUE index is narrowed to LIVE
--       sessions. 0107 made it table-wide, so a session the 0096 orphan sweep
--       expired kept its engagement's slot forever, every later createSession
--       for that engagement hit 23505, and the engagement silently dropped out
--       of the dial loop.
--   E2  The worker lease records the per-machine LiveKit agent name the
--       machine itself registered, so the API can dispatch each session's job
--       to the machine leased for it instead of to the shared pool name (which
--       let LiveKit run a call on a machine leased to a DIFFERENT session, and
--       every stop path then stopped the wrong machine mid-interview).
--   E3  A lease reclaim that restores an engagement now also holds its next
--       dial. 0096's restore wrote only the state, so the engagement was due
--       again on the very next 15 s pass and was redialled within seconds.
--
-- Nothing here writes a row (no DML, no backfill). Every function that is
-- redeclared is copied VERBATIM from the migration that last declared it and
-- patched only where the block comment says; a reviewer can diff the bodies
-- against 0079 (claim_voice_worker, reset_voice_worker) and 0096
-- (reclaim_phone_attempt_leases) and see only the stated deltas.
--
-- Re-applying this file is a no-op: every DDL statement is guarded
-- (`if exists` / `if not exists`, a catalog check around the constraint) and
-- every function is `create or replace`.
-- =====================================================================

-- Fail fast rather than queue: the E1 index swap takes an ACCESS EXCLUSIVE
-- lock on call_sessions and the E2 column add takes one on
-- voice_worker_leases, both of which live phone admission reads constantly.
-- A long wait should fail this deploy (it retries cleanly), not stall live
-- screening behind it. LOCAL: scoped to this migration's transaction, so it
-- never persists on a pooled connection (0109 precedent).
set local lock_timeout = '10s';


-- ═════════════════════════════════════════════════════════════════════
-- BLOCK E1 — one LIVE phone session per engagement (index narrowing)
-- ═════════════════════════════════════════════════════════════════════
--
-- INDEX-NARROW SANCTION (E1)
-- The 0107 engagement-claim unique index is dropped and re-created under the
-- SAME name, in this same transaction, with a status predicate added that
-- limits it to live sessions (created, waiting, in_progress). A partial
-- unique index cannot be narrowed in place, hence the drop and re-create.
-- The narrowing only REMOVES terminal rows from the index's coverage, so it
-- can never newly reject an insert the old index allowed, and the build cannot
-- fail on existing data: the old index already guaranteed at most one row per
-- engagement over a superset of these rows. The re-create follows the drop,
-- so the chain's final state still carries the index (TST-15 checks this
-- order and the exact predicate in scripts/migrate-rollback.test.mjs).
--
-- WHY THE LIVE SET IS EXACTLY created/waiting/in_progress: it must equal the
-- live precondition of bind_phone_attempt_recording_session (0107). That RPC
-- maps a unique_violation on its coalesce claim to session_engagement_race;
-- if the index covered a status the RPC treats as dead (or skipped one it
-- treats as live), the race verdict would fire for a session that cannot
-- race, or a second live session could claim the same engagement.
--
-- Terminal sessions keep their phone_engagement_id as history. Terminal
-- statuses have no outgoing edges (session-lifecycle.ts), so a row that leaves
-- the index can never re-enter it and collide with a newer live session.
--
-- The plain non-unique index keeps engagement lookups and the FK's
-- ON DELETE SET NULL scan indexed over ALL claimed rows, live or terminal,
-- now that the unique index no longer covers terminal ones.

drop index if exists screening_v2.uq_call_sessions_phone_engagement;

create unique index if not exists uq_call_sessions_phone_engagement
  on screening_v2.call_sessions (phone_engagement_id)
  where phone_engagement_id is not null and status in ('created', 'waiting', 'in_progress');

create index if not exists idx_call_sessions_phone_engagement
  on screening_v2.call_sessions (phone_engagement_id)
  where phone_engagement_id is not null;

comment on index screening_v2.uq_call_sessions_phone_engagement is
  'At most one LIVE (created/waiting/in_progress) phone session per engagement. '
  'The predicate must equal the live precondition of '
  'bind_phone_attempt_recording_session (0107), which maps a unique_violation '
  'to session_engagement_race. Terminal sessions keep their claim as history '
  'and are deliberately outside the index (0112, E1).';

comment on index screening_v2.idx_call_sessions_phone_engagement is
  'Non-unique lookup index over every claimed session, live or terminal: keeps '
  'engagement lookups and the ON DELETE SET NULL foreign-key scan indexed now '
  'that the unique index covers live statuses only (0112, E1).';

comment on column screening_v2.call_sessions.phone_engagement_id is
  'Validated phone engagement claim used to prevent arbitrary worker session '
  'cross-binding before consent; does not imply assessment start or '
  'recording-slot ownership. Uniqueness is enforced over LIVE statuses only '
  '(created/waiting/in_progress, uq_call_sessions_phone_engagement): a terminal '
  'session keeps its claim as history and does not block a new live session '
  'for the same engagement (0112).';


-- ═════════════════════════════════════════════════════════════════════
-- BLOCK E2 — the per-machine agent name a leased machine registered
-- ═════════════════════════════════════════════════════════════════════
--
-- Every phone machine used to register with LiveKit under the one shared
-- name, and the API dispatched each session's job to that name, so LiveKit
-- was free to hand session S's job to a machine leased to session T. Every
-- stop path (reaper, terminal-release, cleanupClaim, orphan sweep) judges a
-- machine by its lease's claimed_session_id, so the machine actually running
-- S's interview was stopped as soon as T's room was gone.
--
-- The fix binds the dispatch to the leased machine: a worker (behind its own
-- env flag) registers as `<base>-<FLY_MACHINE_ID>` and reports that exact name
-- in its machine-level ready post; the API stores it here and dispatches to
-- it. A NULL name means "this machine registered the shared base name", which
-- is exactly today's behaviour — so this column is inert until a worker
-- reports a name.
--
-- The name lives and dies with ONE boot of ONE claim: claim_voice_worker
-- nulls it on every NEW claim and reset_voice_worker nulls it on stop, so a
-- name the API reads always came from the boot serving the current claim and
-- never from an earlier one. The idempotent re-claim branch (same session,
-- same live lease) keeps it, because that is the same boot.

alter table screening_v2.voice_worker_leases
  add column if not exists registered_agent_name text null;

-- The format is the API's own contract (voice-worker.ts readyMachineSchema):
-- a base name, a dash, and a Fly machine id of 8-32 lowercase alphanumerics.
-- Added NOT VALID then VALIDATED, the repo's constraint convention (0107):
-- every existing row is NULL, so validation is trivial, and the separate
-- VALIDATE also re-checks the rows on a re-run. Guarded on the catalog so a
-- re-run neither fails nor drops and re-adds it (no window without the guard).
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'voice_worker_leases_registered_agent_name_format'
       and conrelid = 'screening_v2.voice_worker_leases'::regclass
  ) then
    alter table screening_v2.voice_worker_leases
      add constraint voice_worker_leases_registered_agent_name_format
      check (registered_agent_name is null
             or registered_agent_name ~ '^[A-Za-z0-9_-]{1,64}-[0-9a-z]{8,32}$')
      not valid;
  end if;
end
$$;

alter table screening_v2.voice_worker_leases
  validate constraint voice_worker_leases_registered_agent_name_format;

comment on column screening_v2.voice_worker_leases.registered_agent_name is
  'The per-machine LiveKit agent name this machine registered for its CURRENT '
  'claim, as reported by the worker''s ready post (<base>-<machine_id>). NULL '
  'means the machine registered the shared base name and the API dispatches '
  'to that (pre-0112 behaviour). Nulled on every new claim and on reset, so it '
  'can never outlive the boot that reported it (0112, E2).';

-- ── set_voice_worker_agent_name ─────────────────────────────────────
-- Records the name a starting/ready machine registered. A SEPARATE RPC rather
-- than a new parameter on mark_voice_worker_ready_machine: adding a defaulted
-- parameter to an existing function creates a second overload, and PostgREST
-- refuses to choose between ambiguous overloads.
--
-- Fail-closed:
--   * any NULL argument, a name that fails the column's format, or a name
--     whose suffix is not exactly '-' || p_machine_id -> invalid_request, and
--     nothing is written. A machine can only ever record ITS OWN name, so a
--     confused or hostile caller cannot point machine A's lease at machine
--     B's worker.
--   * only a 'starting' or 'ready' row is updated. A stopped, busy or
--     draining machine is not booting for a claim, so a late post from a
--     previous boot matches no row -> stale (the API then does not mark the
--     machine ready either, and the dial defers).

create or replace function screening_v2.set_voice_worker_agent_name(
  p_app        text,
  p_machine_id text,
  p_agent_name text,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_updated integer;
begin
  if p_app is null or p_machine_id is null or p_agent_name is null or p_now is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if p_agent_name !~ '^[A-Za-z0-9_-]{1,64}-[0-9a-z]{8,32}$' then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if right(p_agent_name, length(p_machine_id) + 1) <> '-' || p_machine_id then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set registered_agent_name = p_agent_name,
         updated_at            = p_now
   where app = p_app
     and machine_id = p_machine_id
     and state in ('starting', 'ready');
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    return jsonb_build_object('status', 'ok', 'updated', v_updated);
  end if;
  return jsonb_build_object('status', 'stale');
end;
$$;

revoke all on function screening_v2.set_voice_worker_agent_name(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_voice_worker_agent_name(text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.set_voice_worker_agent_name(text, text, text, timestamptz) is
  'Record the per-machine LiveKit agent name a starting/ready machine '
  'registered (must end in -<machine_id>). Returns {status:ok,updated} or '
  '{status:stale} when no starting/ready lease matches, or '
  '{status:invalid_request} with no write. Service-role only.';

-- ── claim_voice_worker ──────────────────────────────────────────────
-- Lifted VERBATIM from 0079. The ONLY change: the NEW-claim UPDATE also sets
-- registered_agent_name = null, so a fresh claim can never inherit the name a
-- previous boot of this machine reported. The idempotent existing-claim
-- branch is untouched: it returns the same live lease, i.e. the same boot.

create or replace function screening_v2.claim_voice_worker(
  p_app        text,
  p_pipeline   text,
  p_session_id uuid,
  p_epoch      bigint      default null,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.voice_worker_leases%rowtype;
  v_id    uuid;
begin
  if p_app is null or p_pipeline is null or p_session_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if p_pipeline not in ('phone', 'browser') then
    return jsonb_build_object('status', 'invalid_pipeline');
  end if;

  -- Idempotency: a live claim for this session on this app is returned
  -- as-is. A retried admit must never start a second machine.
  select * into v_row
    from screening_v2.voice_worker_leases
   where app = p_app
     and claimed_session_id = p_session_id
     and state in ('starting', 'ready', 'busy', 'draining')
   limit 1;
  if found then
    return jsonb_build_object(
      'status', 'claimed', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
  end if;

  -- Atomically select and lock ONE stopped machine for this app.
  --
  -- M009: LEAST-RECENTLY-STOPPED first (updated_at, then machine_id as the
  -- tie-break), no longer always the lowest machine_id. Every stop path
  -- (reaper, cleanupClaim, terminal drain) POSTs a Fly stop — which only
  -- BEGINS the stop — and resets the lease to `stopped` at once. With the
  -- phone app's kill_timeout now 300 s, the machine can still be `stopping`
  -- (draining) for minutes after its lease reads `stopped`; a start on it
  -- fails and the dial defers. Lowest-id-first handed that same draining
  -- machine to EVERY due dial while other stopped machines sat idle. Picking
  -- the row reset longest ago makes a just-stopped machine the LAST choice,
  -- and a failed start (cleanup resets it again, bumping updated_at) rotates
  -- the next claim onto another machine.
  select id into v_id
    from screening_v2.voice_worker_leases
   where app = p_app
     and pipeline = p_pipeline
     and state = 'stopped'
   order by updated_at, machine_id
   limit 1
   for update skip locked;

  if v_id is null then
    return jsonb_build_object('status', 'no_capacity');
  end if;

  update screening_v2.voice_worker_leases
     set state              = 'starting',
         claimed_session_id = p_session_id,
         epoch              = case when p_epoch is not null and p_epoch > epoch
                                   then p_epoch else epoch + 1 end,
         started_at         = p_now,
         ready_at           = null,
         last_heartbeat_at  = p_now,
         registered_agent_name = null,
         updated_at         = p_now
   where id = v_id
   returning * into v_row;

  return jsonb_build_object(
    'status', 'claimed', 'machine_id', v_row.machine_id, 'epoch', v_row.epoch);
end;
$$;

-- ── reset_voice_worker ──────────────────────────────────────────────
-- Lifted VERBATIM from 0079 (no later migration redeclares it). The ONLY
-- change: the stop UPDATE also nulls registered_agent_name, so a stopped
-- machine carries no name into its next claim.

create or replace function screening_v2.reset_voice_worker(
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
     set state              = 'stopped',
         claimed_session_id = null,
         started_at         = null,
         ready_at           = null,
         last_heartbeat_at  = null,
         registered_agent_name = null,
         updated_at         = p_now
   where app = p_app
     and machine_id = p_machine_id
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'unknown_machine');
  end if;
  return jsonb_build_object(
    'status', 'stopped', 'machine_id', v_row.machine_id);
end;
$$;

-- Same privileges as 0079 declared, re-issued verbatim so this file states
-- the full posture of every function it replaces.

revoke all on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)
  to service_role;

revoke all on function screening_v2.reset_voice_worker(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reset_voice_worker(text, text, timestamptz)
  to service_role;


-- ═════════════════════════════════════════════════════════════════════
-- BLOCK E3 — a reclaimed engagement is held before its next dial
-- ═════════════════════════════════════════════════════════════════════
--
-- reclaim_phone_attempt_leases's RESTORE branch (0096) put the engagement
-- back in its prior state and wrote nothing else. admit_phone_attempt's only
-- time gate is next_eligible_at > p_now, and the TS due-loop reads the same
-- column, so a reclaimed engagement was due again on the very next pass:
-- production shows the second dial admitted 2-26 s after each reclaim, and
-- only the two-per-IST-day cap stopped a third. A crash, a kill or a wedged
-- ring-out therefore became a burst of redials at a candidate.
--
-- The restore now also sets next_eligible_at, by the state it restores to:
--   * eligible, first dial of the IST day (initial / no_answer_retry):
--       now + phone_same_day_retry_delay() — the same spacing the no-answer
--       ladder already uses for the day's second dial.
--   * eligible otherwise (the day's second dial): the next IST day's window
--       open — the exact expression 0095's apply_phone_event uses for an
--       abandoned pre-disclosure leg.
--   * scheduled: now + 15 minutes. The candidate asked for this slot, so the
--       hold is short (it matches the stranded-session grace), and the day cap
--       still applies.
--   * reconnecting: untouched. The reconnect backoff lives in the TS clock.
-- greatest() keeps a later hold that was already on the row. No budget is
-- charged (the 0042 principle: a reclaim is our failure, not the
-- candidate's), and the scored-session branch is not held — it completes the
-- engagement instead of restoring it.
--
-- Lifted VERBATIM from 0096 (no migration 0097-0111 redeclares it). The only
-- deltas: the v_redial_at declaration, its computation and the extra SET
-- line in the RESTORE branch, and the 'redial_not_before' audit key. The
-- grace predicates, the engagement-before-attempt SKIP LOCKED order, the
-- scored-session branch, the 0071 session terminalize, the other audit keys
-- and the privileges are byte-identical. admit_phone_attempt is NOT
-- redeclared.

create or replace function screening_v2.reclaim_phone_attempt_leases(
  p_limit integer     default 50,
  p_now   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row       record;
  v_att       screening_v2.phone_call_attempts%rowtype;
  v_eng_id    uuid;
  v_restored  integer;
  v_jobs      integer;
  v_count     integer := 0;
  v_finalized integer;
  v_redial_at timestamptz;
  v_limit    constant integer := greatest(1, least(coalesce(p_limit, 50), 500));
begin
  for v_row in
    select id, engagement_id, answered_at
      from screening_v2.phone_call_attempts
     where state in ('admitted','ringing','answered_unclassified','human','machine')
       and lease_expires_at is not null
       -- ── A CONNECTED CALL IS NOT A DEAD LEG ──────────────────────────
       -- RCA 2026-09-10. `'human'` — a consented, talking candidate — sat in
       -- the same IN-list as `'admitted'`, with ZERO grace and no liveness
       -- check of any kind, so this sweep abandoned two live conversations at
       -- `lease_expires_at <= p_now`. It does not hang up: the room and the
       -- SIP leg carry on, the candidate keeps talking to a bot whose attempt
       -- the database has already written off and whose engagement has been
       -- rolled back to `eligible`. Whatever that leg goes on to score is then
       -- ignored, because `assessment.completed` is gated on `in_call`.
       --
       -- A leg that ANSWERED now gets one extra grace period before it can be
       -- taken. Legs that never answered are untouched — a ringing phone that
       -- stops heartbeating should still be reclaimed promptly, because its
       -- fleet slot is holding up somebody else's call.
       --
       -- This is a delay, not an exemption: a genuinely dead worker still
       -- loses its slot, one grace later. The sibling worker reaper already
       -- cross-checks LiveKit room liveness before stopping a machine; this
       -- sweep has no such signal available in SQL, so bounded extra patience
       -- is the honest substitute.
       and lease_expires_at <=
             p_now - case
                       when answered_at is null then interval '0 seconds'
                       -- VOICEMAIL GETS NO GRACE. The grace protects a
                       -- CONVERSATION; `machine` is a classified answering
                       -- machine, with nobody to protect and a fleet slot that
                       -- another candidate is waiting for. `answered_at` is
                       -- stamped on the answered_unclassified transition
                       -- regardless of who picked up, so without this the
                       -- grace would hold a slot two extra minutes for every
                       -- voicemail in a burst — at a cap of ten, that is real.
                       when state = 'machine' then interval '0 seconds'
                       else screening_v2.phone_answered_reclaim_grace()
                     end
     order by lease_expires_at asc
     limit v_limit
  loop
    select id into v_eng_id
      from screening_v2.phone_engagements
     where id = v_row.engagement_id
     for update skip locked;
    if not found then
      continue;
    end if;

    select * into v_att
      from screening_v2.phone_call_attempts
     where id = v_row.id
       and state in ('admitted','ringing','answered_unclassified','human','machine')
       and lease_expires_at is not null
       -- The SAME predicate as the scan above, re-evaluated under the lock.
       -- The scan is unlocked, so a leg can be answered (or heartbeaten)
       -- between the two — and without repeating the grace here, a call that
       -- became live in that window would still be abandoned.
       and lease_expires_at <=
             p_now - case
                       when answered_at is null then interval '0 seconds'
                       -- VOICEMAIL GETS NO GRACE. The grace protects a
                       -- CONVERSATION; `machine` is a classified answering
                       -- machine, with nobody to protect and a fleet slot that
                       -- another candidate is waiting for. `answered_at` is
                       -- stamped on the answered_unclassified transition
                       -- regardless of who picked up, so without this the
                       -- grace would hold a slot two extra minutes for every
                       -- voicemail in a burst — at a cap of ten, that is real.
                       when state = 'machine' then interval '0 seconds'
                       else screening_v2.phone_answered_reclaim_grace()
                     end
     for update skip locked;
    if not found then
      continue;
    end if;

    update screening_v2.phone_call_attempts
       set state         = 'abandoned',
           outcome_class = null,
           lease_token   = null,
           lease_owner   = null,
           ended_at      = p_now
     where id = v_att.id;

    update screening_v2.job_queue
       set status       = 'completed',
           completed_at = p_now
     where name = 'phone.dial'
       and dedup_key = 'phone.dial:' || v_att.id::text
       and status in ('pending', 'delayed');
    get diagnostics v_jobs = row_count;

    if exists (
      select 1
        from screening_v2.call_sessions s
       where s.id = v_att.session_id
         and s.status = 'completed'
         and exists (
           select 1 from screening_v2.assessments a
            where a.session_id = s.id and a.source = 'phone'
         )
    ) then
      perform screening_v2.apply_phone_event(
        p_source            => 'internal',
        p_event_type        => 'assessment.completed',
        p_attempt_id        => null,
        p_engagement_id     => v_att.engagement_id,
        p_provider_event_id => 'reclaim:assessment.completed:' || v_att.session_id::text,
        p_epoch             => null,
        p_metadata          => null,
        p_now               => p_now
      );
      v_restored := 0;
    else
      -- ── 0112 / E3: HOLD THE NEXT DIAL ───────────────────────────────
      -- Without this the restored engagement is due on the very next pass
      -- (next_eligible_at is the only admission time gate) and is redialled
      -- within seconds. Computed from the attempt being reclaimed, before
      -- the restore, so it reflects the state the engagement returns to.
      -- 'reconnecting' (and anything unforeseen) yields null: untouched.
      v_redial_at := case
        when v_att.prior_engagement_state = 'eligible'
             and v_att.ist_day_seq = 1
             and v_att.kind in ('initial', 'no_answer_retry')
          then p_now + screening_v2.phone_same_day_retry_delay()
        when v_att.prior_engagement_state = 'eligible'
          then screening_v2.phone_next_window_open(
                 (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                   at time zone 'Asia/Kolkata')
        when v_att.prior_engagement_state = 'scheduled'
          then p_now + interval '15 minutes'
        else null
      end;

      update screening_v2.phone_engagements
         set state        = v_att.prior_engagement_state,
             state_reason = 'lease_reclaimed',
             -- greatest(): never pull an existing, later hold forward.
             next_eligible_at = case when v_redial_at is null then next_eligible_at
                                     else greatest(coalesce(next_eligible_at, p_now), v_redial_at) end,
             version      = version + 1,
             updated_at   = p_now
       where id = v_att.engagement_id
         and terminal_at is null
         and state in ('dialing', 'in_call');
      get diagnostics v_restored = row_count;

      -- ── 0071 / X5a: DRIVE A CRASHED SESSION TERMINAL SO ITS ─────────
      -- ── RECORDING CAN FINALIZE ──────────────────────────────────────
      -- We are in the RESTORE branch: this reclaim is ENDING the
      -- conversation's lease (no completed+scored screening won above). A
      -- worker crash posts no terminal session status, so the session sits
      -- `in_progress` with a live egress and no object key, and the 0038
      -- finalize trigger — which fires only on a terminal transition — never
      -- runs. Drive it to `expired`/`grace_timeout` (a valid `in_progress ->
      -- expired` edge, 0006 §9) ONLY when the stuck-recording shape is
      -- present, so a session with no egress or an already-finalized one is
      -- left untouched. The transition fires trg_enqueue_recording_finalize
      -- (0038) in THIS transaction and the finalize job is enqueued. Charges
      -- no budget: terminalizing a session is not a dial attempt.
      --
      -- Guarded on the SAME stuck shape the 0038 sweeper index enumerates
      -- (egress id present, object key null, egress status 'active', not
      -- deleted/revoked/quarantined) plus the terminal-reason coherence the
      -- 0006 CHECK requires. `for update skip locked` so this never blocks a
      -- concurrent live completion of the same session.
      update screening_v2.call_sessions s
         set status          = 'expired',
             terminal_reason = 'grace_timeout',
             ended_at        = coalesce(s.ended_at, p_now),
             updated_at      = p_now
       where s.id = v_att.session_id
         and s.status = 'in_progress'
         and s.recording_egress_id is not null
         and s.recording_object_key is null
         and s.recording_egress_status = 'active'
         and s.recording_deleted_at is null
         and s.recording_revoked_at is null
         and coalesce(s.recording_quarantined, false) = false;
      get diagnostics v_finalized = row_count;
    end if;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_attempt_ended', 'phone_call_attempt', v_att.id::text, 'success',
       jsonb_build_object('engagement_id', v_att.engagement_id,
                          'attempt_seq', v_att.attempt_seq,
                          'attempt_state', 'abandoned',
                          'reason', 'lease_reclaimed',
                          -- Whether this leg had a human on it, and so which
                          -- grace it was held under. An operator reading a
                          -- reclaim needs to tell "a phone that never answered
                          -- stopped heartbeating" from "a conversation was
                          -- taken away", and the two want different responses.
                          'answered', v_att.answered_at is not null,
                          'budget_charged', false,
                          'restored', v_restored > 0,
                          'restored_state',
                          case when v_restored > 0
                               then v_att.prior_engagement_state else null end,
                          -- 0112 / E3: the hold this reclaim computed. Null on
                          -- the scored branch and on a no-op restore (the
                          -- engagement was not restored), and for a
                          -- 'reconnecting' restore, which is not held. It is
                          -- the computed hold, not the stored column: a later
                          -- hold already on the row wins via greatest().
                          'redial_not_before',
                          case when v_restored > 0 then v_redial_at end,
                          'dial_jobs_completed', v_jobs,
                          -- 0071 / X5a: read from the UPDATE's own row count,
                          -- so an operator sees exactly when a reclaim also
                          -- terminalized a crashed session for finalization.
                          'session_finalize_terminalized',
                          coalesce(v_finalized, 0) > 0));

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('status', 'ok', 'reclaimed', v_count, 'limit', v_limit);
end;
$$;

revoke all on function screening_v2.reclaim_phone_attempt_leases(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.reclaim_phone_attempt_leases(integer, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
