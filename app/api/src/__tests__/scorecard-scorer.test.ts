/**
 * scorer.ts — role-configured scorecard scoring, all boundaries mocked.
 *
 * Proves the scorer computes server-owned weighted/overall/recommendation/status
 * from a valid model output, marks status incomplete_evidence when ANY metric
 * lacks evidence while STILL producing a provisional weighted/overall/reco
 * renormalized over the scored metrics (null only when NONE scored), and FAILS
 * CLOSED (throws) on malformed, unknown-id, duplicate, or count-mismatched model
 * output — never fabricating a score. The inference boundary is injected, so no
 * network/CLI call happens.
 */

import { describe, it, expect, vi } from 'vitest';
import { scoreWithScorecard } from '../lib/scorecards/scorer.js';
import { ScorecardValidationError } from '../lib/scorecards/domain.js';
import type {
  RoleScorecardVersion,
  ScorecardMetricModelResult,
} from '../lib/scorecards/contracts.js';
import type { TranscriptTurn } from '../lib/types.js';

const rubric = { 1: 'Poor', 2: 'Average', 3: 'Good', 4: 'Excellent' } as const;

function scorecard(weights: number[] = [5000, 3000, 2000]): RoleScorecardVersion {
  return {
    id: 'ver-1',
    roleId: 'role-1',
    version: 1,
    configurationHash: 'a'.repeat(64),
    metrics: weights.map((weightBps, index) => ({
      id: `metric-${index}`,
      libraryMetricId: `library-${index}`,
      key: `metric_${index + 1}`,
      name: `Metric ${index + 1}`,
      instruction: 'Use direct transcript evidence.',
      rubric,
      weightBps,
      displayOrder: index,
    })),
  };
}

function modelResults(scores: Array<1 | 2 | 3 | 4 | null>): ScorecardMetricModelResult[] {
  return scores.map((score, index) => ({
    configMetricId: `metric-${index}`,
    score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: 'Grounded in what the candidate actually said.',
    evidenceRefs: ['turn:1'],
  }));
}

const transcript: TranscriptTurn[] = [
  { speaker: 'bot', text: 'Tell me about a time you led a team.' },
  { speaker: 'candidate', text: 'I led a five-person team through a migration.' },
];

function input(card = scorecard()) {
  return {
    scorecard: card,
    roleTitle: 'Advisor',
    candidateName: 'Asha',
    transcript,
    resumeFacts: 'facts',
  };
}

function inferReturning(value: unknown) {
  return vi.fn(async (_prompt: string) => value);
}

describe('scoreWithScorecard — valid output', () => {
  it('computes weighted/overall/recommendation/status and attaches each metric', async () => {
    const infer = inferReturning({ results: modelResults([4, 3, 1]) });
    const result = await scoreWithScorecard({ infer }, input());

    // (5000*4 + 3000*3 + 2000*1) / 10000 = 3.1
    expect(result.weightedScore5).toBe(3.1);
    expect(result.overallScore).toBe(70); // round((3.1-1)/3*100)
    expect(result.recommendation).toBe('advance');
    expect(result.status).toBe('complete');
    expect(result.schemaVersion).toBe(2);
    // 0093: the scorer stamps the rubric scale it scored on, so every reader
    // projects this row on 1..4 even after the scale changes again.
    expect(result.scoreScaleMax).toBe(4);
    expect(result.scorecardVersionId).toBe('ver-1');
    expect(result.revision).toBe(1);

    expect(result.metricResults).toHaveLength(3);
    // Each result carries its configured metric snapshot, ordered by the config.
    expect(result.metricResults.map((r) => r.configMetricId)).toEqual([
      'metric-0',
      'metric-1',
      'metric-2',
    ]);
    expect(result.metricResults[0].metric.id).toBe('metric-0');
    expect(result.metricResults[0].metric.weightBps).toBe(5000);

    expect(infer).toHaveBeenCalledOnce();
    // The prompt string was handed to the inference boundary.
    expect(typeof infer.mock.calls[0][0]).toBe('string');
  });
});

describe('scoreWithScorecard — insufficient evidence (PARTIAL scoring)', () => {
  it('stays incomplete_evidence but still yields a PROVISIONAL score over the scored metrics', async () => {
    // One metric lacks evidence, two are scored. The scorecard must NOT be
    // voided (the production failure): renormalize over {metric-0: 5000@4,
    // metric-1: 3000@3} = (20000+9000)/8000 = 3.625 → overall round((3.625-1)/3*100)
    // = 88 → 'advance'. Status remains incomplete_evidence so the card can flag it.
    const infer = inferReturning({ results: modelResults([4, 3, null]) });
    const result = await scoreWithScorecard({ infer }, input());

    expect(result.status).toBe('incomplete_evidence');
    expect(result.weightedScore5).toBe(3.625);
    expect(result.overallScore).toBe(88);
    expect(result.recommendation).toBe('advance');
    // The insufficient metric keeps score null; it is not invented.
    expect(result.metricResults[2].score).toBeNull();
    expect(result.metricResults[2].evidenceStatus).toBe('insufficient_evidence');
  });

  it('collapses to null weighted/overall + human_review ONLY when NO metric was scored', async () => {
    const infer = inferReturning({ results: modelResults([null, null, null]) });
    const result = await scoreWithScorecard({ infer }, input());

    expect(result.status).toBe('incomplete_evidence');
    expect(result.weightedScore5).toBeNull();
    expect(result.overallScore).toBeNull();
    expect(result.recommendation).toBe('human_review');
    expect(result.metricResults.every((r) => r.score === null)).toBe(true);
  });
});

describe('scoreWithScorecard — fail closed', () => {
  it('throws when `results` is missing or not an array', async () => {
    await expect(scoreWithScorecard({ infer: inferReturning({ foo: 'bar' }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
    await expect(scoreWithScorecard({ infer: inferReturning('not json object') }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
    await expect(scoreWithScorecard({ infer: inferReturning({ results: 'nope' }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws when the result count does not match the configured metrics', async () => {
    await expect(scoreWithScorecard({ infer: inferReturning({ results: modelResults([4, 3]) }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws on an unknown configMetricId (invented metric)', async () => {
    const bad = modelResults([4, 3, 1]);
    (bad[2] as { configMetricId: string }).configMetricId = 'metric-invented';
    await expect(scoreWithScorecard({ infer: inferReturning({ results: bad }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws on a duplicate configMetricId', async () => {
    const dup = modelResults([4, 3, 1]);
    (dup[2] as { configMetricId: string }).configMetricId = 'metric-0';
    await expect(scoreWithScorecard({ infer: inferReturning({ results: dup }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws when a scored metric carries an out-of-range/invented score shape', async () => {
    const bad = modelResults([4, 3, 1]);
    // insufficient_evidence must NOT carry a score — this is the fabrication guard.
    (bad[1] as { evidenceStatus: string }).evidenceStatus = 'insufficient_evidence';
    await expect(scoreWithScorecard({ infer: inferReturning({ results: bad }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws when the model returns a RETIRED five-point score (never clamps it to 4)', async () => {
    // The realistic post-0093 failure: a cached/stale prompt makes the model
    // answer on the old 1..5 scale. A 5 must fail closed — silently clamping it
    // to 4 would fabricate a rubric level the recruiter never defined.
    const bad = modelResults([4, 3, 1]);
    (bad[0] as { score: number }).score = 5;
    await expect(scoreWithScorecard({ infer: inferReturning({ results: bad }) }, input()))
      .rejects.toThrow(/scored metric must have an integer score from 1 to 4/);
  });

  it('throws when a result element is not an object', async () => {
    await expect(
      scoreWithScorecard({ infer: inferReturning({ results: ['x', 'y', 'z'] }) }, input()),
    ).rejects.toBeInstanceOf(ScorecardValidationError);
  });
});
