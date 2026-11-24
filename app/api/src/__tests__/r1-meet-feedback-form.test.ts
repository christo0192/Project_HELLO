/**
 * M034 S09 T2: Dex's R1 scorecard mapped onto the live Ashby feedback form (`lib/r1/meet/feedback-form.ts`).
 *
 * - The source: the M029 Overall mapping (reject 1, hold below 50 is 2, hold at 50 or above is 3,
 *   advance 4); `human_review`, placeholders, v1 rows, non-numeric overalls and out-of-range weighted
 *   scores are refused; a metric counts only when scored on the row's scale; `evidence`,
 *   `evidenceRefs` and `raw` are never read (getters that throw prove it).
 * - The Summary: header wording, NOT SCORED lines first, the 280 and 2000 bounds on whole lines,
 *   control characters and lone surrogates stripped, no evidence quote, no old persona name.
 * - The binding: the exact fieldSubmissions of the happy path with the five R1 metric titles; every
 *   refusal in its check order; scale and type rules of the Score fields; the optional report link.
 * - The request: exactly five keys, and none of the PII sentinels planted in the fixture row.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProbeFeedbackForm, ProbeFormField } from '../integrations/ashby/probe.js';
import { R1_METRICS } from '../lib/r1/rubric.js';
import {
  R1_MEET_FEEDBACK_FORM_REFUSALS,
  R1_MEET_FEEDBACK_LIMITS,
  R1_MEET_FEEDBACK_OVERALL_PATH,
  R1_MEET_FEEDBACK_REPORT_TITLE,
  R1_MEET_FEEDBACK_SUMMARY_TITLE,
  R1_MEET_VERDICT_WORDS,
  bindR1MeetFeedbackForm,
  isR1MeetFeedbackRefused,
  r1MeetFeedbackReportUrl,
  r1MeetFeedbackRequest,
  r1MeetFeedbackSource,
  r1MeetFeedbackSummary,
  type R1MeetFeedbackSource,
} from '../lib/r1/meet/feedback-form.js';

const SRC = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

// ── Fixture ids (the harness namespace) ─────────────────────────────────────

const FORM_ID = '7f000000-0000-4000-8000-00000000f001';
const ROUND_ID = '7f000000-0000-4000-8000-000000000301';
const APPLICATION_ID = '7f000000-0000-4000-8000-000000000401';
const EVENT_ID = '7f000000-0000-4000-8000-000000000501';
const DEX_USER_ID = '7f000000-0000-4000-8000-000000000601';
const BRIDGE_PAGE_URL = 'https://hello.example.test/candidate/r1/meet';
const REPORT_URL = `https://hello.example.test/interviews/${ROUND_ID}`;

/** Planted in every place of the row the card must never read. */
const PII = Object.freeze({
  name: 'Zeta Sentinelcandidate',
  email: 'zeta.sentinel@example.test',
  phone: '+91 90000 11111',
  meetUrl: 'https://meet.google.com/sen-tine-lzz',
  quote: 'SENTINEL-QUOTE I would only pay seven thousand',
});

const RATIONALES = [
  'Asked four open questions before the first pitch.',
  'Answered the price objection with prep-guide facts.',
  'Tied urgency to the stated career goal.',
  'Held value before a conditional discount.',
  'Clear and polite; talk share inside the band.',
] as const;

function metricResult(index: number, score: number | null, rationale: string, status?: string): Record<string, unknown> {
  const metric = R1_METRICS[index]!;
  return {
    configMetricId: `7f000000-0000-4000-8000-00000000070${index}`,
    metric: { key: metric.key, name: metric.name, weightBps: metric.weightBps },
    score,
    evidenceStatus: status ?? (score === null ? 'insufficient_evidence' : 'scored'),
    rationale,
    evidenceRefs: [`turn 4: "${PII.quote}" (${PII.name})`],
    evidence: [{ turn_index: 4, quote: `${PII.quote} ${PII.email} ${PII.phone}` }],
  };
}

/** A scored R1 row: 4,3,3,3,3 over weights 25/25/15/15/20 = 3.25/4 = 75 overall = advance. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7f000000-0000-4000-8000-000000000201',
    session_id: '7f000000-0000-4000-8000-000000000101',
    schema_version: 2,
    recommendation: 'advance',
    overall_score: 75,
    weighted_score_5: 3.25,
    score_scale_max: 4,
    scoring_status: 'complete',
    metric_results: [4, 3, 3, 3, 3].map((score, i) => metricResult(i, score, RATIONALES[i]!)),
    raw: { transcript: PII.quote, candidate: { name: PII.name, email: PII.email, phone: PII.phone }, meetUrl: PII.meetUrl },
    candidate_name: PII.name,
    meeting_url: PII.meetUrl,
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}): R1MeetFeedbackSource {
  const result = r1MeetFeedbackSource(row(overrides));
  if (isR1MeetFeedbackRefused(result)) throw new Error(`fixture refused: ${result.refused}`);
  return result;
}

function field(id: string, over: Partial<ProbeFormField>): ProbeFormField {
  return { id, title: null, path: null, type: null, required: null, options: [], optionsTruncated: false, ...over };
}
const options = (values: readonly string[]) => values.map((value) => ({ value, label: `Option ${value}` }));
const FOUR = ['1', '2', '3', '4'] as const;

const OVERALL = field('fld-overall', {
  title: 'Overall Recommendation', path: 'overall_recommendation', type: 'ValueSelect', required: true, options: options(FOUR),
});
const SUMMARY = field('fld-summary', { title: 'Summary', path: 'summary_path', type: 'RichText', required: true });
const REPORT = field('fld-report', { title: 'Detailed report', path: 'report_path', type: 'Url', required: false });
const METRIC_FIELDS = R1_METRICS.map((metric, i) =>
  field(`fld-metric-${i}`, { title: metric.name, path: `metric_path_${i}`, type: 'Score', required: false, options: options(FOUR) }),
);
const ALL_FIELDS: readonly ProbeFormField[] = [OVERALL, SUMMARY, REPORT, ...METRIC_FIELDS];

function form(fields: readonly ProbeFormField[] = ALL_FIELDS, over: Partial<ProbeFeedbackForm> = {}): ProbeFeedbackForm {
  return {
    formDefinitionId: FORM_ID,
    title: 'Dex R1 interview',
    interviewId: null,
    interviewTitle: null,
    stageId: null,
    stageTitle: null,
    sections: [{ id: 'sec-1', title: 'Scorecard', fields: [...fields] }],
    fieldCount: fields.length,
    schemaAvailable: true,
    ...over,
  };
}

/** The fields with one replaced (by id) or added. */
function withField(replacement: ProbeFormField, base: readonly ProbeFormField[] = ALL_FIELDS): ProbeFormField[] {
  const found = base.some((f) => f.id === replacement.id);
  return found ? base.map((f) => (f.id === replacement.id ? replacement : f)) : [...base, replacement];
}
function without(id: string, base: readonly ProbeFormField[] = ALL_FIELDS): ProbeFormField[] {
  return base.filter((f) => f.id !== id);
}

function bind(f: ProbeFeedbackForm = form(), src: R1MeetFeedbackSource = source(), reportUrl: string | null = REPORT_URL) {
  return bindR1MeetFeedbackForm(src, f, { formDefinitionId: FORM_ID, reportUrl, summary: r1MeetFeedbackSummary(src) });
}

const HAPPY_SUMMARY = [
  'Dex (AI interviewer): R1 sales role-play over Google Meet. Verdict: Select. Weighted 3.25/4 across 5 of 5 metrics.',
  'Probing & discovery — 4/4: Asked four open questions before the first pitch.',
  'Objection handling — 3/4: Answered the price objection with prep-guide facts.',
  'Urgency & close — 3/4: Tied urgency to the stated career goal.',
  'Negotiation & discount discipline — 3/4: Held value before a conditional discount.',
  'Communication & rapport — 3/4: Clear and polite; talk share inside the band.',
].join('\n');

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  it('pins the limits, the field anchors and the verdict words, all frozen', () => {
    expect(R1_MEET_FEEDBACK_LIMITS).toStrictEqual({ summaryMax: 2000, rationaleMax: 280, staleMs: 604_800_000 });
    expect(R1_MEET_FEEDBACK_OVERALL_PATH).toBe('overall_recommendation');
    expect(R1_MEET_FEEDBACK_SUMMARY_TITLE).toBe('Summary');
    expect(R1_MEET_FEEDBACK_REPORT_TITLE).toBe('Detailed report');
    expect(R1_MEET_VERDICT_WORDS).toStrictEqual({ advance: 'Select', hold: 'Borderline', reject: 'Reject' });
    expect([...R1_MEET_FEEDBACK_FORM_REFUSALS]).toEqual([
      'form_no_schema', 'form_mismatch', 'form_archived', 'form_overall_missing', 'form_overall_options_mismatch',
      'form_summary_missing', 'form_summary_ambiguous', 'form_required_field_unbound',
    ]);
    for (const value of [R1_MEET_FEEDBACK_LIMITS, R1_MEET_VERDICT_WORDS, R1_MEET_FEEDBACK_FORM_REFUSALS]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});

// ── The source ──────────────────────────────────────────────────────────────

describe('r1MeetFeedbackSource: the Overall value (M029)', () => {
  it.each([
    ['advance', 75, 4],
    ['hold', 49, 2],
    ['hold', 49.99, 2],
    ['hold', 50, 3],
    ['hold', 64, 3],
    ['reject', 30, 1],
  ] as const)('%s at %s maps to %s, and the binding writes it as a string', (recommendation, overall, value) => {
    const src = source({ recommendation, overall_score: overall });
    expect(src.overallValue).toBe(value);
    expect(src.recommendation).toBe(recommendation);
    const bound = bind(form(), src);
    expect(bound.ok && bound.fieldSubmissions[0]).toStrictEqual({ path: 'overall_recommendation', value: String(value) });
  });

  it('reads a numeric column sent as a decimal string', () => {
    expect(source({ overall_score: '75' }).overallValue).toBe(4);
    expect(source({ recommendation: 'hold', overall_score: '49.5' }).overallValue).toBe(2);
    expect(source({ weighted_score_5: '3.25', schema_version: '2' }).weighted).toBe(3.25);
  });

  it('answers a frozen source in rubric order', () => {
    const src = source();
    expect(src).toStrictEqual({
      recommendation: 'advance',
      overallValue: 4,
      weighted: 3.25,
      scaleMax: 4,
      metrics: R1_METRICS.map((metric, i) => ({
        key: metric.key, name: metric.name, score: [4, 3, 3, 3, 3][i], rationale: RATIONALES[i],
      })),
    });
    expect(Object.isFrozen(src)).toBe(true);
    expect(Object.isFrozen(src.metrics)).toBe(true);
    expect(Object.isFrozen(src.metrics[0])).toBe(true);
  });
});

describe('r1MeetFeedbackSource: refusals', () => {
  it.each([
    ['a v1 row', { schema_version: 1 }],
    ['no schema version', { schema_version: null }],
    ['a non-numeric schema version', { schema_version: '2a' }],
    ['an array schema version', { schema_version: [2] }],
  ])('%s is not_v2', (_label, overrides) => {
    expect(r1MeetFeedbackSource(row(overrides))).toStrictEqual({ refused: 'not_v2' });
  });

  it('a missing row is not_v2', () => {
    expect(r1MeetFeedbackSource(null)).toStrictEqual({ refused: 'not_v2' });
    expect(r1MeetFeedbackSource(undefined)).toStrictEqual({ refused: 'not_v2' });
  });

  const placeholderMetrics = R1_METRICS.map((_, i) =>
    metricResult(i, null, 'R1 scoring could not be completed (scoring_failed); human review is required.'));

  it.each([
    ['human_review (the column stores NULL)', { recommendation: null, overall_score: null, weighted_score_5: null }],
    ['the human_review word itself', { recommendation: 'human_review' }],
    ['an unknown verdict', { recommendation: 'Select' }],
    ['a scoring_failed placeholder', { recommendation: null, overall_score: null, weighted_score_5: null, metric_results: placeholderMetrics }],
    ['a placeholder that somehow carries a verdict', { weighted_score_5: null, metric_results: placeholderMetrics }],
    ['a null overall', { overall_score: null }],
    ['a non-numeric string overall', { overall_score: 'seventy' }],
    ['an empty string overall', { overall_score: '' }],
    ['a NaN overall', { overall_score: Number.NaN }],
    ['an infinite overall', { overall_score: Number.POSITIVE_INFINITY }],
    ['a weighted score below 1', { weighted_score_5: 0.5 }],
    ['a weighted score above the scale', { weighted_score_5: 4.5 }],
    ['a weighted score of 5 on the 4-point scale', { weighted_score_5: 5 }],
    ['no metric results', { metric_results: [] }],
    ['metric results that are not an array', { metric_results: { a: 1 } }],
    ['not one scored metric', { metric_results: placeholderMetrics }],
  ])('%s is not_postable', (_label, overrides) => {
    expect(r1MeetFeedbackSource(row(overrides))).toStrictEqual({ refused: 'not_postable' });
  });
});

describe('r1MeetFeedbackSource: metrics', () => {
  it('counts a metric only when scored, an integer, and on the row scale', () => {
    const src = source({
      metric_results: [
        metricResult(0, 4, 'ok'),
        metricResult(1, 5, 'five on a four-point row'),
        metricResult(2, 0, 'zero'),
        metricResult(3, 2.5, 'half'),
        metricResult(4, 3, 'insufficient but numeric', 'insufficient_evidence'),
        { ...metricResult(0, 3, 'duplicate key, ignored'), configMetricId: 'dup' },
        { ...metricResult(1, 3, 'string score'), metric: { key: 'string_score', name: 'String score' }, score: '3' },
      ],
    });
    expect(src.metrics.map((m) => [m.key, m.score])).toEqual([
      [R1_METRICS[0]!.key, 4],
      [R1_METRICS[1]!.key, null],
      [R1_METRICS[2]!.key, null],
      [R1_METRICS[3]!.key, null],
      [R1_METRICS[4]!.key, null],
      ['string_score', null],
    ]);
  });

  it('honours a five-point row and falls back to the current scale for an unknown one', () => {
    const five = source({ score_scale_max: 5, weighted_score_5: 4.5, metric_results: [metricResult(0, 5, 'top')] });
    expect(five.scaleMax).toBe(5);
    expect(five.metrics[0]!.score).toBe(5);
    const odd = source({ score_scale_max: 7, metric_results: [metricResult(0, 4, 'top'), metricResult(1, 5, 'off scale')] });
    expect(odd.scaleMax).toBe(4);
    expect(odd.metrics.map((m) => m.score)).toEqual([4, null]);
  });

  it('skips unusable entries, names a nameless metric by its key and caps at 20 metrics', () => {
    const entries: unknown[] = [null, 'text', [1], { metric: {} }, { metric: { key: '' } }, { score: 3 }];
    entries.push({ metric: { key: 'nameless_metric' }, score: 3, evidenceStatus: 'scored' });
    for (let i = 0; i < 30; i += 1) {
      entries.push({ metric: { key: `m_${i}`, name: `Metric ${i}` }, score: 2, evidenceStatus: 'scored', rationale: 'r' });
    }
    const src = source({ metric_results: entries });
    expect(src.metrics).toHaveLength(20);
    expect(src.metrics[0]).toStrictEqual({ key: 'nameless_metric', name: 'nameless_metric', score: 3, rationale: '' });
  });

  it('never reads evidence, evidenceRefs or raw', () => {
    const trap = (target: Record<string, unknown>, key: string) =>
      Object.defineProperty(target, key, { enumerable: true, get() { throw new Error(`read ${key}`); } });
    const metrics = [4, 3, 3, 3, 3].map((score, i) => {
      const entry = metricResult(i, score, RATIONALES[i]!);
      delete entry.evidence;
      delete entry.evidenceRefs;
      trap(entry, 'evidence');
      trap(entry, 'evidenceRefs');
      return entry;
    });
    const fixture = row({ metric_results: metrics });
    delete fixture.raw;
    trap(fixture, 'raw');
    expect(isR1MeetFeedbackRefused(r1MeetFeedbackSource(fixture))).toBe(false);
  });
});

// ── The Summary ─────────────────────────────────────────────────────────────

describe('r1MeetFeedbackSummary', () => {
  it('writes the header and one line per metric in rubric order', () => {
    expect(r1MeetFeedbackSummary(source())).toBe(HAPPY_SUMMARY);
  });

  it.each([
    ['hold', 55, 'Borderline'],
    ['reject', 20, 'Reject'],
  ] as const)('says the verdict word for %s', (recommendation, overall, word) => {
    expect(r1MeetFeedbackSummary(source({ recommendation, overall_score: overall }))).toContain(`. Verdict: ${word}. `);
  });

  it('puts the NOT SCORED lines first and states the coverage', () => {
    const src = source({
      weighted_score_5: 3.4,
      metric_results: [
        metricResult(0, 4, RATIONALES[0]),
        metricResult(1, null, 'The learner raised no objection.'),
        metricResult(2, 3, RATIONALES[2]),
        metricResult(3, null, ''),
        metricResult(4, 3, RATIONALES[4]),
      ],
    });
    expect(r1MeetFeedbackSummary(src)).toBe([
      'Dex (AI interviewer): R1 sales role-play over Google Meet. Verdict: Select. Weighted 3.4/4 across 3 of 5 metrics; 2 not scored (listed below).',
      'Objection handling — NOT SCORED (insufficient evidence): The learner raised no objection.',
      'Negotiation & discount discipline — NOT SCORED (insufficient evidence)',
      'Probing & discovery — 4/4: Asked four open questions before the first pitch.',
      'Urgency & close — 3/4: Tied urgency to the stated career goal.',
      'Communication & rapport — 3/4: Clear and polite; talk share inside the band.',
    ].join('\n'));
  });

  it('rounds the weighted score to two decimals and omits an empty rationale', () => {
    const summary = r1MeetFeedbackSummary(source({ weighted_score_5: 3.3333, metric_results: [metricResult(0, 3, '  ')] }));
    expect(summary).toBe(
      'Dex (AI interviewer): R1 sales role-play over Google Meet. Verdict: Select. Weighted 3.33/4 across 1 of 1 metric.\n'
      + 'Probing & discovery — 3/4',
    );
  });

  it('bounds each rationale to 280 characters with an ellipsis', () => {
    const src = source({ metric_results: [metricResult(0, 4, 'word '.repeat(100))] });
    expect(src.metrics[0]!.rationale).toHaveLength(280);
    expect(src.metrics[0]!.rationale.endsWith('…')).toBe(true);
    const line = r1MeetFeedbackSummary(src).split('\n')[1]!;
    expect(line).toBe(`Probing & discovery — 4/4: ${src.metrics[0]!.rationale}`);
  });

  it('keeps whole lines up to 2000 characters, the NOT SCORED lines surviving first', () => {
    const entries: unknown[] = [];
    for (let i = 0; i < 20; i += 1) {
      const unscored = i >= 17;
      entries.push({
        metric: { key: `m_${i}`, name: `Metric ${i}` },
        score: unscored ? null : 3,
        evidenceStatus: unscored ? 'insufficient_evidence' : 'scored',
        rationale: `${i} `.padEnd(400, 'x'),
      });
    }
    const src = source({ metric_results: entries });
    const summary = r1MeetFeedbackSummary(src);
    expect(summary.length).toBeLessThanOrEqual(2000);
    const lines = summary.split('\n');
    expect(lines[0]).toContain('across 17 of 20 metrics; 3 not scored (listed below).');
    const expected = [
      ...src.metrics.filter((m) => m.score === null).map((m) => `${m.name} — NOT SCORED (insufficient evidence): ${m.rationale}`),
      ...src.metrics.filter((m) => m.score !== null).map((m) => `${m.name} — ${m.score}/4: ${m.rationale}`),
    ];
    // Whole lines, in order, and the next whole line would not have fitted.
    expect(lines.slice(1)).toEqual(expected.slice(0, lines.length - 1));
    expect(lines.slice(1, 4).every((line) => line.includes('NOT SCORED'))).toBe(true);
    expect(`${summary}\n${expected[lines.length - 1]}`.length).toBeGreaterThan(2000);
  });

  it('strips control characters and lone surrogates from names and rationales', () => {
    const src = source({
      metric_results: [
        { ...metricResult(0, 4, 'Good\u0000 open\nquestions\t\u007f\u0085here \uD83D then \uDE00 more'), metric: { key: 'k', name: 'Pro\u0007bing ' } },
        metricResult(1, 3, `${'a'.repeat(278)}😀tail`),
      ],
    });
    expect(src.metrics[0]!.name).toBe('Pro bing');
    expect(src.metrics[0]!.rationale).toBe('Good open questions here then more');
    expect(src.metrics[1]!.rationale).toBe(`${'a'.repeat(278)}…`);
    const summary = r1MeetFeedbackSummary(src);
    expect(summary).not.toMatch(LONE_SURROGATE);
    expect(summary.replace(/\n/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('holds no evidence quote, no candidate detail and no old persona name', () => {
    const summary = r1MeetFeedbackSummary(source());
    for (const sentinel of Object.values(PII)) expect(summary).not.toContain(sentinel);
    expect(summary).not.toMatch(/christy/i);
  });
});

describe('the modules carry no old persona name and no phone-screen binding', () => {
  it.each(['feedback-form.ts', 'feedback-ashby.ts'])('%s', (file) => {
    const text = readFileSync(path.join(SRC, 'lib', 'r1', 'meet', file), 'utf8');
    expect(text).not.toMatch(/christy/i);
    expect(text).not.toMatch(/HELLO_[A-Z_]*BINDING/);
    expect(text).not.toMatch(/process\.env\.|console\./);
  });
});

// ── The report link ─────────────────────────────────────────────────────────

describe('r1MeetFeedbackReportUrl', () => {
  it('is the bridge page origin plus /interviews/<round uuid>, lower-cased', () => {
    expect(r1MeetFeedbackReportUrl(BRIDGE_PAGE_URL, ROUND_ID)).toBe(REPORT_URL);
    expect(r1MeetFeedbackReportUrl(BRIDGE_PAGE_URL, ROUND_ID.toUpperCase())).toBe(REPORT_URL);
    expect(r1MeetFeedbackReportUrl('https://hello.example.test:8443/candidate/r1/meet?x=1#y', ROUND_ID))
      .toBe(`https://hello.example.test:8443/interviews/${ROUND_ID}`);
    // Userinfo never reaches the link: the origin drops it.
    expect(r1MeetFeedbackReportUrl('https://user:pw@hello.example.test/candidate/r1/meet', ROUND_ID)).toBe(REPORT_URL);
  });

  it.each([
    ['an http origin', 'http://hello.example.test/candidate/r1/meet', ROUND_ID],
    ['not a URL', 'hello.example.test/candidate', ROUND_ID],
    ['a file URL', 'file:///candidate/r1/meet', ROUND_ID],
    ['a non-string page', 42, ROUND_ID],
    ['a non-UUID round', BRIDGE_PAGE_URL, 'round-1'],
    ['a path-smuggling round', BRIDGE_PAGE_URL, `${ROUND_ID}/../admin`],
    ['a missing round', BRIDGE_PAGE_URL, null],
  ])('is null for %s', (_label, page, round) => {
    expect(r1MeetFeedbackReportUrl(page, round)).toBeNull();
  });
});

// ── The binding ─────────────────────────────────────────────────────────────

describe('bindR1MeetFeedbackForm: the happy path', () => {
  it('binds Overall, Summary, the report and the five R1 metric Score fields, in that order', () => {
    expect(bind()).toStrictEqual({
      ok: true,
      fieldSubmissions: [
        { path: 'overall_recommendation', value: '4' },
        { path: 'summary_path', value: { type: 'PlainText', value: HAPPY_SUMMARY } },
        { path: 'report_path', value: REPORT_URL },
        { path: 'metric_path_0', value: { score: 4 } },
        { path: 'metric_path_1', value: { score: 3 } },
        { path: 'metric_path_2', value: { score: 3 } },
        { path: 'metric_path_3', value: { score: 3 } },
        { path: 'metric_path_4', value: { score: 3 } },
      ],
      metricsBound: 5,
      metricsUnbound: 0,
    });
  });

  it('finds the metric and Summary fields whatever the section layout and title spacing', () => {
    const f = form();
    f.sections = [
      { id: 's1', title: null, fields: [OVERALL, { ...SUMMARY, title: '  SUMMARY ' }] },
      { id: 's2', title: null, fields: [REPORT, ...METRIC_FIELDS.map((m) => ({ ...m, title: (m.title ?? '').toUpperCase() }))] },
    ];
    const bound = bind(f);
    expect(bound.ok && bound.fieldSubmissions.map((s) => s.path)).toEqual([
      'overall_recommendation', 'summary_path', 'report_path',
      'metric_path_0', 'metric_path_1', 'metric_path_2', 'metric_path_3', 'metric_path_4',
    ]);
  });

  it('answers a frozen binding', () => {
    const bound = bind();
    expect(Object.isFrozen(bound)).toBe(true);
    expect(bound.ok && Object.isFrozen(bound.fieldSubmissions)).toBe(true);
  });
});

describe('bindR1MeetFeedbackForm: the Summary field', () => {
  it.each(['LongText', 'String'])('a %s field gets the bare text', (type) => {
    const bound = bind(form(withField({ ...SUMMARY, type })));
    expect(bound.ok && bound.fieldSubmissions[1]).toStrictEqual({ path: 'summary_path', value: HAPPY_SUMMARY });
  });

  it('none, or one that takes no text or has no path, is form_summary_missing', () => {
    expect(bind(form(without('fld-summary')))).toStrictEqual({ ok: false, reason: 'form_summary_missing' });
    expect(bind(form(withField({ ...SUMMARY, type: 'Score' })))).toStrictEqual({ ok: false, reason: 'form_summary_missing' });
    expect(bind(form(withField({ ...SUMMARY, type: null })))).toStrictEqual({ ok: false, reason: 'form_summary_missing' });
    expect(bind(form(withField({ ...SUMMARY, path: null })))).toStrictEqual({ ok: false, reason: 'form_summary_missing' });
  });

  it('two Summary fields are form_summary_ambiguous', () => {
    const second = field('fld-summary-2', { title: 'summary', path: 'summary_path_2', type: 'LongText' });
    expect(bind(form(withField(second)))).toStrictEqual({ ok: false, reason: 'form_summary_ambiguous' });
  });
});

describe('bindR1MeetFeedbackForm: the Overall field', () => {
  it('none, or two with the path, is form_overall_missing', () => {
    expect(bind(form(without('fld-overall')))).toStrictEqual({ ok: false, reason: 'form_overall_missing' });
    const twin = { ...OVERALL, id: 'fld-overall-2' };
    expect(bind(form(withField(twin)))).toStrictEqual({ ok: false, reason: 'form_overall_missing' });
  });

  it.each([
    ['another type', { type: 'Score' }],
    ['no type', { type: null }],
    ['options 1..5', { options: options(['1', '2', '3', '4', '5']) }],
    ['Yes/No options', { options: options(['Yes', 'No']) }],
    ['options 0..3', { options: options(['0', '1', '2', '3']) }],
    ['a repeated option', { options: options(['1', '2', '3', '3']) }],
    ['label-only options', { options: FOUR.map((label) => ({ value: null, label })) }],
    ['truncated options', { optionsTruncated: true }],
    ['no options', { options: [] }],
  ])('%s is form_overall_options_mismatch', (_label, over) => {
    expect(bind(form(withField({ ...OVERALL, ...over })))).toStrictEqual({ ok: false, reason: 'form_overall_options_mismatch' });
  });

  it('accepts the four values in any order', () => {
    expect(bind(form(withField({ ...OVERALL, options: options(['4', '2', '1', '3']) }))).ok).toBe(true);
  });
});

describe('bindR1MeetFeedbackForm: the form itself, in check order', () => {
  it('refuses a read without a schema, another form, an archived form', () => {
    expect(bind(form(ALL_FIELDS, { schemaAvailable: false }))).toStrictEqual({ ok: false, reason: 'form_no_schema' });
    expect(bind(form(ALL_FIELDS, { formDefinitionId: '7f000000-0000-4000-8000-00000000f002' })))
      .toStrictEqual({ ok: false, reason: 'form_mismatch' });
    expect(bind(form(ALL_FIELDS, { formDefinitionId: FORM_ID.toUpperCase() })))
      .toStrictEqual({ ok: false, reason: 'form_mismatch' });
    expect(bind(form(ALL_FIELDS, { archived: true }))).toStrictEqual({ ok: false, reason: 'form_archived' });
  });

  it('answers the first refusal when several apply', () => {
    const required = field('fld-notes', { title: 'Hiring notes', path: 'notes_path', type: 'LongText', required: true });
    const broken = [required, { ...SUMMARY, type: 'Score' }];
    const cases: Array<[Partial<ProbeFeedbackForm>, readonly ProbeFormField[], string]> = [
      [{ schemaAvailable: false, archived: true, formDefinitionId: 'other' }, broken, 'form_no_schema'],
      [{ archived: true, formDefinitionId: 'other' }, broken, 'form_mismatch'],
      [{ archived: true }, broken, 'form_archived'],
      [{}, broken, 'form_overall_missing'],
      [{}, [{ ...OVERALL, type: 'String' }, ...broken], 'form_overall_options_mismatch'],
      [{}, [OVERALL, ...broken], 'form_summary_missing'],
      [{}, [OVERALL, SUMMARY, { ...SUMMARY, id: 'fld-summary-2' }, required], 'form_summary_ambiguous'],
      [{}, [OVERALL, SUMMARY, required], 'form_required_field_unbound'],
    ];
    for (const [over, fields, reason] of cases) {
      expect(bind(form(fields, over)), reason).toStrictEqual({ ok: false, reason });
    }
  });

  it('refuses a card that would leave a required field empty', () => {
    const notes = field('fld-notes', { title: 'Hiring notes', path: 'notes_path', type: 'LongText', required: true });
    expect(bind(form(withField(notes)))).toStrictEqual({ ok: false, reason: 'form_required_field_unbound' });
    expect(bind(form(withField({ ...notes, path: null })))).toStrictEqual({ ok: false, reason: 'form_required_field_unbound' });
    // Not required, or required: null (the payload did not say): left empty, the card still binds.
    expect(bind(form(withField({ ...notes, required: false }))).ok).toBe(true);
    expect(bind(form(withField({ ...notes, required: null }))).ok).toBe(true);
  });

  it('refuses when a required metric field cannot be filled', () => {
    const src = source({ metric_results: [metricResult(0, 4, 'a'), metricResult(1, null, 'b')] });
    const fields = withField({ ...METRIC_FIELDS[1]!, required: true });
    expect(bind(form(fields), src)).toStrictEqual({ ok: false, reason: 'form_required_field_unbound' });
  });

  it('refuses a required report field when no safe link exists', () => {
    const fields = withField({ ...REPORT, required: true });
    expect(bind(form(fields)).ok).toBe(true);
    expect(bind(form(fields), source(), null)).toStrictEqual({ ok: false, reason: 'form_required_field_unbound' });
  });

  it('never writes one path twice: a shared path refuses the whole card', () => {
    const clash = withField({ ...METRIC_FIELDS[2]!, path: 'summary_path' });
    expect(bind(form(clash))).toStrictEqual({ ok: false, reason: 'form_mismatch' });
    const reportClash = withField({ ...REPORT, path: 'overall_recommendation' });
    expect(bind(form(reportClash))).toStrictEqual({ ok: false, reason: 'form_overall_missing' });
    const reportOnSummary = withField({ ...REPORT, path: 'summary_path' });
    expect(bind(form(reportOnSummary))).toStrictEqual({ ok: false, reason: 'form_mismatch' });
  });
});

describe('bindR1MeetFeedbackForm: the metric Score fields', () => {
  function submittedPaths(bound: ReturnType<typeof bind>): string[] {
    if (!bound.ok) throw new Error(`refused: ${bound.reason}`);
    return bound.fieldSubmissions.map((s) => s.path);
  }

  it('a five-point field leaves its metric unbound', () => {
    const fields = withField({ ...METRIC_FIELDS[1]!, options: options(['1', '2', '3', '4', '5']) });
    const bound = bind(form(fields));
    expect(submittedPaths(bound)).not.toContain('metric_path_1');
    expect(bound).toMatchObject({ metricsBound: 4, metricsUnbound: 1 });
  });

  it('a field of another type, a missing field or two fields with the title leave the metric unbound', () => {
    const retyped = bind(form(withField({ ...METRIC_FIELDS[0]!, type: 'String' })));
    expect(submittedPaths(retyped)).not.toContain('metric_path_0');
    expect(retyped).toMatchObject({ metricsBound: 4, metricsUnbound: 1 });

    const missing = bind(form(without('fld-metric-3')));
    expect(missing).toMatchObject({ metricsBound: 4, metricsUnbound: 1 });

    const twin = field('fld-metric-4b', { title: R1_METRICS[4]!.name, path: 'metric_path_4b', type: 'Score', options: options(FOUR) });
    const ambiguous = bind(form(withField(twin)));
    expect(submittedPaths(ambiguous)).not.toContain('metric_path_4');
    expect(submittedPaths(ambiguous)).not.toContain('metric_path_4b');
    expect(ambiguous).toMatchObject({ metricsBound: 4, metricsUnbound: 1 });
  });

  it('an unscored metric is never bound, even with a matching field', () => {
    const src = source({
      metric_results: [metricResult(0, 4, 'a'), metricResult(1, null, 'b'), metricResult(2, 5, 'c'), metricResult(3, 3, 'd'), metricResult(4, 3, 'e')],
    });
    const bound = bind(form(), src);
    expect(submittedPaths(bound)).toEqual([
      'overall_recommendation', 'summary_path', 'report_path', 'metric_path_0', 'metric_path_3', 'metric_path_4',
    ]);
    expect(bound).toMatchObject({ metricsBound: 3, metricsUnbound: 0 });
  });

  it('a five-point row binds only five-point fields', () => {
    const src = source({ score_scale_max: 5, weighted_score_5: 4, metric_results: [metricResult(0, 5, 'a'), metricResult(1, 3, 'b')] });
    const fields = withField({ ...METRIC_FIELDS[0]!, options: options(['1', '2', '3', '4', '5']) });
    const bound = bind(form(fields), src);
    expect(bound.ok && bound.fieldSubmissions.slice(3)).toStrictEqual([{ path: 'metric_path_0', value: { score: 5 } }]);
    expect(bound).toMatchObject({ metricsBound: 1, metricsUnbound: 1 });
  });
});

describe('bindR1MeetFeedbackForm: the Detailed report field', () => {
  function reportOf(bound: ReturnType<typeof bind>): unknown {
    if (!bound.ok) throw new Error(`refused: ${bound.reason}`);
    return bound.fieldSubmissions.find((s) => s.path.startsWith('report_path'))?.value ?? null;
  }

  it('present: the link; no link: the field stays empty', () => {
    expect(reportOf(bind())).toBe(REPORT_URL);
    expect(reportOf(bind(form(), source(), null))).toBeNull();
    expect(reportOf(bind(form(without('fld-report'))))).toBeNull();
  });

  it('two report fields, or one of another type or without a path, are skipped', () => {
    const twin = { ...REPORT, id: 'fld-report-2', path: 'report_path_2' };
    expect(reportOf(bind(form(withField(twin))))).toBeNull();
    expect(reportOf(bind(form(withField({ ...REPORT, type: 'String' }))))).toBeNull();
    expect(reportOf(bind(form(withField({ ...REPORT, path: null }))))).toBeNull();
  });

  it('an http origin gives no link, and a non-https link is never written', () => {
    const httpLink = r1MeetFeedbackReportUrl('http://hello.example.test/candidate/r1/meet', ROUND_ID);
    expect(httpLink).toBeNull();
    expect(reportOf(bind(form(), source(), httpLink))).toBeNull();
    expect(reportOf(bind(form(), source(), `http://hello.example.test/interviews/${ROUND_ID}`))).toBeNull();
    expect(reportOf(bind(form(), source(), '/interviews/relative'))).toBeNull();
  });
});

// ── The request ─────────────────────────────────────────────────────────────

describe('r1MeetFeedbackRequest', () => {
  function request() {
    const bound = bind();
    if (!bound.ok) throw new Error('fixture refused');
    return r1MeetFeedbackRequest({
      applicationId: APPLICATION_ID,
      formDefinitionId: FORM_ID,
      interviewEventId: EVENT_ID,
      dexUserId: DEX_USER_ID,
      fieldSubmissions: bound.fieldSubmissions,
    });
  }

  it('has exactly the five keys, in order, and no extra', () => {
    const req = request();
    expect(Object.keys(req)).toEqual(['applicationId', 'formDefinitionId', 'feedbackForm', 'userId', 'interviewEventId']);
    expect(Object.keys(req.feedbackForm)).toEqual(['fieldSubmissions']);
    expect(req).not.toHaveProperty('extra');
    expect(req).toStrictEqual({
      applicationId: APPLICATION_ID,
      formDefinitionId: FORM_ID,
      feedbackForm: {
        fieldSubmissions: [
          { path: 'overall_recommendation', value: '4' },
          { path: 'summary_path', value: { type: 'PlainText', value: HAPPY_SUMMARY } },
          { path: 'report_path', value: REPORT_URL },
          ...[4, 3, 3, 3, 3].map((score, i) => ({ path: `metric_path_${i}`, value: { score } })),
        ],
      },
      userId: DEX_USER_ID,
      interviewEventId: EVENT_ID,
    });
  });

  it('carries none of the PII sentinels planted in the row', () => {
    const json = JSON.stringify(request());
    for (const sentinel of Object.values(PII)) expect(json).not.toContain(sentinel);
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain('meet.google.com');
    expect(json).not.toContain('turn_index');
    expect(json).not.toMatch(/christy/i);
  });
});
