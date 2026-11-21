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

notify pgrst, 'reload schema';
