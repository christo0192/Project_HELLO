/**
 * ashby/scorecard.ts — deterministic, bounded, redaction-safe mapping from an
 * internal screening assessment to an Ashby scorecard payload.
 *
 * Pure and DB-free (mirrors integration-schema.ts): the saga layer adapts a
 * persisted assessment into a {@link ScorecardSource} and hands the mapped
 * payload to the Ashby client. This module NEVER emits a raw model response,
 * chain-of-thought, full transcript, recording bytes/URL, or a bearer/presigned
 * URL — only the existing numeric dimensions, the current scale, an
 * informational recommendation, a bounded summary, provenance, and a relative
 * internal review deep-link path. It also fails CLOSED when the tenant form
 * binding is unverified, rather than inventing Ashby field ids.
 *
 * Determinism: given the same source + config the payload and its idempotency
 * marker are byte-identical, so "write the scorecard only if no matching marker
 * exists" is a stable, reproducible check.
 */

import { createHash } from 'node:crypto';

/** Informational recommendation — NEVER drives an auto-reject/stage decision. */
export const RECOMMENDATIONS = ['advance', 'hold', 'reject'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** One normalized 0–10 dimension score carried into the scorecard. */
export interface ScorecardDimension {
  /** Stable internal dimension key (e.g. 'communication'). */
  key: string;
  /** Raw 0–10 dimension score. */
  score: number;
}

/** Bounded, PII-light view the saga extracts from a persisted assessment. */
export interface ScorecardSource {
  /** Opaque Ashby application id used only as the provider request identity. */
  externalApplicationId?: string;
  /** Overall 0–100 score. */
  overallScore: number;
  /** Informational recommendation. */
  recommendation: Recommendation;
  /** Existing dimension scores (0–10). */
  dimensions: readonly ScorecardDimension[];
  /** Bounded human-readable summary (already free of raw model text). */
  summary: string;
  /** Immutable scoring provenance (model id / scored-at / version) — no secrets. */
  provenance: { model?: string; scoredAt?: string; version?: string };
  /**
   * Relative internal review path (e.g. '/review/sessions/<id>'). MUST be a
   * site-relative path — never an absolute URL, so no bearer/presigned link can
   * ride along in the scorecard.
   */
  reviewPath: string;
}

/** The configured target scale for the overall score on the Ashby scorecard. */
export interface ScorecardScale {
  /** Inclusive minimum bucket value (e.g. 1). */
  min: number;
  /** Inclusive maximum bucket value (e.g. 4). */
  max: number;
}

/** Bounds. */
const MAX_SUMMARY_LEN = 2000;
const MAX_DIMENSIONS = 32;
const MAX_REVIEW_PATH_LEN = 512;

/**
 * Field name fragments that must NEVER appear in scorecard source/config —
 * raw model output, chain-of-thought, full transcript, recording, or any
 * bearer/presigned URL. Case-insensitive substring match on each key.
 */
export const FORBIDDEN_SCORECARD_KEY_FRAGMENTS: readonly string[] = [
  'transcript', 'recording', 'audio', 'raw_model', 'rawmodel', 'raw_response',
  'rawresponse', 'chain_of_thought', 'chainofthought', 'cot', 'reasoning',
  'bearer', 'signed_url', 'signedurl', 'presigned', 'token', 'secret',
];

function collectForbidden(value: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (value === null || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...collectForbidden(v, `${path}[${i}]`)));
    return hits;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_SCORECARD_KEY_FRAGMENTS.some((f) => lower.includes(f))) hits.push(`${path}.${key}`);
    hits.push(...collectForbidden(v, `${path}.${key}`));
  }
  return hits;
}

/** True iff the value carries no raw-model/transcript/recording/bearer keys. */
export function isScorecardSafe(value: unknown): boolean {
  return collectForbidden(value).length === 0;
}

function clampNum(n: unknown, min: number, max: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

/**
 * Deterministically bucket a 0–100 overall score into the configured scale.
 * Uses evenly-sized bands so the mapping is reproducible and explainable.
 */
export function mapOverallToScale(overallScore: number, scale: ScorecardScale): number {
  const min = Math.round(scale.min);
  const max = Math.round(scale.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return min;
  const pct = clampNum(overallScore, 0, 100) / 100;
  const buckets = max - min + 1;
  // Map [0,1] into [0, buckets-1]; the top score only at exactly 100-ish band.
  const idx = Math.min(buckets - 1, Math.floor(pct * buckets));
  return min + idx;
}

export type ScorecardBuild =
  | { ok: true; scorecard: NormalizedScorecard; marker: string }
  | { ok: false; reason: 'unsafe_source' | 'invalid_review_path' | 'empty_summary' | 'no_dimensions' };

/** The normalized, transport-ready scorecard (before tenant field binding). */
export interface NormalizedScorecard {
  provider: 'ashby';
  scaleValue: number;
  scale: ScorecardScale;
  recommendation: Recommendation;
  dimensions: { key: string; score: number }[];
  summary: string;
  reviewPath: string;
  provenance: { model?: string; scoredAt?: string; version?: string };
}

/** True iff `p` is a safe site-relative path (leading '/', no scheme/host/userinfo). */
export function isRelativeReviewPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_REVIEW_PATH_LEN) return false;
  if (!p.startsWith('/') || p.startsWith('//')) return false; // no protocol-relative
  if (/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return false; // no scheme
  if (p.includes('@') || p.includes('\\')) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/**
 * Build the normalized, redaction-safe scorecard + a deterministic idempotency
 * marker. Fails closed on any unsafe field, an absolute/invalid review path, an
 * empty summary, or no dimensions.
 */
export function buildScorecard(source: ScorecardSource, scale: ScorecardScale): ScorecardBuild {
  if (!isScorecardSafe(source)) return { ok: false, reason: 'unsafe_source' };
  if (!isRelativeReviewPath(source.reviewPath)) return { ok: false, reason: 'invalid_review_path' };

  const summary = typeof source.summary === 'string' ? source.summary.trim().slice(0, MAX_SUMMARY_LEN) : '';
  if (summary.length === 0) return { ok: false, reason: 'empty_summary' };

  const dims = (source.dimensions ?? [])
    .filter((d) => d && typeof d.key === 'string' && d.key.length > 0)
    .slice(0, MAX_DIMENSIONS)
    .map((d) => ({ key: d.key, score: Math.round(clampNum(d.score, 0, 10) * 100) / 100 }));
  if (dims.length === 0) return { ok: false, reason: 'no_dimensions' };

  const recommendation: Recommendation = RECOMMENDATIONS.includes(source.recommendation)
    ? source.recommendation
    : 'hold';

  const scaleValue = mapOverallToScale(source.overallScore, scale);
  const provenance = {
    model: typeof source.provenance?.model === 'string' ? source.provenance.model : undefined,
    scoredAt: typeof source.provenance?.scoredAt === 'string' ? source.provenance.scoredAt : undefined,
    version: typeof source.provenance?.version === 'string' ? source.provenance.version : undefined,
  };

  const scorecard: NormalizedScorecard = {
    provider: 'ashby',
    scaleValue,
    scale: { min: Math.round(scale.min), max: Math.round(scale.max) },
    recommendation,
    dimensions: dims,
    summary,
    reviewPath: source.reviewPath,
    provenance,
  };

  // Deterministic idempotency marker over the stable content (no wall-clock).
  const marker = createHash('sha256')
    .update(
      JSON.stringify({
        v: scorecard.scaleValue,
        r: scorecard.recommendation,
        d: scorecard.dimensions,
        s: scorecard.summary,
        p: scorecard.reviewPath,
        m: provenance.model ?? '',
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return { ok: true, scorecard, marker };
}

// ── Tenant form binding (fails closed until a probe verifies field ids) ──────

/**
 * A verified per-tenant binding from internal dimension keys to Ashby feedback
 * form field ids. Absent/incomplete → we DO NOT invent field ids; the saga
 * models the write as blocked and surfaces it in Mission Control instead.
 */
export interface ScorecardFormBinding {
  /** Whether this binding has been verified by an approved tenant probe. */
  verified: boolean;
  /** Ashby feedback form definition id. */
  formDefinitionId?: string;
  /** Field id for the overall ValueSelect field. */
  overallFieldId?: string;
  /** Field id for the RichText summary field. */
  summaryFieldId?: string;
  /** Map of internal dimension key → Ashby Score field id. */
  dimensionFieldIds?: Record<string, string>;
  /** Verified Ashby Score scale for dimension fields. */
  dimensionScale?: ScorecardScale;
}

/** The approved synthetic Hello Christy tenant binding. */
export const HELLO_CHRISTY_SCORECARD_BINDING: ScorecardFormBinding = {
  verified: true,
  formDefinitionId: '1c9a92c0-c18f-4bf1-898f-c29e71d7d303',
  overallFieldId: '666cedf5-cbd2-4d51-8e53-213e73fd536f',
  summaryFieldId: '1a943e2f-c1ec-4960-9179-b97ce376392a',
  dimensionFieldIds: {
    english: '8a057bef-b7c6-4193-9e47-611c01d5d910',
    tone: 'cfd97e91-928d-49b1-8924-f928dc2bdada',
    communication: '2dd40f54-2e2a-4879-ad4e-e43c2a24902f',
    motivation: 'f25d443d-0c0e-49ab-9d82-e472e0f1c28b',
    role_fit: '8604e59e-5147-4c39-b33f-4dffc8e10c1d',
  },
  dimensionScale: { min: 1, max: 4 },
};

export type BoundFeedbackForm =
  | { ok: true; formDefinitionId: string; feedbackForm: Record<string, unknown> }
  | { ok: false; reason: 'binding_unverified' | 'binding_incomplete' };

/**
 * Bind a normalized scorecard to concrete Ashby feedback-form field ids using a
 * VERIFIED tenant binding. Fails closed when the binding is unverified or is
 * missing the form/overall/summary ids — never fabricating an Ashby endpoint
 * shape. Unmapped dimensions are omitted (not guessed).
 */
function mapDimensionToScale(score: number, scale: ScorecardScale): number {
  const min = Math.round(scale.min);
  const max = Math.round(scale.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return min;
  const pct = clampNum(score, 0, 10) / 10;
  return min + Math.min(max - min, Math.floor(pct * (max - min + 1)));
}

function dashboardSummary(scorecard: NormalizedScorecard, dashboardOrigin: string): string {
  // The review path was validated as site-relative before reaching this point.
  // The origin is supplied from the server's validated WEB_ORIGIN allowlist;
  // reject anything else rather than placing an attacker-controlled URL in ATS.
  let origin = '';
  try {
    const parsed = new URL(dashboardOrigin);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && parsed.pathname === '/') {
      origin = parsed.origin;
    }
  } catch { /* fail closed to the relative path */ }
  return `${scorecard.summary}\n\nDetailed Project_HELLO scorecard: ${origin}${scorecard.reviewPath}`.slice(0, MAX_SUMMARY_LEN);
}

export function bindFeedbackForm(
  scorecard: NormalizedScorecard,
  binding: ScorecardFormBinding,
  dashboardOrigin = '',
): BoundFeedbackForm {
  if (!binding.verified) return { ok: false, reason: 'binding_unverified' };
  if (!binding.formDefinitionId || !binding.overallFieldId || !binding.summaryFieldId) {
    return { ok: false, reason: 'binding_incomplete' };
  }
  const feedbackForm: Record<string, unknown> = {
    // Ashby ValueSelect fields accept the stored option value as a string.
    [binding.overallFieldId]: String(scorecard.scaleValue),
    // Ashby accepts PlainText objects for RichText fields via the public API.
    [binding.summaryFieldId]: { type: 'PlainText', value: dashboardSummary(scorecard, dashboardOrigin) },
  };
  const dimIds = binding.dimensionFieldIds ?? {};
  const dimensionScale = binding.dimensionScale ?? { min: 1, max: 4 };
  for (const d of scorecard.dimensions) {
    const fieldId = dimIds[d.key];
    if (typeof fieldId === 'string' && fieldId.length > 0) {
      feedbackForm[fieldId] = { score: mapDimensionToScale(d.score, dimensionScale) };
    }
  }
  return { ok: true, formDefinitionId: binding.formDefinitionId, feedbackForm };
}
