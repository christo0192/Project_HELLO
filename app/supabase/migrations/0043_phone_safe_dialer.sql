-- =====================================================================
-- 0043 -- Phone safe dialer: pre-disclosure abandonment + per-attempt
--         recording artifacts (P4).
--
-- FORWARD-ONLY and ADDITIVE. It adds three columns, one partial unique
-- index, four service-role RPCs, and REPLACES exactly one function body
-- (`apply_phone_event`) to add a single new branch. It widens two closed
-- CHECK allowlists using the sanctioned drop-IF-EXISTS -> re-create NOT
-- VALID -> VALIDATE pattern. It drops no table, column, index or
-- unique/foreign-key constraint, and leaves 0001-0042 byte-identical.
--
-- -- WHAT THIS IS, AND WHAT IT IS NOT -----------------------------------
-- This is the DATABASE half of the safe outbound dialer. There is still
-- no TypeScript, no provider client, no SIP call, no route, no flag read
-- and no dial in this migration. Nothing here can place a call.
--
-- -- THE THREE THINGS IT ADDS, AND WHY EACH IS A SAFETY FIX -------------
--
-- 1. `abandoned_pre_disclosure` -- a TRUTHFUL outcome for a candidate who
--    ANSWERS and hangs up before the recording disclosure is delivered.
--    P3 recorded this gap (P3-1): 0042 has no legal `dialing` edge for it,
--    so it surfaced as `unexpected_event` and the outcome was UNRECORDED
--    rather than classified. The two easy answers are both lies -- calling
--    it `no_answer` after somebody demonstrably picked up (the exact
--    defect P3's independent review caught), or calling it an "uncharged
--    reconnect", which is not a thing, because a reconnect grant is
--    precisely what `reconnects_used` counts. So it is its own outcome,
--    it charges NOTHING, and it is bounded by the per-IST-day index that
--    already exists rather than by a new counter with no reset lifecycle.
--
-- 2. Per-attempt recording artifacts -- `recording_object_key`,
--    `recording_manifest_key` and `recording_role`. 0042 gave an attempt
--    an `egress_id` and NO object key, and `egressManifestObjectKey()` is
--    SESSION-scoped. A purge written against the session key alone would
--    report success while a RECONNECT attempt's audio survived: the exact
--    "we believe none was created" failure this lane has already paid for
--    once, and the same manifest-suffix trap PR #91 recorded. An attempt's
--    artifacts must be NAMEABLE before they can be deleted, so they are
--    named here, on the attempt, by constrained columns.
--
-- 3. `recording_role` in DATA, not in prose. The first consented attempt
--    is `authoritative`; every reconnect is `supplementary`. A partial
--    unique index makes a second authoritative binding UNREPRESENTABLE
--    rather than merely discouraged, and an authoritative reader can
--    filter on a column instead of on a promise.
--
-- -- WHAT THE PURGE IS, SAID PLAINLY ------------------------------------
-- The recording purge and the opt-out suppression are ORDERED, DURABLE
-- and IDEMPOTENT. They are NOT atomic, and this migration does not
-- pretend otherwise. No transaction spans Postgres and an object store.
-- The suppression is already atomic with the terminal transition inside
-- `apply_phone_event` (the PR #91 repair), so the caller gets it by
-- posting the event; the object deletion is a separate, verified step
-- that must COMPLETE before the terminal event is posted, and must be
-- retried on failure. `clear_phone_attempt_recordings` therefore records
-- that the deletion HAPPENED; it never performs one and never claims one.
--
-- -- KEYS ARE DERIVED, NOT SUPPLIED -------------------------------------
-- Both key columns are constrained to the EXACT derived artifact names
-- (`phone-<attempt-uuid>-egress.ogg` and its `.json` manifest). This is
-- deliberately narrower than a general path CHECK: a column that can only
-- hold the name the dialer derives cannot be talked into holding a phone
-- number, a provider payload or someone else's object, and it makes "the
-- purge can name what it must delete" a structural property rather than a
-- convention. Changing the container format is therefore a migration, on
-- purpose.
--
-- -- LOCK ORDER ---------------------------------------------------------
-- The new RPCs take `phone_engagements` before `phone_call_attempts`,
-- exactly as 0042 pins it. None of them takes the admission advisory
-- lock, because none of them admits anything.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. CHECK evolution 1 of 2 -- phone_call_attempts.outcome
-- ═══════════════════════════════════════════════════════════════════════
-- Re-declared IN FULL because a CHECK cannot be patched in place. All
-- eleven 0042 members are reproduced verbatim; exactly one is added.
--
-- `abandoned_pre_disclosure` is deliberately NOT folded into
-- `disconnected`. `disconnected` means "the conversation dropped" and
-- carries a reconnect grant; this outcome means "there was no
-- conversation yet", carries no grant and charges no budget. An operator
-- filtering for calls that reached a human must be able to tell the two
-- apart, and a shared label would make that impossible after the fact.

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_outcome;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_outcome check (
    outcome_class is null or outcome_class in (
      'completed','disconnected','no_answer','busy','voicemail','declined',
      'wrong_number','opt_out','provider_error','window_closed','cancelled',
      -- 0043, additive: answered, then dropped before the recording
      -- disclosure was delivered. Charges no budget of any kind.
      'abandoned_pre_disclosure'))
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_outcome;

comment on constraint chk_phone_call_attempts_outcome
  on screening_v2.phone_call_attempts is
  'Closed outcome allowlist, extended ADDITIVELY by 0043 with '
  '`abandoned_pre_disclosure`. No prior member has ever been removed.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Per-attempt recording artifacts
-- ═══════════════════════════════════════════════════════════════════════
-- Nullable and unwritten until a consented attempt actually starts an
-- egress, so adding them changes nothing about any existing row.

alter table screening_v2.phone_call_attempts
  add column if not exists recording_object_key   text;
alter table screening_v2.phone_call_attempts
  add column if not exists recording_manifest_key text;
alter table screening_v2.phone_call_attempts
  add column if not exists recording_role         text;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_object_key;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_object_key check (
    recording_object_key is null
    or recording_object_key ~ '^phone-[0-9a-f-]{36}-egress\.ogg$')
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_object_key;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_manifest_key;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_manifest_key check (
    recording_manifest_key is null
    or recording_manifest_key ~ '^phone-[0-9a-f-]{36}-egress\.ogg\.json$')
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_manifest_key;

alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_role;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_role check (
    recording_role is null or recording_role in ('authoritative','supplementary'))
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_role;

-- A role with no object is a claim about an artifact that does not exist;
-- an object with no role is an artifact no reader can classify, which is
-- exactly how a supplementary recording gets surfaced as authoritative.
-- Neither is representable. A manifest without its object is likewise
-- refused -- the manifest describes the object.
alter table screening_v2.phone_call_attempts
  drop constraint if exists chk_phone_call_attempts_recording_coherent;
alter table screening_v2.phone_call_attempts
  add constraint chk_phone_call_attempts_recording_coherent check (
    (recording_object_key is null) = (recording_role is null)
    and (recording_manifest_key is null or recording_object_key is not null))
  not valid;
alter table screening_v2.phone_call_attempts
  validate constraint chk_phone_call_attempts_recording_coherent;

-- I6 (0043): at most ONE authoritative recording per engagement. The
-- first consented attempt earns it; every reconnect is supplementary.
-- This is the DATA form of the rule -- a second authoritative binding is
-- unrepresentable, not merely discouraged, and an authoritative reader
-- filters on a column rather than on a comment.
create unique index if not exists uq_phone_attempts_one_authoritative_recording
  on screening_v2.phone_call_attempts(engagement_id)
  where recording_role = 'authoritative';

comment on column screening_v2.phone_call_attempts.recording_object_key is
  'Object-store key of THIS ATTEMPT''s recording, constrained to the '
  'exact derived name. Attempt-scoped on purpose: the session-scoped key '
  'cannot name a reconnect attempt''s audio, so a purge written against '
  'it would report success while that audio survived. Never a phone '
  'number, never a provider payload.';
comment on column screening_v2.phone_call_attempts.recording_manifest_key is
  'Object-store key of the egress MANIFEST for this attempt. Named '
  'separately because the manifest is a second object with its own '
  'suffix; deleting the recording and forgetting the manifest is a '
  'documented trap this lane has already hit once.';
comment on column screening_v2.phone_call_attempts.recording_role is
  'authoritative | supplementary. The FIRST consented attempt is '
  'authoritative; every reconnect is supplementary. No authoritative '
  'reader may surface a supplementary artifact.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. CHECK evolution 2 of 2 -- audit_events.chk_audit_action
-- ═══════════════════════════════════════════════════════════════════════
-- Re-declared IN FULL. Every pre-existing action is reproduced verbatim
-- and exactly two are added -- the two this migration''s own RPCs write.
-- Unused vocabulary in a re-declared CHECK is scope with no caller, so
-- nothing is added "for later".

alter table screening_v2.audit_events
  drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events
  add constraint chk_audit_action check (
    action in (
      'invite_sent', 'invite_revoked', 'invite_consumed',
      'grant_issued', 'grant_revoked', 'grant_consumed',
      'screening_started', 'screening_completed', 'screening_failed',
      'assessment_recorded',
      'candidate_status_changed', 'candidate_consent_updated',
      'session_created', 'session_updated', 'session_terminated',
      'membership_created', 'membership_updated', 'membership_deactivated',
      'role_created', 'role_updated', 'role_deactivated',
      'export_requested', 'export_completed',
      'login_success', 'login_failure', 'logout',
      'config_changed',
      'auth_login_success', 'auth_login_failure', 'auth_token_refresh', 'auth_logout',
      'rbac_access_denied', 'rbac_ownership_denied',
      'resource_create', 'resource_read', 'resource_update',
      'resource_delete', 'resource_list', 'rate_limit_exceeded',
      'audit_sink_failure', 'audit_configuration_error',
      'recording_download', 'recording_upload', 'recording_integrity_verified',
      'recording_quarantined', 'recording_revoked', 'recording_deleted',
      'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update',
      'quota_override', 'notification_create', 'appeal_create', 'appeal_review',
      'allowlist_linked', 'admin_allowlist_add', 'admin_allowlist_update',
      -- Ashby Wave 2 (0029): mapping-administration audits.
      'ashby_mapping_update', 'ashby_mapping_drift',
      -- Ashby Wave 2 (0031, additive): workflow-execution audits.
      'ashby_application_cancel', 'ashby_operation_enqueue', 'ashby_operation_update',
      -- Ashby Wave 2 (0032, additive): runtime-activation audits.
      'ashby_operation_retry', 'ashby_writeback_pending',
      -- Ashby Wave 2 (0032, review repair): manual invite hand-off.
      'ashby_invite_delivered',
      -- Ashby Wave 2 (0036, additive): audited ingestion attempt-counter reset.
      'ashby_ingestion_attempts_reset',
      -- Ashby (0039, additive): audited BOUNDED parse-class ingestion retry.
      'ashby_ingestion_parse_recovery',
      -- Ashby (0041, additive): ONE-SHOT recovery of a LEGACY parse_bad_output
      -- row, i.e. one written while a library could still pollute the child's
      -- stdout protocol channel.
      'ashby_ingestion_legacy_bad_output_recovery',
      -- Phone screening (0042, additive): the eight actions this
      -- migration's own RPCs write. No stage move, no email, no
      -- scorecard.
      'phone_attempt_admitted',
      'phone_attempt_classified',
      'phone_attempt_ended',
      'phone_appointment_scheduled',
      'phone_appointment_cancelled',
      'phone_appointment_missed',
      'phone_opt_out_recorded',
      -- Written in the SAME transaction as the terminal opt-out that
      -- earns it; the target id is the line's SHA-256 digest, never a
      -- number.
      'phone_suppression_added',
      -- Phone safe dialer (0043, additive): the two actions this
      -- migration's own RPCs write. Both target a phone_call_attempt and
      -- neither carries a key, a number or a provider payload.
      'phone_recording_attached',
      -- Written when a VERIFIED object deletion is recorded. The audit
      -- row is evidence the purge happened; it never performs one.
      'phone_recording_purged'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Closed action allowlist, extended ADDITIVELY by 0043 with the two '
  'phone recording-artifact actions its RPCs write. No prior member has '
  'ever been removed; policy_tests.sql asserts that directly.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. apply_phone_event -- ONE new branch, everything else byte-identical
-- ═══════════════════════════════════════════════════════════════════════
-- Replaced rather than patched because a CHECK-style in-place edit does
-- not exist for a function body. The ONLY difference from 0042 is the
-- `dialing` + answered + participant-left/connection-aborted branch; a
-- drift test diffs this body against 0042''s and asserts that the added
-- branch is the sole change.

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
      when v_eng.state = 'in_call' and p_event_type = 'assessment.completed' then
        v_new_state := 'completed'; v_att_state := 'ended'; v_outcome := 'completed'; -- #22
      when v_eng.state = 'in_call' and p_event_type = 'assessment.aborted' then
        -- Every other `ended` path names an outcome; an operator
        -- filtering on outcome_class must not lose these rows.
        v_new_state := 'failed'; v_att_state := 'ended'; v_outcome := 'disconnected';
        v_reason := 'assessment_aborted';
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
    if v_eng.no_answer_attempts + 1 >= 3 then
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

-- Grants are preserved by `create or replace`, but they are re-issued here
-- so this file states the whole privilege story of the function it ships.
revoke all on function screening_v2.apply_phone_event(
  text, text, uuid, uuid, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.apply_phone_event(
  text, text, uuid, uuid, text, integer, jsonb, timestamptz) to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. attach_phone_attempt_recording -- the ONLY door that binds audio
-- ═══════════════════════════════════════════════════════════════════════
-- THE DISCLOSURE GATE LIVES HERE, IN SQL, NOT ONLY IN THE WORKER.
--
-- A recording may be bound to an attempt if and only if the engagement is
-- already `in_call`, and 0042 moves an engagement to `in_call` at exactly
-- one place: transition #18, `disclosure.delivered`. So "no egress before
-- an affirmative recording disclosure" is enforced by the state machine
-- rather than by the order of two statements in a worker that a future
-- refactor could swap. A caller that starts an egress at originate, at
-- ring, at join, while unclassified, on a machine, or after a refusal
-- cannot record that fact here. Note the limit honestly: an egress whose
-- binding this function REFUSED leaves both key columns null, and
-- `list_phone_engagement_recordings` filters on a non-null object key, so the
-- purge would not find it either. That is precisely why the binding is
-- attempted BEFORE any egress is started -- a refusal here means no egress was
-- ever started, so there is nothing to orphan.
--
-- Idempotency is by VALUE, not by existence: re-attaching the identical
-- triple is `ok` with `duplicate`, while re-attaching a DIFFERENT triple
-- is refused as `already_bound` rather than silently overwriting a key
-- that a purge may already have been told to delete.
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
  -- EQUALITY, not a shape match. A regex only says the key LOOKS derived;
  -- this says it IS derived, from THIS attempt. Without it, attempt A could be
  -- bound with attempt B's key and the purge would delete the wrong object
  -- while reporting success for both -- and `[0-9a-f-]{36}` happily admits
  -- thirty-six hyphens. The header claims the columns hold "the name the
  -- dialer derives"; this is what makes that claim true.
  if p_object_key is distinct from ('phone-' || p_attempt_id::text || '-egress.ogg') then
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

  -- THE GATE. `in_call` is reachable only through `disclosure.delivered`.
  if v_eng.state <> 'in_call' then
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
    -- uq_phone_attempts_one_authoritative_recording. A second
    -- authoritative binding for the engagement is refused by the index,
    -- not by a read-then-write race we would have to get right.
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
  'Binds an attempt-scoped recording object and manifest. Refuses unless '
  'the engagement is already in_call, which 0042 reaches only through '
  'disclosure.delivered -- so the recording disclosure gate is enforced '
  'by the state machine, not by statement order in a worker. Idempotent '
  'by value; a differing re-bind is refused rather than overwritten. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. finalize_phone_attempt_recording
-- ═══════════════════════════════════════════════════════════════════════
-- Records the terminal egress status, and the provider's egress id if it
-- was not known at attach time.
--
-- IT CAN ONLY BE REACHED THROUGH AN ATTACHED RECORDING. That is what makes
-- the ordering safe: `attach_phone_attempt_recording` carries the disclosure
-- gate and is called BEFORE any egress is started, so a caller that is
-- refused there never starts one and never arrives here. Binding the key
-- first and learning the egress id second is deliberate -- the alternative
-- (start the egress, then ask permission) records first and asks after.
--
-- Deliberately cannot clear a key: forgetting an artifact and deleting one
-- are different acts, and only section 8 may claim the second.
create or replace function screening_v2.finalize_phone_attempt_recording(
  p_attempt_id    uuid,
  p_egress_status text,
  p_egress_id     text        default null,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att screening_v2.phone_call_attempts%rowtype;
begin
  if p_egress_status is null or p_egress_status not in ('active','complete','failed') then
    return jsonb_build_object('status', 'invalid_egress_status');
  end if;
  if p_egress_id is not null and p_egress_id !~ '^EG_[A-Za-z0-9_-]{4,200}$' then
    return jsonb_build_object('status', 'invalid_egress_id');
  end if;
  if p_attempt_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_att from screening_v2.phone_call_attempts
   where id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_att.recording_object_key is null then
    return jsonb_build_object('status', 'no_recording');
  end if;

  update screening_v2.phone_call_attempts
     set egress_status = p_egress_status,
         egress_id     = coalesce(p_egress_id, egress_id)
   where id = v_att.id;

  return jsonb_build_object('status', 'ok', 'attempt_id', v_att.id,
                            'egress_status', p_egress_status,
                            'role', v_att.recording_role);
end;
$$;

revoke all on function screening_v2.finalize_phone_attempt_recording(
  uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.finalize_phone_attempt_recording(
  uuid, text, text, timestamptz) to service_role;
comment on function screening_v2.finalize_phone_attempt_recording(
  uuid, text, text, timestamptz) is
  'Records the terminal egress status, and the egress id when it was not '
  'known at attach time. Reachable only through an ATTACHED recording, so '
  'the disclosure gate on attach also gates this. Cannot clear a key -- '
  'forgetting an artifact and deleting one are different acts. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. list_phone_engagement_recordings -- what a purge must delete
-- ═══════════════════════════════════════════════════════════════════════
-- Enumerates EVERY attempt artifact of an engagement, authoritative and
-- supplementary alike, so a purge can name what it must delete instead of
-- guessing from the session key. A refusal that ran against the session
-- key alone would report success while a reconnect attempt's audio
-- survived; the negative control for the purge is exactly a reconnect.
--
-- Returns keys only -- no phone number, no provider payload, no lease
-- token, no participant identity.
create or replace function screening_v2.list_phone_engagement_recordings(
  p_engagement_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_items jsonb;
begin
  if p_engagement_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from screening_v2.phone_engagements where id = p_engagement_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- `egress_id` and `egress_status` are carried because a purge must be able
  -- to STOP an egress that is still writing before it deletes anything: the
  -- object is uploaded when the egress STOPS, not continuously, so deleting
  -- during an active egress deletes nothing and then reports success moments
  -- before the recording lands. Neither is a phone value; `egress_id` matches
  -- the opaque `EG_...` shape 0042 already constrains.
  select coalesce(jsonb_agg(jsonb_build_object(
           'attempt_id',    a.id,
           'role',          a.recording_role,
           'object_key',    a.recording_object_key,
           'manifest_key',  a.recording_manifest_key,
           'egress_id',     a.egress_id,
           'egress_status', a.egress_status
         ) order by a.attempt_seq), '[]'::jsonb)
    into v_items
    from screening_v2.phone_call_attempts a
   where a.engagement_id = p_engagement_id
     and a.recording_object_key is not null;

  -- An engagement with nothing to purge is a DISTINCT SUCCESS, not a
  -- failure and not an unknown. Conflating "no artifact exists" with "we
  -- could not tell" is how a purge quietly reports done.
  return jsonb_build_object('status', 'ok', 'artifacts', v_items,
                            'count', jsonb_array_length(v_items));
end;
$$;

revoke all on function screening_v2.list_phone_engagement_recordings(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.list_phone_engagement_recordings(uuid)
  to service_role;
comment on function screening_v2.list_phone_engagement_recordings(uuid) is
  'Every attempt-scoped recording artifact of an engagement, '
  'authoritative and supplementary alike, so a purge can NAME what it '
  'must delete. Keys only. An empty list is a distinct success. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. clear_phone_attempt_recordings -- records a VERIFIED deletion
-- ═══════════════════════════════════════════════════════════════════════
-- THIS FUNCTION DELETES NOTHING. It records that the caller has already
-- deleted, and verified the absence of, every artifact this engagement
-- had. Calling it before that is a lie the database cannot detect, which
-- is precisely why the ordering is written down here and asserted by test
-- rather than left to a comment in a worker.
--
-- The correct order, and the reason for it:
--
--   1. enumerate  (list_phone_engagement_recordings)
--   2. delete every object AND every manifest, then VERIFY absence
--   3. clear_phone_attempt_recordings          <- you are here
--   4. apply_phone_event('disclosure.refused' | 'candidate.opt_out' | ...)
--
-- Step 4 is last because 0042 does the suppression ATOMICALLY with the
-- terminal transition (the PR #91 repair), so the obligation to never
-- dial this line again lands in the same transaction as the terminal
-- state. If step 2 fails, steps 3 and 4 MUST NOT run: the request stays
-- unacknowledged and is retried. A terminal state committed over audio we
-- failed to delete would be the split this substrate exists to prevent.
--
-- Idempotent: clearing an engagement that has nothing left to clear
-- returns `ok` with `cleared = 0`, which is a distinct success.
create or replace function screening_v2.clear_phone_attempt_recordings(
  p_engagement_id uuid,
  p_actor_id      uuid        default null,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_cleared integer := 0;
begin
  if p_engagement_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from screening_v2.phone_engagements where id = p_engagement_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Terminal engagements are immutable, but their ATTEMPTS are not, and
  -- must not be: a purge that could only run before the terminal event
  -- could never repair a partial one afterwards.
  with cleared as (
    update screening_v2.phone_call_attempts
       set recording_object_key   = null,
           recording_manifest_key = null,
           recording_role         = null
     where engagement_id = p_engagement_id
       and recording_object_key is not null
    returning 1)
  select count(*) into v_cleared from cleared;

  if v_cleared > 0 then
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (coalesce(p_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
       case when p_actor_id is null then 'system' else 'recruiter' end,
       'phone_recording_purged', 'phone_engagement', p_engagement_id::text, 'success',
       jsonb_build_object('cleared', v_cleared));
  end if;

  return jsonb_build_object('status', 'ok', 'cleared', v_cleared);
end;
$$;

revoke all on function screening_v2.clear_phone_attempt_recordings(
  uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.clear_phone_attempt_recordings(
  uuid, uuid, timestamptz) to service_role;
comment on function screening_v2.clear_phone_attempt_recordings(
  uuid, uuid, timestamptz) is
  'Records that every attempt-scoped recording artifact of an engagement '
  'has ALREADY been deleted and verified absent. Deletes nothing itself. '
  'Must run AFTER verified object deletion and BEFORE the terminal '
  'opt-out event, whose suppression 0042 writes atomically. Idempotent; '
  'cleared = 0 is a distinct success. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';
