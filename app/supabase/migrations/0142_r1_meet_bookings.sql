-- R1 over Google Meet (M034 S02, D-M034-9 / D-M034-11): the database half of "Dex joins the Meet
-- that HR booked in Ashby".
--
-- DARK. Nothing calls any object below until S03 (webhook receipts), S05 (bridge ticket) and S06
-- (booking runtime) ship behind R1_MEET_ENABLED (default OFF). No queue is registered here. Every
-- job row an object below can write is named `r1-meet`, and none is written while the flag is off:
-- the §5 bot release fires only when a booking is deleted, and only S06 creates bookings.
--
--   §1 interview_rounds.channel ('browser' default | 'meet') and trg_interview_rounds_channel_locked:
--      the only allowed change is browser -> meet, and only while the round is `invited`, unstarted
--      (starts_used = 0) and has no consent record. The Meet guard of S05 relies on it.
--   §2 interview_round_consents: method ('candidate_web' default | 'hr_attested_ashby'),
--      attested_by_external_id (the Ashby scheduledBy user id), attested_at (when HR scheduled the
--      interview in Ashby), india_location_attested, and chk_interview_round_consents_attestation
--      tying them together. Every existing row and every insert the browser flow makes reads
--      candidate_web with no attestation, so the browser consent flow is unchanged.
--   §3 screening_v2.r1_meet_bookings: one row per Ashby interview event that has Dex as an
--      interviewer. Closed status machine (12 states) and closed reason list (32), tied by
--      chk_r1_meet_bookings_status_reason; the Recall bot generation (version) and Idempotency-Key
--      rotation (key_attempt); the single-use bridge ticket, stored as a digest only.
--   §4 screening_v2.r1_meet_receipts: durable, de-duplicated webhook receipts (Recall Svix
--      webhook-id or the S01 Ashby schedule key). No body, no metadata; 30-day retention.
--   §5 enqueue_r1_meet_bot_release: deleting a booking that still holds a Recall bot (including the
--      DSAR cascade from candidates and rounds) queues one `r1-meet` bot_release job, so a cascade
--      never orphans a billing bot.
--   §10 r1_meet_create_round_from_ashby: the R1 round (through r1_send_round, channel meet), the
--      HR-attested consent and the booking for one Ashby event, in one transaction; re-links a
--      reusable Meet round after HR re-books. Never creates a call_sessions row.
--   §11 r1_meet_reschedule_booking: a new slot or Meet link for a booking that holds no bot; moves
--      the round's bounded expiry with it.
--   §12 r1_meet_cancel_booking: cancels the booking ONLY; the round, its consent and the candidate
--      are never touched.
--   §13 r1_meet_set_bot: the Recall bot of a booking (attach, rotate_key, replace, release),
--      compare-and-set on the bot generation (version) and the Idempotency-Key attempt.
--   §14 r1_meet_transition_booking: the runtime status moves of S06, compare-and-set on the status.
--   §15 r1_meet_bind_session: binds the admitted call session of the round to an in-call booking.
--   §16 r1_meet_arm_ticket: stores the digest and window of a single-use bridge ticket for a booking
--      that holds a bot (at most 5 arms per bot generation); the status is unchanged.
--   §17 r1_meet_claim_ticket: claims a ticket once, inside its window, under the booking row lock;
--      the booking moves to in_call and the answer is the booking/round/candidate/profile binding.
--   §18 r1_meet_record_receipt: insert-or-report-duplicate of a webhook receipt plus the 0030
--      transactional outbox (one live `r1-meet` job per receipt while it is enqueued).
--   §19 r1_meet_prune_receipts: the 30-day receipt retention (refuses less than 7 days).
--   §90 RLS on (no policy) and service-role-only privileges.
--
-- PII-minimal: ids, times, statuses, the canonical Meet URL and the Ashby user id of the HR
-- attester. No names, no emails, no webhook bodies.
--
-- Additive and re-runnable: `if not exists` tables, columns and indexes, DO-guarded constraints,
-- `create or replace` functions, `drop trigger if exists` + `create trigger`. No existing row is
-- changed (every new column has a constant default or is NULL), no existing function is redeclared.
-- Nothing is re-priced, so it could run while an R1 session is live, but it is still merged in the
-- runbook's zero-live window. Forward-only: while dark the objects simply stay unused.
set local lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------------
-- §1. interview_rounds.channel: how the candidate joins the round.
-- ---------------------------------------------------------------------------------------------
-- 'browser' (our link, every round so far) or 'meet' (Dex joins the Google Meet HR booked in
-- Ashby). NOT NULL with a constant default is a metadata-only change, and every existing round
-- reads 'browser'.
alter table screening_v2.interview_rounds
  add column if not exists channel text not null default 'browser'
  constraint chk_interview_rounds_channel
  check (channel in ('browser', 'meet'));

comment on column screening_v2.interview_rounds.channel is
  'How the candidate joins: browser (the R1 link) or meet (Dex joins the Google Meet booked in '
  'Ashby, M034). Set to meet only by the service-role Meet round RPC, right after the round is '
  'created; locked by trg_interview_rounds_channel_locked.';

-- The channel is fixed once the round could have been used. The Meet RPC creates the round through
-- r1_send_round (browser) and flips it to meet in the same transaction, before the consent row is
-- written; any later change (meet -> browser, or browser -> meet after consent or a start) would let
-- a Meet round take the browser path or the reverse, so it is refused. The check is on the value
-- changing, so a no-op write of the same channel is never refused. SECURITY DEFINER so the consent
-- lookup is not hidden from the writer by row level security (0120 audience lock pattern).
create or replace function screening_v2.reject_interview_round_channel_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
begin
  if new.channel is distinct from old.channel
     and not (
       old.channel = 'browser'
       and new.channel = 'meet'
       and old.status = 'invited'
       and old.starts_used = 0
       and not exists (
         select 1 from screening_v2.interview_round_consents c where c.round_id = old.id
       )
     ) then
    raise exception 'interview_rounds.channel of round % can only change from browser to meet while the round is invited, unstarted and has no consent record',
      old.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_interview_rounds_channel_locked on screening_v2.interview_rounds;
create trigger trg_interview_rounds_channel_locked
  before update of channel on screening_v2.interview_rounds
  for each row execute function screening_v2.reject_interview_round_channel_change();

-- ---------------------------------------------------------------------------------------------
-- §2. interview_round_consents: HR-attested consent (D-M034-9 / D-M034-11).
-- ---------------------------------------------------------------------------------------------
-- Scheduling the Dex interview in Ashby is recorded as HR-attested verbal consent AND India
-- location attestation, naming who scheduled it (the Ashby scheduledBy user id, never a service
-- user) and when. The browser flow's inserts set none of these columns, so they read
-- candidate_web with no attestation and pass the pairing check unchanged.
alter table screening_v2.interview_round_consents
  add column if not exists method text not null default 'candidate_web'
  constraint chk_interview_round_consents_method
  check (method in ('candidate_web', 'hr_attested_ashby'));
alter table screening_v2.interview_round_consents
  add column if not exists attested_by_external_id text
  constraint chk_interview_round_consents_attested_by
  check (attested_by_external_id is null
         or attested_by_external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table screening_v2.interview_round_consents
  add column if not exists attested_at timestamptz;
alter table screening_v2.interview_round_consents
  add column if not exists india_location_attested boolean;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_interview_round_consents_attestation'
       and conrelid = 'screening_v2.interview_round_consents'::regclass
  ) then
    alter table screening_v2.interview_round_consents
      add constraint chk_interview_round_consents_attestation check (
        (method = 'candidate_web'
          and attested_by_external_id is null
          and attested_at is null
          and india_location_attested is null)
        or (method = 'hr_attested_ashby'
          and attested_by_external_id is not null
          and attested_at is not null
          and india_location_attested is true)
      );
  end if;
end;
$$;

comment on column screening_v2.interview_round_consents.method is
  'candidate_web: the candidate granted or declined on the R1 consent page. hr_attested_ashby: HR '
  'scheduled the Dex interview in Ashby, recorded as HR-attested verbal consent and India location '
  'attestation (M034, D-M034-9/11).';
comment on column screening_v2.interview_round_consents.attested_by_external_id is
  'hr_attested_ashby only: the Ashby user id of the HR staff member who scheduled the interview '
  '(scheduledBy), kept verbatim as consent evidence. Never a service user. Confidential.';
comment on column screening_v2.interview_round_consents.attested_at is
  'hr_attested_ashby only: when HR scheduled the interview in Ashby.';
comment on column screening_v2.interview_round_consents.india_location_attested is
  'hr_attested_ashby only: true, the India location attested by the same HR act. NULL on '
  'candidate_web rows (not recorded there).';

-- ---------------------------------------------------------------------------------------------
-- §3. screening_v2.r1_meet_bookings
-- ---------------------------------------------------------------------------------------------
-- Status (closed): pending, unmatched_application, unmapped_scheduler, blocked, bot_scheduled,
-- bot_joining, human_present, in_call (active, one bot) and completed, cancelled, failed, drained
-- (terminal, never revived; a terminal booking keeps recall_bot_id until S06 confirms the release).
-- Reason (closed, NOT NULL): the S01 Dex event decisions plus the matching, round-creation and
-- runtime reasons; chk_r1_meet_bookings_status_reason ties each reason to its status family.
create table if not exists screening_v2.r1_meet_bookings (
  id uuid primary key default gen_random_uuid(),
  ashby_interview_event_id uuid not null,
  ashby_schedule_id text not null,
  ashby_application_id text not null,
  ashby_interview_stage_id text,
  ashby_interview_id text,
  ashby_scheduled_by_user_id text not null,
  ashby_updated_at timestamptz,
  candidate_id uuid references screening_v2.candidates(id) on delete cascade,
  round_id uuid references screening_v2.interview_rounds(id) on delete cascade,
  objective_profile text not null default 'r1_dex_sales',
  status text not null,
  reason text not null,
  version integer not null default 0,
  key_attempt integer not null default 0,
  meet_url text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  recall_bot_id uuid,
  ticket_digest text,
  ticket_not_before timestamptz,
  ticket_expires_at timestamptz,
  ticket_claimed_at timestamptz,
  ticket_arms integer not null default 0,
  session_id uuid references screening_v2.call_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_r1_meet_bookings_event unique (ashby_interview_event_id),
  constraint chk_r1_meet_bookings_schedule_id check (
    ashby_schedule_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint chk_r1_meet_bookings_application_id check (
    ashby_application_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint chk_r1_meet_bookings_stage_id check (
    ashby_interview_stage_id is null
    or ashby_interview_stage_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint chk_r1_meet_bookings_interview_id check (
    ashby_interview_id is null
    or ashby_interview_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint chk_r1_meet_bookings_scheduled_by check (
    ashby_scheduled_by_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint chk_r1_meet_bookings_objective_profile check (objective_profile in ('r1_dex_sales')),
  constraint chk_r1_meet_bookings_status check (status in (
    'pending', 'unmatched_application', 'unmapped_scheduler', 'blocked',
    'bot_scheduled', 'bot_joining', 'human_present', 'in_call',
    'completed', 'cancelled', 'failed', 'drained'
  )),
  constraint chk_r1_meet_bookings_reason check (reason in (
    'dex_absent', 'cancelled', 'in_past', 'not_scheduled', 'no_attester', 'no_meet_link', 'eligible',
    'application_unknown', 'application_terminal', 'scheduler_unmapped', 'created_by_unknown',
    'disabled', 'paused', 'candidate_ineligible', 'role_not_configured', 'round_active',
    'phone_engagement_active', 'phone_assessment_pending', 'capacity_exhausted',
    'consent_template_unavailable', 'slot_too_far',
    'bot_cap_reached', 'bot_create_failed', 'bot_fatal', 'event_removed', 'round_cancelled',
    'round_expired', 'no_show', 'admission_refused', 'multiple_humans', 'attempt_settled', 'flag_off'
  )),
  constraint chk_r1_meet_bookings_status_reason check (
    (status in ('pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
      and reason in ('eligible'))
    or (status in ('unmatched_application')
      and reason in ('application_unknown', 'application_terminal'))
    or (status in ('unmapped_scheduler')
      and reason in ('scheduler_unmapped', 'created_by_unknown'))
    or (status in ('blocked')
      and reason in ('not_scheduled', 'no_attester', 'no_meet_link', 'disabled', 'paused',
                     'candidate_ineligible', 'role_not_configured', 'round_active',
                     'phone_engagement_active', 'phone_assessment_pending', 'capacity_exhausted',
                     'consent_template_unavailable', 'slot_too_far', 'bot_cap_reached'))
    or (status in ('completed')
      and reason in ('attempt_settled'))
    or (status in ('cancelled')
      and reason in ('cancelled', 'dex_absent', 'event_removed', 'round_cancelled'))
    or (status in ('failed')
      and reason in ('in_past', 'bot_create_failed', 'bot_fatal', 'no_show', 'admission_refused',
                     'multiple_humans', 'round_expired'))
    or (status in ('drained')
      and reason in ('flag_off'))
  ),
  constraint chk_r1_meet_bookings_version check (version between 0 and 50),
  constraint chk_r1_meet_bookings_key_attempt check (key_attempt between 0 and 20),
  constraint chk_r1_meet_bookings_meet_url check (
    meet_url ~ '^https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$'
  ),
  constraint chk_r1_meet_bookings_slot check (
    end_at > start_at and end_at <= start_at + interval '24 hours'
  ),
  constraint chk_r1_meet_bookings_ticket_digest check (
    ticket_digest is null or ticket_digest ~ '^[a-f0-9]{64}$'
  ),
  constraint chk_r1_meet_bookings_ticket_arms check (ticket_arms between 0 and 5),
  constraint chk_r1_meet_bookings_round_binding check (
    (status not in ('pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed')
      or (round_id is not null and candidate_id is not null))
    and (status <> 'unmatched_application' or (candidate_id is null and round_id is null))
    and (status <> 'unmapped_scheduler' or round_id is null)
    and (round_id is null or candidate_id is not null)
  ),
  constraint chk_r1_meet_bookings_bot_binding check (
    (status not in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call')
      or recall_bot_id is not null)
    and (status not in ('pending', 'blocked', 'unmatched_application', 'unmapped_scheduler')
      or recall_bot_id is null)
  ),
  constraint chk_r1_meet_bookings_ticket check (
    ((ticket_digest is null) = (ticket_not_before is null))
    and ((ticket_digest is null) = (ticket_expires_at is null))
    and (ticket_expires_at is null or ticket_expires_at > ticket_not_before)
    and (ticket_claimed_at is null or ticket_digest is not null)
    and (ticket_digest is null
      or status in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call',
                    'completed', 'cancelled', 'failed', 'drained'))
  )
);

-- One live booking (and so one bot) per round; terminal bookings stay as history.
create unique index if not exists uq_r1_meet_bookings_live_round
  on screening_v2.r1_meet_bookings (round_id)
  where round_id is not null and status not in ('completed', 'cancelled', 'failed', 'drained');
-- The drain, the bot scheduler and the daily bot cap (counted by slot day).
create index if not exists idx_r1_meet_bookings_status_start
  on screening_v2.r1_meet_bookings (status, start_at);
-- Recall webhooks resolve a booking by bot id; a bot belongs to one booking.
create unique index if not exists uq_r1_meet_bookings_recall_bot
  on screening_v2.r1_meet_bookings (recall_bot_id)
  where recall_bot_id is not null;
-- The bridge page claims a ticket by its digest; a digest belongs to one booking.
create unique index if not exists uq_r1_meet_bookings_ticket_digest
  on screening_v2.r1_meet_bookings (ticket_digest)
  where ticket_digest is not null;
create index if not exists idx_r1_meet_bookings_round
  on screening_v2.r1_meet_bookings (round_id)
  where round_id is not null;
create index if not exists idx_r1_meet_bookings_candidate
  on screening_v2.r1_meet_bookings (candidate_id)
  where candidate_id is not null;
-- A Cancelled schedule cancels every booking of that schedule.
create index if not exists idx_r1_meet_bookings_schedule
  on screening_v2.r1_meet_bookings (ashby_schedule_id);
create index if not exists idx_r1_meet_bookings_session
  on screening_v2.r1_meet_bookings (session_id)
  where session_id is not null;
-- Terminal bookings whose Recall bot is not yet confirmed released (S06, from an existing tick).
create index if not exists idx_r1_meet_bookings_owed_release
  on screening_v2.r1_meet_bookings (updated_at)
  where recall_bot_id is not null and status in ('completed', 'cancelled', 'failed', 'drained');

comment on table screening_v2.r1_meet_bookings is
  'R1 over Google Meet (M034): one row per Ashby interview event with Dex as an interviewer. '
  'PII-minimal: Ashby ids, slot times, the canonical Meet URL, statuses and counters; no names, '
  'emails or webhook bodies. Cascades with the candidate and the round (DSAR); a deleted row that '
  'still holds a Recall bot queues one r1-meet bot_release job. Service-role only.';
comment on column screening_v2.r1_meet_bookings.meet_url is
  'The canonical https://meet.google.com/xxx-xxxx-xxx of the event (S01 normalizeGoogleMeetUrl). '
  'A meeting access link: Confidential.';
comment on column screening_v2.r1_meet_bookings.ticket_digest is
  'SHA-256 hex of the single-use bridge ticket (S05 owns the ticket and its HMAC domain). The raw '
  'ticket is never stored. Secret.';
comment on column screening_v2.r1_meet_bookings.version is
  'Recall bot generation for the Idempotency-Key r1-meet-<event>-v<version>-k<key_attempt>; '
  'bumped only when a bot is deleted and recreated (0..50).';
comment on column screening_v2.r1_meet_bookings.key_attempt is
  'Idempotency-Key rotation within one bot generation, bumped only when the Recall client asks '
  'for a new key (Recall caches 4xx/5xx answers for 1 h); reset to 0 by a new generation (0..20).';
comment on column screening_v2.r1_meet_bookings.ashby_scheduled_by_user_id is
  'The Ashby user id of the HR staff member who scheduled the interview: the consent attester '
  '(D-M034-11). Never a service user. Confidential.';

-- ---------------------------------------------------------------------------------------------
-- §4. screening_v2.r1_meet_receipts
-- ---------------------------------------------------------------------------------------------
-- One row per accepted webhook delivery, keyed by the Recall Svix webhook-id (`msg_...`) or the
-- S01 Ashby schedule key (`ashby-schedule:<schedule>:<stamp>:<16 hex>`, at most 86 characters);
-- the dedupe space check keeps the two key families disjoint. 256 is the S01 id bound; the regex
-- has no bound of its own because Postgres caps regex bounds at 255.
create table if not exists screening_v2.r1_meet_receipts (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  dedupe_key text not null,
  event_type text not null,
  booking_id uuid references screening_v2.r1_meet_bookings(id) on delete set null,
  outcome text not null default 'recorded',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint uq_r1_meet_receipts_dedupe_key unique (dedupe_key),
  constraint chk_r1_meet_receipts_source check (source in ('recall', 'ashby')),
  constraint chk_r1_meet_receipts_dedupe_key check (
    char_length(dedupe_key) between 1 and 256 and dedupe_key ~ '^[A-Za-z0-9_.:-]+$'
  ),
  constraint chk_r1_meet_receipts_dedupe_space check (
    (source = 'ashby') = (dedupe_key like 'ashby-schedule:%')
  ),
  constraint chk_r1_meet_receipts_event_type check (event_type ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  constraint chk_r1_meet_receipts_outcome check (
    outcome in ('recorded', 'enqueued', 'processed', 'ignored', 'failed')
  ),
  constraint chk_r1_meet_receipts_processed check (
    (processed_at is null) = (outcome in ('recorded', 'enqueued'))
  )
);

create index if not exists idx_r1_meet_receipts_received
  on screening_v2.r1_meet_receipts (received_at);
create index if not exists idx_r1_meet_receipts_booking
  on screening_v2.r1_meet_receipts (booking_id)
  where booking_id is not null;

comment on table screening_v2.r1_meet_receipts is
  'R1 over Google Meet (M034): durable, de-duplicated webhook receipts (Recall and Ashby schedule '
  'webhooks). Holds the dedupe id, event type, outcome and times only: no body, no metadata, no '
  'PII. Retention 30 days (r1_meet_prune_receipts, called from an existing tick). Service-role only.';

-- ---------------------------------------------------------------------------------------------
-- §5. A deleted booking never orphans a Recall bot.
-- ---------------------------------------------------------------------------------------------
-- Row-level AFTER DELETE triggers fire for FK cascades too (candidate or round delete, DSAR), so a
-- booking that still holds a bot always leaves one durable `r1-meet` bot_release job in the same
-- transaction. The job carries ids only. Its dedup key is per bot; uq_job_queue_dedup_active (0009)
-- is PARTIAL over live jobs, so a second delete of the same bot while its job is live adds nothing.
create or replace function screening_v2.enqueue_r1_meet_bot_release()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
  values ('r1-meet',
          jsonb_build_object('kind', 'bot_release', 'recall_bot_id', old.recall_bot_id,
                             'booking_id', old.id),
          'r1-meet:bot-release:' || old.recall_bot_id::text, 10)
  on conflict do nothing;
  return old;
end;
$$;

drop trigger if exists enqueue_r1_meet_bot_release on screening_v2.r1_meet_bookings;
create trigger enqueue_r1_meet_bot_release
  after delete on screening_v2.r1_meet_bookings
  for each row
  when (old.recall_bot_id is not null)
  execute function screening_v2.enqueue_r1_meet_bot_release();

-- ---------------------------------------------------------------------------------------------
-- §10. r1_meet_create_round_from_ashby: the round, the HR-attested consent and the booking.
-- ---------------------------------------------------------------------------------------------
-- S06 calls this for every Ashby interview event that has Dex as an interviewer (S01 decision
-- `eligible`). One transaction, idempotent per Ashby event id; the first refusal wins:
--   1. validation, no write: invalid_request with a closed `field` code;
--   2. a slot that has already started, no write: in_past;
--   3. the event lock (advisory lock, then the booking row): a terminal booking answers
--      booking_terminal; a booking that has a round answers exists (changes go through the
--      reschedule RPC); an older Ashby updatedAt answers stale_update; a round-less booking
--      (unmatched, unmapped, blocked) is retried in place;
--   4. the candidate, through ashby_application_links only (never by email):
--      unmatched_application / application_unknown | application_terminal;
--   5. created_by (the staff user S06 mapped from the Ashby scheduler, or the
--      R1_MEET_SERVICE_USER_ID fallback) must be an auth.users row, because admission writes
--      call_sessions.owner_id = created_by: unmapped_scheduler / scheduler_unmapped |
--      created_by_unknown;
--   6. the round expires at slot end + grace, at most 14 days ahead, else blocked/slot_too_far
--      with retry_after (S06 re-runs this then); never through a reissue of the round link;
--   7. the newest active consent template for en-IN, requiring something, else
--      blocked/consent_template_unavailable;
--   8. exactly one sales_r1 role (the browser route's rule), else blocked/role_not_configured;
--   9. the round is created BY r1_send_round itself, so every check, the 65-minute hold, the
--      hold month and the month counter are the browser path's, with a link digest whose
--      preimage nobody has (the candidate gets no link); then channel = meet. Its refusals become
--      blocked/<code>;
--  10. round_active: the candidate's live round is re-linked when it is a reusable Meet round (HR
--      cancelled and re-booked), else blocked/round_active (or the phone code).
-- created and relinked insert the HR-attested consent: the attester is ALWAYS the Ashby
-- scheduledBy user id, never created_by. Every outcome after step 3 upserts the booking. No
-- call_sessions row, no audit row, no clock read (p_now only), no digest in any answer.
--
-- Lock order: the event's advisory lock and booking row first, then (inside r1_send_round)
-- settings and the current month, then for a re-link the round's hold month and the round: the
-- admission order (settings, month, round), and no other booking is ever locked.
create or replace function screening_v2.r1_meet_create_round_from_ashby(
  p_ashby_interview_event_id uuid,
  p_ashby_schedule_id text,
  p_ashby_application_id text,
  p_ashby_interview_stage_id text,
  p_ashby_interview_id text,
  p_ashby_scheduled_by_user_id text,
  p_attested_at timestamptz,
  p_ashby_updated_at timestamptz,
  p_meet_url text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_created_by uuid,
  p_objective_profile text default 'r1_dex_sales',
  p_expiry_grace_sec integer default 7200,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_has_booking boolean;
  v_link_candidate uuid;
  v_link_terminal text;
  v_candidate_id uuid;
  v_candidate_status text;
  v_expires timestamptz;
  v_retry_after timestamptz;
  v_template screening_v2.interview_round_consent_templates%rowtype;
  v_role_id uuid;
  v_role_count integer;
  v_send jsonb;
  v_code text;
  v_live_id uuid;
  v_hold_minutes numeric;
  v_hold_month date;
  v_uncounted boolean;
  v_round screening_v2.interview_rounds%rowtype;
  v_round_id uuid;
  v_status text;
  v_reason text;
  v_result text;
  v_out jsonb;
begin
  -- 1. Validation. Nothing is written.
  if p_ashby_interview_event_id is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'event_id');
  end if;
  if p_ashby_schedule_id is null or p_ashby_schedule_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'schedule_id');
  end if;
  if p_ashby_application_id is null or p_ashby_application_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'application_id');
  end if;
  if p_ashby_interview_stage_id is not null and p_ashby_interview_stage_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'stage_id');
  end if;
  if p_ashby_interview_id is not null and p_ashby_interview_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'interview_id');
  end if;
  if p_ashby_scheduled_by_user_id is null or p_ashby_scheduled_by_user_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'attester');
  end if;
  if p_meet_url is null or p_meet_url !~ '^https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'meet_url');
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at
     or p_end_at > p_start_at + interval '24 hours' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'slot');
  end if;
  if p_attested_at is null or p_attested_at > p_now + interval '5 minutes' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'attested_at');
  end if;
  if p_objective_profile is null or p_objective_profile not in ('r1_dex_sales') then
    return jsonb_build_object('status', 'invalid_request', 'field', 'profile');
  end if;
  if p_expiry_grace_sec is null or p_expiry_grace_sec not between 900 and 86400 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'grace');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  -- 2. A slot that has started is never booked. Nothing is written.
  if p_start_at <= p_now then
    return jsonb_build_object('status', 'in_past');
  end if;

  -- 3. The event lock, then the booking row.
  perform pg_advisory_xact_lock(hashtextextended('r1_meet_booking:' || p_ashby_interview_event_id::text, 0));
  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.ashby_interview_event_id = p_ashby_interview_event_id
   for update;
  v_has_booking := found;
  if v_has_booking then
    if v_booking.status in ('completed', 'cancelled', 'failed', 'drained') then
      return jsonb_build_object('status', 'booking_terminal', 'booking_id', v_booking.id,
                                'booking_status', v_booking.status, 'reason', v_booking.reason);
    end if;
    if v_booking.round_id is not null then
      return jsonb_build_object(
        'status', 'exists', 'booking_id', v_booking.id, 'round_id', v_booking.round_id,
        'candidate_id', v_booking.candidate_id, 'booking_status', v_booking.status,
        'reason', v_booking.reason, 'version', v_booking.version,
        'key_attempt', v_booking.key_attempt,
        'round_expires_at', (select r.expires_at from screening_v2.interview_rounds r
                              where r.id = v_booking.round_id),
        'objective_profile', v_booking.objective_profile);
    end if;
    if p_ashby_updated_at < v_booking.ashby_updated_at then
      return jsonb_build_object('status', 'stale_update', 'booking_id', v_booking.id);
    end if;
  end if;

  <<decide>>
  begin
    -- 4. The candidate: the Ashby application link, by its verbatim id.
    select l.candidate_id, l.terminal_state into v_link_candidate, v_link_terminal
      from screening_v2.ashby_application_links l
     where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;
    if v_link_candidate is null then
      v_status := 'unmatched_application';
      v_reason := 'application_unknown';
      exit decide;
    end if;
    if v_link_terminal is not null then
      v_status := 'unmatched_application';
      v_reason := 'application_terminal';
      exit decide;
    end if;
    v_candidate_id := v_link_candidate;

    -- 5. The round creator must be a real auth user (critic A2).
    if p_created_by is null then
      v_status := 'unmapped_scheduler';
      v_reason := 'scheduler_unmapped';
      exit decide;
    end if;
    if not exists (select 1 from auth.users u where u.id = p_created_by) then
      v_status := 'unmapped_scheduler';
      v_reason := 'created_by_unknown';
      exit decide;
    end if;

    -- 6. The bounded expiry (critic A1, C10).
    v_expires := p_end_at + make_interval(secs => p_expiry_grace_sec);
    if v_expires > p_now + interval '14 days' then
      v_retry_after := v_expires - interval '14 days';
      v_status := 'blocked';
      v_reason := 'slot_too_far';
      exit decide;
    end if;

    -- 7. The notice: the newest active release (admission's exact predicate) for en-IN.
    select t.* into v_template
      from screening_v2.interview_round_consent_templates t
     where t.is_active
       and t.version = (select max(x.version) from screening_v2.interview_round_consent_templates x
                         where x.is_active)
       and t.locale = 'en-IN';
    if not found or jsonb_array_length(v_template.required_consents) = 0 then
      v_status := 'blocked';
      v_reason := 'consent_template_unavailable';
      exit decide;
    end if;

    -- 8. Exactly one sales_r1 role.
    select count(*), (array_agg(r.id))[1] into v_role_count, v_role_id
      from screening_v2.roles r
     where r.interview_kind = 'sales_r1';
    if v_role_count <> 1 then
      v_status := 'blocked';
      v_reason := 'role_not_configured';
      exit decide;
    end if;

    -- 9. The round, through r1_send_round. The digest's preimage is never stored or returned.
    select c.status into v_candidate_status
      from screening_v2.candidates c
     where c.id = v_candidate_id;
    v_send := screening_v2.r1_send_round(
      v_candidate_id, v_role_id, p_created_by,
      encode(sha256(convert_to('r1-meet-unusable:' || gen_random_uuid()::text || ':'
                               || gen_random_uuid()::text, 'UTF8')), 'hex'),
      v_candidate_status, v_expires, p_now);
    v_code := v_send ->> 'status';
    if v_code = 'ok' then
      v_round_id := (v_send ->> 'id')::uuid;
      -- Allowed by trg_interview_rounds_channel_locked: invited, unstarted, no consent yet.
      update screening_v2.interview_rounds set channel = 'meet' where id = v_round_id;
      v_status := 'pending';
      v_reason := 'eligible';
      v_result := 'created';
      exit decide;
    end if;
    if v_code in ('disabled', 'paused', 'candidate_ineligible', 'role_not_configured',
                  'phone_engagement_active', 'phone_assessment_pending', 'capacity_exhausted') then
      v_status := 'blocked';
      v_reason := v_code;
      exit decide;
    end if;
    if v_code is distinct from 'round_active' then
      raise exception 'r1_meet_create_round_from_ashby: unexpected answer from r1_send_round'
        using errcode = 'P0001';
    end if;

    -- 10. Re-link. r1_send_round already holds the settings row; take the live round's hold month
    -- (exactly as the round transitions do) and then the round.
    v_status := 'blocked';
    v_reason := 'round_active';
    select r.id, r.held_minutes, r.hold_month, r.charged_attempt_number > r.attempts_counted
      into v_live_id, v_hold_minutes, v_hold_month, v_uncounted
      from screening_v2.interview_rounds r
     where r.candidate_id = v_candidate_id and r.kind = 'sales_r1'
       and r.status in ('invited', 'in_progress');
    if v_live_id is null then
      exit decide;
    end if;
    if v_hold_minutes > 0 then
      if v_hold_month is null then
        exit decide;
      end if;
      perform 1 from screening_v2.r1_budget_month where month_start = v_hold_month for update;
    elsif v_uncounted and v_hold_month is not null then
      perform 1 from screening_v2.r1_budget_month where month_start = v_hold_month for update;
    end if;
    select * into v_round from screening_v2.interview_rounds where id = v_live_id for update;
    -- Reusable: a Meet round that is still live and unexpired (so its hold still counts and no
    -- capacity re-check is needed), has starts and attempts left, no live session and no live
    -- booking. A browser round is never taken over.
    if v_round.id is null
       or v_round.channel <> 'meet'
       or v_round.status not in ('invited', 'in_progress')
       or v_round.expires_at <= p_now
       or v_round.starts_used >= 3
       or v_round.attempts_counted >= v_round.attempts_allowed
       or exists (select 1 from screening_v2.call_sessions s
                   where s.interview_round_id = v_round.id
                     and s.status in ('created', 'waiting', 'in_progress'))
       or exists (select 1 from screening_v2.r1_meet_bookings b
                   where b.round_id = v_round.id
                     and b.status not in ('completed', 'cancelled', 'failed', 'drained')) then
      exit decide;
    end if;
    -- r1_send_round answered round_active before running its two phone checks, so they run here.
    declare
      p_candidate_id constant uuid := v_candidate_id;
    begin
      -- copied from r1_send_round (0128)
      if exists (select 1 from screening_v2.phone_engagements e where e.candidate_id=p_candidate_id and e.state in ('pending_prereqs','eligible','scheduled','dialing','in_call','reconnecting','awaiting_retry')) then
        v_reason := 'phone_engagement_active';
        exit decide;
      end if;
      if exists (select 1 from screening_v2.call_sessions s join screening_v2.job_queue j on j.payload->>'session_id'=s.id::text where s.candidate_id=p_candidate_id and s.mode='live' and j.name='phone.assessment' and j.status in ('pending','active','delayed')) then
        v_reason := 'phone_assessment_pending';
        exit decide;
      end if;
    end;
    -- The notice for the ROUND's audience.
    select t.* into v_template
      from screening_v2.interview_round_consent_templates t
     where t.is_active
       and t.version = (select max(x.version) from screening_v2.interview_round_consent_templates x
                         where x.is_active)
       and t.locale = v_round.consent_locale;
    if not found or jsonb_array_length(v_template.required_consents) = 0 then
      v_reason := 'consent_template_unavailable';
      exit decide;
    end if;
    -- The hold stays in its original month (as a reissue does); only the expiry moves.
    update screening_v2.interview_rounds
       set expires_at = v_expires, version = version + 1, updated_at = p_now
     where id = v_round.id;
    -- The live consent is superseded, never edited in place (routes/r1-candidate.ts); the
    -- recording erase trigger (0127) ignores `superseded`.
    update screening_v2.interview_round_consents
       set withdrawn_at = p_now,
           proof = coalesce(proof, '{}'::jsonb)
             || jsonb_build_object('decision', 'superseded', 'superseded_at', p_now)
     where round_id = v_round.id and withdrawn_at is null;
    v_round_id := v_round.id;
    v_status := 'pending';
    v_reason := 'eligible';
    v_result := 'relinked';
  end decide;

  -- The HR-attested consent of a created or re-linked round (D-M034-9 / D-M034-11): a normal live
  -- consent for the newest template, so admission and the API consent read accept it unchanged.
  if v_result is not null then
    insert into screening_v2.interview_round_consents
      (round_id, template_id, consents, proof, granted_at, method,
       attested_by_external_id, attested_at, india_location_attested)
    values (v_round_id, v_template.id, v_template.required_consents,
            jsonb_build_object(
              'decision', 'granted', 'method', 'hr_attested_ashby', 'captured_at', p_now,
              'template_version', v_template.version, 'locale', v_template.locale,
              'attested_by_external_id', p_ashby_scheduled_by_user_id,
              'attested_at', p_attested_at, 'india_location_attested', true,
              'source', 'ashby_interview_schedule',
              'ashby_interview_event_id', p_ashby_interview_event_id,
              'ashby_schedule_id', p_ashby_schedule_id),
            p_now, 'hr_attested_ashby', p_ashby_scheduled_by_user_id, p_attested_at, true);
  end if;

  -- The booking: every outcome from here on is recorded on the event's one row.
  if v_has_booking then
    update screening_v2.r1_meet_bookings
       set ashby_schedule_id = p_ashby_schedule_id,
           ashby_application_id = p_ashby_application_id,
           ashby_interview_stage_id = p_ashby_interview_stage_id,
           ashby_interview_id = p_ashby_interview_id,
           ashby_scheduled_by_user_id = p_ashby_scheduled_by_user_id,
           ashby_updated_at = greatest(ashby_updated_at, p_ashby_updated_at),
           candidate_id = v_candidate_id,
           round_id = v_round_id,
           objective_profile = p_objective_profile,
           status = v_status,
           reason = v_reason,
           meet_url = p_meet_url,
           start_at = p_start_at,
           end_at = p_end_at,
           updated_at = p_now
     where id = v_booking.id
    returning * into v_booking;
  else
    insert into screening_v2.r1_meet_bookings
      (ashby_interview_event_id, ashby_schedule_id, ashby_application_id,
       ashby_interview_stage_id, ashby_interview_id, ashby_scheduled_by_user_id, ashby_updated_at,
       candidate_id, round_id, objective_profile, status, reason, meet_url, start_at, end_at,
       created_at, updated_at)
    values (p_ashby_interview_event_id, p_ashby_schedule_id, p_ashby_application_id,
            p_ashby_interview_stage_id, p_ashby_interview_id, p_ashby_scheduled_by_user_id,
            p_ashby_updated_at, v_candidate_id, v_round_id, p_objective_profile, v_status, v_reason,
            p_meet_url, p_start_at, p_end_at, p_now, p_now)
    returning * into v_booking;
  end if;

  if v_result is not null then
    return jsonb_build_object(
      'status', v_result, 'booking_id', v_booking.id, 'round_id', v_booking.round_id,
      'candidate_id', v_booking.candidate_id, 'booking_status', v_booking.status,
      'reason', v_booking.reason, 'version', v_booking.version,
      'key_attempt', v_booking.key_attempt, 'round_expires_at', v_expires,
      'objective_profile', v_booking.objective_profile);
  end if;
  v_out := jsonb_build_object('status', v_status, 'reason', v_reason, 'booking_id', v_booking.id);
  if v_retry_after is not null then
    v_out := v_out || jsonb_build_object('retry_after', v_retry_after);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §11. r1_meet_reschedule_booking: a new slot or Meet link for a booking that holds no bot.
-- ---------------------------------------------------------------------------------------------
-- S06 calls this when Ashby moves the time or the Meet link of an event whose booking has a round.
-- A booking that still holds a bot is refused (bot_attached): S06 deletes the bot at Recall, calls
-- r1_meet_set_bot('replace') (a new bot generation), reschedules with that generation, then
-- creates the next bot: the one path of the S01 hand-off. A dispatched bot (joining, a human
-- present, in call) holds the slot (booking_dispatched). The first refusal wins:
--   invalid_request (+field: meet_url, slot, grace, now) | not_found | booking_terminal |
--   version_conflict (the bot generation moved) | stale_update (an older Ashby updatedAt) |
--   booking_dispatched | bot_attached | no_round (a round-less booking retries through the create
--   RPC) | not_allowed | in_past | slot_too_far (+retry_after; nothing changes, S06 marks the
--   booking blocked/slot_too_far) | round_not_live (the round is not an invited or in-progress
--   Meet round, or it has lapsed).
-- Writes: the round's expiry (slot end + grace, at most 14 days ahead, and it may also shorten), its
-- version and updated_at; the booking's slot, Meet link and Ashby updatedAt, back to
-- pending/eligible. The booking version (the bot generation) is NOT bumped here. The round has not
-- lapsed, so its hold still counts and stays in its month: no capacity re-check, as for a re-link.
-- Never reissues the round link; no call_sessions row; time only from p_now.
--
-- Lock order: the booking row, then settings, the round's hold month (taken exactly as the round
-- transitions take it), then the round: the admission order, after one booking.
create or replace function screening_v2.r1_meet_reschedule_booking(
  p_booking_id uuid,
  p_expected_version integer,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_meet_url text,
  p_ashby_updated_at timestamptz,
  p_expiry_grace_sec integer default 7200,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_expires timestamptz;
  v_hold_minutes numeric;
  v_hold_month date;
  v_uncounted boolean;
  v_round screening_v2.interview_rounds%rowtype;
begin
  -- Validation (the create RPC's rules). Nothing is locked or written.
  if p_meet_url is null or p_meet_url !~ '^https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}$' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'meet_url');
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at
     or p_end_at > p_start_at + interval '24 hours' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'slot');
  end if;
  if p_expiry_grace_sec is null or p_expiry_grace_sec not between 900 and 86400 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'grace');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_booking.status in ('completed', 'cancelled', 'failed', 'drained') then
    return jsonb_build_object('status', 'booking_terminal', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status, 'reason', v_booking.reason);
  end if;
  if v_booking.version is distinct from p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'booking_id', v_booking.id,
                              'version', v_booking.version, 'key_attempt', v_booking.key_attempt);
  end if;
  if p_ashby_updated_at < v_booking.ashby_updated_at then
    return jsonb_build_object('status', 'stale_update', 'booking_id', v_booking.id);
  end if;
  if v_booking.status in ('bot_joining', 'human_present', 'in_call') then
    return jsonb_build_object('status', 'booking_dispatched', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status);
  end if;
  if v_booking.recall_bot_id is not null then
    return jsonb_build_object('status', 'bot_attached', 'booking_id', v_booking.id,
                              'version', v_booking.version, 'key_attempt', v_booking.key_attempt);
  end if;
  if v_booking.round_id is null then
    return jsonb_build_object('status', 'no_round', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status, 'reason', v_booking.reason);
  end if;
  if v_booking.status not in ('pending', 'blocked') then
    return jsonb_build_object('status', 'not_allowed', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status);
  end if;
  if p_start_at <= p_now then
    return jsonb_build_object('status', 'in_past', 'booking_id', v_booking.id);
  end if;
  v_expires := p_end_at + make_interval(secs => p_expiry_grace_sec);
  if v_expires > p_now + interval '14 days' then
    return jsonb_build_object('status', 'slot_too_far', 'booking_id', v_booking.id,
                              'retry_after', v_expires - interval '14 days');
  end if;

  -- The round, in the admission order: settings, the round's hold month, the round.
  perform 1 from screening_v2.r1_settings where singleton for update;
  select r.held_minutes, r.hold_month, r.charged_attempt_number > r.attempts_counted
    into v_hold_minutes, v_hold_month, v_uncounted
    from screening_v2.interview_rounds r
   where r.id = v_booking.round_id;
  if v_hold_month is not null and (v_hold_minutes > 0 or v_uncounted) then
    perform 1 from screening_v2.r1_budget_month where month_start = v_hold_month for update;
  end if;
  select * into v_round
    from screening_v2.interview_rounds r
   where r.id = v_booking.round_id
   for update;
  -- Live: the claim RPC's definition (an invited or in-progress Meet round that has not lapsed).
  if not found
     or v_round.channel <> 'meet'
     or v_round.status not in ('invited', 'in_progress')
     or v_round.expires_at <= p_now then
    return jsonb_build_object('status', 'round_not_live', 'booking_id', v_booking.id,
                              'round_id', v_booking.round_id);
  end if;

  update screening_v2.interview_rounds
     set expires_at = v_expires, version = version + 1, updated_at = p_now
   where id = v_round.id;
  -- pending and blocked hold no ticket (chk_r1_meet_bookings_ticket); the clear keeps it so.
  update screening_v2.r1_meet_bookings
     set start_at = p_start_at,
         end_at = p_end_at,
         meet_url = p_meet_url,
         ashby_updated_at = greatest(ashby_updated_at, p_ashby_updated_at),
         ticket_digest = null,
         ticket_not_before = null,
         ticket_expires_at = null,
         ticket_claimed_at = null,
         status = 'pending',
         reason = 'eligible',
         updated_at = p_now
   where id = v_booking.id
  returning * into v_booking;
  return jsonb_build_object('status', 'ok', 'booking_id', v_booking.id,
                            'round_expires_at', v_expires, 'version', v_booking.version,
                            'key_attempt', v_booking.key_attempt);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §12. r1_meet_cancel_booking: the booking is cancelled; nothing else is touched.
-- ---------------------------------------------------------------------------------------------
-- Ashby cancelled the schedule, Dex was removed, the event is gone, or HR cancelled the round in
-- our app. Writes the booking row ONLY (status, reason, an unclaimed ticket, updated_at): the
-- round, its consent rows, attempts, sessions, scores and the candidate stay exactly as they were
-- (owner rule: never delete or rewrite candidate data), which is what lets a re-booking re-link
-- the round (§10). A claimed ticket stays as evidence. The bot is NOT released here: the answer
-- says which bot S06 must remove, and whether it was dispatched (Recall DELETE until then,
-- leave_call afterwards); S06 confirms with r1_meet_set_bot('release'). The first refusal wins:
--   invalid_reason | invalid_request (+field now) | not_found | already_cancelled (+recall_bot_id)
--   | booking_terminal | ok (+previous_status, recall_bot_id, bot_dispatched).
create or replace function screening_v2.r1_meet_cancel_booking(
  p_booking_id uuid,
  p_reason text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
begin
  if p_reason is null
     or p_reason not in ('cancelled', 'dex_absent', 'event_removed', 'round_cancelled') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_booking.status = 'cancelled' then
    return jsonb_build_object('status', 'already_cancelled', 'booking_id', v_booking.id,
                              'reason', v_booking.reason, 'recall_bot_id', v_booking.recall_bot_id);
  end if;
  if v_booking.status in ('completed', 'failed', 'drained') then
    return jsonb_build_object('status', 'booking_terminal', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status, 'reason', v_booking.reason);
  end if;

  update screening_v2.r1_meet_bookings
     set status = 'cancelled',
         reason = p_reason,
         ticket_digest = case when ticket_claimed_at is null then null else ticket_digest end,
         ticket_not_before = case when ticket_claimed_at is null then null else ticket_not_before end,
         ticket_expires_at = case when ticket_claimed_at is null then null else ticket_expires_at end,
         updated_at = p_now
   where id = v_booking.id;
  return jsonb_build_object(
    'status', 'ok', 'booking_id', v_booking.id, 'previous_status', v_booking.status,
    'recall_bot_id', v_booking.recall_bot_id,
    'bot_dispatched', v_booking.status in ('bot_joining', 'human_present', 'in_call'));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §13. r1_meet_set_bot: the Recall bot of a booking, compare-and-set on its generation.
-- ---------------------------------------------------------------------------------------------
-- The Idempotency-Key of a Recall create is r1-meet-<event>-v<version>-k<key_attempt> (S01). Every
-- action compares BOTH counters with what S06 read (version_conflict otherwise), so a stale worker
-- never attaches, rotates, replaces or releases across a generation change. Actions:
--   attach     a created bot on a pending booking -> bot_scheduled. duplicate (the same bot again)
--              | bot_conflict (another bot already attached) | not_allowed (not pending) | in_past
--              (the slot has ended) | round_not_live | bot_in_use (the bot is on another booking).
--   rotate_key Recall asked for a new key (it caches 4xx/5xx answers for 1 h): key_attempt + 1, on a
--              pending booking only (no bot attached) | key_attempts_exhausted at 20.
--   replace    the bot was deleted at Recall before it was dispatched (a time or link change):
--              a new generation, version + 1, key_attempt 0, no bot, no ticket (and a fresh ticket
--              arm budget), back to pending | not_allowed (not bot_scheduled) | version_exhausted
--              at 50.
--   release    S06 confirmed the Recall DELETE / leave_call of a terminal booking's bot: the bot
--              id is cleared (no longer an owed release) | not_allowed (not terminal) | duplicate
--              (already released).
-- invalid_action | invalid_request (+field now, recall_bot_id) | not_found come first. Every answer
-- after the booking is read carries the booking's current version, key_attempt and status.
-- p_recall_bot_id is read by attach only. Locks the booking row only; reads the round.
create or replace function screening_v2.r1_meet_set_bot(
  p_booking_id uuid,
  p_action text,
  p_expected_version integer,
  p_expected_key_attempt integer,
  p_recall_bot_id uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_round screening_v2.interview_rounds%rowtype;
  v_answer text;
begin
  if p_action is null or p_action not in ('attach', 'rotate_key', 'replace', 'release') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;
  if p_action = 'attach' and p_recall_bot_id is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'recall_bot_id');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_booking.version is distinct from p_expected_version
     or v_booking.key_attempt is distinct from p_expected_key_attempt then
    v_answer := 'version_conflict';
  elsif p_action = 'attach' then
    if v_booking.status = 'bot_scheduled' and v_booking.recall_bot_id = p_recall_bot_id then
      v_answer := 'duplicate';
    elsif v_booking.status = 'bot_scheduled' then
      v_answer := 'bot_conflict';
    elsif v_booking.status <> 'pending' then
      v_answer := 'not_allowed';
    elsif p_now >= v_booking.end_at then
      v_answer := 'in_past';
    else
      select * into v_round
        from screening_v2.interview_rounds r
       where r.id = v_booking.round_id;
      if not found
         or v_round.channel <> 'meet'
         or v_round.status not in ('invited', 'in_progress')
         or v_round.expires_at <= p_now then
        v_answer := 'round_not_live';
      elsif exists (select 1 from screening_v2.r1_meet_bookings o
                     where o.recall_bot_id = p_recall_bot_id and o.id <> v_booking.id) then
        v_answer := 'bot_in_use';
      else
        update screening_v2.r1_meet_bookings
           set recall_bot_id = p_recall_bot_id,
               status = 'bot_scheduled',
               reason = 'eligible',
               updated_at = p_now
         where id = v_booking.id
        returning * into v_booking;
        v_answer := 'ok';
      end if;
    end if;
  elsif p_action = 'rotate_key' then
    if v_booking.status <> 'pending' then
      v_answer := 'not_allowed';
    elsif v_booking.key_attempt >= 20 then
      v_answer := 'key_attempts_exhausted';
    else
      update screening_v2.r1_meet_bookings
         set key_attempt = key_attempt + 1,
             updated_at = p_now
       where id = v_booking.id
      returning * into v_booking;
      v_answer := 'ok';
    end if;
  elsif p_action = 'replace' then
    if v_booking.status <> 'bot_scheduled' then
      v_answer := 'not_allowed';
    elsif v_booking.version >= 50 then
      v_answer := 'version_exhausted';
    else
      update screening_v2.r1_meet_bookings
         set recall_bot_id = null,
             version = version + 1,
             key_attempt = 0,
             ticket_digest = null,
             ticket_not_before = null,
             ticket_expires_at = null,
             ticket_claimed_at = null,
             ticket_arms = 0,
             status = 'pending',
             reason = 'eligible',
             updated_at = p_now
       where id = v_booking.id
      returning * into v_booking;
      v_answer := 'ok';
    end if;
  else
    if v_booking.status not in ('completed', 'cancelled', 'failed', 'drained') then
      v_answer := 'not_allowed';
    elsif v_booking.recall_bot_id is null then
      v_answer := 'duplicate';
    else
      update screening_v2.r1_meet_bookings
         set recall_bot_id = null,
             updated_at = p_now
       where id = v_booking.id
      returning * into v_booking;
      v_answer := 'ok';
    end if;
  end if;

  return jsonb_build_object('status', v_answer, 'booking_id', v_booking.id,
                            'version', v_booking.version, 'key_attempt', v_booking.key_attempt,
                            'booking_status', v_booking.status);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §14. r1_meet_transition_booking: the runtime status moves, compare-and-set on the status.
-- ---------------------------------------------------------------------------------------------
-- The moves S06 makes from Recall and Ashby signals; every other move has its own RPC (create,
-- reschedule, cancel, set_bot, the ticket claim). The matrix (from -> to):
--   bot_scheduled -> bot_joining                     (Recall dispatched the bot)
--   bot_scheduled | bot_joining -> human_present     (a non-bot participant joined)
--   in_call -> completed                             (the attempt settled)
--   pending | blocked -> blocked                     (unschedule but keep, the daily bot cap, ...)
--   pending | blocked | unmatched_application | unmapped_scheduler | bot_scheduled |
--   bot_joining | human_present | in_call -> failed | drained
-- not_found | invalid_request (+field now) | status_conflict (+current: the booking moved first) |
-- invalid_transition. The reason is checked ONLY by the table's status/reason pairing: a reason the
-- target does not accept raises 23514 (a programming error, not a runtime answer). A move to a
-- terminal status clears an unclaimed ticket; the bot stays until S06 confirms its release.
create or replace function screening_v2.r1_meet_transition_booking(
  p_booking_id uuid,
  p_from_status text,
  p_to_status text,
  p_reason text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_terminal boolean;
begin
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_booking.status is distinct from p_from_status then
    return jsonb_build_object('status', 'status_conflict', 'booking_id', v_booking.id,
                              'current', v_booking.status);
  end if;
  -- `is not true`: a NULL target is an invalid transition, never a write.
  if ((p_from_status = 'bot_scheduled' and p_to_status = 'bot_joining')
      or (p_from_status in ('bot_scheduled', 'bot_joining') and p_to_status = 'human_present')
      or (p_from_status = 'in_call' and p_to_status = 'completed')
      or (p_from_status in ('pending', 'blocked') and p_to_status = 'blocked')
      or (p_from_status in ('pending', 'blocked', 'unmatched_application', 'unmapped_scheduler',
                            'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
          and p_to_status in ('failed', 'drained'))) is not true then
    return jsonb_build_object('status', 'invalid_transition', 'booking_id', v_booking.id,
                              'from_status', p_from_status, 'to_status', p_to_status);
  end if;

  v_terminal := p_to_status in ('completed', 'failed', 'drained');
  update screening_v2.r1_meet_bookings
     set status = p_to_status,
         reason = p_reason,
         ticket_digest = case when v_terminal and ticket_claimed_at is null then null
                              else ticket_digest end,
         ticket_not_before = case when v_terminal and ticket_claimed_at is null then null
                                  else ticket_not_before end,
         ticket_expires_at = case when v_terminal and ticket_claimed_at is null then null
                                  else ticket_expires_at end,
         updated_at = p_now
   where id = v_booking.id;
  return jsonb_build_object('status', 'ok', 'booking_id', v_booking.id,
                            'previous_status', v_booking.status, 'booking_status', p_to_status,
                            'reason', p_reason, 'recall_bot_id', v_booking.recall_bot_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §15. r1_meet_bind_session: the admitted call session of an in-call booking.
-- ---------------------------------------------------------------------------------------------
-- S05 claims the ticket (the booking moves to in_call), admits the attempt through the unchanged
-- r1_admit_attempt, then binds the session it got. The session must belong to the booking's
-- round; a later session of the same round (a restart) re-binds and the answer names the previous
-- one. not_found | invalid_request (+field now) | not_in_call | session_mismatch (unknown session,
-- or another round's) | duplicate | ok (+previous_session_id). Locks the booking row only; reads
-- the session; writes session_id and updated_at.
create or replace function screening_v2.r1_meet_bind_session(
  p_booking_id uuid,
  p_session_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_session_round uuid;
begin
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_booking.status <> 'in_call' then
    return jsonb_build_object('status', 'not_in_call', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status);
  end if;
  select s.interview_round_id into v_session_round
    from screening_v2.call_sessions s
   where s.id = p_session_id;
  if v_session_round is null or v_session_round is distinct from v_booking.round_id then
    return jsonb_build_object('status', 'session_mismatch', 'booking_id', v_booking.id);
  end if;
  if v_booking.session_id = p_session_id then
    return jsonb_build_object('status', 'duplicate', 'booking_id', v_booking.id,
                              'session_id', v_booking.session_id);
  end if;

  update screening_v2.r1_meet_bookings
     set session_id = p_session_id,
         updated_at = p_now
   where id = v_booking.id;
  return jsonb_build_object('status', 'ok', 'booking_id', v_booking.id,
                            'session_id', p_session_id,
                            'previous_session_id', v_booking.session_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §16. r1_meet_arm_ticket: a single-use bridge ticket for a booking that holds a bot.
-- ---------------------------------------------------------------------------------------------
-- S05/S06 mint the ticket (its plaintext and HMAC domain stay in the API, D-M034-7) and store only
-- its SHA-256 hex digest here, with the window in which the bridge page may claim it. Arming does
-- not depend on the bot's progress, so both modes work (armed when the bot is created, or when a
-- human joins): bot_scheduled, bot_joining, human_present, and in_call (a re-arm after a claimed
-- ticket recovers the page). Each arm replaces the previous ticket, claimed or not; a booking takes
-- at most 5 arms per bot generation (r1_meet_set_bot('replace') resets the count). The window lies
-- inside the slot: not_before >= start_at - 15 min, expires_at <= end_at + 30 min, not_before <
-- expires_at, expires_at > p_now. A spent ticket is never armed again: S05 mints a fresh random
-- ticket per arm, and the stored digest, once claimed, is refused. The status is unchanged. The
-- first refusal wins:
--   invalid_ticket (not a hex64 digest) | invalid_request (+field now) | invalid_window | not_found
--   | invalid_window (outside the slot) | not_armable | digest_in_use (the stored ticket was
--   claimed) | duplicate (the same unclaimed ticket and window again: nothing written) |
--   ticket_arms_exhausted | digest_in_use (another booking holds it) | ok (+not_before,
--   expires_at, ticket_arms).
-- Locks the booking row only; never answers the digest.
create or replace function screening_v2.r1_meet_arm_ticket(
  p_booking_id uuid,
  p_ticket_digest text,
  p_not_before timestamptz,
  p_expires_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
begin
  if p_ticket_digest is null or p_ticket_digest !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_ticket');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;
  if p_not_before is null or p_expires_at is null
     or p_not_before >= p_expires_at or p_expires_at <= p_now then
    return jsonb_build_object('status', 'invalid_window');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_not_before < v_booking.start_at - interval '15 minutes'
     or p_expires_at > v_booking.end_at + interval '30 minutes' then
    return jsonb_build_object('status', 'invalid_window', 'booking_id', v_booking.id);
  end if;
  if v_booking.status not in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call') then
    return jsonb_build_object('status', 'not_armable', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status);
  end if;
  if v_booking.ticket_digest = p_ticket_digest then
    if v_booking.ticket_claimed_at is not null then
      return jsonb_build_object('status', 'digest_in_use', 'booking_id', v_booking.id);
    end if;
    if v_booking.ticket_not_before = p_not_before and v_booking.ticket_expires_at = p_expires_at then
      return jsonb_build_object('status', 'duplicate', 'booking_id', v_booking.id,
                                'not_before', v_booking.ticket_not_before,
                                'expires_at', v_booking.ticket_expires_at,
                                'ticket_arms', v_booking.ticket_arms);
    end if;
  end if;
  if v_booking.ticket_arms >= 5 then
    return jsonb_build_object('status', 'ticket_arms_exhausted', 'booking_id', v_booking.id,
                              'ticket_arms', v_booking.ticket_arms);
  end if;
  if exists (select 1 from screening_v2.r1_meet_bookings o
              where o.ticket_digest = p_ticket_digest and o.id <> v_booking.id) then
    return jsonb_build_object('status', 'digest_in_use', 'booking_id', v_booking.id);
  end if;

  update screening_v2.r1_meet_bookings
     set ticket_digest = p_ticket_digest,
         ticket_not_before = p_not_before,
         ticket_expires_at = p_expires_at,
         ticket_claimed_at = null,
         ticket_arms = ticket_arms + 1,
         updated_at = p_now
   where id = v_booking.id
  returning * into v_booking;
  return jsonb_build_object('status', 'ok', 'booking_id', v_booking.id,
                            'not_before', v_booking.ticket_not_before,
                            'expires_at', v_booking.ticket_expires_at,
                            'ticket_arms', v_booking.ticket_arms);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §17. r1_meet_claim_ticket: the bridge page exchanges its ticket, once.
-- ---------------------------------------------------------------------------------------------
-- S05 hashes the ticket the bridge page presents and claims it BEFORE admission. Single use: the
-- booking row is found by the digest and locked, and ticket_claimed_at is set under that lock, so of
-- two concurrent claims exactly one wins and the other answers ticket_already_claimed with the
-- booking id (S05 answers 409 and alerts: a replayed or shared ticket). A re-arm changes the digest,
-- so a claim racing it finds no row (ticket_unknown). The first refusal wins:
--   invalid_ticket | invalid_request (+field now) | ticket_unknown | ticket_already_claimed
--   (+booking_id) | booking_not_claimable (the booking is not in an armable state) |
--   ticket_not_yet_valid | ticket_expired | round_not_live (not an invited or in-progress Meet
--   round, or it has lapsed: the reschedule and attach definition) | ok.
-- Writes ticket_claimed_at = p_now, status in_call (eligible) and updated_at. Answers the binding
-- S05 admits with: booking, round, candidate, objective profile, Ashby event, the bound session (a
-- re-arm after a restart), and the slot. Never a digest, a link or the attester. Locks the booking
-- row only; reads the round.
create or replace function screening_v2.r1_meet_claim_ticket(
  p_ticket_digest text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_round screening_v2.interview_rounds%rowtype;
begin
  if p_ticket_digest is null or p_ticket_digest !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_ticket');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.ticket_digest = p_ticket_digest
   for update;
  if not found then
    return jsonb_build_object('status', 'ticket_unknown');
  end if;
  if v_booking.ticket_claimed_at is not null then
    return jsonb_build_object('status', 'ticket_already_claimed', 'booking_id', v_booking.id);
  end if;
  if v_booking.status not in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call') then
    return jsonb_build_object('status', 'booking_not_claimable', 'booking_id', v_booking.id,
                              'booking_status', v_booking.status);
  end if;
  if p_now < v_booking.ticket_not_before then
    return jsonb_build_object('status', 'ticket_not_yet_valid', 'booking_id', v_booking.id);
  end if;
  if p_now >= v_booking.ticket_expires_at then
    return jsonb_build_object('status', 'ticket_expired', 'booking_id', v_booking.id);
  end if;
  select * into v_round
    from screening_v2.interview_rounds r
   where r.id = v_booking.round_id;
  if not found
     or v_round.channel <> 'meet'
     or v_round.status not in ('invited', 'in_progress')
     or v_round.expires_at <= p_now then
    return jsonb_build_object('status', 'round_not_live', 'booking_id', v_booking.id,
                              'round_id', v_booking.round_id);
  end if;

  update screening_v2.r1_meet_bookings
     set ticket_claimed_at = p_now,
         status = 'in_call',
         reason = 'eligible',
         updated_at = p_now
   where id = v_booking.id
  returning * into v_booking;
  return jsonb_build_object('status', 'ok', 'booking_id', v_booking.id,
                            'round_id', v_booking.round_id,
                            'candidate_id', v_booking.candidate_id,
                            'objective_profile', v_booking.objective_profile,
                            'ashby_interview_event_id', v_booking.ashby_interview_event_id,
                            'session_id', v_booking.session_id,
                            'start_at', v_booking.start_at,
                            'end_at', v_booking.end_at);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §18. r1_meet_record_receipt: a durable, de-duplicated webhook receipt and its queued work.
-- ---------------------------------------------------------------------------------------------
-- S03 records every accepted Recall (Svix webhook-id) or Ashby schedule (S01 key) delivery here.
-- Insert-or-report-duplicate on the dedupe key, with the inputs checked against the table CHECKs
-- first. An unknown booking id is stored as NULL (booking_linked false), never an error: a webhook
-- may outrun or outlive its booking. With p_enqueue the 0030 transactional outbox runs in the same
-- transaction, so a receipt never exists without its work: one live job in the ONE Meet queue
-- (`r1-meet`, hard-coded; the caller cannot name another queue), dedup key
-- 'r1-meet:receipt:<receipt id>', payload = p_payload (`kind` plus ids, times and the canonical Meet
-- URL only: never a body, a name or an email) || {receipt_id, source}, scheduled at p_scheduled_at
-- (S06's delayed re-runs) or p_now. Re-drive (at least once, never doubled): a duplicate delivery
-- inserts a missing job while the receipt is still `enqueued` and no live job (pending, active,
-- delayed: the uq_job_queue_dedup_active set of 0009) carries the key; a terminal outcome
-- (processed, ignored, failed) means the work is done. A recorded-only receipt that a later
-- delivery asks work for becomes `enqueued` (the first delivery's source and event type stay). The
-- first refusal wins:
--   invalid_source | invalid_dedupe_key | invalid_event_type | invalid_request (+field now) |
--   invalid_payload (p_enqueue needs an object whose `kind` matches ^[a-z][a-z0-9_]{0,39}$; a
--   payload without p_enqueue is a caller bug) | payload_too_large (over 4096 bytes) |
--   invalid_scheduled_at (outside p_now - 1 hour .. p_now + 30 days, or without p_enqueue).
-- Answers {status: inserted | duplicate, id, outcome, enqueued, work_pending, booking_linked}; no
-- dedupe key, no payload. Lock order: the booking (key share, so it outlives the insert), then the
-- receipt row.
create or replace function screening_v2.r1_meet_record_receipt(
  p_source text,
  p_dedupe_key text,
  p_event_type text,
  p_booking_id uuid default null,
  p_enqueue boolean default false,
  p_payload jsonb default null,
  p_scheduled_at timestamptz default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_enqueue constant boolean := coalesce(p_enqueue, false);
  v_booking_id uuid;
  v_id uuid;
  v_outcome text;
  v_linked uuid;
  v_created boolean := false;
  v_enqueued boolean := false;
  v_work_pending boolean := false;
begin
  if p_source is null or p_source not in ('recall', 'ashby') then
    return jsonb_build_object('status', 'invalid_source');
  end if;
  -- The table CHECKs, so a bad key is an answer, never a 23514.
  if p_dedupe_key is null
     or char_length(p_dedupe_key) not between 1 and 256
     or p_dedupe_key !~ '^[A-Za-z0-9_.:-]+$'
     or (p_source = 'ashby') <> (p_dedupe_key like 'ashby-schedule:%') then
    return jsonb_build_object('status', 'invalid_dedupe_key');
  end if;
  if p_event_type is null or p_event_type !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    return jsonb_build_object('status', 'invalid_event_type');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;
  if v_enqueue then
    if p_payload is null
       or jsonb_typeof(p_payload) <> 'object'
       or jsonb_typeof(p_payload -> 'kind') is distinct from 'string'
       or (p_payload ->> 'kind') !~ '^[a-z][a-z0-9_]{0,39}$' then
      return jsonb_build_object('status', 'invalid_payload');
    end if;
    if octet_length(p_payload::text) > 4096 then
      return jsonb_build_object('status', 'payload_too_large');
    end if;
  elsif p_payload is not null then
    return jsonb_build_object('status', 'invalid_payload');
  end if;
  if p_scheduled_at is not null
     and (not v_enqueue
          or p_scheduled_at < p_now - interval '1 hour'
          or p_scheduled_at > p_now + interval '30 days') then
    return jsonb_build_object('status', 'invalid_scheduled_at');
  end if;

  if p_booking_id is not null then
    select b.id into v_booking_id
      from screening_v2.r1_meet_bookings b
     where b.id = p_booking_id
     for key share;
  end if;

  -- Race-safe insert-or-noop on the dedupe key: concurrent deliveries converge to one row. A prior
  -- delivery's row is read back locked, so that a worker's outcome update and this re-drive see
  -- each other; if a prune removed it between the two statements, this delivery is recorded afresh.
  loop
    insert into screening_v2.r1_meet_receipts
      (source, dedupe_key, event_type, booking_id, outcome, received_at)
    values
      (p_source, p_dedupe_key, p_event_type, v_booking_id,
       case when v_enqueue then 'enqueued' else 'recorded' end, p_now)
    on conflict (dedupe_key) do nothing
    returning id, outcome, booking_id into v_id, v_outcome, v_linked;
    if v_id is not null then
      v_created := true;
      exit;
    end if;
    select r.id, r.outcome, r.booking_id into v_id, v_outcome, v_linked
      from screening_v2.r1_meet_receipts r
     where r.dedupe_key = p_dedupe_key
     for update;
    exit when found;
  end loop;

  if not v_created and v_enqueue and v_outcome = 'recorded' then
    update screening_v2.r1_meet_receipts
       set outcome = 'enqueued'
     where id = v_id
    returning outcome into v_outcome;
  end if;

  -- Atomic outbox / re-drive (0030): exactly one live r1-meet job while the receipt is enqueued.
  if v_enqueue then
    if v_outcome in ('processed', 'ignored', 'failed') then
      -- The worker already reached a terminal decision: the durable work is done.
      v_work_pending := true;
    elsif exists (
      select 1 from screening_v2.job_queue j
       where j.dedup_key = 'r1-meet:receipt:' || v_id::text
         and j.status in ('pending', 'active', 'delayed')
    ) then
      -- A live job already carries this receipt: no duplicate work.
      v_work_pending := true;
    else
      begin
        insert into screening_v2.job_queue
          (name, payload, status, dedup_key, attempts, max_attempts, priority, scheduled_at, created_at)
        values
          ('r1-meet', p_payload || jsonb_build_object('receipt_id', v_id, 'source', p_source),
           'pending', 'r1-meet:receipt:' || v_id::text, 0, 5, 0,
           coalesce(p_scheduled_at, p_now), p_now);
        v_enqueued := true;
        v_work_pending := true;
      exception when unique_violation then
        -- A concurrent delivery won the enqueue race: a live job exists.
        v_work_pending := true;
      end;
    end if;
  end if;

  return jsonb_build_object(
    'status', case when v_created then 'inserted' else 'duplicate' end,
    'id', v_id,
    'outcome', v_outcome,
    'enqueued', v_enqueued,
    'work_pending', v_work_pending,
    'booking_linked', v_linked is not null);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §19. r1_meet_prune_receipts: the 30-day receipt retention.
-- ---------------------------------------------------------------------------------------------
-- S06 calls this from an EXISTING tick with p_older_than = now - 30 days (no new loop). It refuses
-- to keep less than 7 days (retention_too_short), deletes at most p_limit (1..5000) of the oldest
-- receipts received before p_older_than, and only those whose work is settled or never existed
-- (recorded, processed, ignored, failed): an `enqueued` receipt is kept while its job may still
-- read it. Rows another prune holds are skipped. Answers invalid_request (+field now, older_than,
-- limit) | retention_too_short | ok (+deleted).
create or replace function screening_v2.r1_meet_prune_receipts(
  p_older_than timestamptz,
  p_limit integer default 500,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_deleted integer;
begin
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;
  if p_older_than is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'older_than');
  end if;
  if p_limit is null or p_limit not between 1 and 5000 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'limit');
  end if;
  if p_older_than > p_now - interval '7 days' then
    return jsonb_build_object('status', 'retention_too_short');
  end if;

  delete from screening_v2.r1_meet_receipts
   where id in (
     select r.id
       from screening_v2.r1_meet_receipts r
      where r.received_at < p_older_than
        and r.outcome in ('recorded', 'processed', 'ignored', 'failed')
      order by r.received_at
      limit p_limit
      for update skip locked);
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('status', 'ok', 'deleted', v_deleted);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §90. Row level security and privileges.
-- ---------------------------------------------------------------------------------------------
-- RLS on, no policy: staff never read these tables directly; the API (service role) authorizes in
-- code (0115 / 0127 pattern). service_role gets exactly select, insert, update and delete: the
-- 0001 default privileges would also hand it TRUNCATE, which skips row triggers and would bypass
-- the §5 bot release, so everything is revoked first.
alter table screening_v2.r1_meet_bookings enable row level security;
alter table screening_v2.r1_meet_receipts enable row level security;

revoke all on screening_v2.r1_meet_bookings, screening_v2.r1_meet_receipts
  from public, anon, authenticated;
revoke all on screening_v2.r1_meet_bookings, screening_v2.r1_meet_receipts
  from service_role;
grant select, insert, update, delete on screening_v2.r1_meet_bookings, screening_v2.r1_meet_receipts
  to service_role;

revoke all on function screening_v2.reject_interview_round_channel_change()
  from public, anon, authenticated;
revoke all on function screening_v2.enqueue_r1_meet_bot_release()
  from public, anon, authenticated;

-- The RPCs: service_role only (S03/S05/S06 call them through the API's service client).
revoke all on function screening_v2.r1_meet_create_round_from_ashby(uuid, text, text, text, text, text, timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_create_round_from_ashby(uuid, text, text, text, text, text, timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_create_round_from_ashby(uuid, text, text, text, text, text, timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz) is
  'M034: for one Ashby interview event with Dex, in one transaction and idempotent per event id: '
  'creates the R1 round through r1_send_round (channel meet, bounded expiry, no usable link), the '
  'HR-attested consent (attester = the Ashby scheduledBy user id, never created_by) and the booking; '
  're-links a reusable Meet round after a re-booking. Answers created | relinked | exists | '
  'booking_terminal | stale_update | unmatched_application | unmapped_scheduler | blocked (+reason, '
  'retry_after for slot_too_far) | in_past | invalid_request (+field). Writes no call_sessions. '
  'Service-role only.';

revoke all on function screening_v2.r1_meet_reschedule_booking(uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_reschedule_booking(uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_reschedule_booking(uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz) is
  'M034: a new slot or Meet link for a booking with a round and no bot (S06 deletes and replaces a '
  'bot first): moves the round expiry to slot end + grace (at most 14 days ahead), back to '
  'pending/eligible; the bot generation is not bumped. Answers ok | invalid_request (+field) | '
  'not_found | booking_terminal | version_conflict | stale_update | booking_dispatched | '
  'bot_attached | no_round | not_allowed | in_past | slot_too_far (+retry_after) | round_not_live. '
  'Service-role only.';

revoke all on function screening_v2.r1_meet_cancel_booking(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_cancel_booking(uuid, text, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_cancel_booking(uuid, text, timestamptz) is
  'M034: cancels a booking (reason cancelled | dex_absent | event_removed | round_cancelled) and '
  'writes nothing but the booking row: the round, its consent and the candidate are untouched. '
  'Answers ok (+previous_status, recall_bot_id, bot_dispatched) | already_cancelled | '
  'booking_terminal | not_found | invalid_reason | invalid_request. Service-role only.';

revoke all on function screening_v2.r1_meet_set_bot(uuid, text, integer, integer, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_set_bot(uuid, text, integer, integer, uuid, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_set_bot(uuid, text, integer, integer, uuid, timestamptz) is
  'M034: the Recall bot of a booking, compare-and-set on (version, key_attempt): attach | '
  'rotate_key (at most 20) | replace (a new generation, at most 50) | release (a terminal '
  'booking''s bot confirmed removed). Answers ok | duplicate | bot_conflict | bot_in_use | '
  'not_allowed | in_past | round_not_live | key_attempts_exhausted | version_exhausted | '
  'version_conflict | not_found | invalid_action | invalid_request, with the current version, '
  'key_attempt and status. Service-role only.';

revoke all on function screening_v2.r1_meet_transition_booking(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_transition_booking(uuid, text, text, text, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_transition_booking(uuid, text, text, text, timestamptz) is
  'M034: the runtime status moves of a booking (bot_joining, human_present, completed, blocked, '
  'failed, drained), compare-and-set on the current status; the reason is checked by the '
  'status/reason pairing CHECK (23514). Answers ok | status_conflict (+current) | '
  'invalid_transition | not_found | invalid_request. Service-role only.';

revoke all on function screening_v2.r1_meet_bind_session(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_bind_session(uuid, uuid, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_bind_session(uuid, uuid, timestamptz) is
  'M034: binds a call session of the booking''s round to an in-call booking (a restart re-binds). '
  'Answers ok (+previous_session_id) | duplicate | not_in_call | session_mismatch | not_found | '
  'invalid_request. Service-role only.';

revoke all on function screening_v2.r1_meet_arm_ticket(uuid, text, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_arm_ticket(uuid, text, timestamptz, timestamptz, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_arm_ticket(uuid, text, timestamptz, timestamptz, timestamptz) is
  'M034: stores the SHA-256 hex digest and claim window of a single-use bridge ticket on a booking '
  'that holds a bot (bot_scheduled, bot_joining, human_present, in_call); window inside start - 15 '
  'min .. end + 30 min; at most 5 arms per bot generation; a claimed digest is never re-armed; the '
  'status is unchanged. Answers ok | duplicate | invalid_ticket | invalid_window | not_found | '
  'not_armable | digest_in_use | ticket_arms_exhausted | invalid_request. Service-role only.';

revoke all on function screening_v2.r1_meet_claim_ticket(text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_claim_ticket(text, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_claim_ticket(text, timestamptz) is
  'M034: claims a bridge ticket by its digest exactly once, inside its window, under the booking row '
  'lock: the booking moves to in_call and the answer is the booking, round, candidate, objective '
  'profile, Ashby event, session and slot. Answers ok | ticket_already_claimed (+booking_id) | '
  'ticket_unknown | booking_not_claimable | ticket_not_yet_valid | ticket_expired | round_not_live | '
  'invalid_ticket | invalid_request. Service-role only.';

revoke all on function screening_v2.r1_meet_record_receipt(text, text, text, uuid, boolean, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_record_receipt(text, text, text, uuid, boolean, jsonb, timestamptz, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_record_receipt(text, text, text, uuid, boolean, jsonb, timestamptz, timestamptz) is
  'M034: durable, de-duplicated webhook receipt (Recall Svix webhook-id or S01 Ashby schedule key; no '
  'body) and, with p_enqueue, the transactional outbox: exactly one live r1-meet job per receipt '
  'while it is enqueued (dedup r1-meet:receipt:<id>, payload p_payload || {receipt_id, source}); '
  'duplicates re-drive a missing job, never double a live one or re-run settled work. An unknown '
  'booking is stored as NULL. Answers inserted | duplicate (+id, outcome, enqueued, work_pending, '
  'booking_linked) | invalid_source | invalid_dedupe_key | invalid_event_type | invalid_payload | '
  'payload_too_large | invalid_scheduled_at | invalid_request. Service-role only.';

revoke all on function screening_v2.r1_meet_prune_receipts(timestamptz, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_prune_receipts(timestamptz, integer, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_prune_receipts(timestamptz, integer, timestamptz) is
  'M034: the 30-day receipt retention, from an existing tick: deletes at most p_limit (1..5000) of '
  'the oldest recorded, processed, ignored or failed receipts received before p_older_than (never an '
  'enqueued one); refuses less than 7 days. Answers ok (+deleted) | retention_too_short | '
  'invalid_request. Service-role only.';

notify pgrst, 'reload schema';
