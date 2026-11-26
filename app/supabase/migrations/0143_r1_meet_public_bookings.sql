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
-- §10. r1_meet_public_slot_count (internal): live bookings overlapping a slot.
-- ---------------------------------------------------------------------------------------------
-- How many LIVE bookings of either source (pending, blocked, bot_scheduled, bot_joining,
-- human_present, in_call) overlap [p_start_at, p_end_at): a booking that ends exactly when the
-- slot starts, or starts exactly when it ends, does not overlap. p_exclude_booking_id leaves one
-- booking out (a move counts the slot without the booking being moved). Internal: create and move
-- call it under the day lock, capacity reads the same rule. No EXECUTE for any API role.
create or replace function screening_v2.r1_meet_public_slot_count(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_booking_id uuid
)
returns integer
language plpgsql
stable
security invoker
set search_path = pg_catalog, screening_v2
as $$
begin
  return (
    select count(*)::integer
      from screening_v2.r1_meet_bookings b
     where b.status in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
       and b.start_at < p_end_at
       and b.end_at > p_start_at
       and b.id is distinct from p_exclude_booking_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §11. r1_meet_public_day_count (internal): the IST-day count, total and public.
-- ---------------------------------------------------------------------------------------------
-- The bookings whose slot STARTS in the IST day p_ist_date ([00:00, 24:00) Asia/Kolkata) and that
-- either are live or used a bot: (status, reason) in R1_MEET_CAP_STATUSES x R1_MEET_CAP_REASONS
-- (lib/r1/meet/runtime-store.ts, the M034 daily bot cap read, pinned by a parity test). `total`
-- counts both sources, `public` only public_page bookings. A failure that never had a bot (in_past,
-- bot_create_failed, round_expired, invite_undeliverable) and a cancel do not count.
-- p_exclude_booking_id leaves one booking out (a move). Internal, no EXECUTE for any API role.
create or replace function screening_v2.r1_meet_public_day_count(
  p_ist_date date,
  p_exclude_booking_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, screening_v2
as $$
declare
  v_from timestamptz := p_ist_date::timestamp at time zone 'Asia/Kolkata';
  v_to timestamptz := (p_ist_date + 1)::timestamp at time zone 'Asia/Kolkata';
  v_total integer;
  v_public integer;
begin
  select count(*)::integer, (count(*) filter (where b.source = 'public_page'))::integer
    into v_total, v_public
    from screening_v2.r1_meet_bookings b
   where b.start_at >= v_from
     and b.start_at < v_to
     and b.id is distinct from p_exclude_booking_id
     and (b.status in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
          or (b.status in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed', 'failed')
              and b.reason in ('eligible', 'attempt_settled', 'bot_fatal', 'no_show', 'admission_refused', 'multiple_humans')));
  return jsonb_build_object('total', v_total, 'public', v_public);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §12. r1_meet_public_refusal (internal): the refusal predicates shared by precheck and create.
-- ---------------------------------------------------------------------------------------------
-- The ONE answer to "may this candidate book a public R1 slot now": NULL (eligible) or the first
-- refusal code, in this order (contracts 4.1 item 2):
--   application_unknown (no Ashby link with this verbatim application id, or bound to another
--   candidate) | application_terminal | mapping_unavailable (not enabled, or archived) |
--   dsar_hold (the 0130 subject_request_hold predicate) | candidate_ineligible
--   (decision_use_blocked_at) | already_booked | r1_completed | phone_engagement_active |
--   phone_assessment_pending | role_not_configured | consent_template_unavailable | disabled |
--   paused | capacity_exhausted.
-- already_booked: a live booking of either source; or a live round that the create could neither
-- expire (0142 step 8a: a lapsed, unstarted Meet round nothing uses) nor re-link (0142 step 10: a
-- live, unexpired Meet round with starts and attempts left, no live session and no live booking).
-- So a live or lapsed browser round, an in-progress lapsed Meet round and a Meet round with a live
-- session refuse, while a Meet round after a cancel, a failed booking or HR's grant-retake (back
-- to invited) is eligible. r1_completed: a completed sales_r1 round and no round to re-link (no
-- public retake). capacity_exhausted applies only when no round is re-linked: a re-link takes no
-- new hold (0142 step 10 has no capacity check either). The notice is the newest active release
-- for the re-linked round's consent locale, else en-IN. Read only (stable): precheck calls it, and
-- create calls it under its candidate and day locks. Internal, no EXECUTE for any API role.
create or replace function screening_v2.r1_meet_public_refusal(
  p_candidate_id uuid,
  p_ashby_application_id text,
  p_now timestamptz
)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, screening_v2
as $$
declare
  v_candidate_id constant uuid := p_candidate_id;
  v_link_found boolean;
  v_link_candidate uuid;
  v_link_terminal text;
  v_link_mapping uuid;
  v_round screening_v2.interview_rounds%rowtype;
  v_reusable boolean := true;
  v_lapsed_id uuid;
  v_lapsed_version integer;
  v_locale text := 'en-IN';
  v_role_count integer;
  v_template screening_v2.interview_round_consent_templates%rowtype;
  v_settings screening_v2.r1_settings%rowtype;
begin
  -- The Ashby application link, by its verbatim id, bound to THIS candidate.
  select l.candidate_id, l.terminal_state, l.job_mapping_id
    into v_link_candidate, v_link_terminal, v_link_mapping
    from screening_v2.ashby_application_links l
   where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;
  v_link_found := found;
  if not v_link_found or v_link_candidate is distinct from p_candidate_id then
    return 'application_unknown';
  end if;
  if v_link_terminal is not null then
    return 'application_terminal';
  end if;
  if not exists (select 1 from screening_v2.ashby_job_mappings m
                  where m.id = v_link_mapping and m.status = 'enabled' and m.archived_at is null) then
    return 'mapping_unavailable';
  end if;
  -- copied from 0130 subject_request_hold
  if exists (
    select 1 from screening_v2.data_subject_requests d
     where d.candidate_id = p_candidate_id
       and d.request_type in ('correct', 'restrict', 'delete')
       and d.request_status in ('pending', 'in_progress', 'fulfilled')
  ) then
    return 'dsar_hold';
  end if;
  if not exists (select 1 from screening_v2.candidates c
                  where c.id = p_candidate_id and c.decision_use_blocked_at is null) then
    return 'candidate_ineligible';
  end if;

  -- A live booking of either source.
  if exists (select 1 from screening_v2.r1_meet_bookings b
              where b.candidate_id = p_candidate_id
                and b.status in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')) then
    return 'already_booked';
  end if;
  -- The candidate's live round: at most one (uq_interview_rounds_candidate_kind_live, 0115).
  select * into v_round
    from screening_v2.interview_rounds r
   where r.candidate_id = p_candidate_id and r.kind = 'sales_r1'
     and r.status in ('invited', 'in_progress');
  -- Expirable: the lapsed Meet round the create would expire first (0142 step 8a). Without a
  -- booking of the caller yet, no booking is left out.
  -- copied from r1_meet_create_round_from_ashby (0142) step 8a, without the event conjunct
  select r.id, r.version into v_lapsed_id, v_lapsed_version
    from screening_v2.interview_rounds r
   where r.candidate_id = v_candidate_id and r.kind = 'sales_r1' and r.channel = 'meet'
     and r.status = 'invited' and r.starts_used = 0 and r.expires_at <= p_now
     and not exists (select 1 from screening_v2.call_sessions s
                      where s.interview_round_id = r.id
                        and s.status in ('created', 'waiting', 'in_progress'))
     and not exists (select 1 from screening_v2.r1_meet_bookings o
                      where o.round_id = r.id
                        and o.status not in ('completed', 'cancelled', 'failed', 'drained'))
   limit 1;
  -- Reusable: the live round the create would re-link (0142 step 10).
  -- copied from r1_meet_create_round_from_ashby (0142) step 10 reuse
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
    v_reusable := false;
  end if;
  if v_round.id is not null and not v_reusable and v_lapsed_id is null then
    return 'already_booked';
  end if;
  -- One R1 per candidate: a completed round and nothing to re-link (an expirable round is not live).
  if not v_reusable
     and exists (select 1 from screening_v2.interview_rounds r
                  where r.candidate_id = p_candidate_id and r.kind = 'sales_r1'
                    and r.status = 'completed') then
    return 'r1_completed';
  end if;

  -- copied from r1_send_round (0128)
  if exists (select 1 from screening_v2.phone_engagements e where e.candidate_id=p_candidate_id and e.state in ('pending_prereqs','eligible','scheduled','dialing','in_call','reconnecting','awaiting_retry')) then
    return 'phone_engagement_active';
  end if;
  if exists (select 1 from screening_v2.call_sessions s join screening_v2.job_queue j on j.payload->>'session_id'=s.id::text where s.candidate_id=p_candidate_id and s.mode='live' and j.name='phone.assessment' and j.status in ('pending','active','delayed')) then
    return 'phone_assessment_pending';
  end if;

  select count(*) into v_role_count
    from screening_v2.roles r
   where r.interview_kind = 'sales_r1';
  if v_role_count <> 1 then
    return 'role_not_configured';
  end if;

  -- The notice: the re-linked round's audience, else the public (en-IN) one.
  if v_reusable then
    v_locale := v_round.consent_locale;
  end if;
  -- newest active notice (0142 step 7)
  select t.* into v_template
    from screening_v2.interview_round_consent_templates t
   where t.is_active
     and t.version = (select max(x.version) from screening_v2.interview_round_consent_templates x
                       where x.is_active)
     and t.locale = v_locale;
  if not found or jsonb_array_length(v_template.required_consents) = 0 then
    return 'consent_template_unavailable';
  end if;

  select * into v_settings from screening_v2.r1_settings where singleton;
  if not found or not v_settings.enabled then
    return 'disabled';
  end if;
  if v_settings.paused then
    return 'paused';
  end if;
  if not v_reusable then
    -- copied from r1_send_round (0128) capacity
    if coalesce((screening_v2.r1_capacity_snapshot(p_now, 65)->>'admits')::boolean, false) is not true then
      return 'capacity_exhausted';
    end if;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §13. r1_meet_public_capacity: live intervals, day counts and the admission capacity, read only.
-- ---------------------------------------------------------------------------------------------
-- What the slot picker needs for [p_from, p_to) (at most 15 days): `intervals`, the live bookings
-- of both sources overlapping the window (start_at, end_at only, never an id), ordered by start;
-- `day_counts`, one entry per IST date the window touches (zeros included, ascending, at most 16)
-- with the total and public counts of §11; `effective_concurrency`, the 0131 admission limit
-- (target cloud 1, else least(max_concurrent_sessions, greatest(browser pool, 1))); `admits`,
-- whether one more 65-minute round fits, decided exactly as r1_send_round decides
-- capacity_exhausted; `enabled` and `paused` from the settings. A missing settings row answers
-- enabled false, paused false, admits false, effective_concurrency 1 (r1_capacity_snapshot raises
-- on a missing row, so it is not called). Stable: it writes nothing and takes no lock.
-- Answers ok | invalid_request (+field: window, now).
create or replace function screening_v2.r1_meet_public_capacity(
  p_from timestamptz,
  p_to timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_settings screening_v2.r1_settings%rowtype;
  v_pool integer;
  v_limit integer;
  v_admits boolean;
  v_first date;
  v_last date;
  v_intervals jsonb;
  v_days jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '15 days' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'window');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('start_at', b.start_at, 'end_at', b.end_at)
                            order by b.start_at, b.end_at), '[]'::jsonb)
    into v_intervals
    from screening_v2.r1_meet_bookings b
   where b.status in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
     and b.start_at < p_to
     and b.end_at > p_from;

  v_first := (p_from at time zone 'Asia/Kolkata')::date;
  v_last := ((p_to - interval '1 microsecond') at time zone 'Asia/Kolkata')::date;
  select jsonb_agg(jsonb_build_object('ist_date', to_char(g.d, 'YYYY-MM-DD'))
                   || screening_v2.r1_meet_public_day_count(g.d, null)
                   order by g.d)
    into v_days
    from (select v_first + i as d from generate_series(0, v_last - v_first) i) g;

  select * into v_settings from screening_v2.r1_settings where singleton;
  if not found then
    return jsonb_build_object('status', 'ok', 'enabled', false, 'paused', false, 'admits', false,
                              'effective_concurrency', 1, 'intervals', v_intervals,
                              'day_counts', v_days);
  end if;
  -- copied from r1_admit_attempt (0131 concurrent-limit)
  if v_settings.livekit_target='r1' then
    select count(*) into v_pool from screening_v2.voice_worker_leases l where l.app='project-hello-voice' and l.pipeline='browser';
    v_limit:=least(coalesce(v_settings.max_concurrent_sessions,1),greatest(v_pool,1));
  else
    v_limit:=1;
  end if;
  -- copied from r1_send_round (0128) capacity
  v_admits := coalesce((screening_v2.r1_capacity_snapshot(p_now, 65)->>'admits')::boolean, false);
  return jsonb_build_object('status', 'ok', 'enabled', v_settings.enabled,
                            'paused', v_settings.paused, 'admits', v_admits,
                            'effective_concurrency', v_limit, 'intervals', v_intervals,
                            'day_counts', v_days);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §14. r1_meet_public_precheck: eligible or the first refusal, read only.
-- ---------------------------------------------------------------------------------------------
-- S06 calls this before it creates the Google event; the create re-runs the same §12 predicates
-- under its locks. Stable: it writes nothing and takes no lock. Answers eligible |
-- refused (+code, §12 order) | invalid_request (+field: candidate_id, application_id, now).
create or replace function screening_v2.r1_meet_public_precheck(
  p_candidate_id uuid,
  p_ashby_application_id text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_code text;
begin
  if p_candidate_id is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'candidate_id');
  end if;
  if p_ashby_application_id is null or p_ashby_application_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'application_id');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  v_code := screening_v2.r1_meet_public_refusal(p_candidate_id, p_ashby_application_id, p_now);
  if v_code is null then
    return jsonb_build_object('status', 'eligible');
  end if;
  return jsonb_build_object('status', 'refused', 'code', v_code);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §16. r1_meet_public_set_manage_digest: stores (or rotates) the manage token digest.
-- ---------------------------------------------------------------------------------------------
-- S06 mints the manage token after the create and stores only its HMAC-SHA256 hex here; a new
-- digest replaces the old one (rotation: the old link dies at once). A terminal booking takes no
-- digest (its token is dead). updated_at is NOT changed: it records status changes only (the S11
-- tag rule reads failed or drained with updated_at >= start_at). A digest already on another
-- booking raises 23505 (32 random bytes never collide: a programming error). The first refusal
-- wins: invalid_request (+field: booking_id, digest, now) | not_found | not_public |
-- booking_terminal | ok.
create or replace function screening_v2.r1_meet_public_set_manage_digest(
  p_booking_id uuid,
  p_digest text,
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
  if p_booking_id is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'booking_id');
  end if;
  if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'digest');
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
  if v_booking.source <> 'public_page' then
    return jsonb_build_object('status', 'not_public');
  end if;
  if v_booking.status in ('completed', 'cancelled', 'failed', 'drained') then
    return jsonb_build_object('status', 'booking_terminal');
  end if;

  update screening_v2.r1_meet_bookings
     set manage_token_digest = p_digest
   where id = v_booking.id;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §17. r1_meet_public_manage_read: what the manage page may show and offer, read only.
-- ---------------------------------------------------------------------------------------------
-- The manage link's booking, by digest: only a LIVE public booking whose slot has not ended (the
-- token is dead at slot end or once terminal), else not_found. can_move: undispatched (pending,
-- blocked, bot_scheduled), before start - cutoff, and moves left. can_cancel: not dispatched
-- (bot_joining, human_present, in_call) and before start - cutoff. moves_left floors at 0.
-- consent_current: the round has a live consent that admission accepts (r1_admit_attempt's
-- consent gate: on the newest active release, granted, covering the required keys). Stable:
-- writes nothing, takes no lock. Answers ok (+booking_id, booking_status, version, has_bot,
-- start_at, end_at, can_move, can_cancel, moves_left, consent_current) | not_found |
-- invalid_request (+field: digest, cutoff, max_moves, now).
create or replace function screening_v2.r1_meet_public_manage_read(
  p_digest text,
  p_cutoff_sec integer,
  p_max_moves integer,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_before_cutoff boolean;
  v_consent boolean;
begin
  if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'digest');
  end if;
  if p_cutoff_sec is null or p_cutoff_sec not between 900 and 43200 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'cutoff');
  end if;
  if p_max_moves is null or p_max_moves not between 0 and 10 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'max_moves');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  select * into v_booking
    from screening_v2.r1_meet_bookings b
   where b.manage_token_digest = p_digest and b.source = 'public_page';
  if not found
     or v_booking.status not in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
     or p_now >= v_booking.end_at then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_before_cutoff := p_now < v_booking.start_at - make_interval(secs => p_cutoff_sec);
  -- copied from r1_admit_attempt (0128) consent gate
  v_consent := exists(select 1 from screening_v2.interview_round_consents c join screening_v2.interview_round_consent_templates t on t.id=c.template_id where c.round_id=v_booking.round_id and c.withdrawn_at is null and c.granted_at<=p_now and t.is_active and t.version=(select max(x.version) from screening_v2.interview_round_consent_templates x where x.is_active) and t.required_consents <@ c.consents);
  return jsonb_build_object(
    'status', 'ok', 'booking_id', v_booking.id, 'booking_status', v_booking.status,
    'version', v_booking.version, 'has_bot', v_booking.recall_bot_id is not null,
    'start_at', v_booking.start_at, 'end_at', v_booking.end_at,
    'can_move', v_booking.status in ('pending', 'blocked', 'bot_scheduled')
                and v_before_cutoff and v_booking.move_count < p_max_moves,
    'can_cancel', v_booking.status not in ('bot_joining', 'human_present', 'in_call')
                  and v_before_cutoff,
    'moves_left', greatest(p_max_moves - v_booking.move_count, 0),
    'consent_current', v_consent);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §21. r1_meet_public_set_calendar_state: the calendar event's state, compare-and-set.
-- ---------------------------------------------------------------------------------------------
-- S05 records what it did on Dex's calendar. Allowed moves: created|invited -> invited (a re-send
-- after a move keeps the first invite time), created|invited -> cancelled,
-- created|invited|cancelled -> purged; p_from lists the states the caller expects (1..3, each a
-- legal source for p_to). invited sets invite_sent_at = coalesce(invite_sent_at, p_now).
-- updated_at is NOT changed (status changes only, see §16), and no status changes, so the §3
-- trigger never fires from here. The first refusal wins: invalid_request (+field: booking_id, to,
-- from, now) | not_found | not_public | state_conflict (+current) | ok (+calendar_state).
create or replace function screening_v2.r1_meet_public_set_calendar_state(
  p_booking_id uuid,
  p_from text[],
  p_to text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_booking screening_v2.r1_meet_bookings%rowtype;
  v_allowed text[];
begin
  if p_booking_id is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'booking_id');
  end if;
  if p_to is null or p_to not in ('invited', 'cancelled', 'purged') then
    return jsonb_build_object('status', 'invalid_request', 'field', 'to');
  end if;
  v_allowed := case p_to
                 when 'purged' then array['created', 'invited', 'cancelled']
                 else array['created', 'invited']
               end;
  if p_from is null or array_ndims(p_from) is distinct from 1 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'from');
  end if;
  if cardinality(p_from) not between 1 and 3
     or cardinality(array_remove(p_from, null)) <> cardinality(p_from)
     or not (p_from <@ v_allowed) then
    return jsonb_build_object('status', 'invalid_request', 'field', 'from');
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
  if v_booking.source <> 'public_page' then
    return jsonb_build_object('status', 'not_public');
  end if;
  if v_booking.calendar_state <> all(p_from) then
    return jsonb_build_object('status', 'state_conflict', 'current', v_booking.calendar_state);
  end if;

  update screening_v2.r1_meet_bookings
     set calendar_state = p_to,
         invite_sent_at = case when p_to = 'invited' then coalesce(invite_sent_at, p_now)
                               else invite_sent_at end
   where id = v_booking.id;
  return jsonb_build_object('status', 'ok', 'calendar_state', p_to);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §22. r1_meet_public_throttle_hit: one atomic hit on up to eight throttle keys.
-- ---------------------------------------------------------------------------------------------
-- The public routes' rate limit (S06): 1..8 keyed digests (64 lower-case hex, unique) with one
-- limit each (1..100000) and one window (60..86400 s). Bucket = p_now floored to the window (epoch
-- aligned). Each key's row of that bucket gets one more hit (capped at 1000000000) in ONE upsert
-- that takes the rows in ascending key order, so concurrent hits never deadlock. `over` lists the
-- 0-based indexes (ascending) of the keys whose count after this hit exceeds its limit. Writes
-- the throttle table only. Answers ok (+over) | invalid_request (+field: keys, limits, window,
-- now); duplicate keys are invalid (one upsert cannot touch a row twice).
create or replace function screening_v2.r1_meet_public_throttle_hit(
  p_keys text[],
  p_limits integer[],
  p_window_sec integer,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_bucket timestamptz;
  v_over integer[];
begin
  if p_keys is null or array_ndims(p_keys) is distinct from 1 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'keys');
  end if;
  if cardinality(p_keys) not between 1 and 8
     or exists (select 1 from unnest(p_keys) k(key_digest)
                 where k.key_digest is null or k.key_digest !~ '^[a-f0-9]{64}$')
     or (select count(distinct k.key_digest) from unnest(p_keys) k(key_digest)) <> cardinality(p_keys) then
    return jsonb_build_object('status', 'invalid_request', 'field', 'keys');
  end if;
  if p_limits is null or array_ndims(p_limits) is distinct from 1
     or cardinality(p_limits) <> cardinality(p_keys)
     or exists (select 1 from unnest(p_limits) l(hit_limit)
                 where l.hit_limit is null or l.hit_limit not between 1 and 100000) then
    return jsonb_build_object('status', 'invalid_request', 'field', 'limits');
  end if;
  if p_window_sec is null or p_window_sec not between 60 and 86400 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'window');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  v_bucket := to_timestamp((floor(extract(epoch from p_now) / p_window_sec) * p_window_sec)::double precision);
  with hit as (
    insert into screening_v2.r1_meet_public_throttle as t (key_digest, bucket_start, hits)
    select k.key_digest, v_bucket, 1
      from unnest(p_keys) k(key_digest)
     order by k.key_digest
    on conflict (key_digest, bucket_start)
    do update set hits = least(t.hits + 1, 1000000000)
    returning t.key_digest, t.hits
  )
  select coalesce(array_agg((k.ord - 1)::integer order by k.ord), array[]::integer[])
    into v_over
    from hit h
    join unnest(p_keys, p_limits) with ordinality k(key_digest, hit_limit, ord)
      on k.key_digest = h.key_digest
   where h.hits > k.hit_limit;
  return jsonb_build_object('status', 'ok', 'over', to_jsonb(v_over));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §23. r1_meet_public_throttle_prune: the throttle retention.
-- ---------------------------------------------------------------------------------------------
-- From an existing maintenance tick (S05/S06 pick the age): deletes at most p_limit (1..5000) of
-- the throttle rows whose bucket started more than p_older_than_sec (1 hour .. 365 days) before
-- p_now, oldest bucket first; rows another call holds are skipped. Answers ok (+deleted) |
-- invalid_request (+field: older_than, limit, now).
create or replace function screening_v2.r1_meet_public_throttle_prune(
  p_older_than_sec integer,
  p_limit integer,
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
  if p_older_than_sec is null or p_older_than_sec not between 3600 and 31536000 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'older_than');
  end if;
  if p_limit is null or p_limit not between 1 and 5000 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'limit');
  end if;
  if p_now is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  delete from screening_v2.r1_meet_public_throttle
   where (key_digest, bucket_start) in (
     select t.key_digest, t.bucket_start
       from screening_v2.r1_meet_public_throttle t
      where t.bucket_start < p_now - make_interval(secs => p_older_than_sec)
      order by t.bucket_start, t.key_digest
      limit p_limit
      for update skip locked);
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('status', 'ok', 'deleted', v_deleted);
end;
$$;

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

-- The internal helpers (§10-§12): no EXECUTE for any API role, service_role included, and no
-- grant. Only the security definer RPCs of this file call them, as their owner (the
-- r1_refund_uncounted_charge precedent, 0128).
revoke all on function screening_v2.r1_meet_public_slot_count(timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
comment on function screening_v2.r1_meet_public_slot_count(timestamptz, timestamptz, uuid) is
  'M035 internal: the live bookings (both sources) overlapping [start, end), one booking left out '
  'on request. Stable, security invoker, no EXECUTE for any API role.';

revoke all on function screening_v2.r1_meet_public_day_count(date, uuid)
  from public, anon, authenticated, service_role;
comment on function screening_v2.r1_meet_public_day_count(date, uuid) is
  'M035 internal: {total, public} of the bookings starting in one IST day that are live or used a '
  'bot (R1_MEET_CAP_STATUSES x R1_MEET_CAP_REASONS), one booking left out on request. Stable, '
  'security invoker, no EXECUTE for any API role.';

revoke all on function screening_v2.r1_meet_public_refusal(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
comment on function screening_v2.r1_meet_public_refusal(uuid, text, timestamptz) is
  'M035 internal: NULL (eligible) or the first refusal code of a public R1 booking, shared by '
  'r1_meet_public_precheck and r1_meet_create_round_from_public. Stable, security invoker, no '
  'EXECUTE for any API role.';

-- The RPCs: service_role only (S05/S06 call them through the API's service client).
revoke all on function screening_v2.r1_meet_public_capacity(timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_capacity(timestamptz, timestamptz, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_capacity(timestamptz, timestamptz, timestamptz) is
  'M035: read only. For a window of at most 15 days: the live booking intervals (no ids), the '
  'IST-day counts (total, public), the 0131 effective concurrency, whether one more 65-minute '
  'round fits (admits) and the enabled and paused settings. Answers ok | invalid_request '
  '(+field). Service-role only.';

revoke all on function screening_v2.r1_meet_public_precheck(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_precheck(uuid, text, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_precheck(uuid, text, timestamptz) is
  'M035: read only. Whether the candidate may book a public R1 slot: eligible | refused (+code, '
  'the first of the shared refusal predicates) | invalid_request (+field). Service-role only.';

revoke all on function screening_v2.r1_meet_public_set_manage_digest(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_set_manage_digest(uuid, text, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_set_manage_digest(uuid, text, timestamptz) is
  'M035: stores or rotates the manage token digest (HMAC-SHA256 hex, never the token) of a live '
  'public booking. updated_at unchanged. Answers ok | not_found | not_public | booking_terminal | '
  'invalid_request (+field). Service-role only.';

revoke all on function screening_v2.r1_meet_public_manage_read(text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_manage_read(text, integer, integer, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_manage_read(text, integer, integer, timestamptz) is
  'M035: read only. The live public booking of a manage digest before its slot ends: status, '
  'version, has_bot, slot, can_move, can_cancel, moves_left and consent_current. Answers ok | '
  'not_found | invalid_request (+field). Service-role only.';

revoke all on function screening_v2.r1_meet_public_set_calendar_state(uuid, text[], text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_set_calendar_state(uuid, text[], text, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_set_calendar_state(uuid, text[], text, timestamptz) is
  'M035: compare-and-set of a public booking''s calendar event state (created|invited -> invited, '
  'created|invited -> cancelled, created|invited|cancelled -> purged), invite_sent_at on the first '
  'invite. updated_at unchanged. Answers ok (+calendar_state) | state_conflict (+current) | '
  'not_found | not_public | invalid_request (+field). Service-role only.';

revoke all on function screening_v2.r1_meet_public_throttle_hit(text[], integer[], integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_throttle_hit(text[], integer[], integer, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_throttle_hit(text[], integer[], integer, timestamptz) is
  'M035: one atomic hit on 1..8 keyed digests in the window bucket of p_now, rows taken in key '
  'order. Answers ok (+over, the 0-based indexes of the keys over their limit) | invalid_request '
  '(+field). Service-role only.';

revoke all on function screening_v2.r1_meet_public_throttle_prune(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_throttle_prune(integer, integer, timestamptz)
  to service_role;
comment on function screening_v2.r1_meet_public_throttle_prune(integer, integer, timestamptz) is
  'M035: the throttle retention: deletes at most p_limit (1..5000) of the oldest buckets older than '
  'p_older_than_sec (1 hour .. 365 days). Answers ok (+deleted) | invalid_request (+field). '
  'Service-role only.';

notify pgrst, 'reload schema';
