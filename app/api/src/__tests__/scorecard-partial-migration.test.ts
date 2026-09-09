/**
 * 0091 — scorecard partial scoring, read from the migration text.
 *
 * These assertions read the SQL rather than the database, so a regression fails
 * in `npm test` rather than later in the Supabase job. The behavioural half —
 * that the recovery UPDATE actually recomputes the incident row and the relaxed
 * CHECK accepts a partial row — is proven on real Postgres by
 * scripts/test-scorecard-partial.sh; these pin the contract that guards it:
 *
 *   1. The v2 shape CHECK is relaxed to DECOUPLE incomplete_evidence from a null
 *      weighted score, while STILL requiring a `complete` row to carry one.
 *   2. Historical incomplete_evidence rows are recovered IN PLACE — columns AND
 *      the `raw` payload the candidate card reads — using the row's own stored
 *      metric_results, with math byte-identical to domain.ts.
 *   3. The recovery statement starts with UPDATE (not WITH), so the TST-15
 *      rollback verifier classifies it as DML, not unclassified DDL.
 *   4. v_funnel_failures gains a HARD scoring-failure branch off job_dlq, with
 *      the code sanitized and scoped to phone.assessment jobs.
 *   5. Additive + service-role-only: no browser-role grant, no destructive DDL.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0091_scorecard_partial_scoring.sql', import.meta.url),
  ),
  'utf8',
);

describe('0091 scorecard partial scoring migration', () => {
  it('relaxes the v2 shape CHECK to decouple incomplete_evidence from a null weighted score', () => {
    // The constraint is dropped (guarded) and re-added.
    expect(MIGRATION).toContain('drop constraint if exists chk_assessments_v2_shape');
    expect(MIGRATION).toMatch(/add constraint chk_assessments_v2_shape check/);
    // The relaxed rule: complete STILL requires a non-null weighted score…
    expect(MIGRATION).toMatch(/scoring_status = 'complete' and weighted_score_5 is not null/);
    // …but incomplete_evidence no longer forces weighted_score_5 IS NULL (the old
    // all-or-nothing coupling that voided the whole card). It must NOT re-appear.
    expect(MIGRATION).not.toMatch(/incomplete_evidence and weighted_score_5 is null/);
    // NOT VALID: the relaxed constraint is strictly weaker than the validated 0088
    // one, so the redundant full-table validation scan (an ACCESS EXCLUSIVE lock
    // held for the whole migration) is skipped — it still enforces on new writes.
    expect(MIGRATION).toMatch(/\)\s*not valid;/);
  });

  it('recovers historical rows IN PLACE with a statement that starts with UPDATE (DML, not DDL)', () => {
    // Leading keyword must be `update` so the rollback verifier reads it as DML —
    // a `with`-first statement would trip UNCLASSIFIED_DDL and go RED.
    expect(MIGRATION).toMatch(/^update screening_v2\.assessments a/m);
    // Renormalize over the SCORED metrics only, using the row's own results.
    expect(MIGRATION).toContain("(m->>'evidenceStatus') = 'scored'");
    expect(MIGRATION).toContain('jsonb_array_elements(a2.metric_results)');
    expect(MIGRATION).toContain('join screening_v2.role_scorecard_version_metrics vm');
    // Only touches unrecovered partials that HAVE at least one scored metric.
    expect(MIGRATION).toContain("a2.scoring_status = 'incomplete_evidence'");
    expect(MIGRATION).toContain('a2.weighted_score_5 is null');
    expect(MIGRATION).toContain('where rc.weighted5 is not null');
  });

  it('recovery math matches domain.ts under exact arithmetic (renormalize, overall, thresholds)', () => {
    // weighted = round(sum(w*score)/sum(w), 4)  ← domain.calculateWeightedScore
    // (the score is cast fail-soft into e.score_int in the guarded lateral below).
    expect(MIGRATION).toMatch(/round\(\s*sum\(vm\.weight_bps \* e\.score_int\)::numeric\s*\/ nullif\(sum\(vm\.weight_bps\), 0\), 4\)/);
    // overall = round(((weighted-1)/4)*100)     ← domain.weightedScoreToOverall
    expect(MIGRATION).toMatch(/round\(\(\(rc\.weighted5 - 1\) \/ 4\) \* 100\)/);
    // reco: >=65 advance / >=45 hold / else reject ← domain.recommendationForOverall
    expect(MIGRATION).toContain(">= 65 then 'advance'");
    expect(MIGRATION).toContain(">= 45 then 'hold'");
    expect(MIGRATION).toContain("else 'reject'");
  });

  it('guards the recovery casts FAIL-SOFT so one malformed historical row cannot abort the deploy', () => {
    // configMetricId and score are cast inside a CASE that first shape-checks the
    // text, so a malformed element yields NULL (skipped) instead of raising.
    expect(MIGRATION).toMatch(/case when \(m->>'configMetricId'\) ~\* '\^\[0-9a-f\]\{8\}-/);
    expect(MIGRATION).toMatch(/case when \(m->>'score'\) ~ '\^\[0-9\]\+\$'/);
    // Elements that failed either guard are dropped WHOLE (both must be non-null),
    // so a valid-uuid/bad-score element never skews the renormalization denominator.
    expect(MIGRATION).toContain('cast_guarded.config_metric_id is not null');
    expect(MIGRATION).toContain('cast_guarded.score_int is not null');
  });

  it('rewrites the `raw` payload the candidate card reads, not just the columns', () => {
    // readScorecardAssessmentV2 does `raw?.recommendation ?? row.recommendation`,
    // so a stale raw.recommendation='human_review' would win — raw MUST be updated.
    expect(MIGRATION).toContain("'{weightedScore5}'");
    expect(MIGRATION).toContain("'{overallScore}'");
    expect(MIGRATION).toContain("'{recommendation}'");
    expect(MIGRATION).toMatch(/jsonb_set\(/);
  });

  it('extends v_funnel_failures with a HARD scoring branch off job_dlq, sanitized + phone-scoped', () => {
    expect(MIGRATION).toMatch(/create or replace view screening_v2\.v_funnel_failures/);
    // The soft incomplete_evidence branch is retained but now surfaces ONLY true
    // voids (no metric scored) — a provisionally-scored partial is not a drop.
    expect(MIGRATION).toMatch(/'scoring'::text, 'incomplete_evidence'::text/);
    expect(MIGRATION).toMatch(/scoring_status = 'incomplete_evidence' and a2\.weighted_score_5 is null/);
    // …and a hard DLQ branch added, sanitized to a stable code, scoped to phone.
    expect(MIGRATION).toContain("d.error_message ~ '^[a-z0-9_.:-]{1,64}$'");
    expect(MIGRATION).toContain("else 'scoring_failed' end");
    expect(MIGRATION).toContain("d.name like 'phone.assessment%'");
  });

  it('creates the view with security_invoker and keeps it service-role-only', () => {
    expect(MIGRATION).toContain('with (security_invoker = true)');
    expect(MIGRATION).toContain('revoke all on screening_v2.v_funnel_failures from anon, authenticated, public');
    expect(MIGRATION).toContain('grant select on screening_v2.v_funnel_failures to service_role');
  });

  it('is additive + service-role-only: no browser-role grant, no destructive DDL', () => {
    expect(MIGRATION).not.toMatch(/grant[^\n]*to[^\n]*\b(anon|authenticated)\b/i);
    expect(MIGRATION).not.toMatch(/create policy/i);
    expect(MIGRATION).not.toMatch(/using \(true\)/i);
    expect(MIGRATION).not.toMatch(/\bdrop table\b/i);
    expect(MIGRATION).not.toMatch(/\bdrop column\b/i);
    expect(MIGRATION).not.toMatch(/\btruncate\b/i);
  });
});
