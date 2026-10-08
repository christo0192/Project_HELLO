/**
 * The R1 three-run scorer (plan 6.3, 6.5).
 *
 * One transcript is scored THREE times against the R1 scorecard (run 0 first, then the other
 * two in parallel; see `scoreR1Transcript`). Per metric the MEDIAN level is kept. The result is trusted for a status effect only when the runs agree:
 * the recommendation is identical across runs and no metric spreads by more than one level,
 * and every run's evidence references validated. Otherwise the recommendation is
 * `human_review`.
 *
 * ISOLATION. It reuses the shared PURE validators (`validateMetricResults`,
 * `normalizeModelResults`, `calculateWeightedScore`, `weightedScoreToOverall`) but never the
 * phone prompt, the phone scorer module, `recommendationForOverall` (R1 thresholds live in
 * `r1_settings`) or the default DeepSeek exports. The model call is an injected `infer`;
 * production builds it from the R1-only runner in `deepseek-runner.ts`.
 *
 * FAIL CLOSED. A malformed model answer gets at most ONE repair resample per run; a second
 * failure throws its stable code (the queue retries, and the final attempt records a
 * `human_review` placeholder). An evidence violation after its one repair does not throw:
 * the run is marked evidence-invalid and the recommendation becomes `human_review`.
 */

import {
  SCORE_MAX,
  type RoleScorecardMetric,
  type RoleScorecardVersion,
  type ScoreValue,
  type ScorecardAssessmentStatus,
  type ScorecardMetricModelResult,
  type ScorecardMetricResult,
  type ScorecardValidationCode,
} from '../scorecards/contracts.js';
import {
  ScorecardValidationError,
  calculateWeightedScore,
  normalizeModelResults,
  validateMetricResults,
  weightedScoreToOverall,
} from '../scorecards/domain.js';
import { buildR1ScorerPrompt, r1RepairSuffix } from '../scorecards/r1-prompt.js';
import { createLogger } from '../logger.js';
import type { R1AdministrationLog } from './admin-log.js';
import {
  R1_EVIDENCE_REPAIR_SUFFIX,
  checkMetricEvidence,
  type R1EvidenceCode,
} from './evidence.js';
import { R1_METRIC_KEYS, r1EvidencePhasesFor } from './rubric.js';
import type { R1Turn, R1TranscriptStats } from './transcript.js';

export const R1_SCORING_RUNS = 3;

export type R1Recommendation = 'advance' | 'hold' | 'reject' | 'human_review';

export interface R1Thresholds {
  /** Overall (0-100) at or above which a score recommends `advance`. */
  readonly advance: number;
  /** Overall at or above which it recommends `hold`; below it, `reject`. */
  readonly hold: number;
}

/** Validate the thresholds read from `r1_settings` (numeric columns may arrive as strings). */
export function parseR1Thresholds(advance: unknown, hold: unknown): R1Thresholds {
  const a = Number(advance);
  const h = Number(hold);
  if (!Number.isFinite(a) || !Number.isFinite(h) || a < 0 || a > 100 || h < 0 || h > 100 || h > a) {
    throw new Error('r1_thresholds_invalid');
  }
  return { advance: a, hold: h };
}

/**
 * The R1 recommendation rule. Thresholds start at advance >= 65 and hold >= 45 and are
 * re-fitted on the calibration set. INTEGRITY FLOOR: a level 1 on objection handling or on
 * negotiation caps the result at `hold`, so a candidate who promised something false or blew
 * the discount ladder cannot be advanced on the strength of the other metrics.
 */
export function r1RecommendationForOverall(
  overall: number | null,
  thresholds: R1Thresholds,
  floorBreached: boolean,
): R1Recommendation {
  if (overall === null) return 'human_review';
  if (overall >= thresholds.advance) return floorBreached ? 'hold' : 'advance';
  if (overall >= thresholds.hold) return 'hold';
  return 'reject';
}

/** True when objection handling or negotiation was scored at level 1. */
function integrityFloorBreached(
  metrics: readonly RoleScorecardMetric[],
  results: readonly ScorecardMetricModelResult[],
): boolean {
  const keyById = new Map(metrics.map((metric) => [metric.id, metric.key]));
  return results.some((result) => {
    const key = keyById.get(result.configMetricId);
    return (key === R1_METRIC_KEYS.objection || key === R1_METRIC_KEYS.negotiation)
      && result.evidenceStatus === 'scored'
      && result.score === 1;
  });
}

export interface R1ScoreInput {
  readonly scorecard: RoleScorecardVersion;
  readonly roleTitle: string;
  /** Masked turns: exactly what the model is shown and what evidence is checked against. */
  readonly turns: readonly R1Turn[];
  readonly log: R1AdministrationLog;
  readonly stats: R1TranscriptStats;
  readonly deckFacts: string;
  readonly thresholds: R1Thresholds;
}

export interface R1ScoreDiagnosticEvent {
  readonly kind: 'normalized' | 'repair_attempted' | 'repair_succeeded' | 'repair_failed';
  readonly code: string;
}

export interface R1ScoreDeps {
  /** The model boundary: returns already-parsed JSON. */
  readonly infer: (prompt: string) => Promise<unknown>;
  readonly onDiagnostic?: (event: R1ScoreDiagnosticEvent) => void;
  /** Test seam: a fixed sentinel (production: random per prompt). */
  readonly sentinel?: string;
  readonly runs?: number;
}

const scorerLog = createLogger('r1-scorer');

function defaultOnDiagnostic(event: R1ScoreDiagnosticEvent): void {
  if (event.kind === 'repair_failed') return;
  scorerLog.info('unknown_event', {
    error_category: event.kind === 'normalized' ? 'r1_output_normalized' : 'r1_output_repair',
    rejection_reason: event.code,
  });
}

/** One fixed sentence per shape rule; never the error message, model text or candidate text. */
type RepairableCode = Exclude<ScorecardValidationCode, 'scorecard_invalid:config'>;
const EXACT_IDS_HINT =
  'return exactly one result for each configMetricId listed above, using the ids verbatim.';
const SHAPE_REPAIR_SENTENCE: Readonly<Record<RepairableCode, string>> = {
  'scorecard_invalid:output_not_object':
    'the answer must be a single JSON object with a "results" array.',
  'scorecard_invalid:results_missing': 'the JSON object must contain a "results" array.',
  'scorecard_invalid:result_not_object':
    'every "results" entry must be a JSON object with the five contract keys.',
  'scorecard_invalid:result_count': EXACT_IDS_HINT,
  'scorecard_invalid:unknown_metric_id': EXACT_IDS_HINT,
  'scorecard_invalid:duplicate_metric_id': EXACT_IDS_HINT,
  'scorecard_invalid:evidence_status':
    '"evidenceStatus" must be exactly "scored" or "insufficient_evidence".',
  'scorecard_invalid:score_not_integer_1_4':
    'a "scored" metric must have "score" as a JSON integer from 1 to 4.',
  'scorecard_invalid:insufficient_with_score':
    'if evidence is insufficient keep evidenceStatus "insufficient_evidence" and set score to ' +
    'JSON null; do NOT change it to "scored".',
  'scorecard_invalid:rationale_empty': 'every "rationale" must be non-empty text.',
  'scorecard_invalid:rationale_too_long': 'every "rationale" must be at most 900 characters.',
  'scorecard_invalid:evidence_refs_not_array':
    '"evidenceRefs" must be a JSON array of strings ([] if none).',
  'scorecard_invalid:evidence_refs_too_many': 'use at most 5 "evidenceRefs" entries per metric.',
  'scorecard_invalid:evidence_ref_not_string': 'every "evidenceRefs" entry must be a JSON string.',
  'scorecard_invalid:evidence_ref_too_long':
    'each evidenceRefs entry must be at most 100 characters; excerpt the key phrase.',
};

/** Extract and shallow-shape the `results` array; fail closed on anything else. */
function parseResults(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScorecardValidationError(
      'scorecard model output must be a JSON object',
      'scorecard_invalid:output_not_object',
    );
  }
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new ScorecardValidationError(
      'scorecard model output must contain a `results` array',
      'scorecard_invalid:results_missing',
    );
  }
  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ScorecardValidationError(
        'each scorecard result must be an object',
        'scorecard_invalid:result_not_object',
      );
    }
  }
  return results as Record<string, unknown>[];
}

export interface R1RunOutcome {
  /** Validated results with `evidenceRefs` restricted to the references that passed. */
  readonly results: readonly ScorecardMetricModelResult[];
  readonly weightedScore5: number | null;
  readonly overallScore: number | null;
  /** This run's own recommendation (after the integrity floor). */
  readonly recommendation: R1Recommendation;
  readonly evidenceValid: boolean;
  readonly evidenceViolations: readonly R1EvidenceCode[];
  readonly repaired: boolean;
}

interface EvidenceVerdict {
  readonly results: readonly ScorecardMetricModelResult[];
  readonly violations: readonly R1EvidenceCode[];
}

/** Validate every metric's references; rebuild `evidenceRefs` from the ones that passed. */
function verifyEvidence(
  metrics: readonly RoleScorecardMetric[],
  validated: readonly ScorecardMetricModelResult[],
  turnsByIndex: ReadonlyMap<number, R1Turn>,
): EvidenceVerdict {
  const keyById = new Map(metrics.map((metric) => [metric.id, metric.key]));
  const violations: R1EvidenceCode[] = [];
  const results = validated.map((result) => {
    const key = keyById.get(result.configMetricId) ?? '';
    const check = checkMetricEvidence(result.evidenceRefs, turnsByIndex, r1EvidencePhasesFor(key));
    violations.push(...check.violations);
    // A 3 or a 4 counts behaviours, so it needs a verifiable candidate quote behind it. Only the
    // LOW levels may rest on the absence of a behaviour (plan 6.2).
    if (result.evidenceStatus === 'scored' && (result.score as number) >= 3
        && check.valid.length === 0) {
      violations.push('r1_evidence_missing');
    }
    return {
      ...result,
      evidenceRefs: check.valid.map((ref) => `T${ref.turnIndex}: ${ref.quote}`),
    };
  });
  return { results, violations };
}

export async function scoreOneR1Run(
  deps: R1ScoreDeps,
  input: R1ScoreInput,
  prompt: string,
): Promise<R1RunOutcome> {
  const metrics = input.scorecard.metrics;
  const onDiagnostic = deps.onDiagnostic ?? defaultOnDiagnostic;
  const turnsByIndex = new Map(input.turns.map((turn) => [turn.index, turn]));

  const attempt = async (promptText: string): Promise<readonly ScorecardMetricModelResult[]> => {
    const raw = await deps.infer(promptText);
    const { results, applied } = normalizeModelResults(parseResults(raw));
    for (const rule of applied) onDiagnostic({ kind: 'normalized', code: rule });
    // The single strict gate: one result per metric, valid score/evidence pairing, bounded
    // text. It also re-validates the configured metrics, so a corrupt scorecard fails here.
    return validateMetricResults(metrics, results);
  };

  let repaired = false;
  let validated: readonly ScorecardMetricModelResult[];
  try {
    validated = await attempt(prompt);
  } catch (err) {
    if (!(err instanceof ScorecardValidationError) || err.code === 'scorecard_invalid:config') {
      throw err;
    }
    onDiagnostic({ kind: 'repair_attempted', code: err.code });
    try {
      validated = await attempt(prompt + r1RepairSuffix(SHAPE_REPAIR_SENTENCE[err.code]));
    } catch (repairErr) {
      if (repairErr instanceof ScorecardValidationError) {
        onDiagnostic({ kind: 'repair_failed', code: repairErr.code });
      }
      throw repairErr;
    }
    repaired = true;
    onDiagnostic({ kind: 'repair_succeeded', code: err.code });
  }

  let verdict = verifyEvidence(metrics, validated, turnsByIndex);
  if (verdict.violations.length > 0 && !repaired) {
    // ONE repair resample for an evidence violation, with the fixed sentence for the first
    // violation. If the resample is malformed or still violates, the run is evidence-invalid.
    const first = verdict.violations[0] as R1EvidenceCode;
    onDiagnostic({ kind: 'repair_attempted', code: first });
    repaired = true;
    try {
      const second = await attempt(prompt + r1RepairSuffix(R1_EVIDENCE_REPAIR_SUFFIX[first]));
      const secondVerdict = verifyEvidence(metrics, second, turnsByIndex);
      verdict = secondVerdict;
      onDiagnostic({
        kind: secondVerdict.violations.length === 0 ? 'repair_succeeded' : 'repair_failed',
        code: first,
      });
    } catch (repairErr) {
      if (!(repairErr instanceof ScorecardValidationError)) throw repairErr;
      onDiagnostic({ kind: 'repair_failed', code: repairErr.code });
    }
  }

  const weighted = calculateWeightedScore(metrics, verdict.results);
  const overall = weightedScoreToOverall(weighted);
  return {
    results: verdict.results,
    weightedScore5: weighted,
    overallScore: overall,
    recommendation: r1RecommendationForOverall(
      overall,
      input.thresholds,
      integrityFloorBreached(metrics, verdict.results),
    ),
    evidenceValid: verdict.violations.length === 0,
    evidenceViolations: verdict.violations,
    repaired,
  };
}

export interface R1RunSummary {
  readonly overallScore: number | null;
  readonly recommendation: R1Recommendation;
  readonly evidenceValid: boolean;
  readonly evidenceViolations: number;
  readonly repaired: boolean;
}

export interface R1ScoreOutcome {
  /** Median results, one per metric, in scorecard order. */
  readonly metricResults: readonly ScorecardMetricResult[];
  readonly weightedScore5: number | null;
  readonly overallScore: number | null;
  readonly scoringStatus: ScorecardAssessmentStatus;
  /** What the median would recommend, before the agreement checks and the gate. */
  readonly scoredRecommendation: R1Recommendation;
  /** `human_review` unless complete, in agreement and evidence-valid. Gate NOT applied. */
  readonly recommendation: R1Recommendation;
  readonly runsAgree: boolean;
  /** Stable codes: `recommendation_differs`, `metric_spread:<key>`, `metric_status:<key>`. */
  readonly disagreement: readonly string[];
  readonly evidenceValid: boolean;
  readonly complete: boolean;
  readonly runs: readonly R1RunSummary[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Median per metric, agreement checks, and the recommendation (gate NOT applied here). */
export function aggregateR1Runs(
  metrics: readonly RoleScorecardMetric[],
  runs: readonly R1RunOutcome[],
  thresholds: R1Thresholds,
): R1ScoreOutcome {
  const disagreement: string[] = [];
  const ordered = [...metrics].sort((a, b) => a.displayOrder - b.displayOrder);
  const metricResults: ScorecardMetricResult[] = ordered.map((metric) => {
    const perRun = runs.map((run) => run.results.find(
      (result) => result.configMetricId === metric.id,
    ) as ScorecardMetricModelResult);
    const scores = perRun
      .filter((result) => result.evidenceStatus === 'scored')
      .map((result) => result.score as number);
    if (scores.length > 0 && scores.length < perRun.length) {
      disagreement.push(`metric_status:${metric.key}`);
    }
    if (scores.length === 0) {
      const base = perRun[0] as ScorecardMetricModelResult;
      return { ...base, score: null, evidenceStatus: 'insufficient_evidence', metric };
    }
    if (Math.max(...scores) - Math.min(...scores) > 1) {
      disagreement.push(`metric_spread:${metric.key}`);
    }
    const level = median(scores) as ScoreValue;
    const scoredRuns = perRun.filter((result) => result.evidenceStatus === 'scored');
    const donor = scoredRuns.find((result) => result.score === level)
      ?? (scoredRuns[0] as ScorecardMetricModelResult);
    return { ...donor, score: level, evidenceStatus: 'scored', metric };
  });

  if (new Set(runs.map((run) => run.recommendation)).size > 1) {
    disagreement.push('recommendation_differs');
  }

  const complete = metricResults.every((result) => result.evidenceStatus === 'scored');
  const weighted = calculateWeightedScore(metrics, metricResults);
  const overall = weightedScoreToOverall(weighted, SCORE_MAX);
  const scoredRecommendation = r1RecommendationForOverall(
    overall,
    thresholds,
    integrityFloorBreached(metrics, metricResults),
  );
  const evidenceValid = runs.every((run) => run.evidenceValid);
  const runsAgree = disagreement.length === 0;
  const recommendation: R1Recommendation = complete && runsAgree && evidenceValid
    ? scoredRecommendation
    : 'human_review';
  return {
    metricResults,
    weightedScore5: weighted,
    overallScore: overall,
    scoringStatus: complete ? 'complete' : 'incomplete_evidence',
    scoredRecommendation,
    recommendation,
    runsAgree,
    disagreement,
    evidenceValid,
    complete,
    runs: runs.map((run) => ({
      overallScore: run.overallScore,
      recommendation: run.recommendation,
      evidenceValid: run.evidenceValid,
      evidenceViolations: run.evidenceViolations.length,
      repaired: run.repaired,
    })),
  };
}

/**
 * Score a transcript with `R1_SCORING_RUNS` runs and aggregate: run 0 ALONE first, then the
 * remaining runs in parallel.
 *
 * Why run 0 goes first. All runs share ONE circuit breaker. Fanned out together, a breaker that
 * is half-open admits a single probe and refuses the siblings with `circuit_open`, so the
 * attempt could not succeed even when the probe did (the half-open trap, RCA for owner test
 * b58c7d9c). And a provider failure that applies to every call (an exhausted balance, a bad
 * key, a timeout on a long transcript) used to bill three calls for nothing. Run 0 first means a
 * failure costs ONE call and ends the attempt before the other runs start, and a successful
 * probe closes the breaker before the fan-out. The price is at most one extra run of latency.
 */
export async function scoreR1Transcript(
  deps: R1ScoreDeps,
  input: R1ScoreInput,
): Promise<R1ScoreOutcome> {
  const runs = Math.max(1, Math.floor(deps.runs ?? R1_SCORING_RUNS));
  const prompt = buildR1ScorerPrompt({
    metrics: input.scorecard.metrics,
    roleTitle: input.roleTitle,
    turns: input.turns,
    log: input.log,
    stats: input.stats,
    deckFacts: input.deckFacts,
    sentinel: deps.sentinel,
  });
  // Run 0: any failure (provider or validation) propagates here and no further run starts.
  const outcomes: R1RunOutcome[] = [await scoreOneR1Run(deps, input, prompt)];
  // allSettled: a failing run must not leave its siblings as unhandled rejections or abandon
  // in-flight provider calls. The FIRST failure in run order is rethrown once all have settled.
  const settled = await Promise.allSettled(
    Array.from({ length: runs - 1 }, () => scoreOneR1Run(deps, input, prompt)),
  );
  for (const entry of settled) {
    if (entry.status === 'rejected') throw entry.reason;
    outcomes.push(entry.value);
  }
  return aggregateR1Runs(input.scorecard.metrics, outcomes, input.thresholds);
}
