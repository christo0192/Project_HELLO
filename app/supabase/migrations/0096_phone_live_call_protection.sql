-- ═══════════════════════════════════════════════════════════════════════
-- 0096 — a connected call is not a dead leg, and an orphan session is not
--        invisible
--
-- RCA 2026-09-10. Two calls were admitted in ONE due-loop pass at the identical
-- microsecond. Both answered. Both produced zero transcript turns. Both leases
-- expired at admission + exactly 180.000s with ZERO renewals, and both were
-- reaped `abandoned` at the same instant — with people on the line.
--
-- The worker half of the fix ships alongside this migration: the lease is now
-- re-based on `call.answered` (so a cold-boot answer no longer inherits a
-- half-spent window) and the opening gate has a wall clock (so a wedged playout
-- fails loudly instead of freezing a call). This file closes the two halves
-- that live in SQL.
--
-- ── 1. THE REAPER TOOK LIVE CONVERSATIONS ───────────────────────────────
-- `reclaim_phone_attempt_leases` selected on
--   state in ('admitted','ringing','answered_unclassified','human','machine')
--   and lease_expires_at <= p_now
-- — ZERO grace, and no liveness check of any kind. `'human'` is a consented,
-- talking candidate, and it sat in the same IN-list as a leg that never rang.
--
-- The reap does not hang up. The LiveKit room and the SIP leg continue; the
-- candidate keeps talking to a bot whose attempt is already `abandoned` and
-- whose engagement has been rolled back to `eligible`. If that leg later
-- finishes and scores, `assessment.completed` is IGNORED — that edge is gated
-- on `in_call`, which the engagement no longer is. The screening is lost in
-- silence.
--
-- An ANSWERED leg now gets one extra grace period. This is a delay, not an
-- exemption: a genuinely dead worker still loses its slot, one grace later. A
-- leg that never answered is untouched, because its slot really is holding up
-- somebody else's call.
--
-- ── 2. AN ORPHAN SESSION WEDGED A WORKER LEASE FOR FOUR DAYS ────────────
-- `ensureSession` creates the `call_sessions` row BEFORE `admit_phone_attempt`
-- runs, so a refused admission leaves the row behind in `waiting` — with no
-- attempt, for ever. One such row (session 77e3ae0d, 2026-09-10) was then
-- ADOPTED by a later dial, which claimed a worker lease against it; the call
-- hit voicemail, `start_phone_assessment` never ran, the session never left
-- `waiting`, and with no terminal session there was nothing to drive
-- `release_voice_worker_by_session`. The lease sat `ready` with a 32-hour-dead
-- heartbeat, holding HALF the phone pool, and the next screening of that
-- candidate would have passed the readiness gate on it.
--
-- Nothing could clean it up. `finalize_phone_partial_sessions` joins
-- `phone_call_attempts` with an INNER lateral — a session with no attempt row
-- produces no rows at all and is dropped before any predicate runs — and also
-- requires `in_progress`/`expired`. `reclaim_phone_attempt_leases` scans
-- attempts. `list_terminal_session_leases` requires a terminal session. A row
-- visible to none of them is a row nothing can ever resolve.
--
-- `sweep_phone_orphan_sessions` is that missing reaper. It is deliberately a
-- separate function rather than a widening of the partial-finalize sweep: that
-- one asks "did a started call end without being scored?", this one asks "was a
-- session ever used at all?", and neither can answer for the other.
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1. HOW LONG A CONNECTED CALL IS SPARED ────────────────────────────

create or replace function screening_v2.phone_answered_reclaim_grace()
returns interval
language sql
immutable
set search_path = pg_catalog
as $$
  -- Two minutes. One full heartbeat cadence (30s) times four: long enough that
  -- a worker briefly wedged on a playout or a slow provider keeps its
  -- conversation, short enough that a machine which has genuinely died gives
  -- its fleet slot back inside the same call window.
  --
  -- Deliberately NOT sized to the lease (180s at admission, 240s today): the
  -- grace is about how long we are willing to be WRONG about a live call, and
  -- that is a smaller question than how long a call may run.
  select interval '120 seconds';
$$;

revoke all on function screening_v2.phone_answered_reclaim_grace()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_answered_reclaim_grace()
  to service_role;

comment on function screening_v2.phone_answered_reclaim_grace() is
  'Extra grace before `reclaim_phone_attempt_leases` may abandon an attempt '
  'that was ANSWERED BY A PERSON. A leg that never rang, and one classified as '
  'an answering machine, are both reclaimed with no grace at all.';


-- ── 2. THE REAPER, PATCHED ────────────────────────────────────────────
--
-- Lifted VERBATIM from 0071 (the migration that last defined it) and patched
-- surgically, so the parts not being changed are byte-identical to what is
-- running. The build asserted every anchor matched exactly once.

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
      update screening_v2.phone_engagements
         set state        = v_att.prior_engagement_state,
             state_reason = 'lease_reclaimed',
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


-- ── 3. THE SWEEP THAT SEES AN ORPHAN SESSION ──────────────────────────
--
-- Terminalizes a `live` session that was created for a dial which never
-- happened, so the worker lease claimed against it can finally be released.
--
-- SIGNATURE CONVENTIONS (the RPC-contract tests read this text with regexes):
-- `timestamptz` not `timestamp with time zone`; `)` and `returns` on separate
-- lines; NO comments between the parameters; body quoted `$$`.
create or replace function screening_v2.sweep_phone_orphan_sessions(
  p_limit integer default 25,
  p_grace_seconds integer default 14400,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'screening_v2'
as $$
declare
  v_limit     integer := greatest(1, least(coalesce(p_limit, 25), 200));
  -- FLOOR 900, DEFAULT 14400 (four hours).
  --
  -- The lower bound is set by the RETRY LADDER, not by the call: a refused
  -- dial comes back after `infraDeferBackoffSeconds` (300s), and when the pool
  -- is small every dial in a burst defers, so one session can be stranded and
  -- re-adopted several times in a quarter of an hour. A grace anywhere near
  -- that is a sweep racing the dial it is meant to be cleaning up after.
  --
  -- The upper bound is set by what this is FOR: releasing a worker lease that
  -- nothing else can release. Four hours detects that inside a working day.
  --
  -- NOT `phone_stale_session_seconds()` (four days), and the difference is
  -- deliberate. That constant answers "how long may a `waiting` session
  -- legitimately live before an operator should be TOLD about it" — it spans
  -- the three-IST-day no-answer ladder, and it drives a report, never a write.
  -- This one answers "how long before we collect it", and collecting one
  -- between ladder rungs costs nothing: `findReusableSession` simply finds no
  -- adoptable row and `ensureSession` mints a fresh one, which that function's
  -- own comment calls the cheap direction. What it buys is the machine back.
  v_grace     integer := greatest(900, least(coalesce(p_grace_seconds, 14400), 345600));
  v_row       record;
  v_updated   integer;
  v_examined  integer := 0;
  v_expired   integer := 0;
  v_skipped   integer := 0;
begin
  for v_row in
    select s.id as session_id
      from screening_v2.call_sessions s
     where s.mode = 'live'
       -- `waiting` ONLY. A session that reached `in_progress` had a worker in
       -- it and belongs to `finalize_phone_partial_sessions`; taking it here
       -- would race that sweep for the same row and could terminalize a call
       -- that is still being screened.
       and s.status = 'waiting'
       and s.started_at is not null
       -- Age is `started_at`, and deliberately NOT `greatest(started_at,
       -- updated_at)`: adoption does not write to `call_sessions` at all, so
       -- `updated_at` says nothing about recent USE for the one status this
       -- sweep can see. (It is also unwritable by a caller — the 0001
       -- `set_updated_at` trigger overwrites it with the host clock — so a
       -- rule built on it could not be tested against an injected clock.)
       -- The fence against a session in active use is the live-attempt check
       -- below; the age is only a floor under how stale a row must look first.
       and s.started_at <= p_now - (v_grace * interval '1 second')
       -- ── NO CALL IS IN FLIGHT FOR THIS CANDIDATE ─────────────────────
       -- THE decisive guard, and the only one of the three that is not
       -- structurally redundant. `start_phone_assessment` (0044) binds
       -- BOTH session ids AND moves the session `waiting -> in_progress` in a
       -- single transaction — so for any row this sweep can see, the two
       -- `not exists` checks below are already implied by `status = 'waiting'`
       -- and fence nothing. Between admission and that bind there is a live
       -- call on a session that still looks exactly like an orphan: the
       -- attempt exists but its `session_id` is still null, and the candidate
       -- may already be talking.
       --
       -- A session is only reapable while NOTHING is dialling this candidate.
       -- Deliberately scoped to the CANDIDATE rather than to this session,
       -- because the link a live call has to its session is precisely the one
       -- that has not been written yet.
       and not exists (
         select 1
           from screening_v2.phone_call_attempts a2
           join screening_v2.phone_engagements e2 on e2.id = a2.engagement_id
          where e2.candidate_id = s.candidate_id
            and a2.state in ('admitted','ringing','answered_unclassified','human','machine')
       )
       -- NEVER DIALLED. Redundant today (see above) and kept deliberately: it
       -- states the orphan's defining property, and it is the check that stays
       -- correct if the bind is ever split from the status change.
       and not exists (
         select 1 from screening_v2.phone_call_attempts a
          where a.session_id = s.id
       )
       -- NOT THE ENGAGEMENT'S CURRENT SESSION. Same note: redundant today,
       -- retained as a statement of intent.
       and not exists (
         select 1 from screening_v2.phone_engagements e
          where e.session_id = s.id
            and e.terminal_at is null
       )
     order by s.started_at asc
     limit v_limit
     for update of s skip locked
  loop
    v_examined := v_examined + 1;

    -- `waiting -> expired` is a legal edge (`enforce_session_transition`), and
    -- ('expired','idle_timeout') is a legal pair for the terminal-reason CHECK.
    -- `idle_timeout` is the truthful word: the session sat unused until it
    -- aged out. It is NOT `grace_timeout`, which the partial-finalize sweep
    -- uses for crash residue and which the scoring eligibility gate admits —
    -- an orphan has no conversation to score and must never look like one.
    update screening_v2.call_sessions s
       set status          = 'expired',
           terminal_reason = 'idle_timeout',
           ended_at        = coalesce(s.ended_at, p_now),
           updated_at      = p_now
     where s.id = v_row.session_id
       and s.status = 'waiting'
       -- RE-VERIFIED UNDER THE ROW LOCK, exactly as the reaper above does it.
       -- The scan is a separate statement, and `for update of s` locks the
       -- SESSION — it cannot fence an `admit_phone_attempt` that touches only
       -- the attempt and engagement tables. Repeating the predicate here makes
       -- the UPDATE itself the point of decision, so an admission that
       -- committed while this loop was running is seen and the row is skipped.
       and not exists (
         select 1
           from screening_v2.phone_call_attempts a2
           join screening_v2.phone_engagements e2 on e2.id = a2.engagement_id
          where e2.candidate_id = s.candidate_id
            and a2.state in ('admitted','ringing','answered_unclassified','human','machine')
       );
    get diagnostics v_updated = row_count;

    if v_updated = 1 then
      v_expired := v_expired + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status',   'ok',
    'examined', v_examined,
    'expired',  v_expired,
    'skipped',  v_skipped,
    'limit',    v_limit
  );
end;
$$;

revoke all on function screening_v2.sweep_phone_orphan_sessions(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.sweep_phone_orphan_sessions(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.sweep_phone_orphan_sessions(integer, integer, timestamptz) is
  'Terminalizes a live `waiting` session that never got an attempt — the shape '
  '`ensureSession` leaves behind when admission refuses after the session row '
  'is created. Invisible to every other sweep, and it wedges the worker lease '
  'claimed against it until terminalized. Drives `expired`/`idle_timeout`, '
  'which the scoring eligibility gate does NOT admit. Never touches a session '
  'whose candidate has a live attempt, re-verified under the row lock: between '
  'admission and `start_phone_assessment` a real call sits on a session that '
  'is still indistinguishable from an orphan.';
