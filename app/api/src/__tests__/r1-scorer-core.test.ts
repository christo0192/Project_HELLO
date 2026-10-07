/**
 * The R1 three-run scorer: median, agreement, thresholds, the integrity floor, the single
 * repair resample, evidence validation, and fail-closed behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  R1_SCORING_RUNS,
  aggregateR1Runs,
  parseR1Thresholds,
  r1RecommendationForOverall,
  scoreOneR1Run,
  scoreR1Transcript,
  type R1RunOutcome,
  type R1ScoreDiagnosticEvent,
  type R1ScoreInput,
  type R1Thresholds,
} from '../lib/r1/scorer.js';
import { R1_METRIC_KEYS, R1_METRICS } from '../lib/r1/rubric.js';
import { r1DeckFactsBlock } from '../lib/r1/deck-facts.js';
import { parseR1AdministrationLog } from '../lib/r1/admin-log.js';
import { computeTranscriptStats, maskR1Turns, toR1Turns } from '../lib/r1/transcript.js';
import { ScorecardValidationError } from '../lib/scorecards/domain.js';
import { DeepseekError } from '../lib/deepseek.js';
import { METRIC_IDS, cleanLogRows, interviewRows, modelAnswer, r1Scorecard } from './support/r1-scorer.js';

const THRESHOLDS: R1Thresholds = { advance: 65, hold: 45 };
const REPAIR_MARK = 'NOTE: An earlier answer to this request was rejected';

function input(): R1ScoreInput {
  const turns = maskR1Turns(toR1Turns(interviewRows()), "Ava O'Neil");
  return {
    scorecard: r1Scorecard(),
    roleTitle: 'Sales Program Advisor',
    turns,
    log: parseR1AdministrationLog(cleanLogRows()),
    stats: computeTranscriptStats(turns),
    deckFacts: r1DeckFactsBlock(),
    thresholds: THRESHOLDS,
  };
}

const allScores = (score: number | null) =>
  Object.fromEntries(R1_METRICS.map((metric) => [metric.key, score]));

/** An `infer` that answers each call from a queue (calls are made in parallel but in order). */
function scripted(answers: Array<unknown | (() => unknown)>) {
  const prompts: string[] = [];
  let next = 0;
  const infer = async (prompt: string): Promise<unknown> => {
    prompts.push(prompt);
    const answer = answers[Math.min(next, answers.length - 1)];
    next += 1;
    const value = typeof answer === 'function' ? (answer as () => unknown)() : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return { infer, prompts };
}

const rows = interviewRows();

describe('thresholds and the recommendation rule', () => {
  it('maps overall to advance/hold/reject at the configured thresholds', () => {
    const rec = (overall: number | null, floor = false) => r1RecommendationForOverall(overall, THRESHOLDS, floor);
    expect(rec(null)).toBe('human_review');
    expect(rec(100)).toBe('advance');
    expect(rec(65)).toBe('advance');
    expect(rec(64)).toBe('hold');
    expect(rec(45)).toBe('hold');
    expect(rec(44)).toBe('reject');
    expect(rec(0)).toBe('reject');
  });

  it('caps an advance at hold when the integrity floor is breached, and leaves reject alone', () => {
    expect(r1RecommendationForOverall(90, THRESHOLDS, true)).toBe('hold');
    expect(r1RecommendationForOverall(50, THRESHOLDS, true)).toBe('hold');
    expect(r1RecommendationForOverall(20, THRESHOLDS, true)).toBe('reject');
  });

  it('parses thresholds read from numeric columns and refuses nonsense', () => {
    expect(parseR1Thresholds('65.00', '45.00')).toEqual({ advance: 65, hold: 45 });
    expect(parseR1Thresholds(70, 70)).toEqual({ advance: 70, hold: 70 });
    for (const [a, h] of [[40, 50], [null, 45], ['x', 1], [101, 45], [65, -1]] as const) {
      expect(() => parseR1Thresholds(a, h), `${String(a)}/${String(h)}`).toThrow('r1_thresholds_invalid');
    }
  });
});

describe('three runs and the median', () => {
  it('runs the scorer three times in parallel and agrees when all runs match', async () => {
    const { infer, prompts } = scripted([modelAnswer(rows, allScores(3))]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(R1_SCORING_RUNS).toBe(3);
    expect(prompts).toHaveLength(3);
    expect(new Set(prompts).size).toBe(1);
    expect(outcome.runs).toHaveLength(3);
    expect(outcome.runsAgree).toBe(true);
    expect(outcome.complete).toBe(true);
    expect(outcome.evidenceValid).toBe(true);
    expect(outcome.scoringStatus).toBe('complete');
    expect(outcome.weightedScore5).toBe(3);
    expect(outcome.overallScore).toBe(67);
    expect(outcome.recommendation).toBe('advance');
    expect(outcome.scoredRecommendation).toBe('advance');
    expect(outcome.metricResults.map((r) => r.metric.key)).toEqual(R1_METRICS.map((m) => m.key));
    expect(outcome.metricResults.every((r) => r.score === 3 && r.evidenceRefs.length === 1)).toBe(true);
    expect(outcome.metricResults[0]!.evidenceRefs[0]).toMatch(/^T\d+: /);
  });

  it('keeps the median level per metric and accepts a one-level spread', async () => {
    const { infer } = scripted([
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.probing]: 4 }),
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.probing]: 3 }),
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.probing]: 3 }),
    ]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.metricResults[0]!.score).toBe(3);
    expect(outcome.runsAgree).toBe(true);
    expect(outcome.recommendation).toBe('advance');
  });

  it('falls to human_review when the runs recommend differently', async () => {
    const { infer } = scripted([
      modelAnswer(rows, allScores(3)),
      modelAnswer(rows, allScores(3)),
      modelAnswer(rows, allScores(2)),
    ]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.runsAgree).toBe(false);
    expect(outcome.disagreement).toEqual(['recommendation_differs']);
    expect(outcome.scoredRecommendation).toBe('advance');
    expect(outcome.recommendation).toBe('human_review');
  });

  it('falls to human_review when any metric spreads by more than one level', async () => {
    const { infer } = scripted([
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.communication]: 1 }),
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.communication]: 2 }),
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.communication]: 3 }),
    ]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.disagreement).toContain(`metric_spread:${R1_METRIC_KEYS.communication}`);
    expect(outcome.recommendation).toBe('human_review');
  });

  it('treats a metric scored in some runs and insufficient in others as a disagreement', async () => {
    const { infer } = scripted([
      modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.urgency]: null }),
      modelAnswer(rows, allScores(3)),
      modelAnswer(rows, allScores(3)),
    ]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.disagreement).toContain(`metric_status:${R1_METRIC_KEYS.urgency}`);
    expect(outcome.recommendation).toBe('human_review');
  });

  it('is incomplete (human_review) when a metric is insufficient in every run', async () => {
    const { infer } = scripted([modelAnswer(rows, { ...allScores(3), [R1_METRIC_KEYS.negotiation]: null })]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.complete).toBe(false);
    expect(outcome.runsAgree).toBe(true);
    expect(outcome.scoringStatus).toBe('incomplete_evidence');
    expect(outcome.recommendation).toBe('human_review');
    // A provisional weighted score still exists over the scored metrics (shared partial rule).
    expect(outcome.weightedScore5).toBe(3);
    const negotiation = outcome.metricResults.find((r) => r.metric.key === R1_METRIC_KEYS.negotiation)!;
    expect(negotiation.score).toBeNull();
    expect(negotiation.evidenceStatus).toBe('insufficient_evidence');
  });

  it('records a reject and a hold from the median score', async () => {
    const low = await scoreR1Transcript({ infer: scripted([modelAnswer(rows, allScores(1))]).infer }, input());
    expect(low.overallScore).toBe(0);
    expect(low.recommendation).toBe('reject');
    // Weighted 2.5 (levels 2,2,3,3,3 over weights 25/25/15/15/20) -> overall 50 -> hold.
    const mid = await scoreR1Transcript({
      infer: scripted([modelAnswer(rows, {
        [R1_METRIC_KEYS.probing]: 2,
        [R1_METRIC_KEYS.objection]: 2,
        [R1_METRIC_KEYS.urgency]: 3,
        [R1_METRIC_KEYS.negotiation]: 3,
        [R1_METRIC_KEYS.communication]: 3,
      })]).infer,
    }, input());
    expect(mid.overallScore).toBe(50);
    expect(mid.recommendation).toBe('hold');
  });
});

describe('integrity floor', () => {
  it('caps an otherwise-advance score at hold when objection handling is level 1', async () => {
    const { infer } = scripted([
      modelAnswer(rows, { ...allScores(4), [R1_METRIC_KEYS.objection]: 1 }),
    ]);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.overallScore).toBe(75);
    expect(outcome.scoredRecommendation).toBe('hold');
    expect(outcome.recommendation).toBe('hold');
  });

  it('applies the same cap for negotiation level 1 but not for other metrics', async () => {
    const neg = await scoreR1Transcript({
      infer: scripted([modelAnswer(rows, { ...allScores(4), [R1_METRIC_KEYS.negotiation]: 1 })]).infer,
    }, input());
    expect(neg.recommendation).toBe('hold');
    const probing = await scoreR1Transcript({
      infer: scripted([modelAnswer(rows, { ...allScores(4), [R1_METRIC_KEYS.probing]: 1 })]).infer,
    }, input());
    expect(probing.overallScore).toBe(75);
    expect(probing.recommendation).toBe('advance');
  });
});

describe('malformed output gets exactly one repair resample', () => {
  it('repairs a bad shape once with a fixed sentence and never echoes the model output', async () => {
    const events: R1ScoreDiagnosticEvent[] = [];
    const prompts: string[] = [];
    let calls = 0;
    const infer = async (prompt: string): Promise<unknown> => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) return { not_results: 'MODEL_SECRET_TEXT' };
      return modelAnswer(rows, allScores(3));
    };
    const outcome = await scoreR1Transcript({ infer, onDiagnostic: (e) => events.push(e) }, input());
    expect(prompts).toHaveLength(4);
    const repairPrompts = prompts.filter((p) => p.includes(REPAIR_MARK));
    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain('the JSON object must contain a "results" array.');
    expect(repairPrompts[0]).not.toContain('MODEL_SECRET_TEXT');
    expect(outcome.runs.filter((run) => run.repaired)).toHaveLength(1);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['repair_attempted', 'repair_succeeded']));
    expect(outcome.runsAgree).toBe(true);
  });

  it('throws the stable validation code when the repair also fails (queue retries)', async () => {
    const events: R1ScoreDiagnosticEvent[] = [];
    const { infer, prompts } = scripted([{ results: 'nope' }]);
    await expect(
      scoreR1Transcript({ infer, onDiagnostic: (e) => events.push(e), runs: 1 }, input()),
    ).rejects.toMatchObject({ code: 'scorecard_invalid:results_missing' });
    expect(prompts).toHaveLength(2);
    expect(events.map((e) => e.kind)).toContain('repair_failed');
  });

  it('does not repair a corrupt recruiter configuration', async () => {
    const bad = { ...input(), scorecard: { ...r1Scorecard(), metrics: r1Scorecard().metrics.slice(0, 2) } };
    const { infer, prompts } = scripted([modelAnswer(rows, allScores(3))]);
    await expect(scoreR1Transcript({ infer, runs: 1 }, bad)).rejects.toBeInstanceOf(ScorecardValidationError);
    expect(prompts.length).toBeLessThanOrEqual(1);
  });

  it('normalizes presentation noise (string scores, long rationale) without a repair', async () => {
    const answer = modelAnswer(rows, allScores(3));
    const noisy = {
      results: answer.results.map((result, index) => ({
        ...result,
        score: index === 0 ? '3' : result.score,
        rationale: `${result.rationale as string} ${'x'.repeat(1200)}`,
      })),
    };
    const { infer, prompts } = scripted([noisy]);
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(prompts).toHaveLength(1);
    expect(outcome.metricResults[0]!.score).toBe(3);
    expect(outcome.metricResults.every((r) => r.rationale.length <= 1000)).toBe(true);
  });

  it('rethrows a provider failure after letting every sibling run settle', async () => {
    let calls = 0;
    const infer = async (): Promise<unknown> => {
      calls += 1;
      if (calls === 2) throw new DeepseekError('timeout');
      return modelAnswer(rows, allScores(3));
    };
    await expect(scoreR1Transcript({ infer }, input())).rejects.toMatchObject({ category: 'timeout' });
    expect(calls).toBe(3);
  });
});

describe('evidence validation (plan 6.2)', () => {
  const learnerTurn = rows.find((row) => row.speaker === 'bot' && row.phase === 'roleplay' && row.text.length > 20)!;
  const currentRoleTurn = rows.find((row) => row.speaker === 'candidate' && row.text.includes('current role'))!;

  it('repairs one evidence violation (a learner line cited) and accepts the corrected answer', async () => {
    const bad = modelAnswer(rows, allScores(3), {
      refs: () => [`T${learnerTurn.turn_index}: ${learnerTurn.text.slice(0, 20)}`],
    });
    const good = modelAnswer(rows, allScores(3));
    const prompts: string[] = [];
    const infer = async (prompt: string): Promise<unknown> => {
      prompts.push(prompt);
      return prompt.includes(REPAIR_MARK) ? good : bad;
    };
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('evidenceRefs may cite only CANDIDATE turns; never cite an Interviewer or a Learner line.');
    expect(outcome.evidenceValid).toBe(true);
    expect(outcome.recommendation).toBe('advance');
    expect(outcome.runs[0]!.repaired).toBe(true);
  });

  it('marks the run evidence-invalid when the repair still violates: no throw, human_review, bad refs dropped', async () => {
    const bad = modelAnswer(rows, allScores(3), {
      refs: (key) => key === R1_METRIC_KEYS.probing
        ? [`T${learnerTurn.turn_index}: ${learnerTurn.text.slice(0, 20)}`, `T${currentRoleTurn.turn_index}: What does your current role look like`]
        : [],
    });
    const { infer, prompts } = scripted([bad]);
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(prompts).toHaveLength(2);
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.recommendation).toBe('human_review');
    expect(outcome.scoredRecommendation).toBe('advance');
    // The learner citation was dropped; the genuine one survives.
    expect(outcome.metricResults[0]!.evidenceRefs).toEqual([
      `T${currentRoleTurn.turn_index}: What does your current role look like`,
    ]);
  });

  it('does not use a second repair after a shape repair has been spent (cost bound)', async () => {
    const calls: string[] = [];
    const bad = modelAnswer(rows, allScores(3), { refs: () => ['not a ref'] });
    const infer = async (prompt: string): Promise<unknown> => {
      calls.push(prompt);
      return calls.length === 1 ? { results: 'broken' } : bad;
    };
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(calls).toHaveLength(2);
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.recommendation).toBe('human_review');
  });

  it('keeps the first verdict when the evidence repair itself is malformed', async () => {
    const bad = modelAnswer(rows, allScores(3), { refs: () => ['free text'] });
    const infer = async (prompt: string): Promise<unknown> => (prompt.includes(REPAIR_MARK) ? { nope: true } : bad);
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.recommendation).toBe('human_review');
  });

  it('fails a quote of the candidate\'s unmasked name: validation runs on what the model saw', async () => {
    const answer = modelAnswer(rows, allScores(3), {
      refs: () => ['T2: Hello, I am Ava O\'Neil and I have five years'],
    });
    const outcome = await scoreR1Transcript({ infer: scripted([answer]).infer, runs: 1 }, input());
    expect(outcome.evidenceValid).toBe(false);
  });

  it('allows a LOW score (1 or 2) with no references: the absence of a behaviour is evidence', async () => {
    for (const level of [1, 2]) {
      const answer = modelAnswer(rows, allScores(level), { refs: () => [] });
      const outcome = await scoreR1Transcript({ infer: scripted([answer]).infer, runs: 1 }, input());
      expect(outcome.evidenceValid, `level ${level}`).toBe(true);
      expect(outcome.metricResults.every((r) => r.evidenceRefs.length === 0)).toBe(true);
    }
  });

  it('allows insufficient_evidence with no references', async () => {
    const answer = modelAnswer(rows, { ...allScores(2), [R1_METRIC_KEYS.urgency]: null }, { refs: () => [] });
    const outcome = await scoreR1Transcript({ infer: scripted([answer]).infer, runs: 1 }, input());
    expect(outcome.evidenceValid).toBe(true);
  });
});

describe('a 3 or a 4 needs a verifiable candidate quote (r1_evidence_missing)', () => {
  const MISSING_SENTENCE = 'a score of 3 or 4 must cite at least one candidate turn.';

  it('flags a level 4 with no references, repairs once with a fixed sentence, then falls to human_review', async () => {
    const answer = modelAnswer(rows, allScores(4), { refs: () => [] });
    const { infer, prompts } = scripted([answer]);
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(MISSING_SENTENCE);
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.runs[0]!.evidenceViolations).toBe(R1_METRICS.length);
    // Every metric was scored 4, so the median would have advanced: the missing evidence is
    // what keeps the session from recommending advance.
    expect(outcome.scoredRecommendation).toBe('advance');
    expect(outcome.recommendation).toBe('human_review');
  });

  it('flags a level 3 the same way', async () => {
    const answer = modelAnswer(rows, allScores(3), { refs: () => [] });
    const outcome = await scoreR1Transcript({ infer: scripted([answer]).infer, runs: 1 }, input());
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.recommendation).toBe('human_review');
  });

  it('flags ONLY the metric that is 3 or 4 without a quote, and reports the stable code', async () => {
    const answer = modelAnswer(
      rows,
      { ...allScores(2), [R1_METRIC_KEYS.probing]: 4 },
      { refs: () => [] },
    );
    const run = await scoreOneR1Run({ infer: async () => answer }, input(), 'prompt');
    // The first violation is spent on the single repair resample; the second answer is the same.
    expect(run.evidenceViolations).toEqual(['r1_evidence_missing']);
    expect(run.evidenceValid).toBe(false);
    expect(run.repaired).toBe(true);
  });

  it('accepts the corrected answer when the repair cites a candidate turn', async () => {
    const bad = modelAnswer(rows, allScores(4), { refs: () => [] });
    const good = modelAnswer(rows, allScores(4));
    const infer = async (prompt: string): Promise<unknown> => (prompt.includes(REPAIR_MARK) ? good : bad);
    const outcome = await scoreR1Transcript({ infer, runs: 1 }, input());
    expect(outcome.evidenceValid).toBe(true);
    expect(outcome.recommendation).toBe('advance');
    expect(outcome.runs[0]!.repaired).toBe(true);
  });

  it('does not count an INVALID reference as the quote that supports a 3 or 4', async () => {
    const learnerLine = rows.find((row) => row.speaker === 'bot' && row.phase === 'roleplay' && row.text.length > 20)!;
    const answer = modelAnswer(rows, allScores(4), {
      refs: () => [`T${learnerLine.turn_index}: ${learnerLine.text.slice(0, 20)}`],
    });
    const run = await scoreOneR1Run({ infer: async () => answer }, input(), 'prompt');
    expect(run.evidenceValid).toBe(false);
    // The specific violation comes first (it names the repair sentence); the missing quote follows.
    expect(run.evidenceViolations[0]).toBe('r1_evidence_not_candidate');
    expect(run.evidenceViolations).toContain('r1_evidence_missing');
  });

  it('is enforced across the three runs: one run without quotes invalidates the whole result', async () => {
    const good = modelAnswer(rows, allScores(4));
    const bad = modelAnswer(rows, allScores(4), { refs: () => [] });
    let calls = 0;
    // The first run answers without quotes, and again after its repair; the others cite.
    const infer = async (prompt: string): Promise<unknown> =>
      (prompt.includes(REPAIR_MARK) || calls++ === 0 ? bad : good);
    const outcome = await scoreR1Transcript({ infer }, input());
    expect(outcome.runs.map((run) => run.evidenceValid)).toEqual([false, true, true]);
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.recommendation).toBe('human_review');
  });

  it('tells the model the rule in the prompt: [] only for a score of 1 or 2', async () => {
    const seen: string[] = [];
    const answer = modelAnswer(rows, allScores(3));
    await scoreR1Transcript({ infer: async (prompt) => { seen.push(prompt); return answer; }, runs: 1 }, input());
    expect(seen[0]).toContain('Use [] ONLY for a score of 1 or 2');
    expect(seen[0]).toContain('a score of 3 or 4 MUST cite at least one CANDIDATE line');
    expect(seen[0]).not.toContain('use [] if you have no direct quote');
  });
});

describe('aggregateR1Runs', () => {
  const run = (score: number, extra: Partial<R1RunOutcome> = {}): R1RunOutcome => ({
    results: R1_METRICS.map((metric) => ({
      configMetricId: METRIC_IDS[metric.key] as string,
      score: score as 1 | 2 | 3 | 4,
      evidenceStatus: 'scored',
      rationale: `level ${score}`,
      evidenceRefs: [],
    })),
    weightedScore5: score,
    overallScore: Math.round(((score - 1) / 3) * 100),
    recommendation: score >= 3 ? 'advance' : 'reject',
    evidenceValid: true,
    evidenceViolations: [],
    repaired: false,
    ...extra,
  });

  it('takes the donor rationale from the first run whose score equals the median', () => {
    const outcome = aggregateR1Runs(r1Scorecard().metrics, [run(3), run(3), run(3)], THRESHOLDS);
    expect(outcome.metricResults[0]!.rationale).toBe('level 3');
    expect(outcome.runs).toEqual(
      Array.from({ length: 3 }, () => ({
        overallScore: 67,
        recommendation: 'advance',
        evidenceValid: true,
        evidenceViolations: 0,
        repaired: false,
      })),
    );
  });

  it('marks any invalid run as invalid evidence for the whole result', () => {
    const outcome = aggregateR1Runs(
      r1Scorecard().metrics,
      [run(3), run(3), run(3, { evidenceValid: false, evidenceViolations: ['r1_evidence_phase'] })],
      THRESHOLDS,
    );
    expect(outcome.evidenceValid).toBe(false);
    expect(outcome.recommendation).toBe('human_review');
  });
});

describe('scoreOneR1Run in isolation', () => {
  it('returns the per-run recommendation after the floor', async () => {
    const result = await scoreOneR1Run(
      { infer: async () => modelAnswer(rows, { ...allScores(4), [R1_METRIC_KEYS.negotiation]: 1 }) },
      input(),
      'prompt',
    );
    expect(result.recommendation).toBe('hold');
    expect(result.overallScore).toBe(85);
    expect(result.repaired).toBe(false);
  });
});
