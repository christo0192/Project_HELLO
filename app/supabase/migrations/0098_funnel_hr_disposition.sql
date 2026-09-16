-- 0098_funnel_hr_disposition.sql
--
-- WHAT HR DID with a candidate the bot already screened.
--
-- 0090 records `reached_reference_check` — useful, but on its own it cannot
-- answer the question an HR head actually asks, because "not at Reference
-- Check" conflates two completely different situations:
--
--   * HR looked at this candidate and moved them somewhere else  → a decision
--   * HR has not opened this candidate yet                       → a backlog
--
-- Counting the second as a rejection makes the rejection rate a function of
-- how recently the bot ran, so it spikes every time screening speeds up and
-- drifts downward as the team works through the queue. It is exactly the kind
-- of number that reads as an insight and is actually an artefact.
--
-- This migration adds the third state explicitly. `hr_state` is derived from
-- the CURRENT Ashby stage on the application link, compared against the two
-- stage ids the job mapping already stores:
--
--   qualified     current stage = mapping.reference_check_stage_id
--   awaiting      current stage = mapping.ai_screening_stage_id  (untouched)
--   disqualified  bot-decided, and HR has moved them to some OTHER stage
--   null          the bot has not produced an assessment yet, so there is
--                 nothing for HR to have acted on
--
-- KNOWN LIMIT, stated so nobody mistakes it for precision: the link carries
-- only the CURRENT stage, not a stage history. A candidate promoted BEYOND
-- reference check (offer, hired) therefore stops counting as `qualified` and
-- becomes `disqualified`. Fixing that needs stage-transition history, which
-- this system does not record. For the present pipeline — where Reference
-- Check is the last mapped stage — the distinction does not yet arise, and
-- the dashboard copy says "currently at" rather than "reached" so the number
-- is not read as cumulative.
--
-- Deliberately a SEPARATE view rather than three more columns on
-- `v_funnel_candidate`: that view is 130 lines and `create or replace` would
-- mean restating all of it to append a column, which is pure transcription
-- risk for no benefit. The rollup joins the two.

-- ── 1. The per-candidate HR disposition ──────────────────────────────────
create or replace view screening_v2.v_funnel_hr_state
with (security_invoker = true) as
with latest_assessment as (
  -- One row per candidate: the newest assessment, matching how
  -- v_funnel_candidate picks `scored`/`qualified` so the two agree.
  select distinct on (a.candidate_id)
         a.candidate_id
    from screening_v2.assessments a
   order by a.candidate_id, a.created_at desc, a.id desc
),
stage as (
  -- A candidate may hold links on several jobs. Precedence is
  -- qualified > awaiting > disqualified: being at Reference Check anywhere is
  -- the strongest signal, and still sitting in the screening stage anywhere
  -- means there is still HR work outstanding.
  --
  -- `observable` is what makes `disqualified` safe to infer. It is true only
  -- when this candidate has a link whose CURRENT stage is actually known AND
  -- whose mapping has the two stage ids wired. Without it, "not at either
  -- mapped stage" is indistinguishable from "we cannot see where they are",
  -- and the difference is the whole point of this migration.
  select l.candidate_id,
         bool_or(jm.reference_check_stage_id is not null
                 and l.external_stage_id = jm.reference_check_stage_id) as at_reference_check,
         bool_or(jm.ai_screening_stage_id is not null
                 and l.external_stage_id = jm.ai_screening_stage_id)    as at_ai_screening,
         bool_or(l.external_stage_id is not null
                 and jm.ai_screening_stage_id is not null
                 and jm.reference_check_stage_id is not null)           as observable
    from screening_v2.ashby_application_links l
    join screening_v2.ashby_job_mappings jm on jm.id = l.job_mapping_id
   where l.candidate_id is not null
   group by l.candidate_id
)
select c.id                     as candidate_id,
       c.role_id                as role_id,
       (c.created_at)::date     as cohort_day,
       case
         -- No assessment ⇒ the bot has not decided ⇒ HR owes nothing yet.
         when la.candidate_id is null                then null
         when coalesce(st.at_reference_check, false) then 'qualified'
         when coalesce(st.at_ai_screening, false)    then 'awaiting'
         -- ONLY here can "somewhere else" mean "a human moved them". An
         -- `else 'disqualified'` would silently absorb: a candidate with no
         -- Ashby link at all (every recruiter-uploaded résumé), a link whose
         -- stage has not synced yet, and every job whose mapping still has a
         -- NULL reference_check/ai_screening stage id — reporting each as an
         -- HR rejection. That is precisely the artefact this migration was
         -- written to remove, so the inference is gated on proof.
         when coalesce(st.observable, false)         then 'disqualified'
         else 'unknown'
       end                      as hr_state
  from screening_v2.candidates c
  left join latest_assessment la on la.candidate_id = c.id
  left join stage st            on st.candidate_id = c.id;

comment on view screening_v2.v_funnel_hr_state is
  'Per-candidate HR disposition (qualified | awaiting | disqualified | unknown '
  '| null). `unknown` covers a candidate whose Ashby stage cannot be observed '
  '— no link, an unsynced stage, or a mapping missing its stage ids — so an '
  'unconfigured tenant never reads as a wall of HR rejections. '
  'derived from the CURRENT Ashby stage on the application link versus the job '
  'mapping''s reference_check/ai_screening stage ids. `awaiting` exists so an '
  'unopened candidate is never counted as an HR rejection. Null until the bot '
  'has produced an assessment. Current-stage only: no stage history exists, so '
  'a candidate promoted beyond Reference Check stops counting as qualified.';

revoke all on screening_v2.v_funnel_hr_state from anon, authenticated, public;
grant select on screening_v2.v_funnel_hr_state to service_role;

-- ── 2. Roll the three states into the stored daily grain ─────────────────
alter table screening_v2.funnel_stage_daily
  add column if not exists hr_qualified    integer not null default 0,
  add column if not exists hr_disqualified integer not null default 0,
  add column if not exists hr_awaiting     integer not null default 0,
  -- Counted, not dropped: a state that exists in the view but nowhere in the
  -- rollup is a state nobody can ever see is growing.
  add column if not exists hr_unknown      integer not null default 0,
  -- The denominator the dashboard needs. Every existing cohort column is a
  -- FILTERED count (dialed, connected, scored…), so "how many candidates are
  -- in this window at all" was not answerable from the rollup — only by
  -- summing filters that overlap, or by borrowing `entered_parse`, which
  -- counts résumé-parse events rather than candidates.
  add column if not exists candidates_total integer not null default 0;

-- Separate from `chk_funnel_stage_daily_nonneg` rather than widening it: the
-- existing constraint is validated, and replacing it would re-scan the table
-- for no reason. New columns default to 0, so this validates immediately.
alter table screening_v2.funnel_stage_daily
  drop constraint if exists chk_funnel_stage_daily_hr_nonneg;
alter table screening_v2.funnel_stage_daily
  add constraint chk_funnel_stage_daily_hr_nonneg
  check (hr_qualified >= 0 and hr_disqualified >= 0 and hr_awaiting >= 0
         and hr_unknown >= 0 and candidates_total >= 0);

comment on column screening_v2.funnel_stage_daily.hr_awaiting is
  'Bot-screened candidates still sitting in the AI screening stage — an HR '
  'backlog, NOT a rejection. Kept distinct so the rejection rate is not a '
  'function of how recently the bot ran.';

-- ── 3. Teach the refresh to populate them ────────────────────────────────
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
    attempts_total, connects_total, total_call_seconds, median_ttfc_sec, p95_ttfc_sec,
    hr_qualified, hr_disqualified, hr_awaiting, hr_unknown, candidates_total
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
           count(*)                                          as candidates_total,
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
  ),
  hr as (
    select cohort_day as day, role_id,
           count(*) filter (where hr_state = 'qualified')    as hr_qualified,
           count(*) filter (where hr_state = 'disqualified') as hr_disqualified,
           count(*) filter (where hr_state = 'awaiting')     as hr_awaiting,
           count(*) filter (where hr_state = 'unknown')      as hr_unknown
    from screening_v2.v_funnel_hr_state
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
    coalesce(ch.total_call_seconds, 0), ch.median_ttfc_sec, ch.p95_ttfc_sec,
    coalesce(hr.hr_qualified, 0), coalesce(hr.hr_disqualified, 0), coalesce(hr.hr_awaiting, 0),
    coalesce(hr.hr_unknown, 0), coalesce(ch.candidates_total, 0)
  from intake i
  full outer join cohort ch
    on i.day = ch.day and i.role_id is not distinct from ch.role_id
  -- LEFT, not FULL: every HR row derives from `candidates`, exactly like
  -- `cohort`, so its grain keys are a subset. A FULL join here could only ever
  -- introduce a row the cohort side already guarantees.
  left join hr
    on hr.day = coalesce(i.day, ch.day)
   and hr.role_id is not distinct from coalesce(i.role_id, ch.role_id);

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

-- ── 4. Recompute the WHOLE history, not just the refresh loop's window ────
-- `add column … default 0` stamped a literal zero onto every pre-existing row,
-- and `refresh_funnel_rollup` only ever deletes-and-reinserts a trailing
-- window (30 days by default). Without this, any range longer than that window
-- sums real historical `qualified`/`dialed` counts against `candidates_total =
-- 0` and `hr_* = 0`: a funnel whose top is smaller than its middle, and an HR
-- backlog that reads as "fully caught up" — both vouched for by a fresh
-- `refreshed_at`. Ten years covers every row this table can hold.
--
-- Safe to re-run: the function is delete-then-insert over the same window and
-- takes an advisory lock, so a concurrent refresh returns `busy` rather than
-- double-counting.
select screening_v2.refresh_funnel_rollup(now(), 3650);
