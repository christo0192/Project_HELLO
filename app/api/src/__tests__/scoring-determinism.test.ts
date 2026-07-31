/**
 * TST-01 scoring determinism — property tests over the pure scoring logic
 * (computeOverall in services/assessment.ts).
 *
 * Invariants exercised here:
 *   - Determinism: identical input ⇒ identical overall_score + recommendation
 *     (no hidden randomness, time-dependence, or shared mutable state).
 *   - Reproducibility: the property generator itself is fully reproducible
 *     under a fixed seed (fc.sample with the same seed yields identical
 *     inputs on every run), so the test result is stable across CI runs.
 *   - Contract: overall is a 0..100 integer and recommendation matches the
 *     documented thresholds (>=65 advance, >=45 hold, else reject).
 *   - Arithmetic: the weighted formula is pinned to the documented weights
 *     (communication 0.50, motivation 0.20, tone 0.10, role_fit 0.20).
 *   - Fail-closed: malformed/legacy rows (missing or out-of-range subscores)
 *     never throw; scores default to 0 and yield 'reject'.
 *
 * Deterministic + fixed seed + no network. Synthetic inputs only.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeOverall } from '../services/assessment.js';
import type { Assessment } from '../lib/types.js';

// Fixed seed shared by every property run in this file: identical on every
// invocation, on every machine. No Math.random() anywhere.
const SEED = 0x0a5eed;
const NUM_RUNS = 200;

// ── Arbitraries ─────────────────────────────────────────────────────────

const score10 = fc.integer({ min: 0, max: 10 });
const lvl = fc.constantFrom('none', 'low', 'moderate', 'high');
const fillerLevel = fc.constantFrom('low', 'moderate', 'high');

const languageProficiencyArb = fc.record({
  band: fc.constantFrom('A1', 'A2', 'B1', 'B2', 'C1', 'C2'),
  grammar: score10,
  vocabulary: score10,
  fluency: score10,
  coherence: score10,
  notes: fc.string(),
});

const speechPatternArb = fc.record({
  level: lvl,
  examples: fc.array(fc.string()),
  impact_score: score10,
  notes: fc.string(),
});

const fillerUsageArb = fc.record({
  level: fillerLevel,
  examples: fc.array(fc.string()),
  impact_score: score10,
  notes: fc.string(),
});

const assessmentArb: fc.Arbitrary<Assessment> = fc.record({
  english: fc.option(languageProficiencyArb, { nil: undefined }),
  tone: fc.record({
    clarity: score10,
    confidence: score10,
    professionalism: score10,
    sentiment: fc.constantFrom('positive', 'neutral', 'negative'),
    notes: fc.string(),
  }),
  communication: fc.record({
    score: score10,
    clarity: score10,
    structure: score10,
    listening: score10,
    rapport: score10,
    english_proficiency: languageProficiencyArb,
    filler_usage: fillerUsageArb,
    native_language_usage: speechPatternArb,
    notes: fc.string(),
  }),
  motivation: fc.record({ score: score10, notes: fc.string() }),
  role_fit: fc.record({
    score: score10,
    matched_skills: fc.array(fc.string()),
    gaps: fc.array(fc.string()),
    red_flags: fc.array(fc.string()),
    notes: fc.string(),
  }),
  overall_score: score10.map((n) => n * 10),
  recommendation: fc.constantFrom('advance', 'hold', 'reject'),
  summary: fc.string(),
  resume_conflicts: fc.array(
    fc.record({
      topic: fc.string(),
      resume_says: fc.string(),
      candidate_said: fc.string(),
      resolved: fc.boolean(),
      note: fc.string(),
    }),
  ),
});

// Documented screening-stage weights (must match services/assessment.ts).
const W = { communication: 0.5, motivation: 0.2, tone: 0.1, roleFit: 0.2 };
const clamp = (n: number): number => Math.max(0, Math.min(10, n));
const meanOf = (ns: number[]): number =>
  ns.length ? ns.reduce((a, b) => a + clamp(b), 0) / ns.length : 0;

/** Expected overall from the documented weighted formula. */
function expectedOverall(a: Assessment): number {
  const tone = meanOf([a.tone.clarity, a.tone.confidence, a.tone.professionalism]);
  const comm = clamp(a.communication.score);
  const motiv = clamp(a.motivation.score);
  const roleFit = clamp(a.role_fit.score);
  const weighted =
    comm * W.communication + motiv * W.motivation + tone * W.tone + roleFit * W.roleFit;
  return Math.round(weighted * 10);
}

function expectedRecommendation(overall: number): Assessment['recommendation'] {
  return overall >= 65 ? 'advance' : overall >= 45 ? 'hold' : 'reject';
}

/** Build a full Assessment from the four subscores computeOverall reads. */
function mkAssessment(comm: number, motiv: number, tone: number, roleFit: number): Assessment {
  return {
    tone: {
      clarity: tone,
      confidence: tone,
      professionalism: tone,
      sentiment: 'neutral',
      notes: '',
    },
    communication: {
      score: comm,
      clarity: comm,
      structure: comm,
      listening: comm,
      rapport: comm,
      english_proficiency: {
        band: 'B1',
        grammar: comm,
        vocabulary: comm,
        fluency: comm,
        coherence: comm,
        notes: '',
      },
      filler_usage: { level: 'low', examples: [], impact_score: 10, notes: '' },
      native_language_usage: { level: 'none', examples: [], impact_score: 10, notes: '' },
      notes: '',
    },
    motivation: { score: motiv, notes: '' },
    role_fit: { score: roleFit, matched_skills: [], gaps: [], red_flags: [], notes: '' },
    overall_score: 0,
    recommendation: 'hold',
    summary: '',
    resume_conflicts: [],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('scoring determinism (TST-01)', () => {
  it('computeOverall is deterministic: identical input ⇒ identical output', () => {
    fc.assert(
      fc.property(assessmentArb, (a) => {
        const first = computeOverall(a);
        const second = computeOverall(a);
        return (
          first.overall === second.overall &&
          first.recommendation === second.recommendation
        );
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('fixed seed reproduces the exact same generated inputs (no hidden randomness)', () => {
    const a = fc.sample(assessmentArb, { seed: SEED, numRuns: 5 });
    const b = fc.sample(assessmentArb, { seed: SEED, numRuns: 5 });
    expect(a).toEqual(b);
    // Same seed + same numRuns must never depend on wall-clock/process state.
    const c = fc.sample(assessmentArb, { seed: SEED, numRuns: 5 });
    expect(a).toEqual(c);
  });

  it('overall is a 0..100 integer and recommendation matches documented thresholds', () => {
    fc.assert(
      fc.property(assessmentArb, (a) => {
        const { overall, recommendation } = computeOverall(a);
        if (!Number.isInteger(overall) || overall < 0 || overall > 100) return false;
        return recommendation === expectedRecommendation(overall);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('overall_score equals the documented weighted formula exactly', () => {
    fc.assert(
      fc.property(assessmentArb, (a) => {
        const { overall } = computeOverall(a);
        return overall === expectedOverall(a);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('golden values: exact scores produce exact overall/recommendation', () => {
    const golden: Array<[number, number, number, number, number, Assessment['recommendation']]> = [
      [10, 10, 10, 10, 100, 'advance'], // all max → 5+2+1+2 = 10.0
      [10, 10, 10, 0, 80, 'advance'], // role_fit 0 → 5+2+1+0 = 8.0
      [5, 5, 5, 5, 50, 'hold'], // 2.5+1+0.5+1 = 5.0
      [2, 2, 2, 2, 20, 'reject'], // 1+0.4+0.2+0.4 = 2.0
      [7, 5, 5, 7, 64, 'hold'], // 3.5+1+0.5+1.4 = 6.4 → 64 (just under advance)
      [7, 6, 5, 7, 66, 'advance'], // 3.5+1.2+0.5+1.4 = 6.6 → 66 (just over)
      [4, 5, 5, 5, 45, 'hold'], // 2+1+0.5+1 = 4.5 → 45 (advance floor boundary)
      [4, 4, 5, 5, 43, 'reject'], // 2+0.8+0.5+1 = 4.3 → 43 (just under hold)
      [0, 0, 0, 0, 0, 'reject'], // degenerate floor
      [6, 6, 0, 6, 54, 'hold'], // 3+1.2+0+1.2 = 5.4
    ];
    for (const [comm, motiv, tone, roleFit, overall, rec] of golden) {
      const got = computeOverall(mkAssessment(comm, motiv, tone, roleFit));
      expect(got.overall).toBe(overall);
      expect(got.recommendation).toBe(rec);
    }
  });

  it('fails closed on malformed/legacy rows: no throw, scores default to 0 → reject', () => {
    // Entirely empty assessment (older rows / missing columns).
    expect(computeOverall({} as unknown as Assessment)).toEqual({
      overall: 0,
      recommendation: 'reject',
    });

    // NaN/Infinity/negative/out-of-range subscores are clamped to [0, 10].
    const dirty = {
      tone: { clarity: NaN, confidence: Infinity, professionalism: -3, sentiment: 'neutral', notes: '' },
      communication: { score: 99 },
      motivation: { score: Number.NEGATIVE_INFINITY },
      role_fit: { score: 3.5 },
    } as unknown as Assessment;
    const got = computeOverall(dirty);
    // comm 10*0.5 + motiv 0*0.2 + tone 0*0.1 + roleFit 3.5*0.2 = 5.7 → 57
    expect(got.overall).toBe(57);
    expect(got.recommendation).toBe('hold');
  });
});
