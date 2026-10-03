-- =====================================================================
-- 0113 — Phone answer gate and callback-leg detach (M009 / S02, PR-B).
--
-- FORWARD-ONLY. Sections, each in its own clearly delimited block:
--
--   E6  apply_phone_event — one new ledger branch for the worker's
--       pre-answer verdicts (call.no_answer / call.busy / call.failed) from
--       dialing + admitted/ringing with no answer yet. Lifted VERBATIM from
--       0095 (0112 does not redeclare it) and patched only by that branch.
--   E4  confirm_candidate_voice_callback (lifted from 0073) detaches the
--       engagement's bound session and releases the leg's claim;
--       finalize_phone_partial_sessions (lifted from 0095) reports
--       callback_booked and skips expired callback legs;
--       sweep_phone_stranded_sessions (lifted from 0045) skips engagements
--       with a live candidate_voice appointment.
--   E4  Data repair — idempotent; releases claims and nulls session_id on
--       non-terminal scheduled engagements that still hold a session while a
--       live candidate_voice appointment exists. Never touches terminal rows.
--
-- Function ownership (B0, checked on the PR-A base 506873b): the newest
-- bodies are 0095 (apply_phone_event, finalize_phone_partial_sessions), 0073
-- (confirm_candidate_voice_callback) and 0045 (sweep_phone_stranded_sessions);
-- 0112 redeclares none of them.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- E6 — apply_phone_event: the worker's PRE-ANSWER verdicts.
--
-- Lifted VERBATIM from 0095 (the newest body; 0112 does not redeclare it).
-- The ONE change is a new case branch placed immediately before the §4
-- `unexpected_event` default: from `dialing`, with the attempt still
-- `admitted`/`ringing` and `answered_at` null, `call.no_answer` /
-- `call.busy` / `call.failed` end the attempt as no_answer / busy /
-- provider_error and charge through the existing budget ladder (no_answer,
-- no_answer, provider) exactly as the provider's `sip.originate_*` edges do.
-- Signature, SECURITY DEFINER, pinned search_path and the 0067 ACL are
-- unchanged; the ACL is restated below as 0067 last did, so the grant cannot
-- drift. The assessment.completed / stranded logic and the `sip.originate_*`
-- branches are untouched.
-- ─────────────────────────────────────────────────────────────────────

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

      -- #27b (0095). THE SAME-DAY SECOND CHANCE. Before this edge the ONLY
      -- way out of `awaiting_retry` was the IST day rolling, so a candidate
      -- whose phone was in a pocket at 10am waited until tomorrow. Now an
      -- unanswered dial is retried once more the SAME day, after
      -- `phone_same_day_retry_delay()`.
      --
      -- Deliberately a DIFFERENT event from `day.rolled`, not a widening of
      -- it: `day.rolled` means "a new day began", and a same-day retry must
      -- not be able to masquerade as one. The IST-date equality below is the
      -- mirror of #27's inequality, so exactly one of the two can ever fire.
      -- `admit_phone_attempt` still enforces the two-dial ceiling, so this
      -- edge cannot produce a third dial even if posted repeatedly.
      when v_eng.state = 'awaiting_retry' and p_event_type = 'retry.same_day_due'
           and v_eng.last_attempt_at is not null
           and screening_v2.phone_ist_date(p_now)
               = screening_v2.phone_ist_date(v_eng.last_attempt_at)
           and p_now >= v_eng.last_attempt_at
                        + screening_v2.phone_same_day_retry_delay() then
        v_new_state := 'eligible';
        v_reason    := 'same_day_retry_due';

      -- ── from `pending_prereqs` ──────────────────────────────────────
      when v_eng.state = 'pending_prereqs' and p_event_type = 'prereq.satisfied' then
        -- #2. Advisory only: every prerequisite is RE-CHECKED, under a
        -- lock, inside admit_phone_attempt. This edge cannot authorise a
        -- dial on its own.
        v_new_state := 'eligible';

      -- ── from any non-terminal state ─────────────────────────────────
      -- #30 (0095). OUR FAULT, NOT THEIRS — and never confused with a
      -- refusal. Three exits after `call.answered` used to post NOTHING at
      -- all: `consent_start_failed`, `classify_human_failed` and
      -- `disclosure_not_recorded`. The worker returned, the reaper found the
      -- session, and `finalize_phone_partial_sessions` stamped `completed` /
      -- `conversation_complete` — the same transition the happy path uses.
      -- Issue #286: candidate NEELU S was recorded as SCREENED without ever
      -- being asked a question, and could not be redialled without a human
      -- noticing.
      --
      -- This is NOT `disclosure.refused`. A candidate who declines is
      -- terminal and must never be dialled again; a consent gate that broke
      -- because our RPC returned a malformed body is a fault we own, and the
      -- candidate is owed the call they never got. Conflating the two either
      -- redials someone who said no, or abandons someone we failed.
      --
      -- Lands on `awaiting_retry`, so the ordinary retry machinery carries
      -- it: the same-day edge above if the budget allows, otherwise the day
      -- roll. The engagement is NOT terminal and the cycle is NOT closed.
      -- SCOPED TO `dialing`, exactly like `disclosure.refused` (#17) and every
      -- other gate edge. The whole consent gate runs while the engagement is
      -- `dialing`: `classify.human` (#16) moves no state, and
      -- `disclosure.delivered` (#18) is the ONLY edge to `in_call`. So all
      -- three exits that post this event are in `dialing` by construction.
      --
      -- An earlier draft left this unconditional on state. That handed a
      -- buggy or replayed worker post the power to yank a LIVE screening out
      -- of `in_call` and into `awaiting_retry` mid-conversation. It is
      -- reachable: `run_phone_gate` fails OPEN on a `fetch_durable_consent`
      -- error, so a reconnect into an already-consented call can re-run the
      -- gate. Out of `dialing` this is now `unexpected_event` — logged,
      -- recorded, and unable to touch a call in progress.
      when v_eng.state = 'dialing' and p_event_type = 'consent.failed' then
        v_new_state := 'awaiting_retry';                                -- #30
        v_reason    := 'consent_gate_failed';
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'consent_failed';
        end if;

      when p_event_type in ('hr.cancelled','emergency.stop','ashby.stage_left','prereq.lost') then
        v_new_state := 'cancelled';                                     -- #3 / #29
        v_reason    := replace(p_event_type, '.', '_');
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'cancelled';
        end if;

      -- ── from `dialing`, PRE-ANSWER: the worker's ring verdicts (0113 / E6) ─
      -- Until 0113 nothing could record a truthful ring-out or reject. The
      -- worker took SIP-participant PRESENCE for the answer, and LiveKit adds
      -- that participant when it starts DIALING, so every leg was already
      -- `answered_unclassified` before anybody picked up; the `sip.originate_*`
      -- edges are the provider's and the worker may not post them. The worker
      -- now waits for a REAL answer (`sip.callStatus` 'active' or the agent
      -- track being subscribed) and, when none comes, posts exactly one of
      -- these three.
      --
      -- FENCED HERE, NOT ONLY IN THE WORKER. The attempt must still be
      -- PRE-ANSWER -- `admitted`/`ringing` with `answered_at` null -- so no
      -- answered call can ever be charged as a no-answer or a busy, whatever a
      -- buggy or replayed worker posts. Every other shape (answered, already
      -- ended by the reconciler's `sip.originate_timeout`, engagement moved on)
      -- matches nothing and falls through to `unexpected_event`, charging
      -- nothing. The epoch fence above still refuses a superseded leg.
      --
      -- The charges are the provider edges' (#11-#13) exactly, through the one
      -- budget ladder below: a reject is `busy` and a ring-out `no_answer`,
      -- both on the no-answer budget; `call.failed` (a SIP trunk failure) is
      -- `provider_error` on the IST-day-paced provider budget.
      --
      -- DEPENDENCY: this edge is reachable only while nothing moves a ringing
      -- attempt to `answered_unclassified`. The LiveKit webhook maps
      -- participant_joined to `sip.participant_joined` (#14), and the SIP
      -- participant joins at DIALING; enabling that webhook would disarm this
      -- branch, so it must be re-gated first. It is not delivered today.
      when v_eng.state = 'dialing'
           and p_event_type in ('call.no_answer','call.busy','call.failed')
           and v_att.state in ('admitted','ringing')
           and v_att.answered_at is null then
        v_att_state := 'ended';
        v_outcome   := case p_event_type
                         when 'call.busy'   then 'busy'
                         when 'call.failed' then 'provider_error'
                         else 'no_answer'
                       end;
        v_charge    := case p_event_type
                         when 'call.failed' then 'provider'
                         else 'no_answer'
                       end;

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

-- ─────────────────────────────────────────────────────────────────────
-- E4 — confirm_candidate_voice_callback: detach the callback leg.
--
-- Lifted VERBATIM from 0073 (the newest body; 0112 does not redeclare it).
-- The changes: the engagement UPDATE also sets session_id = null; the leg's
-- 0107 engagement claim is released right after it (guarded on this
-- engagement's own claim); and the existing phone_callback_confirmed audit
-- row gains session_detached / claim_released. Signature, advisory lock,
-- idempotent replay, the unique_violation handler and the ACL are unchanged;
-- the ACL is restated so the grant cannot drift.
-- ─────────────────────────────────────────────────────────────────────

create or replace function screening_v2.confirm_candidate_voice_callback(
  p_attempt_id uuid,
  p_starts_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_attempt screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
  v_live screening_v2.phone_appointments%rowtype;
  v_eng_id uuid;
  v_appointment_id uuid;
  v_version integer;
  v_live_count integer;
  v_max constant integer := screening_v2.phone_max_concurrent();
  v_end timestamptz;
  v_day date;
  -- 0113 / E4: the session the engagement was bound to BEFORE this confirm,
  -- and whether the leg's engagement claim was actually released.
  v_bound_session_id uuid;
  v_claim_released boolean := false;
  v_released integer;
begin
  if p_attempt_id is null or p_starts_at is null or p_now is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- Serialize booking decisions with one deterministic lock. This is separate
  -- from the engagement row lock and makes overlapping callback reservations
  -- a real capacity decision rather than an advisory UI projection.
  perform pg_advisory_xact_lock(hashtext('phone_callback_booking'));

  select engagement_id into v_eng_id
    from screening_v2.phone_call_attempts
   where id = p_attempt_id;
  if not found then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  select * into v_eng
    from screening_v2.phone_engagements
   where id = v_eng_id for update;
  if not found or v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal');
  end if;

  select * into v_attempt
    from screening_v2.phone_call_attempts
   where id = p_attempt_id for update;
  if not found or v_attempt.engagement_id <> v_eng.id then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  -- Only an answered, live leg can prove that the candidate confirmed. A
  -- stale/replayed worker cannot close an unrelated attempt.
  if v_attempt.state not in ('answered_unclassified', 'human')
     or v_eng.state not in ('dialing', 'in_call') then
    if exists (
      select 1 from screening_v2.phone_appointments
       where confirmed_from_attempt_id = p_attempt_id
    ) then
      select id, version into v_appointment_id, v_version
        from screening_v2.phone_appointments
       where confirmed_from_attempt_id = p_attempt_id;
      return jsonb_build_object('status', 'already_confirmed',
                                'appointment_id', v_appointment_id,
                                'version', v_version);
    end if;
    return jsonb_build_object('status', 'attempt_in_flight');
  end if;

  if p_starts_at < p_now + interval '5 minutes' then
    return jsonb_build_object('status', 'lead_time_too_short');
  end if;
  if not screening_v2.phone_ist_window_open(p_starts_at) then
    return jsonb_build_object('status', 'window_closed');
  end if;
  if screening_v2.phone_ist_date(p_starts_at) <> screening_v2.phone_ist_date(
       p_starts_at + interval '15 minutes') then
    return jsonb_build_object('status', 'slot_straddles_ist_midnight');
  end if;

  v_day := screening_v2.phone_ist_date(p_starts_at);
  if v_day = screening_v2.phone_ist_date(p_now) then
    -- Preserve the existing per-IST-day contact ledger. The callback is not a
    -- loophole for a second same-day cold call.
    return jsonb_build_object('status', 'slot_not_yet_eligible', 'ist_date', v_day);
  end if;
  if v_eng.next_eligible_at is not null and p_starts_at < v_eng.next_eligible_at then
    return jsonb_build_object('status', 'slot_not_yet_eligible',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;
  if exists (
    select 1 from screening_v2.phone_call_attempts a
     where a.engagement_id = v_eng.id
       and a.ist_date = v_day
       and a.kind in ('initial','no_answer_retry','scheduled')
  ) then
    return jsonb_build_object('status', 'daily_attempt_exists', 'ist_date', v_day);
  end if;

  v_end := p_starts_at + interval '15 minutes';
  select count(*) into v_live_count
    from screening_v2.phone_appointments a
   where a.status in ('scheduled','confirmed')
     and a.starts_at < v_end
     and a.ends_at > p_starts_at
     and a.engagement_id <> v_eng.id;
  if v_live_count >= v_max then
    return jsonb_build_object('status', 'slot_full', 'live', v_live_count,
                              'max_concurrent', v_max);
  end if;

  select * into v_live
    from screening_v2.phone_appointments
   where engagement_id = v_eng.id
     and status in ('scheduled','confirmed')
   for update;

  if found then
    update screening_v2.phone_appointments
       set status = 'superseded', version = version + 1,
           cancel_reason = 'superseded', updated_at = p_now
     where id = v_live.id;
  end if;

  insert into screening_v2.phone_appointments
    (engagement_id, starts_at, ends_at, ist_date, status, source,
     confirmed_at, confirmed_from_attempt_id, created_by, created_at, updated_at)
  values
    (v_eng.id, p_starts_at, v_end, v_day, 'confirmed', 'candidate_voice',
     p_now, p_attempt_id,
     '00000000-0000-0000-0000-000000000000'::uuid, p_now, p_now)
  returning id, version into v_appointment_id, v_version;

  -- End the current leg in the same transaction. This is deliberately not an
  -- assessment completion/score claim and does not charge a no-answer budget.
  update screening_v2.phone_call_attempts
     set state = 'ended', outcome_class = 'disconnected', ended_at = p_now
   where id = p_attempt_id;
  -- 0113 / E4: DETACH the engagement from the leg that just ended. A booked
  -- callback is a deferral, not a screening: left bound, the leg's session was
  -- finalized ~180 s later, scored as a 0-coverage partial, published to Ashby,
  -- and its stranded-shape assessment.completed drove the engagement terminal
  -- `completed` before the callback slot ever arrived. With session_id null
  -- the stranded edges are unreachable for this engagement, and the slot dial
  -- mints a fresh session behind a fresh consent gate.
  v_bound_session_id := v_eng.session_id;
  update screening_v2.phone_engagements
     set state = 'scheduled', state_reason = 'candidate_callback_confirmed',
         session_id = null,
         version = version + 1, updated_at = p_now
   where id = v_eng.id;
  -- ...and RELEASE the leg's 0107 engagement claim. Required even under
  -- 0112's live-only unique index: the leg session is still `in_progress`
  -- (live) until partial-finalize runs, so the slot's createSession would hit
  -- 23505 and the callback would be skipped `no_session`. Guarded on this
  -- engagement's own claim, so no other engagement's claim can be touched.
  -- call_sessions is LAST in the pinned lock order (engagement, appointment,
  -- then sessions), exactly where this statement sits.
  update screening_v2.call_sessions
     set phone_engagement_id = null
   where phone_engagement_id = v_eng.id
     and id in (v_bound_session_id, v_attempt.session_id);
  get diagnostics v_released = row_count;
  v_claim_released := v_released > 0;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_callback_confirmed', 'phone_appointment', v_appointment_id::text,
     'success', jsonb_build_object('engagement_id', v_eng.id,
                                    'source_attempt_id', p_attempt_id,
                                    'duration_seconds', 900,
                                    'ist_date', v_day,
                                    'superseded', v_live.id is not null,
                                    'session_detached', v_bound_session_id is not null,
                                    'claim_released', v_claim_released));

  return jsonb_build_object('status', 'ok', 'appointment_id', v_appointment_id,
                            'version', v_version,
                            'superseded_appointment_id', v_live.id);
exception when unique_violation then
  -- A retry after the first transaction committed is a success, not a second
  -- booking. The unique source-attempt index is the final idempotency fence.
  select id, version into v_appointment_id, v_version
    from screening_v2.phone_appointments
   where confirmed_from_attempt_id = p_attempt_id;
  if v_appointment_id is not null then
    return jsonb_build_object('status', 'already_confirmed',
                              'appointment_id', v_appointment_id,
                              'version', v_version);
  end if;
  raise;
end;
$$;

revoke all on function screening_v2.confirm_candidate_voice_callback(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.confirm_candidate_voice_callback(uuid, timestamptz, timestamptz)
  to service_role;

comment on function screening_v2.confirm_candidate_voice_callback is
  'Confirms one candidate voice callback after explicit affirmative consent. '
  'Reserves exactly fifteen minutes, requires five minutes lead, enforces IST and '
  'capacity rules, preserves the daily-contact ledger, atomically supersedes '
  'the prior live appointment, and closes the current answered leg. Idempotent '
  'by source attempt. 0113: also detaches the engagement from the leg session '
  '(session_id null) and releases that leg''s engagement claim, so the leg is '
  'never scored as the screening and the slot dial mints a fresh session. '
  'Service-role-only.';

-- ─────────────────────────────────────────────────────────────────────
-- E4 — finalize_phone_partial_sessions: report callback_booked.
--
-- Lifted VERBATIM from 0095 (the newest body; 0112 does not redeclare it),
-- with 0072's ACL and comment restated. The changes: the expired /
-- grace_timeout arm skips a leg whose attempt booked a callback (it is never
-- scored, so that arm would re-select it for ever), and each session object
-- carries `callback_booked` (exact confirmed_from_attempt_id match) so the
-- caller skips the scoring enqueue. The in_progress -> completed transition
-- (and so the MP3 trigger), never_started and the limit/order/skip-locked
-- behaviour are unchanged.
-- ─────────────────────────────────────────────────────────────────────

create or replace function screening_v2.finalize_phone_partial_sessions(
  p_limit         integer     default 25,
  p_grace_seconds integer     default 180,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit    integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_grace    integer := greatest(30, least(coalesce(p_grace_seconds, 180), 7200));
  v_row      record;
  v_att      screening_v2.phone_call_attempts%rowtype;
  v_updated  integer;
  v_examined integer := 0;
  v_finalized integer := 0;
  v_skipped  integer := 0;
  v_total    integer;
  v_reason   text;
  v_has_assessment boolean;
  v_never_started  boolean;
  v_recording_present boolean;
  -- 0113 / E4: this leg ended because the candidate booked a callback.
  v_callback_booked boolean;
  v_sessions jsonb := '[]'::jsonb;
begin
  for v_row in
    select s.id as session_id,
           s.current_question_index as covered,
           s.recording_object_key,
           a.id            as attempt_id,
           -- 0095: reported so an operator reading the sweep's output can tie
           -- a finalized session to its engagement without a second query.
           -- Nothing ACTS on it — the draft that posted an engagement event
           -- from the caller is gone with edge #31.
           a.engagement_id as engagement_id,
           a.state         as attempt_state,
           a.outcome_class as attempt_outcome,
           a.ended_at      as attempt_ended_at,
           a.lease_expires_at
      from screening_v2.call_sessions s
      -- The LATEST attempt on this session decides whether the call is over.
      -- A session is adopted across a no-answer ladder, so join the newest by
      -- admitted_at rather than any row.
      join lateral (
        select att.*
          from screening_v2.phone_call_attempts att
         where att.session_id = s.id
         order by att.admitted_at desc
         limit 1
      ) a on true
     where s.mode = 'live'
       and s.started_at is not null
       -- Idempotency + no-re-score, in one predicate: a session that already
       -- carries a phone assessment is NEVER re-selected. This self-terminates
       -- the sweep for a scored session and makes a redundant enqueue
       -- impossible from the SQL side (belt to the dedup-key braces).
       and not exists (
         select 1 from screening_v2.assessments a2
          where a2.session_id = s.id and a2.source = 'phone'
       )
       -- The session must be ENDABLE-but-unscored. Either it is still
       -- `in_progress` (hangup / network drop / crash before 0071's reclaim),
       -- or it is the crash residue 0071 already terminalized to
       -- `expired`/`grace_timeout` (MP3 finalized, scoring never enqueued).
       and (
         s.status = 'in_progress'
         -- 0113 / E4: a callback leg is NEVER scored, so on this arm (which
         -- only an assessment row ever drains) it would be re-selected for
         -- ever and starve real partials out of the window. The in_progress
         -- arm keeps it: that transition is what promotes its MP3.
         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout'
             and not exists (
               select 1 from screening_v2.phone_appointments ap
                where ap.confirmed_from_attempt_id = a.id
             ))
       )
       -- The call is genuinely over, not merely briefly quiet: the attempt is
       -- terminal with an ended_at, OR its lease lapsed in a live state (crash
       -- before reclaim), OR it is `abandoned` (reclaim's crash terminal) with
       -- an ended_at/lease past. In EVERY case the deciding instant must be
       -- older than the grace so a live leg that touched a moment ago is never
       -- taken.
       and (
         (a.state in ('ended','human','machine')
            and a.ended_at is not null
            and a.ended_at <= p_now - (v_grace * interval '1 second'))
         or
         (a.lease_expires_at is not null
            and a.lease_expires_at <= p_now - (v_grace * interval '1 second')
            and a.state in ('admitted','ringing','answered_unclassified','human','machine'))
         or
         (a.state = 'abandoned'
            and coalesce(a.ended_at, a.lease_expires_at) is not null
            and coalesce(a.ended_at, a.lease_expires_at)
                  <= p_now - (v_grace * interval '1 second'))
       )
     order by s.started_at asc
     limit v_limit
     for update of s skip locked
  loop
    v_examined := v_examined + 1;

    -- Coverage: the cursor is the count of questions covered; the plan's
    -- question_count is the total. A session with no plan row yet (should not
    -- happen for a screening that started, but must not abort the sweep)
    -- reports total=null and is still scored.
    select p.question_count into v_total
      from screening_v2.phone_session_plans p
     where p.session_id = v_row.session_id;

    -- disconnect_reason (no PII, one of three fixed tokens):
    --   * 'candidate_hangup' — the attempt ended with outcome 'disconnected'
    --     (the deliberate-hangup path);
    --   * 'worker_crash' — the residue 0071's reclaim produced: the attempt is
    --     `abandoned` (reclaim nulls its outcome_class) or its lease expired in
    --     a live state without a terminal outcome. This is the mode where the
    --     session is already `expired`/`grace_timeout` (or was, before this
    --     sweep saw it) and the MP3 was finalized by reclaim, not by us;
    --   * 'disconnected' — any other genuine end (e.g. an `ended` attempt with
    --     a non-'disconnected' outcome).
    v_reason := case
      when v_row.attempt_outcome = 'disconnected' then 'candidate_hangup'
      when v_row.attempt_state = 'abandoned'
        or (v_row.lease_expires_at is not null
            and v_row.attempt_state in
                ('admitted','ringing','answered_unclassified','human','machine'))
        then 'worker_crash'
      else 'disconnected'
    end;

    -- ── 0095 / issue #286: DID A SCREENING ACTUALLY HAPPEN? ───────────
    -- The sweep already knew — it selects `covered` and reads the plan's
    -- `question_count` — and used neither to decide the terminal state, so
    -- "crashed after eight answers" and "hung up before asking anything"
    -- both landed on `completed` / `conversation_complete`.
    --
    -- The test is DIRECT evidence, not a coverage threshold: did the
    -- CANDIDATE ever say anything outside the gate?
    --
    -- Gate turns (identity, consent) are excluded because they are exactly
    -- what a never-started call DOES have. And the speaker filter is
    -- load-bearing: `commit_phone_item_turn` (0071:179) writes BOTH 'bot'
    -- and 'candidate' turns with is_gate = false, so testing for any
    -- non-gate turn would count the bot ASKING question one as evidence the
    -- candidate answered it. A call that died the instant Q1 was asked would
    -- then be a completed screening — the precise defect this migration
    -- exists to remove, reintroduced one turn later.
    --
    -- Keyed on the candidate it is also the SAFE direction for scoring: if
    -- the candidate contributed no non-gate turn there is, by construction,
    -- nothing to score, so skipping the enqueue can never cost a real
    -- scorecard. Any candidate answer at all — even one — takes the
    -- `completed` branch and scores exactly as it did before 0095.
    select not exists (
      select 1 from screening_v2.transcript_turns t
       where t.session_id = v_row.session_id
         and t.is_gate = false
         and t.speaker = 'candidate'
    ) into v_never_started;

    -- Already-present signals — reported, never gating. The caller's dedup key
    -- makes a redundant enqueue a no-op; the recording flag is for the log.
    select exists (
      select 1 from screening_v2.assessments a
       where a.session_id = v_row.session_id and a.source = 'phone'
    ) into v_has_assessment;
    v_recording_present := v_row.recording_object_key is not null;

    -- 0113 / E4: did this leg end because the candidate CONFIRMED a voice
    -- callback? An EXACT match on the attempt that booked it (unique index),
    -- any appointment status, and deliberately no engagement-level fallback:
    -- an unrelated appointment on the same engagement must never suppress a
    -- real screening's scorecard. The caller skips the scoring enqueue on it.
    select exists (
      select 1 from screening_v2.phone_appointments ap
       where ap.confirmed_from_attempt_id = v_row.attempt_id
    ) into v_callback_booked;

    -- Drive the session terminal, RE-VERIFYING under the lock that it is still
    -- in_progress (the unlocked-ish scan may have raced a live completion).
    -- The SAME transition the worker's happy path uses: completed /
    -- conversation_complete. It fires trg_enqueue_recording_finalize (0038) in
    -- THIS transaction and makes the session eligible for scoring. A row that
    -- is no longer in_progress is left untouched — this covers BOTH the
    -- idempotent re-run (a session already completed) AND the worker-crash
    -- residue this sweep also selects (`expired`/`grace_timeout`, MP3 already
    -- finalized by 0071's reclaim): re-transitioning `expired -> completed` is
    -- not a legal 0006 edge, so we deliberately leave it terminal and report
    -- `transitioned=false`. Its scoring is still owed and still returned below.
    -- ── THE SESSION TRANSITION IS UNCHANGED BY 0095 ───────────────────
    --
    -- An earlier draft drove a never-started session to `failed` /
    -- `screening_never_started`. Three reviews and the repo's own
    -- `phone_partial_finalize_assert.sql` all rejected it, and they were
    -- right. `never_started` is now REPORTED and never acted on here.
    --
    -- Why the status must not move:
    --   * THE SWEEP STARVES ITSELF. The selection admits
    --     `expired`/`grace_timeout` as well as `in_progress`, but this UPDATE
    --     is guarded `status = 'in_progress'`, so that arm is never
    --     re-stamped. It leaves the set only once an assessment row exists.
    --     Skipping the scoring enqueue for these sessions meant no row was
    --     ever written, so they were re-selected for ever — and with
    --     `limit 25` and `order by started_at asc`, 25 of them displace every
    --     REAL partial screening from the window. Those lose both the
    --     scorecard and the terminal transition that drives the MP3.
    --   * THE MP3 LOSES A RECOVERY PATH. The 0038 trigger and the sweeper do
    --     treat `failed` like `completed`, but the download route's
    --     on-demand finalize backstop is `status = 'completed'` only.
    --   * SCORING CHANGES FOR A CLASS THAT HAD IT. The crash-partial pair
    --     (`expired` + `grace_timeout`) is admitted by the eligibility gate,
    --     so such a session was scored before; withholding the enqueue takes
    --     that away without touching the gate, which is what made the change
    --     invisible.
    --   * THE EVIDENCE IS NOT SAFE TO ACT ON. The per-item transcript writer
    --     is fire-and-forget (`agent.py`, `asyncio.create_task`, never
    --     awaited, failures swallowed) and the boundary writer SUPPRESSES its
    --     own insert when any per-item row exists (0086). If the bot's write
    --     lands and the candidate's does not, a real screening reads as
    --     never-started. Good enough to REPORT; not good enough to withhold a
    --     scorecard or redirect a call on.
    --
    -- So the transition below is byte-for-byte what 0072 shipped: the SAME
    -- transition the worker's happy path uses. MP3 and scorecard generation
    -- are therefore untouched by this migration, which is the owner's
    -- explicit constraint.
    update screening_v2.call_sessions s
       set status          = 'completed',
           terminal_reason = 'conversation_complete',
           ended_at        = coalesce(s.ended_at, p_now),
           updated_at      = p_now
     where s.id = v_row.session_id
       and s.status = 'in_progress';
    get diagnostics v_updated = row_count;
    if v_updated = 1 then
      v_finalized := v_finalized + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    -- The selection is returned WHETHER OR NOT the transition landed on this
    -- pass, so the caller enqueues scoring independently of the transition.
    v_sessions := v_sessions || jsonb_build_object(
      'session_id',         v_row.session_id,
      'attempt_id',         v_row.attempt_id,
      'engagement_id',      v_row.engagement_id,
      'covered',            v_row.covered,
      'total',              v_total,
      'disconnect_reason',  v_reason,
      -- The caller reads this to decide whether to enqueue scoring at all.
      -- A never-started session has no non-gate turns; enqueuing it would DLQ
      -- against the eligibility guard and look like a scoring failure rather
      -- than a call that never happened.
      'never_started',      v_never_started,
      'transitioned',       v_updated = 1,
      'assessment_present', v_has_assessment,
      'recording_present',  v_recording_present,
      -- 0113 / E4: true = a callback leg; finalized for its MP3 and
      -- transcript, but never scored, published or used to end the engagement.
      'callback_booked',    v_callback_booked);

    v_total := null;
  end loop;

  return jsonb_build_object(
    'status',        'ok',
    'examined',      v_examined,
    'finalized',     v_finalized,
    'skipped',       v_skipped,
    'limit',         v_limit,
    'grace_seconds', v_grace,
    'sessions',      v_sessions);
end;
$$;

revoke all on function screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.finalize_phone_partial_sessions is
  'Partial-finalize sweeper (0072): finds phone sessions left in_progress '
  'whose call is genuinely over (latest attempt terminal or lease-expired) '
  'past a short reconnect grace, drives each to completed/conversation_complete '
  'so the 0038 finalize trigger promotes the attempt MP3, and returns the '
  'coverage/attempt facts so the caller can enqueue PARTIAL scoring '
  'independently. Selection is on session-ended, not egress state, so the '
  'scorecard lands even when egress produced nothing. Idempotent and '
  'self-limiting; charges no budget. Service-role-only.';

-- ─────────────────────────────────────────────────────────────────────
-- E4 — sweep_phone_stranded_sessions: a booked callback is not stranded.
--
-- Lifted VERBATIM from 0045, INCLUDING the comment block between p_now and
-- p_grace_seconds, which the RPC-contract extractor relies on (it yields
-- [p_limit, p_now], as rpc-contract.ts pins). The one change: engagements
-- with a live candidate_voice appointment are not selected.
-- ─────────────────────────────────────────────────────────────────────

create or replace function screening_v2.sweep_phone_stranded_sessions(
  p_limit         integer     default 25,
  p_now           timestamptz default now(),
  -- ── THE GRACE, AND WHY IT IS NOT OPTIONAL ─────────────────────────
  -- A first draft of this sweep raced a LIVE RECOVERY and won with
  -- probability ~1. `/assessment/complete` completes the session BEFORE it
  -- awaits scoring, so a scoring outage leaves exactly the shape this sweep
  -- reads as "stranded, unscored": a `completed` session with no assessment
  -- row. The engagement is meanwhile in `reconnecting` with a reconnect
  -- already GRANTED AND CHARGED, and it cannot be redialled for
  -- `reconnectBackoffSeconds`. The sweep ran at 120s with no idle backoff,
  -- fired first, posted `assessment.aborted`, and made a transient scoring
  -- outage a permanently terminal-`failed` candidate — destroying the
  -- documented retry path the agent already implements.
  --
  -- So nothing is resolved until the engagement AND its session have both
  -- been still for this long. A granted reconnect touches `updated_at`, so
  -- the grace restarts and the live path always wins. 15 minutes is well
  -- past the 120s reconnect plus a due pass, and it is the difference
  -- between "we are recovering" and "nothing is coming".
  p_grace_seconds integer     default 900
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_limit     integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_grace     integer := greatest(60, least(coalesce(p_grace_seconds, 900), 86400));
  v_row       record;
  v_result    jsonb;
  v_event     text;
  v_examined  integer := 0;
  v_completed integer := 0;
  v_failed    integer := 0;
  v_skipped   integer := 0;
begin
  for v_row in
    select e.id,
           e.session_id,
           exists (
             select 1 from screening_v2.assessments a
              where a.session_id = e.session_id
                and a.source = 'phone'
           ) as scored
      from screening_v2.phone_engagements e
      join screening_v2.call_sessions s on s.id = e.session_id
     where e.terminal_at is null
       and e.state in ('eligible','scheduled','reconnecting')
       and e.session_id is not null
       and s.status in ('completed','failed','cancelled','expired')
       -- Both clocks, and the LATER of them. A session that ended long ago
       -- says nothing if the engagement moved a second ago.
       and greatest(coalesce(s.ended_at, s.started_at), e.updated_at)
           <= p_now - (v_grace * interval '1 second')
       -- 0113 / E4: a candidate who booked a voice callback is WAITING for
       -- it, not stranded. The bound session (a legacy pre-0113 confirm, or
       -- the in-call /schedule-callback route that does not detach) is the
       -- deferred leg, and resolving it would terminate the engagement before
       -- the slot. system_deferral / hr_manual appointments keep today's
       -- behaviour.
       and not exists (
         select 1 from screening_v2.phone_appointments ap
          where ap.engagement_id = e.id
            and ap.source = 'candidate_voice'
            and ap.status in ('scheduled','confirmed')
       )
     order by e.updated_at asc
     limit v_limit
  loop
    v_examined := v_examined + 1;
    -- "Scored" here means exactly what it means everywhere else in this
    -- schema: a `source='phone'` assessment row exists. `overall_score`
    -- and `recommendation` are nullable and are deliberately NOT part of
    -- the test — introducing a second definition of scored would put this
    -- sweep and 0044's interlock into disagreement.
    v_event := case when v_row.scored then 'assessment.completed'
                    else 'assessment.aborted' end;

    v_result := screening_v2.apply_phone_event(
      p_source            => 'internal',
      p_event_type        => v_event,
      p_attempt_id        => null,
      p_engagement_id     => v_row.id,
      p_provider_event_id => 'stranded:' || v_row.session_id::text || ':' || v_event,
      p_epoch             => null,
      p_metadata          => null,
      p_now               => p_now
    );

    if (v_result ->> 'status') is not distinct from 'applied'
       and (v_result ->> 'ignored_reason') is null
       and not coalesce((v_result ->> 'duplicate')::boolean, false) then
      if v_row.scored then v_completed := v_completed + 1;
      else v_failed := v_failed + 1;
      end if;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status',    'ok',
    'examined',  v_examined,
    'completed', v_completed,
    'failed',    v_failed,
    'skipped',   v_skipped,
    'limit',     v_limit,
    'grace_seconds', v_grace
  );
end;
$$;

revoke all on function screening_v2.sweep_phone_stranded_sessions(integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function screening_v2.sweep_phone_stranded_sessions(integer, timestamptz, integer) to service_role;

comment on function screening_v2.sweep_phone_stranded_sessions is
  'Bounded driver for the 0045 stranded-session edges. A terminal session with '
  'a phone assessment row completes its engagement without anybody being '
  'redialled; one without becomes a truthful failed. Decides nothing itself — '
  'apply_phone_event re-checks the interlock under the row lock. Resolves '
  'nothing until the engagement AND its session have both been still for '
  'p_grace_seconds, so it can never win a race against a live recovery whose '
  'reconnect has already been granted and charged. Idempotent '
  'per session. Service-role-only.';

-- ─────────────────────────────────────────────────────────────────────
-- E4 — one-time data repair (idempotent; 0 rows expected in production).
--
-- A non-terminal `scheduled` engagement with a live candidate_voice
-- appointment that is STILL bound to a session is the pre-0113 confirm shape:
-- left alone, its leg is scored as the screening and the slot dial is
-- refused. Release the claim first (it is found through the binding), then
-- detach. Terminal engagements are never touched (the 0042 trigger makes them
-- immutable anyway). A second run matches nothing.
--
-- MIRRORED: the two statements between the markers are replayed verbatim by
-- policy_tests.sql (0113-E4-repair), and a vitest pins that the copy cannot
-- drift from this text.
-- ─────────────────────────────────────────────────────────────────────

-- >>> 0113-E4-REPAIR
update screening_v2.call_sessions s
   set phone_engagement_id = null
  from screening_v2.phone_engagements e
 where s.phone_engagement_id = e.id
   and s.id = e.session_id
   and e.terminal_at is null
   and e.state = 'scheduled'
   and exists (
     select 1 from screening_v2.phone_appointments ap
      where ap.engagement_id = e.id
        and ap.source = 'candidate_voice'
        and ap.status in ('scheduled','confirmed')
   );

update screening_v2.phone_engagements e
   set session_id = null, version = e.version + 1, updated_at = now()
 where e.terminal_at is null
   and e.state = 'scheduled'
   and e.session_id is not null
   and exists (
     select 1 from screening_v2.phone_appointments ap
      where ap.engagement_id = e.id
        and ap.source = 'candidate_voice'
        and ap.status in ('scheduled','confirmed')
   );
-- <<< 0113-E4-REPAIR


notify pgrst, 'reload schema';
