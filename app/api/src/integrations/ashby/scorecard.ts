/**
 * ashby/scorecard.ts — deterministic, bounded, redaction-safe mapping from an
 * internal screening assessment to an Ashby scorecard payload.
 *
 * Pure and DB-free (mirrors integration-schema.ts): the saga layer adapts a
 * persisted assessment into a {@link ScorecardSource} and hands the mapped
 * payload to the Ashby client. This module NEVER emits a raw model response,
 * chain-of-thought, full transcript, recording bytes/URL, or a bearer/presigned
 * URL — only the existing numeric dimensions, the current scale, an
 * informational recommendation, a bounded summary, provenance, bounded red
 * flags taken only from the persisted `role_fit.red_flags` array, and an
 * internal review deep link composed solely from the server's validated
 * dashboard origin plus the canonical scoped review path. It also fails CLOSED
 * when the tenant form binding is unverified, when that origin cannot be
 * trusted, or when the review path is not the canonical scoped one — rather
 * than inventing an Ashby field id or degrading the deep link.
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
   * Relative internal review path (e.g. '/ashby/review/<applicationLinkId>',
   * built by {@link ashbyReviewPath}). MUST be a
   * site-relative path — never an absolute URL, so no bearer/presigned link can
   * ride along in the scorecard.
   */
  reviewPath: string;
  /**
   * Raw `role_fit.red_flags` entries from the PERSISTED assessment, in the
   * order they were scored. This is the ONLY accepted red-flag source: the
   * saga reads exactly `role_fit.red_flags` and never an arbitrary provider or
   * user payload key. Entries are normalized and bounded by
   * {@link normalizeRedFlags} before they reach the provider.
   */
  redFlags?: readonly unknown[];
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
/** Red flags bounds — per item, per count, and over the rendered total. */
export const MAX_RED_FLAG_ITEMS = 12;
export const MAX_RED_FLAG_ITEM_LEN = 200;
export const MAX_RED_FLAGS_TOTAL_LEN = 1500;
/** Bound on an accepted dashboard origin string (defence in depth). */
const MAX_DASHBOARD_ORIGIN_LEN = 255;
/** The exact value submitted when no red flag survives normalization. */
export const NO_RED_FLAGS_TEXT = 'None identified';
/** How each normalized red flag is rendered into the Ashby `String` field. */
const RED_FLAG_BULLET = '- ';

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
  /**
   * Normalized, ordered, bounded red flags. Derived ONLY from the persisted
   * `role_fit.red_flags` array; an empty list renders as
   * {@link NO_RED_FLAGS_TEXT}.
   */
  redFlags: string[];
}

/** Remove UTF-16 surrogate halves that have no partner. */
function stripLoneSurrogates(value: string): string {
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/**
 * Normalize the persisted `role_fit.red_flags` array into ordered, bounded,
 * control-character-free text items.
 *
 * Deliberately total and defensive: a non-array, a non-string entry, an entry
 * that is only whitespace/control bytes, or an over-long list can never widen
 * what reaches the ATS. Order is preserved because a recruiter reads the list
 * as the assessment scored it. The cumulative bound is applied against the
 * RENDERED length, so {@link renderRedFlags} can never exceed
 * {@link MAX_RED_FLAGS_TOTAL_LEN} and no item is ever cut mid-way.
 */
export function normalizeRedFlags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  let rendered = 0;
  for (const entry of input) {
    if (out.length >= MAX_RED_FLAG_ITEMS) break;
    if (typeof entry !== 'string') continue;
    // Strip C0/C1 controls and DEL (newlines included: one flag is one line),
    // then collapse the resulting whitespace runs.
    let cleaned = '';
    for (let i = 0; i < entry.length; i++) {
      const c = entry.charCodeAt(i);
      cleaned += c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) ? ' ' : entry[i];
    }
    // Lone surrogates are not text. Drop them before collapsing whitespace so
    // removing one cannot leave a double space behind.
    cleaned = stripLoneSurrogates(cleaned).replace(/\s+/g, ' ').trim();
    if (cleaned.length === 0) continue;
    if (cleaned.length > MAX_RED_FLAG_ITEM_LEN) {
      // Truncation counts UTF-16 code units, so a cut can land inside a
      // surrogate pair; strip the orphaned half the cut just created.
      cleaned = stripLoneSurrogates(cleaned.slice(0, MAX_RED_FLAG_ITEM_LEN)).trim();
    }
    if (cleaned.length === 0) continue;
    // '- ' prefix, plus a '\n' separator for every item after the first.
    const cost = RED_FLAG_BULLET.length + cleaned.length + (out.length === 0 ? 0 : 1);
    if (rendered + cost > MAX_RED_FLAGS_TOTAL_LEN) break;
    rendered += cost;
    out.push(cleaned);
  }
  return out;
}

/**
 * Render normalized red flags into the exact value submitted to the Ashby
 * `String` field. An empty list is submitted as exactly
 * {@link NO_RED_FLAGS_TEXT} — never an empty string, so a recruiter can tell
 * "screened, nothing found" from "never screened".
 */
export function renderRedFlags(redFlags: readonly string[]): string {
  if (!Array.isArray(redFlags) || redFlags.length === 0) return NO_RED_FLAGS_TEXT;
  const text = redFlags.map((f) => `${RED_FLAG_BULLET}${f}`).join('\n');
  return text.length === 0 ? NO_RED_FLAGS_TEXT : text.slice(0, MAX_RED_FLAGS_TOTAL_LEN);
}

/**
 * Canonicalize a configured dashboard origin into a bare `https://host[:port]`
 * origin, or `null` when it cannot be trusted.
 *
 * Fails closed on anything that is not a plain HTTPS origin: `http:` (the ATS
 * link must not be downgradeable), userinfo (`https://user:pw@host`, a classic
 * spoofed-host vector), a path/query/fragment (an open-redirect input), and any
 * unparseable or over-long value. The caller MUST refuse to submit any Ashby
 * feedback when this returns `null` — a relative path may never enter a `Url`
 * field.
 */
export function dashboardOriginOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_DASHBOARD_ORIGIN_LEN) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.pathname !== '/') return null;
  if (parsed.search.length > 0 || parsed.hash.length > 0) return null;
  if (parsed.hostname.length === 0) return null;
  return parsed.origin;
}

/**
 * True iff `p` is EXACTLY the canonical scoped review path
 * `/ashby/review/<uuid>`. Nothing else may be composed into the `Detailed
 * report` `Url` field: not a legacy `/sessions/<id>` path, not an absolute URL,
 * not a path carrying a query/fragment/traversal, and not a non-UUID id (which
 * is what an external Ashby id or an email would look like).
 */
export function isScopedReviewPath(p: unknown): boolean {
  if (typeof p !== 'string' || !isRelativeReviewPath(p)) return false;
  return /^\/ashby\/review\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(p);
}

/**
 * Compose the bare absolute HTTPS deep link submitted to `Detailed report`.
 * Built ONLY from a validated server origin plus the canonical scoped review
 * path, so it carries no PII, token, query, fragment, userinfo, external Ashby
 * id, or open-redirect input. Returns `null` (fail closed) otherwise.
 */
export function detailedReportUrl(dashboardOrigin: unknown, reviewPath: unknown): string | null {
  const origin = dashboardOriginOf(dashboardOrigin);
  if (origin === null) return null;
  if (!isScopedReviewPath(reviewPath)) return null;
  const composed = `${origin}${reviewPath as string}`;
  // Re-parse the composed value: it must round-trip byte-identically as a bare
  // HTTPS URL with no credentials, query, or fragment.
  let url: URL;
  try { url = new URL(composed); } catch { return null; }
  if (url.href !== composed) return null;
  if (url.protocol !== 'https:') return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  return composed;
}

/**
 * The canonical relative deep link for a scorecard's review experience: the
 * candidate-scoped Ashby review page, addressed ONLY by the opaque application
 * link id. It never carries a candidate id, a session id, an email, or a token,
 * and it is always site-relative so no bearer/presigned URL can ride along.
 *
 * Both scorecard builders (enqueue-time and execute-time) MUST derive the path
 * through this helper: the idempotency marker hashes the review path, so the
 * two sites drifting apart would make the executed payload's marker disagree
 * with the enqueued operation_key.
 */
export function ashbyReviewPath(applicationLinkId: string): string {
  return `/ashby/review/${encodeURIComponent(applicationLinkId)}`;
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
    redFlags: normalizeRedFlags(source.redFlags),
  };

  // Deterministic idempotency marker over the ASSESSMENT CONTENT only (no
  // wall-clock, and deliberately NOT the review path): the deep link is
  // presentation, so re-shaping it must never look like new content and
  // re-trigger a provider write. Normalized red flags ARE assessment content
  // and are hashed under a NEW key `f` — deliberately, so the marker keeps
  // describing what was scored rather than a subset of it. This is safe
  // because it cannot widen what gets written: link-scoped idempotency (at
  // most one scorecard_write per application link, across every historical
  // marker version) is enforced by a marker-INDEPENDENT admission read plus a
  // link-derived `operation_key` unique constraint — see
  // `enqueueScorecardWrite` in workflow-stores.ts and `enqueueScorecard` in
  // orchestration.ts. A changed red-flag list therefore changes the marker and
  // still enqueues nothing.
  const marker = createHash('sha256')
    .update(
      JSON.stringify({
        v: scorecard.scaleValue,
        r: scorecard.recommendation,
        d: scorecard.dimensions,
        s: scorecard.summary,
        m: provenance.model ?? '',
        f: scorecard.redFlags,
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
  /** Map of internal dimension key → Ashby field id (display/audit metadata). */
  dimensionFieldIds?: Record<string, string>;
  /** Ashby submit payload keys; the API uses field paths, not definition ids. */
  fieldPaths?: {
    overall: string;
    summary: string;
    dimensions: Record<string, string>;
    /** Verified submission path of the optional `Red flags` String field. */
    redFlags?: string;
    /** Verified submission path of the optional `Detailed report` Url field. */
    detailedReport?: string;
  };
  /**
   * Explicit expected Ashby field types, as read from the tenant's official
   * `feedbackFormDefinition.info`. Declared so a future form edit that changes
   * a field's type is a fail-closed binding error rather than a silently
   * mis-typed submission: a `Url` field takes a bare URL string, a `String`
   * field takes a bare string, and only `RichText` takes a PlainText envelope.
   */
  fieldTypes?: { redFlags?: string; detailedReport?: string };
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
  fieldPaths: {
    overall: 'overall_recommendation',
    summary: 'b5778d87-0be5-4ca3-8727-88dc8dd6eba0',
    dimensions: {
      english: '46ee47b9-71a7-42bd-844c-c279c0e8bebf',
      tone: 'bba47eac-b0f4-43c2-a931-d1fe00a24d03',
      communication: 'ee3ca034-ea9c-451a-85de-1e22b1bce180',
      motivation: '6d8d9ff3-43c9-44e5-bba3-d3ae4dce0eef',
      role_fit: 'd1220462-1d8a-43b9-a56f-c5635cdd5e2f',
    },
    // Verified 2026-08-21 from the tenant's official feedbackFormDefinition.info
    // for form 1c9a92c0-c18f-4bf1-898f-c29e71d7d303. Both fields are optional
    // on the form; no submitted values were read.
    redFlags: 'a9127af9-fc4d-474d-b3ce-95c57052e840',
    detailedReport: '81b04084-d7a0-40f1-9d30-7eccaa62798d',
  },
  fieldTypes: { redFlags: 'String', detailedReport: 'Url' },
  dimensionScale: { min: 1, max: 4 },
};

export type BoundFeedbackForm =
  | { ok: true; formDefinitionId: string; feedbackForm: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | 'binding_unverified'
        | 'binding_incomplete'
        | 'binding_field_type_mismatch'
        | 'dashboard_origin_invalid'
        | 'invalid_review_path';
    };

function mapDimensionToScale(score: number, scale: ScorecardScale): number {
  const min = Math.round(scale.min);
  const max = Math.round(scale.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return min;
  const pct = clampNum(score, 0, 10) / 10;
  return min + Math.min(max - min, Math.floor(pct * (max - min + 1)));
}

/**
 * Bind a normalized scorecard to concrete Ashby feedback-form field paths.
 *
 * Fail-closed order matters and is deliberate:
 *   1. an unverified / incomplete / mis-typed binding never invents a shape;
 *   2. the dashboard deep link is composed BEFORE any field is emitted, so a
 *      dashboard origin we cannot trust (missing, `http:`, userinfo-bearing,
 *      pathful, unparseable) or a review path that is not the canonical
 *      `/ashby/review/<uuid>` refuses the WHOLE binding. The caller then
 *      submits no Ashby feedback at all, rather than a scorecard whose only
 *      clickable destination is missing or, worse, a relative path smuggled
 *      into a `Url` field.
 *
 * The Summary field deliberately no longer carries the dashboard URL: the
 * clickable destination lives ONLY in `Detailed report`.
 */
export function bindFeedbackForm(
  scorecard: NormalizedScorecard,
  binding: ScorecardFormBinding,
  dashboardOrigin = '',
): BoundFeedbackForm {
  if (!binding.verified) return { ok: false, reason: 'binding_unverified' };
  if (!binding.formDefinitionId || !binding.overallFieldId || !binding.summaryFieldId) {
    return { ok: false, reason: 'binding_incomplete' };
  }
  const paths = binding.fieldPaths;
  const overallKey = paths?.overall ?? binding.overallFieldId;
  const summaryKey = paths?.summary ?? binding.summaryFieldId;
  if (!overallKey || !summaryKey) return { ok: false, reason: 'binding_incomplete' };
  // Explicit verified types only. A form edit that retyped either extended
  // field must break loudly here, never submit a wrongly-shaped value.
  if (paths?.redFlags && (binding.fieldTypes?.redFlags ?? 'String') !== 'String') {
    return { ok: false, reason: 'binding_field_type_mismatch' };
  }
  if (paths?.detailedReport && (binding.fieldTypes?.detailedReport ?? 'Url') !== 'Url') {
    return { ok: false, reason: 'binding_field_type_mismatch' };
  }
  // Compose the deep link first: it gates the entire submission.
  if (!isScopedReviewPath(scorecard.reviewPath)) return { ok: false, reason: 'invalid_review_path' };
  const reportUrl = detailedReportUrl(dashboardOrigin, scorecard.reviewPath);
  if (reportUrl === null) return { ok: false, reason: 'dashboard_origin_invalid' };

  const fieldSubmissions: Array<{ path: string; value: unknown }> = [
    // Ashby ValueSelect fields accept the stored option value as a string.
    { path: overallKey, value: String(scorecard.scaleValue) },
    // Ashby accepts PlainText objects for RichText fields via the public API.
    // The approved summary text only — no raw dashboard URL, no link label.
    { path: summaryKey, value: { type: 'PlainText', value: scorecard.summary } },
  ];
  // Ashby `String` fields take a bare string; `Url` fields take a bare, valid
  // absolute URL string. Neither takes a PlainText envelope.
  if (paths?.redFlags) {
    fieldSubmissions.push({ path: paths.redFlags, value: renderRedFlags(scorecard.redFlags) });
  }
  if (paths?.detailedReport) {
    fieldSubmissions.push({ path: paths.detailedReport, value: reportUrl });
  }
  const dimKeys = paths?.dimensions ?? binding.dimensionFieldIds ?? {};
  const dimensionScale = binding.dimensionScale ?? { min: 1, max: 4 };
  for (const d of scorecard.dimensions) {
    const fieldKey = dimKeys[d.key];
    if (typeof fieldKey === 'string' && fieldKey.length > 0) {
      fieldSubmissions.push({ path: fieldKey, value: { score: mapDimensionToScale(d.score, dimensionScale) } });
    }
  }
  const feedbackForm: Record<string, unknown> = { fieldSubmissions };
  return { ok: true, formDefinitionId: binding.formDefinitionId, feedbackForm };
}
