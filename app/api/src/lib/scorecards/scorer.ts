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
import {
  SCORECARD_SCHEMA_VERSION,
  type RoleScorecardMetric,
  type RoleScorecardVersion,
  type ScorecardAssessmentStatus,
  type ScorecardAssessmentV2,
  type ScorecardMetricModelResult,
  type ScorecardMetricResult,
} from './contracts.js';
import {
  ScorecardValidationError,
  calculateWeightedScore,
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
function parseResults(raw: unknown): ScorecardMetricModelResult[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScorecardValidationError('scorecard model output must be a JSON object');
  }
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new ScorecardValidationError('scorecard model output must contain a `results` array');
  }
  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ScorecardValidationError('each scorecard result must be an object');
    }
  }
  // Element FIELD validity (ids, score/evidence pairing, rationale, refs) is the
  // job of domain.validateMetricResults — the one authority — so pass through.
  return results as ScorecardMetricModelResult[];
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

  const raw = await infer(prompt);

  // validateMetricResults is the single fail-closed gate: exactly one result
  // per configured metric, no unknown/duplicate ids, valid score/evidence
  // pairing, bounded rationale and evidence refs. It re-validates the metric
  // set too, so a corrupt configuration also fails here rather than scoring.
  const modelResults = parseResults(raw);
  const validated = validateMetricResults(metrics, modelResults);

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
    weightedScore5,
    overallScore,
    recommendation,
  };
}
