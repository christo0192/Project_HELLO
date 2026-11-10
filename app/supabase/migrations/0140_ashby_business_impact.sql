-- 0140: the business-impact read model (M031 S5).
--
-- What happens to an imported Ashby application after Christy, as one row per
-- application and as the aggregates the /impact page draws
-- (.gsd/milestones/M031/BUSINESS-IMPACT-PLAN.md section 5 "Read model and
-- refresh"; API-CONTRACT.md). Two NEW tables, one NEW view, six NEW functions:
--
--   ashby_impact_exclusions          per mapping: leave it out of the page, or
--                                    count an archived one (the switch an admin
--                                    sets; no staff id is stored)
--   ashby_erased_application_links   every Ashby link of a person a data-subject
--                                    erasure deleted, listed before the
--                                    candidate row goes (a link id and a time)
--   v_ashby_application_impact       one row per imported application: when it
--                                    came in, Christy's steps on THAT
--                                    application, its own verdict, and where it
--                                    went in Ashby. Raw facts, not nested.
--   impact_application_rows()        the view for one window and job, nested:
--                                    the one place the step rules live, so the
--                                    summary and the list can never disagree
--   impact_summary()                 the summary contract's aggregates, as JSON
--   impact_candidates()              one page of the applications behind a
--                                    figure, scoped by the candidate page's rule
--   ashby_impact_mapping_settings()  every mapping and whether the page counts it
--   set_ashby_impact_exclusion()     an admin's switch and its audit row, in one
--                                    transaction (the 0138 pattern)
--   mark_ashby_application_links_erased()
--                                    lib/dsar.ts's erasure step: lists every link
--                                    of the person, live or already terminal
--
-- 0139 is S3's (the progress worker), built in parallel. This file reads only
-- 0138's tables and the existing ones, and depends on nothing 0139 adds.
--
-- ADDITIVE ONLY. Nothing that exists is altered, dropped, updated or deleted:
-- no existing table, column or view changes, and ashby_application_links,
-- candidates, assessments and every other existing row are only READ. The
-- one row written outside the new tables is the switch's own audit row,
-- appended to audit_events under an action chk_audit_action already admits
-- (config_changed), so that constraint is not re-created. Nothing here
-- deletes: going back to the default stores NULL, and the erasure list only
-- grows. Each new table has one reference, ON DELETE CASCADE: the switch to
-- its ashby_job_mappings row, a listed link to its ashby_application_links
-- row.
--
-- SECURITY (the 0029/0138 posture): RLS on, no policy, no browser grant; the
-- view is security_invoker and, like every function here, service-role only.
-- The functions are SECURITY DEFINER with a pinned search_path.
--
-- PRIVACY. The switch holds a mapping id, a boolean and timestamps; the
-- erasure list a link id and a time. The view,
-- impact_application_rows and impact_summary carry opaque ids, codes, counts,
-- times, stage titles and Ashby's own archive-reason catalogue text: never a
-- name, email, phone, resume, offer amount, Ashby actor id or text typed about
-- a candidate. impact_candidates is the one place a candidate's name and role
-- leave the database, and only for rows the caller's scope can open
-- (D-M031-5): the API passes the candidate page's own rule (an interviewer
-- opens the candidates they own; a role that opens every candidate sees all).
-- A row the viewer cannot open is never returned, not even as an id; it is
-- counted in `hidden`.
--
-- APPEAL BLOCKS. While an appeal blocks decision use (candidates.
-- decision_use_blocked_at), the automated verdict is suppressed everywhere, as
-- the candidate list and its summary already suppress it: the application is
-- left OUT of the verdict table (counts and lists alike), so no cell and no
-- list can be subtracted to recover it, and a list row shows no verdict, score
-- or provisional mark. It still counts in the pipeline: it is real pipeline.
--
-- WHICH APPLICATIONS. Every Ashby link on a mapping (a link whose mapping was
-- hard-deleted has no mapping to count it under), except an erased or
-- restricted subject's, which is in no figure and no list:
--   - a link on the erasure list (ashby_erased_application_links). lib/dsar.ts
--     lists EVERY link of the person before it deletes the candidate, because
--     afterwards nothing else ties the link to them: the request row goes with
--     the candidate (ON DELETE CASCADE), candidate_id is set to NULL, and a
--     link that was already terminal (withdrawn, cancelled) keeps its own
--     terminal_reason;
--   - a link the erasure terminated (terminal_reason 'subject_erasure'), which
--     also covers erasures made before the list existed;
--   - a link whose candidate has a pending, in-progress or fulfilled
--     restriction or erasure request.
-- An erasure fulfilled before this migration, of a link that was ALREADY
-- terminal, left no mark at all and cannot be recognised here. This file does
-- not change 0139: its progress worker does not read the erasure list, but it
-- skips every ended link whose candidate is gone, so it never reads such an
-- application again. `in_impact` then says whether the mapping counts
-- (ashby_impact_exclusions).
--
-- THE RULES (API-CONTRACT.md):
--   came in      the application entered its Christy stage (the link's
--                import-time stage, or any stage labelled christy): the first
--                such entry in Ashby's history, or the link's import time when
--                none has been read. Cohort = the IST date of that time.
--   called       phone_primary: a phone attempt on any of the application's
--                engagements (phone_engagements.application_link_id).
--                browser_primary: the link's browser session started (waiting,
--                in progress or completed).
--   answered     phone: an attempt was answered (voicemail included). Browser:
--                the session started. The "Call answered" sub-line.
--   connected    consent given (D-M031-2). Phone: a session plan exists on one
--                of the application's engagements (start_phone_assessment
--                writes it at consent; 0122's consent_passed reads the same).
--                Browser: the session started and a granted consent record
--                covering ai_interview is bound to that session.
--   verdict      the newest non-R1 assessment on THIS application's sessions
--                (the link's session and its engagements', the tag resolver's
--                rule limited to one link), never candidate-wide: evidence
--                graded insufficient is held; advance select, hold
--                borderline, reject reject; anything else or none is none.
--                Provisional = scoring_status incomplete_evidence with a verdict.
--   scored       select, borderline or reject, provisional included.
--   Ashby-known  the progress worker has read the application
--                (last_checked_at). Every Ashby fact below needs it.
--   moved fwd    reached a stage after the Christy stage in its plan's order,
--                or a stage labelled r1..hired, or status Hired.
--   r1 .. hired  reached a stage labelled that milestone or a later labelled
--                one (r1 < r2 < r3 < r4 < r5 < reference < offer < hired), or
--                status Hired.
--   Archived-type and Lead-type stages, and a stage labelled archived, never
--   count as reached or as forward. Only history entered at or after the
--   application came in counts: what happened before HELLO counts for nothing.
--   still in Christy  not Archived or Hired, and the current stage is a
--                Christy stage (or unknown).
--   decided      left the Christy stage: moved forward, archived, or anywhere
--                that is not a Christy stage.
--   left from    an archived application's last stage that is not an
--                Archived one: where it left.
-- The steps nest in impact_application_rows: each counts only applications
-- that reached the one before, so no share is ever over 100%. While the
-- worker is off, or has read none of the applications in view, every
-- Ashby-side figure is NULL, never 0. Each weekly cohort, job row and verdict
-- row is gated the same way on its OWN applications: one that has
-- applications, none of them read, shows NULL Ashby-side figures (not read
-- yet is not 0), so a week or job answers the same chosen alone as inside a
-- longer view. An empty verdict row has nothing unread and follows the
-- window. A group partly read counts its read applications (meta.coverage
-- says how much of the window is read).

-- Fail fast rather than queue (the 0109 precedent): the foreign keys take a
-- SHARE ROW EXCLUSIVE lock on ashby_job_mappings and on ashby_application_links.
-- LOCAL: this transaction only.
set local lock_timeout = '10s';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ashby_impact_exclusions
-- ═══════════════════════════════════════════════════════════════════════
-- No row, or excluded NULL: the default, which leaves out an archived mapping
-- (Mission Control's "delete") and counts every other. excluded = true leaves
-- the mapping out (staff or test applications); false counts it, even
-- archived. Going back to the default stores NULL, so the switch's last state
-- is never deleted. Who chose is in the audit row, never here.

create table if not exists screening_v2.ashby_impact_exclusions (
  job_mapping_id uuid primary key references screening_v2.ashby_job_mappings(id) on delete cascade,
  excluded       boolean,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_ashby_impact_exclusions_times check (updated_at >= created_at)
);

comment on table screening_v2.ashby_impact_exclusions is
  'Per Ashby mapping (M031): whether the business-impact page leaves it out '
  '(excluded true), counts it even when archived (false), or follows the '
  'default (NULL or no row: an archived mapping is left out, every other is '
  'counted). Written only by set_ashby_impact_exclusion, which audits the '
  'admin. No staff id. Service-role only.';
comment on column screening_v2.ashby_impact_exclusions.excluded is
  'true: the mapping''s applications are left out of every impact figure and '
  'list; false: they are counted even if the mapping is archived; NULL: the '
  'default (archived = left out).';

alter table screening_v2.ashby_impact_exclusions enable row level security;
revoke all on screening_v2.ashby_impact_exclusions from anon, authenticated, public;
grant all privileges on screening_v2.ashby_impact_exclusions to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 1b. ashby_erased_application_links
-- ═══════════════════════════════════════════════════════════════════════
-- Every Ashby link of a person a data-subject erasure deleted, live or
-- already terminal when the erasure ran. Written only by
-- mark_ashby_application_links_erased, which lib/dsar.ts calls while the
-- candidate row still exists. Never deleted: an erasure is not undone. A
-- listed link goes from the list only if the link itself is deleted.

create table if not exists screening_v2.ashby_erased_application_links (
  application_link_id uuid primary key references screening_v2.ashby_application_links(id) on delete cascade,
  created_at          timestamptz not null default now()
);

comment on table screening_v2.ashby_erased_application_links is
  'Every Ashby application link of a person a data-subject erasure deleted '
  '(M031), listed by lib/dsar.ts through mark_ashby_application_links_erased '
  'before the candidate row goes, when nothing else will tie the link to '
  'the person. The business-impact read model leaves a listed link out of '
  'every figure and list. A link id and a time only. Service-role only.';

alter table screening_v2.ashby_erased_application_links enable row level security;
revoke all on screening_v2.ashby_erased_application_links from anon, authenticated, public;
grant all privileges on screening_v2.ashby_erased_application_links to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. v_ashby_application_impact: one row per imported application
-- ═══════════════════════════════════════════════════════════════════════
-- Raw facts per application. The nesting is impact_application_rows'. Ids,
-- codes, flags, times and stage titles only.

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
  'titles only. Service-role only.';

revoke all on screening_v2.v_ashby_application_impact from anon, authenticated, public;
grant select on screening_v2.v_ashby_application_impact to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. impact_application_rows: one window and job, nested
-- ═══════════════════════════════════════════════════════════════════════
-- The counted applications whose cohort day is in [p_from, p_to] (and on
-- p_job when given), with every step nested and every Ashby-side fact gated:
--
--   ashby_read  the same on every row: p_progress_enabled and at least one
--               of these applications has been read. While false, every
--               Ashby-side column is NULL or false and `furthest` stops at
--               scored (3).
--   furthest    the furthest nested step: 0 came in, 1 called, 2 connected,
--               3 scored, 4 decided, 5 moved forward, 6 R1+, 7 R2+, 8 Offer+,
--               9 hired. Reached step k = furthest >= k, so a step can never
--               count more than the one before it.
--   is_still    Ashby still has it open (Active or Lead).
--   is_dropped  Ashby archived it.
--   stale       its progress row has been due for more than a day (0139's
--               rule; a row Ashby no longer has, due at infinity, is not).
--
-- impact_summary and impact_candidates read only this, so a list holds
-- exactly the applications its figure counts.

create or replace function screening_v2.impact_application_rows(
  p_from date,
  p_to date,
  p_job uuid,
  p_progress_enabled boolean,
  p_now timestamptz
)
returns table (
  application_link_id uuid,
  job_mapping_id      uuid,
  candidate_id        uuid,
  cohort_day          date,
  came_in_at          timestamptz,
  called_at           timestamptz,
  answered            boolean,
  verdict             text,
  provisional         boolean,
  has_assessment      boolean,
  decision_blocked    boolean,
  verdict_at          timestamptz,
  score               numeric,
  ashby_known         boolean,
  ashby_read          boolean,
  stale               boolean,
  status              text,
  current_stage_title text,
  current_milestone   text,
  still_christy       boolean,
  archived            boolean,
  archived_christy    boolean,
  is_active           boolean,
  leave_stage_id      text,
  leave_stage_title   text,
  leave_milestone     text,
  leave_order         integer,
  archive_reason_type text,
  archive_reason_text text,
  decided_at          timestamptz,
  r1_at               timestamptz,
  r2_at               timestamptz,
  offer_at            timestamptz,
  hired_at            timestamptz,
  last_move_at        timestamptz,
  n_called            boolean,
  n_connected         boolean,
  n_scored            boolean,
  n_decided           boolean,
  a_fwd               boolean,
  a_r1                boolean,
  a_r2                boolean,
  a_offer             boolean,
  a_hired             boolean,
  furthest            integer,
  is_still            boolean,
  is_dropped          boolean
)
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  with v as (
    select i.*
      from screening_v2.v_ashby_application_impact i
     where i.in_impact
       and i.cohort_day between p_from and p_to
       and (p_job is null or i.job_mapping_id = p_job)
  ),
  r as (
    select v.*,
           (coalesce(p_progress_enabled, false) and coalesce(bool_or(v.ashby_known) over (), false)) as rd
      from v
  ),
  g as (
    select r.*,
           r.called as x_called,
           (r.called and r.connected) as x_connected,
           (r.called and r.connected and r.verdict in ('select', 'borderline', 'reject')) as x_scored,
           (r.rd and r.decided) as x_decided,
           (r.rd and r.moved_forward) as x_fwd,
           (r.rd and r.moved_forward and r.reached_r1) as x_r1,
           (r.rd and r.moved_forward and r.reached_r1 and r.reached_r2) as x_r2,
           (r.rd and r.moved_forward and r.reached_r1 and r.reached_r2 and r.reached_offer) as x_offer,
           (r.rd and r.moved_forward and r.reached_r1 and r.reached_r2 and r.reached_offer and r.reached_hired) as x_hired
      from r
  )
  select
    g.application_link_id,
    g.job_mapping_id,
    g.candidate_id,
    g.cohort_day,
    g.came_in_at,
    g.called_at,
    (g.called and g.answered),
    g.verdict,
    g.provisional,
    g.has_assessment,
    g.decision_blocked,
    g.verdict_at,
    g.score,
    g.ashby_known,
    g.rd,
    (g.next_check_at is not null and g.next_check_at <> 'infinity'::timestamptz
     and g.next_check_at < coalesce(p_now, now()) - interval '1 day'),
    case when g.rd then g.status end,
    case when g.rd then g.current_stage_title end,
    case when g.rd then g.current_milestone end,
    (g.rd and g.still_christy),
    (g.rd and g.archived),
    (g.rd and g.archived_christy),
    (g.rd and g.status is not distinct from 'Active'),
    case when g.rd then g.leave_stage_id end,
    case when g.rd then g.leave_stage_title end,
    case when g.rd then g.leave_milestone end,
    case when g.rd then g.leave_order end,
    case when g.rd then g.archive_reason_type end,
    case when g.rd then g.archive_reason_text end,
    case when g.rd then g.decided_at end,
    case when g.rd then g.r1_at end,
    case when g.rd then g.r2_at end,
    case when g.rd then g.offer_at end,
    case when g.rd then g.hired_at end,
    case when g.rd then g.last_move_at end,
    g.x_called,
    g.x_connected,
    g.x_scored,
    (g.x_scored and g.x_decided),
    g.x_fwd,
    g.x_r1,
    g.x_r2,
    g.x_offer,
    g.x_hired,
    case
      when not g.x_called then 0
      when not g.x_connected then 1
      when not g.x_scored then 2
      when not g.x_decided then 3
      when not g.x_fwd then 4
      when not g.x_r1 then 5
      when not g.x_r2 then 6
      when not g.x_offer then 7
      when not g.x_hired then 8
      else 9
    end,
    (g.rd and g.status in ('Active', 'Lead')),
    (g.rd and g.status is not distinct from 'Archived')
  from g
$$;

revoke all on function screening_v2.impact_application_rows(date, date, uuid, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.impact_application_rows(date, date, uuid, boolean, timestamptz)
  to service_role;

comment on function screening_v2.impact_application_rows(date, date, uuid, boolean, timestamptz) is
  'The business-impact applications of one IST cohort window and job (M031), '
  'with every step nested (furthest 0 came in .. 9 hired) and every Ashby-side '
  'fact gated on ashby_read (the flag is on and some of them have been read). '
  'The one place the step rules live: impact_summary and impact_candidates '
  'read only this. Ids, codes, flags and times only. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. impact_summary: the summary contract's aggregates
-- ═══════════════════════════════════════════════════════════════════════
-- p_from/p_to: IST cohort dates, NULL = the last 12 IST weeks (from the
-- Monday 11 weeks before this week's, to today). p_job: a counted
-- ashby_job_mappings id, NULL = all. p_progress_enabled: the API's
-- ASHBY_PROGRESS_ENABLED. p_now: the clock (tests pin it).
-- Answers {status:'ok', summary:{...}} in the contract's shape, or a refusal
-- (invalid_filter, unknown_job). Coverage, stale rows and the Ashby-side gate
-- are the window's and job's: what the page shows is what they describe.
-- Each cohort week, job row and verdict row also carries its own gate (rd):
-- its Ashby-side figures are NULL unless one of its own applications has been
-- read (an empty verdict row follows the window's gate). Counts, shares, days
-- and stage titles only. Reads only.

create or replace function screening_v2.impact_summary(
  p_from date default null,
  p_to date default null,
  p_job uuid default null,
  p_progress_enabled boolean default false,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_today    date := (coalesce(p_now, now()) at time zone 'Asia/Kolkata')::date;
  v_from     date;
  v_to       date;
  v_last     timestamptz;
  v_mature   integer;
  v_unlab    integer;
  v_unread   integer;
  v_mappings integer;
  v_out      jsonb;
begin
  v_from := coalesce(p_from, date_trunc('week', (v_today - 77)::timestamp)::date);
  v_to := coalesce(p_to, v_today);
  if v_from > v_to or v_to - v_from > 3660 then
    return jsonb_build_object('status', 'invalid_filter');
  end if;
  if p_job is not null and not exists (
    select 1 from screening_v2.ashby_job_mappings m
      left join screening_v2.ashby_impact_exclusions x on x.job_mapping_id = m.id
     where m.id = p_job and m.provider = 'ashby' and not coalesce(x.excluded, m.archived_at is not null)
  ) then
    return jsonb_build_object('status', 'unknown_job');
  end if;

  select max(finished_at) into v_last from screening_v2.ashby_progress_runs;

  -- A cohort is still maturing while it is younger than the usual time to
  -- hire (the median came in -> hired over every counted application, with
  -- at least 5 hires), and never under six weeks.
  v_mature := 42;
  if coalesce(p_progress_enabled, false) then
    select greatest(42, ceil(percentile_cont(0.5) within group (order by h.d))::integer)
      into v_mature
      from (select extract(epoch from (i.hired_at - i.came_in_at)) / 86400.0 as d
              from screening_v2.v_ashby_application_impact i
             where i.in_impact and i.reached_hired and i.hired_at > i.came_in_at) h
    having count(*) >= 5;
    v_mature := coalesce(v_mature, 42);
  end if;

  -- Labels: the counted plans' stages after the Christy stage, and stages
  -- seen only in counted history after the application came in, that nobody
  -- has labelled. Stages before the Christy stage never matter.
  with live as (
    select m.id, m.ai_screening_stage_id
      from screening_v2.ashby_job_mappings m
      left join screening_v2.ashby_impact_exclusions x on x.job_mapping_id = m.id
     where m.provider = 'ashby' and not coalesce(x.excluded, m.archived_at is not null)
  ),
  anchors as (
    select distinct c.interview_plan_id, c.order_in_plan as christy_order
      from live join screening_v2.ashby_stage_catalog c on c.stage_id = live.ai_screening_stage_id
  ),
  plan_gaps as (
    select c.stage_id
      from screening_v2.ashby_stage_catalog c
      join anchors a on a.interview_plan_id = c.interview_plan_id
     where c.not_in_plan_since is null and c.milestone is null
       and coalesce(c.stage_type, '') not in ('Archived', 'Lead')
       and (c.order_in_plan is null or a.christy_order is null or c.order_in_plan > a.christy_order)
  ),
  history_gaps as (
    select distinct i.stage_id
      from screening_v2.ashby_application_stage_intervals i
      join screening_v2.v_ashby_application_impact v on v.application_link_id = i.application_link_id
      left join screening_v2.ashby_stage_catalog c on c.stage_id = i.stage_id
     where v.in_impact and i.gone_at is null and c.milestone is null
       and coalesce(c.stage_type, '') not in ('Archived', 'Lead')
       and i.stage_id is distinct from v.christy_stage_id
       and (i.entered_at is null or i.entered_at >= v.came_in_at)
       and not exists (
         select 1 from anchors a
          where a.interview_plan_id = c.interview_plan_id
            and a.christy_order is not null and c.order_in_plan is not null
            and c.order_in_plan <= a.christy_order)
  )
  select (select count(*) from (select stage_id from plan_gaps union select stage_id from history_gaps) g),
         (select count(*) from live l
           where l.ai_screening_stage_id is null
              or not exists (select 1 from screening_v2.ashby_stage_catalog c where c.stage_id = l.ai_screening_stage_id)),
         (select count(*) from live)
    into v_unlab, v_unread, v_mappings;

  with
  f as materialized (
    select * from screening_v2.impact_application_rows(v_from, v_to, p_job, p_progress_enabled, v_now)
  ),
  cov as (
    select count(*)::integer as total,
           count(*) filter (where f.ashby_known)::integer as checked,
           count(*) filter (where f.stale)::integer as stale,
           coalesce(bool_or(f.ashby_read), false) as rd
      from f
  ),
  steps (idx, step, label) as (
    values (0, 'came_in', 'Came in'), (1, 'called', 'Christy called'), (2, 'connected', 'Christy connected'),
           (3, 'scored', 'Scored'), (4, 'decided', 'A person decided in Ashby'),
           (5, 'moved_forward', 'Moved forward in Ashby'), (6, 'r1', 'R1 or later'), (7, 'r2', 'R2 or later'),
           (8, 'offer', 'Offer or later'), (9, 'hired', 'Hired')
  ),
  sc as (
    select s.idx, s.step, s.label,
           count(f.application_link_id) filter (where f.furthest >= s.idx) as reached,
           count(f.application_link_id) filter (where f.furthest = s.idx and f.is_still) as still,
           count(f.application_link_id) filter (where f.furthest = s.idx and f.is_dropped) as dropped
      from steps s left join f on true
     group by s.idx, s.step, s.label
  ),
  sc2 as (
    select sc.*, lag(sc.reached) over (order by sc.idx) as prev,
           first_value(sc.reached) over (order by sc.idx) as came
      from sc
  ),
  pipeline as (
    select jsonb_agg(
             jsonb_build_object(
               'step', sc2.step,
               'label', sc2.label,
               'reached', case when sc2.idx >= 4 and not cov.rd then null else sc2.reached end,
               'ofPrevious', case when sc2.idx = 0 or (sc2.idx >= 4 and not cov.rd) or sc2.prev = 0 then null
                                  else round(sc2.reached::numeric / sc2.prev, 3) end,
               'ofCameIn', case when (sc2.idx >= 4 and not cov.rd) or sc2.came = 0 then null
                                else round(sc2.reached::numeric / sc2.came, 3) end,
               'stillHere', case when not cov.rd or sc2.idx in (4, 9) then null else sc2.still end,
               'droppedHere', case when not cov.rd or sc2.idx = 9 then null else sc2.dropped end)
             || case when sc2.step = 'connected' then jsonb_build_object('sub', jsonb_build_object(
                  'label', 'Call answered',
                  'reached', (select count(*) from f where f.n_called and f.answered)))
                else '{}'::jsonb end
             order by sc2.idx) as j
      from sc2 cross join cov
  ),
  vrows (ord, verdict, label) as (
    values (1, 'select', 'Select'), (2, 'borderline', 'Borderline'), (3, 'reject', 'Reject'),
           (4, 'held', 'Held (thin evidence)'), (5, 'none', 'No verdict')
  ),
  vc as (
    select r.ord, r.verdict, r.label,
           count(f.application_link_id) as total,
           -- This row's own gate: Ashby has been read for one of ITS applications.
           coalesce(bool_or(f.ashby_read and f.ashby_known), false) as rd,
           count(f.application_link_id) filter (where f.still_christy) as still_christy,
           count(f.application_link_id) filter (where f.archived_christy) as archived_christy,
           count(f.application_link_id) filter (where f.a_fwd) as moved_forward,
           count(f.application_link_id) filter (where f.a_r1) as r1,
           count(f.application_link_id) filter (where f.a_r2) as r2,
           count(f.application_link_id) filter (where f.a_offer) as offer,
           count(f.application_link_id) filter (where f.a_hired) as hired,
           count(f.application_link_id) filter (where f.is_active) as active
      from vrows r
      left join f on f.n_connected and f.verdict = r.verdict and not f.decision_blocked
     group by r.ord, r.verdict, r.label
  ),
  verdicts as (
    select jsonb_build_object(
             'columns', jsonb_build_array(
               jsonb_build_object('key', 'still_christy', 'label', 'Still in the Christy stage'),
               jsonb_build_object('key', 'archived_christy', 'label', 'Archived from the Christy stage'),
               jsonb_build_object('key', 'moved_forward', 'label', 'Moved forward'),
               jsonb_build_object('key', 'r1', 'label', 'R1 or later'),
               jsonb_build_object('key', 'r2', 'label', 'R2 or later'),
               jsonb_build_object('key', 'offer', 'label', 'Offer or later'),
               jsonb_build_object('key', 'hired', 'label', 'Hired'),
               jsonb_build_object('key', 'active', 'label', 'Still active')),
             'rows', jsonb_agg(jsonb_build_object(
               'verdict', vc.verdict, 'label', vc.label, 'total', vc.total,
               -- An empty row has nothing unread: it follows the window, so its cells are 0 once Ashby is read.
               'cells', case when vc.rd or (vc.total = 0 and cov.rd) then jsonb_build_object(
                          'still_christy', vc.still_christy, 'archived_christy', vc.archived_christy,
                          'moved_forward', vc.moved_forward, 'r1', vc.r1, 'r2', vc.r2, 'offer', vc.offer,
                          'hired', vc.hired, 'active', vc.active)
                        else jsonb_build_object(
                          'still_christy', null, 'archived_christy', null, 'moved_forward', null,
                          'r1', null, 'r2', null, 'offer', null, 'hired', null, 'active', null) end)
               order by vc.ord)) as j
      from vc cross join cov
  ),
  lv as (
    select f.leave_stage_id, max(f.leave_stage_title) as title, max(f.leave_milestone) as milestone,
           min(f.leave_order) as ord, count(*) as archived,
           count(*) filter (where f.archive_reason_type = 'rejected_by_org') as by_org,
           count(*) filter (where f.archive_reason_type = 'rejected_by_candidate') as by_candidate,
           count(*) filter (where f.archive_reason_type = 'other') as by_other,
           count(*) filter (where f.archive_reason_type = 'none') as by_none
      from f
     where f.archived and f.leave_stage_id is not null
     group by f.leave_stage_id
  ),
  leaves as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'stageId', lv.leave_stage_id,
             'stageTitle', coalesce(lv.title, 'Untitled stage'),
             'milestone', lv.milestone,
             'archived', lv.archived,
             'byReasonType', jsonb_build_object('rejected_by_org', lv.by_org, 'rejected_by_candidate', lv.by_candidate,
                                                'other', lv.by_other, 'none', lv.by_none),
             'topReasons', coalesce((
               select jsonb_agg(jsonb_build_object('text', t.text, 'count', t.cnt) order by t.cnt desc, t.text)
                 from (select f2.archive_reason_text as text, count(*) as cnt
                         from f f2
                        where f2.archived and f2.leave_stage_id = lv.leave_stage_id
                          and f2.archive_reason_text is not null
                        group by f2.archive_reason_text
                        order by count(*) desc, f2.archive_reason_text
                        limit 5) t), '[]'::jsonb))
             order by lv.ord nulls last, lv.title, lv.leave_stage_id), '[]'::jsonb) as j
      from lv
  ),
  dur as (
    select 'entry_to_first_call' as key, extract(epoch from (f.called_at - f.came_in_at)) / 86400.0 as d
      from f where f.n_called and f.called_at >= f.came_in_at
    union all
    select 'entry_to_verdict', extract(epoch from (f.verdict_at - f.came_in_at)) / 86400.0
      from f where f.n_scored and f.verdict_at >= f.came_in_at
    union all
    select 'verdict_to_decision', extract(epoch from (f.decided_at - f.verdict_at)) / 86400.0
      from f where f.n_decided and f.decided_at >= f.verdict_at
    union all
    select 'christy_to_r1', extract(epoch from (f.r1_at - f.came_in_at)) / 86400.0
      from f where f.a_r1 and f.n_decided and f.r1_at > f.came_in_at
    union all
    select 'r1_to_r2', extract(epoch from (f.r2_at - f.r1_at)) / 86400.0
      from f where f.a_r2 and f.n_decided and f.r2_at > f.r1_at
    union all
    select 'r2_to_offer', extract(epoch from (f.offer_at - f.r2_at)) / 86400.0
      from f where f.a_offer and f.n_decided and f.offer_at > f.r2_at
    union all
    select 'offer_to_hired', extract(epoch from (f.hired_at - f.offer_at)) / 86400.0
      from f where f.a_hired and f.n_decided and f.hired_at > f.offer_at
  ),
  tkeys (ord, key, label) as (
    values (1, 'entry_to_first_call', 'Christy stage to first call'),
           (2, 'entry_to_verdict', 'Christy stage to verdict'),
           (3, 'verdict_to_decision', 'Verdict to a person deciding'),
           (4, 'christy_to_r1', 'Christy stage to R1'),
           (5, 'r1_to_r2', 'R1 to R2'),
           (6, 'r2_to_offer', 'R2 to Offer'),
           (7, 'offer_to_hired', 'Offer to Hired')
  ),
  tm as (
    select t.ord, t.key, t.label,
           count(d.d) as n,
           percentile_cont(0.5) within group (order by d.d) as med,
           percentile_cont(0.9) within group (order by d.d) as p90
      from tkeys t
      left join dur d on d.key = t.key
     group by t.ord, t.key, t.label
  ),
  timings as (
    select jsonb_agg(jsonb_build_object(
             'key', tm.key, 'label', tm.label,
             'medianDays', case when tm.n >= 5 then round(tm.med::numeric, 2) end,
             'p90Days', case when tm.n >= 5 then round(tm.p90::numeric, 2) end,
             'n', tm.n) order by tm.ord) as j
      from tm
  ),
  wk as (
    select date_trunc('week', f.cohort_day::timestamp)::date as week_start,
           count(*) as came,
           -- This week's own gate, so a week answers the same alone as in a longer view.
           coalesce(bool_or(f.ashby_read and f.ashby_known), false) as rd,
           count(*) filter (where f.n_connected) as c_connected,
           count(*) filter (where f.n_scored) as c_scored,
           count(*) filter (where f.n_decided and f.a_fwd) as c_fwd,
           count(*) filter (where f.n_decided and f.a_r1) as c_r1,
           count(*) filter (where f.n_decided and f.a_r2) as c_r2,
           count(*) filter (where f.n_decided and f.a_offer) as c_offer,
           count(*) filter (where f.n_decided and f.a_hired) as c_hired
      from f group by 1
  ),
  cohorts as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'weekStart', to_char(wk.week_start, 'YYYY-MM-DD'),
             'ageDays', v_today - wk.week_start,
             'maturing', (v_today - wk.week_start) < v_mature,
             'cameIn', wk.came,
             'shares', jsonb_build_object(
               'connected', round(wk.c_connected::numeric / wk.came, 3),
               'scored', round(wk.c_scored::numeric / wk.came, 3),
               'moved_forward', case when wk.rd then round(wk.c_fwd::numeric / wk.came, 3) end,
               'r1', case when wk.rd then round(wk.c_r1::numeric / wk.came, 3) end,
               'r2', case when wk.rd then round(wk.c_r2::numeric / wk.came, 3) end,
               'offer', case when wk.rd then round(wk.c_offer::numeric / wk.came, 3) end,
               'hired', case when wk.rd then round(wk.c_hired::numeric / wk.came, 3) end))
             order by wk.week_start), '[]'::jsonb) as j
      from wk
  ),
  jobs_all as (
    select m.id,
           r.title || case when nullif(btrim(m.label), '') is not null and lower(btrim(m.label)) <> lower(r.title)
                           then ' (' || btrim(m.label) || ')' else '' end as label
      from screening_v2.ashby_job_mappings m
      join screening_v2.roles r on r.id = m.role_id
      left join screening_v2.ashby_impact_exclusions x on x.job_mapping_id = m.id
     where m.provider = 'ashby' and not coalesce(x.excluded, m.archived_at is not null)
  ),
  bj as (
    select f.job_mapping_id, count(*) as came,
           -- This job's own gate, so a job answers the same alone as in the all-jobs view.
           coalesce(bool_or(f.ashby_read and f.ashby_known), false) as rd,
           count(*) filter (where f.n_connected) as c_connected,
           count(*) filter (where f.n_scored) as c_scored,
           count(*) filter (where f.n_decided and f.a_fwd) as c_fwd,
           count(*) filter (where f.n_decided and f.a_r1) as c_r1,
           count(*) filter (where f.n_decided and f.a_r2) as c_r2,
           count(*) filter (where f.n_decided and f.a_offer) as c_offer,
           count(*) filter (where f.n_decided and f.a_hired) as c_hired
      from f group by f.job_mapping_id
  ),
  by_job as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'jobId', bj.job_mapping_id,
             'label', coalesce(ja.label, 'Ashby job'),
             'cameIn', bj.came,
             'shares', jsonb_build_object(
               'connected', round(bj.c_connected::numeric / bj.came, 3),
               'scored', round(bj.c_scored::numeric / bj.came, 3),
               'moved_forward', case when bj.rd then round(bj.c_fwd::numeric / bj.came, 3) end,
               'r1', case when bj.rd then round(bj.c_r1::numeric / bj.came, 3) end,
               'r2', case when bj.rd then round(bj.c_r2::numeric / bj.came, 3) end,
               'offer', case when bj.rd then round(bj.c_offer::numeric / bj.came, 3) end,
               'hired', case when bj.rd then round(bj.c_hired::numeric / bj.came, 3) end))
             order by ja.label, bj.job_mapping_id), '[]'::jsonb) as j
      from bj
      left join jobs_all ja on ja.id = bj.job_mapping_id
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'generatedAt', v_now,
      'timezone', 'Asia/Kolkata',
      'progressEnabled', coalesce(p_progress_enabled, false),
      'lastPassAt', v_last,
      'coverage', jsonb_build_object('checked', cov.checked, 'total', cov.total),
      'staleRows', cov.stale,
      'labelsConfigured', v_mappings > 0 and v_unread = 0 and v_unlab = 0,
      'unlabelledStages', v_unlab,
      'minTimingN', 5),
    'filters', jsonb_build_object(
      'from', to_char(v_from, 'YYYY-MM-DD'),
      'to', to_char(v_to, 'YYYY-MM-DD'),
      'job', p_job,
      'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', ja.id, 'label', ja.label) order by ja.label, ja.id)
                          from jobs_all ja), '[]'::jsonb)),
    'pipeline', (select j from pipeline),
    'verdictOutcomes', (select j from verdicts),
    'leaves', (select j from leaves),
    'timings', (select j from timings),
    'cohorts', (select j from cohorts),
    'byJob', (select j from by_job))
    into v_out
    from cov;

  return jsonb_build_object('status', 'ok', 'summary', v_out);
end;
$$;

revoke all on function screening_v2.impact_summary(date, date, uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function screening_v2.impact_summary(date, date, uuid, boolean, timestamptz) to service_role;

comment on function screening_v2.impact_summary(date, date, uuid, boolean, timestamptz) is
  'The business-impact summary (M031 API-CONTRACT.md): nested pipeline (no '
  'share over 100%), verdict against outcome, where candidates leave (top 5 '
  'reasons from Ashby''s catalogue), timings in days (median and p90 NULL '
  'under n 5; n always), IST weekly cohorts with a maturing flag, by job, '
  'and meta (coverage and stale rows of the window, last pass, labels). Every '
  'Ashby-side figure is NULL while p_progress_enabled is false or none of the '
  'window''s applications is read, and a cohort week, job row or verdict row '
  'that has applications, none of them read, shows NULL Ashby-side figures. '
  'Counts and stage titles only; reads only. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. impact_candidates: the applications behind one figure
-- ═══════════════════════════════════════════════════════════════════════
-- Exactly one selector: p_step (a pipeline step; p_dropped = the applications
-- that stopped there and Ashby archived), or p_verdict with p_outcome (a cell
-- of the verdict table), or p_leave_stage_id (archived after that stage). The
-- same window, job and rows as the summary (impact_application_rows), so a
-- list holds exactly the applications its figure counts.
--
-- VISIBILITY (D-M031-5). p_scope 'all' is a role that can open every
-- candidate: every row, an application with no candidate record included.
-- p_scope 'owner' is an interviewer: only rows whose candidate's owner_id is
-- p_owner_id, exactly the candidate page's rule. Anything else is refused.
-- What the viewer cannot open is counted in `hidden` and never returned, so
-- total + hidden is the figure. Paged in a total order: newest Ashby move
-- first, then newest came in, then the link id. A page past the end is empty.

create or replace function screening_v2.impact_candidates(
  p_from date,
  p_to date,
  p_job uuid,
  p_step text,
  p_verdict text,
  p_outcome text,
  p_leave_stage_id text,
  p_dropped boolean,
  p_scope text,
  p_owner_id uuid,
  p_page integer,
  p_page_size integer,
  p_progress_enabled boolean default false,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_now     timestamptz := coalesce(p_now, now());
  v_today   date := (coalesce(p_now, now()) at time zone 'Asia/Kolkata')::date;
  v_from    date;
  v_to      date;
  v_idx     integer;
  v_size    integer;
  v_page    integer;
  v_total   integer;
  v_hidden  integer;
  v_rows    jsonb;
begin
  if p_scope is null or p_scope not in ('all', 'owner') or (p_scope = 'owner' and p_owner_id is null) then
    return jsonb_build_object('status', 'invalid_scope');
  end if;
  v_from := coalesce(p_from, date_trunc('week', (v_today - 77)::timestamp)::date);
  v_to := coalesce(p_to, v_today);
  if v_from > v_to or v_to - v_from > 3660 then
    return jsonb_build_object('status', 'invalid_filter');
  end if;
  if (p_step is not null)::int + (p_verdict is not null or p_outcome is not null)::int + (p_leave_stage_id is not null)::int <> 1
     or (p_verdict is null) <> (p_outcome is null)
     or (coalesce(p_dropped, false) and p_step is null) then
    return jsonb_build_object('status', 'invalid_filter');
  end if;
  v_idx := case p_step
    when 'came_in' then 0 when 'called' then 1 when 'connected' then 2 when 'scored' then 3 when 'decided' then 4
    when 'moved_forward' then 5 when 'r1' then 6 when 'r2' then 7 when 'offer' then 8 when 'hired' then 9 end;
  if (p_step is not null and v_idx is null)
     or (coalesce(p_dropped, false) and v_idx = 9)
     or (p_verdict is not null and p_verdict not in ('select', 'borderline', 'reject', 'held', 'none'))
     or (p_outcome is not null and p_outcome not in
           ('still_christy', 'archived_christy', 'moved_forward', 'r1', 'r2', 'offer', 'hired', 'active'))
     or (p_leave_stage_id is not null
         and not (p_leave_stage_id ~ '^[A-Za-z0-9_.:-]+$' and length(p_leave_stage_id) <= 256)) then
    return jsonb_build_object('status', 'invalid_filter');
  end if;
  if p_job is not null and not exists (
    select 1 from screening_v2.ashby_job_mappings m
      left join screening_v2.ashby_impact_exclusions x on x.job_mapping_id = m.id
     where m.id = p_job and m.provider = 'ashby' and not coalesce(x.excluded, m.archived_at is not null)
  ) then
    return jsonb_build_object('status', 'unknown_job');
  end if;
  v_size := least(100, greatest(1, coalesce(p_page_size, 50)));
  v_page := greatest(1, coalesce(p_page, 1));

  with
  f as (
    select * from screening_v2.impact_application_rows(v_from, v_to, p_job, p_progress_enabled, v_now)
  ),
  m as (
    select f.*
      from f
     where case
             -- An Ashby-side step is not known while Ashby is not read: nothing is behind it.
             when p_step is not null and not coalesce(p_dropped, false) then
               f.furthest >= v_idx and (v_idx < 4 or f.ashby_read)
             when p_step is not null then
               f.furthest = v_idx and f.is_dropped
             when p_verdict is not null then
               f.ashby_read and f.n_connected and f.verdict = p_verdict and not f.decision_blocked and case p_outcome
                 when 'still_christy' then f.still_christy
                 when 'archived_christy' then f.archived_christy
                 when 'moved_forward' then f.a_fwd
                 when 'r1' then f.a_r1
                 when 'r2' then f.a_r2
                 when 'offer' then f.a_offer
                 when 'hired' then f.a_hired
                 when 'active' then f.is_active
               end
             else
               f.archived and f.leave_stage_id = p_leave_stage_id
           end
  ),
  s as (
    select m.*, c.id as cand_id, c.name as cand_name, ro.title as role_title,
           not (p_scope = 'owner' and (c.id is null or c.owner_id is distinct from p_owner_id)) as visible
      from m
      left join screening_v2.candidates c on c.id = m.candidate_id
      left join screening_v2.roles ro on ro.id = c.role_id
  ),
  counted as (
    select count(*) filter (where s.visible)::integer as total,
           count(*) filter (where not s.visible)::integer as hidden
      from s
  ),
  paged as (
    select s.*,
           row_number() over (order by s.last_move_at desc nulls last, s.came_in_at desc, s.application_link_id) as rn
      from s where s.visible
  )
  select c.total, c.hidden,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'candidateId', p.cand_id,
                    'name', p.cand_name,
                    'roleTitle', p.role_title,
                    'verdict', case when p.decision_blocked then null else p.verdict end,
                    'score', case when not p.decision_blocked and p.has_assessment then p.score end,
                    'provisional', not p.decision_blocked and p.provisional,
                    'currentStageTitle', p.current_stage_title,
                    'currentMilestone', p.current_milestone,
                    'status', p.status,
                    'enteredChristyAt', p.came_in_at,
                    'lastMoveAt', p.last_move_at)
                  order by p.rn)
             from paged p
            where p.rn > (v_page - 1)::bigint * v_size and p.rn <= v_page::bigint * v_size),
           '[]'::jsonb)
    into v_total, v_hidden, v_rows
    from counted c;

  return jsonb_build_object('status', 'ok', 'total', v_total, 'hidden', v_hidden,
                            'page', v_page, 'pageSize', v_size, 'rows', v_rows);
end;
$$;

revoke all on function screening_v2.impact_candidates(date, date, uuid, text, text, text, text, boolean, text, uuid, integer, integer, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.impact_candidates(date, date, uuid, text, text, text, text, boolean, text, uuid, integer, integer, boolean, timestamptz)
  to service_role;

comment on function screening_v2.impact_candidates(date, date, uuid, text, text, text, text, boolean, text, uuid, integer, integer, boolean, timestamptz) is
  'One page of the applications behind a business-impact figure (M031, '
  'D-M031-5): the summary''s window, job and nested rows, then the candidate '
  'page''s own visibility (scope all, or owner = the interviewer). Rows the '
  'viewer cannot open are counted in hidden and never returned; an '
  'appeal-blocked verdict is never listed or shown. Name and role from the existing '
  'candidate record; no email, phone, Ashby id or archive free text. Reads '
  'only. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. ashby_impact_mapping_settings: every mapping and whether it counts
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.ashby_impact_mapping_settings()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, screening_v2
as $$
  with rows as (
    select m.id, r.title as role_title, nullif(btrim(m.label), '') as label,
           m.archived_at is not null as archived, x.excluded,
           not coalesce(x.excluded, m.archived_at is not null) as in_impact,
           m.created_at
      from screening_v2.ashby_job_mappings m
      join screening_v2.roles r on r.id = m.role_id
      left join screening_v2.ashby_impact_exclusions x on x.job_mapping_id = m.id
     where m.provider = 'ashby'
     order by m.created_at desc, m.id
     limit 501
  )
  select jsonb_build_object(
    'truncated', (select count(*) from rows) > 500,
    'mappings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'roleTitle', t.role_title, 'label', t.label, 'archived', t.archived,
               'excluded', t.excluded, 'inImpact', t.in_impact) order by t.created_at desc, t.id)
        from (select * from rows order by created_at desc, id limit 500) t), '[]'::jsonb));
$$;

revoke all on function screening_v2.ashby_impact_mapping_settings() from public, anon, authenticated;
grant execute on function screening_v2.ashby_impact_mapping_settings() to service_role;

comment on function screening_v2.ashby_impact_mapping_settings() is
  'Every Ashby mapping (newest first, at most 500, truncated says when there '
  'are more): its role title and label, whether it is archived, the admin''s '
  'switch (excluded true or false, NULL = the default) and whether the '
  'business-impact page counts it. Configuration only. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. set_ashby_impact_exclusion: an admin's switch, and its audit row
-- ═══════════════════════════════════════════════════════════════════════
-- p_excluded true: leave the mapping out; false: count it (even archived);
-- NULL: back to the default (stored as NULL, never deleted). The switch and
-- its audit_events row (config_changed, target ashby_impact_exclusion/<mapping
-- id>, before and after) are one transaction; no exception handler, so a
-- refused audit insert rolls the switch back. A refusal writes nothing.

create or replace function screening_v2.set_ashby_impact_exclusion(
  p_job_mapping_id uuid,
  p_excluded boolean,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_archived boolean;
  v_from     boolean;
  v_in       boolean;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_job_mapping_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select m.archived_at is not null into v_archived
    from screening_v2.ashby_job_mappings m
   where m.id = p_job_mapping_id and m.provider = 'ashby'
   for key share;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select x.excluded into v_from
    from screening_v2.ashby_impact_exclusions x
   where x.job_mapping_id = p_job_mapping_id
   for update;

  insert into screening_v2.ashby_impact_exclusions as x (job_mapping_id, excluded)
  values (p_job_mapping_id, p_excluded)
  on conflict (job_mapping_id) do update
    set excluded = excluded.excluded,
        updated_at = greatest(now(), x.created_at);
  v_in := not coalesce(p_excluded, v_archived);

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'config_changed', 'ashby_impact_exclusion', p_job_mapping_id::text, 'success',
     jsonb_build_object('resource', 'ashby_impact_exclusion', 'job_mapping_id', p_job_mapping_id,
                        'excluded_from', v_from, 'excluded_to', p_excluded, 'in_impact', v_in));

  return jsonb_build_object('status', 'ok', 'excluded_from', v_from, 'excluded', p_excluded,
                            'archived', v_archived, 'in_impact', v_in);
end;
$$;

revoke all on function screening_v2.set_ashby_impact_exclusion(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function screening_v2.set_ashby_impact_exclusion(uuid, boolean, uuid) to service_role;

comment on function screening_v2.set_ashby_impact_exclusion(uuid, boolean, uuid) is
  'Sets one mapping''s business-impact switch (M031): true leaves it out, '
  'false counts it even archived, NULL returns it to the default (archived = '
  'left out). Never deletes. Writes its audit row (before and after) in the '
  'same transaction; the admin is the audit row''s actor, never a column. '
  'Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. mark_ashby_application_links_erased: an erasure lists the person's links
-- ═══════════════════════════════════════════════════════════════════════
-- lib/dsar.ts calls this while the candidate row still exists: after it has
-- terminated the live links, before it deletes the candidate. In one
-- statement it lists EVERY link whose candidate_id is that person, live or
-- already terminal. It lists only while the person has a deletion request
-- (pending, in progress or fulfilled); anything else is refused and lists
-- nothing, so the list can never hide a person nobody asked to erase.
-- Idempotent: a retry lists nothing twice. It reads the links and the
-- request, and writes only the list.
-- Answers {status:'ok', listed: the person's links now on the list, added:
-- those this call listed}, or invalid_request / no_erasure_request.

create or replace function screening_v2.mark_ashby_application_links_erased(p_candidate_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_added  integer;
  v_listed integer;
begin
  if p_candidate_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if not exists (
    select 1 from screening_v2.data_subject_requests d
     where d.candidate_id = p_candidate_id
       and d.request_type = 'delete'
       and d.request_status in ('pending', 'in_progress', 'fulfilled')
  ) then
    return jsonb_build_object('status', 'no_erasure_request');
  end if;

  insert into screening_v2.ashby_erased_application_links (application_link_id)
  select l.id
    from screening_v2.ashby_application_links l
   where l.candidate_id = p_candidate_id
  on conflict (application_link_id) do nothing;
  get diagnostics v_added = row_count;

  select count(*)::integer into v_listed
    from screening_v2.ashby_application_links l
    join screening_v2.ashby_erased_application_links e on e.application_link_id = l.id
   where l.candidate_id = p_candidate_id;

  return jsonb_build_object('status', 'ok', 'listed', v_listed, 'added', v_added);
end;
$$;

revoke all on function screening_v2.mark_ashby_application_links_erased(uuid) from public, anon, authenticated;
grant execute on function screening_v2.mark_ashby_application_links_erased(uuid) to service_role;

comment on function screening_v2.mark_ashby_application_links_erased(uuid) is
  'lib/dsar.ts''s erasure step (M031): lists every Ashby link of the person, '
  'live or already terminal, in ashby_erased_application_links, while the '
  'candidate row still ties them to the person. Only while the person has a '
  'deletion request (pending, in progress or fulfilled); otherwise refused, '
  'listing nothing. Idempotent. Reads the links and the request, writes the '
  'list only. Service-role only.';

notify pgrst, 'reload schema';
