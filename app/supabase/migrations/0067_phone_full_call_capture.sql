-- 0067_phone_full_call_capture.sql
--
-- Phone Parity 2 — capture the WHOLE call, keep only what is consented.
--
-- FORWARD-ONLY and ADDITIVE. It adds one nullable column with a default,
-- REPLACES two function bodies in full (`apply_phone_event`, latest was 0057;
-- `attach_phone_attempt_recording`, latest was 0050) and adds ONE new RPC
-- (`commit_phone_gate_turns`). It drops no table, column, index or
-- unique/foreign-key constraint, retypes nothing, and rewrites no existing
-- row. Every earlier migration stays byte-identical.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────
-- Today a phone call is only observable to the durable model from the
-- moment `disclosure.delivered` moves the engagement to `in_call`: that is
-- when recording may bind (0043/0050) and when the assessment plan
-- snapshots (0044). Everything the candidate says between ANSWER and the
-- disclosure — the greeting, the "who is this?", the consent exchange
-- itself — has no home. Phone Parity 2 closes that gap in three additive
-- pieces, each of which is safe on its own and none of which changes an
-- existing outcome for an existing event type:
--
--   1. A `call.answered` event, so the ledger records the instant a leg was
--      answered as a FIRST-CLASS fact rather than inferring it from a
--      classification. It stamps `answered_at` and moves nothing else.
--   2. A recording-bind relaxation, so an egress may start at ANSWER
--      (the pre-consent `dialing` state) instead of only after the
--      disclosure — record from answer, keep only if consented, and purge
--      on every non-consent exit through the SAME purge path 0043 already
--      ships.
--   3. A gate-transcript RPC, so the pre-consent turns are durable and
--      flagged `is_gate = true`, distinct from the scored assessment turns
--      a question boundary writes.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────
--   * No new engagement state and no new transition. `call.answered` does
--     not move the engagement; it only stamps the attempt's answer time.
--     The consent gate that governs SCORED recording and the assessment
--     plan is untouched — `in_call` remains reachable only through
--     `disclosure.delivered`.
--   * No change to the purge/suppression order. The pre-consent recording
--     is enumerated and deleted by the identical 0043 machinery
--     (`list_phone_engagement_recordings` / `clear_phone_attempt_recordings`);
--     a non-consent exit already runs it before posting its terminal event.
--   * No new event-type ALLOWLIST in SQL. `phone_call_events.event_type` is
--     a FORMAT rule (`^[a-z][a-z0-9_.]{1,63}$`), never a closed CHECK, so
--     `call.answered` is representable without touching a constraint. The
--     closed vocabulary lives in TypeScript, and that is where it is widened.
--   * No egress-status change and no phone number, provider payload or raw
--     text stored, read or returned by anything below.
--
-- ── LOCK ORDER ────────────────────────────────────────────────────────
-- Unchanged. `apply_phone_event` keeps 0042's pinned engagement→attempt
-- order; `attach_phone_attempt_recording` keeps engagement→attempt;
-- `commit_phone_gate_turns` takes the SESSION lock ONLY (a strict prefix of
-- 0044's order), so it cannot deadlock against any assessment RPC — a
-- single-lock transaction cannot close a cycle.
--
-- ── TIME IS INJECTED ──────────────────────────────────────────────────
-- Every replaced or new RPC keeps `p_now timestamptz` as its FINAL
-- parameter and no body calls `now()`.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. is_gate — mark the pre-consent turns apart from the scored ones
-- ═══════════════════════════════════════════════════════════════════════
-- Additive, defaulted false, so every pre-0067 turn and every assessment
-- boundary turn keeps its exact prior meaning: a scored transcript row is
-- `is_gate = false` and nothing writes it any other way except the new
-- gate RPC below.

alter table screening_v2.transcript_turns
  add column if not exists is_gate boolean not null default false;

comment on column screening_v2.transcript_turns.is_gate is
  'True only for turns captured BEFORE the recording disclosure — the '
  'greeting and consent exchange — written by commit_phone_gate_turns. '
  'False for every legacy row and every scored assessment boundary turn '
  '(commit_phone_question_boundary), so a reader can tell the pre-consent '
  'gate transcript from the assessment transcript.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. apply_phone_event — ONE new branch (call.answered), else 0057 verbatim
-- ═══════════════════════════════════════════════════════════════════════
-- Replaced because a function body cannot be patched in place. The ONLY
-- difference from 0057 is the `call.answered` branch: it is gated on the
-- ATTEMPT being in a live PRE-CLASSIFICATION state
-- (`admitted`/`ringing`/`answered_unclassified`), it moves the attempt to
-- `answered_unclassified` — which stamps `answered_at` if null through the
-- existing attempt-update block, exactly as 0055 keeps answer timing
-- truthful — and it sets NO engagement target, so the engagement state is
-- unchanged. Idempotency needs no special handling: a redelivery carrying
-- the same provider/synthetic id hits `uq_phone_call_events_provider` and
-- is answered with the ORIGINAL verdict, and a re-application while already
-- `answered_unclassified` is a harmless self-update that re-coalesces the
-- already-set `answered_at`.

create or replace function screening_v2.apply_phone_event(
  p_source            text,
  p_event_type        text,
  p_attempt_id        uuid        default null,
  p_engagement_id     uuid        default null,
  p_provider_event_id text        default null,
  p_epoch             integer     default null,
  p_metadata          jsonb       default null,
  p_now               timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att        screening_v2.phone_call_attempts%rowtype;
  v_eng        screening_v2.phone_engagements%rowtype;
  v_eng_id     uuid;
  v_subject    text;
  v_event_id   text;
  v_ignored    text;
  v_new_state  text;        -- engagement target, null = no engagement change
  v_att_state  text;        -- attempt target, null = no attempt change
  v_outcome    text;
  v_charge     text;        -- 'no_answer' | 'reconnect' | 'provider' | null
  v_reason     text;
  v_bump_epoch boolean := false;
  v_defer      boolean := false;
  v_row_id     uuid;
  v_existing   screening_v2.phone_call_events%rowtype;
  v_slot_start timestamptz;
  v_metadata   jsonb;
  v_phone      text;
  v_digest     text;
  v_suppressed boolean := false;
  v_defer_at   timestamptz;
  -- 0044: set by the one edge whose claim must be backed by a real score.
  v_needs_assessment boolean := false;
  -- 0045: the engagement is non-terminal but its session has already ended.
  v_stranded         boolean := false;
begin
  if p_source is null or p_source not in
     ('livekit_webhook','provider_callback','provider_poll','internal','reconciliation') then
    return jsonb_build_object('status', 'invalid_source');
  end if;

  -- Unsanitized metadata is DROPPED, not stored and not fatal. Refusing
  -- the whole call would lose the event, and the ledger exists to record
  -- events; storing it would durably persist a provider envelope on an
  -- append-only table. The replacement marker says plainly that
  -- something was discarded, so this is visible rather than silent.
  v_metadata := case
    when screening_v2.phone_event_metadata_sanitized(p_metadata) then p_metadata
    else jsonb_build_object('metadata_rejected', true)
  end;
  if p_event_type is null or p_event_type !~ '^[a-z][a-z0-9_.]{1,63}$' then
    return jsonb_build_object('status', 'invalid_event_type');
  end if;

  -- ── Resolve the subject, taking locks in the pinned order ──────────
  if p_attempt_id is not null then
    select engagement_id into v_eng_id
      from screening_v2.phone_call_attempts where id = p_attempt_id;
  else
    v_eng_id := p_engagement_id;
  end if;

  if v_eng_id is not null then
    select * into v_eng from screening_v2.phone_engagements
     where id = v_eng_id for update;
    if not found then
      v_eng_id := null;
    end if;
  end if;

  -- ── 0045: IS THIS ENGAGEMENT STRANDED? ─────────────────────────────
  -- A conversation that ended while nobody was holding the engagement in
  -- `in_call`. Before 0045's heartbeat the normal way to get here was a
  -- mid-call lease reclaim: the sweep restored `prior_engagement_state`
  -- (always one of these three) while the agent talked on, and the
  -- agent's eventual `assessment.completed` then hit an `in_call` guard
  -- that no longer held and was ignored as `unexpected_event`. The
  -- screening was conducted, persisted and SCORED, and the engagement
  -- never heard about it.
  --
  -- All three conditions are load-bearing:
  --   * one of the three states the reclaimer can restore — NOT any
  --     non-terminal state, because `dialing` and `pending_prereqs` have
  --     no ended conversation behind them;
  --   * a bound session, since an engagement with no `session_id` has
  --     nothing to be stranded BY;
  --   * that session already TERMINAL. Without this a stray
  --     `assessment.aborted` could terminate an `eligible` engagement
  --     that is merely waiting its turn to be dialled.
  --
  -- The read is UNLOCKED. `call_sessions` is last in the pinned lock
  -- order, so taking no lock here cannot close a cycle, and the value is
  -- only ever used to permit a refusal-free transition that a separate
  -- interlock re-checks.
  -- ── AND ONLY THE SWEEP MAY DRIVE IT ────────────────────────────────
  -- `v_stranded` is a property of the ENGAGEMENT, not of the caller, and a
  -- first draft stopped there. That is not an interlock: ANY caller posting
  -- these two event types drives the same widened edges — including
  -- `POST /api/internal/phone/events`, whose worker allowlist contains
  -- `assessment.aborted`, which carries no assessment interlock of its own.
  -- A delayed or retried `assessment.aborted` landing after the engagement
  -- had moved to `reconnecting` with a bound terminal session was
  -- `unexpected_event` and harmless before 0045; after it, it was terminal
  -- `failed`.
  --
  -- So the branch is additionally gated on the SHAPE ONLY THE SWEEP
  -- PRODUCES: an `internal` post carrying NO attempt id. Every worker post
  -- names its attempt, so no worker can reach these edges however delayed
  -- or replayed it is.
  if v_eng_id is not null
     and p_source = 'internal'
     and p_attempt_id is null
     and v_eng.terminal_at is null
     and v_eng.state in ('eligible','scheduled','reconnecting')
     and v_eng.session_id is not null then
    select exists (
      select 1 from screening_v2.call_sessions s
       where s.id = v_eng.session_id
         and s.status in ('completed','failed','cancelled','expired')
    ) into v_stranded;
  end if;
  if p_attempt_id is not null and v_eng_id is not null then
    select * into v_att from screening_v2.phone_call_attempts
     where id = p_attempt_id for update;
  end if;

  -- ── The deterministic synthetic id ─────────────────────────────────
  -- provider_event_id is NOT NULL on the table, because a unique index
  -- over a nullable column does not dedup and the non-provider channels
  -- are exactly the ones that recover a dropped webhook.
  v_subject := coalesce(p_attempt_id::text, v_eng_id::text, 'unbound');
  if p_provider_event_id is not null then
    v_event_id := p_provider_event_id;
  elsif p_source = 'internal' then
    v_event_id := 'internal:' || v_subject || ':' || p_event_type
                  || ':' || coalesce(p_epoch, -1)::text;
  elsif p_source = 'provider_poll' then
    v_event_id := 'poll:' || v_subject || ':' || p_event_type;
  elsif p_source = 'reconciliation' then
    v_event_id := 'recon:' || v_subject || ':' || p_event_type;
  else
    -- A webhook or provider callback with no provider id is not
    -- dedupable and must not be silently invented.
    return jsonb_build_object('status', 'provider_event_id_required');
  end if;
  if v_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$' then
    return jsonb_build_object('status', 'invalid_provider_event_id');
  end if;

  -- ── The verdict, decided BEFORE anything is written ────────────────
  if v_eng_id is null or (p_attempt_id is not null and v_att.id is null) then
    v_ignored := 'unknown_attempt';
  elsif v_eng.terminal_at is not null then
    v_ignored := 'terminal';
  -- Fencing must not be optional. An ingress that omits its epoch is
  -- fenced against the epoch stored ON THE ATTEMPT, which #18 keeps in
  -- step with the engagement's. Without this fallback a callback
  -- belonging to a superseded conversation and carrying no epoch applied
  -- against the NEW one — charging a reconnect on a call still up.
  elsif coalesce(p_epoch, v_att.epoch) is not null
        and coalesce(p_epoch, v_att.epoch) < v_eng.epoch then
    v_ignored := 'stale_epoch';
  else
    case
      -- ── from `dialing` ──────────────────────────────────────────────
      when v_eng.state = 'dialing' and p_event_type = 'sip.participant_joined' then
        -- #14. JOIN IS NOT ANSWER. The SIP leg being up says nothing
        -- about who, or what, is on it. No assessment, no egress, no
        -- agent speech may follow from this state.
        v_att_state := 'answered_unclassified';

      -- ── ANSWER, as a first-class ledger fact (0067) ────────────────
      -- A leg was answered. This is gated on the ATTEMPT being in a live
      -- PRE-CLASSIFICATION state, not on the engagement, because `dialing`
      -- OUTLIVES the answer and a classified attempt has already recorded
      -- its answer. It stamps `answered_at` (through the attempt-update
      -- block, exactly as 0055 does) and moves the engagement NOWHERE — it
      -- is not consent and must not be mistaken for it. From `admitted`/
      -- `ringing` it advances the attempt to `answered_unclassified`; a
      -- second `call.answered` on an already-answered attempt is a harmless
      -- self-update that re-coalesces the already-set `answered_at`, and a
      -- redelivery of the SAME event id is deduped by the ledger and reads
      -- back the original verdict. An engagement-scoped post with no
      -- attempt matches no branch (v_att.state is null) and is recorded as
      -- `unexpected_event`, never as a spurious `attempt_required`.
      when p_event_type = 'call.answered'
           and v_att.state in ('admitted','ringing','answered_unclassified') then
        v_att_state := 'answered_unclassified';

      when v_eng.state = 'dialing' and p_event_type = 'classify.human' then
        v_att_state := 'human';                                        -- #16
      when v_eng.state = 'dialing' and p_event_type = 'classify.machine' then
        -- #15. A voicemail must produce NO scored session: it charges a
        -- no-answer attempt, never a reconnect, and the attempt ends.
        v_att_state := 'ended'; v_outcome := 'voicemail'; v_charge := 'no_answer';
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_rejected_busy' then
        v_att_state := 'ended'; v_outcome := 'busy'; v_charge := 'no_answer';   -- #11
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_timeout' then
        v_att_state := 'ended'; v_outcome := 'no_answer'; v_charge := 'no_answer'; -- #12
      when v_eng.state = 'dialing' and p_event_type = 'sip.originate_rejected_transport' then
        v_att_state := 'ended'; v_outcome := 'provider_error'; v_charge := 'provider'; -- #13
      when v_eng.state = 'dialing' and p_event_type = 'disclosure.refused' then
        -- #17. Terminal, and the purge/suppression that must accompany
        -- it is P4's transaction, not this one.
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';
        v_reason := 'disclosure_refused';
      when v_eng.state = 'dialing' and p_event_type = 'disclosure.delivered' then
        -- #18. The ONLY place a conversation begins: bump the fencing
        -- epoch and reset the reconnect budget for the new conversation.
        v_new_state := 'in_call'; v_bump_epoch := true;
      when v_eng.state = 'dialing' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number';
        v_reason := 'wrong_number';

      -- ── from `dialing`, ANSWERED but PRE-DISCLOSURE (0043 / P3-1) ───
      -- The gap P3 recorded and could not close: a candidate who PICKS UP
      -- and hangs up before `disclosure.delivered` left the engagement in
      -- `dialing` with the attempt in `answered_unclassified`/`human` and
      -- NO legal edge, so the drop was recorded as `unexpected_event` and
      -- the outcome was unrecorded rather than classified.
      --
      -- Three things make this branch truthful rather than convenient:
      --
      --   * IT IS GATED ON THE ATTEMPT, NOT THE ENGAGEMENT. `dialing`
      --     OUTLIVES THE ANSWER (0042 #14: join is not answer), so the
      --     engagement state alone cannot tell a leg that rang out from a
      --     leg somebody picked up. Only `answered_unclassified` and
      --     `human` reach here; `admitted`/`ringing` fall through to the
      --     §4 default exactly as before. Calling an unanswered drop
      --     "abandoned" would be the mirror of the P3 HIGH that called an
      --     answered call `no_answer`.
      --   * IT CHARGES NOTHING. No no-answer budget, no reconnect budget,
      --     no provider budget. A hangup during our own identity line is
      --     not evidence the line is bad, and a reconnect grant is exactly
      --     what `reconnects_used` records -- an "uncharged reconnect" is
      --     not a thing. The engagement returns to `eligible`, a legal
      --     edge out of `dialing`.
      --   * IT IS BOUNDED BY AN INDEX THAT ALREADY EXISTS, not by a new
      --     counter. The attempt keeps today's `ist_date` and its
      --     `initial`/`no_answer_retry`/`scheduled` kind, so
      --     `uq_phone_attempts_one_per_ist_day` refuses the next admission
      --     with `daily_attempt_exists` until the IST day rolls. A gating
      --     counter with no reset lifecycle is the one-way latch this
      --     project has already paid for twice; the per-day index needs no
      --     lifecycle because the day supplies it.
      --
      -- `next_eligible_at` is moved to the next legal instant on the next
      -- IST day for the same reason the provider path does it: the row
      -- must say out loud when it may next be tried rather than looking
      -- eligible now and being refused by an index.
      --
      -- `candidate.deferred_pre_disclosure` is the THIRD member and the one
      -- that is not a hangup: the candidate answered, said "call me later",
      -- and asked for it BEFORE the disclosure. It shares this branch because
      -- it shares every property that matters -- the attempt ends, nothing is
      -- charged, and the engagement leaves `dialing` for a legal state. It is
      -- a DISTINCT event type rather than a reused `sip.participant_left`
      -- because posting "the participant left" about somebody still holding
      -- the handset would be false, and the ledger is the place an operator
      -- goes to find out what actually happened.
      --
      -- It exists because `schedule_phone_appointment` refuses outright while
      -- the engagement is `dialing` (`attempt_in_flight`) -- a live dial owns
      -- the engagement, and rescheduling under it would put the calendar and
      -- the wire into disagreement. So a pre-disclosure "later" must FIRST
      -- end the attempt truthfully and uncharged, and only then book from a
      -- legal state. The alternative -- relaxing the guard -- would trade a
      -- real invariant for the convenience of one code path.
      --
      -- Idempotency needs no special handling. A redelivery carrying the
      -- same `provider_event_id` hits `uq_phone_call_events_provider` and
      -- is answered with the ORIGINAL verdict; a genuinely distinct second
      -- event finds the engagement in `eligible`, matches no branch and is
      -- recorded as `unexpected_event`. Neither loops.
      when v_eng.state = 'dialing'
           and p_event_type in ('sip.participant_left','sip.connection_aborted',
                                'candidate.deferred_pre_disclosure')
           and v_att.state in ('answered_unclassified','human') then
        v_att_state := 'ended'; v_outcome := 'abandoned_pre_disclosure';
        v_new_state := 'eligible'; v_reason := 'abandoned_pre_disclosure';
        v_defer_at  := screening_v2.phone_next_window_open(
                         (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                           at time zone 'Asia/Kolkata');

      -- ── from `in_call` ──────────────────────────────────────────────
      when v_eng.state = 'in_call'
           and p_event_type in ('sip.participant_left','sip.connection_aborted') then
        v_att_state := 'ended'; v_outcome := 'disconnected';
        if v_eng.reconnects_used >= 3 then
          -- #21. Three reconnects have already been GRANTED and used;
          -- this drop earns no fourth. Terminal, and no further charge —
          -- `reconnecting` with an unredeemable budget would be a state
          -- with no outgoing edge and nothing left to drive it.
          v_new_state := 'failed'; v_reason := 'reconnect_budget_exhausted';
        elsif screening_v2.phone_ist_window_open(p_now) then
          -- #19. The charge happens HERE, at the grant, not at the dial:
          -- `reconnects_used` counts drops that have been granted a
          -- reconnect, and the grant that takes it to 3 is precisely the
          -- one being redeemed by the next admission.
          v_new_state := 'reconnecting'; v_charge := 'reconnect';
        else
          -- #20. The boundary is evaluated when the reconnect would be
          -- ACTED ON, not when the disconnect happened. A wait outside
          -- the window charges NOTHING and is deferred to a real slot.
          v_new_state := 'scheduled'; v_defer := true; v_reason := 'window_closed';
        end if;
      -- ── THE STRANDED PATH SETS NO ATTEMPT EDGE ─────────────────
      -- `v_att_state := 'ended'` is right for `in_call`: there is a live
      -- attempt and this event ends it. On the STRANDED path there is no
      -- attempt at all — the sweep posts by ENGAGEMENT, because the
      -- attempt that carried the conversation was reclaimed and ended long
      -- ago. Setting an attempt edge anyway made every stranded post fail
      -- the `attempt_required` guard below, so the whole resolution was
      -- dead code that still reported a healthy sweep. A real-Postgres
      -- test is what caught it; nothing in the SQL reads wrong.
      when (v_eng.state = 'in_call' or v_stranded)
           and p_event_type = 'assessment.completed' then
        -- #22, WITH THE 0044 INTERLOCK (enforced below, before the insert).
        --
        -- 0045 widened the guard to the STRANDED states. This cannot
        -- fabricate a completion: the interlock below still refuses unless
        -- a `source='phone'` assessment row actually exists for the bound
        -- session, so the only engagements this can complete are ones that
        -- really were screened and really were scored. That is the whole
        -- point — a scored screening must reach its engagement without
        -- anybody's phone ringing a second time.
        v_new_state := 'completed';
        v_needs_assessment := true;
        if not v_stranded then
          v_att_state := 'ended'; v_outcome := 'completed';
        end if;
      when (v_eng.state = 'in_call' or v_stranded)
           and p_event_type = 'assessment.aborted' then
        -- Every other `ended` path names an outcome; an operator
        -- filtering on outcome_class must not lose these rows.
        v_new_state := 'failed';
        v_reason := 'assessment_aborted';
        if not v_stranded then
          v_att_state := 'ended'; v_outcome := 'disconnected';
        end if;
      when v_eng.state = 'in_call' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number'; -- #23
        v_reason := 'wrong_number';
      when v_eng.state = 'in_call' and p_event_type = 'candidate.opt_out' then
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24
        v_reason := 'candidate_opt_out';

      -- ── from `awaiting_retry` ───────────────────────────────────────
      -- #28 has no branch here on purpose. The no-answer charge that
      -- lands on 3 goes STRAIGHT to `abandoned_no_answer` (below), so an
      -- `awaiting_retry` engagement always has budget left and a
      -- `budget.exhausted` branch could never fire. An unreachable
      -- branch reads as a safety net and is not one.
      when v_eng.state = 'awaiting_retry' and p_event_type = 'day.rolled'
           and screening_v2.phone_ist_date(p_now)
               > screening_v2.phone_ist_date(coalesce(v_eng.last_attempt_at, p_now)) then
        v_new_state := 'eligible';                                      -- #27

      -- ── from `pending_prereqs` ──────────────────────────────────────
      when v_eng.state = 'pending_prereqs' and p_event_type = 'prereq.satisfied' then
        -- #2. Advisory only: every prerequisite is RE-CHECKED, under a
        -- lock, inside admit_phone_attempt. This edge cannot authorise a
        -- dial on its own.
        v_new_state := 'eligible';

      -- ── from any non-terminal state ─────────────────────────────────
      when p_event_type in ('hr.cancelled','emergency.stop','ashby.stage_left','prereq.lost') then
        v_new_state := 'cancelled';                                     -- #3 / #29
        v_reason    := replace(p_event_type, '.', '_');
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'cancelled';
        end if;

      else
        v_ignored := 'unexpected_event';                                -- the §4 default
    end case;
  end if;

  -- ── An engagement-scoped post cannot drive an attempt-scoped edge ──
  -- Both attempt writes below are guarded by `v_att.id is not null`, and
  -- a guard that SKIPS is not a guard: the engagement half of the
  -- transition would still be applied. `classify.machine` posted with
  -- only an engagement id would charge a no-answer attempt and move to
  -- `awaiting_retry` while leaving the attempt live and holding a fleet
  -- slot; `disclosure.delivered` would bump the engagement's epoch and
  -- not the attempt's, fencing out every later event on that attempt and
  -- leaving a conversation nothing could end.
  --
  -- So the requirement is decided WITH the verdict, before anything is
  -- written, and answered with a stable refusal. Nothing is recorded:
  -- this is a malformed call, not an event that happened.
  if v_ignored is null and v_att.id is null
     and (v_att_state is not null or v_bump_epoch) then
    return jsonb_build_object('status', 'attempt_required',
                              'event_type', p_event_type,
                              'engagement_state', v_eng.state);
  end if;

  -- ── 0044: A COMPLETION CLAIM MUST BE BACKED BY A REAL SCORE ────────
  -- `assessment.completed` takes the engagement to terminal `completed`
  -- with outcome_class = 'completed', which the engagement state, P6's
  -- health backlog and the P7 calendar queue all read as a SCORED
  -- screening. That claim is unrecoverable once committed, so it is
  -- checked here rather than trusted from the worker — the same reason
  -- 0043 put the disclosure gate in attach_phone_attempt_recording
  -- instead of in phone.py: a worker-side ordering rule survives exactly
  -- until someone reorders two awaits.
  --
  -- IT IS A PRE-INSERT REFUSAL, AND THAT IS THE WHOLE POINT. The
  -- `internal` source mints a DETERMINISTIC provider_event_id, so a
  -- recorded refusal would be read back verbatim by every later delivery
  -- of the same claim — and a worker that posted one moment too early
  -- could then never complete the call at all. Recording this would turn
  -- a retryable timing problem into a permanent wedge. So nothing is
  -- written, exactly as for `attempt_required` above, and a re-post once
  -- scoring has landed is a fresh event that applies.
  --
  -- Nothing is charged either: the engagement stays precisely where it
  -- was, with every budget untouched.
  if v_ignored is null and v_needs_assessment
     and (v_eng.session_id is null
          or not exists (
            select 1 from screening_v2.assessments a
             where a.session_id = v_eng.session_id
               and a.source = 'phone')) then
    return jsonb_build_object('status', 'assessment_missing',
                              'event_type', p_event_type,
                              'engagement_state', v_eng.state);
  end if;

  -- ── One INSERT, already carrying the final verdict ─────────────────
  insert into screening_v2.phone_call_events
    (source, provider_event_id, engagement_id, attempt_id, epoch, event_type,
     received_at, applied, ignored_reason, metadata, created_at)
  values
    (p_source, v_event_id,
     case when v_ignored = 'unknown_attempt' then null else v_eng_id end,
     case when v_ignored = 'unknown_attempt' then null else p_attempt_id end,
     p_epoch, p_event_type, p_now, v_ignored is null, v_ignored, v_metadata, p_now)
  on conflict do nothing
  returning id into v_row_id;

  if v_row_id is null then
    -- A duplicate delivery. Read back the ORIGINAL row and hand the
    -- caller exactly the answer the first delivery received, so a
    -- webhook retry storm converges instead of diverging.
    select * into v_existing from screening_v2.phone_call_events
     where source = p_source and provider_event_id = v_event_id;
    return jsonb_build_object(
      'status', case when v_existing.applied then 'applied' else 'ignored' end,
      'applied', v_existing.applied,
      'ignored_reason', v_existing.ignored_reason,
      'event_id', v_existing.id,
      'duplicate', true);
  end if;

  if v_ignored is not null then
    return jsonb_build_object('status', 'ignored', 'applied', false,
                              'ignored_reason', v_ignored,
                              'event_id', v_row_id, 'duplicate', false);
  end if;

  -- ── Apply. Budgets move HERE and nowhere else ──────────────────────
  if v_charge = 'no_answer' then
    if v_eng.no_answer_attempts + 1 >= v_eng.no_answer_limit then
      v_new_state := 'abandoned_no_answer'; v_reason := 'no_answer_budget_exhausted';
    else
      v_new_state := 'awaiting_retry';
    end if;
  elsif v_charge = 'provider' then
    if v_eng.provider_failures + 1 >= 5 then
      v_new_state := 'failed'; v_reason := 'provider_budget_exhausted';
    else
      -- THE PROVIDER BUDGET IS PACED BY THE IST DAY, DELIBERATELY.
      -- The engagement returns to `eligible`, but the failed attempt
      -- keeps kind='initial'/'no_answer_retry' and today's ist_date, so
      -- uq_phone_attempts_one_per_ist_day refuses the next admission
      -- with `daily_attempt_exists` until the IST day rolls. Exhausting
      -- the five-failure budget therefore takes up to five IST days.
      --
      -- That is the choice, not an accident. The alternative — letting a
      -- provider error free the day — would mean an engagement could be
      -- dialled up to six times in one day whenever our transport was
      -- flaky, and the per-day index is an ANTI-HARASSMENT invariant.
      -- We cannot tell from a transport rejection whether the line rang;
      -- fail closed on that uncertainty, at the cost of throughput and
      -- never at the candidate's.
      --
      -- `next_eligible_at` is set to the next legal instant on the next
      -- IST day so the row says out loud when it may next be tried,
      -- rather than looking eligible now and being refused by an index.
      v_new_state := 'eligible';
      v_defer_at  := screening_v2.phone_next_window_open(
                       (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                         at time zone 'Asia/Kolkata');
    end if;
  end if;

  -- #18 bumps the engagement's fencing epoch; the LIVE attempt must
  -- carry the new value, or the fallback above would fence the very
  -- conversation that just started.
  if v_bump_epoch then
    update screening_v2.phone_call_attempts
       set epoch = v_eng.epoch + 1
     where id = v_att.id;
  end if;

  if v_att_state is not null then
    update screening_v2.phone_call_attempts
       set state         = v_att_state,
           outcome_class = coalesce(v_outcome, outcome_class),
           answered_at   = case when v_att_state = 'answered_unclassified'
                                then coalesce(answered_at, p_now) else answered_at end,
           classified_at = case when v_att_state in ('human','machine')
                                then coalesce(classified_at, p_now) else classified_at end,
           ended_at      = case when v_att_state = 'ended' then p_now else ended_at end,
           -- An ended attempt releases its fleet slot immediately; a
           -- freed slot must not wait for a lease to lapse.
           lease_token   = case when v_att_state = 'ended' then null else lease_token end,
           lease_owner   = case when v_att_state = 'ended' then null else lease_owner end
     where id = v_att.id;
  end if;

  -- #20: a window-closed reconnect is parked on a real, legal slot
  -- rather than on a state that merely claims to be scheduled.
  if v_defer then
    v_slot_start := screening_v2.phone_next_window_open(p_now);
    insert into screening_v2.phone_appointments
      (engagement_id, starts_at, ends_at, ist_date, status, source,
       created_by, created_at, updated_at)
    values
      (v_eng.id, v_slot_start, v_slot_start + interval '30 minutes',
       screening_v2.phone_ist_date(v_slot_start), 'scheduled', 'system_deferral',
       '00000000-0000-0000-0000-000000000000'::uuid, p_now, p_now)
    on conflict do nothing;
  end if;

  if v_new_state is not null then
    update screening_v2.phone_engagements
       set state           = v_new_state,
           state_reason    = coalesce(v_reason, state_reason),
           epoch           = case when v_bump_epoch then epoch + 1 else epoch end,
           -- THE reconnect budget. It is reset only when a genuinely NEW
           -- conversation begins — an `initial`, `no_answer_retry` or
           -- `scheduled` dial. Resetting it on a RECONNECT's disclosure
           -- would make "max 3 reconnects" unenforceable: every
           -- reconnect that reached in_call would zero the counter, so
           -- it could never exceed 1, the reconnect-exhaustion refusal
           -- and the #21 `failed` edge would both be dead code, and a
           -- flapping line could be re-dialled without limit. On a
           -- BILLABLE dialer that is the bound that must actually hold.
           reconnects_used = case
                               when v_bump_epoch
                                    and coalesce(v_att.kind, 'initial') <> 'reconnect'
                                 then 0
                               when v_charge = 'reconnect' then reconnects_used + 1
                               else reconnects_used end,
           no_answer_attempts = case when v_charge = 'no_answer'
                                     then no_answer_attempts + 1 else no_answer_attempts end,
           provider_failures  = case when v_charge = 'provider'
                                     then provider_failures + 1 else provider_failures end,
           terminal_at     = case
                               when v_new_state in ('completed','abandoned_no_answer',
                                                    'opted_out','wrong_number','failed','cancelled')
                               then p_now else null end,
           next_eligible_at = case
                                when v_defer then v_slot_start
                                when v_defer_at is not null then v_defer_at
                                else next_eligible_at end,
           version          = version + 1,
           updated_at       = p_now
     where id = v_eng.id;
  end if;
  -- There is deliberately no "charged but no state change" branch: every
  -- path that sets v_charge also sets v_new_state, so such a branch would
  -- be unreachable code pretending to be a safety net.

  -- ── Audit only the outcomes an operator must be able to find ───────
  if v_att_state in ('human','machine') then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_attempt_classified', 'phone_call_attempt', v_att.id::text, 'success',
       jsonb_build_object('engagement_id', v_eng.id, 'classification', v_att_state,
                          'event_type', p_event_type));
  end if;
  -- ── THE SUPPRESSION IS PART OF THE OPT-OUT, NOT A FOLLOW-UP ────────
  -- An opt-out modelled only on the engagement is enforced PER
  -- APPLICATION: the same person applying to a second role would be
  -- dialled again, because the second engagement has its own terminal
  -- state and knows nothing about the first. The obligation follows the
  -- LINE, so it is recorded against the line's digest, and it is
  -- recorded in THIS transaction — a terminal transition that commits
  -- without its suppression is the split this substrate exists to
  -- prevent, and a deferred obligation is documentation, not a control.
  if v_new_state in ('opted_out','wrong_number') then
    select phone_e164 into v_phone
      from screening_v2.candidates where id = v_eng.candidate_id;

    if v_phone is not null then
      v_digest := screening_v2.sha256_hex(v_phone);
      insert into screening_v2.phone_suppressions
        (candidate_id, phone_sha256, reason, source, created_at)
      values
        (v_eng.candidate_id, v_digest,
         case when v_new_state = 'opted_out' then 'candidate_opt_out' else 'wrong_number' end,
         'candidate', p_now)
      -- The line may already be suppressed from an earlier application.
      -- That is the mechanism working, not a conflict to resolve.
      on conflict (phone_sha256) do nothing;
      v_suppressed := true;

      insert into screening_v2.audit_events
        (actor_id, actor_type, action, target_type, target_id, result, metadata)
      values
        ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
         'phone_suppression_added', 'phone_suppression', v_digest, 'success',
         -- The DIGEST is the target id, and there is no number anywhere
         -- in this row. That is the whole point of keying on a digest.
         jsonb_build_object('engagement_id', v_eng.id,
                            'reason', case when v_new_state = 'opted_out'
                                           then 'candidate_opt_out' else 'wrong_number' end,
                            'source', 'candidate'));
    end if;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      -- The one place `candidate` is the truthful actor type: the
      -- outcome originated with the person on the line.
      ('00000000-0000-0000-0000-000000000000'::uuid, 'candidate',
       'phone_opt_out_recorded', 'phone_engagement', v_eng.id::text, 'success',
       -- `suppression_written` is read from what actually happened. An
       -- engagement with no number on record CANNOT suppress a line it
       -- does not know, and saying so is better than implying a control
       -- that was not applied. Such an engagement is also undialable
       -- (admission refuses `phone_invalid`), so the two facts are
       -- coherent — but an operator must be able to see the gap.
       jsonb_build_object('outcome', v_new_state, 'reason', v_reason,
                          'event_type', p_event_type,
                          'suppression_written', v_suppressed));
  end if;

  return jsonb_build_object('status', 'applied', 'applied', true,
                            'ignored_reason', null,
                            'event_id', v_row_id, 'duplicate', false,
                            'engagement_state', coalesce(v_new_state, v_eng.state),
                            'attempt_state', coalesce(v_att_state, v_att.state));
end;
$$;
revoke all on function screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. attach_phone_attempt_recording — bind from ANSWER, not only in_call
-- ═══════════════════════════════════════════════════════════════════════
-- Replaced from its latest 0050 definition. The ONLY change is the
-- engagement-state gate: 0050 refused unless the engagement was already
-- `in_call` (reachable only through `disclosure.delivered`). Parity 2
-- records FROM ANSWER and keeps only what is consented, so binding is now
-- also allowed in the pre-consent ANSWERED state — `dialing` — provided the
-- ATTEMPT is live pre-classification (`answered_unclassified` / `human`).
-- Everything else is byte-identical: the derived-key equality check, the
-- role vocabulary, the manifest/egress guards, the value-idempotency and
-- the authoritative-uniqueness refusal. `admitted`/`ringing` still cannot
-- bind — the attempt must have ANSWERED — and a terminal engagement still
-- refuses. Because binding now precedes consent, the caller's obligation is
-- exactly the header posture: record from answer, keep only if consented,
-- and PURGE on every non-consent exit through the unchanged 0043 purge path
-- (`list_phone_engagement_recordings` / `clear_phone_attempt_recordings`),
-- which enumerates by non-null object key regardless of engagement state.
create or replace function screening_v2.attach_phone_attempt_recording(
  p_attempt_id   uuid,
  p_object_key   text,
  p_manifest_key text,
  p_role         text,
  p_egress_id    text        default null,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
begin
  if p_role is null or p_role not in ('authoritative','supplementary') then
    return jsonb_build_object('status', 'invalid_role');
  end if;
  if p_attempt_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_object_key is distinct from ('phone-' || p_attempt_id::text || '-egress.mp3') then
    return jsonb_build_object('status', 'invalid_object_key');
  end if;
  if p_manifest_key is not null
     and p_manifest_key is distinct from (p_object_key || '.json') then
    return jsonb_build_object('status', 'invalid_manifest_key');
  end if;
  if p_egress_id is not null and p_egress_id !~ '^EG_[A-Za-z0-9_-]{4,200}$' then
    return jsonb_build_object('status', 'invalid_egress_id');
  end if;

  -- Pinned lock order: engagement, then attempt.
  select e.* into v_eng
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
   where a.id = p_attempt_id
     for update of e;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_att from screening_v2.phone_call_attempts
   where id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  -- THE GATE, RELAXED FOR PARITY 2. Binding is allowed once the leg has
  -- ANSWERED: either the pre-consent answered state (`dialing`, the state
  -- held between answer and `disclosure.delivered`) or the post-consent
  -- `in_call` state 0050 already permitted. The ATTEMPT gate below is what
  -- makes `dialing` safe — it admits only an attempt that has actually
  -- answered, never one still `admitted`/`ringing`.
  if v_eng.state not in ('dialing', 'in_call') then
    return jsonb_build_object('status', 'disclosure_not_delivered',
                              'engagement_state', v_eng.state);
  end if;
  if v_att.state not in ('answered_unclassified','human') then
    return jsonb_build_object('status', 'attempt_not_recordable',
                              'attempt_state', v_att.state);
  end if;
  if v_att.recording_object_key is not null then
    if v_att.recording_object_key = p_object_key
       and v_att.recording_role = p_role
       and v_att.recording_manifest_key is not distinct from p_manifest_key then
      return jsonb_build_object('status', 'ok', 'duplicate', true,
                                'attempt_id', v_att.id, 'role', v_att.recording_role);
    end if;
    return jsonb_build_object('status', 'already_bound', 'role', v_att.recording_role);
  end if;

  begin
    update screening_v2.phone_call_attempts
       set recording_object_key   = p_object_key,
           recording_manifest_key = p_manifest_key,
           recording_role         = p_role,
           egress_id              = coalesce(p_egress_id, egress_id),
           egress_status          = case when p_egress_id is not null
                                         then 'active' else egress_status end
     where id = v_att.id;
  exception when unique_violation then
    return jsonb_build_object('status', 'authoritative_exists');
  end;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_recording_attached', 'phone_call_attempt', v_att.id::text, 'success',
     jsonb_build_object('engagement_id', v_eng.id, 'role', p_role,
                        'has_manifest', p_manifest_key is not null));

  return jsonb_build_object('status', 'ok', 'duplicate', false,
                            'attempt_id', v_att.id, 'role', p_role);
end;
$$;

revoke all on function screening_v2.attach_phone_attempt_recording(
  uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.attach_phone_attempt_recording(
  uuid, text, text, text, text, timestamptz) to service_role;
comment on function screening_v2.attach_phone_attempt_recording(
  uuid, text, text, text, text, timestamptz) is
  'Binds an attempt-scoped recording object and manifest. Parity 2 posture: '
  'record from answer, keep only if consented, purge on every non-consent '
  'exit. Binding is allowed once the leg has ANSWERED — the pre-consent '
  '`dialing` answered state as well as the post-consent `in_call` state — '
  'gated by the ATTEMPT being answered_unclassified/human so a leg that is '
  'merely admitted/ringing still cannot bind. A terminal engagement '
  'refuses. Idempotent by value; a differing re-bind is refused rather than '
  'overwritten. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. stamp_phone_session_egress — LEFT UNTOUCHED, and here is why
-- ═══════════════════════════════════════════════════════════════════════
-- The latest definition (0052) gates ONLY on the SESSION status
-- (`waiting` / `in_progress`) and on the candidate/room binding — it never
-- reads the engagement or attempt classification state and never requires a
-- post-consent state. A pre-consent (answered-state) attempt whose session
-- is `waiting` therefore already stamps cleanly, so no relaxation is
-- required and 0052's body is deliberately not re-declared here. Re-issuing
-- it byte-for-byte would only add a fourth copy of a function this migration
-- does not change.

-- ═══════════════════════════════════════════════════════════════════════
-- 5. commit_phone_gate_turns — the pre-consent transcript, written once
-- ═══════════════════════════════════════════════════════════════════════
-- The turns BEFORE the recording disclosure — greeting, "who is this?",
-- the consent exchange — have no durable home today: 0044 only snapshots
-- and appends AFTER `disclosure.delivered`. This RPC appends 1..6 ordered
-- pre-consent turns to `transcript_turns` with `is_gate = true`, so the
-- gate transcript is durable and legibly distinct from the scored
-- assessment turns a question boundary writes.
--
-- ── WHY IT IS SESSION-STATUS GATED, NOT PLAN GATED ────────────────────
-- The gate transcript exists BEFORE any assessment plan; requiring a plan
-- would make it impossible to record the very exchange that precedes the
-- plan. So it only requires a LIVE session (`waiting` or `in_progress`) —
-- the same window `start_phone_assessment` and `stamp_phone_session_egress`
-- accept — and it takes the SESSION lock only, so its lock set is a strict
-- prefix of every assessment RPC's and it cannot deadlock against them.
--
-- ── IDEMPOTENT AT THE GATE, NOT PER EVENT ─────────────────────────────
-- The gate transcript is written ONCE. If any `is_gate = true` row already
-- exists for the session, this returns `already_recorded` and writes
-- nothing — a redelivery of the whole gate, not a per-boundary event, so
-- the guard is existence of a gate row rather than a source_event_id
-- register. `p_source_event_id` is still validated in shape for symmetry
-- with the boundary RPC and to name the delivery in a future audit.
--
-- ── TURN INDEXING CONTINUES, NEVER COLLIDES ───────────────────────────
-- Turns are appended at coalesce(max(turn_index), -1) + 1 for the session,
-- exactly as `commit_phone_question_boundary` does, so gate turns and a
-- later assessment boundary share one monotonic sequence and never collide.
--
-- ── THE TIMING ANCHOR IS COERCED, NEVER FATAL ────────────────────────
-- `turn_started_at_ms` is optional. Unlike the boundary RPC, an
-- out-of-range or non-numeric anchor here is set to NULL rather than
-- refusing the whole gate: losing the pre-consent transcript over a bad
-- millisecond value would be the worse failure. The 0026 CHECK
-- (0 < v < 4102444800000) is the bound; anything outside it, or of the
-- wrong JSON type, becomes NULL and the turn is written.

create or replace function screening_v2.commit_phone_gate_turns(
  p_session_id      uuid,
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
  v_sess   screening_v2.call_sessions%rowtype;
  v_item   jsonb;
  v_speaker text;
  v_text   text;
  v_count  integer;
  v_base   integer;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  -- The SESSION row lock, and nothing above it — a strict prefix of the
  -- assessment RPCs' lock order, so this can never deadlock against them.
  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  -- ── SHAPE FIRST, so a malformed body is answered truthfully ────────
  if p_source_event_id is null
     or p_source_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_turns is null
     or jsonb_typeof(p_turns) <> 'array' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;
  v_count := jsonb_array_length(p_turns);
  -- A gate transcript is short: at least one exchange, at most six.
  if v_count < 1 or v_count > 6 then
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
  end loop;

  -- ── The session must be LIVE ───────────────────────────────────────
  if v_sess.status not in ('waiting','in_progress') then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  -- ── IDEMPOTENT AT THE GATE: write the gate transcript once ─────────
  if exists (
    select 1 from screening_v2.transcript_turns
     where session_id = p_session_id and is_gate = true) then
    return jsonb_build_object('status', 'already_recorded');
  end if;

  -- ── Append, continuing the session's one turn sequence ─────────────
  -- One statement, so any bad turn takes the whole set. The timing anchor
  -- is COERCED to NULL when it is absent, of the wrong JSON type, or
  -- outside the 0026 CHECK window (0 < v < 4102444800000) — never fatal.
  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  insert into screening_v2.transcript_turns
    (session_id, turn_index, speaker, text, is_gate, created_at, turn_started_at_ms)
  select p_session_id,
         v_base + (t.ord - 1)::integer,
         t.value ->> 'speaker',
         btrim(t.value ->> 'text'),
         true,
         p_now,
         case
           when jsonb_typeof(t.value -> 'turn_started_at_ms') = 'number'
                and (t.value ->> 'turn_started_at_ms') ~ '^[1-9][0-9]{0,15}$'
                and (t.value ->> 'turn_started_at_ms')::numeric < 4102444800000
             then (t.value ->> 'turn_started_at_ms')::bigint
           else null
         end
    from jsonb_array_elements(p_turns) with ordinality as t(value, ord);

  return jsonb_build_object('status', 'ok', 'turns_written', v_count);
end;
$$;

revoke all on function screening_v2.commit_phone_gate_turns(uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_gate_turns(uuid, text, jsonb, timestamptz)
  to service_role;
comment on function screening_v2.commit_phone_gate_turns is
  'Appends 1..6 ordered PRE-CONSENT (gate) transcript turns for a live '
  'phone session, flagged is_gate = true and distinct from the scored '
  'assessment turns a question boundary writes. Idempotent at the gate: a '
  'session that already carries any is_gate row returns already_recorded '
  'and writes nothing. Turn indexes continue the session''s one monotonic '
  'sequence. An invalid turn_started_at_ms is coerced to NULL, never '
  'fatal. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';
