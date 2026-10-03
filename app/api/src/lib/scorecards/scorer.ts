/**
 * scorer.ts — run one role-configured scorecard scoring pass.
 *
 * Flow (all server-owned; the model only supplies per-metric judgements):
 *   buildScorecardPrompt → infer → parse `results` array
 *     → domain.validateMetricResults  (exactly one per metric, closed shape)
 *     → domain.calculateWeightedScore  (PARTIAL: renormalized over the evidenced
 *                                       metrics; null only when NONE were scored)
 *     → domain.weightedScoreToOverall → domain.recommendationForOverall
 *
 * FAIL-CLOSED: any parse/shape failure throws `ScorecardValidationError`. The
 * scorer NEVER fabricates a score, a weighted total, or a recommendation to
 * paper over malformed model output — a screening either scores cleanly against
 * the configured rubric or it fails loudly for retry.
 *
 * Per inference the flow is infer → parseResults → normalizeModelResults →
 * validateMetricResults (UNCHANGED, the single strict gate):
 *   - NORMALIZATION IS PRESENTATION-ONLY. It truncates over-long quotes and
 *     rationales (marked '…'), coerces a numeric-string score '1'..'4', nulls an
 *     ABSENT score on an insufficient_evidence metric, canonicalizes the status
 *     spelling and strips extra keys. It never clamps, rounds or invents a
 *     score and never remaps an id; what persists is ITS new objects, never the
 *     model's originals.
 *   - AT MOST ONE REPAIR RESAMPLE. When the model's output (not the recruiter
 *     config) fails validation, the same prompt is re-sent once with a fixed,
 *     server-owned hint for the failed rule appended after the transcript fence.
 *     The hint never carries the error message or any model text. infer is
 *     therefore called at most twice per scoring pass; a second failure throws
 *     its own code.
 *
 * The status is `incomplete_evidence` whenever ANY metric comes back
 * `insufficient_evidence`. PARTIAL SCORING: a mix of scored + insufficient
 * metrics still yields a real `weightedScore5`/`overallScore`/`recommendation`
 * (renormalized over the scored metrics) so a good screening is never voided by
 * one un-evidenced metric — it is `incomplete_evidence` AND provisionally scored,
 * and the recruiter card shows that. Only when EVERY metric is
 * `insufficient_evidence` are `weightedScore5`/`overallScore` `null` and the
 * recommendation collapses to `human_review`.
 */

import { env } from '../env.js';
import { runClaudeJSONWithProvenance } from '../claude.js';
import { createLogger } from '../logger.js';
import {
  SCORE_MAX,
  SCORECARD_SCHEMA_VERSION,
  type RoleScorecardMetric,
  type RoleScorecardVersion,
  type ScorecardAssessmentStatus,
  type ScorecardAssessmentV2,
  type ScorecardMetricModelResult,
  type ScorecardMetricResult,
  type ScorecardValidationCode,
} from './contracts.js';
import {
  ScorecardValidationError,
  calculateWeightedScore,
  normalizeModelResults,
  recommendationForOverall,
  validateMetricResults,
  weightedScoreToOverall,
} from './domain.js';
import { buildScorecardPrompt } from './prompt.js';
import type { TranscriptTurn } from '../types.js';

/**
 * The inference boundary. Default calls the same DeepSeek JSON runner the v1
 * scorer uses, with the configured scoring model. Injected in tests so no
 * network/CLI call happens. Returns already-parsed JSON.
 */
export interface ScoreWithScorecardDeps {
  readonly infer?: (prompt: string) => Promise<unknown>;
  /**
   * One PII-free event per applied normalization rule and per repair step.
   * `code` is a normalization rule or a ScorecardValidationCode — never model
   * text. Defaults to a structured log line (rejection_reason=<code>).
   */
  readonly onDiagnostic?: (event: ScorecardDiagnosticEvent) => void;
}

export interface ScorecardDiagnosticEvent {
  readonly kind: 'normalized' | 'repair_attempted' | 'repair_succeeded' | 'repair_failed';
  readonly code: string;
}

const scorerLog = createLogger('scorecard-scorer');

function defaultOnDiagnostic(event: ScorecardDiagnosticEvent): void {
  // repair_failed is deliberately silent here: the final code is logged once,
  // as a warning, at the assessment boundary (services/assessment.ts).
  if (event.kind === 'repair_failed') return;
  scorerLog.info('unknown_event', {
    error_category: event.kind === 'normalized' ? 'scorecard_output_normalized' : 'scorecard_output_repair',
    rejection_reason: event.code,
  });
}

const REPAIR_PREFIX = '\n\nNOTE: An earlier answer to this request was rejected by the server validator: ';
const REPAIR_POSTFIX = ' Re-read the OUTPUT CONTRACT and RULES and return the complete corrected JSON object only.';
const EXACT_IDS_HINT = 'return exactly one result for each configMetricId listed above, using the ids verbatim.';

type RepairableCode = Exclude<ScorecardValidationCode, 'scorecard_invalid:config'>;

/**
 * The ONLY text ever appended to a repair prompt: one fixed sentence per failed
 * rule. Keyed by code (never by the error message), so no model output and no
 * candidate text can reach the second prompt through it. The config code has
 * no entry: a broken recruiter configuration is not the model's to fix.
 */
export const REPAIR_SUFFIX: Readonly<Record<RepairableCode, string>> = Object.freeze({
  'scorecard_invalid:output_not_object': 'the answer must be a single JSON object with a "results" array.',
  'scorecard_invalid:results_missing': 'the JSON object must contain a "results" array.',
  'scorecard_invalid:result_not_object': 'every "results" entry must be a JSON object with the five contract keys.',
  'scorecard_invalid:result_count': EXACT_IDS_HINT,
  'scorecard_invalid:unknown_metric_id': EXACT_IDS_HINT,
  'scorecard_invalid:duplicate_metric_id': EXACT_IDS_HINT,
  'scorecard_invalid:evidence_status': '"evidenceStatus" must be exactly "scored" or "insufficient_evidence".',
  'scorecard_invalid:score_not_integer_1_4': 'a "scored" metric must have "score" as a JSON integer from 1 to 4.',
  'scorecard_invalid:insufficient_with_score':
    'if evidence is insufficient keep evidenceStatus "insufficient_evidence" and set score to JSON null; do NOT change it to "scored".',
  'scorecard_invalid:rationale_empty': 'every "rationale" must be non-empty text.',
  'scorecard_invalid:rationale_too_long': 'every "rationale" must be at most 900 characters.',
  'scorecard_invalid:evidence_refs_not_array': '"evidenceRefs" must be a JSON array of strings ([] if none).',
  'scorecard_invalid:evidence_refs_too_many': 'use at most 5 "evidenceRefs" entries per metric.',
  'scorecard_invalid:evidence_ref_not_string': 'every "evidenceRefs" entry must be a JSON string.',
  'scorecard_invalid:evidence_ref_too_long': 'each evidenceRefs entry must be at most 100 characters; excerpt the key phrase.',
});

/** The full fixed text appended to the prompt for one repair resample. */
export function repairSuffix(code: RepairableCode): string {
  return `${REPAIR_PREFIX}${REPAIR_SUFFIX[code]}${REPAIR_POSTFIX}`;
}

export interface ScoreWithScorecardInput {
  readonly scorecard: RoleScorecardVersion;
  readonly roleTitle: string;
  readonly candidateName: string | null;
  readonly transcript: readonly TranscriptTurn[];
  readonly resumeFacts?: string;
  readonly callTimestampIso?: string;
}

/** Extract and shallow-shape the `results` array; fail closed on anything else. */
function parseResults(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScorecardValidationError('scorecard model output must be a JSON object', 'scorecard_invalid:output_not_object');
  }
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new ScorecardValidationError('scorecard model output must contain a `results` array', 'scorecard_invalid:results_missing');
  }
  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ScorecardValidationError('each scorecard result must be an object', 'scorecard_invalid:result_not_object');
    }
  }
  // Element FIELD validity (ids, score/evidence pairing, rationale, refs) is the
  // job of domain.validateMetricResults — the one authority — so pass through.
  return results as Record<string, unknown>[];
}

function attachMetrics(
  metrics: readonly RoleScorecardMetric[],
  results: readonly ScorecardMetricModelResult[],
): ScorecardMetricResult[] {
  const byId = new Map(metrics.map((metric) => [metric.id, metric]));
  return results.map((result) => ({ ...result, metric: byId.get(result.configMetricId)! }));
}

export async function scoreWithScorecard(
  deps: ScoreWithScorecardDeps,
  input: ScoreWithScorecardInput,
): Promise<ScorecardAssessmentV2> {
  const infer =
    deps.infer ??
    (async (prompt: string): Promise<unknown> => {
      const { data } = await runClaudeJSONWithProvenance<unknown>(prompt, {
        model: env.deepseekScoringModel,
      });
      return data;
    });

  const metrics = input.scorecard.metrics;
  const prompt = buildScorecardPrompt({
    metrics,
    roleTitle: input.roleTitle,
    candidateName: input.candidateName,
    transcript: input.transcript,
    resumeFacts: input.resumeFacts,
    callTimestampIso: input.callTimestampIso,
  });

  const onDiagnostic = deps.onDiagnostic ?? defaultOnDiagnostic;

  const attempt = async (promptText: string): Promise<readonly ScorecardMetricModelResult[]> => {
    const raw = await infer(promptText);
    // validateMetricResults is the single fail-closed gate: exactly one result
    // per configured metric, no unknown/duplicate ids, valid score/evidence
    // pairing, bounded rationale and evidence refs. It re-validates the metric
    // set too, so a corrupt configuration also fails here rather than scoring.
    // It sees ONLY the normalizer's new objects, and those are what persist.
    const { results, applied } = normalizeModelResults(parseResults(raw));
    // One event per applied rule, logged BEFORE validation so a rejected
    // output's benign noise is visible too: once refs are truncated,
    // evidence_ref_too_long can no longer fire, and these events are the only
    // witness of which output classes actually occur.
    for (const rule of applied) onDiagnostic({ kind: 'normalized', code: rule });
    return validateMetricResults(metrics, results);
  };

  let validated: readonly ScorecardMetricModelResult[];
  try {
    validated = await attempt(prompt);
  } catch (err) {
    if (!(err instanceof ScorecardValidationError) || err.code === 'scorecard_invalid:config') throw err;
    // ONE repair resample: the identical prompt (same per-call sentinel) plus a
    // fixed hint AFTER the transcript fence. A second failure throws its own
    // code; infer is never called a third time.
    onDiagnostic({ kind: 'repair_attempted', code: err.code });
    try {
      validated = await attempt(prompt + repairSuffix(err.code));
    } catch (repairErr) {
      if (repairErr instanceof ScorecardValidationError) {
        onDiagnostic({ kind: 'repair_failed', code: repairErr.code });
      }
      throw repairErr;
    }
    onDiagnostic({ kind: 'repair_succeeded', code: err.code });
  }

  const weightedScore5 = calculateWeightedScore(metrics, validated);
  const overallScore = weightedScoreToOverall(weightedScore5);
  const recommendation = recommendationForOverall(overallScore);

  const status: ScorecardAssessmentStatus = validated.some(
    (result) => result.evidenceStatus === 'insufficient_evidence',
  )
    ? 'incomplete_evidence'
    : 'complete';

  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    scorecardVersionId: input.scorecard.id,
    revision: 1,
    status,
    metricResults: attachMetrics(metrics, validated),
    // The rubric scale this pass scored on, recorded so a reader never has to
    // guess (pre-0093 rows lack it and are read as the historical 5).
    scoreScaleMax: SCORE_MAX,
    weightedScore5,
    overallScore,
    recommendation,
  };
}
