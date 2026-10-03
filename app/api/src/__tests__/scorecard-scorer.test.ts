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
  // E5: a model-output failure gets exactly ONE repair resample. When the model
  // keeps returning the same bad output, the call still rejects — and infer is
  // called exactly twice, never a third time.
  async function expectFailsClosedTwice(value: unknown, message?: RegExp): Promise<void> {
    const infer = inferReturning(value);
    const run = scoreWithScorecard({ infer, onDiagnostic: () => {} }, input());
    if (message) await expect(run).rejects.toThrow(message);
    else await expect(run).rejects.toBeInstanceOf(ScorecardValidationError);
    expect(infer).toHaveBeenCalledTimes(2);
  }

  it('throws when `results` is missing or not an array', async () => {
    await expectFailsClosedTwice({ foo: 'bar' });
    await expectFailsClosedTwice('not json object');
    await expectFailsClosedTwice({ results: 'nope' });
  });

  it('throws when the result count does not match the configured metrics', async () => {
    await expectFailsClosedTwice({ results: modelResults([4, 3]) });
  });

  it('throws on an unknown configMetricId (invented metric)', async () => {
    const bad = modelResults([4, 3, 1]);
    (bad[2] as { configMetricId: string }).configMetricId = 'metric-invented';
    await expectFailsClosedTwice({ results: bad });
  });

  it('throws on a duplicate configMetricId', async () => {
    const dup = modelResults([4, 3, 1]);
    (dup[2] as { configMetricId: string }).configMetricId = 'metric-0';
    await expectFailsClosedTwice({ results: dup });
  });

  it('throws when a scored metric carries an out-of-range/invented score shape', async () => {
    const bad = modelResults([4, 3, 1]);
    // insufficient_evidence must NOT carry a score — this is the fabrication guard.
    (bad[1] as { evidenceStatus: string }).evidenceStatus = 'insufficient_evidence';
    await expectFailsClosedTwice({ results: bad });
  });

  it('throws when the model returns a RETIRED five-point score (never clamps it to 4)', async () => {
    // The realistic post-0093 failure: a cached/stale prompt makes the model
    // answer on the old 1..5 scale. A 5 must fail closed — silently clamping it
    // to 4 would fabricate a rubric level the recruiter never defined.
    const bad = modelResults([4, 3, 1]);
    (bad[0] as { score: number }).score = 5;
    await expectFailsClosedTwice({ results: bad }, /scored metric must have an integer score from 1 to 4/);
  });

  it('throws when a result element is not an object', async () => {
    await expectFailsClosedTwice({ results: ['x', 'y', 'z'] });
  });
});

// ═══════════════════════════════════════════════════════════════════
// E5 — normalized persistence, one repair inference, diagnostics
// ═══════════════════════════════════════════════════════════════════

const SAFE_IDENT_RE = /^[a-zA-Z0-9_:.\-]{1,64}$/;

/** An infer double that returns each value in turn and records every prompt. */
function inferSequence(...values: unknown[]) {
  const prompts: string[] = [];
  let call = 0;
  const infer = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    const value = values[Math.min(call, values.length - 1)];
    call += 1;
    return value;
  });
  return { infer, prompts };
}

function unknownIdOutput() {
  const bad = modelResults([4, 3, 1]);
  (bad[2] as { configMetricId: string }).configMetricId = 'metric-invented';
  // A recognisable model-text marker: it must never reach the repair prompt.
  (bad[0] as { rationale: string }).rationale = 'MODEL-TEXT-MARKER should never be echoed back.';
  return { results: bad };
}

describe('scoreWithScorecard — E5 normalized persistence', () => {
  it('persists the normalizer\'s objects: exact keys, numeric score, truncated refs', async () => {
    const noisy = modelResults([4, 3, 1]).map((r, i) => ({
      ...r,
      score: i === 0 ? '4' : r.score,
      evidenceRefs: [`${'q'.repeat(150)}`],
      modelExtra: 'should not persist',
    }));
    const clean = modelResults([4, 3, 1]).map((r) => ({ ...r, evidenceRefs: ['short'] }));

    const result = await scoreWithScorecard({ infer: inferReturning({ results: noisy }), onDiagnostic: () => {} }, input());
    const baseline = await scoreWithScorecard({ infer: inferReturning({ results: clean }), onDiagnostic: () => {} }, input());

    for (const metricResult of result.metricResults) {
      expect(Object.keys(metricResult).sort()).toEqual(
        ['configMetricId', 'evidenceRefs', 'evidenceStatus', 'metric', 'rationale', 'score'],
      );
      expect(metricResult.evidenceRefs[0]).toHaveLength(100);
      expect(metricResult.evidenceRefs[0].endsWith('…')).toBe(true);
    }
    expect(result.metricResults[0].score).toBe(4);
    expect(typeof result.metricResults[0].score).toBe('number');
    expect(result.weightedScore5).toBe(baseline.weightedScore5);
    expect(result.overallScore).toBe(baseline.overallScore);
    expect(result.recommendation).toBe(baseline.recommendation);
  });
});

describe('scoreWithScorecard — E5 one repair inference', () => {
  it('bad then good: resolves with exactly 2 infer calls; the 2nd prompt extends the 1st with a fixed hint only', async () => {
    const { infer, prompts } = inferSequence(unknownIdOutput(), { results: modelResults([4, 3, 1]) });
    const events: Array<{ kind: string; code: string }> = [];
    const result = await scoreWithScorecard({ infer, onDiagnostic: (e) => events.push(e) }, input());

    expect(result.weightedScore5).toBe(3.1);
    expect(infer).toHaveBeenCalledTimes(2);
    const [first, second] = prompts;
    // Same prefix byte-for-byte, so the per-call sentinel is unchanged…
    expect(second.startsWith(first)).toBe(true);
    const sentinel = first.match(/BEGIN UNTRUSTED CANDIDATE TRANSCRIPT ([0-9a-f]+)/)![1];
    expect(second).toContain(`END UNTRUSTED CANDIDATE TRANSCRIPT ${sentinel}`);
    // …and the hint sits AFTER the transcript fence.
    const suffix = second.slice(first.length);
    expect(first.endsWith(`[END UNTRUSTED CANDIDATE TRANSCRIPT ${sentinel}]`)).toBe(true);
    expect(suffix).toContain('An earlier answer to this request was rejected');
    expect(suffix).toContain('return exactly one result for each configMetricId listed above, using the ids verbatim');
    expect(suffix).toContain('Re-read the OUTPUT CONTRACT and RULES');
    // Never the model's text, the invented id, or the validator's message.
    expect(suffix).not.toContain('MODEL-TEXT-MARKER');
    expect(suffix).not.toContain('metric-invented');
    expect(suffix).not.toContain('unknown or duplicate metric ID');
    expect(events).toEqual([
      { kind: 'repair_attempted', code: 'scorecard_invalid:unknown_metric_id' },
      { kind: 'repair_succeeded', code: 'scorecard_invalid:unknown_metric_id' },
    ]);
  });

  it('insufficient_with_score: the hint keeps the honest gap (JSON null, never switch to "scored")', async () => {
    const bad = modelResults([4, null, 1]);
    (bad[1] as { score: number }).score = 2;
    const { infer, prompts } = inferSequence({ results: bad }, { results: modelResults([4, null, 1]) });
    await scoreWithScorecard({ infer, onDiagnostic: () => {} }, input());
    const suffix = prompts[1].slice(prompts[0].length);
    expect(suffix).toContain('do NOT change it to "scored"');
    expect(suffix).toContain('JSON null');
  });

  it('two bad outputs reject with the SECOND code, and infer is never called a third time', async () => {
    const secondBad = modelResults([4, 3, 1]);
    (secondBad[0] as { score: number }).score = 5;
    const { infer } = inferSequence(unknownIdOutput(), { results: secondBad }, { results: modelResults([4, 3, 1]) });
    const events: Array<{ kind: string; code: string }> = [];
    const err = await scoreWithScorecard({ infer, onDiagnostic: (e) => events.push(e) }, input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScorecardValidationError);
    expect((err as ScorecardValidationError).code).toBe('scorecard_invalid:score_not_integer_1_4');
    expect(infer).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { kind: 'repair_attempted', code: 'scorecard_invalid:unknown_metric_id' },
      { kind: 'repair_failed', code: 'scorecard_invalid:score_not_integer_1_4' },
    ]);
  });

  it('a corrupt scorecard config throws scorecard_invalid:config with no repair', async () => {
    const card = scorecard([5000, 3000, 1999]); // weights do not total 10000
    const { infer } = inferSequence({ results: modelResults([4, 3, 1]) });
    const events: unknown[] = [];
    const err = await scoreWithScorecard({ infer, onDiagnostic: (e) => events.push(e) }, input(card)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScorecardValidationError);
    expect((err as ScorecardValidationError).code).toBe('scorecard_invalid:config');
    expect(infer.mock.calls.length).toBeLessThanOrEqual(1);
    expect(events).toEqual([]);
  });

  it('a provider error is rethrown unchanged with no repair', async () => {
    const providerError = new Error('timeout');
    const infer = vi.fn(async () => { throw providerError; });
    await expect(scoreWithScorecard({ infer, onDiagnostic: () => {} }, input())).rejects.toBe(providerError);
    expect(infer).toHaveBeenCalledTimes(1);
  });
});

describe('scoreWithScorecard — E5 diagnostics', () => {
  it('a valid first output: one infer call and no diagnostic', async () => {
    const infer = inferReturning({ results: modelResults([4, 3, 1]) });
    const onDiagnostic = vi.fn();
    await scoreWithScorecard({ infer, onDiagnostic }, input());
    expect(infer).toHaveBeenCalledOnce();
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('output needing only normalization: one infer call, one event per applied rule, each a safe code', async () => {
    const noisy = modelResults([4, 3, 1]).map((r, i) => ({
      ...r,
      score: i === 1 ? '3' : r.score,
      evidenceRefs: i === 0 ? ['r'.repeat(130)] : r.evidenceRefs,
    }));
    const infer = inferReturning({ results: noisy });
    const onDiagnostic = vi.fn();
    await scoreWithScorecard({ infer, onDiagnostic }, input());
    expect(infer).toHaveBeenCalledOnce();
    expect(onDiagnostic.mock.calls.map(([e]) => e)).toEqual([
      { kind: 'normalized', code: 'evidence_ref_truncated' },
      { kind: 'normalized', code: 'score_string_coerced' },
    ]);
    for (const [event] of onDiagnostic.mock.calls) {
      expect((event as { code: string }).code).toMatch(SAFE_IDENT_RE);
    }
  });
});
