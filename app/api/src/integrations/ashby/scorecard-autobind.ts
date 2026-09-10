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
  | 'no_field'          // no field title equals the metric name
  | 'ambiguous_title'   // two or more fields share the title
  | 'not_score_type'    // the matching field is not a Score field
  | 'no_path';          // the field has no submission path

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
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A Score field's scale, read from its selectable values when the definition
 * exposes them (Ashby lists one option per scale point), else the default.
 * Options that are not small positive integers, or fewer than two of them,
 * fall back to the default rather than inventing a scale.
 */
export function scoreScaleOf(field: ProbeFormField): ScorecardScale {
  const values = field.options
    .map((o) => Number(o.value ?? o.label))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 10);
  if (values.length < 2) return DEFAULT_SCORE_SCALE;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min || max - min > 9) return DEFAULT_SCORE_SCALE;
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

  const unusedScoreFields = fields
    .filter((f) => f.type === SCORE_FIELD_TYPE && !claimed.has(f.id))
    .map((f) => ({ fieldId: f.id, title: f.title }));

  return { matched, unmatched, unusedScoreFields };
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
  if (!base.verified || !base.formDefinitionId) return null;
  if (form.formDefinitionId !== base.formDefinitionId) return null;
  if (form.archived === true) return null;
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
    dimensionScales,
  };
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

  const formMatchesBinding = composeAutoboundBinding(base, form, auto) !== null;
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
