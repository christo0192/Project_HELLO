-- 0071 — continuous transcript persistence and crashed-session recording
-- finalization.
--
-- FORWARD-ONLY and ADDITIVE. It adds ONE column + ONE partial unique index to
-- `transcript_turns`, adds ONE new RPC (`commit_phone_item_turn`), REPLACES two
-- function bodies in full (`commit_phone_question_boundary`, latest was 0052;
-- `reclaim_phone_attempt_leases`, latest was 0056), and adds ONE new sweeper RPC
-- (`sweep_phone_stranded_recordings`). It drops no table, retypes nothing,
-- rewrites no row, and touches no other migration. Every new function is
-- service-role-only. No session ids and no candidate data appear anywhere here.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────
-- Two live phone-path defects from ONE evidence-based RCA (live call 22,
-- 2026-08-29, session f0636659-8152-4fb0-ba23-f454fc30c078). The worker
-- crashed mid-call (CPU starvation, since fixed) and left two durable holes:
--
--   X4. ONLY 4 OF A 6.5-MINUTE CALL'S TRANSCRIPT TURNS SURVIVED. In the phone
--       path, turns are buffered in worker memory and persisted ONLY in pairs
--       at question boundaries by `commit_phone_question_boundary` (0052
--       batch-inserts the buffered pair). A crash BETWEEN boundaries loses
--       every turn since the last one. The BROWSER path never had this hole:
--       it persists every turn as it happens. This migration gives the phone
--       path the same per-item durability.
--
--   X5. THE MP3 WAS NEVER FINALIZED. 0038's recording-finalize convergence
--       trigger fires ONLY when `call_sessions.status` reaches a terminal
--       value. A worker crash posts NO terminal status — disconnect is
--       deliberately non-terminal so the session can survive a re-dispatch
--       window — so the session stays `in_progress` FOREVER: egress frozen at
--       `recording_egress_status = 'active'`, `recording_object_key = null`,
--       `recording_finalize_attempts = 0`, no actor to finalize it. Live proof:
--       session f0636659 sat in exactly that state; its attempt was later
--       `abandoned` by `reclaim_phone_attempt_leases`, but the SESSION was left
--       `in_progress`. This migration drives such a crashed session terminal
--       (`expired`/`grace_timeout`) once its conversation lease has genuinely
--       ended, which fires the 0038 trigger and finalization enqueues.
--
-- ═══════════════════════════════════════════════════════════════════════
-- 0. transcript_turns.source_item_id — the per-item idempotency key
-- ═══════════════════════════════════════════════════════════════════════
-- The per-item writer (X4) needs an exactly-once key that survives duplicate
-- delivery (SDK redelivery, a reconnecting leg replaying an item). The
-- boundary path uses `(session_id, turn_index)` for its own uniqueness, but
-- turn_index is SERVER-ASSIGNED at write time (`max+1`) and cannot be known by
-- the worker before the write — so it cannot be the idempotency key. The
-- worker instead mints a stable per-item id (the SDK conversation-item id, or
-- a monotonic `phone-item-<n>` counter) and the RPC dedups on THAT.
--
-- Additive and nullable: every legacy row and every boundary/gate turn keeps
-- `source_item_id = null`, and the partial unique index below only constrains
-- rows that carry one — so nothing pre-existing is retro-constrained.
alter table screening_v2.transcript_turns
  add column if not exists source_item_id text;

alter table screening_v2.transcript_turns
  drop constraint if exists chk_transcript_turns_source_item_id;
alter table screening_v2.transcript_turns
  add constraint chk_transcript_turns_source_item_id
    check (source_item_id is null
           or source_item_id ~ '^[A-Za-z0-9_.:-]{1,200}$')
    not valid;
alter table screening_v2.transcript_turns
  validate constraint chk_transcript_turns_source_item_id;

-- PARTIAL unique: exactly-once per (session, item) for the per-item writer,
-- while leaving every NULL-keyed legacy/boundary/gate row unconstrained. This
-- is what makes `ON CONFLICT DO NOTHING` in the new RPC actually dedup a
-- redelivered item rather than assign it a second turn_index.
create unique index if not exists uq_transcript_turns_source_item
  on screening_v2.transcript_turns (session_id, source_item_id)
  where source_item_id is not null;

comment on column screening_v2.transcript_turns.source_item_id is
  'Per-item idempotency key for the phone per-item transcript writer (0071 / '
  'commit_phone_item_turn). A stable id minted by the worker for one logical '
  'conversation item; a duplicate delivery carries the same value and is '
  'deduped by uq_transcript_turns_source_item. Null for every legacy row and '
  'every boundary/gate turn — turn_index is those paths'' own uniqueness.';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. commit_phone_item_turn — the per-item writer (X4a)
-- ═══════════════════════════════════════════════════════════════════════
-- Persists ONE phone transcript turn as it happens, mirroring the browser
-- path's per-turn `record_turn`. The SERVER assigns turn_index under the
-- session row lock (the single index authority, correct even across a
-- reconnecting leg whose in-memory counter reset); the RPC dedups on
-- `source_item_id` so a duplicate delivery cannot double-insert.
--
-- is_gate is ALWAYS false here: the gate transcript is owned exclusively by
-- commit_phone_gate_turns (0067), which this RPC does not touch. The boundary
-- authorship guard in §2 keys on `is_gate = false` per-item rows, so a gate
-- turn can never satisfy or defeat that guard.
create or replace function screening_v2.commit_phone_item_turn(
  p_session_id         uuid,
  p_speaker            text,
  p_text               text,
  p_source_item_id     text,
  p_turn_started_at_ms bigint      default null,
  p_now                timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess    screening_v2.call_sessions%rowtype;
  v_text    text;
  v_base    integer;
  v_id      uuid;
  v_anchor  bigint;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  -- ── SHAPE FIRST, answered truthfully ───────────────────────────────
  -- A malformed body is told exactly why and nothing is written. The
  -- source_item_id shape mirrors the boundary's source_event_id regex so a
  -- worker cannot smuggle an unbounded key into a durable column.
  if p_source_item_id is null
     or p_source_item_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_speaker is null
     or p_speaker not in ('bot', 'candidate') then
    return jsonb_build_object('status', 'invalid_turn');
  end if;
  v_text := btrim(coalesce(p_text, ''));
  if v_text = '' or length(v_text) > 8000 then
    return jsonb_build_object('status', 'invalid_turn');
  end if;
  -- The 0026 timing window: coerce anything outside it to NULL rather than
  -- fail — timing is best-effort, the transcript write must not fail on it.
  if p_turn_started_at_ms is not null
     and (p_turn_started_at_ms <= 0 or p_turn_started_at_ms >= 4102444800000) then
    v_anchor := null;
  else
    v_anchor := p_turn_started_at_ms;
  end if;

  -- The SESSION row lock, and nothing above it — a strict prefix of the
  -- assessment RPCs' lock order, so this never deadlocks against them and
  -- serialises the max(turn_index) read with every concurrent writer.
  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;
  -- Live during the gate (`waiting`) and the assessment (`in_progress`). A
  -- terminal session's transcript is closed; refuse rather than append.
  if v_sess.status not in ('waiting', 'in_progress') then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  -- ── IDEMPOTENT ON THE ITEM ─────────────────────────────────────────
  -- A duplicate delivery of the SAME item converges on the ORIGINAL row.
  -- Read the existing row back so the caller is told `applied` with the
  -- original turn_index rather than a false failure.
  select id into v_id from screening_v2.transcript_turns
   where session_id = p_session_id and source_item_id = p_source_item_id;
  if found then
    return jsonb_build_object('status', 'applied', 'applied', true,
                              'duplicate', true);
  end if;

  -- ── Append at the session's next index, guarded ON CONFLICT ────────
  -- The `on conflict do nothing` is belt-and-suspenders behind the read
  -- above: two racing deliveries of the same item that both passed the read
  -- under the same lock cannot both insert, and a concurrent per-item write
  -- for a DIFFERENT item takes the next index because the lock serialises the
  -- max read. is_gate is false; this writer never produces gate turns.
  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  insert into screening_v2.transcript_turns
    (session_id, turn_index, speaker, text, is_gate, created_at,
     turn_started_at_ms, source_item_id)
  values
    (p_session_id, v_base, p_speaker, v_text, false, p_now,
     v_anchor, p_source_item_id)
  on conflict (session_id, source_item_id) where source_item_id is not null
    do nothing;

  return jsonb_build_object('status', 'applied', 'applied', true,
                            'duplicate', false, 'turn_index', v_base);
end;
$$;

revoke all on function screening_v2.commit_phone_item_turn(uuid, text, text, text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_item_turn(uuid, text, text, text, bigint, timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_item_turn is
  'Persists ONE phone transcript turn as it happens (0071 / X4). The server '
  'assigns turn_index under the session row lock; dedup is on source_item_id '
  'via uq_transcript_turns_source_item, so a duplicate delivery converges on '
  'the original row. is_gate is always false. Gives the phone path the '
  'per-turn durability the browser path always had; motivated by live call 22 '
  '(2026-08-29), where a mid-call crash between question boundaries lost all '
  'but 4 of a 6.5-minute transcript. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. commit_phone_question_boundary — authorship-guarded turn insert (X4b)
-- ═══════════════════════════════════════════════════════════════════════
-- Replaced (a function body cannot be patched in place). The ONLY change from
-- 0052 is the transcript_turns INSERT, which is now AUTHORSHIP-GUARDED. Every
-- other behaviour is byte-for-byte 0052: the session row lock, the shape and
-- timing validation, the source_event_id duplicate read-back, the cursor CAS,
-- the phone_session_progress idempotency row, and the exact return shape.
--
-- ── WHY AN AUTHORSHIP GUARD AND NOT `ON CONFLICT` ──────────────────────
-- The per-item writer (§1) and this boundary both want to write the same
-- logical turns, and a double-write is what X4 must prevent. `ON CONFLICT` on
-- (session_id, turn_index) CANNOT dedup the two: turn_index is `max+1`
-- computed independently at two different times against a mutating table, so
-- the two writers land at DIFFERENT indices with identical text — the exact
-- failure. There is no shared deterministic index available at per-item emit
-- time (the item hook does not yet know the question cursor).
--
-- So the guard asks a question BOTH migration states can answer — "did the
-- per-item writer claim this session?" — rather than "is this exact index
-- taken?":
--
--   * A NEW worker writes per-item rows carrying source_item_id (is_gate =
--     false). The guard finds them and this boundary inserts NO turns; it only
--     advances the cursor and records progress. No double-write.
--   * An OLD worker (redelivered/rolled back against this migration — deploy
--     order applies the migration BEFORE the worker deploy, and the phone
--     worker is always-on with in-flight legs) never calls the per-item
--     endpoint, so no source_item_id rows exist, the guard passes, and this
--     boundary inserts turns exactly as 0052 did. Correct.
--
-- Gate turns (is_gate = true, 0067) are EXCLUDED from the guard, so a recorded
-- gate transcript never suppresses a legitimate boundary insert.
--
-- ── phone_session_progress WHEN THE INSERT IS SKIPPED ──────────────────
-- The progress row's chk_phone_session_progress_turns requires
-- turn_count = last_turn_index - first_turn_index + 1 with both >= 0. When the
-- boundary skips the insert (per-item authored), first/last are recorded as
-- the range where this boundary WOULD have written (v_base .. v_base+count-1),
-- a truthful provenance marker that satisfies the CHECK. The cursor and the
-- return shape are identical to 0052 in both branches, so the worker's
-- resume/advance logic is unchanged.
create or replace function screening_v2.commit_phone_question_boundary(
  p_session_id      uuid,
  p_question_key    text,
  p_expected_index  integer,
  p_source_event_id text,
  p_turns           jsonb,
  p_now             timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess       screening_v2.call_sessions%rowtype;
  v_plan       screening_v2.phone_session_plans%rowtype;
  v_prog       screening_v2.phone_session_progress%rowtype;
  v_item       jsonb;
  v_speaker    text;
  v_text       text;
  v_count      integer;
  v_cursor     integer;
  v_expected   text;
  v_base       integer;
  v_updated    integer;
  v_per_item   boolean;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'plan_missing');
  end if;

  if p_source_event_id is null
     or p_source_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_question_key is null
     or p_turns is null
     or jsonb_typeof(p_turns) <> 'array' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;
  v_count := jsonb_array_length(p_turns);
  if v_count < 2 or v_count > 12 then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  for v_item in select value from jsonb_array_elements(p_turns) loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
    v_speaker := v_item ->> 'speaker';
    v_text    := btrim(coalesce(v_item ->> 'text', ''));
    if v_speaker is null
       or v_speaker not in ('bot','candidate')
       or v_text = ''
       or length(v_text) > 8000 then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
    if v_item ? 'turn_started_at_ms'
       and v_item ->> 'turn_started_at_ms' is not null
       and (jsonb_typeof(v_item -> 'turn_started_at_ms') <> 'number'
            or v_item ->> 'turn_started_at_ms' !~ '^[1-9][0-9]{0,15}$'
            or (v_item ->> 'turn_started_at_ms')::numeric >= 4102444800000) then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
  end loop;

  if (p_turns -> 0 ->> 'speaker') <> 'bot'
     or (p_turns -> (v_count - 1) ->> 'speaker') <> 'candidate' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  select * into v_prog from screening_v2.phone_session_progress
   where session_id = p_session_id and source_event_id = p_source_event_id;
  if found then
    return jsonb_build_object(
      'status', 'applied',
      'applied', true,
      'duplicate', true,
      'question_key', v_prog.question_key,
      'question_index', v_prog.question_index,
      'first_turn_index', v_prog.first_turn_index,
      'last_turn_index', v_prog.last_turn_index,
      'cursor', greatest(coalesce(v_sess.current_question_index, 0), 0),
      'question_count', v_plan.question_count,
      'plan_complete',
        greatest(coalesce(v_sess.current_question_index, 0), 0) >= v_plan.question_count);
  end if;

  if v_sess.status <> 'in_progress' then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  if p_expected_index is null or p_expected_index <> v_cursor then
    return jsonb_build_object('status', 'stale_cursor',
                              'cursor', v_cursor,
                              'question_count', v_plan.question_count);
  end if;
  if v_cursor >= v_plan.question_count then
    return jsonb_build_object('status', 'plan_complete',
                              'cursor', v_cursor,
                              'question_count', v_plan.question_count);
  end if;
  v_expected := v_plan.questions -> v_cursor ->> 'key';
  if p_question_key <> v_expected then
    return jsonb_build_object('status', 'key_not_current',
                              'cursor', v_cursor,
                              'expected_key', v_expected,
                              'question_count', v_plan.question_count);
  end if;

  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  -- ── THE AUTHORSHIP GUARD (0071 / X4b) ──────────────────────────────
  -- Has the per-item writer already persisted non-gate turns for this
  -- session? If so, THIS is a new worker and the turns are already durable;
  -- inserting them here would double-write at fresh indices. If not, this is
  -- an old boundary-only worker and the insert below is the only writer.
  select exists (
    select 1 from screening_v2.transcript_turns
     where session_id = p_session_id
       and source_item_id is not null
       and coalesce(is_gate, false) = false
  ) into v_per_item;

  if not v_per_item then
    insert into screening_v2.transcript_turns
      (session_id, turn_index, speaker, text, created_at, turn_started_at_ms)
    select p_session_id,
           v_base + (t.ord - 1)::integer,
           t.value ->> 'speaker',
           btrim(t.value ->> 'text'),
           p_now,
           case when t.value ->> 'turn_started_at_ms' is null then null
                else (t.value ->> 'turn_started_at_ms')::bigint end
      from jsonb_array_elements(p_turns) with ordinality as t(value, ord);
  end if;

  -- Progress and cursor advance ALWAYS run — they are the boundary's real
  -- job. When the insert was skipped, first/last are the range this boundary
  -- would have occupied (a truthful provenance marker satisfying the CHECK).
  insert into screening_v2.phone_session_progress
    (session_id, question_key, question_index, source_event_id,
     first_turn_index, last_turn_index, turn_count, committed_at)
  values
    (p_session_id, p_question_key, v_cursor, p_source_event_id,
     v_base, v_base + v_count - 1, v_count, p_now);

  update screening_v2.call_sessions
     set current_question_index = v_cursor + 1
   where id = p_session_id
     and coalesce(current_question_index, 0) = v_cursor;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'phone question cursor CAS lost under row lock'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'applied', true,
    'duplicate', false,
    'question_key', p_question_key,
    'question_index', v_cursor,
    'first_turn_index', v_base,
    'last_turn_index', v_base + v_count - 1,
    'cursor', v_cursor + 1,
    'question_count', v_plan.question_count,
    'plan_complete', (v_cursor + 1) >= v_plan.question_count);
end;
$$;

revoke all on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, timestamptz)
  to service_role;

comment on function screening_v2.commit_phone_question_boundary is
  'Appends ONE completed question boundary — its progress row and cursor '
  'advance — in a single transaction under the session row lock (0071 keeps '
  'all of 0052''s behaviour). Its transcript_turns insert is now AUTHORSHIP-'
  'GUARDED: it writes the boundary''s turns only when the per-item writer '
  '(commit_phone_item_turn) has NOT already persisted non-gate turns for the '
  'session, so a new worker (per-item authoritative) and an old boundary-only '
  'worker both stay correct and never double-write. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. reclaim_phone_attempt_leases — terminalize a crashed session (X5a)
-- ═══════════════════════════════════════════════════════════════════════
-- Replaced (a function body cannot be patched in place). Everything from 0056
-- is preserved verbatim — the unlocked-scan-then-re-verify lock order, the
-- ENGAGEMENT-first suffix ordering, the dial-job resolution, the
-- already-completed-and-scored assessment.completed path, the prior-state
-- restore, the charge-nothing audit row. The ONLY addition is a narrow step
-- inside the RESTORE branch (the crash case): when the reclaim is ending a
-- conversation whose SESSION is still non-terminal and still carries an active
-- authoritative-recording egress with no object key, drive the session to a
-- terminal `expired`/`grace_timeout`. That fires the 0038 finalize
-- convergence trigger and enqueues the MP3 finalization the crash otherwise
-- stranded forever. It charges no budget (session terminalization is not an
-- attempt) and preserves the charge-nothing contract.
--
-- Live proof (2026-08-29, session f0636659): the attempt was abandoned by
-- THIS reclaimer, but the session was left `in_progress` with
-- recording_egress_status='active', recording_object_key=null,
-- recording_finalize_attempts=0 — so no MP3 was ever produced.
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
    select id, engagement_id
      from screening_v2.phone_call_attempts
     where state in ('admitted','ringing','answered_unclassified','human','machine')
       and lease_expires_at is not null
       and lease_expires_at <= p_now
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
       and lease_expires_at <= p_now
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

comment on function screening_v2.reclaim_phone_attempt_leases is
  'Bounded sweeper for expired phone leases (0071 keeps all of 0056''s '
  'behaviour). A completed+scored session is terminalized via '
  'assessment.completed; other expired attempts restore their prior '
  'non-terminal state. NEW in 0071: when the restore branch ends a '
  'conversation whose session is still in_progress with an active recording '
  'egress and no object key, the session is driven to expired/grace_timeout '
  'so the 0038 finalize trigger fires and the crashed call''s recording '
  'finalizes. Charges no budget. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. sweep_phone_stranded_recordings — belt-and-suspenders finalizer (X5b)
-- ═══════════════════════════════════════════════════════════════════════
-- The reclaim path (§3) covers the common crash: an attempt whose lease
-- lapses. This is the backstop for anything it structurally cannot reach — a
-- session left `in_progress` with a live egress and no object key whose
-- attempt was already resolved by another path, or a legacy row from before
-- §3 shipped. It finds such sessions that have been STILL longer than a wall-
-- clock bound and drives them terminal (`expired`/`grace_timeout`), which
-- fires the 0038 trigger exactly as §3 does.
--
-- The bound is derived from the worker's own residency cap, not an env knob: a
-- healthy phone leg can run at most SESSION_MAX_RESIDENCY_SEC (agent.py
-- default 3600s), after which the worker itself terminalizes the session. A
-- session STILL `in_progress` well past that ceiling is not live. The default
-- 7200s = 2 * the residency default, so a genuinely live call — even one at
-- the maximum residency — is never touched; clamped [3600, 86400].
--
-- Distinct from sweep_phone_stranded_sessions (0045), which resolves
-- ENGAGEMENTS pointing at an ALREADY-terminal session. This resolves the
-- opposite shape: a still-in_progress SESSION whose recording is stranded.
create or replace function screening_v2.sweep_phone_stranded_recordings(
  p_limit         integer     default 25,
  p_grace_seconds integer     default 7200,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit    integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_grace    integer := greatest(3600, least(coalesce(p_grace_seconds, 7200), 86400));
  v_row      record;
  v_updated  integer;
  v_examined integer := 0;
  v_finalized integer := 0;
  v_skipped  integer := 0;
begin
  for v_row in
    select s.id
      from screening_v2.call_sessions s
     where s.status = 'in_progress'
       and s.recording_egress_id is not null
       and s.recording_object_key is null
       and s.recording_egress_status = 'active'
       and s.recording_deleted_at is null
       and s.recording_revoked_at is null
       and coalesce(s.recording_quarantined, false) = false
       -- The staleness bound: the LATER of the session's clocks must be older
       -- than the grace, so a session that a live leg touched a moment ago is
       -- never terminalized under it.
       and greatest(coalesce(s.updated_at, s.started_at), s.started_at)
           <= p_now - (v_grace * interval '1 second')
     order by s.updated_at asc nulls first
     limit v_limit
     for update skip locked
  loop
    v_examined := v_examined + 1;
    -- RE-VERIFY under the lock: the unlocked-ish scan may have raced a live
    -- completion. Only the exact stuck shape, still `in_progress`, is driven
    -- terminal — the transition fires trg_enqueue_recording_finalize (0038).
    update screening_v2.call_sessions s
       set status          = 'expired',
           terminal_reason = 'grace_timeout',
           ended_at        = coalesce(s.ended_at, p_now),
           updated_at      = p_now
     where s.id = v_row.id
       and s.status = 'in_progress'
       and s.recording_egress_id is not null
       and s.recording_object_key is null
       and s.recording_egress_status = 'active'
       and s.recording_deleted_at is null
       and s.recording_revoked_at is null
       and coalesce(s.recording_quarantined, false) = false;
    get diagnostics v_updated = row_count;
    if v_updated = 1 then
      v_finalized := v_finalized + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status',        'ok',
    'examined',      v_examined,
    'finalized',     v_finalized,
    'skipped',       v_skipped,
    'limit',         v_limit,
    'grace_seconds', v_grace);
end;
$$;

revoke all on function screening_v2.sweep_phone_stranded_recordings(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.sweep_phone_stranded_recordings(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.sweep_phone_stranded_recordings is
  'Belt-and-suspenders backstop for X5 (0071): finds sessions left '
  'in_progress with an active recording egress and no object key that have '
  'been still longer than a residency-derived grace, and drives them to '
  'expired/grace_timeout so the 0038 finalize trigger fires. Distinct from '
  'sweep_phone_stranded_sessions (0045), which resolves engagements pointing '
  'at an already-terminal session. Never touches a live session (grace >= the '
  'worker residency cap) or a healthy one. Service-role-only.';

notify pgrst, 'reload schema';
