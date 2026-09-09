-- =====================================================================
-- 0090 — Funnel observability & monitoring
-- ---------------------------------------------------------------------
-- The pipeline already emits rich per-stage operational data (resume
-- parse -> dial/connect -> consent -> Q&A -> scorecard -> Ashby stage),
-- but nothing aggregates or persists it: every "funnel" today is computed
-- client-side from list endpoints and stored nowhere. This migration adds
-- the OBSERVABILITY layer as DERIVED artifacts over the existing tables,
-- so there is no second writer to drift from the operational truth:
--
--   * v_funnel_candidate  one row per candidate, every stage + a single
--                         consolidated drop reason. The live source of
--                         truth for per-candidate drill-down.
--   * v_funnel_intake     one row per resume-parser intake event (parsed
--                         candidates + ingestion failures + sync-path
--                         failures), so "total in / parsed / needs-review
--                         / failed" has an honest denominator.
--   * v_funnel_failures   the unified failure taxonomy across every stage
--                         ({stage, code, entity_id, occurred_at}) — the
--                         one place to watch when a pipeline stage fails.
--   * funnel_stage_daily  a STORED daily rollup (cohort_day, role_id) the
--                         refresh RPC recomputes on a cadence. It survives
--                         operational-table retention and powers trends.
--
-- Plus four capture-gap fixes the observability layer needs:
--   * ashby_job_mappings.reference_check_stage_id — the north-star success
--     metric ("reached reference check") has no representation today. This
--     is the PLACEHOLDER column; detection stays unwired until an operator
--     supplies the per-job stage id and the candidateStageChange webhook is
--     pointed at it (a later PR). Until then reached_reference_check is
--     always false.
--   * resume_intake_failures — the recruiter sync-upload path returns an
--     HTTP error and deletes the file on a parse failure, leaving NO row.
--     This append-only table captures those (sanitized code only) so the
--     denominator is not silently short on that path.
--   * funnel_role_class() — a read-only analytics classifier that buckets a
--     parsed title into a coarse domain. It is DELIBERATELY independent of
--     the phone runtime's role-class lexicon: this one only labels rows for
--     reporting and never influences screening, so it is defined here in
--     full rather than coupled to the speech-path classifier.
--
-- Everything is service-role-only (RLS on, revoked from anon/authenticated,
-- granted to service_role) and stores IDs + sanitized codes + counts +
-- timestamps only — never transcript text or PII, matching the content-free
-- discipline of call_sessions.observability (0082) and the sanitized
-- failed_reason codes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. funnel_role_class — read-only domain bucketing for reporting.
-- ---------------------------------------------------------------------
-- Order matters: the more specific classes are tested BEFORE the general
-- ones (so "data engineer" -> data, "engineering manager" -> engineering),
-- and 'management' is last so a plain "manager" falls through to it while a
-- functional title keeps its function. NULL/blank -> 'unknown'.
create or replace function screening_v2.funnel_role_class(p_title text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_title is null or btrim(p_title) = '' then 'unknown'
    when lower(p_title) ~ '(data scien|machine learning|ml engineer|data engineer|analytics|data analyst|statistician|ai engineer)' then 'data'
    when lower(p_title) ~ '(devops|sre|site reliability|infrastructure|platform engineer|cloud engineer)' then 'devops'
    when lower(p_title) ~ '(software|developer|engineer|programmer|full.?stack|back.?end|front.?end|sdet|qa engineer|architect|mobile|android|ios)' then 'engineering'
    when lower(p_title) ~ '(product manager|product owner|program manager|project manager|scrum master)' then 'product'
    when lower(p_title) ~ '(designer|ux|ui|user experience|creative director)' then 'design'
    when lower(p_title) ~ '(sales|account executive|business development|\mbdr\M|\msdr\M|account manager)' then 'sales'
    when lower(p_title) ~ '(marketing|\mseo\M|content|growth|social media|brand)' then 'marketing'
    when lower(p_title) ~ '(finance|account|audit|financial|controller|bookkeep)' then 'finance'
    when lower(p_title) ~ '(recruit|talent|human resource|people ops|\mhr\M)' then 'hr'
    when lower(p_title) ~ '(support|customer success|customer service|help ?desk)' then 'support'
    when lower(p_title) ~ '(operations|logistics|supply chain|\mops\M)' then 'operations'
    when lower(p_title) ~ '(manager|director|head of|\mvp\M|vice president|chief|lead)' then 'management'
    else 'other'
  end
$$;

comment on function screening_v2.funnel_role_class(text) is
  'Read-only analytics classifier: buckets a parsed job title into a coarse '
  'domain (data/devops/engineering/product/design/sales/marketing/finance/hr/'
  'support/operations/management/other, or unknown). Independent of the phone '
  'runtime role-class lexicon by design — it labels rows for reporting only and '
  'never affects screening behaviour.';

-- Service-role-only, matching every other function in this schema. It is a
-- pure immutable classifier of the caller's own input (no data access), but
-- leaving the default PUBLIC EXECUTE would be a gratuitous compute surface for
-- any signed-in role on a PostgREST-exposed schema whose whole discipline is
-- service-role-only.
revoke all on function screening_v2.funnel_role_class(text) from public;
grant execute on function screening_v2.funnel_role_class(text) to service_role;

-- ---------------------------------------------------------------------
-- 2. reference_check_stage_id — the placeholder success-metric slot.
-- ---------------------------------------------------------------------
alter table screening_v2.ashby_job_mappings
  add column if not exists reference_check_stage_id text;

alter table screening_v2.ashby_job_mappings
  drop constraint if exists chk_ashby_job_mappings_reference_stage_id;
alter table screening_v2.ashby_job_mappings
  add constraint chk_ashby_job_mappings_reference_stage_id check (
    reference_check_stage_id is null or length(reference_check_stage_id) between 1 and 256);

comment on column screening_v2.ashby_job_mappings.reference_check_stage_id is
  'PLACEHOLDER for the north-star success metric. When set to the Ashby stage '
  'id that means "reference check" for this job, v_funnel_candidate marks a '
  'candidate reached_reference_check once ashby_application_links.external_stage_id '
  'equals it. NULL (default) leaves the metric unwired: reached_reference_check '
  'stays false. No behaviour depends on it until an operator populates it.';

-- ---------------------------------------------------------------------
-- 3. resume_intake_failures — sync-path parse-failure capture (gap 1).
-- ---------------------------------------------------------------------
create table if not exists screening_v2.resume_intake_failures (
  id            uuid primary key default gen_random_uuid(),
  role_id       uuid references screening_v2.roles(id) on delete set null,
  failed_reason text not null,
  source        text not null default 'recruiter_upload',
  occurred_at   timestamptz not null default now(),
  -- Sanitized stable code only — never provider text, an error string, or
  -- anything derived from resume content. Same shape as engagement reasons.
  constraint chk_resume_intake_failures_reason check (failed_reason ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint chk_resume_intake_failures_source check (source in ('recruiter_upload'))
);

create index if not exists idx_resume_intake_failures_day
  on screening_v2.resume_intake_failures (occurred_at);
create index if not exists idx_resume_intake_failures_role
  on screening_v2.resume_intake_failures (role_id);

comment on table screening_v2.resume_intake_failures is
  'Append-only capture of recruiter sync-upload (POST /api/resumes) parse '
  'failures, which otherwise leave no row (the route returns an HTTP error and '
  'deletes the stored file). Sanitized failure CODE only, plus the role it was '
  'uploaded against and when. No candidate row exists for these — the parse '
  'never produced one. Service-role-only; never PII or resume content.';

alter table screening_v2.resume_intake_failures enable row level security;
revoke all on screening_v2.resume_intake_failures from anon, authenticated, public;
grant all privileges on screening_v2.resume_intake_failures to service_role;

-- ---------------------------------------------------------------------
-- 4. funnel_stage_daily — the stored daily rollup.
-- ---------------------------------------------------------------------
-- Grain (cohort_day, role_id): cohort_day is the intake day (a candidate's
-- created_at, or a failure's occurred_at). role_id may be NULL (a candidate
-- whose role FK was cleared, or a sync failure with no role) and that NULL
-- bucket is legitimate. The refresh RPC recomputes a trailing window by
-- delete+insert, so no upsert key over a nullable column is needed.
create table if not exists screening_v2.funnel_stage_daily (
  id                       uuid primary key default gen_random_uuid(),
  cohort_day               date not null,
  role_id                  uuid,
  -- resume-parser intake
  entered_parse            integer not null default 0,
  parsed_ok                integer not null default 0,
  needs_review             integer not null default 0,
  parse_failed             integer not null default 0,
  -- candidate-cohort stages
  dialed                   integer not null default 0,
  connected                integer not null default 0,
  consent_passed           integer not null default 0,
  consent_dropped          integer not null default 0,
  answered_ge1             integer not null default 0,
  scored                   integer not null default 0,
  qualified                integer not null default 0,
  on_hold                  integer not null default 0,
  disqualified             integer not null default 0,
  human_review             integer not null default 0,
  reached_reference_check  integer not null default 0,
  -- call economics + timing
  attempts_total           integer not null default 0,
  connects_total           integer not null default 0,
  total_call_seconds       bigint  not null default 0,
  median_ttfc_sec          numeric,
  p95_ttfc_sec             numeric,
  refreshed_at             timestamptz not null default now(),
  constraint chk_funnel_stage_daily_nonneg check (
    entered_parse >= 0 and parsed_ok >= 0 and needs_review >= 0 and parse_failed >= 0
    and dialed >= 0 and connected >= 0 and consent_passed >= 0 and consent_dropped >= 0
    and answered_ge1 >= 0 and scored >= 0 and qualified >= 0 and on_hold >= 0
    and disqualified >= 0 and human_review >= 0 and reached_reference_check >= 0
    and attempts_total >= 0 and connects_total >= 0 and total_call_seconds >= 0)
);

-- Hard grain guarantee: at most one row per (cohort_day, role_id), with the
-- NULL-role bucket treated as a single value (PG15+ NULLS NOT DISTINCT). The
-- refresh RPC's delete-window+insert produces exactly one row per grain key, so
-- this never conflicts during a refresh; it exists to make a stray manual
-- insert fail loudly instead of silently double-counting the summary. It also
-- serves cohort_day-prefix scans, so no separate day index is needed.
create unique index if not exists uq_funnel_stage_daily_grain
  on screening_v2.funnel_stage_daily (cohort_day, role_id) nulls not distinct;
create index if not exists idx_funnel_stage_daily_role
  on screening_v2.funnel_stage_daily (role_id);

comment on table screening_v2.funnel_stage_daily is
  'Stored daily funnel rollup, grain (cohort_day, role_id). Recomputed by '
  'screening_v2.refresh_funnel_rollup over a trailing window (delete+insert), '
  'so it is a derived snapshot of the operational tables that also survives '
  'their retention. Counts + timings only; no PII. Read via an admin API.';

alter table screening_v2.funnel_stage_daily enable row level security;
revoke all on screening_v2.funnel_stage_daily from anon, authenticated, public;
grant all privileges on screening_v2.funnel_stage_daily to service_role;

-- ---------------------------------------------------------------------
-- 4b. Supporting indexes for the funnel read paths.
-- ---------------------------------------------------------------------
-- The `psess` CTE in v_funnel_candidate semi-joins call_sessions to
-- phone_call_attempts on session_id — a FK (0042) that carried NO index, so
-- every candidate-view build (and the FK's on-delete-set-null maintenance)
-- scanned phone_call_attempts. This is the single hottest missing index.
create index if not exists idx_phone_call_attempts_session
  on screening_v2.phone_call_attempts (session_id) where session_id is not null;

-- Small partial indexes for the failure-taxonomy sources, so a stage/date-
-- bounded v_funnel_failures query does not seq-scan the operational tables.
create index if not exists idx_phone_call_attempts_egress_failed
  on screening_v2.phone_call_attempts (ended_at) where egress_status = 'failed';
create index if not exists idx_phone_call_attempts_failure_outcome
  on screening_v2.phone_call_attempts (ended_at)
  where outcome_class in ('provider_error', 'wrong_number');
create index if not exists idx_assessments_incomplete_evidence
  on screening_v2.assessments (created_at) where scoring_status = 'incomplete_evidence';

-- ---------------------------------------------------------------------
-- 5. v_funnel_intake — one row per resume-parser intake event.
-- ---------------------------------------------------------------------
-- Successful parses ARE the candidate rows (both intake paths persist a
-- candidate only on success), so 'parsed' comes from candidates. Failures
-- come from the two failure sources; a 'ready' ingestion is intentionally
-- NOT counted here (it already appears as its candidate) so nothing is
-- double-counted.
create or replace view screening_v2.v_funnel_intake
  with (security_invoker = true) as
  select
    c.id::text                    as entity_id,
    'candidate'::text             as entity_kind,
    c.created_at                  as occurred_at,
    c.role_id                     as role_id,
    'parsed'::text                as outcome,
    null::text                    as failed_reason,
    (c.phone_valid is not true)   as missing_phone
  from screening_v2.candidates c
  union all
  select
    i.id::text,
    'ashby_ingestion'::text,
    i.updated_at,
    jm.role_id,
    'needs_review'::text,
    case when i.failed_reason ~ '^[a-z0-9_.:-]{1,64}$' then i.failed_reason else 'other' end,
    null::boolean
  from screening_v2.ashby_resume_ingestions i
  join screening_v2.ashby_application_links l on l.id = i.application_link_id
  left join screening_v2.ashby_job_mappings jm on jm.id = l.job_mapping_id
  where i.state = 'failed_review'
  union all
  select
    f.id::text,
    'recruiter_upload'::text,
    f.occurred_at,
    f.role_id,
    'failed'::text,
    f.failed_reason,
    null::boolean
  from screening_v2.resume_intake_failures f;

comment on view screening_v2.v_funnel_intake is
  'Resume-parser intake events: parsed candidates (outcome=parsed), Ashby '
  'ingestions in failed_review (outcome=needs_review, with the sanitized '
  'failed_reason bucket), and recruiter sync-upload failures (outcome=failed). '
  'Ready ingestions are represented by their candidate row, never here.';

revoke all on screening_v2.v_funnel_intake from anon, authenticated, public;
grant select on screening_v2.v_funnel_intake to service_role;

-- ---------------------------------------------------------------------
-- 6. v_funnel_candidate — one row per candidate, all stages.
-- ---------------------------------------------------------------------
-- Each one-to-many dimension is pre-aggregated in its own CTE keyed by
-- candidate BEFORE the joins, so a candidate with N attempts and M sessions
-- yields exactly one row, not N*M. A "phone session" is a call_session bound
-- to a phone attempt (psess), which excludes browser sessions cleanly.
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
    select distinct on (candidate_id)
           candidate_id, recommendation, scoring_status, overall_score,
           weighted_score_5, partial
    from screening_v2.assessments
    order by candidate_id, created_at desc, id desc
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
  'the source of truth for per-candidate drill-down. Counts/flags only, no PII.';

revoke all on screening_v2.v_funnel_candidate from anon, authenticated, public;
grant select on screening_v2.v_funnel_candidate to service_role;

-- ---------------------------------------------------------------------
-- 7. v_funnel_failures — unified failure taxonomy across every stage.
-- ---------------------------------------------------------------------
create or replace view screening_v2.v_funnel_failures
  with (security_invoker = true) as
  select 'resume_parse'::text as stage,
         -- ashby_resume_ingestions.failed_reason is length-bounded but NOT
         -- char-class-constrained (0029), so guarantee the "sanitized code"
         -- contract structurally here rather than trusting the writer.
         case when i.failed_reason ~ '^[a-z0-9_.:-]{1,64}$' then i.failed_reason else 'other' end as code,
         i.id::text as entity_id, i.updated_at as occurred_at
  from screening_v2.ashby_resume_ingestions i
  where i.state = 'failed_review' and i.failed_reason is not null
  union all
  select 'resume_parse'::text, f.failed_reason, f.id::text, f.occurred_at
  from screening_v2.resume_intake_failures f
  union all
  select 'dial'::text, a.outcome_class, a.id::text, coalesce(a.ended_at, a.admitted_at)
  from screening_v2.phone_call_attempts a
  where a.outcome_class in ('provider_error', 'wrong_number')
  union all
  select 'recording'::text, 'egress_failed'::text, a.id::text, coalesce(a.ended_at, a.admitted_at)
  from screening_v2.phone_call_attempts a
  where a.egress_status = 'failed'
  union all
  select 'call'::text, c.terminal_reason, c.id::text, coalesce(c.ended_at, c.started_at)
  from screening_v2.call_sessions c
  where c.status = 'failed' and c.terminal_reason is not null
  union all
  select 'scoring'::text, 'incomplete_evidence'::text, a2.id::text, a2.created_at
  from screening_v2.assessments a2
  where a2.scoring_status = 'incomplete_evidence';

comment on view screening_v2.v_funnel_failures is
  'Unified failure taxonomy {stage, code, entity_id, occurred_at} across resume '
  'parse (ingestion + sync-upload), dial (provider_error/wrong_number), recording '
  '(egress_failed), call (failed-family terminal_reason), and scoring '
  '(incomplete_evidence). The one surface to watch for any stage failing. All '
  'codes are already sanitized; safe to aggregate directly.';

revoke all on screening_v2.v_funnel_failures from anon, authenticated, public;
grant select on screening_v2.v_funnel_failures to service_role;

-- ---------------------------------------------------------------------
-- 8. refresh_funnel_rollup — recompute the stored daily rollup.
-- ---------------------------------------------------------------------
-- SECURITY DEFINER + service-role-only. Guarded by a transaction-level
-- advisory lock so two Fly replicas cannot recompute the same window at
-- once (the second returns 'busy' and does no work — auto_start_machines
-- means the replica count is not ours to assume). Bounded work per call: it
-- only touches cohort_day >= now - window. It writes NO audit row — a 15-min
-- recompute would bloat the audit trail; refreshed_at + the scheduler's own
-- health are the observability for this loop.
--
-- COHORT-DAY ATTRIBUTION (and its window implication). Every candidate's stage
-- flags are attributed to their INTAKE day (cohort_day = created_at::date), so
-- a recompute only refreshes cohorts whose intake day is within the window. A
-- candidate who advances or (once wired) reaches reference check LATER than
-- `p_window_days` after intake has aged out of the window and its stored row
-- will not pick up that late conversion. This is acceptable while
-- reached_reference_check is an unwired placeholder. WHEN reference check is
-- wired, the operator must set FUNNEL_ROLLUP_WINDOW_DAYS to exceed the typical
-- intake→reference-check lifecycle, or run a periodic wide recompute (POST
-- /api/admin/funnel/refresh accepts window_days up to 3650), so
-- qualified→reference_check conversion is not structurally undercounted.
create or replace function screening_v2.refresh_funnel_rollup(
  p_now         timestamptz default now(),
  p_window_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_window_start date := (p_now - make_interval(days => greatest(1, least(p_window_days, 3650))))::date;
  v_rows integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('screening_v2.funnel_rollup_refresh')) then
    return jsonb_build_object('status', 'busy');
  end if;

  delete from screening_v2.funnel_stage_daily where cohort_day >= v_window_start;

  insert into screening_v2.funnel_stage_daily (
    cohort_day, role_id,
    entered_parse, parsed_ok, needs_review, parse_failed,
    dialed, connected, consent_passed, consent_dropped, answered_ge1,
    scored, qualified, on_hold, disqualified, human_review, reached_reference_check,
    attempts_total, connects_total, total_call_seconds, median_ttfc_sec, p95_ttfc_sec
  )
  with intake as (
    select (occurred_at)::date as day, role_id,
           count(*)                                          as entered_parse,
           count(*) filter (where outcome = 'parsed')        as parsed_ok,
           count(*) filter (where outcome = 'needs_review')  as needs_review,
           count(*) filter (where outcome = 'failed')        as parse_failed
    from screening_v2.v_funnel_intake
    where (occurred_at)::date >= v_window_start
    group by 1, 2
  ),
  cohort as (
    select cohort_day as day, role_id,
           count(*) filter (where dialed)                    as dialed,
           count(*) filter (where connected)                 as connected,
           count(*) filter (where consent_passed)            as consent_passed,
           count(*) filter (where consent_dropped)           as consent_dropped,
           count(*) filter (where answered_ge1)              as answered_ge1,
           count(*) filter (where scored)                    as scored,
           count(*) filter (where qualified)                 as qualified,
           count(*) filter (where on_hold)                   as on_hold,
           count(*) filter (where disqualified)              as disqualified,
           count(*) filter (where human_review)              as human_review,
           count(*) filter (where reached_reference_check)   as reached_reference_check,
           coalesce(sum(attempts_total), 0)                  as attempts_total,
           coalesce(sum(connects_total), 0)                  as connects_total,
           coalesce(sum(total_call_seconds), 0)              as total_call_seconds,
           percentile_cont(0.5)  within group (order by time_to_first_connect_sec)  as median_ttfc_sec,
           percentile_cont(0.95) within group (order by time_to_first_connect_sec)  as p95_ttfc_sec
    from screening_v2.v_funnel_candidate
    where cohort_day >= v_window_start
    group by 1, 2
  )
  select
    coalesce(i.day, ch.day),
    coalesce(i.role_id, ch.role_id),
    coalesce(i.entered_parse, 0), coalesce(i.parsed_ok, 0),
    coalesce(i.needs_review, 0), coalesce(i.parse_failed, 0),
    coalesce(ch.dialed, 0), coalesce(ch.connected, 0), coalesce(ch.consent_passed, 0),
    coalesce(ch.consent_dropped, 0), coalesce(ch.answered_ge1, 0),
    coalesce(ch.scored, 0), coalesce(ch.qualified, 0), coalesce(ch.on_hold, 0),
    coalesce(ch.disqualified, 0), coalesce(ch.human_review, 0),
    coalesce(ch.reached_reference_check, 0),
    coalesce(ch.attempts_total, 0), coalesce(ch.connects_total, 0),
    coalesce(ch.total_call_seconds, 0), ch.median_ttfc_sec, ch.p95_ttfc_sec
  from intake i
  full outer join cohort ch
    on i.day = ch.day and i.role_id is not distinct from ch.role_id;

  get diagnostics v_rows = row_count;
  return jsonb_build_object(
    'status', 'ok',
    'rows', v_rows,
    'window_start', v_window_start
  );
end;
$$;

revoke all on function screening_v2.refresh_funnel_rollup(timestamptz, integer) from public;
grant execute on function screening_v2.refresh_funnel_rollup(timestamptz, integer) to service_role;

comment on function screening_v2.refresh_funnel_rollup(timestamptz, integer) is
  'Recomputes screening_v2.funnel_stage_daily for a trailing window '
  '(delete+insert), advisory-locked so concurrent replicas do not duplicate '
  'work (a losing caller returns status=busy). Idempotent. Reads the derived '
  'views only; writes counts/timings, never PII.';
