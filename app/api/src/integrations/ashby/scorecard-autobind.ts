/**
 * ashby/scorecard-autobind.ts — bind a role's scorecard METRICS to a tenant
 * feedback form's Score FIELDS by name, at write time, from the form's own
 * definition.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * The v1 binding (`HELLO_CHRISTY_SCORECARD_BINDING`) is a hand-verified table
 * of dimension key → field id. That is the right shape for the FIXED fields
 * (overall recommendation, Summary, Red flags, Detailed report): they never
 * change. It is the wrong shape for v2 metrics, which are configured per role
 * in the dashboard and can be added at any time — every new metric would need
 * a form field AND a code change, and forgetting the second half silently
 * dropped the metric from the Ashby card.
 *
 * Owner decision (2026-09-10, issue #275): bind by NAME. The rule for the form
 * is one sentence — "for every metric a role can score, the form has a Score
 * field whose title equals the metric's name" — and adding a metric then needs
 * no code at all.
 *
 * ── FAIL-CLOSED, ALWAYS ────────────────────────────────────────────────────
 * A metric binds only when EXACTLY ONE field carries its normalised title AND
 * that field is a Score field. Anything else — no field, two fields with the
 * same title, a String/RichText field with the right title — leaves the
 * metric UNMATCHED and it is omitted from the submission (`bindFeedbackForm`
 * already skips dimensions with no path). Nothing is ever guessed onto a
 * field, and the fixed fields are never auto-bound: they stay on the verified
 * static binding. The result also names every unmatched metric and why, so
 * Mission Control can show a recruiter the title they need to fix.
 *
 * Pure and DB-free; the form schema arrives from the read-only probe.
 */

import type { ProbeFeedbackForm, ProbeFormField } from './probe.js';
import type { ScorecardFormBinding, ScorecardScale } from './scorecard.js';

/** The Ashby input type of a rating field. Only these may carry a dimension. */
export const SCORE_FIELD_TYPE = 'Score';

/** The scale assumed for a Score field whose definition exposes no options. */
export const DEFAULT_SCORE_SCALE: ScorecardScale = { min: 1, max: 4 };

/** Why a metric did not bind. Stable codes — safe to display and log. */
export type AutobindMissReason =
  | 'no_field'           // no field title equals the metric name
  | 'ambiguous_title'    // two or more fields share the title
  | 'ambiguous_metric'   // two or more metrics claim the same field
  | 'not_score_type'     // the matching field is not a Score field
  | 'no_path';           // the field has no submission path

export interface MetricToBind {
  /** Stable metric key (`profile_relevance`). */
  key: string;
  /** Display name shown in the dashboard (`Profile relevance`). */
  name: string;
}

/**
 * The derived résumé-vs-role signal (`role_fit.score`, 0–10, written by the v2
 * integrity pass #282) that the owner keeps on the Ashby form as the v1 `Role
 * fit` Score field. It is not a dashboard metric, so it is appended explicitly
 * — by the adapter as a dimension and by the preview as a row — and binds by
 * title exactly like one.
 */
export const ROLE_FIT_DIMENSION: MetricToBind = { key: 'role_fit', name: 'Role fit' };

/** The metrics a v2 write binds: the role's metrics plus the derived Role fit. */
export function withRoleFit(metrics: readonly MetricToBind[]): MetricToBind[] {
  return metrics.some((m) => m.key === ROLE_FIT_DIMENSION.key)
    ? [...metrics]
    : [...metrics, ROLE_FIT_DIMENSION];
}

export interface AutobindMatch {
  key: string;
  name: string;
  fieldId: string;
  fieldPath: string;
  fieldTitle: string;
  scale: ScorecardScale;
}

export interface AutobindMiss {
  key: string;
  name: string;
  reason: AutobindMissReason;
}

export interface AutobindResult {
  matched: AutobindMatch[];
  unmatched: AutobindMiss[];
  /** Score fields on the form that no metric claimed (informational). */
  unusedScoreFields: Array<{ fieldId: string; title: string | null }>;
}

/**
 * Normalise a title or metric name for comparison: Unicode NFKC, lower-case,
 * punctuation and separators collapsed to single spaces, trimmed. So
 * "Night-shift fit", "night shift fit" and "Night_Shift  Fit" are one name,
 * while "Stability" and "Stability (resume)" are two.
 */
export function normalizeTitle(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const normalized = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  // Both sides are bounded before they get here — a metric name at 100 chars,
  // a form title at 120 — so compare on the SHORTER bound; otherwise two
  // identical long names would never match each other.
  return normalized.length > MAX_COMPARABLE_TITLE_LEN
    ? normalized.slice(0, MAX_COMPARABLE_TITLE_LEN).trim()
    : normalized;
}

/** The metric-name bound (`SCORECARD_MAX_NAME_LENGTH`), the shorter of the two. */
const MAX_COMPARABLE_TITLE_LEN = 100;

/**
 * A Score field's scale, read from its selectable values when the definition
 * exposes them (Ashby lists one option per scale point), else the default.
 * Options that are not small positive integers, or fewer than two of them,
 * fall back to the default rather than inventing a scale.
 */
export function scoreScaleOf(field: ProbeFormField): ScorecardScale {
  const values: number[] = [];
  for (const option of field.options) {
    // Only a plain run of digits is a scale point. `Number()` alone would read
    // an empty string as 0 and invent a zero-based scale, and Ashby Score
    // fields start at 1.
    const raw = (typeof option.value === 'string' && option.value.trim().length > 0)
      ? option.value.trim()
      : (typeof option.label === 'string' ? option.label.trim() : '');
    if (!/^\d{1,2}$/.test(raw)) return DEFAULT_SCORE_SCALE;
    values.push(Number(raw));
  }
  if (values.length < 2) return DEFAULT_SCORE_SCALE;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A Score field is 1-based; anything else is a shape this binder does not
  // understand, so fall back to the verified default rather than guess.
  if (min !== 1 || max <= min || max > 10) return DEFAULT_SCORE_SCALE;
  return { min, max };
}

/** Every field of a discovered form, flattened. */
export function formFields(form: ProbeFeedbackForm): ProbeFormField[] {
  return form.sections.flatMap((s) => s.fields);
}

/**
 * Match metrics to fields by normalised title. Deterministic; the same form
 * and metric list always give the same result.
 */
export function autobindScorecardDimensions(
  form: ProbeFeedbackForm,
  metrics: readonly MetricToBind[],
): AutobindResult {
  const fields = formFields(form);
  const byTitle = new Map<string, ProbeFormField[]>();
  for (const f of fields) {
    const key = normalizeTitle(f.title);
    if (key === '') continue;
    const list = byTitle.get(key);
    if (list) list.push(f); else byTitle.set(key, [f]);
  }

  const matched: AutobindMatch[] = [];
  const unmatched: AutobindMiss[] = [];
  const claimed = new Set<string>();
  const seenKeys = new Set<string>();

  for (const metric of metrics) {
    if (seenKeys.has(metric.key)) continue; // a duplicate metric key binds once
    seenKeys.add(metric.key);
    const candidates = byTitle.get(normalizeTitle(metric.name)) ?? [];
    if (candidates.length === 0) { unmatched.push({ key: metric.key, name: metric.name, reason: 'no_field' }); continue; }
    if (candidates.length > 1) { unmatched.push({ key: metric.key, name: metric.name, reason: 'ambiguous_title' }); continue; }
    const field = candidates[0];
    if (field.type !== SCORE_FIELD_TYPE) { unmatched.push({ key: metric.key, name: metric.name, reason: 'not_score_type' }); continue; }
    if (!field.path) { unmatched.push({ key: metric.key, name: metric.name, reason: 'no_path' }); continue; }
    claimed.add(field.id);
    matched.push({
      key: metric.key,
      name: metric.name,
      fieldId: field.id,
      fieldPath: field.path,
      fieldTitle: field.title ?? '',
      scale: scoreScaleOf(field),
    });
  }

  // TWO metrics can carry the same display name (the database enforces unique
  // metric KEYS, not names) — and the derived "Role fit" signal rides beside
  // them. Both would then claim the same field and the submission would carry
  // two values for one path: undefined provider behaviour, and one score
  // silently overwriting the other on a card that cannot be rewritten. Neither
  // binds; both are reported so the recruiter can rename one.
  const claimants = new Map<string, AutobindMatch[]>();
  for (const m of matched) {
    const list = claimants.get(m.fieldId);
    if (list) list.push(m); else claimants.set(m.fieldId, [m]);
  }
  const contested = new Set<string>();
  for (const [fieldId, list] of claimants) {
    if (list.length > 1) {
      contested.add(fieldId);
      for (const m of list) unmatched.push({ key: m.key, name: m.name, reason: 'ambiguous_metric' });
    }
  }
  const finalMatched = matched.filter((m) => !contested.has(m.fieldId));
  for (const fieldId of contested) claimed.delete(fieldId);

  const unusedScoreFields = fields
    .filter((f) => f.type === SCORE_FIELD_TYPE && !claimed.has(f.id))
    .map((f) => ({ fieldId: f.id, title: f.title }));

  return { matched: finalMatched, unmatched, unusedScoreFields };
}

/**
 * Compose the binding the worker submits with: the FIXED fields from the
 * verified static binding (never auto-bound), plus the auto-bound dimension
 * paths and their per-field scales. The static binding's own v1 dimension
 * table is NOT carried over — a v2 submission binds only what the form's
 * definition matched, so a stale v1 id can never receive a v2 score.
 *
 * Refuses (returns `null`) when the form the definition describes is not the
 * form the static binding was verified against: two different forms sharing
 * a field title is exactly the confusion a fail-closed binder must not permit.
 */
export function composeAutoboundBinding(
  base: ScorecardFormBinding,
  form: ProbeFeedbackForm,
  autobind: AutobindResult,
): ScorecardFormBinding | null {
  if (!formIsVerifiedBindingTarget(base, form)) return null;
  // The four FIXED fields are hand-verified, but a recruiter can still delete
  // or retype one. When the definition read carries a field schema, check them
  // against the LIVE form and refuse rather than submitting a value into a
  // field that is gone or has changed shape — the same fail-closed promise the
  // Mission Control preview makes. `fieldTypes` is rebuilt from the live types
  // so `bindFeedbackForm`'s own type gate stays the single enforcement point.
  const liveTypes = form.schemaAvailable ? fixedFieldTypes(base, form) : null;
  if (liveTypes === null && form.schemaAvailable) return null;
  const dimensions: Record<string, string> = {};
  const dimensionFieldIds: Record<string, string> = {};
  const dimensionScales: Record<string, ScorecardScale> = {};
  for (const m of autobind.matched) {
    dimensions[m.key] = m.fieldPath;
    dimensionFieldIds[m.key] = m.fieldId;
    dimensionScales[m.key] = m.scale;
  }
  return {
    ...base,
    dimensionFieldIds,
    fieldPaths: base.fieldPaths
      ? { ...base.fieldPaths, dimensions }
      : undefined,
    ...(liveTypes ? { fieldTypes: liveTypes } : {}),
    dimensionScales,
  };
}

/** The form is the one the static binding was verified against, and usable. */
export function formIsVerifiedBindingTarget(base: ScorecardFormBinding, form: ProbeFeedbackForm): boolean {
  return Boolean(base.verified) && Boolean(base.formDefinitionId)
    && form.formDefinitionId === base.formDefinitionId
    && form.archived !== true;
}

/**
 * The live Ashby types of the optional fixed fields, or `null` when a declared
 * fixed field is MISSING from the form (a deleted field must fail closed, not
 * submit into a path the form no longer has). A retyped field is returned with
 * its new type so `bindFeedbackForm` refuses with `binding_field_type_mismatch`.
 */
function fixedFieldTypes(
  base: ScorecardFormBinding,
  form: ProbeFeedbackForm,
): NonNullable<ScorecardFormBinding['fieldTypes']> | null {
  const byPath = new Map<string, ProbeFormField>();
  for (const f of formFields(form)) if (f.path && !byPath.has(f.path)) byPath.set(f.path, f);
  const paths = base.fieldPaths;
  for (const required of [paths?.overall, paths?.summary]) {
    if (required && !byPath.has(required)) return null;
  }
  const out: NonNullable<ScorecardFormBinding['fieldTypes']> = {};
  for (const [name, path] of [['redFlags', paths?.redFlags], ['detailedReport', paths?.detailedReport]] as const) {
    if (!path) continue;
    const field = byPath.get(path);
    if (!field) return null;
    // An unreadable type is left to the verified default rather than guessed.
    if (typeof field.type === 'string' && field.type.length > 0) out[name] = field.type;
  }
  return out;
}

// ── Mission Control preview ─────────────────────────────────────────────────

/** One of the four hand-verified fields the static binding submits. */
export type FixedFieldName = 'overall' | 'summary' | 'redFlags' | 'detailedReport';

export interface FixedFieldCheck {
  name: FixedFieldName;
  /** The verified submission path the worker will use. */
  path: string;
  /** Type the binding expects, when it declares one. */
  expectedType: string | null;
  /** Whether a field with that path exists on the live form, and with what type. */
  status: 'present' | 'missing' | 'type_mismatch';
  actualType: string | null;
}

export interface MetricBindingPreviewRow {
  key: string;
  name: string;
  status: 'bound' | AutobindMissReason;
  fieldPath: string | null;
  scale: ScorecardScale | null;
}

export interface ScorecardBindingPreview {
  formDefinitionId: string;
  formTitle: string | null;
  /** False when the definition read carried no field schema — not "no fields". */
  schemaAvailable: boolean;
  archived: boolean;
  /** The form matches the verified static binding (id, not archived). */
  formMatchesBinding: boolean;
  fixedFields: FixedFieldCheck[];
  metrics: MetricBindingPreviewRow[];
  unusedScoreFields: Array<{ fieldId: string; title: string | null }>;
  /**
   * True only when the form is the verified one, every fixed field is present
   * with the expected type, and EVERY metric bound. A false here means a v2
   * card would submit with metrics omitted (or not at all).
   */
  ready: boolean;
}

/**
 * What a v2 write WOULD do against this form, for a recruiter to read before
 * a candidate is ever scored. Pure: same inputs as the worker, no I/O, and it
 * carries structure only — field paths, titles, types, scales — never a
 * submitted value or candidate datum.
 */
export function previewScorecardBinding(
  base: ScorecardFormBinding,
  form: ProbeFeedbackForm,
  metrics: readonly MetricToBind[],
): ScorecardBindingPreview {
  const fields = formFields(form);
  const byPath = new Map<string, ProbeFormField>();
  for (const f of fields) if (f.path && !byPath.has(f.path)) byPath.set(f.path, f);

  const fixedFields: FixedFieldCheck[] = [];
  const paths = base.fieldPaths;
  const fixedSpec: Array<[FixedFieldName, string | undefined, string | null]> = [
    ['overall', paths?.overall, null],
    ['summary', paths?.summary, 'RichText'],
    ['redFlags', paths?.redFlags, base.fieldTypes?.redFlags ?? null],
    ['detailedReport', paths?.detailedReport, base.fieldTypes?.detailedReport ?? null],
  ];
  for (const [name, path, expectedType] of fixedSpec) {
    if (!path) continue;
    const field = form.schemaAvailable ? byPath.get(path) : undefined;
    const actualType = field?.type ?? null;
    const status: FixedFieldCheck['status'] = !field
      ? 'missing'
      : expectedType && actualType !== expectedType
        ? 'type_mismatch'
        : 'present';
    fixedFields.push({ name, path, expectedType, status, actualType });
  }

  const auto = autobindScorecardDimensions(form, metrics);
  const rows: MetricBindingPreviewRow[] = [];
  const matchedByKey = new Map(auto.matched.map((m) => [m.key, m]));
  const missByKey = new Map(auto.unmatched.map((u) => [u.key, u]));
  const seen = new Set<string>();
  for (const m of metrics) {
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    const hit = matchedByKey.get(m.key);
    if (hit) { rows.push({ key: m.key, name: m.name, status: 'bound', fieldPath: hit.fieldPath, scale: hit.scale }); continue; }
    const miss = missByKey.get(m.key);
    rows.push({ key: m.key, name: m.name, status: miss?.reason ?? 'no_field', fieldPath: null, scale: null });
  }

  // Identity only — "is this the verified form?" A missing or retyped FIXED
  // field is reported per-field above, not folded into this flag.
  const formMatchesBinding = formIsVerifiedBindingTarget(base, form);
  const ready =
    formMatchesBinding &&
    form.schemaAvailable &&
    fixedFields.every((f) => f.status === 'present') &&
    rows.length > 0 &&
    rows.every((r) => r.status === 'bound');

  return {
    formDefinitionId: form.formDefinitionId,
    formTitle: form.title,
    schemaAvailable: form.schemaAvailable,
    archived: form.archived === true,
    formMatchesBinding,
    fixedFields,
    metrics: rows,
    unusedScoreFields: auto.unusedScoreFields,
    ready,
  };
}
