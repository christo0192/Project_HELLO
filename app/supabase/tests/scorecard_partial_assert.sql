\set ON_ERROR_STOP on
-- =====================================================================
-- Behavioural assertions for migration 0091 (scorecard partial scoring).
-- Runs AFTER the real 0091 has been applied to the bootstrap fixture, so it
-- proves the shipped migration SQL — not a paraphrase — actually:
--   1. Recovered the incident row (a1: 3/5 scored @3) to a provisional score
--      of weighted 3.0 / overall 50 / 'hold' in BOTH the columns AND `raw`.
--   2. Left the all-insufficient row (a2: 0/5 scored) null — genuine human
--      review, nothing to renormalize (the "null only when NONE scored" branch).
--   3. Relaxed chk_assessments_v2_shape so a NEW incomplete_evidence row MAY
--      carry a partial weighted_score_5, while a `complete` row still may NOT be
--      weighted-null (the half of the constraint we must NOT have dropped).
--   4. Surfaces BOTH soft (incomplete_evidence) and HARD (job_dlq) scoring
--      failures in v_funnel_failures, with DLQ codes sanitized.
-- =====================================================================

-- ── 1. Incident row a1 recovered in columns AND raw ───────────────────────
do $$
declare
  r record;
begin
  select weighted_score_5, overall_score, recommendation, scoring_status, partial,
         raw->>'recommendation'   as raw_reco,
         (raw->>'weightedScore5') as raw_weighted,
         (raw->>'overallScore')   as raw_overall
    into r
  from screening_v2.assessments
  where id = '00000000-0000-0000-0000-0000000000a1';

  if r.weighted_score_5 is null then
    raise exception 'a1 NOT recovered: weighted_score_5 is still null';
  end if;
  if r.weighted_score_5 <> 3.0 then
    raise exception 'a1 weighted_score_5 expected 3.0, got %', r.weighted_score_5;
  end if;
  if r.overall_score <> 50 then
    raise exception 'a1 overall_score expected 50, got %', r.overall_score;
  end if;
  if r.recommendation <> 'hold' then
    raise exception 'a1 recommendation expected hold, got %', r.recommendation;
  end if;
  -- status stays incomplete_evidence (it IS a partial screening) and partial stays true.
  if r.scoring_status <> 'incomplete_evidence' then
    raise exception 'a1 scoring_status must remain incomplete_evidence, got %', r.scoring_status;
  end if;
  if r.partial is not true then
    raise exception 'a1 partial flag must remain true';
  end if;

  -- The candidate card reads recommendation out of `raw` (raw.recommendation
  -- was 'human_review' and would win the ?? in readScorecardAssessmentV2), so
  -- the migration MUST have rewritten raw, not just the columns.
  if r.raw_reco <> 'hold' then
    raise exception 'a1 raw.recommendation expected hold (card reads this), got %', r.raw_reco;
  end if;
  if r.raw_weighted is null or r.raw_weighted::numeric <> 3.0 then
    raise exception 'a1 raw.weightedScore5 expected 3.0, got %', r.raw_weighted;
  end if;
  if r.raw_overall is null or r.raw_overall::numeric <> 50 then
    raise exception 'a1 raw.overallScore expected 50, got %', r.raw_overall;
  end if;

  raise notice 'A1 RECOVERY ASSERTIONS PASSED (weighted 3.0 / overall 50 / hold, columns + raw)';
end $$;

-- ── 2. All-insufficient row a2 left null (nothing to renormalize) ──────────
do $$
declare
  r record;
begin
  select weighted_score_5, overall_score, recommendation,
         raw->>'recommendation' as raw_reco
    into r
  from screening_v2.assessments
  where id = '00000000-0000-0000-0000-0000000000a2';

  if r.weighted_score_5 is not null then
    raise exception 'a2 (no metric scored) MUST stay weighted-null, got %', r.weighted_score_5;
  end if;
  if r.overall_score is not null then
    raise exception 'a2 overall_score MUST stay null, got %', r.overall_score;
  end if;
  if r.recommendation is not null then
    raise exception 'a2 recommendation MUST stay null, got %', r.recommendation;
  end if;
  if r.raw_reco <> 'human_review' then
    raise exception 'a2 raw.recommendation MUST stay human_review, got %', r.raw_reco;
  end if;
  raise notice 'A2 NULL-GUARD ASSERTIONS PASSED (no metric scored => still human review)';
end $$;

-- ── 2b. Malformed-element row a3 recovered FAIL-SOFT over its one valid metric ──
do $$
declare
  r record;
begin
  select weighted_score_5, overall_score, recommendation
    into r
  from screening_v2.assessments
  where id = '00000000-0000-0000-0000-0000000000a3';

  -- That the migration applied at all proves the malformed configMetricId / score
  -- did NOT abort it. The two bad elements were skipped and recovery renormalized
  -- over the single valid metric (0002 @3) → weighted 3.0 / overall 50 / hold. (If
  -- the bad-score element had only been nulled instead of dropped whole, its weight
  -- would have skewed the denominator to give 1.5 — so 3.0 also proves drop-whole.)
  if r.weighted_score_5 is null then
    raise exception 'a3 FAIL-SOFT recovery did not run (weighted still null)';
  end if;
  if r.weighted_score_5 <> 3.0 then
    raise exception 'a3 expected weighted 3.0 over its one valid metric, got %', r.weighted_score_5;
  end if;
  if r.overall_score <> 50 then
    raise exception 'a3 expected overall 50, got %', r.overall_score;
  end if;
  if r.recommendation <> 'hold' then
    raise exception 'a3 expected hold, got %', r.recommendation;
  end if;
  raise notice 'A3 FAIL-SOFT ASSERTIONS PASSED (malformed elements skipped; recovered over valid subset)';
end $$;

-- ── 3. Relaxed shape CHECK: partial incomplete_evidence now allowed ────────
-- A NEW incomplete_evidence v2 row carrying a partial weighted score must now
-- INSERT cleanly (before 0091 this violated chk_assessments_v2_shape).
insert into screening_v2.assessments
  (id, session_id, candidate_id, schema_version, revision, scorecard_version_id,
   scoring_status, weighted_score_5, overall_score, recommendation, source, partial, metric_results)
values (
  '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-000000000553',
  '00000000-0000-0000-0000-0000000000c3',
  2, 1, '00000000-0000-0000-0000-0000000000f1',
  'incomplete_evidence', 2.5, 38, 'reject', 'phone', true,
  '[{"configMetricId":"00000000-0000-0000-0000-000000000001","evidenceStatus":"scored","score":2}]'::jsonb
);
do $$ begin raise notice 'CHECK-RELAX ASSERTION PASSED (partial incomplete_evidence insert accepted)'; end $$;

-- ── 3b. The OTHER half of the constraint must still hold: a `complete` v2
--        row may NOT be weighted-null. This insert MUST be rejected. ─────────
do $$
declare
  ok boolean := false;
begin
  begin
    insert into screening_v2.assessments
      (id, session_id, candidate_id, schema_version, revision, scorecard_version_id,
       scoring_status, weighted_score_5, overall_score, recommendation, source, partial, metric_results)
    values (
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-000000000554',
      '00000000-0000-0000-0000-0000000000c4',
      2, 1, '00000000-0000-0000-0000-0000000000f1',
      'complete', null, null, null, 'phone', false,
      '[{"configMetricId":"00000000-0000-0000-0000-000000000001","evidenceStatus":"scored","score":2}]'::jsonb
    );
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'REGRESSION: a complete v2 row with null weighted_score_5 was accepted — 0091 over-relaxed the constraint';
  end if;
  raise notice 'CHECK-STILL-ENFORCED ASSERTION PASSED (complete + weighted-null rejected)';
end $$;

-- ── 4. v_funnel_failures surfaces soft AND hard scoring failures ───────────
-- Insert a messy DLQ code to prove sanitization to 'scoring_failed'.
insert into screening_v2.job_dlq (name, error_message)
  values ('phone.assessment', 'DeepSeek Timeout After 3 Retries!!');
-- A non-phone DLQ row must NOT surface (the branch is scoped to phone.assessment%).
insert into screening_v2.job_dlq (name, error_message)
  values ('resume.parse', 'irrelevant');

do $$
declare
  v int;
  t text;
begin
  -- Soft failures now surface ONLY true voids (weighted_score_5 IS NULL). Of the
  -- incomplete_evidence rows, only a2 (0/5 scored) is a void; a1 + a3 recovered to a
  -- provisional score and b1 carries one, so none of them count as a scoring drop.
  select count(*) into v from screening_v2.v_funnel_failures
    where stage = 'scoring' and code = 'incomplete_evidence';
  if v <> 1 then raise exception 'expected 1 soft (void) incomplete_evidence scoring row, got %', v; end if;
  -- The recovered/provisional rows must NOT appear as scoring failures.
  select count(*) into v from screening_v2.v_funnel_failures
    where stage = 'scoring'
      and entity_id in ('00000000-0000-0000-0000-0000000000a1',
                        '00000000-0000-0000-0000-0000000000a3',
                        '00000000-0000-0000-0000-0000000000b1');
  if v <> 0 then raise exception 'a provisional/recovered row leaked into scoring failures (count %)', v; end if;
  -- The one void is a2.
  select entity_id into t from screening_v2.v_funnel_failures
    where stage = 'scoring' and code = 'incomplete_evidence';
  if t <> '00000000-0000-0000-0000-0000000000a2' then raise exception 'the void row should be a2, got %', t; end if;

  -- Hard failure: the clean DLQ 'timeout' surfaces verbatim (passes the code regex).
  select count(*) into v from screening_v2.v_funnel_failures
    where stage = 'scoring' and code = 'timeout';
  if v <> 1 then raise exception 'expected 1 hard DLQ scoring failure code=timeout, got %', v; end if;

  -- Hard failure: the messy DLQ message sanitizes to 'scoring_failed'.
  select count(*) into v from screening_v2.v_funnel_failures
    where stage = 'scoring' and code = 'scoring_failed';
  if v <> 1 then raise exception 'expected 1 sanitized DLQ scoring failure code=scoring_failed, got %', v; end if;

  -- Scope guard: the resume.parse DLQ row must NOT appear as a scoring failure.
  select count(*) into v from screening_v2.v_funnel_failures
    where stage = 'scoring' and code = 'irrelevant';
  if v <> 0 then raise exception 'non-phone DLQ row leaked into scoring failures'; end if;

  -- Every emitted code is sanitized (safe to aggregate) — no spaces/caps anywhere.
  select count(*) into v from screening_v2.v_funnel_failures
    where code !~ '^[a-z0-9_.:-]{1,64}$';
  if v <> 0 then raise exception 'v_funnel_failures emitted % unsanitized codes', v; end if;

  raise notice 'FUNNEL FAILURE ASSERTIONS PASSED (1 soft void + 2 hard, provisional rows excluded, DLQ sanitized + phone-scoped)';
end $$;

do $$ begin raise notice 'ALL SCORECARD-PARTIAL (0091) ASSERTIONS PASSED'; end $$;
