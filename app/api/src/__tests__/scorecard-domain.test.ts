import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ScorecardValidationError,
  calculateWeightedScore,
  hashRoleScorecard,
  normalizeModelResults,
  recommendationForOverall,
  redistributeWeights,
  validateMetricResults,
  validateRoleMetrics,
  validateRubric,
  weightedScoreToOverall,
} from '../lib/scorecards/domain.js';
import {
  SCORECARD_NORMALIZATION_RULES,
  SCORECARD_VALIDATION_CODES,
  type RoleScorecardMetric,
  type ScorecardMetricModelResult,
} from '../lib/scorecards/contracts.js';
import { sanitizeErrorCode } from '../lib/queue/runner.js';
import { createLogger } from '../lib/logger.js';

const rubric = { 1: 'Poor', 2: 'Average', 3: 'Good', 4: 'Excellent' } as const;
function metrics(weights = [5000, 3000, 2000]): RoleScorecardMetric[] {
  return weights.map((weightBps, index) => ({
    id: `metric-${index}`, libraryMetricId: `library-${index}`, key: `metric_${index + 1}`,
    name: `Metric ${index + 1}`, instruction: 'Use direct transcript evidence.', rubric,
    weightBps, displayOrder: index,
  }));
}
function results(scores: Array<1 | 2 | 3 | 4 | null>): ScorecardMetricModelResult[] {
  return scores.map((score, index) => ({
    configMetricId: `metric-${index}`, score,
    evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
    rationale: 'Evidence is bounded and grounded in the transcript.', evidenceRefs: ['turn:1'],
  }));
}

describe('scorecard domain', () => {
  it('requires exact positive weights and immutable metric shape', () => {
    expect(() => validateRoleMetrics(metrics([5000, 4999, 0]))).toThrow(ScorecardValidationError);
    expect(() => validateRoleMetrics([{ ...metrics()[0], rubric: { ...rubric, 6: 'Injected' } as unknown as typeof rubric }])).toThrow(ScorecardValidationError);
    expect(validateRoleMetrics(metrics())).toHaveLength(3);
  });

  it('accepts EXACTLY the four rubric levels — a 5-key or 3-key rubric is rejected', () => {
    // 0093 closed the rubric at four levels. The retired five-level shape is the
    // one a stale caller (or an un-migrated library row) would send, so it must
    // be refused as loudly as a short rubric — never silently truncated.
    const fiveLevel = { ...rubric, 5: 'Excellent (retired level)' } as unknown as typeof rubric;
    const threeLevel = { 1: 'Poor', 2: 'Average', 3: 'Good' } as unknown as typeof rubric;
    expect(() => validateRubric(fiveLevel)).toThrow(/exactly levels 1,2,3,4/);
    expect(() => validateRubric(threeLevel)).toThrow(/exactly levels 1,2,3,4/);
    expect(() => validateRubric(null)).toThrow(/levels 1\.\.4/);
    expect(() => validateRubric([rubric[1], rubric[2], rubric[3], rubric[4]])).toThrow(/levels 1\.\.4/);
    // …and the four-level rubric round-trips with numeric keys.
    expect(validateRubric({ ...rubric })).toEqual(rubric);
  });

  it('redistributes proportionally with deterministic largest-remainder rounding', () => {
    const next = redistributeWeights(metrics([5000, 3000, 2000]), 'metric-0', 4000);
    expect(next.map((metric) => metric.weightBps)).toEqual([4000, 3600, 2400]);
    expect(next.reduce((sum, metric) => sum + metric.weightBps, 0)).toBe(10_000);
    expect(redistributeWeights(metrics([3334, 3333, 3333]), 'metric-0', 1)
      .map((metric) => metric.weightBps)).toEqual([1, 5000, 4999]);
  });

  it('always preserves exact total, pin, and positive weights', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 9998 }),
      (editedWeight) => {
        const next = redistributeWeights(metrics(), 'metric-0', editedWeight);
        expect(next[0].weightBps).toBe(editedWeight);
        expect(next.reduce((sum, metric) => sum + metric.weightBps, 0)).toBe(10_000);
        expect(next.every((metric) => Number.isInteger(metric.weightBps) && metric.weightBps > 0)).toBe(true);
      },
    ));
  });

  it('reserves a positive weight for every metric under an adversarial double-pin (FIX 3, no 0 bps)', () => {
    // start [2500,2500,2500,2500] → pin metric-0=9900 → then pin metric-1=9800.
    // The old proportional split floored metric-3 to 0 bps (invalid weightBps<1,
    // the save 400s and the slider sticks). The reserve-1 rule keeps every OTHER
    // metric >= 1 while still totalling 10000 with the pin exact.
    const start = metrics([2500, 2500, 2500, 2500]);
    const afterFirst = redistributeWeights(start, 'metric-0', 9900);
    expect(afterFirst.map((m) => m.weightBps)).toEqual([9900, 34, 33, 33]);

    const afterSecond = redistributeWeights(afterFirst, 'metric-1', 9800);
    expect(afterSecond.map((m) => m.weightBps)).toEqual([197, 9800, 2, 1]);
    expect(afterSecond.reduce((sum, m) => sum + m.weightBps, 0)).toBe(10_000);
    expect(afterSecond.find((m) => m.id === 'metric-1')!.weightBps).toBe(9800);
    expect(afterSecond.every((m) => m.weightBps >= 1)).toBe(true);
  });

  it('produces the byte-identical result the client mirror asserts (shared cases)', () => {
    // These SAME cases + expected literals are asserted in the web client test
    // app/web/src/lib/__tests__/scorecard-weights.test.ts; editing one side of
    // the redistribution math without the other breaks this equality.
    const cases: Array<{ weights: number[]; editIndex: number; newWeight: number; expected: number[] }> = [
      { weights: [5000, 3000, 2000], editIndex: 0, newWeight: 4000, expected: [4000, 3600, 2400] },
      { weights: [2500, 2500, 2500, 2500], editIndex: 0, newWeight: 9900, expected: [9900, 34, 33, 33] },
      { weights: [3334, 3333, 3333], editIndex: 0, newWeight: 1, expected: [1, 5000, 4999] },
      { weights: [3334, 3333, 3333], editIndex: 0, newWeight: 5000, expected: [5000, 2500, 2500] },
      { weights: [3333, 3333, 3334], editIndex: 0, newWeight: 3000, expected: [3000, 3499, 3501] },
    ];
    for (const { weights, editIndex, newWeight, expected } of cases) {
      const out = redistributeWeights(metrics(weights), `metric-${editIndex}`, newWeight);
      expect(out.map((m) => m.weightBps), `[${weights}] pin#${editIndex}=${newWeight}`).toEqual(expected);
      expect(out.reduce((sum, m) => sum + m.weightBps, 0)).toBe(10_000);
    }
  });

  it('hashes the canonical display order and snapshot fields', () => {
    const original = metrics();
    expect(hashRoleScorecard(original)).toBe(hashRoleScorecard([...original].reverse()));
    expect(hashRoleScorecard(original)).not.toBe(hashRoleScorecard([{ ...original[0], instruction: 'Different.' }, ...original.slice(1)]));
  });

  it('computes server-owned scores and never invents missing evidence', () => {
    // (5000*4 + 3000*3 + 2000*1) / 10000 = 3.1 on the four-point rubric.
    expect(calculateWeightedScore(metrics(), results([4, 3, 1]))).toBe(3.1);
    expect(weightedScoreToOverall(1)).toBe(0);
    expect(weightedScoreToOverall(2.5)).toBe(50); // the midpoint of 1..4
    expect(weightedScoreToOverall(3.1)).toBe(70);
    expect(weightedScoreToOverall(4)).toBe(100);
    expect(recommendationForOverall(65)).toBe('advance');
    expect(recommendationForOverall(45)).toBe('hold');
    expect(recommendationForOverall(null)).toBe('human_review');
  });

  it('projects a pre-0093 five-point row and a 0093 four-point row onto the SAME 0–100 meaning', () => {
    // The whole point of carrying `score_scale_max` on the row: the midpoint of
    // each scale must land on the same overall, so a historical assessment and a
    // new one are comparable on the candidate card and in the funnel rollups.
    expect(weightedScoreToOverall(3, 5)).toBe(50);
    expect(weightedScoreToOverall(2.5, 4)).toBe(50);
    // Endpoints agree too.
    expect(weightedScoreToOverall(1, 5)).toBe(0);
    expect(weightedScoreToOverall(1, 4)).toBe(0);
    expect(weightedScoreToOverall(5, 5)).toBe(100);
    expect(weightedScoreToOverall(4, 4)).toBe(100);
    // The default scale is the CURRENT one, so an untagged call is four-point.
    expect(weightedScoreToOverall(4)).toBe(weightedScoreToOverall(4, 4));
    // A null weighted score stays null on either scale — never an invented 0.
    expect(weightedScoreToOverall(null, 5)).toBeNull();
    expect(weightedScoreToOverall(null)).toBeNull();
  });

  it('fails closed on an unknown rubric scale and on a score outside that scale', () => {
    // Only 4 and 5 are admissible scales; anything else would silently
    // mis-project a persisted score, so it throws instead.
    expect(() => weightedScoreToOverall(3, 6)).toThrow(/unknown rubric scale/);
    expect(() => weightedScoreToOverall(3, 10)).toThrow(/unknown rubric scale/);
    // 5 is in range for a pre-0093 row and OUT of range on the four-point scale.
    expect(weightedScoreToOverall(5, 5)).toBe(100);
    expect(() => weightedScoreToOverall(5)).toThrow(/weighted score must be between 1 and 4/);
    expect(() => weightedScoreToOverall(0.5)).toThrow(/weighted score must be between 1 and 4/);
    expect(() => weightedScoreToOverall(5.5, 5)).toThrow(/weighted score must be between 1 and 5/);
  });

  it('PARTIAL SCORING: renormalizes over the scored metrics; null ONLY when none scored', () => {
    // The production failure (assessment e333af5d): one un-evidenced metric must
    // NOT void the whole card. With weights [5000, 3000, 2000], scoring only
    // metric-0 (4) and metric-2 (1) renormalizes over {5000, 2000}:
    //   (5000*4 + 2000*1) / (5000+2000) = 22000/7000 = 3.1429 (4dp).
    expect(calculateWeightedScore(metrics(), results([4, null, 1]))).toBe(3.1429);
    // The e333af5d shape itself: 5 equal metrics, 3 scored @3, 2 insufficient →
    // renormalizes to exactly 3.0, the recovered weighted value.
    expect(calculateWeightedScore(metrics([2000, 2000, 2000, 2000, 2000]), results([3, null, null, 3, 3]))).toBe(3);
    // That weighted 3.0 is projected on the RUBRIC SCALE OF THE ROW. The 0091
    // recovery ran on the five-point rubric, where 3/5 → 50 → 'hold'. The same
    // shape scored today is 3/4 ('Good') → 67 → 'advance'. Both are correct for
    // their own scale — which is exactly why the scale is persisted per row.
    expect(weightedScoreToOverall(3, 5)).toBe(50);
    expect(recommendationForOverall(50)).toBe('hold');
    expect(weightedScoreToOverall(3)).toBe(67);
    expect(recommendationForOverall(67)).toBe('advance');
    // A single scored metric still yields that metric's score (renormalized to 1).
    expect(calculateWeightedScore(metrics(), results([null, 4, null]))).toBe(4);
    // Null ONLY when NOT ONE metric was scored — a genuinely unscoreable screening.
    expect(calculateWeightedScore(metrics(), results([null, null, null]))).toBeNull();
    // Full coverage is unchanged: weightTotal == 10000, so identical to before.
    expect(calculateWeightedScore(metrics(), results([4, 3, 1]))).toBe(3.1);
  });

  it('rejects missing, extra, duplicate, fractional, off-scale, and invented scores', () => {
    // A FULL-LENGTH result list with only element 0 corrupted, so each case trips
    // the guard it names rather than the (earlier) count check.
    const corruptFirst = (patch: Partial<ScorecardMetricModelResult>): ScorecardMetricModelResult[] =>
      [{ ...results([4])[0], ...patch }, ...results([4, 3, 2]).slice(1)];

    expect(() => validateMetricResults(metrics(), results([4, 3]))).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), [...results([4, 3, 2]), { ...results([4])[0], configMetricId: 'unknown' }])).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), corruptFirst({ configMetricId: 'metric-1' }))).toThrow(ScorecardValidationError);
    expect(() => validateMetricResults(metrics(), corruptFirst({ score: 2.5 as 3 })))
      .toThrow(/scored metric must have an integer score from 1 to 4/);
    // A 5 is what a stale prompt/model would still emit; on the four-point rubric
    // it is off-scale and must be refused rather than clamped down to 4.
    expect(() => validateMetricResults(metrics(), corruptFirst({ score: 5 as 3 })))
      .toThrow(/scored metric must have an integer score from 1 to 4/);
    // insufficient_evidence must never carry a score — the fabrication guard.
    expect(() => validateMetricResults(metrics(), corruptFirst({ evidenceStatus: 'insufficient_evidence' })))
      .toThrow(/must not receive an invented score/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E5 — stable validation codes + presentation-only normalizer
// ═══════════════════════════════════════════════════════════════════

/** The code a synchronous call throws; fails the test if it does not throw one. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ScorecardValidationError);
    return (err as ScorecardValidationError).code;
  }
  throw new Error('expected a ScorecardValidationError');
}

/** A full, valid raw model entry for metric-<index>, with `patch` applied. */
function rawEntry(index: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configMetricId: `metric-${index}`, score: 3, evidenceStatus: 'scored',
    rationale: 'The candidate described a concrete example.', evidenceRefs: ['short quote'],
    ...patch,
  };
}

function rawAll(patch0: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [rawEntry(0, patch0), rawEntry(1), rawEntry(2)];
}

describe('E5 — ScorecardValidationError codes', () => {
  const corruptFirst = (patch: Record<string, unknown>): ScorecardMetricModelResult[] =>
    [{ ...results([4])[0], ...patch } as unknown as ScorecardMetricModelResult, ...results([4, 3, 2]).slice(1)];

  it('defaults to the config code and keeps config validators on it', () => {
    expect(new ScorecardValidationError('x').code).toBe('scorecard_invalid:config');
    expect(codeOf(() => validateRoleMetrics(metrics([5000, 4999, 0])))).toBe('scorecard_invalid:config');
    expect(codeOf(() => validateRubric(null))).toBe('scorecard_invalid:config');
    expect(codeOf(() => weightedScoreToOverall(3, 6))).toBe('scorecard_invalid:config');
    // A corrupt configuration reaching validateMetricResults is still config.
    expect(codeOf(() => validateMetricResults(metrics([5000, 4999, 0]), results([4, 3, 2])))).toBe('scorecard_invalid:config');
  });

  it('gives every validateMetricResults throw site its own code', () => {
    expect(codeOf(() => validateMetricResults(metrics(), results([4, 3])))).toBe('scorecard_invalid:result_count');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ configMetricId: 'invented' }))))
      .toBe('scorecard_invalid:unknown_metric_id');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ configMetricId: 'metric-1' }))))
      .toBe('scorecard_invalid:duplicate_metric_id');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceStatus: 'partial' }))))
      .toBe('scorecard_invalid:evidence_status');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ score: 5 }))))
      .toBe('scorecard_invalid:score_not_integer_1_4');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceStatus: 'insufficient_evidence' }))))
      .toBe('scorecard_invalid:insufficient_with_score');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ rationale: '   ' }))))
      .toBe('scorecard_invalid:rationale_empty');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ rationale: 42 }))))
      .toBe('scorecard_invalid:rationale_empty');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ rationale: 'x'.repeat(1001) }))))
      .toBe('scorecard_invalid:rationale_too_long');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceRefs: 'quote' }))))
      .toBe('scorecard_invalid:evidence_refs_not_array');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceRefs: Array(11).fill('q') }))))
      .toBe('scorecard_invalid:evidence_refs_too_many');
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceRefs: [7] }))))
      .toBe('scorecard_invalid:evidence_ref_not_string');
    // Called DIRECTLY, the validator stays exactly as strict as before.
    expect(codeOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceRefs: ['x'.repeat(101)] }))))
      .toBe('scorecard_invalid:evidence_ref_too_long');
    expect(() => validateMetricResults(metrics(), corruptFirst({ evidenceRefs: ['x'.repeat(100)] }))).not.toThrow();
  });

  it('keeps every historical message byte-identical (admin 400 bodies and regex tests read them)', () => {
    const messageOf = (fn: () => unknown): string => {
      try { fn(); } catch (err) { return (err as Error).message; }
      return '<no throw>';
    };
    expect(messageOf(() => validateMetricResults(metrics(), results([4, 3]))))
      .toBe('model output must contain exactly one result per metric');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ configMetricId: 'invented' }))))
      .toBe('model output contains an unknown or duplicate metric ID');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ configMetricId: 'metric-1' }))))
      .toBe('model output contains an unknown or duplicate metric ID');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceStatus: 'partial' }))))
      .toBe('metric evidence status is invalid');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ score: 5 }))))
      .toBe('scored metric must have an integer score from 1 to 4');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceStatus: 'insufficient_evidence' }))))
      .toBe('insufficient-evidence metric must not receive an invented score');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ rationale: 42 }))))
      .toBe('metric rationale must be text');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ rationale: '' }))))
      .toBe('metric rationale must contain 1..1000 characters');
    expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ rationale: 'x'.repeat(1001) }))))
      .toBe('metric rationale must contain 1..1000 characters');
    for (const refs of ['q', Array(11).fill('q'), [7], ['x'.repeat(101)]]) {
      expect(messageOf(() => validateMetricResults(metrics(), corruptFirst({ evidenceRefs: refs }))))
        .toBe('metric evidence references are invalid');
    }
    expect(messageOf(() => validateRoleMetrics(metrics([5000, 4999, 0]))))
      .toBe('metric weight must be an integer between 1 and 10000 bps');
    expect(messageOf(() => validateRubric(null))).toBe('rubric must be an object with levels 1..4');
  });

  it('every code and rule passes the queue regex, sanitizeErrorCode, v_funnel_failures and the logger', () => {
    const lines: string[] = [];
    const log = createLogger('scorecard-domain-test', { writer: (line) => lines.push(line), clock: () => '2026-10-03T00:00:00.000Z' });
    const all: string[] = [...SCORECARD_VALIDATION_CODES, ...SCORECARD_NORMALIZATION_RULES];
    expect(new Set(SCORECARD_VALIDATION_CODES).size).toBe(SCORECARD_VALIDATION_CODES.length);
    for (const code of all) {
      expect(code).toMatch(/^[a-z][a-z0-9_.:-]{2,63}$/); // queue runner
      expect(sanitizeErrorCode(new Error(code))).toBe(code);
      expect(code).toMatch(/^[a-z0-9_.:-]{1,64}$/); // v_funnel_failures / 0042 code shape
      lines.length = 0;
      log.info('unknown_event', { rejection_reason: code });
      const entry = JSON.parse(lines[0]) as Record<string, unknown>;
      // Survives SAFE_IDENT_RE and is not caught by DEFENSE_RE.
      expect(entry.rejection_reason, code).toBe(code);
    }
  });
});

describe('E5 — normalizeModelResults (presentation-only)', () => {
  it('returns new objects with exactly the five contract keys and does not mutate its input', () => {
    const input = rawAll({ extra: 'model chatter', confidence: 0.9 });
    const frozen = JSON.stringify(input);
    const { results: out, applied } = normalizeModelResults(input);
    expect(JSON.stringify(input)).toBe(frozen);
    for (const entry of out) {
      expect(Object.keys(entry).sort()).toEqual(['configMetricId', 'evidenceRefs', 'evidenceStatus', 'rationale', 'score']);
    }
    expect(out[0]).not.toBe(input[0]);
    expect(applied).toEqual(['extra_keys_stripped']);
  });

  it('applies nothing to already-clean output', () => {
    const { applied, results: out } = normalizeModelResults(rawAll());
    expect(applied).toEqual([]);
    expect(validateMetricResults(metrics(), out)).toHaveLength(3);
  });

  it('truncates a 143-character ref to 100 with an ellipsis, and the output passes the UNCHANGED validator', () => {
    const long = 'a'.repeat(143);
    const { results: out, applied } = normalizeModelResults(rawAll({ evidenceRefs: [long] }));
    expect(out[0].evidenceRefs[0]).toHaveLength(100);
    expect(out[0].evidenceRefs[0].endsWith('…')).toBe(true);
    expect(out[0].evidenceRefs[0].startsWith('a'.repeat(99))).toBe(true);
    expect(applied).toEqual(['evidence_ref_truncated']);
    expect(() => validateMetricResults(metrics(), out)).not.toThrow();
  });

  it('never splits a surrogate pair at the ref cut point', () => {
    // 98 ASCII units, then an emoji (2 units) straddling the 99-unit cut.
    const ref = `${'b'.repeat(98)}\u{1F600}${'c'.repeat(20)}`;
    const cut = normalizeModelResults(rawAll({ evidenceRefs: [ref] })).results[0].evidenceRefs[0];
    expect(cut).toBe(`${'b'.repeat(98)}…`);
    const last = cut.charCodeAt(cut.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('caps 12 refs to 10', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `quote ${i}`);
    const { results: out, applied } = normalizeModelResults(rawAll({ evidenceRefs: refs }));
    expect(out[0].evidenceRefs).toEqual(refs.slice(0, 10));
    expect(applied).toEqual(['evidence_refs_capped']);
  });

  it('wraps a string ref, coerces a non-array object to [], and leaves null/undefined as [] unlogged', () => {
    let r = normalizeModelResults(rawAll({ evidenceRefs: 'one quote' }));
    expect(r.results[0].evidenceRefs).toEqual(['one quote']);
    expect(r.applied).toEqual(['evidence_refs_coerced_array']);
    r = normalizeModelResults(rawAll({ evidenceRefs: { 0: 'q' } }));
    expect(r.results[0].evidenceRefs).toEqual([]);
    expect(r.applied).toEqual(['evidence_refs_coerced_array']);
    r = normalizeModelResults(rawAll({ evidenceRefs: null }));
    expect(r.results[0].evidenceRefs).toEqual([]);
    expect(r.applied).toEqual([]);
    const noRefs = rawAll();
    delete noRefs[0].evidenceRefs;
    r = normalizeModelResults(noRefs);
    expect(r.results[0].evidenceRefs).toEqual([]);
    expect(r.applied).toEqual([]);
  });

  it('drops numeric and empty refs (never stringifies them) and collapses whitespace', () => {
    const { results: out, applied } = normalizeModelResults(rawAll({ evidenceRefs: [3, '  spaced \n  out  ', '', '   ', null] }));
    expect(out[0].evidenceRefs).toEqual(['spaced out']);
    expect(applied).toEqual(['evidence_ref_dropped']);
  });

  it('truncates a 1400-character rationale at a sentence end or space at position >= 500', () => {
    const sentence = 'The candidate gave a specific, grounded example. ';
    const rationale = sentence.repeat(Math.ceil(1400 / sentence.length)).slice(0, 1400);
    const { results: out, applied } = normalizeModelResults(rawAll({ rationale }));
    const cut = out[0].rationale;
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut.length).toBeGreaterThan(500);
    expect(cut.endsWith('.…')).toBe(true);
    expect(applied).toEqual(['rationale_truncated']);
    expect(() => validateMetricResults(metrics(), out)).not.toThrow();
  });

  it('does NOT cut a 1001-character rationale to a stub at an early full stop', () => {
    // Its only full stop is at character 41; it ends mid-word (not on a space
    // the whitespace collapse would trim back under the limit).
    const rationale = `${'w'.repeat(40)}.${' word'.repeat(200)}`.slice(0, 1001);
    expect(rationale).toHaveLength(1001);
    const cut = normalizeModelResults(rawAll({ rationale })).results[0].rationale;
    expect(cut.length).toBeGreaterThan(500);
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut.endsWith('…')).toBe(true);
    // No sentence end or space at all past 500: hard cut at 999 + ellipsis.
    const solid = 'z'.repeat(1200);
    expect(normalizeModelResults(rawAll({ rationale: solid })).results[0].rationale).toBe(`${'z'.repeat(999)}…`);
  });

  it('leaves an empty or non-string rationale raw so it still fails rationale_empty', () => {
    for (const rationale of ['', '   ', 17, undefined]) {
      const { results: out } = normalizeModelResults(rawAll({ rationale }));
      expect(codeOf(() => validateMetricResults(metrics(), out))).toBe('scorecard_invalid:rationale_empty');
    }
  });

  it("coerces a numeric-string score '3' to the number 3", () => {
    const { results: out, applied } = normalizeModelResults(rawAll({ score: ' 3 ' }));
    expect(out[0].score).toBe(3);
    expect(typeof out[0].score).toBe('number');
    expect(applied).toEqual(['score_string_coerced']);
    expect(() => validateMetricResults(metrics(), out)).not.toThrow();
  });

  it('never clamps, rounds or coerces an off-scale score: all still fail score_not_integer_1_4', () => {
    for (const score of ['5', 5, 0, 3.5, 'three', null, '0']) {
      const { results: out } = normalizeModelResults(rawAll({ score }));
      expect(codeOf(() => validateMetricResults(metrics(), out)), String(score)).toBe('scorecard_invalid:score_not_integer_1_4');
    }
  });

  it('nulls only an ABSENT score on insufficient_evidence; a numeric one still fails', () => {
    for (const score of [undefined, '', 'null', ' NULL ']) {
      const patch: Record<string, unknown> = { evidenceStatus: 'insufficient_evidence', score };
      const input = rawAll(patch);
      if (score === undefined) delete input[0].score;
      const { results: out, applied } = normalizeModelResults(input);
      expect(out[0].score, String(score)).toBeNull();
      expect(applied).toEqual(['insufficient_score_nullified']);
      expect(() => validateMetricResults(metrics(), out)).not.toThrow();
    }
    // The fabrication guard is untouched: a real number is never nulled.
    for (const score of [1, '1', 0]) {
      const { results: out } = normalizeModelResults(rawAll({ evidenceStatus: 'insufficient_evidence', score }));
      expect(codeOf(() => validateMetricResults(metrics(), out)), String(score)).toBe('scorecard_invalid:insufficient_with_score');
    }
  });

  it('canonicalizes the status spelling and leaves unknown statuses raw', () => {
    for (const [raw, want] of [
      ['Insufficient Evidence', 'insufficient_evidence'],
      ['insufficient-evidence', 'insufficient_evidence'],
      [' Scored ', 'scored'],
    ] as const) {
      const patch = want === 'scored' ? { evidenceStatus: raw } : { evidenceStatus: raw, score: null };
      const { results: out, applied } = normalizeModelResults(rawAll(patch));
      expect(out[0].evidenceStatus).toBe(want);
      expect(applied).toEqual(['evidence_status_canonicalized']);
      expect(() => validateMetricResults(metrics(), out)).not.toThrow();
    }
    const { results: out } = normalizeModelResults(rawAll({ evidenceStatus: 'partial' }));
    expect(out[0].evidenceStatus).toBe('partial');
    expect(codeOf(() => validateMetricResults(metrics(), out))).toBe('scorecard_invalid:evidence_status');
  });

  it('trims a padded id but never remaps an unknown one', () => {
    let r = normalizeModelResults(rawAll({ configMetricId: '  metric-0 ' }));
    expect(r.results[0].configMetricId).toBe('metric-0');
    expect(r.applied).toEqual(['metric_id_trimmed']);
    r = normalizeModelResults(rawAll({ configMetricId: 'metric-zero' }));
    expect(codeOf(() => validateMetricResults(metrics(), r.results))).toBe('scorecard_invalid:unknown_metric_id');
  });

  it('reports each applied rule once, even when it fires on several entries', () => {
    const input = [
      rawEntry(0, { evidenceRefs: ['x'.repeat(150)] }),
      rawEntry(1, { evidenceRefs: ['y'.repeat(150)], score: '2' }),
      rawEntry(2),
    ];
    expect(normalizeModelResults(input).applied).toEqual(['evidence_ref_truncated', 'score_string_coerced']);
  });

  it('weighted score is identical for normalized output and already-clean output', () => {
    const clean = normalizeModelResults(rawAll()).results;
    const noisy = normalizeModelResults(rawAll({ score: '3', evidenceRefs: ['q'.repeat(140)], extra: true })).results;
    expect(calculateWeightedScore(metrics(), noisy)).toBe(calculateWeightedScore(metrics(), clean));
  });
});
