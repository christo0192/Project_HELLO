import { createHash } from 'node:crypto';
import {
  SCORECARD_MAX_EVIDENCE_REF_LENGTH,
  SCORECARD_MAX_EVIDENCE_REFS,
  SCORECARD_MAX_INSTRUCTION_LENGTH,
  SCORECARD_MAX_METRICS,
  SCORECARD_MAX_NAME_LENGTH,
  SCORECARD_MAX_RATIONALE_LENGTH,
  SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH,
  SCORECARD_WEIGHT_TOTAL_BPS,
  SCORE_MAX,
  SCORE_MIN,
  isScoreScaleMax,
  isScoreValue,
  type MetricEvidenceStatus,
  type RoleScorecardMetric,
  type ScoreValue,
  type ScorecardMetricModelResult,
  type ScorecardNormalizationRule,
  type ScorecardRubric,
  type ScorecardValidationCode,
} from './contracts.js';

/**
 * `message` is a human sentence the admin routes return verbatim (400 bodies),
 * so every existing message is byte-identical. `code` is the stable, PII-free
 * identifier the queue and the logs can actually store (see contracts.ts
 * SCORECARD_VALIDATION_CODES); it defaults to the configuration code so every
 * config/rubric/metric validator keeps its meaning without naming one.
 */
export class ScorecardValidationError extends Error {
  readonly code: ScorecardValidationCode;

  constructor(message: string, code: ScorecardValidationCode = 'scorecard_invalid:config') {
    super(message);
    this.name = 'ScorecardValidationError';
    this.code = code;
  }
}

interface BoundedTextCodes {
  /** Non-text, or empty after whitespace collapse. */
  readonly empty: ScorecardValidationCode;
  readonly tooLong: ScorecardValidationCode;
}

function boundedText(value: unknown, field: string, max: number, codes?: BoundedTextCodes): string {
  if (typeof value !== 'string') throw new ScorecardValidationError(`${field} must be text`, codes?.empty);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new ScorecardValidationError(`${field} must contain 1..${max} characters`, codes?.empty);
  }
  if (normalized.length > max) {
    throw new ScorecardValidationError(`${field} must contain 1..${max} characters`, codes?.tooLong);
  }
  return normalized;
}

export function validateRubric(value: unknown): ScorecardRubric {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScorecardValidationError('rubric must be an object with levels 1..4');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== '1,2,3,4') {
    throw new ScorecardValidationError('rubric must have exactly levels 1,2,3,4');
  }
  return {
    1: boundedText(record['1'], 'rubric.1', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    2: boundedText(record['2'], 'rubric.2', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    3: boundedText(record['3'], 'rubric.3', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
    4: boundedText(record['4'], 'rubric.4', SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH),
  };
}

export function validateRoleMetrics(metrics: readonly RoleScorecardMetric[]): readonly RoleScorecardMetric[] {
  if (metrics.length < 1 || metrics.length > SCORECARD_MAX_METRICS) {
    throw new ScorecardValidationError(`scorecard must contain 1..${SCORECARD_MAX_METRICS} metrics`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const orders = new Set<number>();
  let total = 0;
  for (const metric of metrics) {
    if (!metric.id || ids.has(metric.id)) throw new ScorecardValidationError('metric IDs must be unique');
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(metric.key) || keys.has(metric.key)) {
      throw new ScorecardValidationError('metric keys must be unique stable identifiers');
    }
    if (!Number.isInteger(metric.displayOrder) || metric.displayOrder < 0 || orders.has(metric.displayOrder)) {
      throw new ScorecardValidationError('metric display orders must be unique non-negative integers');
    }
    boundedText(metric.name, 'metric name', SCORECARD_MAX_NAME_LENGTH);
    boundedText(metric.instruction, 'metric instruction', SCORECARD_MAX_INSTRUCTION_LENGTH);
    validateRubric(metric.rubric);
    if (!Number.isInteger(metric.weightBps) || metric.weightBps < 1 || metric.weightBps > SCORECARD_WEIGHT_TOTAL_BPS) {
      throw new ScorecardValidationError('metric weight must be an integer between 1 and 10000 bps');
    }
    ids.add(metric.id); keys.add(metric.key); orders.add(metric.displayOrder); total += metric.weightBps;
  }
  if (total !== SCORECARD_WEIGHT_TOTAL_BPS) {
    throw new ScorecardValidationError(`metric weights must total ${SCORECARD_WEIGHT_TOTAL_BPS} bps`);
  }
  return [...metrics].sort((a, b) => a.displayOrder - b.displayOrder);
}

/** Canonical hash deliberately includes role-owned snapshots, not mutable library data. */
export function hashRoleScorecard(metrics: readonly RoleScorecardMetric[]): string {
  const canonical = validateRoleMetrics(metrics).map((metric) => ({
    id: metric.id,
    libraryMetricId: metric.libraryMetricId,
    key: metric.key,
    name: metric.name.trim().replace(/\s+/g, ' '),
    instruction: metric.instruction.trim().replace(/\s+/g, ' '),
    rubric: validateRubric(metric.rubric),
    weightBps: metric.weightBps,
    displayOrder: metric.displayOrder,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Pin one metric at `newWeightBps`; redistribute the remaining bps over every
 * other metric proportionally. Largest-remainder rounding with display order
 * tie-breaking makes the result deterministic and exact.
 *
 * Every OTHER metric is guaranteed a weight of at least 1 bps: the proportional
 * split can otherwise floor a small-weight metric to 0 (e.g. after pinning one
 * metric near 100% twice in a row), which violates `weightBps >= 1` and 400s the
 * save / freezes the slider. So one bps is RESERVED per other metric up front,
 * only the surplus (`remainder - others.length`) is spread by the largest-
 * remainder rule, and the reserved 1 is added back to each. The guard above
 * ensures `remainder >= others.length`, so the surplus is never negative.
 *
 * This math is BYTE-IDENTICAL to the client mirror in
 * app/web/src/lib/scorecard-weights.ts — the two MUST stay in lock-step.
 */
export function redistributeWeights(
  metrics: readonly RoleScorecardMetric[],
  editedMetricId: string,
  newWeightBps: number,
): readonly RoleScorecardMetric[] {
  const ordered = validateRoleMetrics(metrics);
  const edited = ordered.find((metric) => metric.id === editedMetricId);
  if (!edited) throw new ScorecardValidationError('edited metric is not in the scorecard');
  const others = ordered.filter((metric) => metric.id !== editedMetricId);
  if (!Number.isInteger(newWeightBps) || newWeightBps < 1 || newWeightBps > SCORECARD_WEIGHT_TOTAL_BPS - others.length) {
    throw new ScorecardValidationError('edited metric weight leaves no positive weight for another metric');
  }
  if (!others.length) return [{ ...edited, weightBps: SCORECARD_WEIGHT_TOTAL_BPS }];

  const remainder = SCORECARD_WEIGHT_TOTAL_BPS - newWeightBps;
  // Reserve 1 bps per other metric so none can floor to 0; distribute only the
  // surplus proportionally, then add the reserved 1 back.
  const distributable = remainder - others.length;
  const oldOtherTotal = others.reduce((sum, metric) => sum + metric.weightBps, 0);
  const shares = others.map((metric) => {
    const numerator = oldOtherTotal > 0 ? distributable * metric.weightBps : distributable;
    const denominator = oldOtherTotal > 0 ? oldOtherTotal : others.length;
    const floor = Math.floor(numerator / denominator);
    return { metric, floor, fractional: numerator % denominator };
  });
  let unallocated = distributable - shares.reduce((sum, share) => sum + share.floor, 0);
  shares.sort((a, b) => b.fractional - a.fractional || a.metric.displayOrder - b.metric.displayOrder);
  const redistributed = new Map(shares.map((share) => [share.metric.id, share.floor + 1]));
  for (const share of shares) {
    if (unallocated-- <= 0) break;
    redistributed.set(share.metric.id, (redistributed.get(share.metric.id) ?? 0) + 1);
  }
  return ordered.map((metric) => metric.id === editedMetricId
    ? { ...metric, weightBps: newWeightBps }
    : { ...metric, weightBps: redistributed.get(metric.id)! });
}

export interface ValidatedMetricResult extends ScorecardMetricModelResult {
  readonly score: ScoreValue | null;
  readonly evidenceStatus: MetricEvidenceStatus;
}

export function validateMetricResults(
  configuredMetrics: readonly RoleScorecardMetric[],
  results: readonly ScorecardMetricModelResult[],
): readonly ValidatedMetricResult[] {
  // A corrupt CONFIGURATION throws here with the default config code — the one
  // code the scorer never "repairs" by re-asking the model.
  const configured = validateRoleMetrics(configuredMetrics);
  // Every throw below keeps its historical message byte-for-byte and adds the
  // code naming the exact rule, so a DLQ row says which one fired.
  if (results.length !== configured.length) {
    throw new ScorecardValidationError('model output must contain exactly one result per metric', 'scorecard_invalid:result_count');
  }
  const expected = new Set(configured.map((metric) => metric.id));
  const seen = new Set<string>();
  for (const result of results) {
    if (!expected.has(result.configMetricId)) {
      throw new ScorecardValidationError('model output contains an unknown or duplicate metric ID', 'scorecard_invalid:unknown_metric_id');
    }
    if (seen.has(result.configMetricId)) {
      throw new ScorecardValidationError('model output contains an unknown or duplicate metric ID', 'scorecard_invalid:duplicate_metric_id');
    }
    seen.add(result.configMetricId);
    if (result.evidenceStatus !== 'scored' && result.evidenceStatus !== 'insufficient_evidence') {
      throw new ScorecardValidationError('metric evidence status is invalid', 'scorecard_invalid:evidence_status');
    }
    if (result.evidenceStatus === 'scored' && !isScoreValue(result.score)) {
      throw new ScorecardValidationError(
        `scored metric must have an integer score from ${SCORE_MIN} to ${SCORE_MAX}`,
        'scorecard_invalid:score_not_integer_1_4',
      );
    }
    if (result.evidenceStatus === 'insufficient_evidence' && result.score !== null) {
      throw new ScorecardValidationError('insufficient-evidence metric must not receive an invented score', 'scorecard_invalid:insufficient_with_score');
    }
    boundedText(result.rationale, 'metric rationale', SCORECARD_MAX_RATIONALE_LENGTH, {
      empty: 'scorecard_invalid:rationale_empty',
      tooLong: 'scorecard_invalid:rationale_too_long',
    });
    // The former single combined refs check, split so each failure names its
    // rule. Each is exactly as strict as before (raw length, no trimming).
    const refsMessage = 'metric evidence references are invalid';
    if (!Array.isArray(result.evidenceRefs)) {
      throw new ScorecardValidationError(refsMessage, 'scorecard_invalid:evidence_refs_not_array');
    }
    if (result.evidenceRefs.length > SCORECARD_MAX_EVIDENCE_REFS) {
      throw new ScorecardValidationError(refsMessage, 'scorecard_invalid:evidence_refs_too_many');
    }
    if (result.evidenceRefs.some((ref) => typeof ref !== 'string')) {
      throw new ScorecardValidationError(refsMessage, 'scorecard_invalid:evidence_ref_not_string');
    }
    if (result.evidenceRefs.some((ref) => ref.length > SCORECARD_MAX_EVIDENCE_REF_LENGTH)) {
      throw new ScorecardValidationError(refsMessage, 'scorecard_invalid:evidence_ref_too_long');
    }
  }
  return configured.map((metric) => results.find((result) => result.configMetricId === metric.id)!);
}

// ── Model-output normalizer (presentation-only) ─────────────────────────────

const MODEL_RESULT_KEYS = new Set(['configMetricId', 'score', 'evidenceStatus', 'rationale', 'evidenceRefs']);
const ELLIPSIS = '…';
/** A truncated rationale is never cut shorter than this many characters. */
const RATIONALE_MIN_CUT = 500;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** First `units` UTF-16 units, backing off one so a surrogate pair is never split. */
function headUtf16(value: string, units: number): string {
  let end = Math.min(units, value.length);
  if (end > 0 && end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Cut an over-long rationale to at most SCORECARD_MAX_RATIONALE_LENGTH including
 * the ellipsis: at the last sentence end, else the last space, at or after
 * RATIONALE_MIN_CUT within the first max-1 units; else a hard cut. The floor
 * keeps a rationale whose only full stop is early from collapsing to a stub.
 */
function truncateRationale(value: string): string {
  const limit = SCORECARD_MAX_RATIONALE_LENGTH - 1;
  const head = value.slice(0, limit);
  for (let i = head.length - 1; i >= RATIONALE_MIN_CUT; i -= 1) {
    const ch = head[i];
    if (ch === '.' || ch === '!' || ch === '?') return head.slice(0, i + 1) + ELLIPSIS;
  }
  const space = head.lastIndexOf(' ');
  if (space >= RATIONALE_MIN_CUT) return head.slice(0, space) + ELLIPSIS;
  return headUtf16(value, limit) + ELLIPSIS;
}

const STATUS_SCORED: MetricEvidenceStatus = 'scored';
const STATUS_INSUFFICIENT: MetricEvidenceStatus = 'insufficient_evidence';

/**
 * Fix ONLY presentation and type noise in raw model result entries, before the
 * UNCHANGED strict validator sees them.
 *
 * Pure: returns NEW objects carrying exactly the five contract keys (so extra
 * model keys are never persisted) plus the de-duplicated list of rules applied.
 * It never clamps or rounds a score, never nulls a numeric score, never remaps
 * an id, and leaves anything it cannot canonicalize RAW so validateMetricResults
 * still rejects it. It is deliberately NOT called from validateMetricResults or
 * calculateWeightedScore: the validator stays the single strict gate.
 */
export function normalizeModelResults(entries: readonly Record<string, unknown>[]): {
  results: ScorecardMetricModelResult[];
  applied: ScorecardNormalizationRule[];
} {
  const applied = new Set<ScorecardNormalizationRule>();
  const results = entries.map((entry): ScorecardMetricModelResult => {
    if (Object.keys(entry).some((key) => !MODEL_RESULT_KEYS.has(key))) applied.add('extra_keys_stripped');

    let configMetricId: unknown = entry.configMetricId;
    if (typeof configMetricId === 'string' && configMetricId.trim() !== configMetricId) {
      configMetricId = configMetricId.trim();
      applied.add('metric_id_trimmed');
    }

    let evidenceStatus: unknown = entry.evidenceStatus;
    if (typeof evidenceStatus === 'string') {
      const canonical = evidenceStatus.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if ((canonical === STATUS_SCORED || canonical === STATUS_INSUFFICIENT) && canonical !== evidenceStatus) {
        evidenceStatus = canonical;
        applied.add('evidence_status_canonicalized');
      }
    }

    let score: unknown = entry.score;
    if (typeof score === 'string' && /^\s*[1-4]\s*$/.test(score)) {
      score = Number(score);
      applied.add('score_string_coerced');
    } else if (
      evidenceStatus === STATUS_INSUFFICIENT &&
      (score === undefined || (typeof score === 'string' && (score.trim() === '' || score.trim().toLowerCase() === 'null')))
    ) {
      // Only an ABSENT score becomes null. A numeric score on an
      // insufficient_evidence metric is left as-is and still fails closed.
      score = null;
      applied.add('insufficient_score_nullified');
    }

    let rationale: unknown = entry.rationale;
    if (typeof rationale === 'string') {
      const collapsed = collapse(rationale);
      // An empty rationale is left raw so it still fails rationale_empty.
      if (collapsed) {
        rationale = collapsed.length > SCORECARD_MAX_RATIONALE_LENGTH ? truncateRationale(collapsed) : collapsed;
        if (collapsed.length > SCORECARD_MAX_RATIONALE_LENGTH) applied.add('rationale_truncated');
      }
    }

    const rawRefs = entry.evidenceRefs;
    let refList: readonly unknown[];
    if (rawRefs === undefined || rawRefs === null) {
      refList = [];
    } else if (typeof rawRefs === 'string') {
      refList = [rawRefs];
      applied.add('evidence_refs_coerced_array');
    } else if (!Array.isArray(rawRefs)) {
      refList = [];
      applied.add('evidence_refs_coerced_array');
    } else {
      refList = rawRefs;
    }
    const refs: string[] = [];
    for (const ref of refList) {
      // Non-strings (numbers included) are DROPPED, never stringified: a bare
      // number is not a quote of anything the candidate said.
      const text = typeof ref === 'string' ? collapse(ref) : '';
      if (!text) {
        applied.add('evidence_ref_dropped');
        continue;
      }
      if (text.length > SCORECARD_MAX_EVIDENCE_REF_LENGTH) {
        refs.push(headUtf16(text, SCORECARD_MAX_EVIDENCE_REF_LENGTH - 1) + ELLIPSIS);
        applied.add('evidence_ref_truncated');
      } else {
        refs.push(text);
      }
    }
    if (refs.length > SCORECARD_MAX_EVIDENCE_REFS) applied.add('evidence_refs_capped');
    const evidenceRefs = refs.slice(0, SCORECARD_MAX_EVIDENCE_REFS);

    // Values the normalizer could not canonicalize are carried RAW (hence the
    // cast): the validator, not this function, decides whether they pass.
    return {
      configMetricId,
      score,
      evidenceStatus,
      rationale,
      evidenceRefs,
    } as unknown as ScorecardMetricModelResult;
  });
  return { results, applied: [...applied] };
}

export function calculateWeightedScore(
  configuredMetrics: readonly RoleScorecardMetric[],
  results: readonly ScorecardMetricModelResult[],
): number | null {
  const configured = validateRoleMetrics(configuredMetrics);
  const validated = validateMetricResults(configured, results);
  const byId = new Map(validated.map((result) => [result.configMetricId, result]));
  // PARTIAL SCORING: average over the metrics that HAVE a score, renormalizing
  // their configured weights among themselves. A single metric the model could
  // not evidence must NOT void the whole scorecard — that discarded the good
  // scores and produced a blank "human review" card (the exact production
  // failure this repairs). The result is null ONLY when NOT ONE metric was
  // scored (a genuinely unscoreable screening → human_review). When every metric
  // is scored, weightTotal == SCORECARD_WEIGHT_TOTAL_BPS, so this is byte-for-byte
  // the prior full-coverage result.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const metric of configured) {
    const score = byId.get(metric.id)!.score;
    if (score === null) continue;
    weightedSum += metric.weightBps * score;
    weightTotal += metric.weightBps;
  }
  if (weightTotal === 0) return null;
  return Math.round((weightedSum / weightTotal) * 10_000) / 10_000;
}

/**
 * Project a weighted rubric score onto 0–100. `scaleMax` is the rubric scale the
 * score was produced on — 4 today, 5 for assessments persisted before 0093 —
 * so a historical 3/5 (50) and a new 2.5/4 (50) mean the same thing.
 */
export function weightedScoreToOverall(score: number | null, scaleMax: number = SCORE_MAX): number | null {
  if (score === null) return null;
  if (!isScoreScaleMax(scaleMax)) throw new ScorecardValidationError('unknown rubric scale');
  if (!Number.isFinite(score) || score < SCORE_MIN || score > scaleMax) {
    throw new ScorecardValidationError(`weighted score must be between ${SCORE_MIN} and ${scaleMax}`);
  }
  return Math.round(((score - SCORE_MIN) / (scaleMax - SCORE_MIN)) * 100);
}

export function recommendationForOverall(overall: number | null): 'advance' | 'hold' | 'reject' | 'human_review' {
  if (overall === null) return 'human_review';
  if (overall >= 65) return 'advance';
  if (overall >= 45) return 'hold';
  return 'reject';
}
