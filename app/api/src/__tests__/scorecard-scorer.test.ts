/**
 * scorer.ts — role-configured scorecard scoring, all boundaries mocked.
 *
 * Proves the scorer computes server-owned weighted/overall/recommendation/status
 * from a valid model output, collapses to incomplete_evidence + null weighted
 * when ANY metric lacks evidence, and FAILS CLOSED (throws) on malformed,
 * unknown-id, duplicate, or count-mismatched model output — never fabricating a
 * score. The inference boundary is injected, so no network/CLI call happens.
 */

import { describe, it, expect, vi } from 'vitest';
import { scoreWithScorecard } from '../lib/scorecards/scorer.js';
import { ScorecardValidationError } from '../lib/scorecards/domain.js';
import type {
  RoleScorecardVersion,
  ScorecardMetricModelResult,
} from '../lib/scorecards/contracts.js';
import type { TranscriptTurn } from '../lib/types.js';

const rubric = { 1: 'Poor', 2: 'Below average', 3: 'Average', 4: 'Good', 5: 'Excellent' } as const;

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

function modelResults(scores: Array<1 | 2 | 3 | 4 | 5 | null>): ScorecardMetricModelResult[] {
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
    const infer = inferReturning({ results: modelResults([5, 3, 1]) });
    const result = await scoreWithScorecard({ infer }, input());

    // (5000*5 + 3000*3 + 2000*1) / 10000 = 3.6
    expect(result.weightedScore5).toBe(3.6);
    expect(result.overallScore).toBe(65); // round((3.6-1)/4*100)
    expect(result.recommendation).toBe('advance');
    expect(result.status).toBe('complete');
    expect(result.schemaVersion).toBe(2);
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

describe('scoreWithScorecard — insufficient evidence', () => {
  it('collapses to incomplete_evidence with null weighted/overall and human_review', async () => {
    const infer = inferReturning({ results: modelResults([5, 3, null]) });
    const result = await scoreWithScorecard({ infer }, input());

    expect(result.status).toBe('incomplete_evidence');
    expect(result.weightedScore5).toBeNull();
    expect(result.overallScore).toBeNull();
    expect(result.recommendation).toBe('human_review');
    // The insufficient metric keeps score null; it is not invented.
    expect(result.metricResults[2].score).toBeNull();
    expect(result.metricResults[2].evidenceStatus).toBe('insufficient_evidence');
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
    await expect(scoreWithScorecard({ infer: inferReturning({ results: modelResults([5, 3]) }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws on an unknown configMetricId (invented metric)', async () => {
    const bad = modelResults([5, 3, 1]);
    (bad[2] as { configMetricId: string }).configMetricId = 'metric-invented';
    await expect(scoreWithScorecard({ infer: inferReturning({ results: bad }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws on a duplicate configMetricId', async () => {
    const dup = modelResults([5, 3, 1]);
    (dup[2] as { configMetricId: string }).configMetricId = 'metric-0';
    await expect(scoreWithScorecard({ infer: inferReturning({ results: dup }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws when a scored metric carries an out-of-range/invented score shape', async () => {
    const bad = modelResults([5, 3, 1]);
    // insufficient_evidence must NOT carry a score — this is the fabrication guard.
    (bad[1] as { evidenceStatus: string }).evidenceStatus = 'insufficient_evidence';
    await expect(scoreWithScorecard({ infer: inferReturning({ results: bad }) }, input()))
      .rejects.toBeInstanceOf(ScorecardValidationError);
  });

  it('throws when a result element is not an object', async () => {
    await expect(
      scoreWithScorecard({ infer: inferReturning({ results: ['x', 'y', 'z'] }) }, input()),
    ).rejects.toBeInstanceOf(ScorecardValidationError);
  });
});
