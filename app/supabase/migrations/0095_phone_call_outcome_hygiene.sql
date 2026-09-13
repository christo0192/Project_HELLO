-- 0095 — CALL-OUTCOME HYGIENE: a call is recorded as what it actually was.
--
-- Closes issue #286 and the dialer changes the owner asked for on 2026-09-13.
--
-- THE DEFECT (#286). A call that died at the consent gate was recorded as a
-- COMPLETED SCREENING. Candidate NEELU S, 2026-09-10: the consent/start RPC
-- returned a malformed response, the worker logged `consent_start_failed` and
-- returned WITHOUT POSTING ANY EVENT, the reaper picked the session up, and
-- `finalize_phone_partial_sessions` stamped `completed` /
-- `conversation_complete` — the same transition the happy path uses. She is now
-- "screened" in the funnel, counted in every report, and will not be redialled
-- without a manual rescreen. The failure was OURS and the retry needs a human to
-- notice it.
--
-- The sweeper already SELECTS `current_question_index as covered` and the plan's
-- `question_count`. It knew how far the call got and did not use it.
--
-- WHAT THIS MIGRATION CHANGES
--
--   1. Two dials per IST day, not one — so a no-answer gets a second chance the
--      SAME day (+5h) instead of waiting until tomorrow.
--   2. A consent gate that fails because of OUR fault is retryable and is NOT
--      recorded as completed. A consent gate the candidate REFUSES stays
--      terminal and is never redialled — those two must never be conflated.
--   3. A call that passed consent but dropped before finishing the Q&A is not
--      recorded as completed, and is redialled to finish.
--   4. `finalize_phone_partial_sessions` stops calling a never-started session
--      a completed screening.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CHANGE
--
--   * MP3 finalization. `trg_enqueue_recording_finalize` fires on
--     `status IN ('completed','failed','cancelled','expired')` — ANY terminal
--     status. Every new path below lands inside that set, so recordings finalize
--     exactly as they do today.
--   * Scorecard generation. `assessment.ts` gates on
--     (`completed` + `conversation_complete`) or the crash-partial
--     (`expired` + `grace_timeout`). Both shapes are preserved untouched. A
--     session that never reached a question has nothing to score and is
--     correctly not scored; a session WITH captured answers keeps the exact
--     status/reason pair scoring already accepts.
--
--   The new truth about how far a call got is carried on the ENGAGEMENT and the
--   ATTEMPT, which is where the funnel and the dialer read it — not on the
--   session fields the recording and scoring pipelines key on.


-- ── 1. TWO DIALS PER IST DAY, ENFORCED BY THE SCHEMA ──────────────────
--
-- `uq_phone_attempts_one_per_ist_day` permitted exactly ONE attempt per
-- engagement per IST day, and 0043 calls that an ANTI-HARASSMENT invariant. It
-- is, and it stays one — the number moves from 1 to 2 and stays enforced by the
-- database rather than by the callers.
--
-- A per-day SEQUENCE with a CHECK, rather than a counted predicate in
-- `admit_phone_attempt`, is the point: a third same-day dial is physically
-- impossible no matter what any caller does. Counting in code would make the
-- guarantee a property of today's callers, which is the failure mode this lane
-- has hit repeatedly.

alter table screening_v2.phone_call_attempts
  add column if not exists ist_day_seq smallint;

-- Backfill. Every existing row is the first (and under the old index, only)
-- dial of its IST day, so 1 is correct by construction, not by assumption.
update screening_v2.phone_call_attempts
   set ist_day_seq = 1
 where ist_day_seq is null;

alter table screening_v2.phone_call_attempts
  alter column ist_day_seq set default 1;

alter table screening_v2.phone_call_attempts
  alter column ist_day_seq set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_phone_attempts_ist_day_seq'
  ) then
    alter table screening_v2.phone_call_attempts
      add constraint chk_phone_attempts_ist_day_seq
      check (ist_day_seq between 1 and 2);
  end if;
end $$;

-- The replacement index carries the SAME partial predicate as the one it
-- replaces, including 0094's `infra_deferred` exemption: an attempt abandoned
-- because our own infrastructure deferred it never consumed the candidate's
-- day and must not block the next dial.
-- DAILY-DIAL-CAP SANCTION (TST-15). The index is REPLACED, not removed: the
-- statement below re-creates the same invariant over the same rows with a
-- per-day sequence, so coverage does not shrink — an engagement still cannot
-- exceed its daily ceiling, the ceiling is 2 instead of 1, and
-- `chk_phone_attempts_ist_day_seq` makes a third physically impossible.
-- 0083 carried the matching INDEX-NARROW SANCTION on this same index.
drop index if exists screening_v2.uq_phone_attempts_one_per_ist_day;

create unique index if not exists uq_phone_attempts_per_ist_day_seq
  on screening_v2.phone_call_attempts (engagement_id, ist_date, ist_day_seq)
  where kind = any (array['initial','no_answer_retry','scheduled'])
    and (state <> 'abandoned' or abandon_reason is distinct from 'infra_deferred');

comment on column screening_v2.phone_call_attempts.ist_day_seq is
  'Which dial of the IST day this is (1 or 2). CHECK-bounded, so a third '
  'same-day dial is impossible regardless of caller. Replaces the '
  'one-per-day unique index; the anti-harassment invariant is unchanged in '
  'kind, only in number.';

-- ── 2. HOW LONG A NO-ANSWER WAITS FOR ITS SECOND CHANCE ───────────────

create or replace function screening_v2.phone_same_day_retry_delay()
returns interval
language sql
immutable
as $$
  -- Five hours. Long enough that the second dial is a genuinely different part
  -- of the candidate's day (a morning miss retries after lunch) rather than
  -- pestering, and short enough to land inside the same calling window.
  select interval '5 hours';
$$;

comment on function screening_v2.phone_same_day_retry_delay() is
  'Gap between the first dial and the same-day no-answer retry.';

-- ── 3. THE VOCABULARY THE NEW EDGES NEED ──────────────────────────────
--
-- Every terminal label in this schema lives in a closed CHECK allowlist, and
-- a CHECK cannot be extended in place — it is dropped and re-declared IN
-- FULL. Both constraints below are re-declared with their existing members
-- copied verbatim and the new ones appended, exactly as 0043 and 0042 did
-- before. NO PRIOR MEMBER IS REMOVED; a diff of these blocks against 0043:91
-- and 0042:1143 should show additions only.
--
-- Without this section the edges added in section 4 do not fail a test — they
-- raise `check_violation` at runtime, on the first real call that hits them.

-- 3a. phone_call_attempts.outcome_class — two new terminal outcomes.
alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_outcome;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_outcome check (
    outcome_class is null or outcome_class in (
      'completed','disconnected','no_answer','busy','voicemail','declined',
      'wrong_number','opt_out','provider_error','window_closed','cancelled',
      'abandoned_pre_disclosure',
      -- 0095, additive. Kept as two labels, not one, because they are two
      -- different failures with two different owners, and merging them would
      -- make the distinction unrecoverable after the fact:
      --   * `consent_failed` — the gate itself broke (our RPC, our judge, our
      --     classifier). NOT a refusal; `declined` already carries that, is
      --     terminal, and must never be dialled again.
      --   * `screening_not_started` — the gate PASSED and the call still died
      --     before a single question was asked.
      'consent_failed','screening_not_started'))
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_outcome;

comment on constraint chk_phone_call_attempts_outcome
  on screening_v2.phone_call_attempts is
  'Closed outcome allowlist, extended ADDITIVELY by 0043 with '
  '`abandoned_pre_disclosure` and by 0095 with `consent_failed` and '
  '`screening_not_started`. No prior member has ever been removed.';

-- 3b. call_sessions.terminal_reason — the never-started session's reason.
--
-- Added to the `failed` family, which is the whole point of the change: a
-- session that never reached a question must not wear a `completed` status.
-- MP3 is unaffected — `trg_enqueue_recording_finalize` fires on
-- status IN ('completed','failed','cancelled','expired'), so `failed`
-- finalizes the recording exactly as `completed` did. Scoring is unaffected
-- because `assessment.ts` admits only ('completed','conversation_complete')
-- or ('expired','grace_timeout'), and this pair is neither — correctly, as
-- there are no answers to score.
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
        'residency_timeout',
        -- 0095: consent passed, the call then ended before question one.
        'screening_never_started'
      )
    )
    or
    (
      status = 'cancelled'
      and terminal_reason in (
        'recruiter_cancelled', 'migrated_abandoned',
        'duplicate_session', 'shutdown_drain',
        'candidate_opt_out', 'wrong_number'
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

comment on constraint chk_call_sessions_terminal_reason on screening_v2.call_sessions is
  'Family-structured terminal-reason allowlist, extended ADDITIVELY by 0042 '
  'with the two cancelled pairs and by 0095 with '
  '("failed","screening_never_started"). voicemail_detected is deliberately '
  'absent: no session is bound before human classification, so a '
  'machine-answered attempt has no session to terminalise.';

-- ── 4. THE THREE FUNCTIONS, PATCHED ──────────────────────────────────
--
-- Lifted verbatim from the migrations that last defined them (0094, 0067,
-- 0072) and patched surgically, so the parts NOT being changed are
-- byte-identical to what is running. The build asserted every anchor
-- matched exactly once.

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
  -- 0095: which dial of the IST day this admission would be (1 or 2).
  v_day_seq        integer;
  v_apt_id         uuid;
  v_max_concurrent constant integer := screening_v2.phone_max_concurrent();
  v_day_dials      integer;
  v_max_daily      constant integer := screening_v2.phone_max_daily_dials();
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
  -- ── 0094: SUPPRESSION IS CHECKED ON THE LINE **AND** ON THE PERSON ──
  -- The digest half is 0042's and is unchanged: it is what makes a
  -- do-not-call promise survive the person applying to a second role, and
  -- what covers a household or reassigned line.
  --
  -- The `candidate_id` half is new, and it closes a hole that the retiring
  -- allowlist was incidentally covering. `phone_suppressions` keys on the
  -- digest of the number AT THE TIME THE PROMISE WAS MADE, while
  -- `verify_candidate_phone` (0057) rewrites `candidates.phone_e164` for an
  -- arbitrary candidate with no suppression check at all. So: candidate opts
  -- out in-call, HR later corrects a typo in the number, the new digest
  -- matches nothing, and the person who said "never call me" is dialable
  -- again. Under `allowlist` that could not happen automatically, because the
  -- corrected number ALSO had to be hand-pasted into PHONE_DIAL_ALLOWLIST
  -- before anything could dial it, and a human was in that loop.
  -- `PHONE_DIAL_SCOPE=pipeline` removes the human, so the check has to be
  -- here instead.
  --
  -- The two halves are an OR, deliberately: either the line is suppressed or
  -- this person is, and both refuse. A row whose `candidate_id` was NULLed by
  -- the FK's ON DELETE SET NULL still refuses on the digest half.
  if exists (select 1 from screening_v2.phone_suppressions
              where phone_sha256 = v_digest
                 or candidate_id = v_eng.candidate_id) then
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
                    -- NULL-SAFE: see the index predicate. Reclaim rows have
                    -- abandon_reason NULL; NOT(... AND NULL) is NULL and would
                    -- silently uncount them. IS DISTINCT FROM keeps them charged.
                    and (state <> 'abandoned'
                         or abandon_reason is distinct from 'infra_deferred')) then
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
       -- NULL-SAFE: see the index predicate (reclaim rows carry NULL reason).
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred')
  ) then
    return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                              'ist_date', v_ist_date);
  end if;

  -- ── 0094: THE FLEET DAILY CAP ──────────────────────────────────────
  -- The blast-radius control that lets `PHONE_DIAL_SCOPE=pipeline` retire
  -- the per-number allowlist. Until now the only thing bounding how many
  -- DISTINCT people the dialer could ring in a day was that an operator had
  -- to paste each number's digest into `PHONE_DIAL_ALLOWLIST` by hand.
  -- `phone_max_concurrent()` bounds SIMULTANEITY, not VOLUME: ten at a time,
  -- all day, is thousands of calls.
  --
  -- It lives HERE, inside the sole grantor, under the same advisory lock as
  -- every other guard, for the reason `phone-screening/config.ts` states
  -- about knobs generally: a cap enforced in TypeScript is decoration. Any
  -- other caller bypasses it, and two API replicas racing would each read a
  -- count below the cap and both admit. Counted under
  -- `pg_advisory_xact_lock(hashtext('phone_admission'))`, count-then-refuse
  -- is atomic by construction.
  --
  -- COUNTED, NEVER STORED. Derived from `phone_call_attempts` at decision
  -- time, so there is no counter to drift, to reset at IST midnight, or to
  -- leave wrong after a manual row change.
  --
  -- ── WHY THIS SITS BEFORE THE CONCURRENCY CAP ───────────────────────
  -- Both refusals can be true at once, and the caller is told only the first.
  -- `at_capacity` clears BY ITSELF as live calls end; `fleet_daily_cap_reached`
  -- clears at IST midnight and not before. Reporting the self-clearing one
  -- first sends an operator to wait for calls to finish that will not help —
  -- the precise misreport `rpc-contract.ts` promises this status will not
  -- make. The one that clears LAST is the one that must be reported.
  --
  -- ── `reconnect` IS EXCLUDED ────────────────────────────────────────
  -- Load-bearing rather than cosmetic. A reconnect redeems a budget already
  -- charged at the grant (apply_phone_event #19); refusing it would strand
  -- the engagement in `reconnecting` with no edge out — the cap would be
  -- enforced by wedging rows rather than by declining calls. Same reasoning
  -- the no-answer budget above states for itself.
  --
  -- ── `scheduled` IS COUNTED BUT NEVER REFUSED ───────────────────────
  -- This is the distinction Guard B above spends a paragraph on, and an
  -- earlier draft of this block got it wrong in the direction that breaks a
  -- promise. A scheduled dial is NOT a cold call: it is a slot the candidate
  -- or HR booked, and `schedule_phone_appointment` sources it `hr_manual` or
  -- `candidate_voice`. Refusing it means the candidate agreed to a time,
  -- nobody rang, and the appointment sat `scheduled` until the expiry sweep
  -- marked it `missed` — with the only signal a counter on a health page,
  -- which is the exact failure shape this whole migration exists to end.
  --
  -- It is still COUNTED, because it is a real billable call and the ceiling
  -- is about spend and blast radius. So a day full of booked slots can push
  -- the count past the ceiling and stop COLD calls, which is right: the
  -- people who asked to be called still are, and the people who did not are
  -- not rung by a runaway.
  --
  -- The infra-defer narrowing matches the per-engagement and per-candidate
  -- daily pre-checks and the 0083 index predicate exactly: a pool hiccup
  -- that placed no call must not spend the fleet's day. Reclaim rows carry
  -- a NULL `abandon_reason` and IS DISTINCT FROM keeps them counted, because
  -- those calls did reach somebody.
  --
  -- THE DAY KEY IS `p_now`, not the machine clock, exactly like every other
  -- guard in this function. That is a deliberate, structurally-enforced
  -- property (`phone-screening-rpc-contract.test.ts` asserts no RPC body
  -- reads the clock), and it means the ceiling is only as strong as the
  -- caller's clock: a caller supplying a date inside the IST window gets that
  -- date's budget. Production has exactly one caller and it passes the real
  -- instant. Anything that backfills or replays MUST pass the true `p_now`,
  -- or it will both mint a fresh budget and write a wrong `ist_date` into the
  -- per-IST-day uniqueness index.
  if p_kind in ('initial','no_answer_retry') then
    select count(*) into v_day_dials
      from screening_v2.phone_call_attempts
     where ist_date = v_ist_date
       and kind in ('initial','no_answer_retry','scheduled')
       and (state <> 'abandoned'
            or abandon_reason is distinct from 'infra_deferred');
    if v_day_dials >= v_max_daily then
      return jsonb_build_object('status', 'fleet_daily_cap_reached',
                                'ist_date', v_ist_date,
                                'dials_today', v_day_dials,
                                'max_daily', v_max_daily);
    end if;
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

  -- WHICH DIAL OF THE DAY THIS IS. Counted under the same advisory lock
  -- that serialises admission, over exactly the rows the unique index
  -- covers — so the count and the index can never disagree. 0094's
  -- `infra_deferred` exemption is honoured here too: an attempt our own
  -- infrastructure deferred never consumed the candidate's day.
  select coalesce(max(a.ist_day_seq), 0) + 1 into v_day_seq
    from screening_v2.phone_call_attempts a
   where a.engagement_id = p_engagement_id
     and a.ist_date = v_ist_date
     and a.kind = any (array['initial','no_answer_retry','scheduled'])
     and (a.state <> 'abandoned'
          or a.abandon_reason is distinct from 'infra_deferred');

  if v_day_seq > 2 then
    -- The anti-harassment invariant, refused in the open rather than as an
    -- index violation, so the caller learns WHY. 0043 held this at one dial
    -- per IST day; 0095 moves it to two (an initial and one same-day
    -- no-answer retry) and not one more.
    return jsonb_build_object('status', 'daily_attempt_exists',
                              'dials_today', v_day_seq - 1,
                              'max_per_day', 2);
  end if;

  v_lease_token   := gen_random_uuid();
  v_lease_expires := p_now + (greatest(5, least(coalesce(p_lease_seconds, 60), 900))
                              * interval '1 second');

  begin
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, ist_date, ist_day_seq,
       prior_engagement_state, lease_token, lease_owner, lease_expires_at,
       admitted_at, created_at)
    values
      (p_engagement_id, v_seq, v_eng.epoch, p_kind, 'admitted', v_ist_date,
       v_day_seq, v_eng.state, v_lease_token, p_lease_owner, v_lease_expires,
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
      when p_event_type = 'consent.failed' then
        v_new_state := 'awaiting_retry';                                -- #30
        v_reason    := 'consent_gate_failed';
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'consent_failed';
        end if;

      -- #31 (0095). CONSENT PASSED, BUT NO SCREENING EVER HAPPENED.
      -- The other half of the owner's 2026-09-13 ask: a candidate who
      -- picked up and consented, and whose call then died before a single
      -- question was asked, is NOT screened and must be called back.
      --
      -- `finalize_phone_partial_sessions` now proves this from the
      -- transcript — no non-gate turn — and drives the session
      -- `failed` / `screening_never_started`. That fixes the SESSION's
      -- story. Without this edge the ENGAGEMENT's story stays wrong: the
      -- sweep posts nothing, so the engagement sits in `in_call` until a
      -- reaper or a scoring write-back closes it, and the candidate is
      -- never dialled again.
      --
      -- Deliberately NOT `assessment.aborted` (#22's sibling), which is
      -- terminal `failed`. A scoring run that aborted really is the end of
      -- the road; a call that never reached a question is a call we still
      -- owe. Same destination as #30 for the same reason — `awaiting_retry`
      -- hands it to the ordinary retry machinery: the same-day edge #27b if
      -- the day's budget allows, otherwise the day roll.
      --
      -- Unconditional on state, exactly as #30 is, and safe for the same
      -- reason: the `terminal_at is not null -> 'terminal'` guard above
      -- already refuses every terminal engagement before this case is
      -- reached, so this can neither resurrect a closed engagement nor
      -- raise from the immutability trigger. The only poster is the partial
      -- sweep, once per session, and only for a session it has just proven
      -- carries no non-gate turn.
      when p_event_type = 'screening.not_started' then
        v_new_state := 'awaiting_retry';                                -- #31
        v_reason    := 'screening_never_started';
        if v_att.id is not null and v_att.state in
           ('admitted','ringing','answered_unclassified','human','machine') then
          v_att_state := 'ended'; v_outcome := 'screening_not_started';
        end if;

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
  v_sessions jsonb := '[]'::jsonb;
begin
  for v_row in
    select s.id as session_id,
           s.current_question_index as covered,
           s.recording_object_key,
           a.id            as attempt_id,
           -- 0095: returned so the CALLER can post `screening.not_started`.
           -- It is posted from the caller and NOT from inside this loop on
           -- purpose: this sweep holds `for update of s` on call_sessions,
           -- which is LAST in the pinned lock order, and `apply_phone_event`
           -- locks the engagement and the attempt. Calling it here would take
           -- engagement-after-session and invert that order against every
           -- other writer — a deadlock, not a test failure.
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
         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout')
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
    -- The test is the DIRECT evidence the issue names: a session with no
    -- non-gate transcript turn never reached a question. Gate turns
    -- (identity, consent) are excluded because they are exactly what a
    -- never-started call DOES have.
    select not exists (
      select 1 from screening_v2.transcript_turns t
       where t.session_id = v_row.session_id
         and t.is_gate = false
    ) into v_never_started;

    -- Already-present signals — reported, never gating. The caller's dedup key
    -- makes a redundant enqueue a no-op; the recording flag is for the log.
    select exists (
      select 1 from screening_v2.assessments a
       where a.session_id = v_row.session_id and a.source = 'phone'
    ) into v_has_assessment;
    v_recording_present := v_row.recording_object_key is not null;

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
    -- A session that never reached a question is driven to `failed` /
    -- `screening_never_started` instead of `completed` /
    -- `conversation_complete`.
    --
    -- WHAT THIS DELIBERATELY PRESERVES:
    --   * MP3 — `trg_enqueue_recording_finalize` fires on
    --     status IN ('completed','failed','cancelled','expired'), so `failed`
    --     finalizes the recording exactly as `completed` did.
    --   * SCORING — `assessment.ts` admits only
    --     (`completed` + `conversation_complete`) or the crash-partial
    --     (`expired` + `grace_timeout`). `failed` is admitted by neither, which
    --     is correct: there are no non-gate turns, so there is nothing to
    --     score. A session WITH captured answers still takes the branch below
    --     and keeps the exact pair scoring accepts.
    --   * `in_progress -> failed` is a legal edge in
    --     `enforce_session_transition`.
    update screening_v2.call_sessions s
       set status          = case when v_never_started then 'failed'
                                  else 'completed' end,
           terminal_reason = case when v_never_started
                                  then 'screening_never_started'
                                  else 'conversation_complete' end,
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
      'recording_present',  v_recording_present);

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

-- ── 5. THE SWEEP THAT NOTICES A SAME-DAY RETRY IS DUE ─────────────────
--
-- The mirror of `sweep_phone_day_rolled`, and deliberately a separate function
-- rather than a widening of it. That sweep asks "has a new day begun?"; this one
-- asks "have five hours passed?" — different questions, different dedup keys,
-- and neither can answer for the other.

create or replace function screening_v2.sweep_phone_same_day_retry(
  p_limit integer default 25,
  p_now   timestamp with time zone default now()
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'screening_v2'
as $function$
declare
  v_limit    integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_row      record;
  v_result   jsonb;
  v_released integer := 0;
  v_examined integer := 0;
  v_skipped  integer := 0;
begin
  for v_row in
    select e.id,
           screening_v2.phone_ist_date(p_now) as today
      from screening_v2.phone_engagements e
     where e.state = 'awaiting_retry'
       and e.terminal_at is null
       and e.last_attempt_at is not null
       -- SAME IST day — the mirror of the day-roll sweep's inequality, so an
       -- engagement is claimed by exactly one of the two.
       and screening_v2.phone_ist_date(p_now)
           = screening_v2.phone_ist_date(e.last_attempt_at)
       -- And the wait has actually elapsed.
       and p_now >= e.last_attempt_at
                    + screening_v2.phone_same_day_retry_delay()
       -- The day's dial budget is not already spent. Checked here as well as in
       -- `admit_phone_attempt` so the sweep does not post an event it knows the
       -- admission will refuse — that would burn the dedup id on a no-op and
       -- leave the engagement looking released when nothing can dial.
       and (
         select coalesce(max(a.ist_day_seq), 0)
           from screening_v2.phone_call_attempts a
          where a.engagement_id = e.id
            and a.ist_date = screening_v2.phone_ist_date(p_now)
            and a.kind = any (array['initial','no_answer_retry','scheduled'])
            and (a.state <> 'abandoned'
                 or a.abandon_reason is distinct from 'infra_deferred')
       ) < 2
     order by e.last_attempt_at asc
     limit v_limit
  loop
    v_examined := v_examined + 1;

    v_result := screening_v2.apply_phone_event(
      p_source            => 'internal',
      p_event_type        => 'retry.same_day_due',
      p_attempt_id        => null,
      p_engagement_id     => v_row.id,
      -- Keyed on the DAY, so two replicas sweeping concurrently collapse to one
      -- release, and a re-run after the release is a duplicate rather than a
      -- second dial.
      p_provider_event_id => 'sameday:' || v_row.id::text || ':' || v_row.today::text,
      p_epoch             => null,
      p_metadata          => null,
      p_now               => p_now
    );

    -- `applied`, not `ok` — `apply_phone_event`'s success word. And the
    -- `duplicate` flag matters: a raced replica replays the ORIGINAL verdict,
    -- which is indistinguishable from fresh work without it.
    if (v_result ->> 'status') is not distinct from 'applied'
       and (v_result ->> 'ignored_reason') is null
       and not coalesce((v_result ->> 'duplicate')::boolean, false) then
      v_released := v_released + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status',   'ok',
    'examined', v_examined,
    'released', v_released,
    'skipped',  v_skipped,
    'limit',    v_limit
  );
end;
$function$;

comment on function screening_v2.sweep_phone_same_day_retry(integer, timestamptz) is
  'Releases an awaiting_retry engagement for its SECOND dial of the same IST '
  'day, once phone_same_day_retry_delay() has elapsed. The day-roll sweep '
  'handles the next-day case; the two are mutually exclusive by IST date.';
