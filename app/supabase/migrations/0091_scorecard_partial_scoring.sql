-- =====================================================================
-- 0091 — scorecard partial scoring: a screening always yields a card
-- ---------------------------------------------------------------------
-- RCA (candidate 0752d87a, session 007184e2, assessment e333af5d): the v2
-- scorer voided the ENTIRE numeric scorecard whenever ANY single metric came
-- back insufficient_evidence. Three of five metrics scored 3/5, but two
-- unevidenced metrics (compensation_fit, night_shift_fit — never elicited on a
-- partial call) nulled weighted_score_5 / overall_score / recommendation, so
-- the recruiter saw "needs human review / no scorecard".
--
-- The code fix (lib/scorecards/domain.ts calculateWeightedScore) now
-- renormalizes over the EVIDENCED metrics and returns null only when NONE were
-- scored. This migration makes the schema + the historical rows + the funnel
-- agree with that:
--   1. Relax chk_assessments_v2_shape so an `incomplete_evidence` v2 row MAY
--      carry a (partial) weighted_score_5 — it was previously forced NULL.
--   2. RECOVER existing incomplete_evidence rows IN PLACE: recompute
--      weighted_score_5 / overall_score / recommendation from their own already-
--      stored metric_results (renormalized over the scored metrics), updating
--      BOTH the columns AND the `raw` payload the candidate card reads from, so
--      historical partial screenings show a provisional card, not a blank one.
--   3. Extend v_funnel_failures to also surface HARD scoring failures (phone
--      assessment jobs that exhausted their retries into job_dlq), closing the
--      blind spot where a soft incomplete_evidence failure was observable but a
--      hard provider/parse failure (which leaves no row) was not.
-- Additive + forward-only: no column added, no data destroyed, service-role-only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Relax the v2 shape CHECK — incomplete_evidence may now be partially scored.
-- ---------------------------------------------------------------------
-- Was: incomplete_evidence => weighted_score_5 IS NULL (all-or-nothing).
-- Now: complete => weighted_score_5 NOT NULL (a fully-scored row must have a
-- score); incomplete_evidence => weighted_score_5 may be NULL (no metric scored)
-- OR a value (a partial score). The 1..5 range stays enforced by
-- chk_assessments_weighted_score_5, so this only removes the null-coupling.
alter table screening_v2.assessments drop constraint if exists chk_assessments_v2_shape;
-- NOT VALID: the new predicate is strictly WEAKER than the 0088 one it replaces
-- (it only REMOVES the incomplete_evidence => weighted-null coupling; every other
-- clause is unchanged), so every already-validated row provably still satisfies
-- it. NOT VALID therefore skips the redundant full-table re-validation scan —
-- which would otherwise hold an ACCESS EXCLUSIVE lock on assessments for the whole
-- migration transaction (blocking live phone-worker writes + recruiter reads) — while
-- STILL enforcing the constraint on every subsequent insert/update, including the
-- recovery UPDATE below and all go-forward writes.
alter table screening_v2.assessments add constraint chk_assessments_v2_shape check (
  (schema_version = 1 and scorecard_version_id is null and metric_results is null and weighted_score_5 is null)
  or (schema_version = 2 and metric_results is not null
      and jsonb_typeof(metric_results) = 'array'
      and (scoring_status = 'incomplete_evidence'
           or (scoring_status = 'complete' and weighted_score_5 is not null)))
) not valid;

-- ---------------------------------------------------------------------
-- 2. Recover existing incomplete_evidence rows in place (no re-inference).
-- ---------------------------------------------------------------------
-- Recompute from the row's own metric_results, renormalizing the scored
-- metrics' weights among themselves — the SAME partial rule as domain.ts:
-- weighted = round(sum(w*score)/sum(w), 4); overall = round((weighted-1)/4*100);
-- reco = >=65 advance / >=45 hold / else reject. (The recovery evaluates in exact
-- numeric while domain.ts evaluates in IEEE-754 double, so a value that lands on
-- an exact rounding half-way point could differ by 1 in the last place; this is
-- bounded to this one-time historical recovery of human-review cards that land
-- 'screened' and are re-confirmed by a human, so it is immaterial.)
-- BOTH the columns and the `raw` payload are updated, because the candidate card
-- reads recommendation out of `raw` (raw.recommendation='human_review' is non-null,
-- so it would otherwise win the `??` in readScorecardAssessmentV2). Idempotent:
-- only touches v2 + incomplete_evidence + weighted-null rows that have >=1 scored
-- metric. Statement starts with UPDATE (not WITH) so the rollback verifier reads
-- it as DML.
--
-- FAIL-SOFT casts: the jsonb -> int / uuid coercions are guarded by a CASE so a
-- single malformed HISTORICAL element (a hand-edited or backfilled row — the live
-- write path enforces integer 1..5 + a configured uuid via validateMetricResults)
-- is SKIPPED rather than raising and aborting the whole one-time migration, which
-- would block the very deploy that fixes scoring for every clean row. A row whose
-- scored elements are ALL malformed simply yields no weighted5 and is left as a
-- (still-visible) void, exactly like a genuinely unscoreable screening.
--
-- The join to role_scorecard_version_metrics is on its GLOBALLY-UNIQUE uuid PK
-- (configMetricId == role_scorecard_version_metrics.id), so it is intentionally
-- NOT scoped to the row's scorecard_version_id: a uuid cannot collide across
-- versions, and leaving it unscoped still recovers a row correctly even if it was
-- rescored across versions — scoping could wrongly drop such a row and reduce
-- recovery coverage, the opposite of the goal.
update screening_v2.assessments a
set weighted_score_5 = r.weighted5,
    overall_score = r.overall,
    recommendation = r.reco,
    raw = jsonb_set(
            jsonb_set(
              jsonb_set(coalesce(a.raw, '{}'::jsonb), '{weightedScore5}', to_jsonb(r.weighted5)),
              '{overallScore}', to_jsonb(r.overall)),
            '{recommendation}', to_jsonb(r.reco))
from (
  select rc.assessment_id,
         rc.weighted5,
         round(((rc.weighted5 - 1) / 4) * 100) as overall,
         case
           when round(((rc.weighted5 - 1) / 4) * 100) >= 65 then 'advance'
           when round(((rc.weighted5 - 1) / 4) * 100) >= 45 then 'hold'
           else 'reject'
         end as reco
  from (
    select a2.id as assessment_id,
           round(sum(vm.weight_bps * e.score_int)::numeric
                 / nullif(sum(vm.weight_bps), 0), 4) as weighted5
    from screening_v2.assessments a2
      cross join lateral (
        -- Guard the casts with CASE so a malformed element never raises; the
        -- outer WHERE drops elements that failed either guard (a valid-uuid but
        -- bad-score element is dropped whole, so it never skews the denominator).
        select cast_guarded.config_metric_id, cast_guarded.score_int
        from (
          select
            case when (m->>'configMetricId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (m->>'configMetricId')::uuid end as config_metric_id,
            case when (m->>'score') ~ '^[0-9]+$'
                 then (m->>'score')::int end as score_int
          from jsonb_array_elements(a2.metric_results) m
          where (m->>'evidenceStatus') = 'scored'
        ) cast_guarded
        where cast_guarded.config_metric_id is not null
          and cast_guarded.score_int is not null
      ) e
      join screening_v2.role_scorecard_version_metrics vm
        on vm.id = e.config_metric_id
    where a2.schema_version = 2
      and a2.scoring_status = 'incomplete_evidence'
      and a2.weighted_score_5 is null
    group by a2.id
  ) rc
  where rc.weighted5 is not null
) r
where a.id = r.assessment_id;

-- ---------------------------------------------------------------------
-- 3. Extend v_funnel_failures to surface HARD scoring failures (job_dlq).
-- ---------------------------------------------------------------------
-- Re-declared in full (0090 body) plus one branch: a phone.assessment job that
-- exhausted its retries and landed in the DLQ. error_message is already
-- sanitized to a stable code by the queue runner; re-validated here to keep the
-- "sanitized code" contract structural. Closes the funnel blind spot where a
-- soft incomplete_evidence failure was observable but a hard failure was not.
create or replace view screening_v2.v_funnel_failures
  with (security_invoker = true) as
  select 'resume_parse'::text as stage,
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
  -- SOFT scoring failure: a screening that produced NO usable numeric verdict —
  -- NOT ONE metric could be scored (weighted_score_5 IS NULL => human review). A
  -- PARTIAL row that renormalized to a provisional score is NOT a drop (the
  -- recruiter got a card), so it is deliberately excluded; only true voids count.
  -- Post-recovery, historical partials fall OUT of this surface — the fix shows up
  -- in the funnel as fewer scoring failures.
  select 'scoring'::text, 'incomplete_evidence'::text, a2.id::text, a2.created_at
  from screening_v2.assessments a2
  where a2.scoring_status = 'incomplete_evidence' and a2.weighted_score_5 is null
  union all
  -- HARD scoring failure: a phone-assessment job that exhausted its retries into
  -- the DLQ (the scorecard genuinely could not be produced — Modes A–D in the
  -- RCA: DeepSeek timeout/4xx-5xx, breaker open, malformed JSON, session not
  -- terminal). job_dlq.name is the queue name; error_message is a sanitized code.
  select 'scoring'::text,
         case when d.error_message ~ '^[a-z0-9_.:-]{1,64}$' then d.error_message else 'scoring_failed' end,
         d.id::text, d.failed_at
  from screening_v2.job_dlq d
  where d.name like 'phone.assessment%';

comment on view screening_v2.v_funnel_failures is
  'Unified failure taxonomy {stage, code, entity_id, occurred_at} across resume '
  'parse (ingestion + sync-upload), dial (provider_error/wrong_number), recording '
  '(egress_failed), call (failed-family terminal_reason), and scoring — both the '
  'soft incomplete_evidence (a row exists, provisionally scored) and the HARD '
  'DLQ failures where no assessment row was produced. The one surface to watch '
  'for any stage failing. All codes are sanitized; safe to aggregate directly.';

revoke all on screening_v2.v_funnel_failures from anon, authenticated, public;
grant select on screening_v2.v_funnel_failures to service_role;
