-- DARK. Nothing calls any object below until M035 S06 ships the public R1 booking page behind
-- R1_MEET_PUBLIC_BOOKING_ENABLED (default OFF, on top of R1_MEET_ENABLED). This is the database
-- half of that page's on-the-spot Ashby import (M035 S12, D-M035-8): when a typed email matches
-- no local candidate and Ashby holds exactly one Active application of that person on a job with
-- an enabled mapping, the page imports it as a new application link with intake
-- r1_public_booking plus a shell candidate (name, email and number from the Ashby candidate
-- profile only, never a typed value). Such an import never gets a resume ingestion, the Ashby
-- profile step or a phone screening call, and its intake never changes. Until S06 calls the
-- import RPC no r1_public_booking link exists, so every fence below is a no-op on today's rows.
--
--   §1 chk_ashby_application_links_intake_type learns r1_public_booking (a guarded CHECK swap;
--      the column default stays resume_parsing).
--   §2 trg_ashby_application_links_intake_locked: an update that changes intake_type from or to
--      r1_public_booking is refused, so apply_ashby_candidate_profile (which stamps phone_parsing
--      on any link that reaches its step 9) can never turn an import into a phone screening.
--   §3 BEFORE INSERT guards on phone_engagements and ashby_resume_ingestions: a row whose link is
--      an r1_public_booking import is refused with a closed message (no id, no value).
--   §4 claim_ashby_profile_due never claims an r1_public_booking link (its no-resume arm has no
--      intake filter, so a no-number import on a phone_primary mapping would otherwise be
--      profiled, stamped phone_parsing and called).
--   §5 v_ashby_application_impact leaves r1_public_booking links out of every impact figure.
--   §6 r1_meet_public_local_rows: the public page's read-only local match lookup.
--   §7 r1_meet_public_import_application: the on-the-spot import, link first, then the shell; the
--      only writer of r1_public_booking.
--   §90 privileges (the RPCs are service-role only; no client role may execute a trigger function)
--      and comments.
--
-- Redeclares (lifted in full, ONE marked hunk each): claim_ashby_profile_due (0130 §6),
-- v_ashby_application_impact (0140 §2). References no 0143 object.
--
-- PII-minimal: the fences store nothing and their messages carry no id and no value.
--
-- Additive and re-runnable: a guarded CHECK swap (drop constraint if exists, add not valid,
-- validate; every existing row is resume_parsing or phone_parsing, so it validates), `create or
-- replace` functions, `drop trigger if exists` + `create trigger`. No existing row is changed and
-- no column default moves. Forward-only: while dark the new value is simply never written.
set local lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------------
-- §1. ashby_application_links.intake_type learns r1_public_booking.
-- ---------------------------------------------------------------------------------------------
-- The 0130 inline CHECK is swapped for the same CHECK plus the new value, in three top-level
-- statements (the 0026 idiom). Existing rows hold one of the two 0130 values, so the validation
-- passes; the column default stays resume_parsing.
alter table screening_v2.ashby_application_links drop constraint if exists chk_ashby_application_links_intake_type;
alter table screening_v2.ashby_application_links add constraint chk_ashby_application_links_intake_type check (intake_type in ('resume_parsing', 'phone_parsing', 'r1_public_booking')) not valid;
alter table screening_v2.ashby_application_links validate constraint chk_ashby_application_links_intake_type;

comment on column screening_v2.ashby_application_links.intake_type is
  '0130 (M017, ADR-0018): how this Ashby application is screened. '
  'resume_parsing (the default, and every row the pre-0130 app inserts) is '
  'the resume pipeline. phone_parsing means no usable resume is attached '
  '(none at all, or one whose ingestion rests in failed_review on a '
  'document verdict): the name, '
  'email and number come from the Ashby candidate record, and admit and '
  'ensure skip only the resume/ingestion gate. Written only by '
  'apply_ashby_candidate_profile, and never flipped back.'
  ' 0144 (M035 S12): r1_public_booking means the public R1 booking page imported this '
  'application on the spot (r1_meet_public_import_application, the only writer); it never '
  'gets a resume ingestion, a phone engagement or the Ashby profile step, and the value never '
  'changes.';

-- ---------------------------------------------------------------------------------------------
-- §2. The intake of a public booking import never changes.
-- ---------------------------------------------------------------------------------------------
-- apply_ashby_candidate_profile (0130 §5) stamps phone_parsing on any link that reaches its step 9,
-- and a link stamped that way would pass the §3 engagement guard. So an update that changes
-- intake_type FROM r1_public_booking, or TO it (only the §7 insert writes it), is refused. The
-- WHEN clause names the value, so no update of any other link reaches the function, and a no-op
-- write of the same value is never refused.
create or replace function screening_v2.reject_r1_public_booking_intake_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
begin
  raise exception 'r1_public_booking: the intake type of a public booking import never changes'
    using errcode = 'P0001';
  return new;
end;
$$;

drop trigger if exists trg_ashby_application_links_intake_locked on screening_v2.ashby_application_links;
create trigger trg_ashby_application_links_intake_locked
  before update of intake_type on screening_v2.ashby_application_links
  for each row
  when (old.intake_type is distinct from new.intake_type
        and (old.intake_type = 'r1_public_booking' or new.intake_type = 'r1_public_booking'))
  execute function screening_v2.reject_r1_public_booking_intake_change();

-- ---------------------------------------------------------------------------------------------
-- §3. A public booking import never gets a phone engagement or a resume ingestion.
-- ---------------------------------------------------------------------------------------------
-- BEFORE INSERT on both tables: a new row whose link is an r1_public_booking import is refused
-- (P0001, a closed message with no id and no value). INSERT only: an engagement or an ingestion
-- never changes its link. Both application_link_id columns are NOT NULL (0042, 0029). SECURITY
-- DEFINER so the link lookup is not hidden from the writer by row level security.
create or replace function screening_v2.reject_r1_public_booking_engagement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
begin
  if exists (select 1 from screening_v2.ashby_application_links l
              where l.id = new.application_link_id and l.intake_type = 'r1_public_booking') then
    raise exception 'r1_public_booking: a public booking import never gets a phone engagement'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_phone_engagements_r1_public_booking on screening_v2.phone_engagements;
create trigger trg_phone_engagements_r1_public_booking
  before insert on screening_v2.phone_engagements
  for each row execute function screening_v2.reject_r1_public_booking_engagement();

create or replace function screening_v2.reject_r1_public_booking_ingestion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
begin
  if exists (select 1 from screening_v2.ashby_application_links l
              where l.id = new.application_link_id and l.intake_type = 'r1_public_booking') then
    raise exception 'r1_public_booking: a public booking import never gets a resume ingestion'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ashby_resume_ingestions_r1_public_booking on screening_v2.ashby_resume_ingestions;
create trigger trg_ashby_resume_ingestions_r1_public_booking
  before insert on screening_v2.ashby_resume_ingestions
  for each row execute function screening_v2.reject_r1_public_booking_ingestion();

-- ---------------------------------------------------------------------------------------------
-- §4. claim_ashby_profile_due never claims a public booking import.
-- ---------------------------------------------------------------------------------------------
-- Lifted in full from 0130 §6 (its newest declaration) by script, byte-identical except ONE
-- marked hunk (M035-S12-a). The no-resume arm has no intake filter, so without the hunk a
-- no-number import on a phone_primary mapping would be claimed, apply_ashby_candidate_profile
-- would stamp it phone_parsing and the phone lane would call the person. intake_type is NOT NULL,
-- so `<>` is null-safe. Signature, language, volatility, security, search_path and grants are
-- unchanged.
create or replace function screening_v2.claim_ashby_profile_due(
  p_limit           integer,
  p_min_age_seconds integer,
  p_retry_seconds   integer,
  p_max_attempts    integer,
  p_now             timestamptz
)
returns table (application_link_id uuid)
language sql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
  with due as (
    select l.id
      from screening_v2.ashby_application_links l
      join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id
           and m.status = 'enabled' and m.screening_mode = 'phone_primary'
      join screening_v2.candidates c on c.id = l.candidate_id
     where l.provider = 'ashby' and l.terminal_state is null
       and l.lifecycle not in ('completed', 'cancelled')
       -- ▼ 0144 M035-S12-a a public booking import is never profiled
       and l.intake_type <> 'r1_public_booking'
       -- ▲ 0144 M035-S12-a a public booking import is never profiled
       and not coalesce(c.phone_valid, false) and c.ashby_phone_applied_at is null
       and l.profile_attempts < p_max_attempts
       and (l.profile_checked_at is null
            or l.profile_checked_at <= p_now - make_interval(
                 secs => p_retry_seconds * power(2, greatest(l.profile_attempts - 1, 0))))
       and not exists (select 1 from screening_v2.data_subject_requests d
                        where d.candidate_id = c.id
                          and d.request_type in ('correct', 'restrict', 'delete')
                          and d.request_status in ('pending', 'in_progress', 'fulfilled'))
       and (
         (l.intake_type = 'resume_parsing' and l.external_resume_file_handle is not null
          and exists (select 1 from screening_v2.ashby_resume_ingestions i
                       where i.application_link_id = l.id and i.state = 'ready')
          and exists (select 1 from screening_v2.phone_engagements e
                       where e.application_link_id = l.id
                         and e.terminal_at is null and e.state = 'pending_prereqs'
                         and e.state_reason = 'phone_invalid'
                         and e.updated_at <= p_now - make_interval(secs => p_min_age_seconds)))
         or
         (l.external_resume_file_handle is null
          and l.created_at <= p_now - make_interval(secs => p_min_age_seconds)
          and not exists (select 1 from screening_v2.phone_engagements e
                           where e.application_link_id = l.id
                             and (e.terminal_at is not null or e.state <> 'pending_prereqs')))
         or
         (l.intake_type in ('resume_parsing', 'phone_parsing')
          and l.external_resume_file_handle is not null
          and exists (select 1 from screening_v2.ashby_resume_ingestions i
                       where i.application_link_id = l.id and i.state = 'failed_review'
                         and (i.failed_reason in ('scan_infected', 'parse_extract_failed',
                                                  'parse_no_output', 'parse_output_exceeded',
                                                  'no_extractable_fields')
                              or left(i.failed_reason, 6) = 'guard_')
                         and i.updated_at <= p_now - make_interval(secs => p_min_age_seconds))
          and not exists (select 1 from screening_v2.phone_engagements e
                           where e.application_link_id = l.id
                             and (e.terminal_at is not null or e.state <> 'pending_prereqs')))
       )
     order by l.profile_checked_at nulls first, l.created_at
     limit least(greatest(p_limit, 1), 50)
     for update of l skip locked
  )
  update screening_v2.ashby_application_links l
     set profile_checked_at = p_now, profile_attempts = l.profile_attempts + 1
    from due
   where l.id = due.id
  returning l.id;
$$;

revoke all on function screening_v2.claim_ashby_profile_due(integer, integer, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_profile_due(integer, integer, integer, integer, timestamptz)
  to service_role;

comment on function screening_v2.claim_ashby_profile_due is
  '0130 (M017, ADR-0018): claims up to 50 Ashby application links due for '
  'the profile step (FOR UPDATE SKIP LOCKED), stamping profile_checked_at '
  'and incrementing profile_attempts. Due: a live link on an enabled '
  'phone_primary mapping, a candidate with no valid and no applied Ashby '
  'number, no DSAR hold, under p_max_attempts claims with exponential '
  'backoff from p_retry_seconds; and either a ready resume link whose '
  'engagement has waited on phone_invalid for p_min_age_seconds (D3), a '
  'link with no resume handle at least p_min_age_seconds old, or (B3) a '
  'link with a handle whose ingestion has rested in failed_review on a '
  'document verdict (never a machine-class reason) for '
  'p_min_age_seconds, in both cases with no engagement or only a live '
  'pending_prereqs one. Returns link ids only. Service-role-only.'
  ' 0144 (M035 S12): never claims an r1_public_booking link.';

-- ---------------------------------------------------------------------------------------------
-- §5. v_ashby_application_impact leaves public booking imports out.
-- ---------------------------------------------------------------------------------------------
-- Filled by the next part of M035 S12 (lifted from 0140 section 2 with one marked hunk).

-- ---------------------------------------------------------------------------------------------
-- §6. r1_meet_public_local_rows: the public page's local match lookup.
-- ---------------------------------------------------------------------------------------------
-- Filled by the next part of M035 S12 (read-only, service-role only).

-- ---------------------------------------------------------------------------------------------
-- §7. r1_meet_public_import_application: the on-the-spot import.
-- ---------------------------------------------------------------------------------------------
-- Filled by the next part of M035 S12 (service-role only; the only writer of r1_public_booking).

-- ---------------------------------------------------------------------------------------------
-- §90. Privileges and comments.
-- ---------------------------------------------------------------------------------------------
-- The trigger functions are never called directly: no client role may execute them (a trigger
-- fires without an EXECUTE check).
revoke all on function screening_v2.reject_r1_public_booking_intake_change()
  from public, anon, authenticated;
revoke all on function screening_v2.reject_r1_public_booking_engagement()
  from public, anon, authenticated;
revoke all on function screening_v2.reject_r1_public_booking_ingestion()
  from public, anon, authenticated;

comment on function screening_v2.reject_r1_public_booking_intake_change() is
  '0144 (M035 S12): trigger function of trg_ashby_application_links_intake_locked. Refuses '
  '(P0001) an update that changes intake_type from or to r1_public_booking: a public booking '
  'import is never turned into a resume or phone screening, and no other writer may make one.';
comment on function screening_v2.reject_r1_public_booking_engagement() is
  '0144 (M035 S12): trigger function of trg_phone_engagements_r1_public_booking. Refuses (P0001, '
  'a closed message) a phone_engagements insert whose application link has intake '
  'r1_public_booking: a public booking import never gets a phone screening call.';
comment on function screening_v2.reject_r1_public_booking_ingestion() is
  '0144 (M035 S12): trigger function of trg_ashby_resume_ingestions_r1_public_booking. Refuses '
  '(P0001, a closed message) an ashby_resume_ingestions insert whose application link has intake '
  'r1_public_booking: a public booking import never gets a resume ingestion.';

notify pgrst, 'reload schema';
