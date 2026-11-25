/**
 * Dex's R1 scorecard as an Ashby feedback card (M034 S09, dark; D-S09-4, D-S09-6, D-S09-7).
 *
 * PURE. No I/O, no environment, no clock, no logger: every input is an argument, so the handler
 * (S09 T3) is the only place that reads the database or calls Ashby, and every rule here is proven
 * by plain unit tests.
 *
 * FOUR STEPS
 *  1. `r1MeetFeedbackSource(row)` reads the persisted v2 `assessments` row (the columns the handler
 *     selects, loosely typed because `metric_results` is jsonb and PostgREST may send a numeric as a
 *     string). It answers a frozen source or `{ refused }`:
 *       not_v2        `schema_version` is not 2;
 *       not_postable  the verdict COLUMN is not advance, hold or reject (`human_review` is stored as
 *                     NULL), the overall score is not a finite number, the M029 Overall value is null,
 *                     the weighted score is not in [1, scale], or not one metric scored (a
 *                     `scoring_failed` / `no_candidate_speech` placeholder). A value is never made up.
 *     A metric counts as scored only when `evidenceStatus === 'scored'` and its score is an integer on
 *     the row's scale. `evidence`, `evidenceRefs` and `raw` are never read, so a transcript quote can
 *     never reach the card.
 *  2. `r1MeetFeedbackSummary(source, profile)` writes the Summary text (D-S09-7): a header naming the
 *     booking's objective profile (its bot and its interview kind, so a later persona is never labelled
 *     as Dex's sales round), the verdict word and the coverage, then the NOT SCORED lines first (so the
 *     bound can never drop them), then the scored lines in rubric order. Every name and rationale is
 *     control-stripped and bounded; lines are kept whole up to 2000 characters. It names no candidate,
 *     no contact detail and no Meet URL.
 *  3. `bindR1MeetFeedbackForm(source, form, options)` binds the card onto the LIVE form definition
 *     (`feedbackFormDefinition.info`, structure only). It refuses, in this order:
 *       form_no_schema                 the read carried no field schema;
 *       form_mismatch                  the read is another form than the configured one (UUIDs
 *                                      compare without case), or two bound values would share one
 *                                      path;
 *       form_archived                  the form is archived;
 *       form_overall_missing           not exactly one field has the path `overall_recommendation`;
 *       form_overall_options_mismatch  that field is not a ValueSelect offering exactly "1".."4";
 *       form_summary_missing           no field titled `Summary`, or it has no path or a type that
 *                                      takes no text (RichText, LongText and String do);
 *       form_summary_ambiguous         two or more fields are titled `Summary`;
 *       form_required_field_unbound    a field the form marks required would stay empty.
 *     Optional fields: one Score field per SCORED metric whose title equals the metric name (the
 *     #275 title rule, `autobindScorecardDimensions`), bound only when its scale is exactly
 *     1..scale; and one Url field titled `Detailed report` (skipped when absent, duplicated, of
 *     another type, or when no safe https link exists). Nothing else is filled; no field is invented.
 *     Order: Overall, Summary, Detailed report, then the metrics in rubric order.
 *  4. `r1MeetFeedbackRequest(...)` builds the `applicationFeedback.submit` body with EXACTLY five
 *     keys: applicationId, formDefinitionId, feedbackForm { fieldSubmissions }, userId (the Dex Ashby
 *     user) and interviewEventId (the booking's event). With both ids Ashby UPDATES Dex's one
 *     submission for that event, so a retry can never post a second card (D-S09-1). No `extra`.
 *
 * This is NOT the phone-screen card: it shares only the generic helpers of the Ashby integration
 * (the M029 Overall mapping, the title binder, the https origin check), never that card's binding.
 */

import type { ProbeFeedbackForm, ProbeFormField } from '../../../integrations/ashby/probe.js';
import {
  dashboardOriginOf,
  overallRecommendationValue,
  stripLoneSurrogates,
  type AshbyOverallValue,
} from '../../../integrations/ashby/scorecard.js';
import {
  OVERALL_OPTION_VALUES,
  autobindScorecardDimensions,
  formFields,
  normalizeTitle,
} from '../../../integrations/ashby/scorecard-autobind.js';
import type { FeedbackSubmitRequest } from '../../../integrations/ashby/types.js';
import {
  SCORECARD_MAX_METRICS,
  SCORECARD_SCHEMA_VERSION,
  SCORE_MAX,
  isScoreOnScale,
  isScoreScaleMax,
  type ScoreScaleMax,
} from '../../scorecards/contracts.js';
import type { R1MeetObjectiveProfile } from './profiles.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** Text bounds and the stale guard (D-S09-5: a card is not posted later than 7 days after the slot). */
export const R1_MEET_FEEDBACK_LIMITS = Object.freeze({
  summaryMax: 2000,
  rationaleMax: 280,
  staleMs: 7 * 24 * 60 * 60 * 1000,
});

/** The Overall Recommendation field is found by its PATH, the same path the phone-screen form uses. */
export const R1_MEET_FEEDBACK_OVERALL_PATH = 'overall_recommendation';
/** The Summary field is found by its TITLE (normalized: case, punctuation and spacing ignored). */
export const R1_MEET_FEEDBACK_SUMMARY_TITLE = 'Summary';
/** The optional deep-link field, by title. */
export const R1_MEET_FEEDBACK_REPORT_TITLE = 'Detailed report';

/**
 * The Summary header's words for each interview kind a Meet objective profile can run. Typed over
 * every `interviewKind` of `profiles.ts`, so a new kind does not compile until it has its words.
 */
export const R1_MEET_FEEDBACK_KIND_LABELS: Readonly<Record<R1MeetObjectiveProfile['interviewKind'], string>> = Object.freeze({
  sales_r1: 'R1 sales role-play',
});

/** What the Summary header reads of the booking's objective profile (`getR1MeetProfile`). */
export type R1MeetFeedbackProfile = Pick<R1MeetObjectiveProfile, 'botDisplayName' | 'interviewKind'>;

/** The verdict words HR already reads on the dashboard and in the Ashby tags (M027). */
export const R1_MEET_VERDICT_WORDS = Object.freeze({
  advance: 'Select',
  hold: 'Borderline',
  reject: 'Reject',
} as const);

/** The closed refusals of the binder, in check order. */
export const R1_MEET_FEEDBACK_FORM_REFUSALS = Object.freeze([
  'form_no_schema',
  'form_mismatch',
  'form_archived',
  'form_overall_missing',
  'form_overall_options_mismatch',
  'form_summary_missing',
  'form_summary_ambiguous',
  'form_required_field_unbound',
] as const);

const OVERALL_FIELD_TYPE = 'ValueSelect';
const RICH_TEXT_FIELD_TYPE = 'RichText';
const PLAIN_TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(['LongText', 'String']);
const URL_FIELD_TYPE = 'Url';
const MAX_METRIC_NAME_LEN = 100;
const MAX_BOT_NAME_LEN = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A numeric column as PostgREST may send it: a JSON number, or a plain decimal string. */
const DECIMAL = /^-?\d{1,12}(?:\.\d{1,12})?$/;

// ── Types ───────────────────────────────────────────────────────────────────

export type R1MeetVerdict = keyof typeof R1_MEET_VERDICT_WORDS;
export type R1MeetFeedbackFormRefusal = (typeof R1_MEET_FEEDBACK_FORM_REFUSALS)[number];
export type R1MeetFeedbackSourceRefusal = 'not_v2' | 'not_postable';

/** The `assessments` columns the handler selects (never `raw`). Loosely typed: jsonb and numerics. */
export interface R1MeetAssessmentRow {
  readonly schema_version?: unknown;
  readonly recommendation?: unknown;
  readonly overall_score?: unknown;
  readonly weighted_score_5?: unknown;
  readonly score_scale_max?: unknown;
  readonly metric_results?: unknown;
}

export interface R1MeetFeedbackMetric {
  /** The configured metric key (`r1_probing_discovery`). */
  readonly key: string;
  /** The display name, control-stripped and bounded; the key when the row has none. */
  readonly name: string;
  /** The metric score on the row's scale, or null when it was not scored. */
  readonly score: number | null;
  /** The scorer's rationale, control-stripped and bounded to 280; '' when there is none. */
  readonly rationale: string;
}

export interface R1MeetFeedbackSource {
  readonly recommendation: R1MeetVerdict;
  /** The M029 Overall Recommendation value (`overallRecommendationValue`). */
  readonly overallValue: AshbyOverallValue;
  /** The weighted rubric score, in [1, scaleMax]. */
  readonly weighted: number;
  readonly scaleMax: ScoreScaleMax;
  /** Every metric of the row, in rubric order (the order the scorecard configured). */
  readonly metrics: readonly R1MeetFeedbackMetric[];
}

export type R1MeetFeedbackSourceResult = R1MeetFeedbackSource | { readonly refused: R1MeetFeedbackSourceRefusal };

export interface R1MeetFeedbackSubmission {
  readonly path: string;
  readonly value: unknown;
}

export type R1MeetFeedbackBinding =
  | {
      readonly ok: true;
      readonly fieldSubmissions: readonly R1MeetFeedbackSubmission[];
      /** Scored metrics bound to a Score field. */
      readonly metricsBound: number;
      /** Scored metrics left out (no field, an ambiguous title, another type or another scale). */
      readonly metricsUnbound: number;
    }
  | { readonly ok: false; readonly reason: R1MeetFeedbackFormRefusal };

export interface R1MeetFeedbackBindOptions {
  /** The configured form (`R1_MEET_ASHBY_FEEDBACK_FORM_ID`), compared as a UUID: case ignored. */
  readonly formDefinitionId: string;
  /** `r1MeetFeedbackReportUrl(...)`; null leaves the report field empty. */
  readonly reportUrl: string | null;
  /** `r1MeetFeedbackSummary(source, profile)`. */
  readonly summary: string;
}

export interface R1MeetFeedbackRequestInput {
  readonly applicationId: string;
  readonly formDefinitionId: string;
  readonly interviewEventId: string;
  readonly dexUserId: string;
  readonly fieldSubmissions: readonly R1MeetFeedbackSubmission[];
}

// ── 1. The source ───────────────────────────────────────────────────────────

/** True when `r1MeetFeedbackSource` refused the row. */
export function isR1MeetFeedbackRefused(
  result: R1MeetFeedbackSourceResult,
): result is { readonly refused: R1MeetFeedbackSourceRefusal } {
  return 'refused' in result;
}

/** Read the persisted v2 row into the card's source, or refuse (see the header). Never throws. */
export function r1MeetFeedbackSource(row: R1MeetAssessmentRow | null | undefined): R1MeetFeedbackSourceResult {
  if (!isRecord(row) || finiteNumber(row.schema_version) !== SCORECARD_SCHEMA_VERSION) return refused('not_v2');

  const recommendation = row.recommendation;
  if (recommendation !== 'advance' && recommendation !== 'hold' && recommendation !== 'reject') {
    return refused('not_postable');
  }
  const overallScore = finiteNumber(row.overall_score);
  const overallValue = overallRecommendationValue(recommendation, overallScore);
  if (overallValue === null) return refused('not_postable');

  // The row's own rubric scale (0093); absent or unknown = the current scale, as the v2 adapter does.
  const declaredScale = finiteNumber(row.score_scale_max);
  const scaleMax: ScoreScaleMax = isScoreScaleMax(declaredScale) ? declaredScale : SCORE_MAX;
  const weighted = finiteNumber(row.weighted_score_5);
  if (weighted === null || weighted < 1 || weighted > scaleMax) return refused('not_postable');

  const metrics: R1MeetFeedbackMetric[] = [];
  const seen = new Set<string>();
  const entries = Array.isArray(row.metric_results) ? row.metric_results : [];
  for (const raw of entries) {
    if (metrics.length >= SCORECARD_MAX_METRICS) break;
    if (!isRecord(raw)) continue;
    const metric = isRecord(raw.metric) ? raw.metric : null;
    const key = metric !== null && typeof metric.key === 'string' ? metric.key : '';
    if (key.length === 0 || key.length > MAX_METRIC_NAME_LEN || seen.has(key)) continue;
    seen.add(key);
    const named = metric !== null && typeof metric.name === 'string' ? boundedText(metric.name, MAX_METRIC_NAME_LEN) : '';
    const scored = raw.evidenceStatus === 'scored' && isScoreOnScale(raw.score, scaleMax);
    metrics.push(Object.freeze({
      key,
      name: named.length > 0 ? named : boundedText(key, MAX_METRIC_NAME_LEN),
      score: scored ? (raw.score as number) : null,
      rationale: typeof raw.rationale === 'string' ? boundedText(raw.rationale, R1_MEET_FEEDBACK_LIMITS.rationaleMax) : '',
    }));
  }
  // A weighted score with not one scored metric behind it is a row this card cannot explain.
  if (!metrics.some((metric) => metric.score !== null)) return refused('not_postable');

  return Object.freeze({
    recommendation,
    overallValue,
    weighted,
    scaleMax,
    metrics: Object.freeze(metrics),
  });
}

// ── 2. The Summary text ─────────────────────────────────────────────────────

/** The Summary field's text (D-S09-7). Pure; always at most `summaryMax` characters. */
export function r1MeetFeedbackSummary(source: R1MeetFeedbackSource, profile: R1MeetFeedbackProfile): string {
  const scaleMax = source.scaleMax;
  const total = source.metrics.length;
  const scoredCount = source.metrics.filter((metric) => metric.score !== null).length;
  const notScored = total - scoredCount;
  const coverage = `across ${scoredCount} of ${total} metric${total === 1 ? '' : 's'}`
    + (notScored > 0 ? `; ${notScored} not scored (listed below)` : '');
  const bot = boundedText(profile.botDisplayName, MAX_BOT_NAME_LEN);
  const kind = R1_MEET_FEEDBACK_KIND_LABELS[profile.interviewKind];
  const header = `${bot} (AI interviewer): ${kind} over Google Meet. `
    + `Verdict: ${R1_MEET_VERDICT_WORDS[source.recommendation]}. `
    + `Weighted ${formatWeighted(source.weighted)}/${scaleMax} ${coverage}.`;

  const unscoredLines: string[] = [];
  const scoredLines: string[] = [];
  for (const metric of source.metrics) {
    const name = boundedText(metric.name, MAX_METRIC_NAME_LEN) || boundedText(metric.key, MAX_METRIC_NAME_LEN);
    const rationale = boundedText(metric.rationale, R1_MEET_FEEDBACK_LIMITS.rationaleMax);
    const reason = rationale.length > 0 ? `: ${rationale}` : '';
    if (metric.score === null) unscoredLines.push(`${name} — NOT SCORED (insufficient evidence)${reason}`);
    else scoredLines.push(`${name} — ${metric.score}/${scaleMax}${reason}`);
  }

  // Whole lines only: a rationale is never cut mid-sentence by the total bound.
  let out = header.slice(0, R1_MEET_FEEDBACK_LIMITS.summaryMax);
  for (const line of [...unscoredLines, ...scoredLines]) {
    const next = `${out}\n${line}`;
    if (next.length > R1_MEET_FEEDBACK_LIMITS.summaryMax) break;
    out = next;
  }
  return out;
}

// ── The deep link ───────────────────────────────────────────────────────────

/**
 * `<https origin of the Meet bridge page>/interviews/<round uuid>`: the R1 review page of the round
 * (the web app hosts both pages). Null when the origin is not a plain https origin or the round id is
 * not a UUID; the report field then stays empty. Never throws.
 */
export function r1MeetFeedbackReportUrl(bridgePageUrl: unknown, roundId: unknown): string | null {
  if (typeof roundId !== 'string' || !UUID.test(roundId)) return null;
  if (typeof bridgePageUrl !== 'string') return null;
  let origin: string;
  try {
    origin = new URL(bridgePageUrl).origin;
  } catch {
    return null;
  }
  const safe = dashboardOriginOf(origin);
  return safe === null ? null : `${safe}/interviews/${roundId.toLowerCase()}`;
}

// ── 3. Binding onto the live form ───────────────────────────────────────────

/** Bind the card onto the live form definition, or refuse with a closed reason (see the header). */
export function bindR1MeetFeedbackForm(
  source: R1MeetFeedbackSource,
  form: ProbeFeedbackForm,
  options: R1MeetFeedbackBindOptions,
): R1MeetFeedbackBinding {
  if (form.schemaAvailable !== true) return refuse('form_no_schema');
  if (!sameUuid(form.formDefinitionId, options.formDefinitionId)) return refuse('form_mismatch');
  if (form.archived === true) return refuse('form_archived');

  const fields = formFields(form);

  const overallFields = fields.filter((field) => field.path === R1_MEET_FEEDBACK_OVERALL_PATH);
  if (overallFields.length !== 1) return refuse('form_overall_missing');
  const overall = overallFields[0] as ProbeFormField;
  if (overall.type !== OVERALL_FIELD_TYPE || !offersExactlyOverallValues(overall)) {
    return refuse('form_overall_options_mismatch');
  }

  const summaryFields = fieldsTitled(fields, R1_MEET_FEEDBACK_SUMMARY_TITLE);
  if (summaryFields.length === 0) return refuse('form_summary_missing');
  if (summaryFields.length > 1) return refuse('form_summary_ambiguous');
  const summaryField = summaryFields[0] as ProbeFormField;
  const summaryPath = summaryField.path;
  const summaryIsRich = summaryField.type === RICH_TEXT_FIELD_TYPE;
  const summaryIsPlain = summaryField.type !== null && PLAIN_TEXT_FIELD_TYPES.has(summaryField.type);
  if (!summaryPath || (!summaryIsRich && !summaryIsPlain)) return refuse('form_summary_missing');

  const submissions: R1MeetFeedbackSubmission[] = [];
  const used = new Set<string>();
  // One field, one value: a second value for a path is undefined provider behaviour, so the whole
  // card is refused rather than one value silently dropped.
  const add = (path: string, value: unknown): boolean => {
    if (used.has(path)) return false;
    used.add(path);
    submissions.push(Object.freeze({ path, value }));
    return true;
  };

  // Ashby ValueSelect fields take the stored option value as a string.
  add(R1_MEET_FEEDBACK_OVERALL_PATH, String(source.overallValue));
  const summaryValue = summaryIsRich ? Object.freeze({ type: 'PlainText', value: options.summary }) : options.summary;
  if (!add(summaryPath, summaryValue)) return refuse('form_mismatch');

  const reportUrl = safeReportUrl(options.reportUrl);
  if (reportUrl !== null) {
    const reportFields = fieldsTitled(fields, R1_MEET_FEEDBACK_REPORT_TITLE);
    const reportField = reportFields.length === 1 ? (reportFields[0] as ProbeFormField) : null;
    if (reportField !== null && reportField.type === URL_FIELD_TYPE && reportField.path) {
      if (!add(reportField.path, reportUrl)) return refuse('form_mismatch');
    }
  }

  // Only SCORED metrics are offered to the title binder: an unscored metric is never bound.
  const scored = source.metrics.filter((metric) => metric.score !== null);
  const matches = new Map(
    autobindScorecardDimensions(form, scored.map((metric) => ({ key: metric.key, name: metric.name })))
      .matched.map((match) => [match.key, match] as const),
  );
  let metricsBound = 0;
  let metricsUnbound = 0;
  for (const metric of scored) {
    // The binder already requires exactly one field with that title, of type Score, with a path.
    const match = matches.get(metric.key);
    if (match === undefined || match.scale.min !== 1 || match.scale.max !== source.scaleMax) {
      metricsUnbound += 1;
      continue;
    }
    if (!add(match.fieldPath, Object.freeze({ score: metric.score }))) return refuse('form_mismatch');
    metricsBound += 1;
  }

  for (const field of fields) {
    if (field.required === true && (!field.path || !used.has(field.path))) {
      return refuse('form_required_field_unbound');
    }
  }

  return Object.freeze({
    ok: true as const,
    fieldSubmissions: Object.freeze(submissions),
    metricsBound,
    metricsUnbound,
  });
}

// ── 4. The request ──────────────────────────────────────────────────────────

/**
 * The `applicationFeedback.submit` body: EXACTLY applicationId, formDefinitionId, feedbackForm
 * { fieldSubmissions }, userId and interviewEventId, never `extra` (the client spreads `extra` after
 * its validated fields, so it could otherwise carry anything).
 */
export function r1MeetFeedbackRequest(input: R1MeetFeedbackRequestInput): FeedbackSubmitRequest {
  return {
    applicationId: input.applicationId,
    formDefinitionId: input.formDefinitionId,
    feedbackForm: {
      fieldSubmissions: input.fieldSubmissions.map((submission) => ({ path: submission.path, value: submission.value })),
    },
    userId: input.dexUserId,
    interviewEventId: input.interviewEventId,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function refused(reason: R1MeetFeedbackSourceRefusal): { readonly refused: R1MeetFeedbackSourceRefusal } {
  return Object.freeze({ refused: reason });
}

/** Two UUIDs name the same form whatever their case (Ashby answers lower case; a pasted id may not be). */
function sameUuid(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && UUID.test(a) && a.toLowerCase() === b.toLowerCase();
}

function refuse(reason: R1MeetFeedbackFormRefusal): { readonly ok: false; readonly reason: R1MeetFeedbackFormRefusal } {
  return Object.freeze({ ok: false as const, reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite JSON number, or a plain decimal string (a PostgREST numeric); anything else is null. */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && DECIMAL.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Strip control characters, drop lone surrogate halves, collapse whitespace, bound (with an
 * ellipsis). A copy of `cleanText` in `integrations/ashby/scorecard-v2-adapter.ts`, which is not
 * exported; idempotent on its own output.
 */
function boundedText(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? ' ' : ch;
  }
  out = stripLoneSurrogates(out).replace(/\s+/g, ' ').trim();
  return out.length > max ? `${stripLoneSurrogates(out.slice(0, max - 1)).trimEnd()}…` : out;
}

/** At most two decimals, as the dashboard shows the weighted score. */
function formatWeighted(weighted: number): string {
  return String(Math.round(weighted * 100) / 100);
}

function fieldsTitled(fields: readonly ProbeFormField[], title: string): ProbeFormField[] {
  const wanted = normalizeTitle(title);
  return fields.filter((field) => normalizeTitle(field.title) === wanted);
}

/** The Overall field offers EXACTLY the values "1".."4", each once (labels are not read). */
function offersExactlyOverallValues(field: ProbeFormField): boolean {
  if (field.optionsTruncated) return false;
  const values = field.options.map((option) => option.value);
  if (values.length !== OVERALL_OPTION_VALUES.length) return false;
  const offered = new Set(values);
  return offered.size === OVERALL_OPTION_VALUES.length && OVERALL_OPTION_VALUES.every((value) => offered.has(value));
}

/** Only an absolute https URL may enter a Url field; anything else leaves the field empty. */
function safeReportUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
