/**
 * fairness.ts — LLM-07 voluntary/synthetic cohort fairness harness (PR-A Lane A3).
 *
 * DETERMINISTIC, FULLY OFFLINE. Computes descriptive cohort metrics from
 * synthetic / explicitly voluntary cohort labels only. It NEVER infers a
 * protected trait from voice, name, accent, transcript, language, or metadata:
 * any member or label field whose key starts with `inferred_from` is rejected.
 *
 * HONESTY CONTRACT (audited plan C2/C4 + Lane A3):
 *  - every cohort label is explicitly voluntary (declared: true, consented:
 *    true, declarationSource voluntary_self_declared | synthetic_fixture);
 *  - members without a voluntary label are EXCLUDED from cohort metrics, never
 *    inferred and never silently bucketed;
 *  - cohorts below the configured minimum N are SUPPRESSED (state suppressed,
 *    no value, reason below_minimum_n);
 *  - zero-sample metrics report state insufficient_data, never a meaningful 0;
 *  - disparity is DESCRIPTIVE ONLY (role: descriptive_only) — it is not an
 *    acceptance gate and no fairness/model-quality approval is derived here;
 *  - every threshold is PROPOSED; an APPROVED threshold or an approval claim
 *    is rejected (no authentic voluntary cohort approval exists in
 *    repository-only work).
 *
 * Reads no environment variables, performs no network access, and imports
 * only node:crypto (no dependency additions).
 */

import { createHash } from 'node:crypto';

// ── Schema identity ─────────────────────────────────────────────────────

export const FAIRNESS_SCHEMA_ID = 'model-governance-fairness.schema.json';
export const FAIRNESS_SCHEMA_VERSION = 1;
export const FAIRNESS_DIGEST_ALGORITHM = 'sha256';
export const FAIRNESS_THRESHOLD_STATUS = 'PROPOSED';

/** Approval claim token. Only used as a comparison constant; shipped artifacts
 *  never carry it as a status value. */
const APPROVED = 'APPROVED';

// ── Closed enumerations ─────────────────────────────────────────────────

export const VOLUNTARY_DECLARATION_SOURCES = [
  'voluntary_self_declared',
  'synthetic_fixture',
] as const;
export type VoluntaryDeclarationSource = (typeof VOLUNTARY_DECLARATION_SOURCES)[number];

/** Protected-trait channels that may never be inferred. Field keys starting
 *  with `inferred_from` are rejected wholesale; these are the documented
 *  channels the harness guards. */
export const INFERRED_TRAIT_CHANNELS = [
  'voice',
  'name',
  'accent',
  'transcript',
  'language',
  'metadata',
] as const;

export const FAIRNESS_METRIC_IDS = [
  'cohort_coverage',
  'mean_score',
  'uncertainty',
  'disparity',
] as const;
export type FairnessMetricId = (typeof FAIRNESS_METRIC_IDS)[number];

export const FAIRNESS_METRIC_STATES = ['measured', 'insufficient_data', 'suppressed'] as const;
export type FairnessMetricState = (typeof FAIRNESS_METRIC_STATES)[number];

export const DEFAULT_MINIMUM_N = 5;

// ── Closed identifier grammars ──────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const INFERRED_TRAIT_PREFIX = 'inferred_from';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function isFiniteNumberIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function hasInferredTraitKey(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => key.startsWith(INFERRED_TRAIT_PREFIX));
}

// ── Cohort shapes ───────────────────────────────────────────────────────

export interface VoluntaryCohortLabel {
  /** Explicitly declared; never derived. */
  declared: true;
  /** Closed kebab-case cohort id. */
  cohortId: string;
  declarationSource: VoluntaryDeclarationSource;
  /** Explicit consent to use the label for aggregate cohort reporting. */
  consented: true;
}

export interface CohortMember {
  /** Closed kebab-case member id. */
  memberId: string;
  /** Optional. Missing → member is EXCLUDED from cohort metrics, never inferred. */
  voluntaryLabel?: VoluntaryCohortLabel;
  /** Observed outcome score on the 0..10 rubric scale (advisory). */
  observedScore: number;
  /** Optional label confidence in 0..1 (source of the uncertainty metric). */
  confidence?: number;
}

export interface CohortDocument {
  schema: typeof FAIRNESS_SCHEMA_ID;
  schemaVersion: number;
  status: 'proposed';
  /** Minimum cohort size before any cohort metric is measured. */
  minimumN: number;
  description?: string;
  /** SHA-256 digest manifest over each member's canonical serialization. */
  manifest: { algorithm: typeof FAIRNESS_DIGEST_ALGORITHM; digests: Record<string, string> };
  members: CohortMember[];
}

export interface FairnessValidationResult {
  valid: boolean;
  /** Fixed-category diagnostic; never echoes a rejected value verbatim. */
  error?: string;
  /** Members present without a voluntary label (excluded, not inferred). */
  excludedMembers?: string[];
}

// ── Cohort document validation ──────────────────────────────────────────

const COHORT_DOC_KEYS: ReadonlySet<string> = new Set([
  'schema',
  'schemaVersion',
  'status',
  'minimumN',
  'description',
  'manifest',
  'members',
]);
const MANIFEST_KEYS: ReadonlySet<string> = new Set(['algorithm', 'digests']);
const MEMBER_KEYS: ReadonlySet<string> = new Set(['memberId', 'voluntaryLabel', 'observedScore', 'confidence']);
const LABEL_KEYS: ReadonlySet<string> = new Set(['declared', 'cohortId', 'declarationSource', 'consented']);

/**
 * Validate a voluntary/synthetic cohort document. Rejects: unknown fields,
 * non-voluntary or non-consented labels, out-of-grammar ids, out-of-range
 * scores/confidences, and ANY `inferred_from_*` trait-inference field.
 * Members without a voluntary label are collected as excluded (never
 * rejected, never inferred).
 */
export function validateCohortDocument(raw: unknown): FairnessValidationResult {
  if (!isPlainObject(raw)) {
    return { valid: false, error: 'cohort document: must be a plain object' };
  }
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!COHORT_DOC_KEYS.has(key)) {
      return { valid: false, error: 'cohort document: unknown field at top level' };
    }
  }
  if (doc.schema !== FAIRNESS_SCHEMA_ID) {
    return { valid: false, error: 'cohort document: schema id mismatch' };
  }
  if (
    typeof doc.schemaVersion !== 'number' ||
    !Number.isInteger(doc.schemaVersion) ||
    doc.schemaVersion < 1
  ) {
    return { valid: false, error: 'cohort document: schemaVersion must be a positive integer' };
  }
  if (doc.status !== 'proposed') {
    return { valid: false, error: 'cohort document: status must be proposed' };
  }
  if (typeof doc.minimumN !== 'number' || !Number.isInteger(doc.minimumN) || doc.minimumN < 1) {
    return { valid: false, error: 'cohort document: minimumN must be a positive integer' };
  }
  if (doc.description !== undefined && (typeof doc.description !== 'string' || doc.description.length === 0)) {
    return { valid: false, error: 'cohort document: description must be a non-empty string' };
  }
  if (!isPlainObject(doc.manifest) || !hasOnlyKeys(doc.manifest, MANIFEST_KEYS)) {
    return { valid: false, error: 'cohort document: manifest malformed' };
  }
  if (doc.manifest.algorithm !== FAIRNESS_DIGEST_ALGORITHM) {
    return { valid: false, error: 'cohort document: manifest algorithm must be sha256' };
  }
  if (!isPlainObject(doc.manifest.digests)) {
    return { valid: false, error: 'cohort document: manifest digests must be a plain object' };
  }
  if (!Array.isArray(doc.members) || doc.members.length === 0) {
    return { valid: false, error: 'cohort document: members must be a non-empty array' };
  }

  const excludedMembers: string[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < doc.members.length; i += 1) {
    const member = doc.members[i];
    const label = `members[${i}]`;
    if (!isPlainObject(member)) {
      return { valid: false, error: `${label}: must be a plain object` };
    }
    for (const key of Object.keys(member)) {
      if (!MEMBER_KEYS.has(key)) {
        if (key.startsWith(INFERRED_TRAIT_PREFIX)) {
          return {
            valid: false,
            error: `${label}: protected-trait inference is rejected; cohort labels must be explicit and voluntary`,
          };
        }
        return { valid: false, error: `${label}: unknown field` };
      }
    }
    if (hasInferredTraitKey(member)) {
      return {
        valid: false,
        error: `${label}: protected-trait inference is rejected; cohort labels must be explicit and voluntary`,
      };
    }

    if (typeof member.memberId !== 'string' || !ID_RE.test(member.memberId)) {
      return { valid: false, error: `${label}.memberId: must be a lowercase kebab-case identifier` };
    }
    if (seenIds.has(member.memberId)) {
      return { valid: false, error: `${label}.memberId: duplicate member id` };
    }
    seenIds.add(member.memberId);

    if (!isFiniteNumberIn(member.observedScore, 0, 10)) {
      return { valid: false, error: `${label}.observedScore: must be a number between 0 and 10` };
    }
    if (member.confidence !== undefined && !isFiniteNumberIn(member.confidence, 0, 1)) {
      return { valid: false, error: `${label}.confidence: must be a number between 0 and 1` };
    }

    // Digest verification (corrupted-member tamper control) for EVERY member,
    // labeled or excluded.
    const expectedDigest = (doc.manifest.digests as Record<string, string>)[member.memberId];
    if (!expectedDigest) {
      return { valid: false, error: `${label}: missing manifest digest` };
    }
    if (computeCohortDigest(member) !== expectedDigest) {
      return { valid: false, error: `${label}: digest drift (tampered member)` };
    }

    if (member.voluntaryLabel === undefined) {
      excludedMembers.push(member.memberId);
      continue;
    }    if (!isPlainObject(member.voluntaryLabel)) {
      return { valid: false, error: `${label}.voluntaryLabel: must be a plain object` };
    }
    const labelObj = member.voluntaryLabel;
    for (const key of Object.keys(labelObj)) {
      if (!LABEL_KEYS.has(key)) {
        if (key.startsWith(INFERRED_TRAIT_PREFIX)) {
          return {
            valid: false,
            error: `${label}.voluntaryLabel: protected-trait inference is rejected; cohort labels must be explicit and voluntary`,
          };
        }
        return { valid: false, error: `${label}.voluntaryLabel: unknown field` };
      }
    }
    if (hasInferredTraitKey(labelObj)) {
      return {
        valid: false,
        error: `${label}.voluntaryLabel: protected-trait inference is rejected; cohort labels must be explicit and voluntary`,
      };
    }
    if (labelObj.declared !== true) {
      return { valid: false, error: `${label}.voluntaryLabel.declared: must be explicitly true` };
    }
    if (typeof labelObj.cohortId !== 'string' || !ID_RE.test(labelObj.cohortId)) {
      return { valid: false, error: `${label}.voluntaryLabel.cohortId: must be a lowercase kebab-case identifier` };
    }
    if (!(VOLUNTARY_DECLARATION_SOURCES as readonly string[]).includes(labelObj.declarationSource as string)) {
      return { valid: false, error: `${label}.voluntaryLabel.declarationSource: not allowlisted` };
    }
    if (labelObj.consented !== true) {
      return { valid: false, error: `${label}.voluntaryLabel.consented: must be explicitly true` };
    }
  }

  return { valid: true, excludedMembers };
}

// ── Report shapes ───────────────────────────────────────────────────────

export interface FairnessThreshold {
  metricId: FairnessMetricId;
  /** Proposed target value in 0..1 (higher is better). Advisory only. */
  proposedValue: number;
  status: typeof FAIRNESS_THRESHOLD_STATUS;
}

export const FAIRNESS_THRESHOLDS: readonly FairnessThreshold[] = [
  { metricId: 'cohort_coverage', proposedValue: 0.8, status: FAIRNESS_THRESHOLD_STATUS },
  { metricId: 'mean_score', proposedValue: 0.6, status: FAIRNESS_THRESHOLD_STATUS },
  { metricId: 'uncertainty', proposedValue: 0.9, status: FAIRNESS_THRESHOLD_STATUS },
  { metricId: 'disparity', proposedValue: 0.3, status: FAIRNESS_THRESHOLD_STATUS },
];

export interface CohortMetricRecord {
  cohortId: string;
  memberCount: number;
  state: FairnessMetricState;
  /** Present only when measured; 0..1 where higher is better. */
  value?: number;
  reason?: 'below_minimum_n' | 'no_observations';
  note?: string;
}

export interface CohortCoverageRecord {
  measuredCohorts: number;
  declaredCohorts: number;
  state: FairnessMetricState;
  value?: number;
}

export interface DisparityRecord {
  state: 'measured' | 'insufficient_data';
  value?: number;
  /** Disparity is descriptive only — never an acceptance verdict. */
  role: 'descriptive_only';
  note: string;
}

export interface FairnessReport {
  schema: typeof FAIRNESS_SCHEMA_ID;
  schemaVersion: number;
  status: 'proposed';
  reportId: string;
  generatedAt: string;
  minimumN: number;
  declaredCohorts: number;
  measuredCohorts: number;
  excludedMembers: string[];
  cohortCoverage: CohortCoverageRecord;
  meanScores: CohortMetricRecord[];
  uncertainty: CohortMetricRecord[];
  disparity: DisparityRecord;
  thresholds: FairnessThreshold[];
  conclusion: {
    kind: 'descriptive_only' | 'insufficient_data';
    text: string;
  };
}

// ── Metric computation (deterministic, descriptive only) ────────────────

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function groupByCohort(doc: CohortDocument): Map<string, CohortMember[]> {
  const groups = new Map<string, CohortMember[]>();
  for (const member of doc.members) {
    if (!member.voluntaryLabel) continue;
    const cohortId = member.voluntaryLabel.cohortId;
    const bucket = groups.get(cohortId);
    if (bucket) bucket.push(member);
    else groups.set(cohortId, [member]);
  }
  return groups;
}

function scoreCohortMetric(
  cohortId: string,
  members: CohortMember[],
  valueOf: (member: CohortMember) => number | undefined,
  label: string,
  minimumN: number,
): CohortMetricRecord {
  const memberCount = members.length;
  if (memberCount === 0) {
    return { cohortId, memberCount: 0, state: 'insufficient_data', reason: 'no_observations' };
  }
  if (memberCount < minimumN) {
    return {
      cohortId,
      memberCount,
      state: 'suppressed',
      reason: 'below_minimum_n',
      note: `${label} suppressed: cohort below minimum N (${memberCount} < ${minimumN})`,
    };
  }
  const values = members
    .map(valueOf)
    .filter((v): v is number => v !== undefined);
  if (values.length === 0) {
    return { cohortId, memberCount, state: 'insufficient_data', reason: 'no_observations' };
  }
  return { cohortId, memberCount, state: 'measured', value: clamp01(mean(values) / 10) };
}

export interface BuildFairnessReportInput {
  fixtureDocument: unknown;
  reportId?: string;
  clock?: { now(): Date };
}

export type BuildFairnessReportOutput =
  | { ok: true; report: FairnessReport }
  | { ok: false; error: string };

/**
 * Build a deterministic, descriptive-only fairness report from a validated
 * voluntary/synthetic cohort document. Small cohorts are suppressed, zero
 * samples report insufficient_data, members without a voluntary label are
 * excluded, and disparity is reported with role descriptive_only only.
 */
export function buildFairnessReport(input: BuildFairnessReportInput): BuildFairnessReportOutput {
  const docResult = validateCohortDocument(input.fixtureDocument);
  if (!docResult.valid) {
    return { ok: false, error: docResult.error ?? 'cohort document: invalid' };
  }
  const doc = input.fixtureDocument as CohortDocument;
  const excludedMembers = docResult.excludedMembers ?? [];

  const groups = groupByCohort(doc);
  const cohortIds = [...groups.keys()];
  const minimumN = doc.minimumN;

  const meanScores = cohortIds.map((cohortId) =>
    scoreCohortMetric(
      cohortId,
      groups.get(cohortId) ?? [],
      (m) => m.observedScore,
      'mean score',
      minimumN,
    ),
  );
  const uncertainty = cohortIds.map((cohortId) =>
    scoreCohortMetric(
      cohortId,
      groups.get(cohortId) ?? [],
      (m) => (m.confidence === undefined ? undefined : 1 - m.confidence),
      'uncertainty',
      minimumN,
    ),
  );

  const measuredCohorts = meanScores.filter((m) => m.state === 'measured').length;
  const declaredCohorts = cohortIds.length;
  const cohortCoverage: CohortCoverageRecord =
    declaredCohorts === 0
      ? { measuredCohorts: 0, declaredCohorts: 0, state: 'insufficient_data' }
      : {
          measuredCohorts,
          declaredCohorts,
          state: 'measured',
          value: measuredCohorts / declaredCohorts,
        };

  const measuredValues = meanScores
    .filter((m) => m.state === 'measured')
    .map((m) => m.value ?? 0);
  const disparity: DisparityRecord =
    measuredValues.length >= 2
      ? {
          state: 'measured',
          value: Math.max(...measuredValues) - Math.min(...measuredValues),
          role: 'descriptive_only',
          note: 'Descriptive only: max-min mean-score spread across measured cohorts. Not an acceptance gate and not a fairness approval.',
        }
      : {
          state: 'insufficient_data',
          role: 'descriptive_only',
          note: 'Fewer than two measured cohorts; disparity cannot be reported.',
        };

  const report: FairnessReport = {
    schema: FAIRNESS_SCHEMA_ID,
    schemaVersion: FAIRNESS_SCHEMA_VERSION,
    status: 'proposed',
    reportId: input.reportId ?? `fairness-report-v${FAIRNESS_SCHEMA_VERSION}`,
    generatedAt: (input.clock?.now() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    minimumN,
    declaredCohorts,
    measuredCohorts,
    excludedMembers,
    cohortCoverage,
    meanScores,
    uncertainty,
    disparity,
    thresholds: [...FAIRNESS_THRESHOLDS],
    conclusion:
      measuredCohorts === 0
        ? {
            kind: 'insufficient_data',
            text: 'No cohort met the minimum-N suppression threshold; no fairness metric is reported. Scores remain advisory.',
          }
        : {
            kind: 'descriptive_only',
            text: 'Descriptive cohort statistics only. No model-quality or fairness approval is derived in repository-only work; thresholds are PROPOSED and scores remain advisory.',
          },
  };

  const reportCheck = validateFairnessReport(report);
  if (!reportCheck.valid) {
    return { ok: false, error: `fairness: report failed validation: ${reportCheck.error}` };
  }
  return { ok: true, report };
}

// ── Report validation ───────────────────────────────────────────────────

const FAIRNESS_REPORT_KEYS: ReadonlySet<string> = new Set([
  'schema',
  'schemaVersion',
  'status',
  'reportId',
  'generatedAt',
  'minimumN',
  'declaredCohorts',
  'measuredCohorts',
  'excludedMembers',
  'cohortCoverage',
  'meanScores',
  'uncertainty',
  'disparity',
  'thresholds',
  'conclusion',
]);
const COHORT_METRIC_KEYS: ReadonlySet<string> = new Set(['cohortId', 'memberCount', 'state', 'value', 'reason', 'note']);
const COVERAGE_KEYS: ReadonlySet<string> = new Set(['measuredCohorts', 'declaredCohorts', 'state', 'value']);
const DISPARITY_KEYS: ReadonlySet<string> = new Set(['state', 'value', 'role', 'note']);
const THRESHOLD_KEYS: ReadonlySet<string> = new Set(['metricId', 'proposedValue', 'status']);
const CONCLUSION_KEYS: ReadonlySet<string> = new Set(['kind', 'text']);

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

/**
 * Validate a fairness report. Rejects unknown fields, any winner/approval
 * claim, non-PROPOSED thresholds, out-of-range values, and any disparity
 * record that is not descriptive_only.
 */
export function validateFairnessReport(raw: unknown): FairnessValidationResult {
  if (!isPlainObject(raw)) {
    return { valid: false, error: 'fairness report: must be a plain object' };
  }
  const report = raw as Record<string, unknown>;
  for (const key of Object.keys(report)) {
    if (key === 'winner') {
      return { valid: false, error: 'fairness report: winner claims are rejected; no model-quality or fairness approval is derived' };
    }
    if (key === 'approvalStatus') {
      return { valid: false, error: 'fairness report: fairness approval is rejected; no authentic voluntary cohort approval exists in repository-only work' };
    }
    if (!FAIRNESS_REPORT_KEYS.has(key)) {
      return { valid: false, error: 'fairness report: unknown field at top level' };
    }
  }

  if (report.schema !== FAIRNESS_SCHEMA_ID) {
    return { valid: false, error: 'fairness report: schema id mismatch' };
  }
  if (
    typeof report.schemaVersion !== 'number' ||
    !Number.isInteger(report.schemaVersion) ||
    report.schemaVersion < 1
  ) {
    return { valid: false, error: 'fairness report: schemaVersion must be a positive integer' };
  }
  if (report.status !== 'proposed') {
    return { valid: false, error: 'fairness report: status must be proposed' };
  }
  if (typeof report.reportId !== 'string' || !ID_RE.test(report.reportId)) {
    return { valid: false, error: 'fairness report: reportId must be a closed lowercase identifier' };
  }
  if (typeof report.generatedAt !== 'string' || !RFC3339_UTC_RE.test(report.generatedAt)) {
    return { valid: false, error: 'fairness report: generatedAt must be UTC RFC 3339' };
  }
  if (typeof report.minimumN !== 'number' || !Number.isInteger(report.minimumN) || report.minimumN < 1) {
    return { valid: false, error: 'fairness report: minimumN must be a positive integer' };
  }
  if (typeof report.declaredCohorts !== 'number' || !Number.isInteger(report.declaredCohorts) || report.declaredCohorts < 0) {
    return { valid: false, error: 'fairness report: declaredCohorts must be a non-negative integer' };
  }
  if (typeof report.measuredCohorts !== 'number' || !Number.isInteger(report.measuredCohorts) || report.measuredCohorts < 0) {
    return { valid: false, error: 'fairness report: measuredCohorts must be a non-negative integer' };
  }
  if (!Array.isArray(report.excludedMembers) || report.excludedMembers.some((m) => typeof m !== 'string')) {
    return { valid: false, error: 'fairness report: excludedMembers must be a string array' };
  }

  // ── cohortCoverage ────────────────────────────────────────────────────
  if (!isPlainObject(report.cohortCoverage) || !hasOnlyKeys(report.cohortCoverage, COVERAGE_KEYS)) {
    return { valid: false, error: 'fairness report: cohortCoverage malformed' };
  }
  const coverage = report.cohortCoverage;
  if (coverage.state === 'insufficient_data') {
    if (coverage.value !== undefined) {
      return { valid: false, error: 'fairness report: insufficient_data coverage must not carry a value' };
    }
  } else if (coverage.state === 'measured') {
    if (typeof coverage.value !== 'number' || coverage.value < 0 || coverage.value > 1) {
      return { valid: false, error: 'fairness report: measured coverage value must be between 0 and 1' };
    }
  } else {
    return { valid: false, error: 'fairness report: coverage state not allowlisted' };
  }

  // ── meanScores / uncertainty ──────────────────────────────────────────
  for (const [field, label] of [
    ['meanScores', 'mean score'],
    ['uncertainty', 'uncertainty'],
  ] as const) {
    if (!Array.isArray(report[field])) {
      return { valid: false, error: `fairness report: ${label} must be an array` };
    }
    const seenCohorts = new Set<string>();
    for (const m of report[field] as unknown[]) {
      if (!isPlainObject(m) || !hasOnlyKeys(m, COHORT_METRIC_KEYS)) {
        return { valid: false, error: `fairness report: ${label} metric malformed` };
      }
      if (typeof m.cohortId !== 'string' || !ID_RE.test(m.cohortId)) {
        return { valid: false, error: `fairness report: ${label} cohortId must be a closed identifier` };
      }
      if (seenCohorts.has(m.cohortId)) {
        return { valid: false, error: `fairness report: ${label} duplicate cohort` };
      }
      seenCohorts.add(m.cohortId);
      if (typeof m.memberCount !== 'number' || !Number.isInteger(m.memberCount) || m.memberCount < 0) {
        return { valid: false, error: `fairness report: ${label} memberCount must be a non-negative integer` };
      }
      if (m.state === 'measured') {
        if (typeof m.value !== 'number' || m.value < 0 || m.value > 1) {
          return { valid: false, error: `fairness report: ${label} measured value must be between 0 and 1` };
        }
        if (m.reason !== undefined) {
          return { valid: false, error: `fairness report: ${label} measured metric must not carry a reason` };
        }
      } else if (m.state === 'suppressed') {
        if (m.value !== undefined || m.reason !== 'below_minimum_n') {
          return { valid: false, error: `fairness report: ${label} suppressed metric must have no value and reason below_minimum_n` };
        }
      } else if (m.state === 'insufficient_data') {
        if (m.value !== undefined || m.reason !== 'no_observations') {
          return { valid: false, error: `fairness report: ${label} insufficient_data metric must have no value and reason no_observations` };
        }
      } else {
        return { valid: false, error: `fairness report: ${label} state not allowlisted` };
      }
    }
  }

  // ── disparity (descriptive only) ──────────────────────────────────────
  if (!isPlainObject(report.disparity) || !hasOnlyKeys(report.disparity, DISPARITY_KEYS)) {
    return { valid: false, error: 'fairness report: disparity malformed' };
  }
  const disparity = report.disparity;
  if (disparity.role !== 'descriptive_only') {
    return { valid: false, error: 'fairness report: disparity must be descriptive_only, never an acceptance verdict' };
  }
  if (disparity.state === 'measured') {
    if (typeof disparity.value !== 'number' || disparity.value < 0 || disparity.value > 1) {
      return { valid: false, error: 'fairness report: measured disparity value must be between 0 and 1' };
    }
  } else if (disparity.state === 'insufficient_data') {
    if (disparity.value !== undefined) {
      return { valid: false, error: 'fairness report: insufficient_data disparity must not carry a value' };
    }
  } else {
    return { valid: false, error: 'fairness report: disparity state not allowlisted' };
  }
  if (typeof disparity.note !== 'string' || disparity.note.length === 0) {
    return { valid: false, error: 'fairness report: disparity note must be non-empty' };
  }

  // ── thresholds (all PROPOSED; fake approval control) ──────────────────
  if (!Array.isArray(report.thresholds) || report.thresholds.length === 0) {
    return { valid: false, error: 'fairness report: thresholds must be a non-empty array' };
  }
  for (const t of report.thresholds) {
    if (!isPlainObject(t)) {
      return { valid: false, error: 'fairness report: threshold must be a plain object' };
    }
    if (t.status === APPROVED) {
      return {
        valid: false,
        error:
          'fairness report: threshold approval requires authentic voluntary cohort approval; none exists in repository-only work',
      };
    }
    if (!hasOnlyKeys(t, THRESHOLD_KEYS) || t.status !== FAIRNESS_THRESHOLD_STATUS) {
      return { valid: false, error: 'fairness report: threshold status must be PROPOSED' };
    }
    if (typeof t.proposedValue !== 'number' || t.proposedValue < 0 || t.proposedValue > 1) {
      return { valid: false, error: 'fairness report: threshold proposedValue must be between 0 and 1' };
    }
    if (!(FAIRNESS_METRIC_IDS as readonly string[]).includes(t.metricId as string)) {
      return { valid: false, error: 'fairness report: threshold metricId not allowlisted' };
    }
  }

  // ── conclusion ────────────────────────────────────────────────────────
  if (!isPlainObject(report.conclusion) || !hasOnlyKeys(report.conclusion, CONCLUSION_KEYS)) {
    return { valid: false, error: 'fairness report: conclusion malformed' };
  }
  const conclusion = report.conclusion;
  if (conclusion.kind !== 'descriptive_only' && conclusion.kind !== 'insufficient_data') {
    return { valid: false, error: 'fairness report: conclusion kind not allowlisted' };
  }
  if (typeof conclusion.text !== 'string' || conclusion.text.length === 0) {
    return { valid: false, error: 'fairness report: conclusion text must be non-empty' };
  }

  return { valid: true };
}

// ── Deterministic digest (cohort fixture tamper detection) ──────────────

/** Deterministic canonical serialization (sorted keys, no insignificant whitespace). */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeCohortDigest(member: unknown): string {
  return createHash(FAIRNESS_DIGEST_ALGORITHM)
    .update(canonicalStringify(member), 'utf8')
    .digest('hex');
}
