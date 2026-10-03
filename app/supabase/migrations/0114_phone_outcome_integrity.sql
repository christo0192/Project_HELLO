-- =====================================================================
-- 0114 — Phone outcome integrity (M009 / S03, PR-C). C1-C10.
--
-- FORWARD-ONLY. ONE migration with numbered sections (R1): Supabase versions
-- migrations by prefix, so the per-design filenames of the research became
-- the section names below. Each section is filled ONLY by the task that owns
-- it, strictly between its `-- ==== 0114 §N BEGIN ====` / `END` markers.
--
--   §1  Constraints (C0). chk_phone_call_attempts_outcome + 'callback_deferred'
--       (C2); chk_audit_action + phone_engagement_late_completed (C2),
--       phone_scheduled_engagement_released (C5), phone_identity_hold_release
--       (C8), phone_due_starved (C10). Both re-created as the newest full list
--       plus the new members, NOT VALID then VALIDATE (R7).
--   §2  Ledger: apply_phone_event (C1 consent.resumed continuation + drop
--       race, C2 callback.deferred_in_call, C7 mid-call opt-out) and
--       enforce_phone_engagement_transition (C2 late-score exception, C7
--       reconnecting/scheduled -> opted_out).
--   §3  Outcome consistency (C2, C7): phone_attempt_score_suppression (new),
--       finalize_phone_partial_sessions (R9),
--       complete_phone_engagement_after_late_score (new),
--       sweep_phone_stranded_sessions.
--   §4  Assessment evidence gate (C3): assessments.evidence_* columns, CHECKs,
--       index, backfill, and the candidate-status repair (the only DML).
--   §5  Appointment truthfulness (C5): expire_phone_appointments,
--       schedule_phone_appointment.
--   §6  Person identity guards (C8): admit_phone_attempt,
--       ensure_ashby_phone_engagement, schedule_candidate_phone_appointment,
--       phone_identity_hold_releases + release_phone_identity_hold,
--       idx_v2_candidates_email_norm.
--   §7  request_phone_rescreen drift (C6).
--   §8  Halt provenance / operational visibility (C10): set_phone_halt,
--       clear_phone_halt, admit_phone_test_attempt SET, direct-write audit
--       trigger on phone_control.
--
-- Binding consolidation decisions (S03-RESEARCH.md section 1): R1 one
-- migration; R2 each function redeclared ONCE, lifted from its newest
-- declaration; R3 consent.resumed bumps the epoch, leaves the attempt state,
-- never resets reconnects_used; R4 post-consent gate failures post nothing;
-- R5 the C7 window_closed guard is "every live appointment is
-- system_deferral"; R6 no event_type CHECK change (regex only); R7
-- chk_audit_action restated once, here; R8 two new non-retryable halts
-- (worker); R9 one finalize body; R10 line_already_offered is benign for the
-- starvation classifier; R11 rollback notes now say "forward 0115+, lifted
-- from 0114"; R12 the support path is
-- app/api/src/__tests__/support/phone-migration.ts; R13 the old-worker window
-- between the API and worker deploys.
--
-- Function ownership (C0, checked on c2d2c90 = PR-A 0112 + PR-B 0113 with
-- `grep -lE "function screening_v2\.<fn>\b" migrations/*.sql | tail -1`):
--   apply_phone_event, finalize_phone_partial_sessions,
--   sweep_phone_stranded_sessions ............................ 0113
--   enforce_phone_engagement_transition ........................ 0045
--   admit_phone_attempt ........................................ 0095
--   ensure_ashby_phone_engagement, request_phone_rescreen ...... 0057
--   schedule_phone_appointment, expire_phone_appointments,
--   clear_phone_halt ........................................... 0042
--   schedule_candidate_phone_appointment ....................... 0058
--   set_phone_halt ............................................. 0110
--   admit_phone_test_attempt ................................... 0063
--   chk_audit_action 0102; chk_phone_call_attempts_outcome 0095.
-- 0112 and 0113 add no audit action and no attempt outcome.
-- NOT redeclared here: confirm_candidate_voice_callback (PR-B),
-- reclaim_phone_attempt_leases, claim_voice_worker, reset_voice_worker,
-- set_voice_worker_agent_name (PR-A), bind_phone_attempt_recording_session.
--
-- Conventions for every section: `$$` bodies; `timestamptz` spelled out; no
-- machine-clock reads (use p_now); `set search_path = pg_catalog,
-- screening_v2`; execute granted to service_role only; call_sessions last in
-- the lock order; no PII in any log, audit row or returned jsonb.
-- =====================================================================

-- Fail fast rather than queue: §1 re-creates CHECKs on audit_events and
-- phone_call_attempts, §4 adds columns and CHECKs on assessments, and later
-- sections replace functions live admission calls. A long wait to ACQUIRE a
-- lock should fail this deploy (it retries cleanly), not stall live
-- screening. LOCAL: scoped to the migration's transaction (0109/0112
-- precedent).
--
-- LOCK IMPACT (deploy note). `supabase db push` runs this file in ONE
-- transaction, and every lock is held until COMMIT. The ACCESS EXCLUSIVE
-- locks taken by the ALTER TABLEs on audit_events (§1b), phone_call_attempts
-- (§1a) and assessments (§4) therefore last for the WHOLE migration — the
-- VALIDATE scans (a full scan of audit_events), the §4 backfill and repair,
-- and every later function body — not "briefly". For that duration every
-- audit insert (auditOrFail routes, login/RBAC audits, worker-route audits)
-- and every read or write of those three tables (recruiter dashboards
-- included) queues behind the lock. Deploy outside recruiter hours and
-- outside the IST calling window, with the lane halted. NOT VALID + VALIDATE
-- is kept only for parity with 0102/0109; inside one transaction it buys no
-- concurrency.
set local lock_timeout = '10s';


-- ==== 0114 §1 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §1a — chk_phone_call_attempts_outcome + 'callback_deferred' (C2).
--
-- Lifted by script from 0095 (the newest re-creation); the ONLY change is the
-- new member. `callback_deferred` is the outcome of a leg on which the
-- candidate asked, mid-interview, to be called back (§2 C2-a): it is neither
-- `completed` (no screening happened) nor `declined` (terminal refusal).
-- Additive: no prior member is removed.
-- ─────────────────────────────────────────────────────────────────────
alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_outcome;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_outcome check (
    outcome_class is null or outcome_class in (
      'completed','disconnected','no_answer','busy','voicemail','declined',
      'wrong_number','opt_out','provider_error','window_closed','cancelled',
      'abandoned_pre_disclosure',
      -- 0095, additive: the consent gate itself BROKE — our RPC returned a
      -- malformed body, our classifier errored, our disclosure was never
      -- recorded. Deliberately NOT `declined`, which means the candidate
      -- refused, is terminal, and must never be dialled again. Conflating
      -- them either redials someone who said no or abandons someone we
      -- failed, and the distinction is unrecoverable after the fact.
      --
      -- A sibling label `screening_not_started` was drafted for "the gate
      -- passed and the call still died before question one" and DROPPED: the
      -- only available evidence for it is the transcript, whose writer is
      -- fire-and-forget, so the label would have been applied to real
      -- screenings. This schema does not carry vocabulary with no trustworthy
      -- writer — see 0042's note on `voicemail_detected`.
      'consent_failed',
      -- 0114 (C2), additive: the candidate asked in-call to be called back.
      'callback_deferred'))
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_outcome;

comment on constraint chk_phone_call_attempts_outcome
  on screening_v2.phone_call_attempts is
  'Closed outcome allowlist, extended ADDITIVELY by 0043 with '
  '`abandoned_pre_disclosure`, by 0095 with `consent_failed` and by 0114 '
  'with `callback_deferred`. No prior member has ever been removed.';

-- ─────────────────────────────────────────────────────────────────────
-- §1b — chk_audit_action: the newest full list (0102) + four actions (R7).
--
-- Lifted by script from 0102. Re-created whole, never by dropping a member:
-- every writer of an existing action depends on it. The four additions are
-- written by later sections of this file; restating the CHECK once, here,
-- first, is what keeps the first such insert from aborting the migration.
-- `not valid` then `validate`, the 0102 pattern. NOTE: inside this one
-- migration transaction the ACCESS EXCLUSIVE lock the ADD takes is held until
-- COMMIT, so it also covers the VALIDATE scan and everything after it; audit
-- inserts block for the whole migration (see LOCK IMPACT at the top).
-- ─────────────────────────────────────────────────────────────────────
alter table screening_v2.audit_events drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events add constraint chk_audit_action check (
  action = any (array[
    'invite_sent','invite_revoked','invite_consumed','grant_issued','grant_revoked',
    'grant_consumed','screening_started','screening_completed','screening_failed',
    'assessment_recorded','candidate_status_changed','candidate_consent_updated',
    'session_created','session_updated','session_terminated','membership_created',
    'membership_updated','membership_deactivated','role_created','role_updated',
    'role_deactivated','export_requested','export_completed','login_success',
    'login_failure','logout','config_changed','auth_login_success','auth_login_failure',
    'auth_token_refresh','auth_logout','rbac_access_denied','rbac_ownership_denied',
    'resource_create','resource_read','resource_update','resource_delete','resource_list',
    'rate_limit_exceeded','audit_sink_failure','audit_configuration_error',
    'recording_download','recording_upload','recording_integrity_verified',
    'recording_quarantined','recording_revoked','recording_deleted',
    'admin_session_override','admin_maintenance_toggle','admin_member_update',
    'quota_override','notification_create','appeal_create','appeal_review',
    'allowlist_linked','admin_allowlist_add','admin_allowlist_update',
    'ashby_mapping_update','ashby_mapping_drift','ashby_application_cancel',
    'ashby_operation_enqueue','ashby_operation_update','ashby_operation_retry',
    'ashby_writeback_pending','ashby_invite_delivered','ashby_ingestion_attempts_reset',
    'ashby_ingestion_parse_recovery','ashby_ingestion_legacy_bad_output_recovery',
    'phone_attempt_admitted','phone_attempt_classified','phone_attempt_ended',
    'phone_appointment_scheduled','phone_appointment_cancelled','phone_appointment_missed',
    'phone_opt_out_recorded','phone_suppression_added','phone_recording_attached',
    'phone_rescreen_requested','phone_number_reverified','phone_test_gate_armed',
    'phone_test_gate_consumed','phone_callback_confirmed','phone_callback_recovery_required',
    'ashby_ingestion_model_degraded_recovery','phone_suppression_released',
    -- 0097
    'ashby_ingestion_midflight_resume',
    -- 0102
    'resource_generate',
    -- 0114
    'phone_engagement_late_completed','phone_scheduled_engagement_released',
    'phone_identity_hold_release','phone_due_starved'
  ])
) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;

-- `drop constraint` also drops its COMMENT; re-set it with the new marker.
comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed audit vocabulary through 0114. Widen ONLY by re-creating this '
  'constraint with the full list plus the new action(s), never by dropping '
  'members — every writer of an existing action depends on it.';
-- ==== 0114 §1 END ====


-- ==== 0114 §2 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §2 — Ledger (S2): apply_phone_event and enforce_phone_engagement_transition.
--
-- apply_phone_event is LIFTED BY SCRIPT from 0113 (the newest declaration:
-- 0095 + PR-B's E6 pre-answer branch), so E6 and every 0095/0045/0044 line
-- survive byte-identical. Signature, SECURITY DEFINER, pinned search_path and
-- the service_role-only ACL are unchanged. Every 0114 hunk sits between
-- `-- ▼ 0114 <id>` / `-- ▲ 0114 <id>` comment markers, except two
-- one-line edits a vitest pins by name: the reconnects_used reset now keys on
-- `v_reset_reconnects` (C1-c) and the trigger's allowed lists gain
-- `opted_out` (C7 (i)).
--   C1-a  unlocked consented-live read (dialing, bound session claiming the
--         engagement, a plan for the engagement, session in_progress);
--   C1-b  R1 dialing + internal consent.resumed -> in_call, epoch bump, attempt
--         state and reconnect budget unchanged; R0 in_call no-op; the
--         drop-race backstop (the in_call drop body, verbatim). Placed before
--         the 0095 pre-disclosure drop branch; disjoint from E6, which needs
--         a pre-answer attempt;
--   C1-c  only disclosure.delivered resets reconnects_used;
--   C1-d  R1 binds attempt.session_id to the continued session;
--   C2-a  in_call callback.deferred_in_call -> eligible at the next IST-day
--         window (or failed/callback_deferral_limit on the 3rd), uncharged,
--         session detached and its 0107 claim released;
--   C7-a  candidate.opt_out that lost the race to the drop (reconnecting, or
--         scheduled/window_closed with only system_deferral slots, R5);
--   C7-b  opted_out / wrong_number cancel the bound in_progress session.
-- enforce_phone_engagement_transition is LIFTED from 0045 (newest); the
-- trigger binding (0042) is unchanged. Hunks: (i) scheduled/reconnecting ->
-- opted_out (C7); (ii) the single exact-column-guarded late-score exception
-- to terminal immutability (C2-P5).
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
  -- ▼ 0114 C1-a/C2 declare
  -- C1 (R3): the unlocked consented-live continuation read below.
  v_consent_session_status text;
  v_consented_live         boolean := false;
  -- C1: ONLY disclosure.delivered resets reconnects_used now; consent.resumed
  -- bumps the epoch without resetting the reconnect budget.
  v_reset_reconnects       boolean := false;
  -- C2: callback.deferred_in_call detaches the leg's session (E4 precedent).
  v_detach_session         boolean := false;
  -- ▲ 0114 C1-a/C2 declare
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
  -- ▼ 0114 C1-a consent read
  -- ── IS THIS DIAL A CONTINUATION OF A CONSENTED, LIVE SESSION? (C1) ──
  -- A reconnect leg, or any redial into the engagement's live session,
  -- adopts that session and its room, and the worker's gate finds durable
  -- consent and asks nothing again. `admit_phone_attempt` put the engagement
  -- in `dialing`, and `disclosure.delivered` is never posted for such a leg,
  -- so before 0114 the whole resumed conversation ran in `dialing`: its
  -- completion and abort were `unexpected_event` and its drop was labelled
  -- abandoned_pre_disclosure (83ce56fb, e6bc7f18, fd9b54f0).
  --
  -- A continuation is recognised ONLY when all of these hold: the engagement
  -- is non-terminal `dialing`; the post names an attempt; the engagement is
  -- bound to a session that CLAIMS this engagement (0107
  -- phone_engagement_id); a phone_session_plans row exists for the
  -- engagement (the plan is snapshotted only after consent); and that
  -- session is `in_progress`. A completed, failed, expired or cancelled
  -- session is never continued, and with NO plan PR-A's A2 pin holds (the
  -- 0095 pre-disclosure branch below is unchanged).
  --
  -- UNLOCKED, exactly like the 0045 stranded read above: call_sessions is
  -- LAST in the pinned lock order, and the value only selects between
  -- edges the engagement transition trigger re-checks.
  if v_eng_id is not null
     and v_eng.state = 'dialing'
     and v_eng.terminal_at is null
     and p_attempt_id is not null
     and v_att.id is not null
     and v_eng.session_id is not null then
    select s.status into v_consent_session_status
      from screening_v2.call_sessions s
     where s.id = v_eng.session_id
       and s.phone_engagement_id = v_eng.id
       and exists (select 1 from screening_v2.phone_session_plans p
                    where p.engagement_id = v_eng.id);
    v_consented_live := coalesce(v_consent_session_status = 'in_progress', false);
  end if;
  -- ▲ 0114 C1-a consent read

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
        -- ▼ 0114 C1-c
        -- The reset is keyed on THIS flag, not on v_bump_epoch: C1's
        -- consent.resumed also bumps the epoch but continues a conversation.
        v_reset_reconnects := true;
        -- ▲ 0114 C1-c
      when v_eng.state = 'dialing' and p_event_type = 'candidate.wrong_number' then
        v_new_state := 'wrong_number'; v_att_state := 'ended'; v_outcome := 'wrong_number';
        v_reason := 'wrong_number';

      -- ▼ 0114 C1-b
      -- ── from `dialing`, a CONTINUATION of a consented, live session (C1) ──
      -- R1. The resumed leg's worker posts `consent.resumed` (internal only)
      -- once its answer is confirmed. The conversation CONTINUES: the
      -- engagement returns to `in_call` and the fencing epoch is bumped on
      -- the engagement and this attempt, so late posts from the previous leg
      -- are refused as stale exactly as after disclosure.delivered. The
      -- attempt state is NOT changed (no classification is forged) and the
      -- reconnect budget is NOT reset (R3). The attempt is bound to the
      -- continued session below.
      when v_eng.state = 'dialing' and p_event_type = 'consent.resumed'
           and p_source = 'internal'
           and v_att.state in ('answered_unclassified','human')
           and v_consented_live then
        v_new_state := 'in_call'; v_bump_epoch := true;
      -- R0. Already continued (or disclosed) on this live attempt: an
      -- applied no-op, so a worker retry converges instead of being recorded
      -- as unexpected. The same event id is deduped by the ledger anyway.
      when v_eng.state = 'in_call' and p_event_type = 'consent.resumed'
           and p_source = 'internal'
           and v_att.state in ('answered_unclassified','human') then
        null;
      -- The DROP RACE. A continuation leg that drops before R1 lands (about
      -- 1-3 s) is still a consented candidate dropping mid-conversation:
      -- the in_call drop body below, VERBATIM (charge a reconnect, #21
      -- budget exhausted, #20 window-closed deferral). With no plan, or a
      -- session that is not live, the pre-disclosure branch below applies.
      when v_eng.state = 'dialing'
           and p_event_type in ('sip.participant_left','sip.connection_aborted')
           and v_att.state in ('answered_unclassified','human')
           and v_consented_live then
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
      -- ▲ 0114 C1-b
      -- ▼ 0114 C1-e
      -- ── a continuation leg whose consent.resumed was NOT recorded (C1) ──
      -- The worker fails OPEN when R1 does not apply (answer unconfirmed, a
      -- timeout, a transport error): the conversation continues while the
      -- engagement stays `dialing`. The candidate's withdrawal or callback
      -- request on that leg must still land, or the session would be
      -- partial-scored on the PREVIOUS leg's attempt (the 4352df89 shape).
      -- Same gate as R1 (internal, answered/human attempt, consented-live
      -- session), and the in_call bodies VERBATIM: #24 opt-out (its suppression
      -- row and the C7-b session cancel follow below) and the C2-a deferral
      -- (uncharged, session detached, 3rd = callback_deferral_limit). The
      -- attempt is bound to the continued session (C1-d).
      when v_eng.state = 'dialing' and p_event_type = 'candidate.opt_out'
           and p_source = 'internal'
           and v_att.state in ('answered_unclassified','human')
           and v_consented_live then
        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24
        v_reason := 'candidate_opt_out';
      when v_eng.state = 'dialing' and p_event_type = 'callback.deferred_in_call'
           and p_source = 'internal'
           and v_att.state in ('human','answered_unclassified')
           and v_consented_live then
        v_att_state := 'ended'; v_outcome := 'callback_deferred';
        v_detach_session := true;
        if (select count(*) from screening_v2.phone_call_events ev
             where ev.engagement_id = v_eng.id
               and ev.event_type = 'callback.deferred_in_call'
               and ev.applied) >= 2 then
          v_new_state := 'failed'; v_reason := 'callback_deferral_limit';
        else
          v_new_state := 'eligible'; v_reason := 'callback_deferred_in_call';
          v_defer_at  := screening_v2.phone_next_window_open(
                           (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                             at time zone 'Asia/Kolkata');
        end if;
      -- The RECONCILER now reports a vanished participant on an answered
      -- `dialing` leg, so the drop-race branch above has a production producer
      -- (the webhook is not delivered in production). Outside a consented-live
      -- continuation that report is recorded and NOT applied: a pre-consent
      -- answered leg keeps today's path (the worker's own E3 departure post,
      -- else reclaim, charging nobody). The webhook and worker sources still
      -- reach the 0043 pre-disclosure branch below unchanged (PR-A's A2 pin).
      when v_eng.state = 'dialing' and p_source = 'reconciliation'
           and p_event_type in ('sip.participant_left','sip.connection_aborted')
           and v_att.state in ('answered_unclassified','human')
           and not v_consented_live then
        v_ignored := 'unexpected_event';
      -- ▲ 0114 C1-e
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
      -- ▼ 0114 C7-a
      -- ── a mid-call withdrawal that LOST THE RACE to the drop (C7) ──────
      -- The worker posts candidate.opt_out after the candidate withdrew, but
      -- the provider's drop usually lands first and moves the engagement out
      -- of `in_call`. Only that exact shape is accepted: an internal post
      -- naming the engagement's LATEST attempt, which the drop ended as
      -- `disconnected`, at the current epoch, while the engagement waits on
      -- that drop's reconnect -- `reconnecting`, or `scheduled/window_closed`
      -- whose live appointments are ALL the drop's own system_deferral slot
      -- (R5: #20 always inserts one; they are cancelled below). Any HR- or
      -- candidate-sourced live appointment means a human booked a call, so
      -- this does not apply. Nothing is charged and the attempt is not
      -- touched; the suppression block below records the line opt-out.
      when p_event_type = 'candidate.opt_out'
           and p_source = 'internal'
           and p_attempt_id is not null
           and v_att.id is not null
           and v_att.engagement_id = v_eng.id
           and v_att.state = 'ended'
           and v_att.outcome_class = 'disconnected'
           and (p_epoch is null or p_epoch = v_eng.epoch)
           and v_att.id = (select a.id from screening_v2.phone_call_attempts a
                            where a.engagement_id = v_eng.id
                            order by a.admitted_at desc, a.attempt_seq desc
                            limit 1)
           and (v_eng.state = 'reconnecting'
                or (v_eng.state = 'scheduled'
                    and v_eng.state_reason = 'window_closed'
                    and not exists (
                      select 1 from screening_v2.phone_appointments ap
                       where ap.engagement_id = v_eng.id
                         and ap.status in ('scheduled','confirmed')
                         and ap.source <> 'system_deferral'))) then
        v_new_state := 'opted_out'; v_reason := 'candidate_opt_out';
      -- ▲ 0114 C7-a
      -- ▼ 0114 C2-a
      -- ── the IN-CALL CALLBACK DEFERRAL (C2-P1) ─────────────────────────
      -- The candidate asked to be called later and no slot could be booked.
      -- That is a deferral, not a screening and not an abort: the attempt
      -- ends `callback_deferred`, NOTHING is charged, and the engagement is
      -- redialled at the next IST-day window (the deferred_pre_disclosure
      -- expression). The leg's session is detached and its 0107 claim
      -- released below, so the next dial mints a fresh session behind a
      -- fresh consent gate (PR-B E4 precedent). Two earlier applied
      -- deferrals make this the third: the engagement fails truthfully
      -- rather than deferring for ever.
      when v_eng.state = 'in_call' and p_event_type = 'callback.deferred_in_call'
           and v_att.state in ('human','answered_unclassified') then
        v_att_state := 'ended'; v_outcome := 'callback_deferred';
        v_detach_session := true;
        if (select count(*) from screening_v2.phone_call_events ev
             where ev.engagement_id = v_eng.id
               and ev.event_type = 'callback.deferred_in_call'
               and ev.applied) >= 2 then
          v_new_state := 'failed'; v_reason := 'callback_deferral_limit';
        else
          v_new_state := 'eligible'; v_reason := 'callback_deferred_in_call';
          v_defer_at  := screening_v2.phone_next_window_open(
                           (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                             at time zone 'Asia/Kolkata');
        end if;
      -- ▲ 0114 C2-a

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
  -- ▼ 0114 C1-d
  -- Every continuation edge (R1, the drop race, and C1-e's opt-out and
  -- deferral) binds the continued session to the attempt that carries it, so
  -- partial-finalize, the score suppression and the assessment handler all
  -- read THIS leg (the latest attempt on the session), not the previous one.
  -- v_consented_live holds only for a `dialing` engagement whose bound,
  -- planned session is in_progress, and only these event types reach a
  -- continuation edge from it.
  if v_consented_live
     and v_att.state in ('answered_unclassified','human')
     and v_new_state is not null
     and p_event_type in ('consent.resumed','sip.participant_left',
                          'sip.connection_aborted','candidate.opt_out',
                          'callback.deferred_in_call') then
    update screening_v2.phone_call_attempts
       set session_id = coalesce(session_id, v_eng.session_id)
     where id = v_att.id;
  end if;
  -- ▲ 0114 C1-d

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
           -- ▼ 0114 C2-a detach
           session_id      = case when v_detach_session then null else session_id end,
           -- ▲ 0114 C2-a detach
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
                               when v_reset_reconnects
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

  -- ▼ 0114 C7-a/C2-a/C7-b tail
  -- C7 (R5): the withdrawn engagement's own system_deferral slot is
  -- cancelled. Only the C7 branch reaches opted_out from `scheduled`.
  if v_new_state = 'opted_out' and v_eng.state = 'scheduled' then
    update screening_v2.phone_appointments
       set status        = 'cancelled',
           cancel_reason = 'engagement_cancelled',
           version       = version + 1,
           updated_at    = p_now
     where engagement_id = v_eng.id
       and status in ('scheduled','confirmed')
       and source = 'system_deferral';
  end if;

  -- call_sessions is LAST in the pinned lock order (engagement,
  -- appointment, then sessions); both statements below sit there.
  --
  -- C2: release the deferred leg's 0107 engagement claim, guarded on this
  -- engagement's own claim (the 0113 E4 statement's shape). The leg is
  -- still in_progress until partial-finalize, so under 0112's live-only
  -- index the next dial's createSession would otherwise hit 23505.
  if v_detach_session then
    update screening_v2.call_sessions
       set phone_engagement_id = null
     where phone_engagement_id = v_eng.id
       and id in (v_eng.session_id, v_att.session_id);
  end if;

  -- C7: a withdrawn or wrong-number candidate's live session is CANCELLED
  -- with the truthful reason (purge-and-suppress, 0042), never left
  -- in_progress for partial-finalize to complete and score.
  if v_new_state in ('opted_out','wrong_number') and v_eng.session_id is not null then
    update screening_v2.call_sessions
       set status          = 'cancelled',
           terminal_reason = case when v_new_state = 'opted_out'
                                  then 'candidate_opt_out' else 'wrong_number' end,
           ended_at        = coalesce(ended_at, p_now),
           updated_at      = p_now
     where id = v_eng.session_id
       and status = 'in_progress';
  end if;
  -- ▲ 0114 C7-a/C2-a/C7-b tail
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

create or replace function screening_v2.enforce_phone_engagement_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  allowed text[];
begin
  -- TERMINAL MEANS TERMINAL, and it is checked before the same-state
  -- shortcut below. Guarding only `state` would leave a finished
  -- engagement's budgets, next_eligible_at and consent_record_id
  -- writable — a narrower guarantee than the word "immutable", and one
  -- a reader would not expect to have to check. No RPC in this file
  -- updates a terminal row; this makes that a property of the schema
  -- rather than a property of the current callers.
  --
  -- KNOWN CONSEQUENCE, stated where it bites: a referential SET NULL is
  -- an UPDATE, so this refusal also blocks deleting the `roles` or
  -- `call_sessions` row a TERMINAL engagement points at — its two
  -- `on delete set null` FKs behave as `restrict` once it is terminal,
  -- and the error names the engagement rather than the row being
  -- deleted. See the file header for the erasure order that satisfies
  -- this and the ledger's insert-once guard together.
  -- ▼ 0114 C2 late-score exception
  -- THE ONE EXCEPTION to terminal immutability (C2-P5). The stranded sweep
  -- aborted an engagement whose phone score landed later (a DLQ replay or a
  -- slow job): the screening WAS conducted and scored, and `failed` is
  -- false. Allowed only for exactly that shape, and only as a relabel:
  --   * failed/assessment_aborted -> completed/late_score_after_stranded_abort;
  --   * NO other column changes (terminal_at, session_id, budgets ...),
  --     only state, state_reason, version and updated_at;
  --   * a source='phone' assessment exists for the bound session;
  --   * the abort was the SWEEP's own (the applied internal
  --     `stranded:<session>:assessment.aborted` ledger row), never a
  --     worker-declared abort.
  -- SECURITY INVOKER with search_path=pg_catalog, so every name is
  -- schema-qualified.
  if old.terminal_at is not null
     and old.state = 'failed'
     and old.state_reason = 'assessment_aborted'
     and new.state = 'completed'
     and new.state_reason = 'late_score_after_stranded_abort'
     and (to_jsonb(new) - '{state,state_reason,version,updated_at}'::text[])
         = (to_jsonb(old) - '{state,state_reason,version,updated_at}'::text[])
     and old.session_id is not null
     and exists (select 1 from screening_v2.assessments a
                  where a.session_id = old.session_id
                    and a.source = 'phone')
     and exists (select 1 from screening_v2.phone_call_events ev
                  where ev.source = 'internal'
                    and ev.provider_event_id
                        = 'stranded:' || old.session_id::text || ':assessment.aborted'
                    and ev.engagement_id = old.id
                    and ev.applied) then
    return new;
  end if;
  -- ▲ 0114 C2 late-score exception
  if old.terminal_at is not null and new is distinct from old then
    raise exception 'phone engagement % is terminal (%) and immutable', old.id, old.state
      using errcode = 'P0001';
  end if;

  if old.state = new.state then
    return new;   -- idempotent no-op (#14/#16 and every retry)
  end if;
  case old.state
    when 'pending_prereqs' then allowed := array['eligible','cancelled'];
    -- 0045 added `completed` and `failed` to these three. They are
    -- reachable ONLY through the stranded-session resolution in
    -- `apply_phone_event`, which requires the engagement to hold a bound
    -- session that is ALREADY TERMINAL, and — for `completed` — requires a
    -- real `source='phone'` assessment row to exist. Widening the
    -- allowlist without those interlocks would let any writer terminate an
    -- engagement that is merely waiting its turn; with them, the only
    -- thing these edges can do is tell an engagement the truth about a
    -- conversation that already happened.
    when 'eligible'        then allowed := array['dialing','scheduled','cancelled',
                                                 'completed','failed'];
    when 'scheduled'       then allowed := array['dialing','eligible','cancelled',
                                                 'completed','failed','opted_out'];
    when 'dialing'         then allowed := array[
      'in_call','awaiting_retry','eligible','scheduled','reconnecting',
      -- The no-answer charge that lands on 3 goes straight to the
      -- terminal state; there is no honest `awaiting_retry` for an
      -- engagement with nothing left to retry.
      'abandoned_no_answer',
      'opted_out','wrong_number','failed','cancelled'];
    when 'in_call'         then allowed := array[
      'reconnecting','scheduled','completed','failed','opted_out','wrong_number','cancelled',
      -- A conversation whose worker died mid-call: the sweeper abandons
      -- the attempt and restores the state the attempt was admitted
      -- from. Without this edge the engagement is stranded `in_call`
      -- with no live attempt and no event that can ever move it — the
      -- PR #70 wedge wearing a different name.
      'eligible'];
    when 'reconnecting'    then allowed := array['dialing','scheduled','eligible','failed',
                                                 'cancelled','completed','opted_out'];
    when 'awaiting_retry'  then allowed := array[
      'eligible','abandoned_no_answer','cancelled',
      -- Booking a callback after a missed call is the single most
      -- ordinary use of the internal calendar. Without this edge
      -- schedule_phone_appointment raised P0001 on it.
      'scheduled'];
    -- Every terminal state: no outgoing edge at all.
    else allowed := '{}'::text[];
  end case;
  if not (new.state = any(allowed)) then
    raise exception 'invalid phone engagement transition % -> %', old.state, new.state
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function screening_v2.enforce_phone_engagement_transition is
  'Enforces the legal phone_engagements state machine on UPDATE; same-state is '
  'a no-op and a terminal row admits no change at all, with ONE exception '
  '(0114): failed/assessment_aborted -> completed/late_score_after_stranded_abort '
  'when only state, state_reason, version and updated_at change, a phone '
  'assessment exists for the bound session and the abort was the stranded '
  'sweep''s own ledger row. Widened by 0045 so eligible/scheduled/reconnecting '
  'may reach completed or failed (stranded-session resolution only), and by '
  '0114 so scheduled/reconnecting may reach opted_out (a mid-call withdrawal '
  'that lost the race to the drop).';
-- ==== 0114 §2 END ====


-- ==== 0114 §3 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §3 — Outcome consistency (S3): C2 + C7.
--
--   phone_attempt_score_suppression (new) — why a leg must never be scored:
--     callback_booked (PR-B's E4 fact), callback_deferred (the C2 in-call
--     deferral outcome) or worker_aborted (an APPLIED internal
--     assessment.aborted carrying this attempt id). The stranded sweep's own
--     abort carries attempt_id NULL, so a DLQ replay of a stranded session
--     is NOT suppressed and still scores (PR-B E5). The API's assessment
--     handler reads it before score() (fail-closed) and partial-finalize
--     reports it.
--   finalize_phone_partial_sessions — LIFTED BY SCRIPT from 0113 (R9): one
--     body = the 0113 body + C7 withdrawn (checked FIRST: the session is
--     cancelled, never completed or returned) + C2 suppression (the
--     expired-arm NOT EXISTS becomes the suppression call; the
--     in_progress -> completed transition stays, so the MP3 finalizes).
--     New keys: withdrawn_skipped, score_suppressed, suppress_reason. Every
--     0113 key is unchanged.
--   complete_phone_engagement_after_late_score (new) — C2-P5: the single
--     writer of the §2 trigger's late-score exception. Re-checks the full
--     predicate under the engagement row lock, writes the
--     `late:<session>:assessment.completed` ledger row and the
--     phone_engagement_late_completed audit; terminal_at is unchanged.
--   sweep_phone_stranded_sessions — LIFTED BY SCRIPT from 0113 (the comment
--     block between p_now and p_grace_seconds verbatim, so the RPC contract
--     stays [p_limit, p_now]) + C2-P4 live-job guard + C2-P5 late-completion
--     loop. New keys: late_completed, late_superseded.
--
-- Every hunk inside a lifted body sits between `-- ▼ 0114 <id>` /
-- `-- ▲ 0114 <id>` markers; the one replaced 0113 clause (the expired-arm
-- callback NOT EXISTS) is pinned by phone-0114-outcome.test.ts. All four
-- functions: SECURITY DEFINER, search_path pinned, EXECUTE for service_role
-- only, no machine clock (p_now), no PII in any returned key or audit row.
-- ─────────────────────────────────────────────────────────────────────

create or replace function screening_v2.phone_attempt_score_suppression(
  p_attempt_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  -- First match wins; the order only decides the reported reason (any
  -- non-null answer suppresses).
  select case
    when p_attempt_id is null then null::text
    -- PR-B E4: this leg ended because the candidate CONFIRMED a voice
    -- callback (exact match on the attempt that booked it; never an
    -- engagement-level fallback).
    when exists (
      select 1 from screening_v2.phone_appointments ap
       where ap.confirmed_from_attempt_id = p_attempt_id)
      then 'callback_booked'
    -- C2-P1: the candidate asked in-call to be called back
    -- (callback.deferred_in_call ended the attempt as callback_deferred).
    when exists (
      select 1 from screening_v2.phone_call_attempts a
       where a.id = p_attempt_id
         and a.outcome_class = 'callback_deferred')
      then 'callback_deferred'
    -- C2-P3: a worker-DECLARED abort (explicit end-call, silence goodbye,
    -- malformed exchange) that the ledger APPLIED for this very attempt. An
    -- ignored abort, or the stranded sweep's attempt-less one, is not.
    when exists (
      select 1 from screening_v2.phone_call_events ev
       where ev.attempt_id = p_attempt_id
         and ev.source = 'internal'
         and ev.event_type = 'assessment.aborted'
         and ev.applied)
      then 'worker_aborted'
    else null::text
  end;
$$;

revoke all on function screening_v2.phone_attempt_score_suppression(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_attempt_score_suppression(uuid)
  to service_role;

comment on function screening_v2.phone_attempt_score_suppression is
  'C2 (0114): why a phone leg must never be scored, or null. callback_booked '
  '(an appointment confirmed from this attempt), callback_deferred (the '
  'attempt ended as an in-call callback deferral) or worker_aborted (an '
  'applied internal assessment.aborted carrying this attempt id). The '
  'stranded sweep''s abort carries no attempt id and is never a reason. '
  'Read-only; service-role-only.';

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
  -- ▼ 0114 C2/C7 declare
  -- C7: the candidate withdrew (opted_out / wrong_number engagement, or a
  -- recorded candidate.opt_out on this leg). C2: why this leg is withheld
  -- from scoring (phone_attempt_score_suppression), or null.
  v_withdrawn         boolean;
  v_withdrawn_state   text;
  v_withdrawn_skipped integer := 0;
  v_suppress          text;
  -- ▲ 0114 C2/C7 declare
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
             -- ▼ 0114 C2/C7 expired arm
             -- C2: PR-B's callback_booked NOT EXISTS is generalised to the
             -- suppression (callback_booked is still its first answer): a
             -- deferred or worker-aborted leg is never scored either, so on
             -- this arm it too would be re-selected for ever.
             and screening_v2.phone_attempt_score_suppression(a.id) is null
             -- C7: a withdrawn leg is never scored; it is not selected here
             -- (the in_progress arm cancels it in the loop below).
             and not exists (
               select 1 from screening_v2.phone_engagements we
                where we.id = a.engagement_id
                  and we.state in ('opted_out','wrong_number'))
             and not exists (
               select 1 from screening_v2.phone_call_events ev
                where ev.attempt_id = a.id
                  and ev.event_type = 'candidate.opt_out')
             -- ▲ 0114 C2/C7 expired arm
             )
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
    -- ▼ 0114 C7 withdrawn
    -- CHECKED FIRST (R9). A candidate who withdrew mid-call (or whose line
    -- was a wrong number) must never be completed and scored: the session
    -- is CANCELLED with the truthful reason, exactly as apply_phone_event's
    -- C7-b tail does, and it is not returned to the caller (no enqueue, no
    -- scorecard). Withdrawn = the engagement is opted_out / wrong_number, OR
    -- a `candidate.opt_out` was recorded on this leg (applied OR ignored:
    -- an opt-out that lost a race to the drop or the budget is still the
    -- candidate's word). Only an in_progress session moves; the expired arm
    -- never selects a withdrawn leg.
    select we.state into v_withdrawn_state
      from screening_v2.phone_engagements we
     where we.id = v_row.engagement_id;
    v_withdrawn := coalesce(v_withdrawn_state in ('opted_out','wrong_number'), false)
      or exists (
        select 1 from screening_v2.phone_call_events ev
         where ev.attempt_id = v_row.attempt_id
           and ev.event_type = 'candidate.opt_out');
    if v_withdrawn then
      update screening_v2.call_sessions s
         set status          = 'cancelled',
             terminal_reason = case when v_withdrawn_state = 'wrong_number'
                                    then 'wrong_number' else 'candidate_opt_out' end,
             ended_at        = coalesce(s.ended_at, p_now),
             updated_at      = p_now
       where s.id = v_row.session_id
         and s.status = 'in_progress';
      v_withdrawn_skipped := v_withdrawn_skipped + 1;
      v_withdrawn_state := null;
      continue;
    end if;
    v_withdrawn_state := null;
    -- ▲ 0114 C7 withdrawn

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
    -- ▼ 0114 C2 suppression
    -- C2: is this leg withheld from scoring? callback_booked (the E4 fact
    -- above), callback_deferred (the in-call deferral outcome) or
    -- worker_aborted (an applied internal assessment.aborted carrying this
    -- attempt id; the stranded sweep's abort carries none, so a DLQ replay
    -- of a stranded session still scores). The session transition below is
    -- UNCHANGED for a suppressed leg, so its MP3 still finalizes; the caller
    -- skips the scoring enqueue on `score_suppressed`.
    v_suppress := screening_v2.phone_attempt_score_suppression(v_row.attempt_id);
    -- ▲ 0114 C2 suppression

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
      -- ▼ 0114 C2 suppression keys
      -- true = never scored (see suppress_reason); finalized for its MP3
      -- and transcript only. callback_booked below is kept verbatim.
      'score_suppressed',   v_suppress is not null,
      'suppress_reason',    v_suppress,
      -- ▲ 0114 C2 suppression keys
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
    -- ▼ 0114 C7 withdrawn key
    'withdrawn_skipped', v_withdrawn_skipped,
    -- ▲ 0114 C7 withdrawn key
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
  'self-limiting; charges no budget. 0113: callback_booked per session. '
  '0114: a withdrawn leg (opted_out/wrong_number engagement, or a recorded '
  'candidate.opt_out on the leg) is cancelled, never completed or returned '
  '(withdrawn_skipped); a leg phone_attempt_score_suppression withholds is '
  'still completed for its MP3 and reported score_suppressed/suppress_reason '
  'so the caller never scores it. Service-role-only.';


create or replace function screening_v2.complete_phone_engagement_after_late_score(
  p_engagement_id uuid,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_eng screening_v2.phone_engagements%rowtype;
begin
  if p_engagement_id is null then
    return jsonb_build_object('status', 'not_eligible');
  end if;

  -- The engagement row lock, then the FULL predicate re-checked under it:
  -- the sweep's selection is a hint, never the decision.
  select * into v_eng
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;

  if not found
     or v_eng.state is distinct from 'failed'
     or v_eng.state_reason is distinct from 'assessment_aborted'
     or v_eng.terminal_at is null
     or v_eng.session_id is null
     -- The abort was the stranded SWEEP's own (C2-P5), never a
     -- worker-declared one (C2-P3: those stay failed; HR may admin-score).
     or not exists (
       select 1 from screening_v2.phone_call_events ev
        where ev.source = 'internal'
          and ev.provider_event_id
              = 'stranded:' || v_eng.session_id::text || ':assessment.aborted'
          and ev.engagement_id = v_eng.id
          and ev.applied)
     -- "Scored" means what it means everywhere in this schema: a
     -- source='phone' assessment row for the bound session.
     or not exists (
       select 1 from screening_v2.assessments a
        where a.session_id = v_eng.session_id
          and a.source = 'phone')
     -- A newer cycle on the same application owns the candidate now: left
     -- for the operator (the sweep counts it as late_superseded).
     or exists (
       select 1 from screening_v2.phone_engagements n
        where n.application_link_id = v_eng.application_link_id
          and n.cycle_number > v_eng.cycle_number)
  then
    return jsonb_build_object('status', 'not_eligible');
  end if;

  -- The ledger row first, so the history reads abort -> late completion.
  -- Idempotent on (source, provider_event_id).
  insert into screening_v2.phone_call_events
    (source, provider_event_id, engagement_id, attempt_id, epoch, event_type,
     received_at, applied, ignored_reason, metadata, created_at)
  values
    ('internal', 'late:' || v_eng.session_id::text || ':assessment.completed',
     v_eng.id, null, null, 'assessment.completed', p_now, true, null, null, p_now)
  on conflict do nothing;

  -- A RELABEL, not a transition: only state, state_reason, version and
  -- updated_at change (the §2 trigger's exception compares every other
  -- column, terminal_at included).
  update screening_v2.phone_engagements
     set state        = 'completed',
         state_reason = 'late_score_after_stranded_abort',
         version      = version + 1,
         updated_at   = p_now
   where id = v_eng.id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_engagement_late_completed', 'phone_engagement', v_eng.id::text, 'success',
     jsonb_build_object('session_id', v_eng.session_id,
                        'prior_reason', v_eng.state_reason));

  return jsonb_build_object('status', 'completed',
                            'engagement_id', v_eng.id,
                            'session_id', v_eng.session_id);
end;
$$;

revoke all on function screening_v2.complete_phone_engagement_after_late_score(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.complete_phone_engagement_after_late_score(uuid, timestamptz)
  to service_role;

comment on function screening_v2.complete_phone_engagement_after_late_score is
  'C2-P5 (0114): relabels a stranded-sweep abort whose phone score landed '
  'later. failed/assessment_aborted with the sweep''s own stranded ledger row, '
  'a source=phone assessment for the bound session and no newer cycle on the '
  'application -> completed/late_score_after_stranded_abort, terminal_at '
  'unchanged, ledger row late:<session>:assessment.completed, audit '
  'phone_engagement_late_completed. Otherwise not_eligible. Idempotent; '
  'service-role-only.';

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
  -- ▼ 0114 C2-P5 declare
  v_late_row        record;
  v_late            jsonb;
  v_late_completed  integer := 0;
  v_late_superseded integer := 0;
  -- ▲ 0114 C2-P5 declare
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
       -- ▼ 0114 C2-P4 live job
       -- C2-P4: a session whose scoring job is still pending, active or
       -- delayed is NOT stranded: its score is on the way, and aborting now
       -- is exactly how e6bc7f18 ended failed with an ADVANCE published
       -- after terminal_at. The key is runtime.ts's
       -- phoneAssessmentDedupKey: `${PHONE_ASSESSMENT_QUEUE}:${sessionId}`
       -- with PHONE_ASSESSMENT_QUEUE = 'phone.assessment' (config.ts). A
       -- completed job or one moved to the DLQ no longer protects the
       -- session, so it resolves exactly as before.
       and not exists (
         select 1 from screening_v2.job_queue q
          where q.name = 'phone.assessment'
            and q.dedup_key = 'phone.assessment:' || e.session_id::text
            and q.status in ('pending','active','delayed')
       )
       -- ▲ 0114 C2-P4 live job
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
  -- ▼ 0114 C2-P5 late completion
  -- C2-P5: an engagement THIS sweep aborted (its own
  -- `stranded:<session>:assessment.aborted` ledger row) whose phone score
  -- landed afterwards (a DLQ replay, a slow job) was screened and scored;
  -- `failed` is false. Each candidate is re-checked under its row lock by
  -- complete_phone_engagement_after_late_score, the only writer of the
  -- trigger's single terminal-immutability exception. Bounded by v_limit,
  -- oldest first. A worker-declared abort has no stranded row and is never
  -- taken (C2-P3).
  for v_late_row in
    select e.id
      from screening_v2.phone_engagements e
     where e.state = 'failed'
       and e.state_reason = 'assessment_aborted'
       and e.session_id is not null
       and exists (
         select 1 from screening_v2.phone_call_events ev
          where ev.source = 'internal'
            and ev.provider_event_id
                = 'stranded:' || e.session_id::text || ':assessment.aborted'
            and ev.engagement_id = e.id
            and ev.applied)
       and exists (
         select 1 from screening_v2.assessments a
          where a.session_id = e.session_id
            and a.source = 'phone')
       and not exists (
         select 1 from screening_v2.phone_engagements n
          where n.application_link_id = e.application_link_id
            and n.cycle_number > e.cycle_number)
     order by e.updated_at asc
     limit v_limit
  loop
    v_late := screening_v2.complete_phone_engagement_after_late_score(v_late_row.id, p_now);
    if (v_late ->> 'status') is not distinct from 'completed' then
      v_late_completed := v_late_completed + 1;
    end if;
  end loop;

  -- The same shape with a NEWER cycle on the application is left for the
  -- operator (the newer cycle owns the candidate now). Counted, bounded by
  -- v_limit, never written: the caller warns on a non-zero count.
  select count(*) into v_late_superseded
    from (
      select 1
        from screening_v2.phone_engagements e
       where e.state = 'failed'
         and e.state_reason = 'assessment_aborted'
         and e.session_id is not null
         and exists (
           select 1 from screening_v2.phone_call_events ev
            where ev.source = 'internal'
              and ev.provider_event_id
                  = 'stranded:' || e.session_id::text || ':assessment.aborted'
              and ev.engagement_id = e.id
              and ev.applied)
         and exists (
           select 1 from screening_v2.assessments a
            where a.session_id = e.session_id
              and a.source = 'phone')
         and exists (
           select 1 from screening_v2.phone_engagements n
            where n.application_link_id = e.application_link_id
              and n.cycle_number > e.cycle_number)
       limit v_limit
    ) superseded;
  -- ▲ 0114 C2-P5 late completion

  return jsonb_build_object(
    'status',    'ok',
    'examined',  v_examined,
    'completed', v_completed,
    'failed',    v_failed,
    'skipped',   v_skipped,
    'limit',     v_limit,
    -- ▼ 0114 C2-P5 keys
    'late_completed',  v_late_completed,
    'late_superseded', v_late_superseded,
    -- ▲ 0114 C2-P5 keys
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
  'per session. 0113: an engagement waiting on a live candidate_voice '
  'callback is not stranded. 0114: a session with a pending/active/delayed '
  'phone.assessment job is not stranded; a sweep-aborted engagement whose '
  'phone score landed later is completed as late_score_after_stranded_abort '
  '(late_completed) unless a newer cycle exists (late_superseded, counted '
  'only). Service-role-only.';

-- ==== 0114 §3 END ====


-- ==== 0114 §4 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §4 — Assessment evidence gate (C3): evidence_* columns, CHECKs, index,
-- backfill, and the candidate-status repair (the only DML of this file).
--
-- WHY. Every decision downstream of scoring keyed on METRIC coverage ("did
-- at least one metric score?"), never on INTERVIEW coverage. A partial phone
-- call on which the candidate answered 0 of 4 planned questions (a744741c)
-- auto-rejected its candidate, while a full call (01c5a5dc) landed
-- `screened`. The API now grades every phone revision
-- (app/api/src/lib/scorecards/evidence.ts `gradeEvidence`) and persists the
-- grade here; `canAutoReject` and the Ashby gate read it.
--
-- §4a  four NULLABLE columns. NULL means "not graded" (every browser row and
--      every pre-0114 row the backfill does not reach) and every reader
--      treats NULL as `decision` — the exact pre-0114 behaviour. No default,
--      no NOT NULL, no table rewrite.
-- §4b  named CHECKs: closed grade and reason vocabularies, grade/reason
--      coherence, count bounds.
-- §4c  the partial index Mission Control's "held for evidence" JOIN uses.
-- §4d  backfill_assessment_evidence_grades(): the gradeEvidence rules as one
--      SQL CASE, for PHONE rows only.
-- §4e  repair_evidence_gated_candidate_status(): revert `rejected` ->
--      `screened` where the candidate's LATEST assessment fails
--      canAutoReject; one candidate_status_changed audit per reverted id.
-- §4f  both run once, here.
--
-- Both §4d and §4e are idempotent by predicate (a second run changes 0
-- rows) and stay declared so the policy suite can replay them on seeded
-- shapes. Prod dry-run (2026-10-03, read-only SELECT, recorded in the PR):
-- 11 phone assessments, 3 rejected candidates, 0 phone rows violating the
-- NOT VALID chk_assessments_v2_shape, 0 human status audits on the rejected
-- candidates; the repair set is exactly 2 (a744741c's and 7f6bb294's
-- candidates) and e3a187ed's stays rejected.
-- ─────────────────────────────────────────────────────────────────────

-- §4a ── columns ──────────────────────────────────────────────────────
alter table screening_v2.assessments
  add column if not exists evidence_grade text,
  add column if not exists evidence_reason text,
  add column if not exists evidence_answered integer,
  add column if not exists evidence_planned integer;

comment on column screening_v2.assessments.evidence_grade is
  '0114 (C3): INTERVIEW-coverage grade of this revision. `decision`: may '
  'drive the candidate status and reach Ashby. `insufficient`: held for '
  'human review, never auto-rejects, never written to Ashby. NULL: not '
  'graded (browser / pre-0114) and read as `decision`. Graded by '
  'app/api/src/lib/scorecards/evidence.ts gradeEvidence.';
comment on column screening_v2.assessments.evidence_reason is
  '0114 (C3): why the grade (closed vocabulary, chk_assessments_evidence_reason).';
comment on column screening_v2.assessments.evidence_answered is
  '0114 (C3): MEASURED answered-question count (asked_answered or '
  'volunteered_with_evidence). NULL when unmeasured (no plan, a pre-0086 '
  'NULL disposition, a failed read); NULL never satisfies canAutoReject.';
comment on column screening_v2.assessments.evidence_planned is
  '0114 (C3): the session plan''s question_count, or NULL without a plan.';

-- §4b ── CHECKs (drop-if-exists, then add NOT VALID + VALIDATE) ────────
-- The columns are new, so validation scans only NULLs. NOT VALID + VALIDATE
-- is §1's pattern; it does NOT shorten the ACCESS EXCLUSIVE window here, which
-- the ADD COLUMN already took and which lasts until the migration commits
-- (see LOCK IMPACT at the top).
alter table screening_v2.assessments
  drop constraint if exists chk_assessments_evidence_grade;
alter table screening_v2.assessments
  add constraint chk_assessments_evidence_grade check (
    evidence_grade is null or evidence_grade in ('decision','insufficient')
  ) not valid;
alter table screening_v2.assessments
  validate constraint chk_assessments_evidence_grade;

alter table screening_v2.assessments
  drop constraint if exists chk_assessments_evidence_reason;
alter table screening_v2.assessments
  add constraint chk_assessments_evidence_reason check (
    evidence_reason is null or evidence_reason in (
      'complete_call','partial_sufficient','no_candidate_speech',
      'infra_interrupted','partial_thin','no_plan','evidence_read_failed')
  ) not valid;
alter table screening_v2.assessments
  validate constraint chk_assessments_evidence_reason;

-- Coherence: all four NULL (ungraded), or a reason that belongs to its
-- grade. A reason without a grade, or `decision` with an insufficient
-- reason, is a writer bug and is refused. Written as a CASE with coalesce so
-- it never evaluates to NULL (a CHECK passes on NULL): a reason with a NULL
-- grade must be FALSE, not unknown.
alter table screening_v2.assessments
  drop constraint if exists chk_assessments_evidence_shape;
alter table screening_v2.assessments
  add constraint chk_assessments_evidence_shape check (
    case
      when evidence_grade is null then
        evidence_reason is null and evidence_answered is null
          and evidence_planned is null
      when evidence_grade = 'decision' then
        coalesce(evidence_reason in ('complete_call','partial_sufficient'), false)
      when evidence_grade = 'insufficient' then
        coalesce(evidence_reason in ('no_candidate_speech','infra_interrupted',
                                     'partial_thin','no_plan','evidence_read_failed'), false)
      else false
    end
  ) not valid;
alter table screening_v2.assessments
  validate constraint chk_assessments_evidence_shape;

-- Bounds mirror phone_session_plans.chk_phone_session_plans_count (1..100).
alter table screening_v2.assessments
  drop constraint if exists chk_assessments_evidence_counts;
alter table screening_v2.assessments
  add constraint chk_assessments_evidence_counts check (
    (evidence_answered is null or evidence_answered >= 0)
    and (evidence_planned is null or evidence_planned between 1 and 100)
  ) not valid;
alter table screening_v2.assessments
  validate constraint chk_assessments_evidence_counts;

-- §4c ── index ────────────────────────────────────────────────────────
-- Partial: only held rows, which are few by construction.
create index if not exists idx_assessments_evidence_insufficient
  on screening_v2.assessments (created_at desc)
  where evidence_grade = 'insufficient';

-- §4d ── backfill ─────────────────────────────────────────────────────
-- The CASE below is evidence.ts `gradeEvidence` rule for rule, in the same
-- order, over the same reads the API makes:
--   candidate turns = non-gate (`is_gate = false`), non-bot transcript_turns
--                     of the session (assessment.ts transcript load);
--   planned         = phone_session_plans.question_count, NULL without a plan;
--   answered        = progress rows with disposition asked_answered /
--                     volunteered_with_evidence (ANSWERED_DISPOSITIONS);
--                     any NULL disposition (pre-0086) => graded on the ROW
--                     count but persisted UNMEASURED (NULL);
--   disconnect      = raw.partial.disconnect_reason when partial (a non-string
--                     or absent value reads 'disconnected', as rescoreEvidence
--                     does), NULL otherwise; only 'worker_crash'
--                     (INFRA_DISCONNECT_REASON) matters.
-- Rules: 1. 0 candidate turns -> insufficient / infra_interrupted
--           (worker_crash) | no_candidate_speech;
--        2. not partial -> decision / complete_call;
--        3. partial, no plan -> insufficient / no_plan (counts NULL);
--        4. answered * 4 >= planned * 3 -> decision / partial_sufficient;
--        5. else insufficient / infra_interrupted (worker_crash) | partial_thin.
-- (evidence.ts's `evidence_read_failed` rule cannot arise here: these are
-- direct reads in this transaction.)
-- THRESHOLD: `* 4 >= * 3` is PARTIAL_DECISION = {num: 3, den: 4} in
-- app/api/src/lib/scorecards/evidence.ts. Change both together, or the
-- backfilled grades disagree with live ones.
-- PHONE rows only and only ungraded ones: a browser row stays NULL (=
-- decision, byte-identical browser behaviour) and a second run updates 0.
create or replace function screening_v2.backfill_assessment_evidence_grades()
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, screening_v2
as $$
declare
  v_n integer;
begin
  update screening_v2.assessments a
     set evidence_grade    = g.grade,
         evidence_reason   = g.reason,
         evidence_answered = g.answered,
         evidence_planned  = g.planned
    from (
      select m.id,
             case
               when m.turns = 0 then 'insufficient'
               when not m.partial then 'decision'
               when m.planned is null then 'insufficient'
               when m.answer_count * 4 >= m.planned * 3 then 'decision'
               else 'insufficient'
             end as grade,
             case
               when m.turns = 0 then
                 case when m.disconnect = 'worker_crash'
                      then 'infra_interrupted' else 'no_candidate_speech' end
               when not m.partial then 'complete_call'
               when m.planned is null then 'no_plan'
               when m.answer_count * 4 >= m.planned * 3 then 'partial_sufficient'
               else
                 case when m.disconnect = 'worker_crash'
                      then 'infra_interrupted' else 'partial_thin' end
             end as reason,
             -- MEASURED only: a plan and no NULL disposition (answeredOf).
             case
               when m.planned is not null and m.null_rows = 0
                 then least(m.answered_rows, m.progress_rows)
             end as answered,
             m.planned as planned
        from (
          select x.id, x.partial, x.disconnect, x.turns, x.planned,
                 x.progress_rows, x.answered_rows, x.null_rows,
                 case when x.null_rows > 0 then x.progress_rows
                      else least(x.answered_rows, x.progress_rows) end as answer_count
            from (
              select a2.id,
                     a2.partial,
                     case when a2.partial then
                       case when jsonb_typeof(a2.raw -> 'partial' -> 'disconnect_reason') = 'string'
                            then a2.raw -> 'partial' ->> 'disconnect_reason'
                            else 'disconnected' end
                     end as disconnect,
                     (select count(*)::integer
                        from screening_v2.transcript_turns t
                       where t.session_id = a2.session_id
                         and t.is_gate = false
                         and t.speaker <> 'bot') as turns,
                     (select p.question_count
                        from screening_v2.phone_session_plans p
                       where p.session_id = a2.session_id
                         and p.question_count > 0) as planned,
                     (select count(*)::integer
                        from screening_v2.phone_session_progress r
                       where r.session_id = a2.session_id) as progress_rows,
                     (select count(*)::integer
                        from screening_v2.phone_session_progress r
                       where r.session_id = a2.session_id
                         and r.disposition in ('asked_answered','volunteered_with_evidence'))
                       as answered_rows,
                     (select count(*)::integer
                        from screening_v2.phone_session_progress r
                       where r.session_id = a2.session_id
                         and r.disposition is null) as null_rows
                from screening_v2.assessments a2
               where a2.source = 'phone'
                 and a2.evidence_grade is null
            ) x
        ) m
    ) g
   where a.id = g.id
     and a.source = 'phone'
     and a.evidence_grade is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function screening_v2.backfill_assessment_evidence_grades()
  from public, anon, authenticated;
grant execute on function screening_v2.backfill_assessment_evidence_grades()
  to service_role;

comment on function screening_v2.backfill_assessment_evidence_grades() is
  '0114 (C3) one-shot backfill: grades every UNGRADED phone assessment with '
  'evidence.ts gradeEvidence''s rules (PARTIAL_DECISION 3/4). Idempotent: a '
  'second run updates 0 rows. Browser rows stay NULL. Returns the row count. '
  'Service-role-only.';

-- §4e ── candidate repair ─────────────────────────────────────────────
-- Reverts candidates.status `rejected` -> `screened` where ALL hold:
--   * the candidate's LATEST assessment (created_at, then revision, then id)
--     is a PHONE row — the only channel the old rule mis-rejected (the
--     browser rule is unchanged, so a rejected browser-latest candidate was
--     placed by a human and is never touched);
--   * that row is what the OLD auto rule rejected on — recommendation
--     `reject` with scoring_status `complete` — so any other rejection (a
--     human's) is out of scope;
--   * that row is graded and FAILS canAutoReject (evidence.ts): grade
--     `insufficient`, or answered UNMEASURED, or answered * 2 < planned;
--   * decision_use_blocked_at is NULL (a blocked candidate is frozen);
--   * no NON-system candidate_status_changed audit for the candidate at or
--     after that assessment (a human decided since; theirs stands).
-- THRESHOLD: `* 2 >= * 1` is AUTO_REJECT_MIN = {num: 1, den: 2} in
-- app/api/src/lib/scorecards/evidence.ts. Change both together.
-- One `candidate_status_changed` audit per reverted id (system actor), from
-- the UPDATE's `returning`. `p_candidate_ids` scopes the run (NULL = all);
-- `p_now` stamps the audit rows. Idempotent: a reverted candidate is no
-- longer `rejected`, so a second run changes 0 rows and audits nothing.
create or replace function screening_v2.repair_evidence_gated_candidate_status(
  p_candidate_ids uuid[] default null,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, screening_v2
as $$
declare
  v_n integer;
begin
  with latest as (
    select distinct on (a.candidate_id)
           a.candidate_id, a.created_at, a.source, a.recommendation,
           a.scoring_status, a.evidence_grade, a.evidence_answered,
           a.evidence_planned
      from screening_v2.assessments a
     where p_candidate_ids is null or a.candidate_id = any (p_candidate_ids)
     order by a.candidate_id, a.created_at desc, a.revision desc, a.id desc
  ),
  targets as (
    select l.candidate_id
      from latest l
      join screening_v2.candidates c on c.id = l.candidate_id
     where c.status = 'rejected'
       and c.decision_use_blocked_at is null
       and l.source = 'phone'
       and l.recommendation = 'reject'
       and l.scoring_status = 'complete'
       and l.evidence_grade is not null
       and not (
         l.evidence_grade = 'decision'
         and l.evidence_answered is not null
         and l.evidence_planned is not null
         and l.evidence_planned > 0
         and l.evidence_answered * 2 >= l.evidence_planned * 1
       )
       and not exists (
         select 1
           from screening_v2.audit_events ae
          where ae.action = 'candidate_status_changed'
            and ae.target_type = 'candidate'
            and ae.target_id = l.candidate_id::text
            and ae.actor_type <> 'system'
            and ae.created_at >= l.created_at)
  ),
  reverted as (
    update screening_v2.candidates c
       set status = 'screened'
      from targets t
     where c.id = t.candidate_id
       and c.status = 'rejected'
       and c.decision_use_blocked_at is null
    returning c.id
  )
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata, created_at)
  select '00000000-0000-0000-0000-000000000000'::uuid, 'system',
         'candidate_status_changed', 'candidate', r.id::text, 'success',
         jsonb_build_object('from', 'rejected', 'to', 'screened',
                            'reason', 'evidence_gate', 'migration', '0114'),
         p_now
    from reverted r;
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', 'ok', 'reverted', v_n);
end;
$$;

revoke all on function screening_v2.repair_evidence_gated_candidate_status(uuid[], timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.repair_evidence_gated_candidate_status(uuid[], timestamptz)
  to service_role;

comment on function screening_v2.repair_evidence_gated_candidate_status(uuid[], timestamptz) is
  '0114 (C3) one-shot repair: rejected -> screened where the candidate''s '
  'latest (phone, complete reject) assessment fails canAutoReject '
  '(AUTO_REJECT_MIN 1/2), unless blocked or a human changed the status '
  'since. One candidate_status_changed audit (system actor, metadata '
  '{from,to,reason:evidence_gate,migration:0114}) per reverted id. '
  'Idempotent. Returns {status, reverted}. Service-role-only.';

-- §4f ── run once ─────────────────────────────────────────────────────
-- Backfill FIRST: the repair reads the grades it writes.
do $$
declare
  v_graded integer;
  v_repair jsonb;
begin
  v_graded := screening_v2.backfill_assessment_evidence_grades();
  v_repair := screening_v2.repair_evidence_gated_candidate_status(null);
  raise notice '0114 §4: graded % phone assessment(s); reverted % candidate status(es)',
    v_graded, v_repair->>'reverted';
end;
$$;
-- ==== 0114 §4 END ====


-- ==== 0114 §5 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §5 — Appointment truthfulness (S5): C5.
--
--   schedule_phone_appointment — LIFTED BY SCRIPT from 0042 (the newest
--     declaration; C0 grep). Hunk C5-b: after the engagement lock and the
--     dialing check, BEFORE any supersede, refuse `slot_not_yet_eligible`
--     (p_starts_at < next_eligible_at) and `daily_attempt_exists` (the
--     slot's IST date already holds 2 counted dials — the 0095:513-519
--     predicate). Signature, SECURITY DEFINER, search_path and the
--     service_role-only ACL are unchanged.
--   expire_phone_appointments — LIFTED BY SCRIPT from 0042. Hunk C5-a: the
--     phone_control read (missing row = halted), the hold predicate in the
--     scan AND the locked re-check, the engagement lock also reads
--     terminal_at, a cause-based cancel_reason (status stays 'missed'),
--     audit metadata cause / lane_halted / control_updated_at, return key
--     `held`. Hunk C5-c: the wedge-release loop (audit
--     phone_scheduled_engagement_released), return key `released`.
--
-- Every hunk sits between `-- ▼ 0114 <id>` / `-- ▲ 0114 <id>` markers. The
-- only 0042 lines REPLACED (not merely added to), all in expire, are the
-- fixed `cancel_reason = 'system_deferral_expired'`, the engagement-lock
-- `select id into v_eng_id` and the two-line return; they are pinned by
-- phone-0114-appointments.test.ts, which also proves the rest of both bodies
-- is byte-identical to 0042. No machine clock (p_now only); no PII in any
-- returned key or audit row.
-- ─────────────────────────────────────────────────────────────────────

create or replace function screening_v2.schedule_phone_appointment(
  p_engagement_id    uuid,
  p_starts_at        timestamptz,
  p_ends_at          timestamptz,
  p_source           text,
  p_actor_id         uuid        default null,
  p_expected_version integer     default null,
  p_now              timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_eng     screening_v2.phone_engagements%rowtype;
  v_live    screening_v2.phone_appointments%rowtype;
  v_new_id   uuid;
  v_version  integer;
  v_promoted boolean := false;
  -- ▼ 0114 C5-b declare
  v_dials_on_day integer;
  -- ▲ 0114 C5-b declare
begin
  if p_source is null or p_source not in ('candidate_voice','hr_manual','system_deferral') then
    return jsonb_build_object('status', 'invalid_source');
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    return jsonb_build_object('status', 'invalid_slot');
  end if;
  if extract(epoch from (p_ends_at - p_starts_at)) not between 900 and 3600 then
    return jsonb_build_object('status', 'slot_duration_invalid');
  end if;
  if p_starts_at < p_now then
    return jsonb_build_object('status', 'slot_in_past');
  end if;
  -- The window governs the START. How long a slot admitted at 20:55 may
  -- then run is the voice layer's maximum call duration, not a schema
  -- rule, and no constraint here pretends otherwise.
  if not screening_v2.phone_ist_window_open(p_starts_at) then
    return jsonb_build_object('status', 'window_closed');
  end if;
  if screening_v2.phone_ist_date(p_starts_at) <> screening_v2.phone_ist_date(p_ends_at) then
    return jsonb_build_object('status', 'slot_straddles_ist_midnight');
  end if;

  select * into v_eng from screening_v2.phone_engagements
   where id = p_engagement_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state = 'dialing' then
    -- A live dial owns the engagement; rescheduling under it would put
    -- the calendar and the wire into disagreement.
    return jsonb_build_object('status', 'attempt_in_flight');
  end if;
  -- ▼ 0114 C5-b booking refusals

  -- A booking is a promise that a dial will happen at p_starts_at. Two
  -- admission gates would refuse that dial, so the booking is refused here
  -- instead of being accepted and then silently missed. Both run under the
  -- engagement row lock and BEFORE any supersede below, so a refused HR
  -- reschedule leaves the existing live slot exactly as it was. No override:
  -- an hr_manual booking is refused the same way (the conservative choice).
  --
  -- (1) Mirrors admission's `not_yet_eligible` (0095:455-458): a slot that
  --     starts before the engagement's own time gate (a no-answer spacing,
  --     a next-IST-day defer, PR-A's reclaim hold) could never be admitted.
  if v_eng.next_eligible_at is not null and p_starts_at < v_eng.next_eligible_at then
    return jsonb_build_object('status', 'slot_not_yet_eligible',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;
  -- (2) Mirrors admission's per-IST-day ledger (0095:510-531), evaluated on
  --     the SLOT's IST date. The WHERE clause is the exact 0095:513-519
  --     predicate (the same rows the per-day unique index covers, NULL-safe on
  --     abandon_reason so a lease-reclaimed row still charges the day and only
  --     an infra_deferred abandonment is exempt), and max(ist_day_seq) is the
  --     same aggregate admission uses, so the two can never disagree.
  select coalesce(max(a.ist_day_seq), 0) into v_dials_on_day
    from screening_v2.phone_call_attempts a
   where a.engagement_id = p_engagement_id
     and a.ist_date = screening_v2.phone_ist_date(p_starts_at)
     and a.kind = any (array['initial','no_answer_retry','scheduled'])
     and (a.state <> 'abandoned'
          or a.abandon_reason is distinct from 'infra_deferred');
  -- The literal 2 is admission's per-IST-day cap: `v_day_seq > 2` and
  -- 'max_per_day', 2 at 0095:522-529. Admission refuses dial N+1 when N >= 2
  -- dials already hold the day, so a slot on such a day is undialable.
  if v_dials_on_day >= 2 then
    return jsonb_build_object('status', 'daily_attempt_exists',
                              'ist_date', screening_v2.phone_ist_date(p_starts_at),
                              'dials_today', v_dials_on_day,
                              'max_per_day', 2);
  end if;
  -- ▲ 0114 C5-b booking refusals

  select * into v_live from screening_v2.phone_appointments
   where engagement_id = p_engagement_id
     and status in ('scheduled','confirmed')
   for update;

  if found then
    -- Optimistic concurrency: a stale write is refused rather than
    -- silently overwriting the slot a recruiter is looking at.
    if p_expected_version is null then
      return jsonb_build_object('status', 'appointment_exists',
                                'appointment_id', v_live.id,
                                'version', v_live.version);
    end if;
    if p_expected_version <> v_live.version then
      return jsonb_build_object('status', 'version_conflict',
                                'appointment_id', v_live.id,
                                'version', v_live.version);
    end if;
    update screening_v2.phone_appointments
       set status        = 'superseded',
           version       = version + 1,
           cancel_reason = 'superseded',
           updated_at    = p_now
     where id = v_live.id;
  end if;

  insert into screening_v2.phone_appointments
    (engagement_id, starts_at, ends_at, ist_date, status, source,
     created_by, created_at, updated_at)
  values
    (p_engagement_id, p_starts_at, p_ends_at,
     screening_v2.phone_ist_date(p_starts_at), 'scheduled', p_source,
     coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid), p_now, p_now)
  returning id, version into v_new_id, v_version;

  if v_eng.state in ('eligible','in_call','reconnecting','awaiting_retry') then
    update screening_v2.phone_engagements
       set state      = 'scheduled',
           version    = version + 1,
           updated_at = p_now
     where id = p_engagement_id;
    v_promoted := true;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    -- An operator/candidate-negotiated slot is attributable: `recruiter`
    -- with the admin identity in actor_id, matching 0035/0040/0041. A
    -- system deferral falls back to the system sentinel.
    (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
     case when p_actor_id is null then 'system' else 'recruiter' end,
     'phone_appointment_scheduled', 'phone_appointment', v_new_id::text, 'success',
     jsonb_build_object('engagement_id', p_engagement_id,
                        'source', p_source,
                        'ist_date', screening_v2.phone_ist_date(p_starts_at),
                        'superseded', v_live.id is not null));

  -- A booking against an engagement whose prerequisites are still unmet
  -- is REAL — the slot exists and HR can see it — but it is not
  -- dialable, because `pending_prereqs` has no edge to `scheduled` and
  -- admission would refuse it anyway. Returning a plain `ok` would let a
  -- caller believe a call is now going to happen at that time. The
  -- distinct status says what was and was not done.
  return jsonb_build_object('status',
                            case when v_promoted or v_eng.state = 'scheduled'
                                 then 'ok' else 'ok_prereqs_pending' end,
                            'appointment_id', v_new_id,
                            'version', v_version,
                            'engagement_state',
                            case when v_promoted then 'scheduled' else v_eng.state end,
                            'superseded_appointment_id', v_live.id);
end;
$$;

revoke all on function screening_v2.schedule_phone_appointment(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.schedule_phone_appointment(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz)
  to service_role;

comment on function screening_v2.schedule_phone_appointment is
  'Books or reschedules the ONE live internal appointment for an '
  'engagement, under the engagement row lock, with optimistic-version '
  'concurrency (a stale write is refused with version_conflict). '
  'Enforces the approved IST START window, the 15-60 minute slot '
  'envelope and the no-IST-midnight-straddle rule, and refuses a slot in '
  'the past, a terminal engagement and an engagement with a dial in '
  'flight. Booking against an engagement whose prerequisites are still '
  'unmet returns `ok_prereqs_pending` rather than `ok`: the slot is real '
  'and visible, but nothing will dial it until the prerequisites are '
  'satisfied. No external calendar is contacted. 0114 (C5): before any '
  'supersede it also refuses a slot that admission could never dial — '
  '`slot_not_yet_eligible` (starts before next_eligible_at) and '
  '`daily_attempt_exists` (the slot''s IST date already holds the two '
  'counted dials) — so a refused reschedule leaves the old slot live. '
  'Service-role-only.';

create or replace function screening_v2.expire_phone_appointments(
  p_grace_seconds integer     default 900,
  p_limit         integer     default 50,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row     record;
  v_eng_id  uuid;
  v_apt     screening_v2.phone_appointments%rowtype;
  v_count   integer := 0;
  v_grace   constant integer := greatest(0, least(coalesce(p_grace_seconds, 900), 86400));
  v_limit   constant integer := greatest(1, least(coalesce(p_limit, 50), 500));
  -- ▼ 0114 C5-a declare
  v_halted       boolean;
  v_ctl_updated  timestamptz;
  v_ctl_at       timestamptz;
  v_eng_terminal timestamptz;
  v_cause        text;
  v_held         integer := 0;
  v_released     integer := 0;
  v_rel          record;
  -- ▲ 0114 C5-a declare
begin
  -- ▼ 0114 C5-a control read
  -- A slot passed during an operator halt was not the candidate's miss: no
  -- dial could have happened. Read the singleton kill switch once (plain
  -- read, no lock: the sweep never queues behind a halt operator). A MISSING
  -- row counts as halted — fail closed, exactly as admission does
  -- (`halt_unreadable`).
  select c.halted_at is not null, c.updated_at
    into v_halted, v_ctl_updated
    from screening_v2.phone_control c
   where c.control_key = 'default';
  if not found then
    v_halted      := true;
    v_ctl_updated := null;
  end if;
  -- v_ctl_at approximates "when the lane last changed" (set/clear bump
  -- updated_at to their p_now). A stamp LATER than p_now is not observable
  -- at p_now, so it is ignored (null) rather than clamped to p_now: clamping
  -- would hold every slot for a full grace on any logical-clock replay.
  v_ctl_at := case when v_ctl_updated <= p_now then v_ctl_updated end;
  -- The hold predicate, applied identically in the scan, the locked
  -- re-check and the `held` count. A live slot is DUE when its grace has
  -- passed AND one of:
  --   * its engagement is terminal (nothing would ever dial it);
  --   * p_now is at/after 21:00 IST on the slot's own IST day (the day's
  --     window is over whatever the lane did);
  --   * the lane is not halted AND the grace has also passed since the lane
  --     last changed (greatest(ends_at, v_ctl_at)): a lift just after the
  --     slot gives the due loop one grace to admit it as kind 'scheduled'.

  -- ▲ 0114 C5-a control read
  -- Unlocked candidate scan, re-verified under the locks below, so the
  -- sweeper never queues behind a live booking.
  for v_row in
    select id, engagement_id
      from screening_v2.phone_appointments
     where status in ('scheduled', 'confirmed')
       and ends_at + (v_grace * interval '1 second') <= p_now
       -- ▼ 0114 C5-a hold (scan)
       and (exists (select 1 from screening_v2.phone_engagements e
                     where e.id = phone_appointments.engagement_id and e.terminal_at is not null)
            or p_now >= ((screening_v2.phone_ist_date(starts_at)::timestamp
                          + screening_v2.phone_ist_window_close_at())
                         at time zone 'Asia/Kolkata')
            or (not v_halted
                and greatest(ends_at, v_ctl_at) + (v_grace * interval '1 second') <= p_now))
       -- ▲ 0114 C5-a hold (scan)
     order by ends_at asc
     limit v_limit
  loop
    -- ▼ 0114 C5-a engagement lock reads terminal_at
    select id, terminal_at into v_eng_id, v_eng_terminal
    -- ▲ 0114 C5-a engagement lock reads terminal_at
      from screening_v2.phone_engagements
     where id = v_row.engagement_id
     for update skip locked;
    if not found then
      continue;
    end if;

    select * into v_apt
      from screening_v2.phone_appointments
     where id = v_row.id
       and status in ('scheduled', 'confirmed')
       and ends_at + (v_grace * interval '1 second') <= p_now
       -- ▼ 0114 C5-a hold (locked re-check)
       and (v_eng_terminal is not null
            or p_now >= ((screening_v2.phone_ist_date(starts_at)::timestamp
                          + screening_v2.phone_ist_window_close_at())
                         at time zone 'Asia/Kolkata')
            or (not v_halted
                and greatest(ends_at, v_ctl_at) + (v_grace * interval '1 second') <= p_now))
       -- ▲ 0114 C5-a hold (locked re-check)
     for update skip locked;
    if not found then
      continue;
    end if;

    -- ▼ 0114 C5-a cause
    -- Why the slot passed undialled. Status stays 'missed' (uncharged, the
    -- engagement eligible at p_now as before); only the reason is truthful:
    -- a terminal engagement's slot is engagement_cancelled (the engagement
    -- row is NOT touched — the guarded UPDATE below skips it), a slot that
    -- passed while the lane was halted, or around a lane change after it
    -- started (updated_at proxy; labelling only), is emergency_stop, and
    -- only an ordinary miss stays system_deferral_expired.
    v_cause := case
                 when v_eng_terminal is not null then 'engagement_cancelled'
                 when v_halted or v_ctl_at > v_apt.starts_at then 'emergency_stop'
                 else 'system_deferral_expired'
               end;
    -- ▲ 0114 C5-a cause
    update screening_v2.phone_appointments
       set status        = 'missed',
           -- ▼ 0114 C5-a cause
           cancel_reason = v_cause,
           -- ▲ 0114 C5-a cause
           version       = version + 1,
           updated_at    = p_now
     where id = v_apt.id;

    -- Back to `eligible` so the ordinary admission path can pick the
    -- engagement up again. A terminal engagement is left alone: its slot
    -- is expired for tidiness, but nothing resurrects it.
    update screening_v2.phone_engagements
       set state            = 'eligible',
           state_reason     = 'appointment_missed',
           next_eligible_at = p_now,
           version          = version + 1,
           updated_at       = p_now
     where id = v_apt.engagement_id
       and terminal_at is null
       and state = 'scheduled';

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_appointment_missed', 'phone_appointment', v_apt.id::text, 'success',
       jsonb_build_object('engagement_id', v_apt.engagement_id,
                          'grace_seconds', v_grace,
                          -- ▼ 0114 C5-a audit cause
                          'cause', v_cause,
                          'lane_halted', v_halted,
                          'control_updated_at', v_ctl_updated,
                          -- ▲ 0114 C5-a audit cause
                          'budget_charged', false));

    v_count := v_count + 1;
  end loop;
  -- ▼ 0114 C5-a held count

  -- Past their grace but held by the predicate above (halted lane, or the
  -- post-lift grace): still live, still dialable as kind 'scheduled'.
  select count(*) into v_held
    from screening_v2.phone_appointments a
   where a.status in ('scheduled', 'confirmed')
     and a.ends_at + (v_grace * interval '1 second') <= p_now
     and not (exists (select 1 from screening_v2.phone_engagements e
                       where e.id = a.engagement_id and e.terminal_at is not null)
              or p_now >= ((screening_v2.phone_ist_date(a.starts_at)::timestamp
                            + screening_v2.phone_ist_window_close_at())
                           at time zone 'Asia/Kolkata')
              or (not v_halted
                  and greatest(a.ends_at, v_ctl_at) + (v_grace * interval '1 second') <= p_now));
  -- ▲ 0114 C5-a held count
  -- ▼ 0114 C5-c wedge release

  -- A `scheduled` engagement with NO live appointment is dialled by nobody:
  -- the due loop dials `scheduled` only through a live slot, and the loop
  -- above only ever sees engagements that still hold one. The reclaim
  -- restore (0096/0112) can leave exactly that shape. Release it to
  -- `eligible` once it has rested a full grace and any time hold it carries
  -- (PR-A's reclaim hold, a defer) has passed — never pulling a later hold
  -- forward, and never sooner than the next IST day's window open, so a
  -- release is never an immediate redial. PR-B's callback engagements hold a
  -- live confirmed slot and are excluded by construction. Bounded, skip
  -- locked, re-checked under the engagement lock (appointment writers take
  -- that lock first), CHARGES NO BUDGET.
  for v_rel in
    select e.id
      from screening_v2.phone_engagements e
     where e.state = 'scheduled'
       and e.terminal_at is null
       and e.updated_at + (v_grace * interval '1 second') <= p_now
       and coalesce(e.next_eligible_at, '-infinity'::timestamptz) <= p_now
       and not exists (select 1 from screening_v2.phone_appointments ap
                        where ap.engagement_id = e.id
                          and ap.status in ('scheduled', 'confirmed'))
     order by e.updated_at asc, e.id asc
     limit v_limit
  loop
    select id into v_eng_id
      from screening_v2.phone_engagements
     where id = v_rel.id
       and state = 'scheduled'
       and terminal_at is null
       and updated_at + (v_grace * interval '1 second') <= p_now
       and coalesce(next_eligible_at, '-infinity'::timestamptz) <= p_now
     for update skip locked;
    if not found then
      continue;
    end if;
    if exists (select 1 from screening_v2.phone_appointments ap
                where ap.engagement_id = v_eng_id
                  and ap.status in ('scheduled', 'confirmed')) then
      continue;
    end if;

    update screening_v2.phone_engagements
       set state            = 'eligible',
           state_reason     = 'appointment_lost',
           next_eligible_at = greatest(next_eligible_at,
                                       screening_v2.phone_next_window_open(
                                         (screening_v2.phone_ist_date(p_now) + 1)::timestamp
                                           at time zone 'Asia/Kolkata')),
           version          = version + 1,
           updated_at       = p_now
     where id = v_eng_id;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_scheduled_engagement_released', 'phone_engagement', v_eng_id::text, 'success',
       jsonb_build_object('grace_seconds', v_grace,
                          'budget_charged', false));

    v_released := v_released + 1;
  end loop;
  -- ▲ 0114 C5-c wedge release

  -- ▼ 0114 C5-a/C5-c return keys
  return jsonb_build_object('status', 'ok', 'expired', v_count,
                            'grace_seconds', v_grace, 'limit', v_limit,
                            'held', v_held, 'released', v_released);
  -- ▲ 0114 C5-a/C5-c return keys
end;
$$;

revoke all on function screening_v2.expire_phone_appointments(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.expire_phone_appointments(integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.expire_phone_appointments is
  'Transition #10: a live internal appointment whose slot passed without '
  'a dial becomes `missed` and its engagement returns to `eligible`. '
  'Bounded and grace-delayed, CHARGES NO BUDGET, and leaves a terminal '
  'engagement alone. Without it a passed slot stays live for ever, HR '
  'sees a stale booking as real, and the one-live index forces every '
  'later booking through the supersede path. 0114 (C5): reads phone_control '
  '(a missing row is halted) and HOLDS a slot while the lane is halted, and '
  'for one grace after a lift, until 21:00 IST on the slot''s own day; the '
  'cancel_reason records the cause (engagement_cancelled, emergency_stop, '
  'system_deferral_expired). A second bounded loop releases a `scheduled` '
  'engagement left with no live appointment to eligible/appointment_lost '
  '(audit phone_scheduled_engagement_released). Returns held and released. '
  'Service-role-only.';
-- ==== 0114 §5 END ====


-- ==== 0114 §6 BEGIN ====
-- ─────────────────────────────────────────────────────────────────────
-- §6 — Person identity guards (S6): C8. One person on several candidate
-- rows was dialled and screened twice (prod lines ffc393 / 3247c3: two rows
-- each, same role, both double-dialled on one IST day, two Ashby
-- writebacks). Ashby import creates one candidate row per application and
-- never dedups (house rule 0029/0042); this section NARROWS that house rule
-- for the phone lane only, with an operator release (owner sign-off: C8-G).
--
--   idx_v2_candidates_email_norm — new; serves the hold's email match.
--   phone_identity_hold_releases — new table: one row per released
--     engagement (opaque ids + time only). RLS on, no policy, service_role
--     only.
--   admit_phone_attempt — LIFTED BY SCRIPT from 0095 (the newest
--     declaration; C0 grep). Hunks C8-a: Guard A (call in flight) and Guard
--     B (cold-called today) widen from `candidate_id = this row` to every
--     row on the same phone_e164 line; refusals gain the additive detail key
--     `scope` (candidate|line). Status strings, LOCK 1 / LOCK 1b and their
--     comments, the halt read (no exception handler above it), the
--     scheduled/reconnect exemptions and ist_day_seq are unchanged.
--   ensure_ashby_phone_engagement — LIFTED BY SCRIPT from 0057. Hunk C8-b:
--     the same-role duplicate hold (pending_prereqs, cycle 1, not a rescreen
--     child, not released), after the phone_invalid return and before the
--     submitted_at / consent checks, under the `ashby_person_identity`
--     advisory lock (lock order: link, engagement, identity).
--   schedule_candidate_phone_appointment — LIFTED BY SCRIPT from 0058. Hunk
--     C8-d: early return on duplicate_application, before any booking.
--   release_phone_identity_hold — new RPC: actor required, refuses unless
--     held, records the release, audits phone_identity_hold_release (§1
--     vocabulary), re-runs ensure.
--
-- Every hunk inside a lifted body sits between `-- ▼ 0114 <id>` /
-- `-- ▲ 0114 <id>` markers; the only REPLACED 0095 lines (the two guard
-- statements) are pinned by phone-0114-identity.test.ts, which also proves
-- the rest of each body byte-identical to its source. No machine clock (p_now
-- only). No phone number, email, name or external id in any returned key,
-- audit row or log: the other row is never named.
-- TS follow-up (P6, not here): register release_phone_identity_hold
-- ['p_engagement_id','p_actor_id','p_now'] in rpc-contract.ts and add the
-- status `duplicate_application` to the ensure / schedule_candidate status
-- lists, the route 409s and the web copy.
-- ─────────────────────────────────────────────────────────────────────

-- Normalised-email lookup for the duplicate hold. Partial: a row with no
-- email can never match on email. Non-unique by design (the house rule still
-- creates one row per application).
create index if not exists idx_v2_candidates_email_norm
  on screening_v2.candidates (lower(btrim(email)))
  where email is not null;

create table if not exists screening_v2.phone_identity_hold_releases (
  engagement_id uuid        primary key
                            references screening_v2.phone_engagements(id) on delete cascade,
  actor_id      uuid        not null,
  created_at    timestamptz not null
);

alter table screening_v2.phone_identity_hold_releases enable row level security;
revoke all on table screening_v2.phone_identity_hold_releases from public, anon, authenticated;
grant select, insert on table screening_v2.phone_identity_hold_releases to service_role;

comment on table screening_v2.phone_identity_hold_releases is
  'C8 (0114): one row per engagement an operator released from the same-role '
  'duplicate_application hold. While a row exists, '
  'ensure_ashby_phone_engagement never re-holds that engagement. Opaque ids '
  'and a time only: no phone, email, name or external id. Written only by '
  'release_phone_identity_hold. RLS on with no policy; service_role only.';

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
  -- ▼ 0114 C8-a declare
  -- Every candidate row on this admission's LINE (same phone_e164), and
  -- which of them a guard refusal matched. Opaque ids only.
  v_line_candidates uuid[];
  v_hit_candidate   uuid;
  -- ▲ 0114 C8-a declare
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

  -- ── 0095: WHICH DIAL OF THE IST DAY THIS WOULD BE ──────────────────
  -- This REPLACES 0083's `exists(...)` test in place. It is deliberately not
  -- a second check bolted on somewhere below: 0083's own comment above warns
  -- that a pre-check which disagrees with the index leaves "the index fix
  -- alone INERT", and an `exists` test in front of a 1..2 sequence index is
  -- exactly that disagreement — it refuses the SECOND dial before the
  -- sequence is ever consulted, making the whole same-day retry dead code.
  -- One site now decides both the refusal and the sequence number, so they
  -- cannot drift apart again.
  --
  -- Counted over exactly the rows the unique index covers, under the same
  -- advisory lock that serialises admission, so the count and the index can
  -- never disagree. 0094's `infra_deferred` exemption is honoured here too:
  -- an attempt our own infrastructure deferred never consumed the
  -- candidate's day.
  --
  -- Guarded by `p_kind` exactly as the old check was, so `reconnect` is
  -- NEITHER COUNTED NOR REFUSED. Refusing a reconnect here would strand the
  -- engagement in `reconnecting` for ever with no edge out — the failure this
  -- function warns about twice elsewhere. A reconnect keeps the column's
  -- default of 1 and sits outside the index predicate entirely.
  if p_kind in ('initial','no_answer_retry','scheduled') then
    select coalesce(max(a.ist_day_seq), 0) + 1 into v_day_seq
      from screening_v2.phone_call_attempts a
     where a.engagement_id = p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind = any (array['initial','no_answer_retry','scheduled'])
       -- NULL-SAFE: see the index predicate. Reclaim rows have
       -- abandon_reason NULL; NOT(... AND NULL) is NULL and would
       -- silently uncount them. IS DISTINCT FROM keeps them charged.
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred');

    if v_day_seq > 2 then
      -- The anti-harassment invariant, refused in the open rather than as an
      -- index violation, so the caller learns WHY. 0043 held this at one dial
      -- per IST day; 0095 moves it to two and not one more.
      return jsonb_build_object('status', 'daily_attempt_exists',
                                'ist_date', v_ist_date,
                                'dials_today', v_day_seq - 1,
                                'max_per_day', 2);
    end if;
  else
    v_day_seq := 1;
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
  -- ▼ 0114 C8-a line set
  -- 0114 (C8): BOTH per-person guards below key on the LINE, not only on this
  -- candidate row. Ashby import creates one candidate row per application
  -- and never dedups (house rule 0029/0042), so one human can sit on two rows
  -- for one role; keyed by candidate_id, each row passed its own guard and one
  -- phone was dialled twice on one IST day (prod lines ffc393 / 3247c3).
  -- The set is every row whose phone_e164 equals the number validated above,
  -- plus this row itself. The number never leaves v_phone: it is not
  -- returned, logged or audited. ATOMICITY: this read-then-decide spans
  -- sibling rows, which LOCK 1b (keyed by THIS row's candidate id) does not
  -- cover; it rests on LOCK 1, the global phone_admission serialiser, taken
  -- as the first statement. Narrowing LOCK 1 must re-key this guard first.
  -- The scheduled/reconnect exemptions and ist_day_seq are unchanged.
  select array_agg(c.id) into v_line_candidates
    from screening_v2.candidates c
   where c.phone_e164 = v_phone
      or c.id = v_eng.candidate_id;
  -- ▲ 0114 C8-a line set
  -- Guard A — nobody is on the phone with this person right now.
  -- ▼ 0114 C8-a guard A
  select e.candidate_id into v_hit_candidate
    from screening_v2.phone_call_attempts a
    join screening_v2.phone_engagements e on e.id = a.engagement_id
   where e.candidate_id = any (v_line_candidates)
     and a.engagement_id <> p_engagement_id
     and a.state in ('admitted','ringing','answered_unclassified','human','machine')
     and a.lease_expires_at > p_now
   order by (e.candidate_id = v_eng.candidate_id) desc
   limit 1;
  if found then
    -- Status string unchanged; `scope` is an additive detail key: `candidate`
    -- when this row's own person matched (the 0045 meaning), `line` when only
    -- a sibling row on the same number did. The sibling row is never named.
    return jsonb_build_object('status', 'candidate_call_in_flight',
                              'scope', case when v_hit_candidate = v_eng.candidate_id
                                            then 'candidate' else 'line' end);
  end if;
  -- ▲ 0114 C8-a guard A

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
  -- ▼ 0114 C8-a guard B
  if p_kind in ('initial','no_answer_retry') then
    select e.candidate_id into v_hit_candidate
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = any (v_line_candidates)
       and a.engagement_id <> p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind in ('initial','no_answer_retry','scheduled')
       -- NULL-SAFE: see the index predicate (reclaim rows carry NULL reason).
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred')
     order by (e.candidate_id = v_eng.candidate_id) desc
     limit 1;
    if found then
      return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                                'ist_date', v_ist_date,
                                'scope', case when v_hit_candidate = v_eng.candidate_id
                                              then 'candidate' else 'line' end);
    end if;
  end if;
  -- ▲ 0114 C8-a guard B

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

  -- `v_day_seq` was decided ABOVE, in the same place as the refusal, and is
  -- not recomputed here. An earlier draft had the count in this position,
  -- behind 0083's untouched `exists(...)` pre-check — which meant the second
  -- same-day dial was refused ~180 lines before this line could ever run, and
  -- the entire same-day retry feature was dead code. Deciding the sequence
  -- and the refusal at one site is what stops that recurring.

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
      -- BOTH names are matched. 0095 replaces
      -- `uq_phone_attempts_one_per_ist_day` with
      -- `uq_phone_attempts_per_ist_day_seq`, and this handler was written
      -- against the old name. Left unchanged, every race lost on the NEW
      -- index would fall through to `attempt_in_flight` — precisely the
      -- misreport the comment above forbids, and one that sends an operator
      -- looking for a call that is not happening. The old name is kept so
      -- the handler stays correct against a database where 0095 has not yet
      -- been applied.
      if v_constraint in ('uq_phone_attempts_one_per_ist_day',
                          'uq_phone_attempts_per_ist_day_seq') then
        return jsonb_build_object('status', 'daily_attempt_exists',
                                  'ist_date', v_ist_date,
                                  'max_per_day', 2);
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

comment on function screening_v2.admit_phone_attempt is
  'RPC-authoritative admission. Since 0045 it also refuses a dial to a person '
  'who is already on a call through ANOTHER engagement '
  '(candidate_call_in_flight) or who has already been called today through '
  'one (candidate_daily_attempt_exists) — every 0042 index is keyed by '
  'engagement, and a person is not. Since 0114 (C8) both refusals key on the '
  'phone LINE (every candidate row with the same phone_e164), because one '
  'person can sit on several candidate rows; the refusal carries a `scope` '
  'detail (candidate|line) and never names the other row. Both refusals are '
  'free. Service-role-only.';

create or replace function screening_v2.ensure_ashby_phone_engagement(
  p_application_link_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link screening_v2.ashby_application_links%rowtype;
  v_map screening_v2.ashby_job_mappings%rowtype;
  v_candidate screening_v2.candidates%rowtype;
  v_ing_state text;
  v_eng screening_v2.phone_engagements%rowtype;
  v_template screening_v2.consent_templates%rowtype;
  v_consent screening_v2.consent_records%rowtype;
  v_next timestamptz;
begin
  perform pg_advisory_xact_lock(
    hashtext('ashby_phone_engagement'),
    hashtext(coalesce(p_application_link_id::text, ''))
  );

  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby'
   for update;
  if not found then
    return jsonb_build_object('status', 'application_not_found');
  end if;

  if v_link.candidate_id is null then
    return jsonb_build_object('status', 'candidate_missing');
  end if;

  select * into v_candidate
    from screening_v2.candidates
   where id = v_link.candidate_id;
  if not found then
    return jsonb_build_object('status', 'candidate_missing');
  end if;

  -- Automatic Ashby materialization is allowed to create only the first
  -- cycle. A terminal cycle is history, not an invitation to create an
  -- implicit re-screen; explicit re-screen intent owns every later cycle.
  if not exists (
    select 1 from screening_v2.phone_engagements
     where application_link_id = v_link.id
  ) then
    insert into screening_v2.phone_engagements (
      application_link_id, candidate_id, role_id, cycle_number,
      state, state_reason
    ) values (
      v_link.id, v_candidate.id, v_candidate.role_id, 1,
      'pending_prereqs', 'evaluating'
    );
  end if;

  select * into v_eng
    from screening_v2.phone_engagements
   where application_link_id = v_link.id
   order by cycle_number desc, created_at desc, id desc
   limit 1
   for update;

  if v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal', 'state', v_eng.state);
  end if;
  if v_eng.state not in ('pending_prereqs', 'eligible') then
    return jsonb_build_object('status', 'engagement_active', 'state', v_eng.state,
                              'engagement_id', v_eng.id);
  end if;

  if v_eng.candidate_id <> v_candidate.id
     or v_eng.role_id is distinct from v_candidate.role_id then
    update screening_v2.phone_engagements
       set state_reason = 'identity_mismatch', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'identity_mismatch', 'engagement_id', v_eng.id);
  end if;

  if v_link.terminal_state is not null or v_link.lifecycle in ('completed', 'cancelled') then
    update screening_v2.phone_engagements
       set state = 'cancelled', state_reason = 'application_terminal',
           terminal_at = p_now, updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'application_terminal', 'engagement_id', v_eng.id);
  end if;

  select * into v_map
    from screening_v2.ashby_job_mappings
   where id = v_link.job_mapping_id;
  if not found or v_map.status <> 'enabled' or v_map.role_id is distinct from v_candidate.role_id then
    update screening_v2.phone_engagements
       set state_reason = 'mapping_not_enabled', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'mapping_not_enabled', 'engagement_id', v_eng.id);
  end if;

  select state into v_ing_state
    from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link.id;
  if v_ing_state is distinct from 'ready' then
    update screening_v2.phone_engagements
       set state_reason = 'ingestion_not_ready', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'ingestion_not_ready', 'engagement_id', v_eng.id);
  end if;

  if not coalesce(v_candidate.phone_valid, false)
     or v_candidate.phone_e164 is null
     or v_candidate.phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    update screening_v2.phone_engagements
       set state_reason = 'phone_invalid', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'phone_invalid', 'engagement_id', v_eng.id);
  end if;

  -- ▼ 0114 C8-b duplicate hold
  -- Same-role duplicate application (C8). ONLY a first-cycle engagement still
  -- in `pending_prereqs` that is not an HR rescreen child and was not
  -- released by an operator can be held: 0042 lets pending_prereqs reach
  -- only eligible|cancelled, an eligible row is never relabelled, and an HR
  -- rescreen cycle is never held. Placed after the phone_invalid return and
  -- BEFORE the consent checks, so no consent record is minted for a held row.
  --
  -- Lock order: the link and the engagement (locked above), THEN the
  -- `ashby_person_identity` advisory lock. It is keyed by ROLE: a hold needs
  -- the same role, so every row that could match this one serialises on the
  -- same key, and the second of two racing rows always sees the first one's
  -- committed promotion.
  --
  -- Another row blocks this one only when it is a DIFFERENT candidate row of
  -- the SAME role that matches on the phone line, the normalised email, or
  -- (external_candidate_id, job mapping) AND holds an engagement that is live
  -- past prerequisites (eligible, scheduled, dialing, in_call, reconnecting,
  -- awaiting_retry) or `completed`. A pending_prereqs row (held or not)
  -- promised no call and never blocks, so two stuck rows cannot hold each
  -- other; a withdrawn, failed, unreached or cancelled screen never blocks,
  -- so a re-application after it is screened.
  --
  -- The row stays pending_prereqs with state_reason duplicate_application.
  -- The result names only THIS engagement, never the other row; no number,
  -- email or external id is returned, logged or audited.
  if v_eng.state = 'pending_prereqs'
     and v_eng.cycle_number = 1
     and not exists (select 1 from screening_v2.phone_rescreen_requests r
                      where r.new_engagement_id = v_eng.id)
     and not exists (select 1 from screening_v2.phone_identity_hold_releases h
                      where h.engagement_id = v_eng.id) then
    perform pg_advisory_xact_lock(
      hashtext('ashby_person_identity'),
      hashtext(coalesce(v_candidate.role_id::text, ''))
    );
    if exists (
      select 1
        from screening_v2.candidates c
        join screening_v2.phone_engagements o on o.candidate_id = c.id
       where c.id <> v_candidate.id
         and c.role_id = v_candidate.role_id
         and ((o.terminal_at is null and o.state <> 'pending_prereqs')
              or o.state = 'completed')
         and (c.phone_e164 = v_candidate.phone_e164
              or (nullif(btrim(v_candidate.email), '') is not null
                  and c.email is not null
                  and lower(btrim(c.email)) = lower(btrim(v_candidate.email)))
              or (v_link.external_candidate_id is not null
                  and exists (
                    select 1 from screening_v2.ashby_application_links l2
                     where l2.candidate_id = c.id
                       and l2.external_candidate_id = v_link.external_candidate_id
                       and l2.job_mapping_id = v_link.job_mapping_id)))
    ) then
      update screening_v2.phone_engagements
         set state_reason = 'duplicate_application', updated_at = p_now, version = version + 1
       where id = v_eng.id;
      return jsonb_build_object('status', 'duplicate_application', 'engagement_id', v_eng.id);
    end if;
  end if;
  -- ▲ 0114 C8-b duplicate hold
  if v_link.submitted_at is null or v_link.submitted_at > p_now + interval '5 minutes' then
    update screening_v2.phone_engagements
       set state_reason = 'consent_evidence_missing', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_evidence_missing', 'engagement_id', v_eng.id);
  end if;

  select * into v_consent
    from screening_v2.consent_records
   where candidate_id = v_candidate.id
   order by created_at desc, id desc
   limit 1;

  if found and v_consent.status <> 'granted' then
    update screening_v2.phone_engagements
       set state_reason = 'consent_not_granted', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_not_granted', 'engagement_id', v_eng.id);
  end if;

  if not found then
    select * into v_template
      from screening_v2.consent_templates
     where is_active
     order by updated_at desc, id desc
     limit 1;
    if not found or v_template.required_consents is null then
      update screening_v2.phone_engagements
         set state_reason = 'consent_template_inactive', updated_at = p_now, version = version + 1
       where id = v_eng.id;
      return jsonb_build_object('status', 'consent_template_inactive', 'engagement_id', v_eng.id);
    end if;

    insert into screening_v2.consent_records (
      candidate_id, source, proof, created_at, updated_at, version, consents,
      status, classification_level
    ) values (
      v_candidate.id,
      'job_application',
      jsonb_build_object('basis', 'ashby_application_submission', 'application_link_id', v_link.id),
      v_link.submitted_at,
      p_now,
      v_template.version,
      v_template.required_consents,
      'granted',
      3
    ) returning * into v_consent;

    update screening_v2.candidates
       set consent_source = 'job_application', consent_at = v_link.submitted_at,
           updated_at = p_now
     where id = v_candidate.id;
  end if;

  if v_consent.expires_at is not null and v_consent.expires_at <= p_now then
    update screening_v2.phone_engagements
       set state_reason = 'consent_expired', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_expired', 'engagement_id', v_eng.id);
  end if;

  select * into v_template
    from screening_v2.consent_templates
   where is_active
   order by updated_at desc, id desc
   limit 1;
  if not found or not (v_template.required_consents <@ v_consent.consents) then
    update screening_v2.phone_engagements
       set state_reason = 'consent_subset_missing', updated_at = p_now, version = version + 1
     where id = v_eng.id;
    return jsonb_build_object('status', 'consent_subset_missing', 'engagement_id', v_eng.id);
  end if;

  v_next := case
    when screening_v2.phone_ist_window_open(p_now) then p_now
    else screening_v2.phone_next_window_open(p_now)
  end;

  update screening_v2.phone_engagements
     set state = 'eligible', state_reason = null, consent_record_id = v_consent.id,
         next_eligible_at = v_next, updated_at = p_now, version = version + 1
   where id = v_eng.id;

  return jsonb_build_object(
    'status', case when v_next <= p_now then 'eligible' else 'scheduled_next_window' end,
    'engagement_id', v_eng.id,
    'next_eligible_at', v_next
  );
end;
$$;

revoke all on function screening_v2.ensure_ashby_phone_engagement(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.ensure_ashby_phone_engagement(uuid, timestamptz)
  to service_role;

comment on function screening_v2.ensure_ashby_phone_engagement is
  'Ashby prerequisite evaluator: materialises cycle 1 and promotes '
  'pending_prereqs -> eligible when every prerequisite holds. POLICY (0114, '
  'C8): a first-cycle pending_prereqs engagement is HELD (state_reason '
  'duplicate_application, status duplicate_application) when a different '
  'candidate row of the SAME role matches it on phone line, normalised email '
  'or (external_candidate_id, job mapping) and holds an engagement past '
  'prerequisites or completed. HR rescreen cycles, eligible rows, other roles '
  'and released engagements are never held; a withdrawn, failed, unreached or '
  'cancelled screen never blocks a re-application. The hold mints no consent, '
  'names only this engagement, and is lifted by release_phone_identity_hold. '
  'Never creates an attempt or a queue job. Service-role-only.';

create or replace function screening_v2.schedule_candidate_phone_appointment(
  p_candidate_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link_id uuid;
  v_eng_id uuid;
  v_result jsonb;
  v_status text;
  v_schedule jsonb;
begin
  if p_candidate_id is null or p_actor_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phone_candidate_schedule'),
    hashtext(p_candidate_id::text)
  );

  select id into v_link_id
    from screening_v2.ashby_application_links
   where provider = 'ashby'
     and candidate_id = p_candidate_id
     and terminal_state is null
     and lifecycle not in ('completed', 'cancelled')
   order by updated_at desc, id desc
   limit 1;
  if not found then
    -- The candidate is known to the caller, but no live Ashby application can
    -- author a phone screen. Keep the answer stable and non-sensitive.
    if exists (select 1 from screening_v2.candidates where id = p_candidate_id) then
      return jsonb_build_object('status', 'application_not_found');
    end if;
    return jsonb_build_object('status', 'candidate_not_found');
  end if;

  v_result := screening_v2.ensure_ashby_phone_engagement(v_link_id, p_now);
  v_status := coalesce(v_result->>'status', 'unknown_status');
  v_eng_id := nullif(v_result->>'engagement_id', '')::uuid;

  -- ▼ 0114 C8-d duplicate hold
  -- A same-role duplicate application is held in pending_prereqs (C8). Booking
  -- a slot for it would promise a call the hold exists to prevent, so return
  -- before schedule_phone_appointment; HR releases the hold first.
  if v_status = 'duplicate_application' then
    return jsonb_build_object('status', 'duplicate_application', 'engagement_id', v_eng_id);
  end if;
  -- ▲ 0114 C8-d duplicate hold
  if v_status = 'engagement_terminal' or v_status = 'application_terminal' then
    return jsonb_build_object('status', 'rescreen_required');
  end if;
  if v_status = 'application_not_live' then
    return jsonb_build_object('status', 'application_not_live');
  end if;
  if v_eng_id is null then
    return jsonb_build_object('status', 'prerequisites_unavailable');
  end if;

  -- A pending prerequisite is still a valid calendar intention. The existing
  -- RPC returns ok_prereqs_pending, which tells HR that the slot exists but no
  -- dial is promised until admission re-checks every prerequisite.
  v_schedule := screening_v2.schedule_phone_appointment(
    v_eng_id, p_starts_at, p_ends_at, 'hr_manual', p_actor_id, null, p_now
  );
  return v_schedule || jsonb_build_object('engagement_id', v_eng_id);
end;
$$;

revoke all on function screening_v2.schedule_candidate_phone_appointment(uuid, timestamptz, timestamptz, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.schedule_candidate_phone_appointment(uuid, timestamptz, timestamptz, uuid, timestamptz)
  to service_role;

comment on function screening_v2.schedule_candidate_phone_appointment is
  'Candidate-scoped atomic booking wrapper. Resolves a live application and '
  'active phone cycle, then delegates to schedule_phone_appointment. It never '
  'reopens a terminal cycle, creates a dial attempt, or contacts a provider. '
  'Since 0114 (C8) it books nothing for a same-role duplicate application '
  'held by ensure_ashby_phone_engagement (status duplicate_application). '
  'Service-role-only.';

-- The operator release for a duplicate_application hold (C8-C). Refuses
-- unless the engagement is held right now; records the release so ensure
-- never re-holds it; audits it; then re-runs ensure so the engagement moves
-- on (or reports its next prerequisite) in the same transaction.
--
-- Lock order mirrors ensure exactly: the per-link `ashby_phone_engagement`
-- advisory lock, the link row, the engagement row. The nested ensure call
-- re-takes the same advisory lock (re-entrant in one transaction) and the
-- same rows, so the release can never deadlock against an ensure for the
-- same link.
create or replace function screening_v2.release_phone_identity_hold(
  p_engagement_id uuid,
  p_actor_id      uuid,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link_id uuid;
  v_eng     screening_v2.phone_engagements%rowtype;
  v_ensure  jsonb;
begin
  -- An operator action is attributable or it does not happen.
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_engagement_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  -- Unlocked read: the link id is reachable only through the engagement.
  select application_link_id into v_link_id
    from screening_v2.phone_engagements
   where id = p_engagement_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('ashby_phone_engagement'),
    hashtext(coalesce(v_link_id::text, ''))
  );
  perform 1
    from screening_v2.ashby_application_links
   where id = v_link_id
   for update;

  select * into v_eng
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_eng.terminal_at is not null
     or v_eng.state <> 'pending_prereqs'
     or v_eng.state_reason is distinct from 'duplicate_application' then
    return jsonb_build_object('status', 'not_held', 'state', v_eng.state,
                              'engagement_id', v_eng.id);
  end if;

  insert into screening_v2.phone_identity_hold_releases
    (engagement_id, actor_id, created_at)
  values (v_eng.id, p_actor_id, p_now)
  on conflict (engagement_id) do nothing;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata,
     created_at)
  values
    -- An operator action: the named admin identity, actor_type recruiter.
    -- Opaque ids and stable codes only; the other row is never named.
    (p_actor_id, 'recruiter', 'phone_identity_hold_release', 'phone_engagement',
     v_eng.id::text, 'success',
     jsonb_build_object('application_link_id', v_eng.application_link_id,
                        'cycle_number', v_eng.cycle_number,
                        'prior_reason', 'duplicate_application'),
     p_now);

  v_ensure := screening_v2.ensure_ashby_phone_engagement(v_link_id, p_now);

  return jsonb_build_object('status', 'ok',
                            'engagement_id', v_eng.id,
                            'prerequisite_status', v_ensure->>'status');
end;
$$;

revoke all on function screening_v2.release_phone_identity_hold(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.release_phone_identity_hold(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.release_phone_identity_hold is
  'C8 (0114) operator release of a same-role duplicate_application hold. '
  'actor_required on a null actor; not_held unless the engagement is '
  'pending_prereqs/duplicate_application right now. Records the release in '
  'phone_identity_hold_releases (idempotent), audits '
  'phone_identity_hold_release, then re-runs ensure_ashby_phone_engagement '
  'and returns its status as prerequisite_status. Never creates an attempt or '
  'a queue job. Service-role-only.';
-- ==== 0114 §6 END ====


-- ==== 0114 §7 BEGIN ====
-- §7 — request_phone_rescreen drift (C6). Owner: S7.
--
-- WHY THIS FUNCTION IS REDECLARED. PR #145 (98596bc) EDITED 0057 AFTER
-- production had applied #144's text: it added the
-- `perform ensure_ashby_phone_engagement(v_link.id, p_now)` call to
-- request_phone_rescreen. Supabase never re-runs an applied migration, so prod
-- kept the #144 body and never evaluates a new cycle's prerequisites:
-- position('ensure_ashby_phone_engagement' in pg_get_functiondef(...)) = 0,
-- re-verified 2026-10-03. Every rescreen child stayed pending_prereqs until a
-- call-now, a booking or an ingestion happened to run ensure, and the owner
-- test gate's fresh path wedged (409 not_armable on every retry). No test
-- could see it: local databases apply the EDITED repo text, and 0057-G1 only
-- asserted `pending_prereqs` (now tightened to the evaluator's reason).
-- Prevention ships with this section: the PR-only `migrations-immutable` CI
-- job refuses any modified, deleted or renamed migration file, and
-- scripts/verify-prod-function-drift.sh asserts the LIVE prod body after
-- every production migration run (deploy-fly.yml).
--
-- Lifted by script from 0057, the newest declaration on c2d2c90. The
-- signature, SECURITY DEFINER, pinned search_path, every refusal and the
-- service_role-only ACL are unchanged. Every change sits between
-- `-- ▼ 0114 C6-<id>` / `-- ▲ 0114 C6-<id>` markers, and
-- phone-rescreen-0114-migration.test.ts proves the rest is byte-identical:
--   C6-declare  the new locals.
--   C6-replay   a same-intent replay stays a READ, except a strictly
--               predicated self-heal: ensure runs only when the stored child
--               is non-terminal, pending_prereqs and still the newest cycle of
--               its link (re-checked under the canonical locks). The answer
--               gains `prerequisite_status` (null for a pure read).
--   C6-lock     canonical lock order: an UNLOCKED newest-link resolve, then
--               ensure's `ashby_phone_engagement`(link) advisory lock, then
--               the link FOR UPDATE, re-validated as still the newest link.
--               The 0057 repo body locked the link row FIRST and reached the
--               advisory lock only inside ensure, the inverse of ensure's own
--               order (advisory, then link): a deadlock against a concurrent
--               ensure, booking or release on the same link.
--   C6-ensure   ensure runs AFTER the child, request and audit inserts (it
--               reads phone_rescreen_requests to know a rescreen child is
--               never duplicate-held, C8). A result naming any other
--               engagement raises rescreen_evaluator_target_mismatch
--               (data_exception) and rolls the whole intent back, retry-safe.
--               The answer gains `prerequisite_status` (ensure's status).
-- Still never creates an attempt or a queue job: admit stays the only billable
-- door. No backfill (0 stuck children in prod, 2026-10-03).
create or replace function screening_v2.request_phone_rescreen(
  p_candidate_id uuid,
  p_reason text,
  p_request_id text,
  p_source text default 'hr_manual',
  p_actor_id uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_candidate screening_v2.candidates%rowtype;
  v_link screening_v2.ashby_application_links%rowtype;
  v_prev screening_v2.phone_engagements%rowtype;
  v_consent screening_v2.consent_records%rowtype;
  v_request screening_v2.phone_rescreen_requests%rowtype;
  v_new_id uuid;
  v_cycle integer;
  v_verified_at timestamptz;
  -- ▼ 0114 C6-declare
  v_link_id uuid;
  v_newest_link_id uuid;
  v_child screening_v2.phone_engagements%rowtype;
  v_prereq jsonb;
  v_prereq_status text;
  -- ▲ 0114 C6-declare
begin
  if p_source is null or p_source not in ('hr_manual','automation') then
    return jsonb_build_object('status', 'invalid_source');
  end if;
  if p_reason is null or p_reason not in (
    'candidate_requested','incomplete_screening','technical_issue',
    'role_changed','quality_review') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    return jsonb_build_object('status', 'invalid_request_id');
  end if;
  if p_source = 'hr_manual' and p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phone_rescreen'),
    hashtext(coalesce(p_candidate_id::text, ''))
  );

  select * into v_request from screening_v2.phone_rescreen_requests
   where source = p_source and request_id = p_request_id
   for update;
  if found then
    if v_request.candidate_id <> p_candidate_id then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    -- ▼ 0114 C6-replay
    -- A same-intent replay is a READ, with ONE strictly predicated self-heal:
    -- the stored child is non-terminal, still pending_prereqs, and still the
    -- newest cycle of its link. That is exactly the child the #145 drift left
    -- stuck, so the retry a caller naturally sends now promotes it. An
    -- eligible, scheduled, live or terminal child, or one a newer cycle has
    -- superseded, is answered untouched (no write, prerequisite_status null).
    select * into v_child from screening_v2.phone_engagements
     where id = v_request.new_engagement_id;
    if found
       and v_child.terminal_at is null
       and v_child.state = 'pending_prereqs'
       and not exists (select 1 from screening_v2.phone_engagements n
                        where n.application_link_id = v_child.application_link_id
                          and n.cycle_number > v_child.cycle_number) then
      -- The canonical order (ensure's own): the link's advisory lock, then the
      -- link row, then the engagement row. Re-checked under the locks, since a
      -- concurrent evaluator may already have promoted or ended the child.
      perform pg_advisory_xact_lock(
        hashtext('ashby_phone_engagement'),
        hashtext(coalesce(v_child.application_link_id::text, ''))
      );
      perform 1 from screening_v2.ashby_application_links
       where id = v_child.application_link_id
       for update;
      select * into v_child from screening_v2.phone_engagements
       where id = v_request.new_engagement_id
       for update;
      if v_child.terminal_at is null
         and v_child.state = 'pending_prereqs'
         and not exists (select 1 from screening_v2.phone_engagements n
                          where n.application_link_id = v_child.application_link_id
                            and n.cycle_number > v_child.cycle_number) then
        v_prereq := screening_v2.ensure_ashby_phone_engagement(
          v_child.application_link_id, p_now);
        if (v_prereq ->> 'engagement_id') is distinct from v_child.id::text then
          raise exception 'rescreen_evaluator_target_mismatch'
            using errcode = 'data_exception';
        end if;
        v_prereq_status := v_prereq ->> 'status';
      end if;
    end if;
    return jsonb_build_object('status', 'already_requested',
      'request_id', v_request.request_id,
      'engagement_id', v_request.new_engagement_id,
      'cycle_number', (select cycle_number from screening_v2.phone_engagements where id = v_request.new_engagement_id),
      'prerequisite_status', v_prereq_status);
    -- ▲ 0114 C6-replay
  end if;

  select * into v_candidate from screening_v2.candidates
   where id = p_candidate_id;
  if not found then return jsonb_build_object('status', 'candidate_not_found'); end if;

  -- One application is selected deterministically. The application link is
  -- never accepted from the browser, preventing cross-candidate/link abuse.
  -- ▼ 0114 C6-lock
  -- Resolve the newest link UNLOCKED, take ensure's advisory lock on it, and
  -- only then lock the row: the same order ensure, schedule_candidate and
  -- release_phone_identity_hold take. The row is re-validated as still the
  -- newest under the lock; a link that moved in that gap fails the intent
  -- with a retry-safe serialization_failure instead of acting on a stale pick.
  select id into v_link_id from screening_v2.ashby_application_links
   where provider = 'ashby' and candidate_id = p_candidate_id
   order by updated_at desc, id desc limit 1;
  if not found then return jsonb_build_object('status', 'application_not_found'); end if;
  perform pg_advisory_xact_lock(
    hashtext('ashby_phone_engagement'),
    hashtext(coalesce(v_link_id::text, ''))
  );
  select * into v_link from screening_v2.ashby_application_links
   where id = v_link_id
   for update;
  if not found then return jsonb_build_object('status', 'application_not_found'); end if;
  select id into v_newest_link_id from screening_v2.ashby_application_links
   where provider = 'ashby' and candidate_id = p_candidate_id
   order by updated_at desc, id desc limit 1;
  if v_newest_link_id is distinct from v_link_id then
    raise exception 'rescreen_application_link_moved'
      using errcode = 'serialization_failure';
  end if;
  -- ▲ 0114 C6-lock
  if v_link.terminal_state is not null or v_link.lifecycle in ('completed','cancelled') then
    return jsonb_build_object('status', 'application_not_live');
  end if;

  select * into v_prev from screening_v2.phone_engagements
   where application_link_id = v_link.id
   order by cycle_number desc, created_at desc, id desc limit 1 for update;
  if not found then return jsonb_build_object('status', 'engagement_not_found'); end if;
  if v_prev.terminal_at is null then
    return jsonb_build_object('status', 'active_cycle',
      'engagement_id', v_prev.id, 'cycle_number', v_prev.cycle_number);
  end if;
  if v_prev.state = 'opted_out' then return jsonb_build_object('status', 'opted_out'); end if;
  if v_prev.state = 'wrong_number' then
    select max(verified_at) into v_verified_at
      from screening_v2.phone_number_verifications
     where candidate_id = p_candidate_id
       and verified_at > v_prev.terminal_at;
    if v_verified_at is null then
      return jsonb_build_object('status', 'wrong_number_unverified');
    end if;
  elsif v_prev.state not in ('completed','failed','abandoned_no_answer','cancelled') then
    return jsonb_build_object('status', 'not_eligible', 'state', v_prev.state);
  end if;

  if v_prev.cycle_number >= 3 then
    return jsonb_build_object('status', 'cycle_limit_reached');
  end if;

  select * into v_consent from screening_v2.consent_records
   where candidate_id = p_candidate_id
   order by created_at desc, id desc limit 1;
  if not found or v_consent.status <> 'granted' then
    return jsonb_build_object('status', 'consent_not_granted');
  end if;
  if v_consent.expires_at is not null and v_consent.expires_at <= p_now then
    return jsonb_build_object('status', 'consent_expired');
  end if;

  v_cycle := v_prev.cycle_number + 1;
  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, cycle_number,
     no_answer_limit, state, state_reason, consent_record_id, created_at, updated_at)
  values
    (v_link.id, p_candidate_id, v_candidate.role_id, v_cycle,
     1, 'pending_prereqs', 'rescreen_requested', v_consent.id, p_now, p_now)
  returning id into v_new_id;

  insert into screening_v2.phone_rescreen_requests
    (application_link_id, candidate_id, predecessor_engagement_id,
     new_engagement_id, source, reason, request_id, actor_id, created_at)
  values
    (v_link.id, p_candidate_id, v_prev.id, v_new_id,
     p_source, p_reason, p_request_id, p_actor_id, p_now);

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
     case when p_actor_id is null then 'system' else 'recruiter' end,
     'phone_rescreen_requested', 'phone_engagement', v_new_id::text, 'success',
     jsonb_build_object('application_link_id', v_link.id,
       'predecessor_engagement_id', v_prev.id, 'cycle_number', v_cycle,
       'source', p_source, 'reason', p_reason));

  -- ▼ 0114 C6-ensure
  -- Run the ordinary Ashby prerequisite evaluator NOW, after the child, the
  -- request row and the audit row exist, so a new cycle never waits for an
  -- unrelated trigger (the #145 intent prod never received). It may leave the
  -- child pending with a stable reason, but it never creates an attempt or a
  -- queue job. The evaluator works on the link's NEWEST cycle, which is this
  -- child; anything else is a broken invariant, so the intent rolls back.
  v_prereq := screening_v2.ensure_ashby_phone_engagement(v_link.id, p_now);
  if (v_prereq ->> 'engagement_id') is distinct from v_new_id::text then
    raise exception 'rescreen_evaluator_target_mismatch'
      using errcode = 'data_exception';
  end if;
  v_prereq_status := v_prereq ->> 'status';

  return jsonb_build_object('status', 'ok', 'engagement_id', v_new_id,
    'cycle_number', v_cycle, 'predecessor_engagement_id', v_prev.id,
    'prerequisite_status', v_prereq_status);
  -- ▲ 0114 C6-ensure
end;
$$;
revoke all on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz)
  to service_role;

comment on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz) is
  'Governed append-only rescreen cycle (0057, redeclared by 0114 C6 because '
  'PR #145 edited 0057 after prod applied it, so prod never ran ensure). '
  'Locks: phone_rescreen(candidate), then ashby_phone_engagement(link), then '
  'the link row, then the engagement rows. Creates the child pending_prereqs, '
  'records the request and the audit, then runs ensure_ashby_phone_engagement '
  'and returns its status as prerequisite_status. A same-intent replay is a '
  'read, except it re-runs ensure for a non-terminal pending_prereqs child '
  'that is still its link''s newest cycle. Never creates an attempt or a queue '
  'job. Service-role-only.';
-- ==== 0114 §7 END ====


-- ==== 0114 §8 BEGIN ====
-- §8 — Halt provenance and phone_control direct-write audit (C10b). Owner: S8.
--
-- THE DEFECT. set_phone_halt / clear_phone_halt accepted a NULL actor and
-- recorded actor_type `recruiter` under the system sentinel, so an anonymous
-- clear (which RESUMES dialing) read as a person's decision. And a raw write
-- to phone_control (psql, the dashboard SQL editor, a migration) was audited
-- by nothing: 6 out-of-API changes in production, 2 of them anonymous.
--
-- THE FIX.
--   * set_phone_halt is LIFTED from 0110 (its newest declaration, which holds
--     the reason precedence) and clear_phone_halt from 0042, by script, with
--     ONLY these marked hunks:
--       C10b-actor-type      (set) a NULL actor is audited as actor_type
--                            `system`, not `recruiter`. An unattributed HALT
--                            is still allowed: a halt is never refused;
--       C10b-actor-required  (clear) a NULL actor answers `actor_required` as
--                            the FIRST statement, before any read or write;
--       C10b-provenance      metadata gains `attributed`, `db_session_user`
--                            and a sanitised `application_name` (a bounded
--                            [A-Za-z0-9 _./:-] prefix, so no address or token
--                            text can reach the audit row).
--     Signatures, SECURITY DEFINER, search_path, grants and every other line
--     are unchanged (structural test: phone-0114-halt-provenance.test.ts).
--   * admit_phone_test_attempt (0063) is NOT touched at all.
--   * audit_phone_control_direct_write + an AFTER INSERT OR UPDATE OR DELETE
--     row trigger on phone_control. A write that changes the halt (INSERT,
--     DELETE, or an UPDATE of halted_at / halt_reason / halt_actor_id) writes
--     ONE `admin_session_override` row with override
--     `phone_control_direct_write` under the system actor, UNLESS the
--     statement was issued directly by set_phone_halt, clear_phone_halt or
--     admit_phone_test_attempt (the owner-test gate's transactional
--     operator_pause lift/restore, including its exception-handler restore).
--     The trigger names its writer from the PL/pgSQL call stack
--     (GET DIAGNOSTICS ... PG_CONTEXT): the first PL/pgSQL frame above the
--     trigger's own. Nothing is stateful, so a raw write later in the SAME
--     transaction as an RPC is still audited. The audit is best effort: any
--     failure is swallowed with a WARNING (no PII in it) and the write
--     stands; an audit outage must never block or revert a halt.
--
-- DEVIATION FROM THE DESIGN (S03-RESEARCH C10b). The design tagged writers
-- with a function-level `SET screening_v2.phone_control_writer = ...` and an
-- `ALTER FUNCTION admit_phone_test_attempt ... SET`. Postgres refuses a
-- function-level SET of a custom (placeholder) parameter to a non-superuser
-- ("permission denied to set parameter"), and Supabase migrations run as the
-- non-superuser `postgres`; GRANT SET ON PARAMETER is superuser-only too.
-- The call-stack check needs no parameter, no body change to the test gate,
-- and has no transaction-scoped state to leak.
--
-- RISKS (stated, accepted). The caller check is visibility for honest
-- operators, not a security boundary (only service_role and the owner can
-- write the table at all): a DO block whose statement text embeds a fake
-- frame line, or a same-named function that someone with DDL rights puts in
-- a schema on its own search_path (so its frame prints unqualified), is not
-- audited. A same-named function elsewhere prints `<schema>.<name>` and IS
-- audited (policy 0114-§8). A future CREATE OR REPLACE of
-- set/clear/test-gate keeps working as long as the name is unchanged; a
-- renamed writer would start being audited (fail-visible). TRUNCATE is
-- statement-level and not covered.
--
-- Rollback (forward-only, 0115+): redeclare set_phone_halt from 0110 and
-- clear_phone_halt from 0042, drop the trigger and its function.

create or replace function screening_v2.set_phone_halt(
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
  -- Ascending restrictiveness. array_position gives the rank.
  v_precedence  constant text[] := array[
    'operator_pause','cost_control','provider_incident','legal_hold','emergency_stop'];
  v_actor       constant uuid := coalesce(p_actor_id,
                                          '00000000-0000-4000-8000-000000000001'::uuid);
  v_prev_at     timestamptz;
  v_prev_reason text;
  v_escalated   boolean := false;
  v_in_force    text;
begin
  if p_reason is null or p_reason not in (
       'operator_pause','provider_incident','cost_control','legal_hold','emergency_stop') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.phone_control (control_key)
  values ('default') on conflict (control_key) do nothing;

  select halted_at, halt_reason into v_prev_at, v_prev_reason
    from screening_v2.phone_control
   where control_key = 'default'
   for update;

  -- Escalate only on a STRICTLY stronger reason. An unrankable stored reason
  -- yields null here, and null is not an escalation.
  if v_prev_at is not null then
    v_escalated := coalesce(
      array_position(v_precedence, p_reason) > array_position(v_precedence, v_prev_reason),
      false);
  end if;

  update screening_v2.phone_control
     -- Keep the ORIGINAL halt instant while a halt is already in force.
     set halted_at     = coalesce(halted_at, p_now),
         halt_reason   = case when v_prev_at is null or v_escalated
                              then p_reason else halt_reason end,
         halt_actor_id = case when v_prev_at is null or v_escalated
                              then v_actor else halt_actor_id end,
         updated_at    = p_now
   where control_key = 'default'
  returning halt_reason into v_in_force;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (v_actor,
     -- ▼ 0114 C10b-actor-type
     case when p_actor_id is null then 'system' else 'recruiter' end,
     'admin_session_override', 'phone_control', 'default', 'success',
     -- ▲ 0114 C10b-actor-type
     jsonb_build_object('override', 'phone_admission_halt_set',
                        'reason', p_reason,
                        'already_halted', v_prev_at is not null,
                        'previous_reason', coalesce(v_prev_reason, 'none'),
                        'reason_in_force', v_in_force,
                        'reason_escalated', v_escalated)
     -- ▼ 0114 C10b-provenance
     || jsonb_build_object(
          'attributed', p_actor_id is not null,
          'db_session_user', coalesce(substring(session_user::text from '^[A-Za-z0-9 _./:-]{0,64}'), ''),
          'application_name',
            coalesce(substring(current_setting('application_name', true) from '^[A-Za-z0-9 _./:-]{0,64}'), ''))
     -- ▲ 0114 C10b-provenance
    );

  return jsonb_build_object('status', 'ok',
                            'already_halted', v_prev_at is not null,
                            'halt_reason', v_in_force,
                            'reason_escalated', v_escalated);
end;
$$;

revoke all on function screening_v2.set_phone_halt(text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_phone_halt(text, uuid, timestamptz) to service_role;

comment on function screening_v2.set_phone_halt is
  'Freezes ALL new outbound phone admission fleet-wide with no deploy, '
  'preserving the original halt instant across repeated calls. While a halt '
  'is in force the reason escalates to the MOST RESTRICTIVE requested '
  '(emergency_stop > legal_hold > provider_incident > cost_control > '
  'operator_pause) and is never downgraded; an escalation re-attributes the '
  'halt to the escalating actor. Returns the reason in force. Audited and '
  'attributable: a NULL actor is recorded as the system actor with '
  'actor_type system and attributed=false (0114), and is still allowed, '
  'because a halt is never refused. The phone_control direct-write trigger '
  'recognises this function as the writer and does not double-audit it. '
  'Dialing cannot resume '
  'without clear_phone_halt: there is no automatic restart. '
  'Service-role-only.';

create or replace function screening_v2.clear_phone_halt(
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
  -- ▼ 0114 C10b-actor-required
  -- FIRST statement: an unattributed clear resumes dialing for nobody, so it
  -- is refused before any read or write (a halt is never refused).
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  -- ▲ 0114 C10b-actor-required
  select halt_reason, halted_at into v_prev_reason, v_prev_at
    from screening_v2.phone_control
   where control_key = 'default'
   for update;
  if not found then
    -- Nothing to clear, and inventing a cleared singleton would turn a
    -- fail-closed stop into a go.
    return jsonb_build_object('status', 'halt_unreadable');
  end if;

  update screening_v2.phone_control
     set halted_at     = null,
         halt_reason   = null,
         halt_actor_id = null,
         updated_at    = p_now
   where control_key = 'default';

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'::uuid),
     'recruiter', 'admin_session_override', 'phone_control', 'default', 'success',
     jsonb_build_object('override', 'phone_admission_halt_cleared',
                        'previous_reason', coalesce(v_prev_reason, 'none'),
                        'was_halted', v_prev_at is not null)
     -- ▼ 0114 C10b-provenance
     || jsonb_build_object(
          'attributed', p_actor_id is not null,
          'db_session_user', coalesce(substring(session_user::text from '^[A-Za-z0-9 _./:-]{0,64}'), ''),
          'application_name',
            coalesce(substring(current_setting('application_name', true) from '^[A-Za-z0-9 _./:-]{0,64}'), ''))
     -- ▲ 0114 C10b-provenance
    );

  return jsonb_build_object('status', 'ok', 'was_halted', v_prev_at is not null);
end;
$$;

revoke all on function screening_v2.clear_phone_halt(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.clear_phone_halt(uuid, timestamptz) to service_role;

comment on function screening_v2.clear_phone_halt is
  'The EXPLICIT, audited clear that is the only way outbound dialing '
  'resumes after a halt. Refuses actor_required for a NULL actor before any '
  'read or write (0114): resuming calls to people must be attributable. '
  'Refuses halt_unreadable when the singleton is missing rather than '
  'inventing a cleared control — an unreadable kill switch on a billable '
  'dialer is a stop, not a go. Service-role-only.';

-- Direct-write audit. SECURITY DEFINER so it can append to audit_events for
-- any writer; never callable directly (EXECUTE revoked; a trigger function
-- cannot be called outside a trigger anyway). No clock read: created_at takes
-- the column default. Every message and metadata value is a code, a boolean
-- or a sanitised label, never a number, a name or an address.
create or replace function screening_v2.audit_phone_control_direct_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_ctx        text;
  v_caller     text;
  v_old_at     timestamptz;
  v_old_reason text;
  v_old_actor  uuid;
  v_new_at     timestamptz;
  v_new_reason text;
  v_new_actor  uuid;
  v_key        text;
begin
  -- The writer is the first PL/pgSQL frame ABOVE this trigger's own (line 1
  -- of the context is this function; the statement that fired it follows).
  -- A raw statement from a client has no such frame; a DO block shows
  -- `inline_code_block`.
  -- The name is taken verbatim up to its argument list or the following
  -- space, so a function of the same name in another schema reads as
  -- `<schema>.<name>` and is NOT exempt.
  get diagnostics v_ctx = pg_context;
  v_caller := regexp_replace(substring(v_ctx from '\nPL/pgSQL function ([^ (\n]{1,200})'),
                             '^screening_v2\.', '');
  if v_caller in ('set_phone_halt', 'clear_phone_halt', 'admit_phone_test_attempt') then
    return null;
  end if;

  -- OLD is null for INSERT and NEW for DELETE; read each only when it exists.
  if tg_op <> 'INSERT' then
    v_old_at := old.halted_at; v_old_reason := old.halt_reason;
    v_old_actor := old.halt_actor_id; v_key := old.control_key;
  end if;
  if tg_op <> 'DELETE' then
    v_new_at := new.halted_at; v_new_reason := new.halt_reason;
    v_new_actor := new.halt_actor_id; v_key := new.control_key;
  end if;

  -- An UPDATE that leaves the three halt columns alone (e.g. updated_at only)
  -- changes nothing an operator relies on. INSERT and DELETE always matter: a
  -- missing singleton reads as halted (halt_unreadable) everywhere.
  if tg_op = 'UPDATE'
     and v_new_at is not distinct from v_old_at
     and v_new_reason is not distinct from v_old_reason
     and v_new_actor is not distinct from v_old_actor then
    return null;
  end if;

  begin
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-4000-8000-000000000001'::uuid, 'system',
       'admin_session_override', 'phone_control', coalesce(v_key, 'default'), 'success',
       jsonb_build_object(
         'override', 'phone_control_direct_write',
         'operation', lower(tg_op),
         'state_before', case when tg_op = 'INSERT' then 'absent'
                              when v_old_at is null then 'clear' else 'halted' end,
         'state_after', case when tg_op = 'DELETE' then 'absent'
                             when v_new_at is null then 'clear' else 'halted' end,
         'previous_reason', coalesce(v_old_reason, 'none'),
         'reason_after', coalesce(v_new_reason, 'none'),
         'actor_changed', v_new_actor is distinct from v_old_actor,
         'caller', coalesce(substring(v_caller from '^[A-Za-z0-9_.]{1,63}'), 'none'),
         'attributed', false,
         'db_session_user', coalesce(substring(session_user::text from '^[A-Za-z0-9 _./:-]{0,64}'), ''),
         'application_name',
           coalesce(substring(current_setting('application_name', true) from '^[A-Za-z0-9 _./:-]{0,64}'), '')));
  exception when others then
    -- Best effort by design: the write it describes has already happened and
    -- must stand. SQLSTATE only, no row data in the message.
    raise warning 'phone_control_direct_write audit failed (sqlstate %)', sqlstate;
  end;
  return null;
end;
$$;
revoke all on function screening_v2.audit_phone_control_direct_write()
  from public, anon, authenticated;

comment on function screening_v2.audit_phone_control_direct_write() is
  'AFTER row trigger on phone_control (0114 C10b). Audits a halt-changing '
  'INSERT, DELETE or UPDATE that was NOT issued directly by set_phone_halt, '
  'clear_phone_halt or admit_phone_test_attempt (read from the PL/pgSQL '
  'call stack) as admin_session_override / phone_control_direct_write under '
  'the system actor, naming the calling PL/pgSQL function (or none). Best '
  'effort: an audit failure is a WARNING and never blocks the write. '
  'Operator visibility, not a security boundary.';

drop trigger if exists trg_phone_control_direct_write_audit on screening_v2.phone_control;
create trigger trg_phone_control_direct_write_audit
  after insert or update or delete on screening_v2.phone_control
  for each row execute function screening_v2.audit_phone_control_direct_write();
-- ==== 0114 §8 END ====


notify pgrst, 'reload schema';
