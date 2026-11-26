-- R1 over Google Meet, booked by the candidate on ONE public link (M035 S01, D-M035-8): the
-- database half of "a candidate already in Ashby registers on /book, picks a slot, and Dex joins
-- the Meet on Dex's own calendar".
--
-- DARK. Nothing calls any object below until S06 (the public booking routes) ships behind
-- R1_MEET_PUBLIC_BOOKING_ENABLED (default OFF) on top of R1_MEET_ENABLED. No queue, route or env
-- variable is added here. Every job row an object below can write is named `r1-meet`, and none is
-- written while the flag is off: the §3 trigger fires only for a public booking (only S06 creates
-- one) and the §4 trigger only when such a booking is deleted. Ashby bookings never enqueue
-- anything new.
--
--   §1 screening_v2.r1_meet_bookings: `source` ('ashby' default | 'public_page') and
--      chk_r1_meet_bookings_source_ids (an Ashby row keeps its three Ashby ids, a public row has
--      none), then the sanctioned DROP NOT NULL of those three ids (ashby_application_id stays NOT
--      NULL: "only people already in Ashby can take it"); the public columns
--      (google_calendar_event_id pinned to the booking id without dashes, calendar_state,
--      invite_sent_at, public_request_id, manage_token_digest, move_count) tied to the source by
--      chk_r1_meet_bookings_public_columns; the reason list grows to 34 (candidate_cancelled,
--      invite_undeliverable) and the status/reason pairing accepts the two new pairs.
--   §2 screening_v2.r1_meet_public_throttle: per-key, per-window hit counters of the public routes
--      (keyed digests only, never plaintext), pruned by r1_meet_public_throttle_prune.
--   §3 enqueue_r1_meet_public_terminal: a public booking that becomes cancelled, failed or drained
--      queues the calendar cancel (while its event exists) and the Ashby "Booked" tag removal.
--   §4 enqueue_r1_meet_calendar_purge: deleting a public booking whose calendar event exists
--      (including the DSAR cascade from candidates and rounds) queues one calendar purge.
--   §10 r1_meet_public_slot_count (internal): live bookings overlapping a slot.
--   §11 r1_meet_public_day_count (internal): the IST-day count, total and public.
--   §12 r1_meet_public_refusal (internal): the refusal predicates shared by precheck and create.
--   §13 r1_meet_public_capacity: live intervals, day counts and the admission capacity, read only.
--   §14 r1_meet_public_precheck: eligible or the first refusal, read only.
--   §15 r1_meet_create_round_from_public: the round, the candidate's consent and the booking.
--   §16 r1_meet_public_set_manage_digest: stores (or rotates) the manage token digest.
--   §17 r1_meet_public_manage_read: what the manage page may show and offer, read only.
--   §18 r1_meet_public_move_booking: a new slot through the manage digest.
--   §19 r1_meet_public_cancel_booking: the candidate's cancel through the manage digest.
--   §20 r1_meet_public_reconsent: a fresh consent on the newest notice through the manage digest.
--   §21 r1_meet_public_set_calendar_state: the calendar event's state, compare-and-set.
--   §22 r1_meet_public_throttle_hit: one atomic hit on up to eight throttle keys.
--   §23 r1_meet_public_throttle_prune: the throttle retention.
--   §90 RLS on (no policy) and service-role-only privileges.
--
-- PII-minimal: ids, times, statuses, closed words and digests. No names, no emails, no phones,
-- no IP addresses (only the minimised prefix inside a consent proof), no request bodies.
--
-- Additive and re-runnable: `if not exists` tables, columns and indexes, guarded CHECK swaps
-- (`drop constraint if exists` + `add constraint ... not valid` + `validate constraint`),
-- `create or replace` functions, `drop trigger if exists` + `create trigger`. No existing row is
-- changed (every new column has a constant default or is NULL; every existing booking is an Ashby
-- row and validates every CHECK below), no existing function is redeclared. The only narrowing is
-- the sanctioned DROP NOT NULL of §1, which the source CHECK added just before it keeps exactly as
-- strict for every Ashby row. Forward-only: while dark the objects simply stay unused.
set local lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------------
-- §1. screening_v2.r1_meet_bookings: public bookings beside the Ashby ones.
-- ---------------------------------------------------------------------------------------------
-- Where the booking came from: 'ashby' (HR scheduled Dex in Ashby, M034, every existing row) or
-- 'public_page' (the candidate booked on the public link, M035). NOT NULL with a constant default
-- is a metadata-only change, and every existing booking reads 'ashby'.
alter table screening_v2.r1_meet_bookings
  add column if not exists source text not null default 'ashby'
  constraint chk_r1_meet_bookings_source
  check (source in ('ashby', 'public_page'));

-- The id rule BEFORE the NOT NULL drops below, so no instant exists in which an Ashby row could
-- lose an Ashby id: an Ashby row keeps all three, a public row has none of them.
alter table screening_v2.r1_meet_bookings
  drop constraint if exists chk_r1_meet_bookings_source_ids;
alter table screening_v2.r1_meet_bookings
  add constraint chk_r1_meet_bookings_source_ids check (
    (source = 'ashby'
      and ashby_interview_event_id is not null
      and ashby_schedule_id is not null
      and ashby_scheduled_by_user_id is not null)
    or (source = 'public_page'
      and ashby_interview_event_id is null
      and ashby_schedule_id is null
      and ashby_scheduled_by_user_id is null)
  ) not valid;
alter table screening_v2.r1_meet_bookings
  validate constraint chk_r1_meet_bookings_source_ids;

-- R1-MEET-PUBLIC-IDS SANCTION: a public booking has no Ashby interview event, schedule or
-- scheduler (the candidate booked it on our page, not HR in Ashby), so these three columns become
-- nullable. chk_r1_meet_bookings_source_ids, added and validated just above, keeps every Ashby row
-- exactly as strict as the NOT NULLs did, and ashby_application_id stays NOT NULL on every row
-- (only people already in Ashby can book). The UUID CHECKs of the three columns and
-- uq_r1_meet_bookings_event already accept NULL (0142). The TST-15 gate sanctions exactly these
-- three single-column statements in this file (scripts/migrate-rollback.test.mjs).
alter table screening_v2.r1_meet_bookings
  alter column ashby_interview_event_id drop not null;
alter table screening_v2.r1_meet_bookings
  alter column ashby_schedule_id drop not null;
alter table screening_v2.r1_meet_bookings
  alter column ashby_scheduled_by_user_id drop not null;

-- The public columns. All NULL (move_count 0) on an Ashby row: chk_r1_meet_bookings_public_columns.
alter table screening_v2.r1_meet_bookings
  add column if not exists google_calendar_event_id text;
alter table screening_v2.r1_meet_bookings
  add column if not exists calendar_state text
  constraint chk_r1_meet_bookings_calendar_state
  check (calendar_state is null or calendar_state in ('created', 'invited', 'cancelled', 'purged'));
alter table screening_v2.r1_meet_bookings
  add column if not exists invite_sent_at timestamptz;
alter table screening_v2.r1_meet_bookings
  add column if not exists public_request_id uuid;
alter table screening_v2.r1_meet_bookings
  add column if not exists manage_token_digest text
  constraint chk_r1_meet_bookings_manage_digest
  check (manage_token_digest is null or manage_token_digest ~ '^[a-f0-9]{64}$');
alter table screening_v2.r1_meet_bookings
  add column if not exists move_count smallint not null default 0
  constraint chk_r1_meet_bookings_move_count
  check (move_count between 0 and 10);

-- The calendar event id is ALWAYS the booking id without dashes (32 lower-case hex characters,
-- valid base32hex for Google), so a purge after a DSAR delete needs no stored value. Table-level:
-- it reads another column.
alter table screening_v2.r1_meet_bookings
  drop constraint if exists chk_r1_meet_bookings_calendar_event_id;
alter table screening_v2.r1_meet_bookings
  add constraint chk_r1_meet_bookings_calendar_event_id check (
    google_calendar_event_id is null
    or google_calendar_event_id = replace(id::text, '-', '')
  ) not valid;
alter table screening_v2.r1_meet_bookings
  validate constraint chk_r1_meet_bookings_calendar_event_id;

-- The public columns belong to public rows only; a public row always has its event id, calendar
-- state and request id, and an invite time only once the invite went out.
alter table screening_v2.r1_meet_bookings
  drop constraint if exists chk_r1_meet_bookings_public_columns;
alter table screening_v2.r1_meet_bookings
  add constraint chk_r1_meet_bookings_public_columns check (
    (source = 'ashby'
      and google_calendar_event_id is null
      and calendar_state is null
      and invite_sent_at is null
      and public_request_id is null
      and manage_token_digest is null
      and move_count = 0)
    or (source = 'public_page'
      and google_calendar_event_id is not null
      and calendar_state is not null
      and public_request_id is not null
      and (invite_sent_at is null or calendar_state in ('invited', 'cancelled', 'purged')))
  ) not valid;
alter table screening_v2.r1_meet_bookings
  validate constraint chk_r1_meet_bookings_public_columns;

-- The closed reason list: the 32 reasons of 0142 in 0142 order, then the candidate's own cancel
-- on the manage page and an invite Google could not deliver.
alter table screening_v2.r1_meet_bookings
  drop constraint if exists chk_r1_meet_bookings_reason;
alter table screening_v2.r1_meet_bookings
  add constraint chk_r1_meet_bookings_reason check (reason in (
    'dex_absent', 'cancelled', 'in_past', 'not_scheduled', 'no_attester', 'no_meet_link', 'eligible',
    'application_unknown', 'application_terminal', 'scheduler_unmapped', 'created_by_unknown',
    'disabled', 'paused', 'candidate_ineligible', 'role_not_configured', 'round_active',
    'phone_engagement_active', 'phone_assessment_pending', 'capacity_exhausted',
    'consent_template_unavailable', 'slot_too_far',
    'bot_cap_reached', 'bot_create_failed', 'bot_fatal', 'event_removed', 'round_cancelled',
    'round_expired', 'no_show', 'admission_refused', 'multiple_humans', 'attempt_settled', 'flag_off',
    'candidate_cancelled', 'invite_undeliverable'
  )) not valid;
alter table screening_v2.r1_meet_bookings
  validate constraint chk_r1_meet_bookings_reason;

-- The 0142 pairing, unchanged except: cancelled also accepts candidate_cancelled, failed also
-- accepts invite_undeliverable.
alter table screening_v2.r1_meet_bookings
  drop constraint if exists chk_r1_meet_bookings_status_reason;
alter table screening_v2.r1_meet_bookings
  add constraint chk_r1_meet_bookings_status_reason check (
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
      and reason in ('cancelled', 'dex_absent', 'event_removed', 'round_cancelled',
                     'candidate_cancelled'))
    or (status in ('failed')
      and reason in ('in_past', 'bot_create_failed', 'bot_fatal', 'no_show', 'admission_refused',
                     'multiple_humans', 'round_expired', 'invite_undeliverable'))
    or (status in ('drained')
      and reason in ('flag_off'))
  ) not valid;
alter table screening_v2.r1_meet_bookings
  validate constraint chk_r1_meet_bookings_status_reason;

-- A submit replays by its request id; a manage token resolves its booking by digest.
create unique index if not exists uq_r1_meet_bookings_public_request
  on screening_v2.r1_meet_bookings (public_request_id)
  where public_request_id is not null;
create unique index if not exists uq_r1_meet_bookings_manage_digest
  on screening_v2.r1_meet_bookings (manage_token_digest)
  where manage_token_digest is not null;

comment on column screening_v2.r1_meet_bookings.source is
  'ashby: HR scheduled Dex in Ashby (M034, the three Ashby event/schedule/scheduler ids are set). '
  'public_page: the candidate booked on the public link (M035, those three ids are NULL). '
  'ashby_application_id is set on every row. Tied by chk_r1_meet_bookings_source_ids.';
comment on column screening_v2.r1_meet_bookings.google_calendar_event_id is
  'public_page only: the Google Calendar event id on Dex''s calendar, always the booking UUID '
  'without dashes (chk_r1_meet_bookings_calendar_event_id), so a purge after a DSAR delete needs '
  'no stored value. Internal.';
comment on column screening_v2.r1_meet_bookings.calendar_state is
  'public_page only: created | invited | cancelled | purged, the state of the calendar event, '
  'written by S05 through r1_meet_public_set_calendar_state (compare-and-set). Internal.';
comment on column screening_v2.r1_meet_bookings.invite_sent_at is
  'public_page only: the first time the calendar invite was sent with the candidate as the '
  'attendee (set by r1_meet_public_set_calendar_state on the move to invited). Internal.';
comment on column screening_v2.r1_meet_bookings.public_request_id is
  'public_page only: the submit request id (uq_r1_meet_bookings_public_request), so a replayed '
  'submit answers the booking it already made. Internal.';
comment on column screening_v2.r1_meet_bookings.manage_token_digest is
  'public_page only: HMAC-SHA256 hex of the candidate''s manage token (move, cancel, re-consent). '
  'The raw token is never stored, and the token is dead at slot end or once the booking is '
  'terminal. Secret.';
comment on column screening_v2.r1_meet_bookings.move_count is
  'public_page only: how many times the candidate moved the slot through the manage link (0..10, '
  'the API caps it lower). Always 0 on an Ashby row. Internal.';

comment on constraint chk_r1_meet_bookings_source_ids on screening_v2.r1_meet_bookings is
  'An Ashby booking has its Ashby interview event, schedule and scheduler ids, a public booking '
  'has none of them (M035). Replaces the NOT NULLs those three columns had in 0142.';
comment on constraint chk_r1_meet_bookings_calendar_event_id on screening_v2.r1_meet_bookings is
  'The calendar event id, when set, is the booking id without dashes (M035).';
comment on constraint chk_r1_meet_bookings_public_columns on screening_v2.r1_meet_bookings is
  'The public columns are NULL (move_count 0) on an Ashby booking, a public booking has its event '
  'id, calendar state and request id, and an invite time only once invited (M035).';
comment on constraint chk_r1_meet_bookings_reason on screening_v2.r1_meet_bookings is
  'Closed reason list: the 32 reasons of 0142, then candidate_cancelled and invite_undeliverable '
  '(M035).';
comment on constraint chk_r1_meet_bookings_status_reason on screening_v2.r1_meet_bookings is
  'Ties each reason to its status family (0142). M035 adds cancelled/candidate_cancelled and '
  'failed/invite_undeliverable.';

-- ---------------------------------------------------------------------------------------------
-- §2. screening_v2.r1_meet_public_throttle
-- ---------------------------------------------------------------------------------------------
-- One row per (key, window bucket). The key is a keyed digest the API computes (of an IP, a
-- normalised email, a phone or a global key); no plaintext ever reaches this table.
create table if not exists screening_v2.r1_meet_public_throttle (
  key_digest text not null,
  bucket_start timestamptz not null,
  hits integer not null default 0,
  constraint pk_r1_meet_public_throttle primary key (key_digest, bucket_start),
  constraint chk_r1_meet_public_throttle_key check (key_digest ~ '^[a-f0-9]{64}$'),
  constraint chk_r1_meet_public_throttle_hits check (hits >= 0)
);

-- The prune deletes the oldest buckets first.
create index if not exists idx_r1_meet_public_throttle_bucket
  on screening_v2.r1_meet_public_throttle (bucket_start);

comment on table screening_v2.r1_meet_public_throttle is
  'R1 public booking (M035): hit counters of the public routes per key and window bucket, written '
  'only by r1_meet_public_throttle_hit and pruned by r1_meet_public_throttle_prune. Keyed digests '
  'only, never plaintext. Service-role only.';
comment on column screening_v2.r1_meet_public_throttle.key_digest is
  'Keyed HMAC-SHA256 hex of the throttled subject (an IP, a normalised email, a phone or a global '
  'key), computed by the API. Never plaintext. Confidential.';
comment on column screening_v2.r1_meet_public_throttle.bucket_start is
  'The start of the window bucket: p_now floored to the window. Internal.';
comment on column screening_v2.r1_meet_public_throttle.hits is
  'Hits of this key in this bucket (capped at 1000000000). Internal.';

-- ---------------------------------------------------------------------------------------------
-- §3. A public booking that ends unused tidies its calendar event and its Ashby tag.
-- ---------------------------------------------------------------------------------------------
-- When a public booking first becomes cancelled, failed or drained (never after completed), one
-- `r1-meet` calendar_sync cancel job is queued while the event exists (created or invited), and
-- one ashby_booked_tag remove job always, so no TypeScript path (the candidate's cancel, HR's
-- round cancel, the drain, a failure, maintenance) has to enqueue them itself. A second terminal
-- update (a reason change) adds nothing. Ids only; the dedup keys are per booking and op, and
-- uq_job_queue_dedup_active (0009) is partial over live jobs. The trigger only inserts jobs: it
-- locks no booking (the 0142 §6 reasoning). Ashby bookings never reach it (the WHEN clause).
create or replace function screening_v2.enqueue_r1_meet_public_terminal()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.calendar_state in ('created', 'invited') then
    insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
    values ('r1-meet',
            jsonb_build_object('kind', 'calendar_sync', 'op', 'cancel', 'booking_id', new.id),
            'r1-meet:calendar:' || new.id::text || ':cancel', 10)
    on conflict do nothing;
  end if;
  insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
  values ('r1-meet',
          jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'remove', 'booking_id', new.id),
          'r1-meet:ashby-tag:' || new.id::text || ':remove', 10)
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists enqueue_r1_meet_public_terminal on screening_v2.r1_meet_bookings;
create trigger enqueue_r1_meet_public_terminal
  after update of status on screening_v2.r1_meet_bookings
  for each row
  when (new.source = 'public_page' and new.status in ('cancelled', 'failed', 'drained') and old.status not in ('completed', 'cancelled', 'failed', 'drained'))
  execute function screening_v2.enqueue_r1_meet_public_terminal();

-- ---------------------------------------------------------------------------------------------
-- §4. A deleted public booking never orphans its calendar event.
-- ---------------------------------------------------------------------------------------------
-- Row-level AFTER DELETE triggers fire for FK cascades too (candidate or round delete, DSAR), so a
-- public booking whose event still exists (created or invited) always leaves one durable
-- `r1-meet` calendar_sync purge job in the same transaction, beside 0142's bot release. The event
-- id is derived from the booking id (§1), so the job carries the booking id only. Dedup per
-- booking; uq_job_queue_dedup_active (0009) is partial over live jobs.
create or replace function screening_v2.enqueue_r1_meet_calendar_purge()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
  values ('r1-meet',
          jsonb_build_object('kind', 'calendar_sync', 'op', 'purge', 'booking_id', old.id),
          'r1-meet:calendar:' || old.id::text || ':purge', 10)
  on conflict do nothing;
  return old;
end;
$$;

drop trigger if exists enqueue_r1_meet_calendar_purge on screening_v2.r1_meet_bookings;
create trigger enqueue_r1_meet_calendar_purge
  after delete on screening_v2.r1_meet_bookings
  for each row
  when (old.source = 'public_page' and old.calendar_state in ('created', 'invited'))
  execute function screening_v2.enqueue_r1_meet_calendar_purge();

-- ---------------------------------------------------------------------------------------------
-- §90. Row level security and privileges.
-- ---------------------------------------------------------------------------------------------
-- RLS on, no policy: nobody but the API (service role) touches the throttle table. service_role
-- gets exactly select, insert, update and delete: the 0001 default privileges would also hand it
-- TRUNCATE, so everything is revoked first (the 0142 pattern). r1_meet_bookings keeps its 0142
-- RLS and privileges unchanged.
alter table screening_v2.r1_meet_public_throttle enable row level security;

revoke all on screening_v2.r1_meet_public_throttle
  from public, anon, authenticated;
revoke all on screening_v2.r1_meet_public_throttle
  from service_role;
grant select, insert, update, delete on screening_v2.r1_meet_public_throttle
  to service_role;

revoke all on function screening_v2.enqueue_r1_meet_public_terminal()
  from public, anon, authenticated;
revoke all on function screening_v2.enqueue_r1_meet_calendar_purge()
  from public, anon, authenticated;

comment on function screening_v2.enqueue_r1_meet_public_terminal() is
  'M035: trigger of r1_meet_bookings (after update of status). A public booking that first becomes '
  'cancelled, failed or drained queues one r1-meet calendar_sync cancel job while its event exists '
  'and one ashby_booked_tag remove job. Ids only.';
comment on function screening_v2.enqueue_r1_meet_calendar_purge() is
  'M035: trigger of r1_meet_bookings (after delete, also on the DSAR cascade). A deleted public '
  'booking whose calendar event exists queues one r1-meet calendar_sync purge job. Ids only.';

notify pgrst, 'reload schema';
