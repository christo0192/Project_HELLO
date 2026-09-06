-- =====================================================================
-- 0083 — Voice-worker terminal release + infra-defer daily-cap relief.
--
-- FORWARD-ONLY and ADDITIVE. Adds three service-role RPCs, ADDS one nullable
-- column (phone_call_attempts.abandon_reason), RE-CREATES exactly one partial
-- index (uq_phone_attempts_one_per_ist_day) to narrow its predicate, and
-- RE-DEFINES `admit_phone_attempt` to narrow its two daily-cap pre-checks in
-- lock-step with that index. It drops no table, drops no column, and leaves
-- the ROW DATA of every table byte-identical (the new column is NULL on every
-- pre-existing row). 0001-0082 keep their function bodies except that one
-- `create or replace function admit_phone_attempt` — whose ONLY delta from the
-- 0057 body is the two narrowed exists-clauses (documented at its definition);
-- every other line is copied byte-for-byte. The only pre-existing index changed
-- is that one, and the change only REMOVES rows from its coverage (a strictly
-- wider set of admissions is now permitted, never a narrower one), so no
-- existing row can newly violate it.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────
-- 0079/0080 shipped the lease substrate and the ensure/claim/ready path,
-- but two loose ends make on-demand orchestration UNSAFE to activate:
--
--   1. TERMINAL RELEASE. A dial that succeeds carries a `machineId` out of
--      the controller, but nothing consumes it: no terminal path calls
--      `release_voice_worker`, so a claimed machine sits `busy`/`ready`
--      until the reaper's grace window. The reaper IS the eventual backstop
--      (it stops any non-stopped machine whose LiveKit room is dead past
--      grace), but a PROMPT release returns the pool slot in seconds rather
--      than one grace window — the difference between a pool that recycles
--      and a pool that exhausts under load. The machine<->session map
--      already lives in this table (`claimed_session_id` is bound at claim),
--      so release needs NO new column and NO durable machineId: it is
--      re-derivable from the session id alone, which is restart-safe (a new
--      process that never saw the dial can still release by session).
--      `release_voice_worker_by_session` and `list_terminal_session_leases`
--      are the two RPCs the prompt-release pass uses.
--
--   2. INFRA-DEFER DAILY-CAP RELIEF. `admit_phone_attempt` commits the
--      attempt row (and thus the per-IST-day index entry) BEFORE the
--      worker-ready gate runs. When that gate defers (`worker_not_ready` —
--      pre-originate, NO carrier contacted), the attempt is left `admitted`
--      and the per-IST-day index (and admission's own daily pre-checks) still
--      count it, so the engagement is wedged at `daily_attempt_exists` until
--      IST midnight — a full day lost to an infrastructure hiccup that never
--      reached the candidate.
--
--      This is the MIRROR OF — and must be carefully distinguished from — the
--      reclaim case. Both `reclaim_phone_attempt_leases` (0071 lineage) and
--      this migration's `abandon_phone_attempt_infra` write `state='abandoned'`.
--      But reclaim abandons a lease that EXPIRED from a live-ish state
--      (admitted/ringing/answered_unclassified/human/machine): the call may
--      have RUNG or been ANSWERED and a worker then crashed mid-call, so the
--      anti-harassment budget is SPENT and the day must STAY CHARGED — reclaim's
--      own comment says so ("re-dialled the NEXT IST day"). An infra defer
--      provably touched no carrier. So the two `abandoned` populations are NOT
--      interchangeable, and a predicate keyed on `state='abandoned'` ALONE
--      (an earlier draft of this migration) would WRONGLY free reclaim-abandoned
--      answered calls to redial the same day.
--
--      The discriminator is a DEDICATED, machine-readable marker on the ATTEMPT
--      row: a new nullable column `phone_call_attempts.abandon_reason`, stamped
--      `'infra_deferred'` by `abandon_phone_attempt_infra` and LEFT NULL by
--      reclaim (reclaim never touches this column). `state_reason` was NOT
--      reused: it does not exist on `phone_call_attempts` at all — reclaim and
--      infra-abandon both stamp `state_reason` on the ENGAGEMENT row, never on
--      the attempt — so a new attempt column is the only place a per-attempt
--      abandon cause can live unambiguously and un-overwritten. The narrowed
--      index AND both of admission's daily pre-checks exclude ONLY
--      `(state='abandoned' AND abandon_reason='infra_deferred')`; reclaim-
--      abandoned rows (abandon_reason NULL) stay counted and stay charged.
--      `abandon_phone_attempt_infra` abandons such an attempt, stamps the marker,
--      backs the engagement off by a bounded `next_eligible_at` bump (P3, so a
--      persistently-broken pool defers once per backoff window rather than
--      churning every due tick), AND the narrowed index + pre-checks let the
--      SAME engagement redial the SAME IST day once the backoff elapses.
--
-- ── DEFAULT-INERT ─────────────────────────────────────────────────────
-- With `WORKER_ORCHESTRATION=false` (the shipped default) nothing calls the
-- two release RPCs (there are no lease rows and no gate), and
-- `abandon_phone_attempt_infra` is only ever called on the `worker_not_ready`
-- refusal, which is itself unreachable when the gate is absent. The index
-- change is a pure WIDENING of what admission permits and is safe on any
-- deployment. So a deploy of this migration with the flag off changes no
-- behaviour whatsoever.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. release_voice_worker_by_session — the terminal-release choke point
-- ═══════════════════════════════════════════════════════════════════════
-- Release the lease a session holds, addressed by SESSION rather than by
-- machine. This is the restart-safe half of terminal release: a terminal
-- handler (or a periodic terminal-session sweep) knows the session id but
-- may never have seen the `machineId` the dial returned — the process that
-- placed the dial may be gone. The (app, claimed_session_id) pair is unique
-- among live claims (uq_voice_worker_leases_one_active), so this resolves at
-- most one machine.
--
-- Sets the lease 'draining' (the same edge `release_voice_worker` sets), so
-- the caller then stops the Fly machine and calls `reset_voice_worker`. It
-- does NOT stop the machine itself — this migration has no Fly client. It is
-- EPOCH-FREE and MACHINE-ID-FREE on purpose: the caller has neither, and the
-- session<->machine map is already a bijection over live claims, so binding
-- by session is unambiguous. Idempotent: a session that holds no live claim
-- (already released, or the reaper won) returns 'already_released' rather
-- than erroring, so a duplicate terminal never fails and never resurrects a
-- claim — the PR#68 lesson (never terminate the winner's room) holds because
-- a re-claimed session carries a NEW machine bound to the SAME session id, so
-- releasing "by session" still releases only the claim that currently owns it.

create or replace function screening_v2.release_voice_worker_by_session(
  p_app        text,
  p_session_id uuid,
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
  if p_app is null or p_session_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  update screening_v2.voice_worker_leases
     set state      = 'draining',
         updated_at = p_now
   where app = p_app
     and claimed_session_id = p_session_id
     and state in ('starting', 'ready', 'busy', 'draining')
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'already_released');
  end if;
  return jsonb_build_object(
    'status', 'draining',
    'machine_id', v_row.machine_id,
    'epoch', v_row.epoch);
end;
$$;

revoke all on function screening_v2.release_voice_worker_by_session(text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.release_voice_worker_by_session(text, uuid, timestamptz)
  to service_role;

comment on function screening_v2.release_voice_worker_by_session(text, uuid, timestamptz) is
  'Terminal-release choke point: drains the live lease bound to a session, '
  'addressed by session id (restart-safe — no machine id or epoch needed). '
  'Returns {status:draining,machine_id,epoch} so the caller can stop+reset '
  'the exact machine, or {status:already_released}. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. list_terminal_session_leases — the prompt-release candidate list
-- ═══════════════════════════════════════════════════════════════════════
-- Surfaces LIVE leases whose bound call_session has already gone TERMINAL.
-- This is the universal terminal signal for the prompt-release pass: EVERY
-- terminal path a call reaches — webhook completion, reconciliation, the
-- assessment completion, the partial-finalize sweep, lease reclaim, a worker
-- crash the recstrand sweep drives to `expired` — eventually drives the bound
-- `call_sessions` row to a terminal status. So a lease still `starting`/
-- `ready`/`busy`/`draining` pointing at a terminal session is a machine whose
-- work is provably done and whose slot can be returned NOW rather than at the
-- reaper's grace window. Read-only: the pass releases each returned lease via
-- `release_voice_worker_by_session`, then stops+resets the machine. Bounded by
-- p_limit. Service-role only.
--
-- The join is on `claimed_session_id = call_sessions.id`; a lease whose
-- session row is missing (deleted) is NOT returned — the reaper's LiveKit
-- liveness backstop covers that residual, and inventing a terminal from an
-- absent row would risk reaping a live call whose session write is in flight.

create or replace function screening_v2.list_terminal_session_leases(
  p_app   text,
  p_limit integer default 50
)
returns table (
  machine_id         text,
  claimed_session_id uuid,
  state              text,
  epoch              bigint
)
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  select l.machine_id, l.claimed_session_id, l.state, l.epoch
    from screening_v2.voice_worker_leases l
    join screening_v2.call_sessions s
      on s.id = l.claimed_session_id
   where l.app = p_app
     and l.state in ('starting', 'ready', 'busy', 'draining')
     and s.status in ('completed', 'failed', 'cancelled', 'expired')
   order by s.updated_at asc
   limit greatest(1, least(coalesce(p_limit, 50), 500));
$$;

revoke all on function screening_v2.list_terminal_session_leases(text, integer)
  from public, anon, authenticated;
grant execute on function screening_v2.list_terminal_session_leases(text, integer)
  to service_role;

comment on function screening_v2.list_terminal_session_leases(text, integer) is
  'Prompt-release candidate list: live leases whose bound call_session is '
  'already terminal. The universal terminal signal — every terminal path '
  'drives the session terminal. Read-only; the caller releases + stops each. '
  'Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3a. abandon_reason — the per-attempt discriminator for infra defers
-- ═══════════════════════════════════════════════════════════════════════
-- A dedicated, machine-readable marker on the ATTEMPT row that distinguishes
-- an infra-deferred abandonment (this migration) from a lease-reclaimed one
-- (0071 lineage). Additive, nullable, NULL on every pre-existing row and on
-- every reclaim-abandoned row — reclaim never writes it. Only
-- `abandon_phone_attempt_infra` sets it, to `'infra_deferred'`. The narrowed
-- index (3b) and admission's daily pre-checks key their exclusion on this
-- column, so a reclaim-abandoned answered call (marker NULL) stays counted and
-- stays charged, while a pre-originate infra defer (marker 'infra_deferred') is
-- excluded and redialable the same IST day. `state_reason` was NOT reused: it
-- has no counterpart on this table (both abandon paths stamp it on the
-- ENGAGEMENT), so a per-attempt cause needs its own column.
alter table screening_v2.phone_call_attempts
  add column if not exists abandon_reason text;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_abandon_reason;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_abandon_reason
  check (abandon_reason is null or abandon_reason in ('infra_deferred'));

comment on column screening_v2.phone_call_attempts.abandon_reason is
  '0083: per-attempt abandonment cause. NULL for a live/ended attempt and for '
  'a lease-reclaimed abandonment (0071 — day stays charged). Set to '
  '''infra_deferred'' ONLY by abandon_phone_attempt_infra (pre-originate '
  'worker_not_ready defer, no carrier contacted). The narrowed per-IST-day '
  'index and admission''s daily pre-checks exclude exactly '
  '(state=''abandoned'' and abandon_reason=''infra_deferred'').';

-- ═══════════════════════════════════════════════════════════════════════
-- 3b. Narrow uq_phone_attempts_one_per_ist_day to CHARGED attempts only
-- ═══════════════════════════════════════════════════════════════════════
-- I5 was "one no-answer-class attempt per engagement per IST day", counting
-- the row's mere EXISTENCE regardless of state. That is right for an attempt
-- that reached (or may have reached) the carrier: the anti-harassment budget
-- is spent whether or not the candidate answered. It is WRONG for an attempt
-- abandoned BEFORE any carrier contact — a pre-originate infrastructure defer
-- (`worker_not_ready`) never rang the phone, so charging the day against it
-- wedges the engagement until IST midnight for a hiccup the candidate never
-- experienced.
--
-- The fix narrows the predicate to EXCLUDE ONLY infra-deferred abandonments,
-- keyed on the dedicated marker `(state='abandoned' and
-- abandon_reason='infra_deferred')`. It deliberately does NOT exclude every
-- `abandoned` row. A lease-RECLAIMED abandonment (0071
-- `reclaim_phone_attempt_leases`, abandon_reason NULL) abandons an attempt that
-- was `admitted/ringing/answered_unclassified/human/machine` when its lease
-- expired — a call that RANG or was ANSWERED and whose worker then crashed
-- mid-call. That day is SPENT (the candidate already got a call), so a
-- reclaim-abandoned row must STAY in the index and keep charging the day; only
-- the pre-originate infra defer, which provably touched no carrier, is freed.
-- A COMPLETED/answered attempt lands in state `ended`, which the predicate
-- still counts, so a real call still holds the day.
--
-- Sanctioned pattern: drop-if-exists then re-create. A partial UNIQUE index
-- cannot be "narrowed in place"; the drop removes strictly more rows from
-- coverage, so no window during the swap can reject an admission that the
-- old index would have allowed. The DROP is immediately followed by a
-- CREATE ... IF NOT EXISTS of the SAME index name in this SAME migration, so
-- the chain's final state still carries the index — the migrate-rollback gate
-- recognises this as the one sanctioned index-narrowing, migration-local and
-- name-scoped; every other DROP INDEX stays RED.
--   INDEX-NARROW SANCTION: uq_phone_attempts_one_per_ist_day is dropped and
--   re-created below in this same migration; the new predicate is a strict
--   subset of the old (it only ADDS the `not (state='abandoned' and
--   abandon_reason='infra_deferred')` conjunct), so coverage only shrinks
--   (never rejects a new admit the old index allowed).

drop index if exists screening_v2.uq_phone_attempts_one_per_ist_day;

create unique index if not exists uq_phone_attempts_one_per_ist_day
  on screening_v2.phone_call_attempts(engagement_id, ist_date)
  where kind in ('initial','no_answer_retry','scheduled')
    and not (state = 'abandoned' and abandon_reason = 'infra_deferred');

comment on index screening_v2.uq_phone_attempts_one_per_ist_day is
  'I5 (0083-narrowed): one CHARGED no-answer-class attempt per engagement '
  'per IST day. ONLY an infra-deferred abandonment (state=abandoned AND '
  'abandon_reason=infra_deferred) is excluded, so a pre-originate '
  'worker_not_ready defer can redial the SAME IST day; a lease-RECLAIMED '
  'abandonment (abandon_reason NULL — call rang/answered) and a completed '
  'attempt (state=ended) both still hold the day.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. abandon_phone_attempt_infra — same-day-retryable infra abandonment
-- ═══════════════════════════════════════════════════════════════════════
-- Called by the dial controller when a POST-ADMISSION, PRE-ORIGINATE gate
-- defers a dial that provably contacted NO carrier (`worker_not_ready`). It
-- abandons the attempt (transition #30 shape) and restores the engagement to
-- `prior_engagement_state`, exactly like `reclaim_phone_attempt_leases`, but
-- WITHOUT waiting for the lease to expire — the recovery is immediate. Paired
-- with the narrowed index above, the SAME engagement is redialable the SAME
-- IST day. CHARGES NO BUDGET (an infra defer is our failure, not the
-- candidate's attempt), and completes the attempt's pending dial job in the
-- same transaction so the queue keeps no orphan.
--
-- Scoped to the attempt id, and re-verified under the engagement lock in the
-- pinned suffix order (engagement -> attempt) so it can never deadlock with
-- admission. Idempotent: an attempt already terminal (ended/abandoned) is a
-- no-op success — a duplicate refusal never double-restores.
--
-- ── P3: BOUNDED BACKOFF ON A PERSISTENTLY-BROKEN POOL ─────────────────
-- Once same-day redial works, a pool that is empty / flag-off / boots slower
-- than the ready timeout would churn admit -> start -> wait -> stop -> abandon
-- -> redial on EVERY due tick, because the restored engagement is immediately
-- due again. So the restore also pushes `next_eligible_at` forward by a bounded
-- backoff (`p_backoff_seconds`, clamped [60,3600]). The ordinary due read
-- (`readDueBatch`/`dueClockPredicate`) filters eligible-state engagements on
-- `next_eligible_at` (null or <= now), so an engagement backed off into the
-- future is simply not returned until the backoff elapses — one infra-defer per
-- window instead of one per tick. The bump is `greatest(now, next_eligible_at)
-- + backoff` so a longer existing backoff is never SHORTENED. `scheduled`/
-- `reconnecting` restores also get the bump; it never harms them (their due
-- gates are additional, not weaker) and keeps the single restore path simple.

create or replace function screening_v2.abandon_phone_attempt_infra(
  p_attempt_id     uuid,
  p_backoff_seconds integer     default 300,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att      screening_v2.phone_call_attempts%rowtype;
  v_eng_id   uuid;
  v_restored integer;
  v_jobs     integer;
  v_backoff  integer;
begin
  if p_attempt_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  -- Clamp the backoff defensively in SQL: the app clamps too, but the RPC is
  -- service-role callable directly and must not trust its input. [60,3600].
  v_backoff := greatest(60, least(coalesce(p_backoff_seconds, 300), 3600));

  -- Peek at the attempt (unlocked) to find its engagement, then take the
  -- ENGAGEMENT lock first (pinned suffix of the admission order), then
  -- re-verify the attempt under that lock. Mirrors reclaim's lock discipline.
  select engagement_id into v_eng_id
    from screening_v2.phone_call_attempts
   where id = p_attempt_id;
  if not found then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  perform 1
    from screening_v2.phone_engagements
   where id = v_eng_id
   for update;

  select * into v_att
    from screening_v2.phone_call_attempts
   where id = p_attempt_id
     and state in ('admitted','ringing','answered_unclassified','human','machine')
   for update;
  if not found then
    -- Already terminal (a duplicate refusal, or the reclaimer won): a no-op
    -- success, never a double-restore.
    return jsonb_build_object('status', 'already_ended');
  end if;

  update screening_v2.phone_call_attempts
     set state         = 'abandoned',
         -- The DEDICATED discriminator: this abandonment is an infra defer, not
         -- a lease reclaim. The narrowed per-IST-day index and admission's two
         -- daily pre-checks exclude exactly this (state='abandoned' AND
         -- abandon_reason='infra_deferred') pair, so ONLY this row — never a
         -- reclaim-abandoned answered call — frees the same-day redial.
         abandon_reason = 'infra_deferred',
         outcome_class = null,
         lease_token   = null,
         lease_owner   = null,
         ended_at      = p_now
   where id = v_att.id;

  -- Complete the attempt's pending/delayed dial job so no orphan lingers.
  update screening_v2.job_queue
     set status       = 'completed',
         completed_at = p_now
   where name = 'phone.dial'
     and dedup_key = 'phone.dial:' || v_att.id::text
     and status in ('pending', 'delayed');
  get diagnostics v_jobs = row_count;

  -- Restore the engagement to the state it was admitted from — transition
  -- #30, the same restore reclaim performs. `worker_not_ready` gates BEFORE
  -- disclosure, so the engagement is `dialing` here; `in_call` is included
  -- for symmetry with reclaim (a defensive superset that costs nothing).
  --
  -- P3: push `next_eligible_at` forward by the clamped backoff so a
  -- persistently-broken pool defers once per window, not once per tick. The
  -- bump is `greatest(now, next_eligible_at) + backoff` so it never SHORTENS a
  -- longer existing backoff. The due read filters eligible engagements on
  -- `next_eligible_at`, so this suppresses the immediate re-admit that would
  -- otherwise churn.
  update screening_v2.phone_engagements
     set state           = v_att.prior_engagement_state,
         state_reason    = 'infra_deferred',
         next_eligible_at = greatest(p_now, coalesce(next_eligible_at, p_now))
                            + (v_backoff * interval '1 second'),
         version         = version + 1,
         updated_at      = p_now
   where id = v_att.engagement_id
     and terminal_at is null
     and state in ('dialing', 'in_call');
  get diagnostics v_restored = row_count;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_attempt_ended', 'phone_call_attempt', v_att.id::text, 'success',
     jsonb_build_object('engagement_id', v_att.engagement_id,
                        'attempt_seq', v_att.attempt_seq,
                        'attempt_state', 'abandoned',
                        'reason', 'infra_deferred',
                        'budget_charged', false,
                        'restored', v_restored > 0,
                        'restored_state',
                        case when v_restored > 0
                             then v_att.prior_engagement_state else null end,
                        'dial_jobs_completed', v_jobs,
                        -- P3: the backoff actually applied (post-clamp), so an
                        -- operator can see how long the engagement was deferred.
                        'backoff_seconds',
                        case when v_restored > 0 then v_backoff else null end));

  return jsonb_build_object(
    'status', 'abandoned',
    'restored', v_restored > 0,
    'backoff_seconds', case when v_restored > 0 then v_backoff else null end,
    'engagement_id', v_att.engagement_id);
end;
$$;

-- The 0083 first draft shipped a 2-arg (uuid, timestamptz) overload. P3 adds a
-- backoff argument, changing the signature to (uuid, integer, timestamptz). Drop
-- the superseded overload guardedly so no orphan/ambiguous function remains;
-- the DROP FUNCTION IF EXISTS is the sanctioned replaceable pattern and the new
-- definition above is the sole survivor.
drop function if exists screening_v2.abandon_phone_attempt_infra(uuid, timestamptz);

revoke all on function screening_v2.abandon_phone_attempt_infra(uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.abandon_phone_attempt_infra(uuid, integer, timestamptz)
  to service_role;

comment on function screening_v2.abandon_phone_attempt_infra(uuid, integer, timestamptz) is
  'Immediately abandon a post-admission, pre-originate attempt (worker_not_ready '
  'defer) and restore the engagement to its prior state — transition #30 without '
  'waiting for the lease to expire. Stamps abandon_reason=infra_deferred on the '
  'attempt (the discriminator the narrowed per-IST-day index and admission daily '
  'pre-checks key their exclusion on) and pushes next_eligible_at forward by a '
  'clamped [60,3600]s backoff so a broken pool defers once per window not per '
  'tick. CHARGES NO BUDGET. Same engagement redials the same IST day once the '
  'backoff elapses. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Re-define admit_phone_attempt with the two daily pre-checks narrowed
-- ═══════════════════════════════════════════════════════════════════════
-- P1: the 0083 index narrowing (section 3b) governs only the INSERT-conflict
-- path. `admit_phone_attempt` ALSO carries two SELECT pre-checks that count
-- same-day attempts BEFORE the insert (engagement-level and candidate-level),
-- and those still counted the infra-deferred row — so the index fix alone was
-- INERT: admission returned `daily_attempt_exists` (or
-- `candidate_daily_attempt_exists`) before the insert was ever attempted, and
-- the engagement stayed wedged until IST midnight.
--
-- This is the LATEST admit_phone_attempt body (0057, the owner of the live
-- definition; 0045/0042 are earlier) copied BYTE-FOR-BYTE, with the ONLY delta
-- being the two exists-clauses: each now excludes exactly
-- (state='abandoned' AND abandon_reason='infra_deferred'), the same predicate
-- the narrowed index uses, so the SELECT pre-checks and the INSERT-conflict
-- path agree. Both deltas are marked inline with "0083 DELTA". Every other line
-- — the advisory locks, the consent/suppression/halt/window gates, the fleet
-- cap, the attempt+lease+job transaction and its audit — is unchanged from
-- 0057. `create or replace` keeps the same (uuid,text,text,integer,timestamptz)
-- signature, so no grant/overload changes are needed beyond re-asserting them.
create or replace function screening_v2.admit_phone_attempt(
  p_engagement_id uuid,
  p_kind          text,
  p_lease_owner   text        default null,
  p_lease_seconds integer     default 60,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link_id        uuid;
  v_eng            screening_v2.phone_engagements%rowtype;
  v_link           screening_v2.ashby_application_links%rowtype;
  v_map            screening_v2.ashby_job_mappings%rowtype;
  v_ing_state      text;
  v_consent        screening_v2.consent_records%rowtype;
  v_required       screening_v2.consent_type[];
  v_phone          text;
  v_phone_valid    boolean;
  v_digest         text;
  v_ctl_found      boolean;
  v_halted_at      timestamptz;
  v_live           integer;
  v_seq            integer;
  v_attempt_id     uuid;
  v_lease_token    uuid;
  v_lease_expires  timestamptz;
  v_ist_date       date;
  v_job_id         uuid;
  v_dedup_key      text;
  v_constraint     text;
  v_apt_id         uuid;
  v_max_concurrent constant integer := screening_v2.phone_max_concurrent();
  v_queue_name     constant text    := 'phone.dial';
  v_job_max_attempts constant integer := 5;
begin
  -- ── LOCK 1: the global admission serialiser, FIRST statement ───────
  -- Before any `select ... for update`. The inverse order deadlocks with
  -- two concurrent admissions; see the file header.
  perform pg_advisory_xact_lock(hashtext('phone_admission'));

  -- ── LOCK 1b (0045): the CANDIDATE serialiser ───────────────────────
  -- Taken immediately after the global one and before any row lock, so
  -- the pinned order is preserved and the pair can never deadlock: no two
  -- admissions hold lock 1 at once, so lock 1b is never contended today.
  --
  -- It is taken anyway, and deliberately. The per-candidate guard below
  -- is a read-then-decide, and its atomicity currently rests ENTIRELY on
  -- the global serialiser. Narrowing that serialiser for throughput is an
  -- obvious future optimisation, and if it happens this guard must not
  -- silently lose the atomicity it depends on. One advisory lock is the
  -- cost of making that safe to do later.
  --
  -- Keyed by the CANDIDATE, resolved before the engagement row is read,
  -- because the whole point of the guard is that one person may hold more
  -- than one engagement.
  -- The two-int4 form. `hashtext` returns int4; `hashtextextended` returns
  -- int8 and narrowing it would risk an overflow on a value chosen by no
  -- one. The classifier half is a constant, so this lock can never collide
  -- with `hashtext('phone_admission')` on a different key space.
  --
  -- The candidate id comes from an UNLOCKED read, exactly like the
  -- `application_link_id` read a few lines below: it takes no row lock, so
  -- the pinned order still holds. An engagement that does not exist hashes
  -- the empty string and is refused by `not_found` moments later.
  perform pg_advisory_xact_lock(
    hashtext('phone_candidate'),
    hashtext(coalesce(
      (select candidate_id::text from screening_v2.phone_engagements
        where id = p_engagement_id), ''))
  );

  if p_kind is null or p_kind not in ('initial','no_answer_retry','reconnect','scheduled') then
    return jsonb_build_object('status', 'invalid_kind');
  end if;

  -- Unlocked read: takes NO row lock, so the pinned order still holds.
  -- It exists only because the link id is reachable solely through the
  -- engagement row.
  select application_link_id into v_link_id
    from screening_v2.phone_engagements
   where id = p_engagement_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- ── LOCK 2: the application link ───────────────────────────────────
  select * into v_link
    from screening_v2.ashby_application_links
   where id = v_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'application_not_found');
  end if;

  -- ── LOCK 3: the engagement ─────────────────────────────────────────
  select * into v_eng
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- ── The application must still be live and still mapped in ─────────
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'application_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;
  if v_link.lifecycle in ('completed','cancelled') then
    return jsonb_build_object('status', 'application_not_live',
                              'lifecycle', v_link.lifecycle);
  end if;

  select * into v_map
    from screening_v2.ashby_job_mappings
   where id = v_link.job_mapping_id;
  if not found or v_map.status <> 'enabled' then
    return jsonb_build_object('status', 'mapping_not_enabled',
                              'mapping_status', coalesce(v_map.status, 'missing'));
  end if;

  -- Resume-backed applications only: an application with no resume file
  -- handle has no ingestion to be ready, and is not phone-eligible here.
  if v_link.external_resume_file_handle is null then
    return jsonb_build_object('status', 'ingestion_not_ready', 'ingestion_state', 'absent');
  end if;
  select state into v_ing_state
    from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link_id;
  if v_ing_state is distinct from 'ready' then
    return jsonb_build_object('status', 'ingestion_not_ready',
                              'ingestion_state', coalesce(v_ing_state, 'absent'));
  end if;

  -- ── The engagement must be in an admissible state for this kind ────
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state not in ('eligible','scheduled','reconnecting') then
    return jsonb_build_object('status', 'state_not_admissible', 'state', v_eng.state);
  end if;
  if (v_eng.state = 'reconnecting') <> (p_kind = 'reconnect')
     or (v_eng.state = 'scheduled')  <> (p_kind = 'scheduled') then
    return jsonb_build_object('status', 'kind_not_admissible',
                              'state', v_eng.state, 'kind', p_kind);
  end if;

  -- ── Consent: the LATEST record, fail-closed on every negative ──────
  -- Layer 1 of the two-layer consent model. The in-call spoken
  -- disclosure is notice plus a right of refusal (P4); it is not this.
  select * into v_consent
    from screening_v2.consent_records
   where candidate_id = v_eng.candidate_id
   order by created_at desc, id desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'consent_missing');
  end if;
  if v_consent.status <> 'granted' then
    return jsonb_build_object('status', 'consent_not_granted',
                              'consent_status', v_consent.status);
  end if;
  if v_consent.expires_at is not null and v_consent.expires_at <= p_now then
    return jsonb_build_object('status', 'consent_expired');
  end if;
  select required_consents into v_required
    from screening_v2.consent_templates
   where is_active
   order by updated_at desc, id desc
   limit 1;
  if v_required is null then
    return jsonb_build_object('status', 'consent_template_inactive');
  end if;
  if not (v_required <@ v_consent.consents) then
    return jsonb_build_object('status', 'consent_subset_missing');
  end if;

  -- ── A dialable Indian mobile, read from the candidate model only ───
  -- The number is never copied into a phone table, a payload, an audit
  -- row or a log line. It is read here and turned straight into a digest.
  select phone_e164, phone_valid into v_phone, v_phone_valid
    from screening_v2.candidates
   where id = v_eng.candidate_id;
  if not coalesce(v_phone_valid, false) or v_phone is null
     or v_phone !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('status', 'phone_invalid');
  end if;

  v_digest := screening_v2.sha256_hex(v_phone);
  if exists (select 1 from screening_v2.phone_suppressions
              where phone_sha256 = v_digest) then
    return jsonb_build_object('status', 'suppressed');
  end if;

  -- ── The kill switch. Read OUTSIDE any exception handler ────────────
  -- No `begin ... exception` wraps this read, and none appears anywhere
  -- above it in this body — asserted structurally in policy_tests.sql.
  -- Swallowing the read is exactly how a halt becomes fail-open, and a
  -- fail-open kill switch on a billable dialer is a defect. A MISSING
  -- singleton is a STOP.
  select halted_at into v_halted_at
    from screening_v2.phone_control
   where control_key = 'default'
   for share;
  v_ctl_found := found;
  if not v_ctl_found then
    return jsonb_build_object('status', 'halt_unreadable');
  end if;
  if v_halted_at is not null then
    return jsonb_build_object('status', 'halted');
  end if;

  -- ── The window, re-evaluated at the moment of dialling ─────────────
  if not screening_v2.phone_ist_window_open(p_now) then
    return jsonb_build_object('status', 'window_closed');
  end if;

  if v_eng.next_eligible_at is not null and v_eng.next_eligible_at > p_now then
    return jsonb_build_object('status', 'not_yet_eligible',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;

  -- ── Budgets: checked, never charged, here ──────────────────────────
  if p_kind in ('initial','no_answer_retry','scheduled')
     and v_eng.no_answer_attempts >= v_eng.no_answer_limit then
    return jsonb_build_object('status', 'no_answer_budget_exhausted',
                              'no_answer_attempts', v_eng.no_answer_attempts);
  end if;
  -- There is deliberately NO reconnect-budget refusal here. The budget
  -- is spent at the GRANT (apply_phone_event #19), so an engagement
  -- sitting in `reconnecting` is by construction one whose reconnect has
  -- already been charged and is now being redeemed. Refusing it at
  -- admission would strand the engagement in `reconnecting` for ever
  -- with no edge out — the budget would be enforced by wedging the row
  -- rather than by ending it. Exhaustion is terminal, decided at the
  -- fourth drop (#21), and `kind_not_admissible` above already refuses a
  -- reconnect from any other state.

  -- ── 0083 DELTA (engagement-level daily pre-check) ────────────────────
  -- Narrowed to match the 0083 per-IST-day INDEX predicate exactly: an
  -- infra-deferred abandonment (state='abandoned' AND
  -- abandon_reason='infra_deferred') is EXCLUDED here just as it is excluded
  -- from the index, so the SELECT pre-check and the INSERT-conflict path agree.
  -- Without this narrowing the pre-check would still count the infra-deferred
  -- row and fire `daily_attempt_exists`, leaving the engagement wedged until
  -- IST midnight even though the index would now let the insert through — i.e.
  -- the index fix alone would be INERT. A lease-RECLAIMED abandonment
  -- (abandon_reason NULL — the call rang/answered) is NOT excluded and still
  -- charges the day.
  v_ist_date := screening_v2.phone_ist_date(p_now);
  if p_kind in ('initial','no_answer_retry','scheduled')
     and exists (select 1 from screening_v2.phone_call_attempts
                  where engagement_id = p_engagement_id
                    and ist_date = v_ist_date
                    and kind in ('initial','no_answer_retry','scheduled')
                    and not (state = 'abandoned'
                             and abandon_reason = 'infra_deferred')) then
    return jsonb_build_object('status', 'daily_attempt_exists', 'ist_date', v_ist_date);
  end if;

  -- ── 0045: THE PER-CANDIDATE GUARDS ────────────────────────────────
  -- Every anti-harassment index in 0042 is keyed by ENGAGEMENT, and a
  -- person is not. `uq_phone_engagements_application` keys an engagement
  -- to an application link and `idx_phone_engagements_candidate` is
  -- deliberately not unique, so one person applying to two roles holds two
  -- engagements — two independent budgets, two independent IST-day slots,
  -- and, before this guard, two admissions that both succeeded. The
  -- advisory lock serialised them and refused neither. One phone rang
  -- twice, possibly at once.
  --
  -- This is the guard that makes the cross-replica claim true. The P5
  -- runtime's own `offeredCandidates` set bounds the hazard to one pass in
  -- one process; only a check INSIDE admission, under the lock, bounds it
  -- across passes and across replicas.
  --
  -- Guard A — nobody is on the phone with this person right now.
  if exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.state in ('admitted','ringing','answered_unclassified','human','machine')
       and a.lease_expires_at > p_now
  ) then
    return jsonb_build_object('status', 'candidate_call_in_flight');
  end if;

  -- Guard B — this person has not already been COLD-CALLED today, on any
  -- engagement.
  --
  -- `reconnect` is excluded for the same reason the per-engagement index
  -- excludes it: it redeems a budget already charged at the grant and must
  -- not be refused by a daily counter.
  --
  -- `scheduled` is excluded too, and that exclusion is the whole difference
  -- between an anti-harassment guard and a broken promise. A scheduled dial
  -- is NOT a cold call — it is a slot the candidate or HR booked
  -- (`schedule_phone_appointment` sources `hr_manual` / `candidate_voice`),
  -- and it is booked on an engagement whose owner cannot see the person's
  -- other engagements. Refusing it means the candidate agreed to a time,
  -- nobody rang, the appointment sat `scheduled` until the expiry sweep
  -- dropped it, and the only signal was a counter on a health page. The
  -- person asked to be called; declining to call them is not protecting
  -- them.
  --
  -- What still protects them is Guard A: if the other engagement is on the
  -- phone with them right now, the scheduled dial is refused
  -- `candidate_call_in_flight` — one line, one conversation, always.
  --
  -- ── 0083 DELTA (candidate-level daily pre-check) ─────────────────────
  -- Same narrowing as the engagement-level pre-check and the index: an
  -- infra-deferred abandonment on ANOTHER engagement of this candidate is
  -- EXCLUDED, so a pool hiccup on engagement A does not wedge a same-day cold
  -- call on engagement B. A reclaim-abandoned row (abandon_reason NULL) on
  -- another engagement — a call that reached this person — still charges the
  -- candidate's day, so the anti-harassment guard holds.
  if p_kind in ('initial','no_answer_retry')
     and exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind in ('initial','no_answer_retry','scheduled')
       and not (a.state = 'abandoned'
                and a.abandon_reason = 'infra_deferred')
  ) then
    return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                              'ist_date', v_ist_date);
  end if;

  -- ── The fleet cap: a DB-derived count, never a stored counter ──────
  -- Counted under the advisory lock, over live states holding an
  -- UNEXPIRED lease. A lease that is not actively renewed by P5's
  -- heartbeat expires and frees its slot; that is a stated dependency,
  -- not a hidden one.
  select count(*) into v_live
    from screening_v2.phone_call_attempts
   where state in ('admitted','ringing','answered_unclassified','human','machine')
     and lease_expires_at > p_now;
  if v_live >= v_max_concurrent then
    return jsonb_build_object('status', 'at_capacity', 'live', v_live,
                              'max_concurrent', v_max_concurrent);
  end if;

  -- ── Everything below is one transaction: attempt + lease + job ─────
  select coalesce(max(attempt_seq), 0) + 1 into v_seq
    from screening_v2.phone_call_attempts
   where engagement_id = p_engagement_id;

  v_lease_token   := gen_random_uuid();
  v_lease_expires := p_now + (greatest(5, least(coalesce(p_lease_seconds, 60), 900))
                              * interval '1 second');

  begin
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, ist_date,
       prior_engagement_state, lease_token, lease_owner, lease_expires_at,
       admitted_at, created_at)
    values
      (p_engagement_id, v_seq, v_eng.epoch, p_kind, 'admitted', v_ist_date,
       v_eng.state, v_lease_token, p_lease_owner, v_lease_expires,
       p_now, p_now)
    returning id into v_attempt_id;
  exception
    -- The ONLY handled condition, and it is handled narrowly. Two
    -- different indexes can raise it and they mean different things, so
    -- the constraint name is read rather than guessed: reporting a
    -- same-day race as an in-flight attempt would send an operator
    -- looking for a call that is not happening.
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'uq_phone_attempts_one_per_ist_day' then
        return jsonb_build_object('status', 'daily_attempt_exists',
                                  'ist_date', v_ist_date);
      end if;
      return jsonb_build_object('status', 'attempt_in_flight',
                                'constraint', v_constraint);
  end;

  update screening_v2.phone_call_attempts
     set participant_identity = 'phone-' || v_attempt_id::text
   where id = v_attempt_id;

  update screening_v2.phone_engagements
     set state             = 'dialing',
         state_reason      = null,
         last_attempt_at   = p_now,
         -- Pin WHICH consent record authorised this dial, so the
         -- authority for a call is auditable after the fact rather than
         -- re-derived from whatever the latest record happens to be.
         consent_record_id = v_consent.id,
         version           = version + 1,
         updated_at        = p_now
   where id = p_engagement_id;

  -- ── Queue admission, in this SAME transaction ──────────────────────
  -- The 0040 shape verbatim: untargeted `on conflict do nothing` so the
  -- guard covers every unique index, a read-back of a CLAIMABLE job when
  -- the insert is skipped, and a fail-closed raise when neither exists.
  -- Returning `ok` must mean live work exists.
  --
  -- The dedup key is ATTEMPT-scoped, so it is unique by construction and
  -- `uq_job_queue_dedup_active` is only a secondary guard; a stale
  -- engagement-scoped key could otherwise wedge an engagement forever.
  -- The payload is camelCase because that is what the handler will read;
  -- snake_case dead-letters the job as a malformed payload — the
  -- documented 0040 trap. It carries an opaque attempt id and nothing
  -- else: no phone number, no name, no provider field, no token, no URL.
  v_dedup_key := 'phone.dial:' || v_attempt_id::text;

  insert into screening_v2.job_queue
    (name, payload, status, dedup_key,
     attempts, max_attempts, priority, scheduled_at, created_at)
  values
    (v_queue_name,
     jsonb_build_object('provider', 'phone', 'attemptId', v_attempt_id),
     'pending',
     v_dedup_key,
     0, v_job_max_attempts, 0, p_now, p_now)
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select id into v_job_id
      from screening_v2.job_queue
     where name = v_queue_name
       and dedup_key = v_dedup_key
       and status in ('pending', 'delayed')
     limit 1;
    if v_job_id is null then
      -- Fail CLOSED. Aborting rolls back the attempt, the lease, the
      -- engagement transition and the audit row together, so the
      -- engagement rests truthfully in its prior state with every budget
      -- intact and its future eligibility unchanged. An admission that
      -- cannot schedule work must not report that it did.
      raise exception 'phone_dial_enqueue_failed'
        using errcode = 'data_exception',
              detail  = 'no live phone.dial job could be admitted';
    end if;
  end if;

  -- The slot that authorised this dial has been spent. `fulfilled` is
  -- written HERE, at the dial, rather than at the answer: the slot's job
  -- was to authorise a call at a time the candidate agreed to, and that
  -- job is done the moment the call is admitted. What the call then does
  -- is the attempt's business, and the attempt records it. Leaving the
  -- slot live instead would keep a stale entry on HR's calendar and push
  -- every later booking down the supersede path.
  if p_kind = 'scheduled' then
    update screening_v2.phone_appointments
       set status     = 'fulfilled',
           version    = version + 1,
           updated_at = p_now
     where engagement_id = p_engagement_id
       and status in ('scheduled', 'confirmed')
    returning id into v_apt_id;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    -- A worker/domain action: the documented all-zero system sentinel
    -- with actor_type 'system' (the 0024 precedent), never a human
    -- identity. OPERATOR actions — the halt RPCs, and a calendar action
    -- with a named actor — use actor_type 'recruiter' with the admin
    -- identity in actor_id, falling back to the house recruiter sentinel
    -- 00000000-0000-4000-8000-000000000001 (the 0035/0040/0041
    -- precedent). Two sentinels because there are two actor types, and
    -- chk_audit_actor_type is what makes the distinction load-bearing.
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_attempt_admitted', 'phone_call_attempt', v_attempt_id::text, 'success',
     -- Opaque ids and stable codes only. No number, no digest, no
     -- provider field, no lease token.
     jsonb_build_object('engagement_id', p_engagement_id,
                        'attempt_seq', v_seq,
                        'kind', p_kind,
                        'epoch', v_eng.epoch,
                        'ist_date', v_ist_date,
                        'live_before', v_live,
                        'max_concurrent', v_max_concurrent,
                        'fulfilled_appointment', v_apt_id is not null));

  return jsonb_build_object('status', 'ok',
                            'attempt_id', v_attempt_id,
                            'attempt_seq', v_seq,
                            'kind', p_kind,
                            'epoch', v_eng.epoch,
                            'ist_date', v_ist_date,
                            'lease_token', v_lease_token,
                            'lease_expires_at', v_lease_expires,
                            'live_before', v_live);
end;
$$;
revoke all on function screening_v2.admit_phone_attempt(uuid, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.admit_phone_attempt(uuid, text, text, integer, timestamptz)
  to service_role;

