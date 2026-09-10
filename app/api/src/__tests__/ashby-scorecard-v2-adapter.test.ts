/**
 * ashby/scorecard-v2-adapter — v2 assessment → ScorecardSource.
 *
 * Proves: a complete v2 row maps to metric-keyed 0–10 dimensions with the
 * overall taken from weighted_score_5 and the recommendation passed through;
 * an evidence-incomplete row fails closed with NO invented overall; a null-score
 * metric is omitted (never a fabricated 0); no metric name / rationale / evidence
 * ref leaks into the produced source; and the produced dimension keys, run
 * through the REAL bindFeedbackForm, submit only the keys the tenant binding
 * maps and silently omit the rest.
 */

import { describe, it, expect } from 'vitest';
import {
  METRIC_SCORE_TO_DIMENSION_FACTOR,
  isV2AdapterBlocked,
  scorecardSourceFromV2Assessment,
  type PersistedV2AssessmentRow,
} from '../integrations/ashby/scorecard-v2-adapter.js';
import {
  ashbyReviewPath,
  bindFeedbackForm,
  buildScorecard,
  HELLO_CHRISTY_SCORECARD_BINDING,
  isScorecardSafe,
  type ScorecardScale,
} from '../integrations/ashby/scorecard.js';

const SCALE: ScorecardScale = { min: 1, max: 4 };
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const REVIEW_PATH = ashbyReviewPath(LINK_ID);
const ORIGIN = 'https://hello.example.com';

/** One persisted metric-result entry, shaped exactly like a jsonb array member. */
function metricResult(
  key: string,
  score: number | null,
  opts: { rationale?: string; name?: string; evidenceRefs?: string[] } = {},
): Record<string, unknown> {
  return {
    configMetricId: `cfg-${key}`,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: opts.rationale ?? `rationale for ${key}`,
    evidenceRefs: opts.evidenceRefs ?? [],
    metric: {
      id: `cfg-${key}`,
      libraryMetricId: `lib-${key}`,
      key,
      name: opts.name ?? `Metric ${key}`,
      instruction: `instruction ${key}`,
      rubric: { 1: 'Poor', 2: 'Below', 3: 'Average', 4: 'Good', 5: 'Excellent' },
      weightBps: 2000,
      displayOrder: 0,
    },
  };
}

function v2Row(overrides: Partial<PersistedV2AssessmentRow> = {}): PersistedV2AssessmentRow {
  return {
    schema_version: 2,
    scoring_status: 'complete',
    weighted_score_5: 4, // → overall round(((4-1)/4)*100) = 75
    recommendation: 'advance',
    metric_results: [metricResult('english', 5), metricResult('communication', 3)],
    provenance: { requestedModel: 'deepseek-v4-pro', prompt_template_version: 'scoring-v2' },
    created_at: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

describe('scorecardSourceFromV2Assessment — happy path', () => {
  it('maps metrics to 0–10 dimensions keyed by metric key', () => {
    const result = scorecardSourceFromV2Assessment(v2Row(), { reviewPath: REVIEW_PATH });
    expect(isV2AdapterBlocked(result)).toBe(false);
    if (isV2AdapterBlocked(result)) return;

    // english 5 → 10, communication 3 → 6 (score * 2). Each dimension also
    // carries the metric NAME (what the auto-binder matches to a form field
    // title) and the raw 1–5 score (submitted 1:1 on a five-point field).
    expect(result.dimensions).toEqual([
      { key: 'english', score: 10, name: 'Metric english', metricScore: 5 },
      { key: 'communication', score: 6, name: 'Metric communication', metricScore: 3 },
    ]);
    expect(result.schemaVersion).toBe(2);
    expect(METRIC_SCORE_TO_DIMENSION_FACTOR).toBe(2);
  });

  it('takes overallScore from weighted_score_5 via the domain fn (1–5 → 0–100)', () => {
    const result = scorecardSourceFromV2Assessment(v2Row({ weighted_score_5: 4 }), {
      reviewPath: REVIEW_PATH,
    });
    if (isV2AdapterBlocked(result)) throw new Error('unexpected block');
    expect(result.overallScore).toBe(75); // round(((4-1)/4)*100)

    const min = scorecardSourceFromV2Assessment(v2Row({ weighted_score_5: 1 }), {
      reviewPath: REVIEW_PATH,
    });
    const max = scorecardSourceFromV2Assessment(v2Row({ weighted_score_5: 5 }), {
      reviewPath: REVIEW_PATH,
    });
    if (isV2AdapterBlocked(min) || isV2AdapterBlocked(max)) throw new Error('unexpected block');
    expect(min.overallScore).toBe(0);
    expect(max.overallScore).toBe(100);
  });

  it('passes the recommendation through unchanged', () => {
    for (const rec of ['advance', 'hold', 'reject'] as const) {
      const result = scorecardSourceFromV2Assessment(v2Row({ recommendation: rec }), {
        reviewPath: REVIEW_PATH,
      });
      if (isV2AdapterBlocked(result)) throw new Error('unexpected block');
      expect(result.recommendation).toBe(rec);
    }
  });

  it('produces the recruiter-facing rich summary (one line per metric) and carries provenance + reviewPath', () => {
    const result = scorecardSourceFromV2Assessment(v2Row(), { reviewPath: REVIEW_PATH });
    if (isV2AdapterBlocked(result)) throw new Error('unexpected block');
    expect(result.summary).toBe(
      'AI phone screen — weighted 4/5 across 2 metrics.\n'
      + 'Metric english — 5/5: rationale for english\n'
      + 'Metric communication — 3/5: rationale for communication',
    );
    expect(result.provenance).toEqual({
      model: 'deepseek-v4-pro',
      scoredAt: '2026-09-09T00:00:00Z',
      version: 'scoring-v2',
    });
    expect(result.reviewPath).toBe(REVIEW_PATH);
    // The whole source is redaction-safe and builds cleanly downstream.
    expect(isScorecardSafe(result)).toBe(true);
    expect(buildScorecard(result, SCALE).ok).toBe(true);
  });
});

describe('scorecardSourceFromV2Assessment — fail closed', () => {
  it('blocks an evidence-incomplete row without inventing an overall', () => {
    const result = scorecardSourceFromV2Assessment(
      v2Row({ scoring_status: 'incomplete_evidence', weighted_score_5: null }),
      { reviewPath: REVIEW_PATH },
    );
    expect(result).toEqual({ blocked: 'incomplete_evidence' });
    // No fabricated overall / recommendation anywhere on the result.
    expect(result).not.toHaveProperty('overallScore');
  });

  it('blocks a complete row whose weighted score is missing/out of range', () => {
    expect(scorecardSourceFromV2Assessment(v2Row({ weighted_score_5: null }), { reviewPath: REVIEW_PATH })).toEqual({
      blocked: 'incomplete_evidence',
    });
    expect(scorecardSourceFromV2Assessment(v2Row({ weighted_score_5: 6 }), { reviewPath: REVIEW_PATH })).toEqual({
      blocked: 'incomplete_evidence',
    });
  });

  it('blocks a non-v2 row (schema_version != 2)', () => {
    expect(scorecardSourceFromV2Assessment(v2Row({ schema_version: 1 }), { reviewPath: REVIEW_PATH })).toEqual({
      blocked: 'not_v2',
    });
  });

  it('blocks a complete row missing a valid recommendation (never defaults it)', () => {
    expect(
      scorecardSourceFromV2Assessment(v2Row({ recommendation: null }), { reviewPath: REVIEW_PATH }),
    ).toEqual({ blocked: 'invalid_recommendation' });
    expect(
      scorecardSourceFromV2Assessment(v2Row({ recommendation: 'human_review' }), { reviewPath: REVIEW_PATH }),
    ).toEqual({ blocked: 'invalid_recommendation' });
  });

  it('blocks when no metric survives to a scored dimension', () => {
    const result = scorecardSourceFromV2Assessment(v2Row({ metric_results: [] }), {
      reviewPath: REVIEW_PATH,
    });
    expect(result).toEqual({ blocked: 'no_dimensions' });
  });
});

describe('scorecardSourceFromV2Assessment — omission & redaction', () => {
  it('omits a null-score metric instead of emitting a fabricated 0', () => {
    // Defensive: a genuinely complete row would not carry a null-score metric,
    // but the adapter must never emit a 0 for one if it appears.
    const row = v2Row({
      metric_results: [metricResult('english', 5), metricResult('motivation', null)],
    });
    const result = scorecardSourceFromV2Assessment(row, { reviewPath: REVIEW_PATH });
    if (isV2AdapterBlocked(result)) throw new Error('unexpected block');
    expect(result.dimensions).toEqual([{ key: 'english', score: 10, name: 'Metric english', metricScore: 5 }]);
    expect(result.dimensions.some((d) => d.key === 'motivation')).toBe(false);
    // …but the recruiter is TOLD it was considered and why it has no score.
    expect(result.summary).toContain('Metric motivation — not scored (insufficient evidence): rationale for motivation');
  });

  it('never leaks evidence refs; rationale appears ONLY in the summary; the name only on its dimension', () => {
    // Owner decision (#275): the Summary field carries the per-metric
    // rationales — that is the recruiter-facing "why". Evidence refs (transcript
    // turn ids, recording clips) are still never copied anywhere.
    const row = v2Row({
      metric_results: [
        metricResult('english', 5, {
          rationale: 'RATIONALE_ONE candidate gave two concrete examples',
          name: 'Display Name One',
          evidenceRefs: ['recording://clip-1', 'turn-42'],
        }),
        metricResult('communication', 3, { rationale: 'RATIONALE_TWO text' }),
      ],
    });
    const result = scorecardSourceFromV2Assessment(row, { reviewPath: REVIEW_PATH });
    if (isV2AdapterBlocked(result)) throw new Error('unexpected block');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('recording://');
    expect(serialized).not.toContain('turn-42');
    expect(serialized).not.toContain('evidenceRefs');
    // Rationale text lives in the summary and nowhere else.
    expect(result.summary).toContain('RATIONALE_ONE');
    expect(JSON.stringify({ ...result, summary: '' })).not.toContain('RATIONALE_ONE');
    // The name rides on its dimension (for the auto-binder) and in the summary.
    expect(result.dimensions[0].name).toBe('Display Name One');
    // Forbidden-key scan passes and the payload builds.
    expect(isScorecardSafe(result)).toBe(true);
    expect(buildScorecard(result, SCALE).ok).toBe(true);
  });

  it('bounds an over-long rationale and control characters, and keeps the summary under the field budget', () => {
    const long = 'x'.repeat(2_000);
    const row = v2Row({
      metric_results: Array.from({ length: 12 }, (_, i) => metricResult(`m${i}`, 4, { rationale: `${long}\u0000\n\ttail` })),
    });
    const result = scorecardSourceFromV2Assessment(row, { reviewPath: REVIEW_PATH });
    if (isV2AdapterBlocked(result)) throw new Error('unexpected block');
    expect(result.summary.length).toBeLessThanOrEqual(2_000);
    expect(result.summary).not.toContain('\u0000');
    expect(result.summary.startsWith('AI phone screen — weighted 4/5 across 12 metrics.')).toBe(true);
    // Whole lines only — every line that made it in ends with the ellipsis of a bounded rationale.
    for (const line of result.summary.split('\n').slice(1)) expect(line.endsWith('…')).toBe(true);
    expect(buildScorecard(result, SCALE).ok).toBe(true);
  });
});

describe('mapped vs unmapped — end to end through the real bindFeedbackForm', () => {
  it('submits only the metric keys the tenant binding maps and omits the rest', () => {
    // english + communication ARE in HELLO_CHRISTY_SCORECARD_BINDING; the
    // 'seniority' metric key is NOT — it must be omitted at bind time, never
    // guessed onto a field.
    const row = v2Row({
      metric_results: [
        metricResult('english', 5),
        metricResult('communication', 4),
        metricResult('seniority', 2),
      ],
    });
    const source = scorecardSourceFromV2Assessment(row, { reviewPath: REVIEW_PATH });
    if (isV2AdapterBlocked(source)) throw new Error('unexpected block');
    // The adapter itself keeps ALL scored metrics, including the unmapped one.
    expect(source.dimensions.map((d) => d.key)).toEqual(['english', 'communication', 'seniority']);

    const built = buildScorecard(source, SCALE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, ORIGIN);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const submissions = (bound.feedbackForm as { fieldSubmissions: Array<{ path: string; value: unknown }> })
      .fieldSubmissions;
    // Dimension submissions are the ones whose value is `{ score: n }`.
    const dimPaths = submissions
      .filter((s) => {
        const v = s.value as Record<string, unknown> | null;
        return v !== null && typeof v === 'object' && typeof v.score === 'number';
      })
      .map((s) => s.path)
      .sort();

    const dims = HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.dimensions;
    // english + communication mapped → their paths present; seniority absent.
    expect(dimPaths).toEqual([dims.communication, dims.english].sort());
    expect(dimPaths).toHaveLength(2);
    expect(dimPaths).not.toContain(dims.motivation); // mapped in binding but not scored here
  });
});
