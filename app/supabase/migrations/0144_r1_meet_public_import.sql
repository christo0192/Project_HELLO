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
--      only writer of r1_public_booking. A person who has done R1 is never imported.
--   §8 v_funnel_candidate leaves a candidate the public booking page imported out of the Christy
--      phone funnel (and so out of the funnel_stage_daily rollup).
--   §9 r1_meet_public_person_r1_check: the public page's book-path lookup, one R1 per Ashby person.
--   §90 privileges (the RPCs are service-role only; no client role may execute a trigger function)
--      and comments.
--
-- Redeclares (lifted in full, ONE marked hunk each): claim_ashby_profile_due (0130 §6),
-- v_ashby_application_impact (0140 §2), v_funnel_candidate (0122 §8). References no 0143 object.
--
-- PII-minimal: the fences store nothing and their messages carry no id and no value.
--
-- Additive and re-runnable: a guarded CHECK swap (drop constraint if exists, add not valid,
-- validate; every existing row is resume_parsing or phone_parsing, so it validates), `create or
-- replace` functions and views (each view's columns are unchanged), `drop trigger if exists` +
-- `create trigger`. No existing row is changed and no column default moves. Forward-only: while
-- dark the new value is simply never written.
--
-- Lock order. §1 takes ACCESS EXCLUSIVE on ashby_application_links and holds it to commit (inside
-- one transaction the NOT VALID + VALIDATE split of the 0026 idiom saves no lock time; it only
-- keeps the swap in three plain statements). §2 adds a trigger on the same table, then §3 takes
-- SHARE ROW EXCLUSIVE on phone_engagements and on ashby_resume_ingestions. Links before
-- engagements is the phone lane's own order (0114: the link row, then the engagement row), so a
-- phone write that holds a link row makes this migration wait (lock_timeout 10 s, then it fails
-- whole and is re-run) instead of deadlocking with it. Merge and apply in the 07:00-08:30 IST
-- window, when the phone lane is idle.
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
-- Lifted in full from 0140 §2 (its only declaration) by script, byte-identical except ONE marked
-- hunk (M035-S12-b) in the lk CTE. Without it an on-the-spot import would count as an imported
-- application of its mapped job with no Christy step, and its import-time stage would be read
-- as the Christy stage. The output columns are unchanged, so `create or replace view` keeps
-- every dependent function valid. The 0140 grants follow verbatim, and the 0140 comment with
-- one sentence more.
create or replace view screening_v2.v_ashby_application_impact
  with (security_invoker = true) as
with
mrank (milestone, milestone_rank) as (
  values ('christy', 0), ('r1', 1), ('r2', 2), ('r3', 3), ('r4', 4), ('r5', 5),
         ('reference', 6), ('offer', 7), ('hired', 8)
),
cat as (
  select c.stage_id, c.interview_plan_id, c.title, c.stage_type, c.order_in_plan, c.milestone,
         mr.milestone_rank,
         (coalesce(c.stage_type, '') in ('Archived', 'Lead') or c.milestone is not distinct from 'archived') as never_reached
    from screening_v2.ashby_stage_catalog c
    left join mrank mr on mr.milestone = c.milestone
),
lk as (
  select l.id as application_link_id, l.job_mapping_id, l.candidate_id, l.session_id as link_session_id,
         l.external_job_id, l.created_at as imported_at,
         coalesce(l.external_stage_id, m.ai_screening_stage_id) as christy_stage_id,
         m.screening_mode,
         not coalesce(x.excluded, m.archived_at is not null) as in_impact
    from screening_v2.ashby_application_links l
    join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id
    left join screening_v2.ashby_impact_exclusions x on x.job_mapping_id = m.id
   where l.provider = 'ashby'
     and not exists (
       select 1 from screening_v2.ashby_erased_application_links e
        where e.application_link_id = l.id)
     and l.terminal_reason is distinct from 'subject_erasure'
     -- ▼ 0144 M035-S12-b a public booking import is not an application Christy screens
     and l.intake_type <> 'r1_public_booking'
     -- ▲ 0144 M035-S12-b a public booking import is not an application Christy screens
     and not exists (
       select 1 from screening_v2.data_subject_requests d
        where d.candidate_id = l.candidate_id
          and d.request_type in ('restrict', 'delete')
          and d.request_status in ('pending', 'in_progress', 'fulfilled'))
),
-- Every history row Ashby still returns, with its stage's catalogue facts.
iv as (
  select i.application_link_id, i.stage_id, i.entered_at, i.left_at,
         coalesce(c.title, i.stage_title_seen) as title,
         c.interview_plan_id, c.order_in_plan, c.milestone, c.milestone_rank, c.stage_type,
         coalesce(c.never_reached, false) as never_reached,
         (i.stage_id = lk.christy_stage_id or c.milestone is not distinct from 'christy') as is_christy,
         cp.interview_plan_id as christy_plan_id, cp.order_in_plan as christy_order,
         lk.imported_at
    from screening_v2.ashby_application_stage_intervals i
    join lk on lk.application_link_id = i.application_link_id
    left join cat c on c.stage_id = i.stage_id
    left join cat cp on cp.stage_id = lk.christy_stage_id
   where i.gone_at is null
),
centry as (
  select application_link_id, min(entered_at) as christy_entered_at
    from iv
   where is_christy and entered_at is not null
   group by application_link_id
),
-- What each row counts as, and only from the time the application came in.
ivf as (
  select iv.application_link_id, iv.entered_at, iv.left_at, iv.is_christy,
         ce.christy_entered_at,
         coalesce(ce.christy_entered_at, iv.imported_at) as anchor_at,
         (not iv.never_reached and not iv.is_christy
          and (coalesce(iv.milestone_rank, 0) >= 1
               or (iv.interview_plan_id = iv.christy_plan_id and iv.order_in_plan > iv.christy_order))) is true as fwd,
         (not iv.never_reached and coalesce(iv.milestone_rank, 0) >= 1) as r1,
         (not iv.never_reached and coalesce(iv.milestone_rank, 0) >= 2) as r2,
         (not iv.never_reached and coalesce(iv.milestone_rank, 0) >= 7) as offer,
         (not iv.never_reached and coalesce(iv.milestone_rank, 0) >= 8) as hired
    from iv
    left join centry ce on ce.application_link_id = iv.application_link_id
),
reach as (
  select application_link_id,
         min(christy_entered_at) as christy_entered_at,
         min(left_at) filter (where is_christy) as christy_left_at,
         bool_or(fwd) as fwd,     min(entered_at) filter (where fwd) as fwd_at,
         bool_or(r1) as r1,       min(entered_at) filter (where r1) as r1_at,
         bool_or(r2) as r2,       min(entered_at) filter (where r2) as r2_at,
         bool_or(offer) as offer, min(entered_at) filter (where offer) as offer_at,
         bool_or(hired) as hired, min(entered_at) filter (where hired) as hired_at,
         max(entered_at) filter (where entered_at > anchor_at) as last_move_at
    from ivf
   where entered_at is null or entered_at >= anchor_at
   group by application_link_id
),
newest as (
  select distinct on (application_link_id) application_link_id, stage_id, title
    from iv
   order by application_link_id, entered_at desc nulls last, stage_id
),
-- The last stage an application stood in that is not an Archived one.
leave as (
  select distinct on (application_link_id) application_link_id, stage_id, title
    from iv
   where coalesce(stage_type, '') <> 'Archived' and milestone is distinct from 'archived'
   order by application_link_id, entered_at desc nulls last, stage_id
),
att as (
  select e.application_link_id, min(a.admitted_at) as first_call_at, min(a.answered_at) as first_answer_at
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
   group by e.application_link_id
),
pcons as (
  select e.application_link_id, min(pl.created_at) as consent_at
    from screening_v2.phone_engagements e
    join screening_v2.phone_session_plans pl on pl.engagement_id = e.id
   group by e.application_link_id
),
bsess as (
  select lk.application_link_id,
         case when s.waiting_at is not null or s.status in ('in_progress', 'completed')
              then coalesce(s.waiting_at, s.started_at) end as joined_at
    from lk
    join screening_v2.call_sessions s on s.id = lk.link_session_id
   where lk.screening_mode = 'browser_primary' and s.interview_round_id is null
),
-- Browser consent is bound to the session it was given for (the candidate
-- portal stores proof.session_id), so another application's consent never
-- counts here.
bcons as (
  select lk.application_link_id, min(cr.created_at) as consent_at
    from lk
    join screening_v2.consent_records cr
      on cr.candidate_id = lk.candidate_id
     and cr.proof ->> 'session_id' = lk.link_session_id::text
   where lk.screening_mode = 'browser_primary'
     and cr.status = 'granted'
     and 'ai_interview'::screening_v2.consent_type = any (cr.consents)
   group by lk.application_link_id
),
-- THIS application's sessions: the link's own and every engagement's (one per
-- re-screen cycle). Never another application of the same person.
sess as (
  select lk.application_link_id, lk.link_session_id as session_id
    from lk where lk.link_session_id is not null
  union
  select e.application_link_id, e.session_id
    from screening_v2.phone_engagements e
    join lk on lk.application_link_id = e.application_link_id
   where e.session_id is not null
),
asmt as (
  select distinct on (s.application_link_id)
         s.application_link_id, a.recommendation, a.scoring_status, a.evidence_grade, a.overall_score, a.created_at
    from sess s
    join screening_v2.assessments a on a.session_id = s.session_id
   where not exists (
     select 1 from screening_v2.call_sessions rs
      where rs.id = a.session_id and rs.interview_round_id is not null)
   order by s.application_link_id, a.created_at desc, a.id desc
),
base as (
  select lk.application_link_id, lk.job_mapping_id, lk.candidate_id, lk.in_impact, lk.external_job_id,
         lk.screening_mode, lk.christy_stage_id, lk.imported_at,
         -- The block flag only: no other candidate column is read here.
         (cand.decision_use_blocked_at is not null) as decision_blocked,
         r.christy_entered_at, r.christy_left_at,
         coalesce(r.fwd, false) as h_fwd, r.fwd_at,
         coalesce(r.r1, false) as h_r1, r.r1_at,
         coalesce(r.r2, false) as h_r2, r.r2_at,
         coalesce(r.offer, false) as h_offer, r.offer_at,
         coalesce(r.hired, false) as h_hired, r.hired_at,
         r.last_move_at as history_last_move_at,
         case when lk.screening_mode = 'browser_primary' then b.joined_at else att.first_call_at end as called_at,
         case when lk.screening_mode = 'browser_primary' then b.joined_at else att.first_answer_at end as answered_at,
         case when lk.screening_mode = 'browser_primary'
              then case when b.joined_at is not null and bc.consent_at is not null
                        then greatest(b.joined_at, bc.consent_at) end
              else pc.consent_at end as connected_at,
         a.application_link_id is not null as has_assessment,
         a.recommendation, a.scoring_status, a.evidence_grade, a.overall_score, a.created_at as assessed_at,
         p.last_checked_at, p.next_check_at, p.check_error_code, p.status, p.current_job_id,
         p.archive_reason_id, p.archive_reason_type, p.archived_at,
         coalesce(p.current_stage_id, nw.stage_id) as current_stage_id,
         case when p.current_stage_id is null or p.current_stage_id = nw.stage_id then nw.title end as newest_title,
         coalesce(lv.stage_id, p.current_stage_id) as leave_candidate_id,
         lv.title as leave_title_seen
    from lk
    left join screening_v2.candidates cand on cand.id = lk.candidate_id
    left join reach r   on r.application_link_id = lk.application_link_id
    left join att       on att.application_link_id = lk.application_link_id
    left join pcons pc  on pc.application_link_id = lk.application_link_id
    left join bsess b   on b.application_link_id = lk.application_link_id
    left join bcons bc  on bc.application_link_id = lk.application_link_id
    left join asmt a    on a.application_link_id = lk.application_link_id
    left join screening_v2.ashby_application_progress p on p.application_link_id = lk.application_link_id
    left join newest nw on nw.application_link_id = lk.application_link_id
    left join leave lv  on lv.application_link_id = lk.application_link_id
),
facts as (
  select base.*,
         coalesce(base.christy_entered_at, base.imported_at) as came_in_at,
         base.last_checked_at is not null as ashby_known,
         coalesce(base.status, 'Active') not in ('Archived', 'Hired')
           and (base.current_stage_id is null or base.current_stage_id = base.christy_stage_id
                or cc.milestone is not distinct from 'christy') as in_christy_now,
         cc.title as current_title_cat, cc.milestone as current_milestone,
         case when coalesce(lc.stage_type, '') = 'Archived' or lc.milestone is not distinct from 'archived'
              then null else base.leave_candidate_id end as leave_stage_id,
         lc.title as leave_title_cat, lc.milestone as leave_milestone, lc.order_in_plan as leave_order,
         coalesce(base.archive_reason_type, ar.reason_type) as reason_type,
         ar.text as archive_reason_text
    from base
    left join cat cc on cc.stage_id = base.current_stage_id
    left join cat lc on lc.stage_id = base.leave_candidate_id
    left join screening_v2.ashby_archive_reasons ar on ar.reason_id = base.archive_reason_id
)
select
  f.application_link_id,
  f.job_mapping_id,
  f.candidate_id,
  f.in_impact,
  f.screening_mode,
  f.christy_stage_id,
  -- Came in: the first Christy entry Ashby recorded, else the import time.
  f.came_in_at,
  (f.christy_entered_at is not null) as came_in_from_history,
  (f.came_in_at at time zone 'Asia/Kolkata')::date as cohort_day,
  -- Christy's steps on this application.
  (f.called_at is not null) as called,
  f.called_at,
  (f.answered_at is not null) as answered,
  f.answered_at,
  (f.connected_at is not null) as connected,
  f.connected_at,
  f.has_assessment,
  case
    when not f.has_assessment then 'none'
    when f.evidence_grade = 'insufficient' then 'held'
    when f.recommendation = 'advance' then 'select'
    when f.recommendation = 'hold' then 'borderline'
    when f.recommendation = 'reject' then 'reject'
    else 'none'
  end as verdict,
  (f.has_assessment and f.scoring_status = 'incomplete_evidence'
   and f.recommendation in ('advance', 'hold', 'reject')
   and f.evidence_grade is distinct from 'insufficient') as provisional,
  f.assessed_at as verdict_at,
  f.overall_score as score,
  -- An appeal blocks decision use: the verdict is suppressed everywhere it could be read.
  f.decision_blocked,
  -- Ashby: known only once the progress worker has read the application.
  f.ashby_known,
  f.last_checked_at,
  f.next_check_at,
  f.check_error_code,
  case when f.ashby_known then f.status end as status,
  case when f.ashby_known then f.current_stage_id end as current_stage_id,
  case when f.ashby_known then coalesce(f.current_title_cat, f.newest_title) end as current_stage_title,
  case when f.ashby_known then f.current_milestone end as current_milestone,
  (f.ashby_known and f.in_christy_now) as still_christy,
  (f.ashby_known and (f.h_fwd or f.status is not distinct from 'Hired')) as moved_forward,
  case when f.ashby_known then f.fwd_at end as moved_forward_at,
  (f.ashby_known and (f.h_r1 or f.status is not distinct from 'Hired')) as reached_r1,
  case when f.ashby_known then f.r1_at end as r1_at,
  (f.ashby_known and (f.h_r2 or f.status is not distinct from 'Hired')) as reached_r2,
  case when f.ashby_known then f.r2_at end as r2_at,
  (f.ashby_known and (f.h_offer or f.status is not distinct from 'Hired')) as reached_offer,
  case when f.ashby_known then f.offer_at end as offer_at,
  (f.ashby_known and (f.h_hired or f.status is not distinct from 'Hired')) as reached_hired,
  case when f.ashby_known then f.hired_at end as hired_at,
  (f.ashby_known and (f.h_fwd or f.status is not distinct from 'Hired' or not f.in_christy_now)) as decided,
  case when f.ashby_known then
    least(f.christy_left_at, f.fwd_at, case when f.status = 'Archived' then f.archived_at end) end as decided_at,
  (f.ashby_known and f.status is not distinct from 'Archived') as archived,
  case when f.ashby_known and f.status = 'Archived' then f.archived_at end as archived_at,
  case when f.ashby_known and f.status = 'Archived' then f.leave_stage_id end as leave_stage_id,
  case when f.ashby_known and f.status = 'Archived' and f.leave_stage_id is not null
       then coalesce(f.leave_title_cat, f.leave_title_seen) end as leave_stage_title,
  case when f.ashby_known and f.status = 'Archived' and f.leave_stage_id is not null then f.leave_milestone end as leave_milestone,
  case when f.ashby_known and f.status = 'Archived' and f.leave_stage_id is not null then f.leave_order end as leave_order,
  (f.ashby_known and f.status is not distinct from 'Archived' and f.leave_stage_id is not null
   and (f.leave_stage_id = f.christy_stage_id or f.leave_milestone is not distinct from 'christy')) as archived_christy,
  case when f.ashby_known and f.status = 'Archived' then
    case
      when f.reason_type = 'RejectedByOrg' then 'rejected_by_org'
      when f.reason_type = 'RejectedByCandidate' then 'rejected_by_candidate'
      when f.reason_type is null then 'none'
      else 'other'
    end end as archive_reason_type,
  case when f.ashby_known and f.status = 'Archived' then f.archive_reason_text end as archive_reason_text,
  case when f.ashby_known then
    greatest(f.history_last_move_at, case when f.status = 'Archived' then f.archived_at end) end as last_move_at,
  (f.ashby_known and f.current_job_id is not null and f.external_job_id is not null
   and f.current_job_id <> f.external_job_id) as transferred_out
from facts f;

comment on view screening_v2.v_ashby_application_impact is
  'One row per imported Ashby application on a mapping (M031), erased or '
  'restricted subjects left out (the erasure list, a link an erasure '
  'terminated, a restriction or erasure request): when it came in (first Christy-stage entry '
  'in Ashby history, else the import time; cohort = IST date), Christy''s '
  'called/answered/connected on THIS application (phone engagements, or the '
  'browser session and its consent for a browser_primary mapping), the '
  'verdict of the newest non-R1 assessment on its own sessions, and, once '
  'the progress worker has read it, its Ashby status, stage, milestones '
  'reached (Archived/Lead types never count) and where it left. Raw facts; '
  'impact_application_rows nests them. Ids, codes, flags, times and stage '
  'titles only. Service-role only.'
  ' 0144 (M035 S12): r1_public_booking links (on-the-spot imports by the public R1 booking page) are left out.';

revoke all on screening_v2.v_ashby_application_impact from anon, authenticated, public;
grant select on screening_v2.v_ashby_application_impact to service_role;

-- ---------------------------------------------------------------------------------------------
-- §6. r1_meet_public_local_rows: the public page's local match lookup.
-- ---------------------------------------------------------------------------------------------
-- Read-only (M035 S04 fix round, contracts 9 item 1). The public page's match store
-- (lib/r1/meet/public/match-store.ts) sends the NORMALISED typed email and phone in the POST body
-- of this one call: the only RPC that takes them. It stores, queues and logs nothing, never
-- returns them, and never raises: a bad input answers invalid_request with no field and no value.
--
--   * Email side: candidates whose lower(btrim(email)) is p_email (idx_v2_candidates_email_norm,
--     0114), at most p_limit, by id. Phone side: phone_e164 = p_phone (idx_v2_candidates_phone,
--     0001), at most p_limit, by id. matched_by is email, phone or both (a full join on the id).
--   * Per candidate: decision_blocked (decision_use_blocked_at is set) and dsar_hold (the 0130
--     hold: a correct, restrict or delete request that is pending, in progress or fulfilled).
--   * Per Ashby link of the candidate: application_id, ashby_candidate_id, link_terminal
--     (terminal_state is set) and mapping_enabled (its mapping is enabled and not archived; no
--     mapping is false). A candidate with no link is ONE fail-closed row: both ids null,
--     link_terminal true, mapping_enabled false.
--   * Rows by candidate id, then application id in the "C" collation (so the cut-off at p_limit
--     is the store's code-unit order), the no-link row last; at most p_limit rows.
-- Answers {status:'ok', rows:[...]} with exactly the eight keys per row (booleans as JSON
-- booleans), or {status:'invalid_request'}. Ids and flags only. No write, no clock.
create or replace function screening_v2.r1_meet_public_local_rows(
  p_email text,
  p_phone text,
  p_limit integer default 21
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_rows jsonb;
begin
  -- 1. Validation: a closed answer, no field and no value.
  if (p_email is null and p_phone is null)
     or p_limit is null or p_limit not between 1 and 21
     or (p_email is not null
         and (p_email <> lower(btrim(p_email))
              or char_length(p_email) not between 3 and 254
              or p_email !~ '^[^@]+@[^@]+$'))
     or (p_phone is not null and p_phone !~ '^\+91[6-9][0-9]{9}$') then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  -- 2. Each side by its index (a null input matches nothing), then the holds and the links.
  with by_email as (
    select c.id
      from screening_v2.candidates c
     where c.email is not null and lower(btrim(c.email)) = p_email
     order by c.id
     limit p_limit
  ),
  by_phone as (
    select c.id
      from screening_v2.candidates c
     where c.phone_e164 = p_phone
     order by c.id
     limit p_limit
  ),
  matched as (
    select coalesce(e.id, ph.id) as candidate_id,
           case when e.id is not null and ph.id is not null then 'both'
                when e.id is not null then 'email'
                else 'phone' end as matched_by
      from by_email e
      full join by_phone ph on ph.id = e.id
  ),
  people as (
    select x.candidate_id, x.matched_by,
           exists (select 1 from screening_v2.data_subject_requests d
                    where d.candidate_id = x.candidate_id
                      and d.request_type in ('correct', 'restrict', 'delete')
                      and d.request_status in ('pending', 'in_progress', 'fulfilled')) as dsar_hold,
           c.decision_use_blocked_at is not null as decision_blocked
      from matched x
      join screening_v2.candidates c on c.id = x.candidate_id
  ),
  picked as (
    select p.candidate_id, p.matched_by,
           l.external_application_id as application_id,
           l.external_candidate_id as ashby_candidate_id,
           (l.id is null or l.terminal_state is not null) as link_terminal,
           coalesce(m.status = 'enabled' and m.archived_at is null, false) as mapping_enabled,
           p.dsar_hold, p.decision_blocked
      from people p
      left join screening_v2.ashby_application_links l
             on l.candidate_id = p.candidate_id and l.provider = 'ashby'
      left join screening_v2.ashby_job_mappings m on m.id = l.job_mapping_id
     order by p.candidate_id, l.external_application_id collate "C" nulls last
     limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'candidate_id', r.candidate_id::text,
           'matched_by', r.matched_by,
           'application_id', r.application_id,
           'ashby_candidate_id', r.ashby_candidate_id,
           'link_terminal', r.link_terminal,
           'mapping_enabled', r.mapping_enabled,
           'dsar_hold', r.dsar_hold,
           'decision_blocked', r.decision_blocked)
         order by r.candidate_id, r.application_id collate "C" nulls last), '[]'::jsonb)
    into v_rows
    from picked r;

  return jsonb_build_object('status', 'ok', 'rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §7. r1_meet_public_import_application: the on-the-spot import.
-- ---------------------------------------------------------------------------------------------
-- The only writer of r1_public_booking (contracts 4.2 and 9). Every argument comes from the two
-- Ashby reads of the public page's import (application.info, candidate.info), never from a typed
-- form value. Ashby ids are stored verbatim; only comparisons ignore case. Order:
--   1. validation, nothing read or written: invalid_request with a closed field (application_id,
--      ashby_candidate_id, job_id, stage_id, name, email, phone, now); the first failing wins;
--   2. the application's advisory lock, before any read;
--   3. holds over the Ashby person (every link of the same Ashby candidate id, case ignored, or of
--      this application): dsar_hold when one of them was erased (terminal_reason
--      subject_erasure, or listed in ashby_erased_application_links) or its candidate has the 0130
--      DSAR hold; then candidate_ineligible when one of their candidates is decision-blocked. Fail
--      closed: an erased or held person is never re-collected because someone typed an email;
--   4. an existing link of this application is adopted UNCHANGED, whatever its intake:
--      application_terminal (terminal_state is set), link_unbound (it has no candidate yet: an
--      import is mid-flight), else exists with its candidate and link ids (the page's book path
--      then asks §9 and the 0143 precheck about that candidate);
--   5. one R1 per Ashby PERSON (the owner's "no R1 yet"; S12 fix round F3): candidate_ineligible
--      when a local candidate linked to the same Ashby candidate id (case ignored) has a sales_r1
--      round, of any channel, that is completed or holds a counted attempt (0143 §12's
--      predicate). A new shell would have no round of its own, so without this a person who took
--      R1 under one application could book a second one through another;
--   6. the job's enabled, non-archived mapping (at most one live mapping per job, 0109), read FOR
--      SHARE; none: mapping_unavailable;
--   7. the writes, LINK FIRST: the link (intake r1_public_booking, no candidate yet) with ON
--      CONFLICT DO NOTHING, so a concurrent import of the same application never makes or deletes
--      a shell (the Ashby import's insert waits on the unique index and then fails); a lost race
--      answers from the re-read as in 4, having written nothing. Then the shell (the columns of
--      the Ashby import's shell plus the Ashby name, email and number; phone_valid false, so it is
--      never dialable; ashby_phone_applied_at = p_now only when a number is written), then the
--      link is bound to it.
-- No resume ingestion, phone engagement, operation, queue, session, invite or consent row is
-- written (the §3 guards refuse the first two in any case). Time only from p_now.
-- Answers {status:'imported'|'exists', candidate_id, application_link_id} |
-- {status:'refused', code: dsar_hold | candidate_ineligible | application_terminal |
-- link_unbound | mapping_unavailable} | {status:'invalid_request', field}. Ids only: never a
-- name, an email or a number.
create or replace function screening_v2.r1_meet_public_import_application(
  p_ashby_application_id text,
  p_ashby_candidate_id text,
  p_ashby_job_id text,
  p_ashby_stage_id text,
  p_name text,
  p_email text,
  p_phone_e164 text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_link_id uuid;
  v_link_candidate uuid;
  v_link_terminal text;
  v_mapping_id uuid;
  v_role_id uuid;
  v_owner_id uuid;
  v_candidate_id uuid;
begin
  -- 1. Validation. Nothing is read or written.
  if p_ashby_application_id is null or p_ashby_application_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'application_id');
  end if;
  if p_ashby_candidate_id is null or p_ashby_candidate_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'ashby_candidate_id');
  end if;
  if p_ashby_job_id is null or char_length(p_ashby_job_id) not between 1 and 256 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'job_id');
  end if;
  if p_ashby_stage_id is not null and char_length(p_ashby_stage_id) not between 1 and 256 then
    return jsonb_build_object('status', 'invalid_request', 'field', 'stage_id');
  end if;
  if p_name is not null
     and (char_length(p_name) not between 1 and 200 or btrim(p_name) = '' or p_name ~ '[[:cntrl:]]') then
    return jsonb_build_object('status', 'invalid_request', 'field', 'name');
  end if;
  if p_email is not null
     and (char_length(p_email) > 254 or p_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$') then
    return jsonb_build_object('status', 'invalid_request', 'field', 'email');
  end if;
  if p_phone_e164 is not null and p_phone_e164 !~ '^\+91[6-9][0-9]{9}$' then
    return jsonb_build_object('status', 'invalid_request', 'field', 'phone');
  end if;
  if p_now is null or not isfinite(p_now) then
    return jsonb_build_object('status', 'invalid_request', 'field', 'now');
  end if;

  -- 2. The application's lock, before any read: two imports of one application run one by one.
  perform pg_advisory_xact_lock(hashtextextended('r1_meet_public:import:' || lower(p_ashby_application_id), 0));

  -- 3. Holds over the Ashby person, erasure and DSAR first, then the decision block.
  if exists (
    select 1
      from screening_v2.ashby_application_links l
     where l.provider = 'ashby'
       and (lower(l.external_candidate_id) = lower(p_ashby_candidate_id)
            or l.external_application_id = p_ashby_application_id)
       and (l.terminal_reason = 'subject_erasure'
            or exists (select 1 from screening_v2.ashby_erased_application_links e
                        where e.application_link_id = l.id)
            or exists (select 1 from screening_v2.data_subject_requests d
                        where d.candidate_id = l.candidate_id
                          and d.request_type in ('correct', 'restrict', 'delete')
                          and d.request_status in ('pending', 'in_progress', 'fulfilled')))
  ) then
    return jsonb_build_object('status', 'refused', 'code', 'dsar_hold');
  end if;
  if exists (
    select 1
      from screening_v2.ashby_application_links l
      join screening_v2.candidates c on c.id = l.candidate_id
     where l.provider = 'ashby'
       and (lower(l.external_candidate_id) = lower(p_ashby_candidate_id)
            or l.external_application_id = p_ashby_application_id)
       and c.decision_use_blocked_at is not null
  ) then
    return jsonb_build_object('status', 'refused', 'code', 'candidate_ineligible');
  end if;

  -- 4. An existing link of this application is adopted unchanged (nothing is written).
  select l.id, l.candidate_id, l.terminal_state
    into v_link_id, v_link_candidate, v_link_terminal
    from screening_v2.ashby_application_links l
   where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;
  if found then
    if v_link_terminal is not null then
      return jsonb_build_object('status', 'refused', 'code', 'application_terminal');
    end if;
    if v_link_candidate is null then
      return jsonb_build_object('status', 'refused', 'code', 'link_unbound');
    end if;
    return jsonb_build_object('status', 'exists', 'candidate_id', v_link_candidate::text,
                              'application_link_id', v_link_id::text);
  end if;

  -- 5. One R1 per Ashby person: no new shell for a person who has done R1 under another
  --    application (the links of this application were answered in 4).
  if exists (
    select 1
      from screening_v2.ashby_application_links l
      join screening_v2.interview_rounds r on r.candidate_id = l.candidate_id
     where l.provider = 'ashby'
       and lower(l.external_candidate_id) = lower(p_ashby_candidate_id)
       and r.kind = 'sales_r1'
       and (r.status = 'completed' or r.attempts_counted > 0)
  ) then
    return jsonb_build_object('status', 'refused', 'code', 'candidate_ineligible');
  end if;

  -- 6. The job's enabled, live mapping gives the role and the owner.
  select m.id, m.role_id, m.owner_id
    into v_mapping_id, v_role_id, v_owner_id
    from screening_v2.ashby_job_mappings m
   where m.provider = 'ashby' and m.external_job_id = p_ashby_job_id
     and m.status = 'enabled' and m.archived_at is null
   for share;
  if not found then
    return jsonb_build_object('status', 'refused', 'code', 'mapping_unavailable');
  end if;

  -- 7. The writes, link first.
  insert into screening_v2.ashby_application_links (
    provider, external_application_id, external_candidate_id, external_job_id, external_stage_id,
    job_mapping_id, candidate_id, lifecycle, intake_type, created_at, updated_at)
  values (
    'ashby', p_ashby_application_id, p_ashby_candidate_id, p_ashby_job_id, p_ashby_stage_id,
    v_mapping_id, null, 'imported', 'r1_public_booking', p_now, p_now)
  on conflict (provider, external_application_id) do nothing
  returning id into v_link_id;
  if v_link_id is null then
    -- Another writer (the Ashby import does not take this lock) made the link first: answer from
    -- the re-read, as in 4. Nothing was written here.
    select l.id, l.candidate_id, l.terminal_state
      into v_link_id, v_link_candidate, v_link_terminal
      from screening_v2.ashby_application_links l
     where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;
    if v_link_terminal is not null then
      return jsonb_build_object('status', 'refused', 'code', 'application_terminal');
    end if;
    if v_link_candidate is null then
      return jsonb_build_object('status', 'refused', 'code', 'link_unbound');
    end if;
    return jsonb_build_object('status', 'exists', 'candidate_id', v_link_candidate::text,
                              'application_link_id', v_link_id::text);
  end if;

  insert into screening_v2.candidates (
    role_id, owner_id, resume_id, name, email, phone_raw, phone_e164, phone_valid, skills,
    experience_years, parsed, status, ats_source, ashby_phone_applied_at, created_at, updated_at)
  values (
    v_role_id, v_owner_id, null, p_name, p_email, null, p_phone_e164, false, '[]'::jsonb,
    null, null, 'queued', 'ashby', case when p_phone_e164 is not null then p_now end, p_now, p_now)
  returning id into v_candidate_id;

  update screening_v2.ashby_application_links
     set candidate_id = v_candidate_id, updated_at = p_now
   where id = v_link_id;

  return jsonb_build_object('status', 'imported', 'candidate_id', v_candidate_id::text,
                            'application_link_id', v_link_id::text);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- §8. v_funnel_candidate leaves public booking imports out of the Christy funnel.
-- ---------------------------------------------------------------------------------------------
-- Lifted in full from 0122 §8 (its newest declaration) by script, byte-identical except ONE marked
-- hunk (M035-S12-c) that gives the base CTE a WHERE. The view has one row per candidates row, and
-- an on-the-spot import is a shell with phone_valid false and no attempt, so without the hunk
-- every import would join its mapped role's phone funnel as parsed, missing_phone and not_dialed
-- (refresh_funnel_rollup, 0098, counts it into funnel_stage_daily, which the role pipeline panel
-- shows as "Awaiting first dial"). Left out: a candidate with an r1_public_booking link and no
-- link of another intake (an import shell has exactly one link: materialize.ts binds one
-- candidate per application). A candidate with no link at all (a recruiter upload) stays.
-- idx_ashby_application_links_candidate (0029) serves both probes. v_funnel_hr_state is not
-- lifted: its hr_state is null without a non-R1 assessment, which an import never has, and the
-- rollup left-joins it to this view, so an import adds nothing there either. The output columns
-- are unchanged, so `create or replace view` keeps every dependent valid. The 0122 grants follow
-- verbatim, and the 0122 comment with one sentence more.
create or replace view screening_v2.v_funnel_candidate
  with (security_invoker = true) as
  with att as (
    select e.candidate_id,
           count(a.*)                                             as attempts_total,
           count(*) filter (where a.answered_at is not null)      as connects_total,
           min(a.admitted_at)                                     as first_attempt_at,
           max(a.admitted_at)                                     as last_attempt_at,
           min(a.answered_at)                                     as first_connect_at
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
    group by e.candidate_id
  ),
  att_last as (
    select distinct on (e.candidate_id) e.candidate_id, a.outcome_class
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.engagement_id = e.id
    order by e.candidate_id, a.admitted_at desc, a.id desc
  ),
  eng as (
    select candidate_id,
           bool_or(state in ('opted_out','wrong_number')) as any_engagement_consent_drop
    from screening_v2.phone_engagements
    group by candidate_id
  ),
  psess as (
    select c.id as session_id, c.candidate_id, c.duration_sec, c.terminal_reason
    from screening_v2.call_sessions c
    where exists (
      select 1 from screening_v2.phone_call_attempts a where a.session_id = c.id
    )
  ),
  sess as (
    select candidate_id,
           count(*)                                                          as phone_sessions_total,
           coalesce(sum(duration_sec), 0)                                    as total_call_seconds,
           bool_or(terminal_reason in ('candidate_opt_out','wrong_number'))  as any_session_consent_drop
    from psess
    group by candidate_id
  ),
  consent as (
    select p.candidate_id, true as consent_passed
    from psess p
    join screening_v2.phone_session_plans pl on pl.session_id = p.session_id
    group by p.candidate_id
  ),
  qa as (
    select p.candidate_id,
           count(*) filter (
             where pr.disposition in ('asked_answered','volunteered_with_evidence')
           ) as answered_questions
    from psess p
    join screening_v2.phone_session_progress pr on pr.session_id = p.session_id
    group by p.candidate_id
  ),
  asmt as (
    -- 0122 (R1 PR-5): an R1 interview round's assessment is never a candidate's
    -- "latest assessment" in this phone-funnel view; R1 has its own surface.
    select distinct on (a.candidate_id)
           a.candidate_id, a.recommendation, a.scoring_status, a.overall_score,
           a.weighted_score_5, a.partial
    from screening_v2.assessments a
    where not exists (
      select 1 from screening_v2.call_sessions rs
      where rs.id = a.session_id and rs.interview_round_id is not null
    )
    order by a.candidate_id, a.created_at desc, a.id desc
  ),
  refchk as (
    select l.candidate_id,
           bool_or(
             jm.reference_check_stage_id is not null
             and l.external_stage_id = jm.reference_check_stage_id
           ) as reached_reference_check
    from screening_v2.ashby_application_links l
    join screening_v2.ashby_job_mappings jm on jm.id = l.job_mapping_id
    where l.candidate_id is not null
    group by l.candidate_id
  ),
  base as (
    select
      c.id                                              as candidate_id,
      c.role_id                                         as role_id,
      r.title                                           as role_title,
      screening_v2.funnel_role_class(
        coalesce(c.parsed->>'current_role', c.parsed->>'title', r.title)
      )                                                 as resume_role_class,
      c.created_at                                      as intake_at,
      (c.created_at)::date                              as cohort_day,
      (c.phone_valid is not true)                       as missing_phone,
      coalesce(att.attempts_total, 0)                   as attempts_total,
      coalesce(att.connects_total, 0)                   as connects_total,
      att.first_attempt_at,
      att.last_attempt_at,
      att.first_connect_at,
      case
        when att.first_attempt_at is not null and att.first_connect_at is not null
        then extract(epoch from (att.first_connect_at - att.first_attempt_at))::numeric
      end                                               as time_to_first_connect_sec,
      att_last.outcome_class                            as latest_outcome_class,
      (coalesce(att.attempts_total, 0) > 0)             as dialed,
      (coalesce(att.connects_total, 0) > 0)             as connected,
      coalesce(consent.consent_passed, false)           as consent_passed,
      (coalesce(eng.any_engagement_consent_drop, false)
        or coalesce(sess.any_session_consent_drop, false)) as consent_dropped,
      coalesce(sess.total_call_seconds, 0)              as total_call_seconds,
      coalesce(qa.answered_questions, 0)                as answered_questions,
      (coalesce(qa.answered_questions, 0) >= 1)         as answered_ge1,
      asmt.recommendation,
      asmt.scoring_status,
      asmt.overall_score,
      asmt.weighted_score_5,
      coalesce(asmt.partial, false)                     as assessment_partial,
      (asmt.candidate_id is not null)                   as scored,
      (asmt.recommendation = 'advance')                 as qualified,
      (asmt.recommendation = 'reject')                  as disqualified,
      (asmt.recommendation = 'hold')                    as on_hold,
      (asmt.candidate_id is not null and asmt.recommendation is null) as human_review,
      coalesce(refchk.reached_reference_check, false)   as reached_reference_check
    from screening_v2.candidates c
    left join screening_v2.roles r        on r.id = c.role_id
    left join att        on att.candidate_id = c.id
    left join att_last   on att_last.candidate_id = c.id
    left join eng        on eng.candidate_id = c.id
    left join sess       on sess.candidate_id = c.id
    left join consent    on consent.candidate_id = c.id
    left join qa         on qa.candidate_id = c.id
    left join asmt       on asmt.candidate_id = c.id
    left join refchk     on refchk.candidate_id = c.id
    -- ▼ 0144 M035-S12-c a candidate the public booking page imported is not in the Christy funnel
    where not (exists (select 1 from screening_v2.ashby_application_links pb
                        where pb.candidate_id = c.id and pb.intake_type = 'r1_public_booking')
               and not exists (select 1 from screening_v2.ashby_application_links ol
                                where ol.candidate_id = c.id and ol.intake_type <> 'r1_public_booking'))
    -- ▲ 0144 M035-S12-c a candidate the public booking page imported is not in the Christy funnel
  )
  select
    base.*,
    case
      when base.reached_reference_check then 'reference_check'
      when base.qualified              then 'qualified'
      when base.scored                 then 'scored'
      when base.answered_ge1           then 'answered'
      when base.consent_passed         then 'consent_passed'
      when base.connected              then 'connected'
      when base.dialed                 then 'dialed'
      else 'parsed'
    end as furthest_stage,
    case
      when base.reached_reference_check then null
      -- Advanced/qualified is a SUCCESS terminus, not a drop. It MUST be
      -- peeled before the failure/consent branches: reached_reference_check is
      -- an unwired placeholder (always false today), so without this a
      -- qualified candidate would fall through to 'scored'/'consent_dropped'
      -- and be mislabeled as a drop. drop_reason is null for anyone who has
      -- not fallen out of the funnel.
      when base.qualified               then null
      when base.disqualified            then 'scorecard_reject'
      when base.human_review            then 'human_review'
      when base.on_hold                 then 'scorecard_hold'
      when base.consent_dropped         then 'consent_dropped'
      -- Scored but not advance/reject/hold/human_review: unreachable under the
      -- current recommendation vocabulary (advance|hold|reject|null), kept as an
      -- honest catch-all for a future recommendation value — never a false
      -- "not advanced" label for the qualified cohort.
      when base.scored                  then 'scored_other'
      when base.connected and not base.consent_passed then 'dropped_pre_consent'
      when base.connected and not base.answered_ge1    then 'no_answers'
      when base.dialed and not base.connected          then coalesce(base.latest_outcome_class, 'not_connected')
      when not base.dialed                             then 'not_dialed'
      else 'in_progress'
    end as drop_reason
  from base;

comment on view screening_v2.v_funnel_candidate is
  'One row per candidate across the whole funnel (parse -> dial -> connect -> '
  'consent -> Q&A -> scorecard -> reference check), with furthest_stage and a '
  'single consolidated drop_reason. Derived live from the operational tables — '
  'the source of truth for per-candidate drill-down. Counts/flags only, no PII.'
  ' 0144 (M035 S12): a candidate the public R1 booking page imported (its only Ashby links are '
  'r1_public_booking) is left out.';

revoke all on screening_v2.v_funnel_candidate from anon, authenticated, public;
grant select on screening_v2.v_funnel_candidate to service_role;

-- ---------------------------------------------------------------------------------------------
-- §9. r1_meet_public_person_r1_check: one R1 per Ashby person on the book path.
-- ---------------------------------------------------------------------------------------------
-- Read-only (S12 fix round, F3). The owner's rule "Open application, no R1 yet" holds per PERSON.
-- One person can have several local candidate rows (one per Ashby application, never merged:
-- integrations/ashby/materialize.ts), and the 0143 precheck answers r1_completed only for the
-- candidate it is given. The public page's book path (M035 S06) calls this right before that
-- precheck, with the candidate and the application it is about to book, and answers 404 not_found
-- on any refusal:
--   * application_unknown: no Ashby link with this verbatim application id bound to this candidate
--     (the 0143 precheck's own first refusal, read the same way);
--   * r1_completed: ANOTHER local candidate (not p_candidate_id) whose Ashby link names the same
--     Ashby candidate id as this link (case ignored) has a sales_r1 round, of any channel, that is
--     completed or holds a counted attempt (0143 §12's predicate). The candidate's own rounds are
--     left to the precheck, which keeps HR's re-linked retake bookable. A link without an Ashby
--     candidate id has no other row to look at;
--   * eligible: otherwise.
-- Answers {status:'eligible'} | {status:'refused', code} | {status:'invalid_request', field}
-- (candidate_id, application_id; the first failing wins). Nothing about the other rows is
-- returned. No write, no lock, no clock. The person probe scans the links table (no index on
-- external_candidate_id, as 0143 notes).
create or replace function screening_v2.r1_meet_public_person_r1_check(
  p_candidate_id uuid,
  p_ashby_application_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_found boolean;
  v_link_candidate uuid;
  v_person text;
begin
  -- 1. Validation. Nothing is read.
  if p_candidate_id is null then
    return jsonb_build_object('status', 'invalid_request', 'field', 'candidate_id');
  end if;
  if p_ashby_application_id is null or p_ashby_application_id !~* c_uuid then
    return jsonb_build_object('status', 'invalid_request', 'field', 'application_id');
  end if;

  -- 2. The application's link, by its verbatim id, bound to THIS candidate, and its Ashby person.
  select l.candidate_id, l.external_candidate_id
    into v_link_candidate, v_person
    from screening_v2.ashby_application_links l
   where l.provider = 'ashby' and l.external_application_id = p_ashby_application_id;
  v_found := found;
  if not v_found or v_link_candidate is distinct from p_candidate_id then
    return jsonb_build_object('status', 'refused', 'code', 'application_unknown');
  end if;

  -- 3. The same Ashby person's OTHER local candidates: none may have done R1.
  if v_person is not null and exists (
    select 1
      from screening_v2.ashby_application_links l2
      join screening_v2.interview_rounds r on r.candidate_id = l2.candidate_id
     where l2.provider = 'ashby'
       and lower(l2.external_candidate_id) = lower(v_person)
       and l2.candidate_id <> p_candidate_id
       and r.kind = 'sales_r1'
       and (r.status = 'completed' or r.attempts_counted > 0)
  ) then
    return jsonb_build_object('status', 'refused', 'code', 'r1_completed');
  end if;

  return jsonb_build_object('status', 'eligible');
end;
$$;

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

-- The three RPCs are service-role only: the public page reaches them only through the API.
revoke all on function screening_v2.r1_meet_public_local_rows(text, text, integer) from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_local_rows(text, text, integer) to service_role;
revoke all on function screening_v2.r1_meet_public_import_application(text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_import_application(text, text, text, text, text, text, text, timestamptz) to service_role;
revoke all on function screening_v2.r1_meet_public_person_r1_check(uuid, text) from public, anon, authenticated;
grant execute on function screening_v2.r1_meet_public_person_r1_check(uuid, text) to service_role;

comment on function screening_v2.r1_meet_public_local_rows(text, text, integer) is
  '0144 (M035 S04 fix round, S12): the public R1 booking page''s read-only local match lookup. '
  'Takes the normalised typed email and phone (the only RPC that does) and matches candidates by '
  'lower(btrim(email)) and by phone_e164, at most p_limit (1..21) per side, joined to their Ashby '
  'links, the links'' mappings, the 0130 DSAR hold and the decision block. Answers '
  '{status:ok, rows} with exactly candidate_id, matched_by, application_id, ashby_candidate_id, '
  'link_terminal, mapping_enabled, dsar_hold, decision_blocked per row (a candidate with no link '
  'is one fail-closed row), ordered by candidate id then application id, or '
  '{status:invalid_request}. Ids and flags only: never an email, a name or a number. Writes, '
  'raises and stores nothing. Service-role only.';
comment on function screening_v2.r1_meet_public_import_application(text, text, text, text, text, text, text, timestamptz) is
  '0144 (M035 S12): the public R1 booking page''s on-the-spot import of ONE Active Ashby '
  'application, the only writer of intake r1_public_booking. Arguments come only from Ashby '
  'reads, never from a typed value. Under a per-application advisory lock: holds over the Ashby '
  'person (dsar_hold: an erased link or the 0130 DSAR hold; then candidate_ineligible: a decision '
  'block), then an existing link is adopted unchanged (application_terminal, link_unbound or '
  'exists), then one R1 per Ashby person (candidate_ineligible: a candidate of the person has a '
  'completed or counted sales_r1 round), then the enabled live mapping of the job '
  '(mapping_unavailable), then the link is '
  'inserted first (on conflict do nothing; a lost race writes nothing), then the shell candidate '
  '(phone_valid false; ashby_phone_applied_at only with a number) is bound to it. Never writes a '
  'resume ingestion, phone engagement, operation, queue, session, invite or consent row. Answers '
  '{status:imported|exists, candidate_id, application_link_id} | {status:refused, code} | '
  '{status:invalid_request, field}: ids only. Service-role only.';
comment on function screening_v2.r1_meet_public_person_r1_check(uuid, text) is
  '0144 (M035 S12 fix round): the public R1 booking page''s book-path lookup, one R1 per Ashby '
  'person. For the Ashby link of p_ashby_application_id bound to p_candidate_id: refused '
  'application_unknown when there is none; refused r1_completed when ANOTHER local candidate '
  'linked to the same Ashby candidate id (case ignored) has a completed or counted sales_r1 round '
  'of any channel; else eligible. The candidate''s own rounds are the 0143 precheck''s. Answers '
  '{status:eligible} | {status:refused, code} | {status:invalid_request, field}: nothing about '
  'the other rows. Writes, locks and stores nothing. Service-role only.';

notify pgrst, 'reload schema';
