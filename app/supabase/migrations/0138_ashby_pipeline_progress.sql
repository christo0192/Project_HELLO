-- 0138: where an imported Ashby application goes after Christy (M031 S2).
--
-- Five NEW tables for the business-impact page
-- (.gsd/milestones/M031/BUSINESS-IMPACT-PLAN.md section 5) and one function:
--
--   ashby_stage_catalog               one row per Ashby interview stage: title,
--                                     type, plan order, group, and the milestone
--                                     (christy, r1..r5, reference, offer, hired,
--                                     archived, other) an admin or a default gave it
--   ashby_application_progress        one row per imported application: Ashby
--                                     status, current stage, archive reason, and
--                                     when the worker next reads it
--   ashby_application_stage_intervals one row per Ashby stage-history row
--   ashby_archive_reasons             Ashby's own archive-reason catalogue
--   ashby_progress_runs               one row per worker pass, counts only
--   refresh_ashby_stage_catalog()     the catalogue refresh's one write
--   set_ashby_stage_milestone()       an admin's label change, its one write
--
-- Each function writes its change AND its audit_events row in one transaction
-- (the 0031 pattern), so a catalogue change is never saved without its audit
-- row and an audit failure never leaves a change behind.
--
-- S2 writes only the catalogue. Progress, intervals, reasons and runs are
-- written by the S3 worker, behind ASHBY_PROGRESS_ENABLED (off by default).
--
-- ADDITIVE ONLY. Nothing that exists is altered, dropped, updated or deleted:
-- ashby_application_links, candidates and assessments are never written. The
-- only rows added outside the new tables are the functions' own audit rows,
-- appended to audit_events under an action chk_audit_action already admits
-- (config_changed), so that constraint is not re-created. The
-- only references to an existing table are the two foreign keys to
-- ashby_application_links, ON DELETE CASCADE like ashby_resume_ingestions and
-- ashby_operations (0029): if a link is ever deleted, its progress goes with
-- it. A DSAR erasure terminates a link rather than deleting it (lib/dsar.ts),
-- and these rows hold no personal data.
--
-- SECURITY (the 0029 posture): RLS on, no policy, no browser grant; only the
-- API's service-role client reads or writes them. The function is SECURITY
-- DEFINER with a pinned search_path, granted to service_role only.
--
-- PRIVACY: opaque Ashby ids, stage titles, Ashby's own reason catalogue, closed
-- codes, booleans, counts and timestamps. Never a name, email, phone, resume,
-- offer amount, custom field, hiring-team member, Ashby staff id (actorId) or
-- text typed about a candidate. `moved_by_person` keeps only whether a person
-- made a move, never who. Who labelled a stage is in the audit row, not here:
-- `milestone_source` is only 'admin' or 'default'.

-- Fail fast rather than queue (the 0109 precedent). This migration only
-- creates new objects, but the two foreign keys take a SHARE ROW EXCLUSIVE
-- lock on ashby_application_links, which the webhook and the workers write.
-- LOCAL: scoped to this migration's transaction.
set local lock_timeout = '10s';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ashby_stage_catalog
-- ═══════════════════════════════════════════════════════════════════════
-- Keyed on the Ashby stage id: a stage belongs to one interview plan, so a
-- plan shared by several jobs gives one row per stage. Rows are never deleted:
-- a stage that leaves a plan keeps its row (and its label), because history
-- rows still point at it. The refresh marks it instead: `not_in_plan_since`
-- is set when a read of its plan no longer lists it, and cleared if it comes
-- back, so a removed stage is never mistaken for a live one. `stage_type` is Ashby's own word (Lead,
-- PreInterviewScreen, Active, Offer, Archived, Hired, ...). The docs give
-- those as examples, not a closed list, so it is checked for shape only.
--
-- Every Ashby id in these tables is checked as `x ~ '^[A-Za-z0-9_.:-]+$' and
-- length(x) <= 256`, the API's own id rule. Never as `{1,256}`: Postgres
-- refuses a regex bound above 255, and only when the CHECK first runs, so the
-- migration would apply and every insert would then fail (SQLSTATE 2201B).

create table if not exists screening_v2.ashby_stage_catalog (
  stage_id          text primary key,
  provider          text not null default 'ashby',
  interview_plan_id text,
  title             text,
  stage_type        text,
  order_in_plan     integer,
  stage_group_id    text,
  milestone         text,
  milestone_source  text,
  milestone_set_at  timestamptz,
  source            text not null default 'plan',
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  not_in_plan_since timestamptz,
  updated_at        timestamptz not null default now(),
  constraint chk_ashby_stage_catalog_stage_id check (stage_id ~ '^[A-Za-z0-9_.:-]+$' and length(stage_id) <= 256),
  constraint chk_ashby_stage_catalog_provider check (provider = 'ashby'),
  constraint chk_ashby_stage_catalog_plan_id check (
    interview_plan_id is null or (interview_plan_id ~ '^[A-Za-z0-9_.:-]+$' and length(interview_plan_id) <= 256)),
  constraint chk_ashby_stage_catalog_title check (title is null or length(title) between 1 and 120),
  constraint chk_ashby_stage_catalog_stage_type check (stage_type is null or stage_type ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  constraint chk_ashby_stage_catalog_order check (order_in_plan is null or order_in_plan >= 0),
  constraint chk_ashby_stage_catalog_group_id check (
    stage_group_id is null or (stage_group_id ~ '^[A-Za-z0-9_.:-]+$' and length(stage_group_id) <= 256)),
  constraint chk_ashby_stage_catalog_milestone check (
    milestone is null or milestone in ('christy','r1','r2','r3','r4','r5','reference','offer','hired','archived','other')),
  constraint chk_ashby_stage_catalog_milestone_source check (
    milestone_source is null or milestone_source in ('admin','default')),
  constraint chk_ashby_stage_catalog_milestone_pair check (
    (milestone is null) = (milestone_source is null)),
  constraint chk_ashby_stage_catalog_source check (source in ('plan','history')),
  constraint chk_ashby_stage_catalog_seen check (last_seen_at >= first_seen_at),
  constraint chk_ashby_stage_catalog_not_in_plan check (
    not_in_plan_since is null or not_in_plan_since >= first_seen_at)
);

comment on table screening_v2.ashby_stage_catalog is
  'One row per Ashby interview stage (M031): title, Ashby stage type (open '
  'text), zero-indexed plan order, stage group, and the milestone the impact '
  'page counts it under. Rows are never deleted. Service-role only.';
comment on column screening_v2.ashby_stage_catalog.milestone is
  'christy, r1..r5, reference, offer, hired, archived or other; NULL = not '
  'labelled (counted as "Other, not labelled"). Every refresh recomputes a '
  'label whose source is default (or none); an admin label is never overwritten.';
comment on column screening_v2.ashby_stage_catalog.milestone_source is
  'admin or default: who set the label, as a kind. The admin who did it is in '
  'the audit row; no staff id is stored here.';
comment on column screening_v2.ashby_stage_catalog.not_in_plan_since is
  'Set by the refresh when a read of this stage''s plan no longer lists it '
  '(Ashby removed it); NULL while it is in the plan, and cleared if it comes '
  'back. The row and its label are kept for history.';
comment on column screening_v2.ashby_stage_catalog.source is
  'plan = read from jobInterviewPlan.info; history = known only from a stage '
  'history row title (S3), type and order unknown.';
comment on column screening_v2.ashby_stage_catalog.stage_type is
  'Ashby''s stage type as sent (Lead, PreInterviewScreen, Active, Offer, '
  'Archived, Hired, ...). Not a closed list: checked for shape only.';

create index if not exists idx_ashby_stage_catalog_plan
  on screening_v2.ashby_stage_catalog (interview_plan_id, order_in_plan);

alter table screening_v2.ashby_stage_catalog enable row level security;
revoke all on screening_v2.ashby_stage_catalog from anon, authenticated, public;
grant all privileges on screening_v2.ashby_stage_catalog to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. ashby_application_progress
-- ═══════════════════════════════════════════════════════════════════════
-- One row per imported application (the link). `status` is Ashby's
-- application status, a documented closed set. `next_check_at` is the
-- worker's claim order (S3: FOR UPDATE SKIP LOCKED by next_check_at).

create table if not exists screening_v2.ashby_application_progress (
  id                       uuid primary key default gen_random_uuid(),
  application_link_id      uuid not null references screening_v2.ashby_application_links(id) on delete cascade,
  status                   text,
  current_stage_id         text,
  current_stage_entered_at timestamptz,
  current_job_id           text,
  archive_reason_id        text,
  archive_reason_type      text,
  archived_at              timestamptz,
  ashby_updated_at         timestamptz,
  last_checked_at          timestamptz,
  next_check_at            timestamptz not null default now(),
  check_error_code         text,
  attempts                 integer not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint uq_ashby_application_progress_link unique (application_link_id),
  constraint chk_ashby_application_progress_status check (
    status is null or status in ('Active','Hired','Archived','Lead')),
  constraint chk_ashby_application_progress_stage check (
    current_stage_id is null or (current_stage_id ~ '^[A-Za-z0-9_.:-]+$' and length(current_stage_id) <= 256)),
  constraint chk_ashby_application_progress_job check (
    current_job_id is null or (current_job_id ~ '^[A-Za-z0-9_.:-]+$' and length(current_job_id) <= 256)),
  constraint chk_ashby_application_progress_reason check (
    archive_reason_id is null or (archive_reason_id ~ '^[A-Za-z0-9_.:-]+$' and length(archive_reason_id) <= 256)),
  constraint chk_ashby_application_progress_reason_type check (
    archive_reason_type is null or archive_reason_type ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  constraint chk_ashby_application_progress_error check (
    check_error_code is null or check_error_code ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint chk_ashby_application_progress_attempts check (attempts >= 0)
);

comment on table screening_v2.ashby_application_progress is
  'Where one imported Ashby application stands (M031): Ashby status, current '
  'stage and job, archive reason id and type, archive time, and when the '
  'progress worker reads it next. Opaque ids, codes and timestamps only; no '
  'name, email, phone, resume, custom field or hiring team. Follows its link '
  'on delete. Service-role only.';
comment on column screening_v2.ashby_application_progress.status is
  'Ashby application status: Active, Hired, Archived or Lead.';
comment on column screening_v2.ashby_application_progress.archive_reason_type is
  'Ashby reasonType as sent (RejectedByCandidate, RejectedByOrg, Other). Checked '
  'for shape only; an archive may carry no reason at all.';
comment on column screening_v2.ashby_application_progress.next_check_at is
  'Claim order for the progress worker (S3). A webhook nudge sets it to now().';
comment on column screening_v2.ashby_application_progress.check_error_code is
  'Last read failure as a sanitized code, e.g. missing_endpoint_permission.';

create index if not exists idx_ashby_application_progress_due
  on screening_v2.ashby_application_progress (next_check_at);
create index if not exists idx_ashby_application_progress_stage
  on screening_v2.ashby_application_progress (current_stage_id);
create index if not exists idx_ashby_application_progress_reason
  on screening_v2.ashby_application_progress (archive_reason_id) where archive_reason_id is not null;

alter table screening_v2.ashby_application_progress enable row level security;
revoke all on screening_v2.ashby_application_progress from anon, authenticated, public;
grant all privileges on screening_v2.ashby_application_progress to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. ashby_application_stage_intervals
-- ═══════════════════════════════════════════════════════════════════════
-- One row per Ashby stage-history row, unique on Ashby's own history id.
-- History can be edited in Ashby, so a row a later read no longer returns is
-- marked `gone_at`, never deleted. `left_at` may be NULL on the current-stage
-- row. `moved_by_person` is true when Ashby named an actor, false when it said
-- none, NULL when unknown; the actor id itself is never stored.

create table if not exists screening_v2.ashby_application_stage_intervals (
  id                  uuid primary key default gen_random_uuid(),
  application_link_id uuid not null references screening_v2.ashby_application_links(id) on delete cascade,
  history_id          text not null,
  stage_id            text not null,
  stage_title_seen    text,
  entered_at          timestamptz,
  left_at             timestamptz,
  stage_number        integer,
  moved_by_person     boolean,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  gone_at             timestamptz,
  constraint uq_ashby_application_stage_intervals_history unique (history_id),
  constraint chk_ashby_application_stage_intervals_history check (history_id ~ '^[A-Za-z0-9_.:-]+$' and length(history_id) <= 256),
  constraint chk_ashby_application_stage_intervals_stage check (stage_id ~ '^[A-Za-z0-9_.:-]+$' and length(stage_id) <= 256),
  constraint chk_ashby_application_stage_intervals_title check (
    stage_title_seen is null or length(stage_title_seen) between 1 and 120),
  constraint chk_ashby_application_stage_intervals_number check (stage_number is null or stage_number >= 0),
  constraint chk_ashby_application_stage_intervals_seen check (last_seen_at >= first_seen_at)
);

comment on table screening_v2.ashby_application_stage_intervals is
  'One row per Ashby stage-history row of an imported application (M031): '
  'stage id, the stage title as seen, entry and exit times, and whether a '
  'person made the move (true, false, NULL = unknown). The Ashby actor id is '
  'never stored. A row Ashby stops returning is marked gone_at, never deleted. '
  'Follows its link on delete. Service-role only.';
comment on column screening_v2.ashby_application_stage_intervals.moved_by_person is
  'true when the history row named an actor, false when it named none, NULL '
  'when unknown. Never the actor id.';
comment on column screening_v2.ashby_application_stage_intervals.gone_at is
  'Set when a later read of the history no longer returns this row (edited in Ashby).';

create index if not exists idx_ashby_application_stage_intervals_link
  on screening_v2.ashby_application_stage_intervals (application_link_id, entered_at);
create index if not exists idx_ashby_application_stage_intervals_stage
  on screening_v2.ashby_application_stage_intervals (stage_id);

alter table screening_v2.ashby_application_stage_intervals enable row level security;
revoke all on screening_v2.ashby_application_stage_intervals from anon, authenticated, public;
grant all privileges on screening_v2.ashby_application_stage_intervals to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. ashby_archive_reasons
-- ═══════════════════════════════════════════════════════════════════════
-- Ashby's own reason catalogue ("Not a fit"), as carried inline on an
-- archived application or listed by archiveReason.list. Never text typed
-- about one candidate.

create table if not exists screening_v2.ashby_archive_reasons (
  reason_id     text primary key,
  text          text,
  reason_type   text,
  is_archived   boolean,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint chk_ashby_archive_reasons_id check (reason_id ~ '^[A-Za-z0-9_.:-]+$' and length(reason_id) <= 256),
  constraint chk_ashby_archive_reasons_text check (text is null or length(text) between 1 and 200),
  constraint chk_ashby_archive_reasons_type check (reason_type is null or reason_type ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  constraint chk_ashby_archive_reasons_seen check (last_seen_at >= first_seen_at)
);

comment on table screening_v2.ashby_archive_reasons is
  'Ashby''s archive-reason catalogue (M031): reason id, its catalogue text, '
  'reasonType and whether Ashby archived the reason. Organisation-wide '
  'configuration, never text typed about one candidate. Service-role only.';

alter table screening_v2.ashby_archive_reasons enable row level security;
revoke all on screening_v2.ashby_archive_reasons from anon, authenticated, public;
grant all privileges on screening_v2.ashby_archive_reasons to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ashby_progress_runs
-- ═══════════════════════════════════════════════════════════════════════
-- One row per progress-worker pass or backfill: counts and error codes only.

create table if not exists screening_v2.ashby_progress_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  checked        integer not null default 0,
  changed        integer not null default 0,
  errors_by_code jsonb not null default '{}'::jsonb,
  mode           text not null,
  constraint chk_ashby_progress_runs_mode check (mode in ('sweep','backfill')),
  constraint chk_ashby_progress_runs_finished check (finished_at is null or finished_at >= started_at),
  constraint chk_ashby_progress_runs_checked check (checked >= 0),
  constraint chk_ashby_progress_runs_changed check (changed >= 0 and changed <= checked),
  constraint chk_ashby_progress_runs_errors check (
    jsonb_typeof(errors_by_code) = 'object' and octet_length(errors_by_code::text) <= 2048)
);

comment on table screening_v2.ashby_progress_runs is
  'One row per Ashby progress pass (M031): start, finish, applications '
  'checked and changed, and failures counted by sanitized code. No ids. '
  'Service-role only.';

create index if not exists idx_ashby_progress_runs_started
  on screening_v2.ashby_progress_runs (started_at desc);

alter table screening_v2.ashby_progress_runs enable row level security;
revoke all on screening_v2.ashby_progress_runs from anon, authenticated, public;
grant all privileges on screening_v2.ashby_progress_runs to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. refresh_ashby_stage_catalog: the catalogue refresh's one write
-- ═══════════════════════════════════════════════════════════════════════
-- p_stages: a JSON array of {stage_id, interview_plan_id, title, stage_type,
-- order_in_plan, stage_group_id, default_milestone}, as the API read them from
-- jobInterviewPlan.info. Each stage is inserted, or its plan fields are
-- refreshed (a NULL keeps what is stored), last_seen_at moves on and source
-- becomes 'plan'.
--
-- MILESTONES. `default_milestone` is what the API's rules give the stage as
-- the plan stands NOW (stage-catalog.ts defaultMilestone). A label an admin
-- set (milestone_source = 'admin') is never touched. Every other label follows
-- the rules on every refresh: a stage first given a default (`defaulted`), or
-- one whose default moved because Ashby renamed or retyped it or a mapping's
-- Christy stage moved (`redefaulted`), to the new default or to none. So a
-- stored 'default' is always what the rules say today, and two stages never
-- keep the same default label after a rename. The admin test is made under the
-- row lock, so a label racing a refresh is never overwritten. Nothing is ever
-- deleted.
--
-- LEFT THE PLAN. A stage of a plan this call read (a non-NULL
-- interview_plan_id in p_stages) that the call does not list is marked
-- `not_in_plan_since` (`left_plan` counts the newly marked); one listed again
-- is cleared. A plan whose read failed is not in the call, so its stages are
-- never judged.
--
-- AUDIT. p_actor_id is the admin whose request ran the refresh; it is
-- required. The one audit_events row (config_changed, target
-- ashby_stage_catalog/refresh) carries the counts, in this transaction. A
-- refusal changes nothing and writes no row. Answers counts only.

create or replace function screening_v2.refresh_ashby_stage_catalog(p_stages jsonb, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_inserted    integer := 0;
  v_updated     integer := 0;
  v_defaulted   integer := 0;
  v_redefaulted integer := 0;
  v_id          text;
  v_had         text;
  v_had_source  text;
  v_left        integer := 0;
  r             record;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' then
    return jsonb_build_object('status', 'invalid_stages');
  end if;
  if jsonb_array_length(p_stages) > 500 then
    return jsonb_build_object('status', 'too_many_stages');
  end if;
  -- Refuse the whole call before any write: one bad default must not land half a refresh.
  if exists (
    select 1 from jsonb_to_recordset(p_stages) as x(default_milestone text)
     where x.default_milestone is not null
       and x.default_milestone not in ('christy','r1','r2','r3','r4','r5','reference','offer','hired','archived','other')
  ) then
    return jsonb_build_object('status', 'invalid_default_milestone');
  end if;

  for r in
    select * from jsonb_to_recordset(p_stages) as x(
      stage_id text, interview_plan_id text, title text, stage_type text,
      order_in_plan integer, stage_group_id text, default_milestone text)
  loop
    v_id := null;
    insert into screening_v2.ashby_stage_catalog as c
      (stage_id, interview_plan_id, title, stage_type, order_in_plan, stage_group_id,
       milestone, milestone_source, milestone_set_at, source)
    values
      (r.stage_id, r.interview_plan_id, r.title, r.stage_type, r.order_in_plan, r.stage_group_id,
       r.default_milestone,
       case when r.default_milestone is not null then 'default' end,
       case when r.default_milestone is not null then now() end,
       'plan')
    on conflict (stage_id) do nothing
    returning c.stage_id into v_id;

    if v_id is not null then
      v_inserted := v_inserted + 1;
      if r.default_milestone is not null then
        v_defaulted := v_defaulted + 1;
      end if;
      continue;
    end if;

    -- The row exists: lock it, so a concurrent label waits for this update
    -- (or this one for it) and the admin test below sees the committed label.
    select c.milestone, c.milestone_source into v_had, v_had_source
      from screening_v2.ashby_stage_catalog c
     where c.stage_id = r.stage_id
       for update;

    update screening_v2.ashby_stage_catalog as c set
      interview_plan_id = coalesce(r.interview_plan_id, c.interview_plan_id),
      title             = coalesce(r.title, c.title),
      stage_type        = coalesce(r.stage_type, c.stage_type),
      order_in_plan     = coalesce(r.order_in_plan, c.order_in_plan),
      stage_group_id    = coalesce(r.stage_group_id, c.stage_group_id),
      -- An admin label stays; any other label is the rules' answer today.
      milestone         = case when c.milestone_source = 'admin' then c.milestone
                               else r.default_milestone end,
      milestone_source  = case when c.milestone_source = 'admin' then c.milestone_source
                               when r.default_milestone is not null then 'default' end,
      milestone_set_at  = case when c.milestone_source = 'admin'
                                 or c.milestone is not distinct from r.default_milestone then c.milestone_set_at
                               when r.default_milestone is null then null
                               else now() end,
      source            = 'plan',
      last_seen_at      = greatest(now(), c.first_seen_at),
      not_in_plan_since = null,
      updated_at        = now()
     where c.stage_id = r.stage_id;

    v_updated := v_updated + 1;
    if v_had_source is distinct from 'admin' and v_had is distinct from r.default_milestone then
      if v_had is null then
        v_defaulted := v_defaulted + 1;
      else
        v_redefaulted := v_redefaulted + 1;
      end if;
    end if;
  end loop;

  -- A plan this call read no longer lists these stages: mark them, never delete.
  update screening_v2.ashby_stage_catalog as c set
      not_in_plan_since = greatest(now(), c.first_seen_at),
      updated_at        = now()
   where c.not_in_plan_since is null
     and c.interview_plan_id in (
       select x.interview_plan_id from jsonb_to_recordset(p_stages) as x(interview_plan_id text)
        where x.interview_plan_id is not null)
     and not exists (
       select 1 from jsonb_to_recordset(p_stages) as y(stage_id text) where y.stage_id = c.stage_id);
  get diagnostics v_left = row_count;

  -- The refresh's audit row, in its transaction: counts only, no id or title.
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'config_changed', 'ashby_stage_catalog', 'refresh', 'success',
     jsonb_build_object('resource', 'ashby_stage_catalog_refresh', 'stages', jsonb_array_length(p_stages),
                        'inserted', v_inserted, 'updated', v_updated, 'defaulted', v_defaulted,
                        'redefaulted', v_redefaulted, 'left_plan', v_left));

  return jsonb_build_object('status', 'ok', 'inserted', v_inserted, 'updated', v_updated,
                            'defaulted', v_defaulted, 'redefaulted', v_redefaulted, 'left_plan', v_left);
end;
$$;

revoke all on function screening_v2.refresh_ashby_stage_catalog(jsonb, uuid) from public, anon, authenticated;
grant execute on function screening_v2.refresh_ashby_stage_catalog(jsonb, uuid) to service_role;

comment on function screening_v2.refresh_ashby_stage_catalog(jsonb, uuid) is
  'Upserts the Ashby stage catalogue from a plan read (M031): inserts new '
  'stages, refreshes plan fields, and sets every label an admin did not set to '
  'the default the API computed for the plan as it stands (or to none); an '
  'admin label is never overwritten. Marks a stage a plan it read no longer '
  'lists (not_in_plan_since) and never deletes. Answers inserted, updated, '
  'defaulted, redefaulted and left_plan counts, and writes its audit row in '
  'the same transaction. Service-role only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. set_ashby_stage_milestone: an admin's label change, its one write
-- ═══════════════════════════════════════════════════════════════════════
-- p_milestone: one of the milestones, or NULL for no label. p_milestone_source:
-- 'admin' for a label the admin chose, 'default' when the admin cleared their
-- label and the API computed the stage's default, NULL exactly when
-- p_milestone is NULL. The row is locked, written, and its audit_events row
-- (config_changed, target ashby_stage/<stage id>, the label before and after
-- and the kinds of setter) inserted in this transaction. The admin is the
-- audit row's actor, never a catalogue column. A refusal changes nothing and
-- writes no row. Answers the label it replaced and the row as now stored.

create or replace function screening_v2.set_ashby_stage_milestone(
  p_stage_id text, p_milestone text, p_milestone_source text, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_from screening_v2.ashby_stage_catalog%rowtype;
  v_to   screening_v2.ashby_stage_catalog%rowtype;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_milestone is not null
     and p_milestone not in ('christy','r1','r2','r3','r4','r5','reference','offer','hired','archived','other') then
    return jsonb_build_object('status', 'invalid_milestone');
  end if;
  if (p_milestone is null) <> (p_milestone_source is null)
     or (p_milestone_source is not null and p_milestone_source not in ('admin','default')) then
    return jsonb_build_object('status', 'invalid_milestone_source');
  end if;

  select * into v_from from screening_v2.ashby_stage_catalog where stage_id = p_stage_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  update screening_v2.ashby_stage_catalog set
      milestone        = p_milestone,
      milestone_source = p_milestone_source,
      milestone_set_at = case when p_milestone is null then null else now() end,
      updated_at       = now()
   where stage_id = p_stage_id
  returning * into v_to;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'config_changed', 'ashby_stage', p_stage_id, 'success',
     jsonb_build_object('resource', 'ashby_stage_catalog', 'stage_id', p_stage_id,
                        'milestone_from', v_from.milestone, 'milestone_source_from', v_from.milestone_source,
                        'milestone_to', v_to.milestone, 'milestone_source', v_to.milestone_source));

  return jsonb_build_object(
    'status', 'ok',
    'milestone_from', v_from.milestone,
    'stage', jsonb_build_object(
      'stage_id', v_to.stage_id, 'interview_plan_id', v_to.interview_plan_id, 'title', v_to.title,
      'stage_type', v_to.stage_type, 'order_in_plan', v_to.order_in_plan, 'stage_group_id', v_to.stage_group_id,
      'milestone', v_to.milestone, 'milestone_source', v_to.milestone_source, 'source', v_to.source,
      'not_in_plan_since', v_to.not_in_plan_since));
end;
$$;

revoke all on function screening_v2.set_ashby_stage_milestone(text, text, text, uuid) from public, anon, authenticated;
grant execute on function screening_v2.set_ashby_stage_milestone(text, text, text, uuid) to service_role;

comment on function screening_v2.set_ashby_stage_milestone(text, text, text, uuid) is
  'Sets one Ashby stage''s milestone (M031): a label an admin chose (admin), '
  'the default the API computed when the admin cleared theirs (default), or '
  'none, and writes its audit row (the label before and after) in the same '
  'transaction. The actor is the audit row''s, never a catalogue column. '
  'Service-role only.';

notify pgrst, 'reload schema';
