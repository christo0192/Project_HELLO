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
-- This migration adds the third state explicitly, plus a fourth for the case
-- that actually dominates today. `hr_state` compares the Ashby stage recorded
-- on the application link against the two stage ids the job mapping stores —
-- but ONLY where that stage has been confirmed since import (section 0):
--
--   qualified     confirmed stage = mapping.reference_check_stage_id
--   awaiting      confirmed stage = mapping.ai_screening_stage_id (untouched)
--   disqualified  bot-decided, the stage is CONFIRMED, and it is neither of the
--                 mapped ones — the only case where "somewhere else" means a
--                 human moved them
--   unknown       bot-decided but the stage is NOT observable: no link at all
--                 (every recruiter-uploaded résumé), a stage never confirmed
--                 since import (today: every link in production), or a mapping
--                 still missing a stage id
--   null          the bot has not produced an assessment yet, so there is
--                 nothing for HR to have acted on
--
-- `unknown` is the whole reason this is safe, and it gates all three of the
-- others rather than only `disqualified`. An `else 'disqualified'` would report
-- unobservable candidates as HR rejections; an ungated `awaiting` would report
-- them as an HR backlog. Both are claims about a human decision we have not
-- observed, and both are the artefact this migration exists to remove.
--
-- KNOWN LIMIT, stated so nobody mistakes it for precision: the link carries
-- only a current stage, not a stage history. A candidate promoted BEYOND
-- reference check (offer, hired) therefore stops counting as `qualified` and
-- becomes `disqualified`, so once hiring starts the advance rate falls. The
-- dashboard copy says so in the definition of "Not advanced" rather than
-- leaving the reader to discover it. Fixing it properly needs stage-transition
-- history, which this system does not record.
--
-- Deliberately a SEPARATE view rather than three more columns on
-- `v_funnel_candidate`: that view is 130 lines and `create or replace` would
-- mean restating all of it to append a column, which is pure transcription
-- risk for no benefit. The rollup joins the two.

-- ── 0. The precondition this whole migration rests on ────────────────────
-- `ashby_application_links.external_stage_id` is written in EXACTLY one place
-- (workflow-stores.ts `createLink`), at import, from `decision.stageId` — and
-- signal-worker.ts refuses any signal whose stage is not the mapping's
-- `ai_screening_stage_id`. So the column is not "the candidate's current
-- stage": it is a constant, equal to the AI screening stage, for every link
-- ever created. Nothing UPDATEs it; `applicationChangeStage` has no callers.
-- Verified against production: all six links carry
-- external_stage_id = ai_screening_stage_id.
--
-- That makes a naive reading of this column actively dangerous. Every scored
-- Ashby candidate would evaluate as "still in AI screening" forever, so
-- `qualified` and `disqualified` would be UNREACHABLE while `awaiting` claimed
-- "HR has not opened this candidate yet" about someone rejected weeks ago —
-- and the moment an operator performed the documented activation step (set
-- `reference_check_stage_id`), the dashboard would stop saying "not tracked"
-- and start presenting "Advanced 0 / Not advanced 0" as measurement.
--
-- So the states are gated on PROOF that a link's stage has been observed since
-- import, not on an id being non-null. `stage_synced_at` is that proof. Nothing
-- writes it yet, deliberately: the `candidateStageChange` webhook already
-- ARRIVES and is already parsed (extractors.ts extracts the stage id), but the
-- signal worker discards it as `stage_not_ai`. Persisting it changes which
-- Ashby events create work, which is an import-pipeline decision that does not
-- belong in a dashboard change. Until that lands, every HR state reads
-- `unknown` and the dashboard says so in plain words.
alter table screening_v2.ashby_application_links
  add column if not exists stage_synced_at timestamptz;

-- Partial: until the stage sync lands the predicate matches no rows, so this is
-- an empty index that answers "has anything been observed?" without touching the
-- table — and it stays the right index afterwards. The probe runs on every
-- dashboard load, for every interviewer.
create index if not exists idx_ashby_links_stage_synced
  on screening_v2.ashby_application_links (job_mapping_id)
  where stage_synced_at is not null;

comment on column screening_v2.ashby_application_links.stage_synced_at is
  'When external_stage_id was last confirmed against Ashby AFTER import. NULL '
  'means the column still holds the import-time constant (the AI screening '
  'stage) and the candidate''s real stage is UNKNOWN. Set this only from a '
  'genuine stage observation — a candidateStageChange receipt or a '
  'reconciliation read. Every HR disposition in v_funnel_hr_state is gated on '
  'it, so writing it without a real observation makes the dashboard lie.';

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
         -- Each clause carries its OWN `stage_synced_at`, per link. A candidate
         -- may hold one synced link and one that has never been looked at;
         -- reading a stage off the second because the first made the candidate
         -- "observable" would be the same unproven inference in a new place.
         bool_or(l.stage_synced_at is not null
                 and jm.reference_check_stage_id is not null
                 and l.external_stage_id = jm.reference_check_stage_id) as at_reference_check,
         bool_or(l.stage_synced_at is not null
                 and jm.ai_screening_stage_id is not null
                 and l.external_stage_id = jm.ai_screening_stage_id)    as at_ai_screening,
         -- `stage_synced_at is not null` is the load-bearing clause. Without
         -- it, `external_stage_id` is the import-time constant and "not at
         -- either mapped stage" means "we have never looked", not "a human
         -- moved them". See section 0.
         bool_or(l.stage_synced_at is not null
                 and l.external_stage_id is not null
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
         -- UNOBSERVABLE FIRST, and it gates all three real states — not just
         -- `disqualified`. If we have never confirmed this candidate's stage
         -- since import, then "still in AI screening" is exactly as unproven as
         -- "moved elsewhere": both are readings of a column that has not been
         -- updated. Reporting `awaiting` here would claim an HR backlog that may
         -- be an HR decision taken weeks ago.
         when not coalesce(st.observable, false)     then 'unknown'
         when coalesce(st.at_reference_check, false) then 'qualified'
         when coalesce(st.at_ai_screening, false)    then 'awaiting'
         -- Reached only when the stage IS observed and is neither mapped one,
         -- which is the single case where "somewhere else" means "a human moved
         -- them". An `else 'disqualified'` above the guard would absorb: a
         -- candidate with no Ashby link at all (every recruiter-uploaded
         -- résumé), a link whose stage has never been confirmed since import
         -- (today: all of them), and every job whose mapping still has a NULL
         -- reference_check/ai_screening stage id — reporting each as an HR
         -- rejection. That is precisely the artefact this migration exists to
         -- remove, so the inference is gated on proof, twice.
         else 'disqualified'
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

-- ── 2b. A heartbeat, so freshness is not read off the DATA ───────────────
-- `max(refreshed_at)` over funnel_stage_daily answers "when did a row last get
-- written", which is not the same question as "when did the roll-up last run".
-- `refresh_funnel_rollup` is DELETE-then-INSERT over a trailing window: a
-- window that produces no rows commits having written nothing, and rows older
-- than the window are never re-stamped. So a tenant with a month of no intake —
-- a hiring freeze, entirely normal here — would have the loop running happily
-- every 15 minutes while the dashboard reported "Figures last recalculated
-- 15 June". That is the same defect the meta field was added to kill, one
-- timescale up.
--
-- One row, upserted on every successful run.
create table if not exists screening_v2.funnel_rollup_runs (
  id           smallint primary key default 1,
  ran_at       timestamptz not null default now(),
  window_start date,
  rows_written integer,
  constraint chk_funnel_rollup_runs_singleton check (id = 1)
);

comment on table screening_v2.funnel_rollup_runs is
  'Single-row heartbeat for refresh_funnel_rollup. Answers "when did the '
  'roll-up last RUN", which a scan of funnel_stage_daily cannot: an empty '
  'window writes no rows, and rows outside the trailing window are never '
  're-stamped.';

-- Required, not optional: policy_tests.sql asserts that EVERY table in
-- screening_v2 has RLS enabled, and this would have been the only one of 66
-- without it. No policy is defined, so the deny-by-default posture is exactly
-- right — only the service role (which bypasses RLS) ever reads it.
alter table screening_v2.funnel_rollup_runs enable row level security;
revoke all on screening_v2.funnel_rollup_runs from anon, authenticated, public;
grant select on screening_v2.funnel_rollup_runs to service_role;

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

  -- Stamped on EVERY successful pass, including one that wrote zero rows —
  -- that is the whole point. It is inside the same transaction as the rebuild,
  -- so it can never claim a run that was rolled back, and it is never reached
  -- on the `busy` path above, so it cannot claim a run that did not happen.
  -- `now()`, NOT `p_now`. The parameter is caller-supplied and only defines the
  -- WINDOW; stamping it as the run time lets any caller move the freshness the
  -- dashboard reports. The test harness calls with `now() + 400 days` to reach
  -- an empty window and would otherwise leave a freshness date next year.
  insert into screening_v2.funnel_rollup_runs (id, ran_at, window_start, rows_written)
  values (1, now(), v_window_start, v_rows)
  on conflict (id) do update
    set ran_at = excluded.ran_at,
        window_start = excluded.window_start,
        rows_written = excluded.rows_written;

  return jsonb_build_object(
    'status', 'ok',
    'rows', v_rows,
    'window_start', v_window_start
  );
end;
$$;

revoke all on function screening_v2.refresh_funnel_rollup(timestamptz, integer) from public;
grant execute on function screening_v2.refresh_funnel_rollup(timestamptz, integer) to service_role;

-- ── 4. Backfill the new columns on EVERY existing row ────────────────────
-- `add column … default 0` stamped a literal zero onto every pre-existing row,
-- and `refresh_funnel_rollup` only ever recomputes a trailing window (30 days
-- by default). Without a backfill, any range longer than that window sums real
-- historical `qualified`/`dialed` counts against `candidates_total = 0` and
-- `hr_* = 0` — a funnel whose top is smaller than its middle, vouched for by a
-- fresh `refreshed_at`.
--
-- An UPDATE, deliberately NOT `refresh_funnel_rollup(now(), 3650)`:
--
--   * That function is delete-then-recompute FROM THE LIVE OPERATIONAL VIEWS,
--     and 0090 states the rollup's purpose is to "survive operational-table
--     retention" — it is a snapshot meant to outlive pruned source rows. A
--     ten-year rebuild would silently shrink every historical day whose source
--     rows have since been purged, irreversibly, from inside a migration.
--   * It takes an advisory lock and returns `{"status":"busy"}` if another
--     refresh holds it. A bare `select` would discard that and commit green
--     with the whole history still at zero — and this migration's own
--     `alter table` (ACCESS EXCLUSIVE) is what opens the window for a
--     scheduled refresh to grab the lock first.
--
-- This touches ONLY the five new columns, leaves every 0090 counter exactly as
-- recorded, and cannot half-apply: it is one statement in the migration's
-- transaction.
--
-- Written as `update … from (subquery)` rather than `with agg as (…) update …`
-- on purpose. scripts/migrate-rollback.test.mjs classifies each statement by its
-- FIRST KEYWORD: a leading `with` is not `update`, so the CTE form fell past the
-- DML branch into the destructive-DDL rules and turned the gate RED. The two
-- forms are semantically identical, and a data statement that reads as a data
-- statement is the honest shape — the alternative was teaching a safety gate to
-- ignore a new prefix, which is the wrong direction entirely.
update screening_v2.funnel_stage_daily f
   set candidates_total = agg.candidates_total,
       hr_qualified     = agg.hr_qualified,
       hr_disqualified  = agg.hr_disqualified,
       hr_awaiting      = agg.hr_awaiting,
       hr_unknown       = agg.hr_unknown
  from (
    -- Both views are one row per candidate over the same `candidates` rows, so
    -- one join gives every new counter in a single pass.
    select v.cohort_day,
           v.role_id,
           count(*)                                            as candidates_total,
           count(*) filter (where h.hr_state = 'qualified')     as hr_qualified,
           count(*) filter (where h.hr_state = 'disqualified')  as hr_disqualified,
           count(*) filter (where h.hr_state = 'awaiting')      as hr_awaiting,
           count(*) filter (where h.hr_state = 'unknown')       as hr_unknown
      from screening_v2.v_funnel_candidate v
      left join screening_v2.v_funnel_hr_state h on h.candidate_id = v.candidate_id
     group by 1, 2
  ) agg
 where agg.cohort_day = f.cohort_day
   and agg.role_id is not distinct from f.role_id;
