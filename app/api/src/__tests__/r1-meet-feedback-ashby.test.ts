/**
 * M034 S09 T2: the Ashby feedback port of the `r1-meet` runtime (`lib/r1/meet/feedback-ashby.ts`).
 *
 * - `classifyR1MeetAshbyFailure` over every client error category (D-S09-10), `retry_exhausted` with
 *   429, 503 and no status, the endpoint-code detail, and null for anything that is not an AshbyError.
 * - The port over a fake `AshbyTransport` running the REAL Ashby client: the submit body snapshot
 *   (exactly five keys, never `extra`), the path `/applicationFeedback.submit`, exactly ONE transport
 *   call on 429, 500, a network failure and a timeout (`maxAttempts: 1`: the queue retries), a submit
 *   without the event or user id refused before the network, and the form read through
 *   `/feedbackFormDefinition.info`.
 * - The log lines hold closed words and a status only: no id, no URL or field path, no key, no body.
 * - M035 S02, public-page bookings: `submitGeneral` (the same card without `interviewEventId`, refused
 *   before the network WITH an event key or without a user id; `submit` still refuses a missing event
 *   id) and `listDexFeedback` / `r1MeetDexFeedbackCards` (the exact list body, paging, the page cap,
 *   cursor faults, the fixed-shape reader and its unreadable cases, and SENTINEL answers, names and
 *   emails that never reach a card, an error or a log line).
 */
import { describe, expect, it } from 'vitest';
import type { AshbyTransport, AshbyTransportRequest, AshbyTransportResponse } from '../integrations/ashby/client.js';
import { AshbyError, isAshbyError, type AshbyErrorCategory } from '../integrations/ashby/errors.js';
import type { ProbeFeedbackForm } from '../integrations/ashby/probe.js';
import {
  R1_MEET_ASHBY_CLIENT_SETTINGS,
  R1_MEET_FEEDBACK_LIST_MAX_PAGES,
  classifyR1MeetAshbyFailure,
  createR1MeetAshbyFeedbackPort,
  r1MeetAshbyClientLogger,
  r1MeetDexFeedbackCards,
  type R1MeetAshbyFailureKind,
} from '../lib/r1/meet/feedback-ashby.js';
import {
  bindR1MeetFeedbackForm,
  isR1MeetFeedbackRefused,
  r1MeetFeedbackReportUrl,
  r1MeetFeedbackRequest,
  r1MeetFeedbackSource,
  r1MeetFeedbackSummary,
} from '../lib/r1/meet/feedback-form.js';
import { R1_MEET_DEFAULT_PROFILE_ID, getR1MeetProfile } from '../lib/r1/meet/profiles.js';
import type { R1MeetLog, R1MeetLogMeta } from '../lib/r1/meet/recall-actions.js';
import { R1_METRICS } from '../lib/r1/rubric.js';

const API_KEY = 'synthetic-key';
const FORM_ID = '7f000000-0000-4000-8000-00000000f001';
const ROUND_ID = '7f000000-0000-4000-8000-000000000301';
const APPLICATION_ID = '7f000000-0000-4000-8000-000000000401';
const EVENT_ID = '7f000000-0000-4000-8000-000000000501';
const DEX_USER_ID = '7f000000-0000-4000-8000-000000000601';
const BRIDGE_PAGE_URL = 'https://hello.example.test/candidate/r1/meet';

// ── The fake Ashby transport ────────────────────────────────────────────────

type Step = AshbyTransportResponse | Error | 'abort';

function res(status: number, body: string, headers: Record<string, string> = {}): AshbyTransportResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const ok = (results: unknown) => res(200, JSON.stringify({ success: true, results }));

function scripted(steps: readonly Step[]): { transport: AshbyTransport; calls: AshbyTransportRequest[] } {
  const calls: AshbyTransportRequest[] = [];
  const transport: AshbyTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step === 'abort') {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (step instanceof Error) throw step;
    return step;
  };
  return { transport, calls };
}

interface Line { readonly level: 'info' | 'warn' | 'error'; readonly meta: R1MeetLogMeta }

function capture(): { log: R1MeetLog; lines: Line[] } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (meta) => lines.push({ level: 'info', meta }),
      warn: (meta) => lines.push({ level: 'warn', meta }),
      error: (meta) => lines.push({ level: 'error', meta }),
    },
  };
}

function port(steps: readonly Step[]) {
  const fake = scripted(steps);
  const logs = capture();
  const sleeps: number[] = [];
  const feedback = createR1MeetAshbyFeedbackPort({
    apiKey: API_KEY,
    log: logs.log,
    transport: fake.transport,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { port: feedback, calls: fake.calls, lines: logs.lines, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<AshbyError> {
  try {
    await promise;
  } catch (error) {
    if (isAshbyError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

// ── The card the port submits (the T2 mapping, end to end) ──────────────────

const FOUR = ['1', '2', '3', '4'].map((value) => ({ value, label: value }));
const DEFINITION = {
  id: FORM_ID,
  title: 'Dex R1 interview',
  isArchived: false,
  formDefinition: {
    sections: [{
      id: 'sec-1',
      title: 'Scorecard',
      fields: [
        { isRequired: true, field: { id: 'fld-overall', type: 'ValueSelect', path: 'overall_recommendation', title: 'Overall Recommendation', selectableValues: FOUR } },
        { isRequired: true, field: { id: 'fld-summary', type: 'RichText', path: 'summary_path', title: 'Summary' } },
        { isRequired: false, field: { id: 'fld-report', type: 'Url', path: 'report_path', title: 'Detailed report' } },
        ...R1_METRICS.map((metric, i) => ({
          isRequired: false,
          field: { id: `fld-metric-${i}`, type: 'Score', path: `metric_path_${i}`, title: metric.name, selectableValues: FOUR },
        })),
      ],
    }],
  },
};

function cardRequest(form: ProbeFeedbackForm) {
  const source = r1MeetFeedbackSource({
    schema_version: 2,
    recommendation: 'hold',
    overall_score: 55,
    weighted_score_5: 2.65,
    score_scale_max: 4,
    metric_results: R1_METRICS.map((metric, i) => ({
      metric: { key: metric.key, name: metric.name },
      score: i === 3 ? null : [3, 3, 2, 0, 3][i],
      evidenceStatus: i === 3 ? 'insufficient_evidence' : 'scored',
      rationale: `Rationale ${i}.`,
      evidence: [{ turn_index: 2, quote: 'SENTINEL-QUOTE' }],
    })),
  });
  if (isR1MeetFeedbackRefused(source)) throw new Error('fixture refused');
  const bound = bindR1MeetFeedbackForm(source, form, {
    formDefinitionId: FORM_ID,
    reportUrl: r1MeetFeedbackReportUrl(BRIDGE_PAGE_URL, ROUND_ID),
    summary: r1MeetFeedbackSummary(source, getR1MeetProfile(R1_MEET_DEFAULT_PROFILE_ID)!),
  });
  if (!bound.ok) throw new Error(`fixture binding refused: ${bound.reason}`);
  return r1MeetFeedbackRequest({
    applicationId: APPLICATION_ID,
    formDefinitionId: FORM_ID,
    interviewEventId: EVENT_ID,
    dexUserId: DEX_USER_ID,
    fieldSubmissions: bound.fieldSubmissions,
  });
}

const EXPECTED_SUMMARY = [
  'Lexy (AI interviewer): R1 sales role-play over Google Meet. Verdict: Borderline. Weighted 2.65/4 across 4 of 5 metrics; 1 not scored (listed below).',
  'Negotiation & discount discipline — NOT SCORED (insufficient evidence): Rationale 3.',
  'Probing & discovery — 3/4: Rationale 0.',
  'Objection handling — 3/4: Rationale 1.',
  'Urgency & close — 2/4: Rationale 2.',
  'Communication & rapport — 3/4: Rationale 4.',
].join('\n');

/** The exact body Ashby receives, as one string (key order included). */
const EXPECTED_BODY = JSON.stringify({
  applicationId: APPLICATION_ID,
  formDefinitionId: FORM_ID,
  feedbackForm: {
    fieldSubmissions: [
      { path: 'overall_recommendation', value: '3' },
      { path: 'summary_path', value: { type: 'PlainText', value: EXPECTED_SUMMARY } },
      { path: 'report_path', value: `https://hello.example.test/interviews/${ROUND_ID}` },
      { path: 'metric_path_0', value: { score: 3 } },
      { path: 'metric_path_1', value: { score: 3 } },
      { path: 'metric_path_2', value: { score: 2 } },
      { path: 'metric_path_4', value: { score: 3 } },
    ],
  },
  userId: DEX_USER_ID,
  interviewEventId: EVENT_ID,
});

async function liveForm(): Promise<ProbeFeedbackForm> {
  const { port: reader } = port([ok(DEFINITION)]);
  const form = await reader.readForm(FORM_ID);
  if (form === null) throw new Error('fixture form unreadable');
  return form;
}

// ── The classifier ──────────────────────────────────────────────────────────

describe('classifyR1MeetAshbyFailure', () => {
  // A Record over the category union: tsc fails if a category is added without a row here.
  const EVERY_CATEGORY: Record<AshbyErrorCategory, { status: number | null; kind: R1MeetAshbyFailureKind }> = {
    invalid_request: { status: null, kind: 'request_invalid' },
    logical_failure: { status: 200, kind: 'rejected' },
    http_client_error: { status: 404, kind: 'rejected' },
    rate_limited: { status: 429, kind: 'rate_limited' },
    http_server_error: { status: 503, kind: 'unavailable' },
    malformed_response: { status: 200, kind: 'unavailable' },
    timeout: { status: null, kind: 'unavailable' },
    network: { status: null, kind: 'unavailable' },
    output_limit: { status: 200, kind: 'unavailable' },
    retry_exhausted: { status: null, kind: 'unavailable' },
  };

  it.each(Object.entries(EVERY_CATEGORY))('%s', (category, { status, kind }) => {
    const error = new AshbyError(category as AshbyErrorCategory, { httpStatus: status, operation: 'applicationFeedback.submit' });
    const classified = classifyR1MeetAshbyFailure(error);
    expect(classified).toStrictEqual({ kind, detail: category, httpStatus: status });
    expect(Object.isFrozen(classified)).toBe(true);
  });

  it.each([
    [429, 'rate_limited', 'rate_limited', 'retry_exhausted:rate_limited'],
    [503, 'http_server_error', 'unavailable', 'retry_exhausted:http_server_error'],
    [500, 'http_server_error', 'unavailable', 'retry_exhausted:http_server_error'],
    [null, 'network', 'unavailable', 'retry_exhausted:network'],
    [null, 'timeout', 'unavailable', 'retry_exhausted:timeout'],
    [null, undefined, 'unavailable', 'retry_exhausted'],
  ] as const)('retry_exhausted with status %s (%s) is %s', (status, code, kind, detail) => {
    const error = new AshbyError('retry_exhausted', { httpStatus: status, ...(code ? { code } : {}) });
    expect(classifyR1MeetAshbyFailure(error)).toStrictEqual({ kind, detail, httpStatus: status });
  });

  it('a permanent 4xx keeps the first short endpoint code, lower-cased; the detail stays within 64', () => {
    const coded = new AshbyError('http_client_error', {
      httpStatus: 422,
      endpointCodes: ['has space', 'x'.repeat(41), 'Feedback_Not_Editable', 'second_code'],
    });
    expect(classifyR1MeetAshbyFailure(coded)).toStrictEqual({
      kind: 'rejected', detail: 'http_client_error:feedback_not_editable', httpStatus: 422,
    });
    const longest = new AshbyError('malformed_response', { httpStatus: 200, endpointCodes: ['y'.repeat(40)] });
    const detail = classifyR1MeetAshbyFailure(longest)!.detail;
    expect(detail).toBe(`malformed_response:${'y'.repeat(40)}`);
    expect(detail.length).toBeLessThanOrEqual(64);
    const logical = new AshbyError('logical_failure', { httpStatus: 200, endpointCodes: ['invalid_input'] });
    expect(classifyR1MeetAshbyFailure(logical)!.detail).toBe('logical_failure:invalid_input');
  });

  it.each([
    ['an Error', new Error('ashby_rate_limited')],
    ['a look-alike object', { name: 'AshbyError', category: 'rate_limited', httpStatus: 429 }],
    ['a string', 'rate_limited'],
    ['null', null],
    ['undefined', undefined],
  ])('is null for %s', (_label, error) => {
    expect(classifyR1MeetAshbyFailure(error)).toBeNull();
  });
});

// ── The port over the fake transport ────────────────────────────────────────

describe('createR1MeetAshbyFeedbackPort: settings', () => {
  it('one attempt and a 15 s timeout: the queue does every retry', () => {
    expect(R1_MEET_ASHBY_CLIENT_SETTINGS).toStrictEqual({ maxAttempts: 1, timeoutMs: 15_000 });
    expect(Object.isFrozen(R1_MEET_ASHBY_CLIENT_SETTINGS)).toBe(true);
  });

  it('refuses an empty key at construction', () => {
    let thrown: unknown;
    try {
      createR1MeetAshbyFeedbackPort({ apiKey: '', log: capture().log });
    } catch (error) {
      thrown = error;
    }
    expect(isAshbyError(thrown) && thrown.category).toBe('invalid_request');
    expect(isAshbyError(thrown) && thrown.code).toBe('missing_api_key');
  });
});

describe('createR1MeetAshbyFeedbackPort: readForm', () => {
  it('reads the structure through /feedbackFormDefinition.info with the id only', async () => {
    const { port: feedback, calls } = port([ok(DEFINITION)]);
    const form = await feedback.readForm(FORM_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.ashbyhq.com/feedbackFormDefinition.info');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body)).toStrictEqual({ feedbackFormDefinitionId: FORM_ID });
    expect(form?.formDefinitionId).toBe(FORM_ID);
    expect(form?.schemaAvailable).toBe(true);
    expect(form?.sections[0]!.fields.map((f) => [f.path, f.type, f.required])).toEqual([
      ['overall_recommendation', 'ValueSelect', true],
      ['summary_path', 'RichText', true],
      ['report_path', 'Url', false],
      ...R1_METRICS.map((_, i) => [`metric_path_${i}`, 'Score', false]),
    ]);
  });

  it('answers null for a payload with no usable definition', async () => {
    const { port: feedback } = port([ok({ title: 'no id' })]);
    expect(await feedback.readForm(FORM_ID)).toBeNull();
  });

  it.each([
    ['a 429', res(429, '{}', { 'retry-after': '1' }), 'rate_limited'],
    ['a 503', res(503, 'down'), 'unavailable'],
    ['a network failure', new Error('socket hang up'), 'unavailable'],
    ['a 403', res(403, JSON.stringify({ errors: ['missing_endpoint_permission'] })), 'rejected'],
  ] as const)('%s is one transport call, then %s', async (_label, step, kind) => {
    const { port: feedback, calls, sleeps } = port([step, ok(DEFINITION)]);
    const error = await failure(feedback.readForm(FORM_ID));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe(kind);
  });
});

describe('createR1MeetAshbyFeedbackPort: submit', () => {
  it('sends exactly the card body to /applicationFeedback.submit and resolves with nothing', async () => {
    const request = cardRequest(await liveForm());
    const { port: feedback, calls, lines } = port([ok({ submittedFormInstance: { id: 'sfi-1', submittedValues: {} } })]);
    await expect(feedback.submit(request)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.ashbyhq.com/applicationFeedback.submit');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe(EXPECTED_BODY);
    expect(calls[0]!.body).not.toContain('SENTINEL');
    expect(lines).toEqual([
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'applicationFeedback.submit', http_status: 200 } },
    ]);
  });

  it('never forwards an extra on the request', async () => {
    const request = cardRequest(await liveForm());
    const { port: feedback, calls } = port([ok({})]);
    await feedback.submit({ ...request, extra: { submittedByUserId: 'someone-else', candidateEmail: 'x@example.test' } });
    expect(calls[0]!.body).toBe(EXPECTED_BODY);
  });

  it('refuses, before the network, a submit without the event or the user id', async () => {
    const request = cardRequest(await liveForm());
    for (const [omit, code] of [['interviewEventId', 'missing_interview_event_id'], ['userId', 'missing_user_id']] as const) {
      const { port: feedback, calls } = port([ok({})]);
      const partial = { ...request };
      delete partial[omit];
      const error = await failure(feedback.submit(partial));
      expect(error.category).toBe('invalid_request');
      expect(error.code).toBe(code);
      expect(classifyR1MeetAshbyFailure(error)?.kind).toBe('request_invalid');
      expect(calls).toHaveLength(0);
      const blank = await failure(port([ok({})]).port.submit({ ...request, [omit]: '' }));
      expect(blank.code).toBe(code);
    }
  });

  it.each([
    ['a 429', res(429, '{}', { 'retry-after': '2' }), 'retry_exhausted', 429, 'rate_limited'],
    ['a 500', res(500, 'oops'), 'retry_exhausted', 500, 'unavailable'],
    ['a 503', res(503, ''), 'retry_exhausted', 503, 'unavailable'],
    ['a network failure', new Error('ECONNRESET'), 'network', null, 'unavailable'],
    ['a timeout', 'abort', 'timeout', null, 'unavailable'],
    ['a malformed answer', res(200, 'not json'), 'malformed_response', 200, 'unavailable'],
  ] as const)('%s is exactly one transport call, then %s', async (_label, step, category, status, kind) => {
    const request = cardRequest(await liveForm());
    const { port: feedback, calls, sleeps } = port([step, ok({})]);
    const error = await failure(feedback.submit(request));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(error.category).toBe(category);
    expect(error.httpStatus).toBe(status);
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe(kind);
  });

  it.each([
    ['a 400', res(400, JSON.stringify({ errors: ['invalid_input'] })), 'http_client_error:invalid_input', 400],
    ['a 404', res(404, ''), 'http_client_error', 404],
    ['a 422', res(422, '{}'), 'http_client_error', 422],
    ['success:false', res(200, JSON.stringify({ success: false, errors: ['feedback_not_editable'] })), 'logical_failure:feedback_not_editable', 200],
  ] as const)('%s is rejected after one call', async (_label, step, detail, status) => {
    const request = cardRequest(await liveForm());
    const { port: feedback, calls } = port([step, ok({})]);
    const error = await failure(feedback.submit(request));
    expect(calls).toHaveLength(1);
    expect(classifyR1MeetAshbyFailure(error)).toStrictEqual({ kind: 'rejected', detail, httpStatus: status });
  });
});

// ── General feedback (M035 S02) ─────────────────────────────────────────────

/** The exact body of a public-page card: `EXPECTED_BODY` without the event key, key order kept. */
const EXPECTED_GENERAL_BODY = JSON.stringify({
  applicationId: APPLICATION_ID,
  formDefinitionId: FORM_ID,
  feedbackForm: (JSON.parse(EXPECTED_BODY) as { feedbackForm: unknown }).feedbackForm,
  userId: DEX_USER_ID,
});

async function generalRequest() {
  const request = cardRequest(await liveForm());
  const { interviewEventId: _event, ...general } = request;
  return general;
}

describe('createR1MeetAshbyFeedbackPort: submitGeneral (M035 S02)', () => {
  it('sends exactly the card body without interviewEventId to /applicationFeedback.submit', async () => {
    expect(EXPECTED_GENERAL_BODY).toBe(EXPECTED_BODY.replace(`,"interviewEventId":"${EVENT_ID}"`, ''));
    const request = await generalRequest();
    const { port: feedback, calls, lines } = port([ok({ submittedFormInstance: { id: 'sfi-1' } })]);
    await expect(feedback.submitGeneral(request)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.ashbyhq.com/applicationFeedback.submit');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe(EXPECTED_GENERAL_BODY);
    expect(Object.keys(JSON.parse(calls[0]!.body) as object)).toEqual(['applicationId', 'formDefinitionId', 'feedbackForm', 'userId']);
    expect(lines).toEqual([
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'applicationFeedback.submit', http_status: 200 } },
    ]);
  });

  it('never forwards an extra on the request', async () => {
    const request = await generalRequest();
    const { port: feedback, calls } = port([ok({})]);
    await feedback.submitGeneral({ ...request, extra: { interviewEventId: EVENT_ID, candidateEmail: 'x@example.test' } });
    expect(calls[0]!.body).toBe(EXPECTED_GENERAL_BODY);
  });

  it.each([
    ['an event id', { interviewEventId: EVENT_ID }],
    ['a blank event id', { interviewEventId: '' }],
    ['an event key holding undefined', { interviewEventId: undefined }],
  ])('refuses, before the network, a request with %s (the two modes never mix)', async (_label, over) => {
    const request = await generalRequest();
    const { port: feedback, calls } = port([ok({})]);
    const error = await failure(feedback.submitGeneral({ ...request, ...over }));
    expect(error.category).toBe('invalid_request');
    expect(error.code).toBe('unexpected_interview_event_id');
    expect(error.operation).toBe('applicationFeedback.submit');
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe('request_invalid');
    expect(calls).toHaveLength(0);
  });

  it('refuses, before the network, a request without the user id', async () => {
    const request = await generalRequest();
    for (const partial of [(() => { const { userId: _u, ...rest } = request; return rest; })(), { ...request, userId: '' }]) {
      const { port: feedback, calls } = port([ok({})]);
      const error = await failure(feedback.submitGeneral(partial));
      expect(error.code).toBe('missing_user_id');
      expect(calls).toHaveLength(0);
    }
  });

  it('submit (interview-event mode) still refuses the general request before the network', async () => {
    const request = await generalRequest();
    const { port: feedback, calls } = port([ok({})]);
    const error = await failure(feedback.submit(request));
    expect(error.code).toBe('missing_interview_event_id');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a 429', res(429, '{}'), 'rate_limited'],
    ['a 500', res(500, ''), 'unavailable'],
    ['a network failure', new Error('ECONNRESET'), 'unavailable'],
    ['a 422', res(422, '{}'), 'rejected'],
  ] as const)('%s is exactly one transport call, then %s', async (_label, step, kind) => {
    const request = await generalRequest();
    const { port: feedback, calls, sleeps } = port([step, ok({})]);
    const error = await failure(feedback.submitGeneral(request));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe(kind);
  });
});

// ── Dex's cards on an application (M035 S02) ────────────────────────────────

const OTHER_USER_ID = '7f000000-0000-4000-8000-000000000602';
const OTHER_FORM_ID = '7f000000-0000-4000-8000-00000000f0ff';
const SINCE = '2026-11-20T10:00:00.000Z';
const SINCE_MS = Date.parse(SINCE);
const AFTER = '2026-11-20T10:45:00.000Z';
const QUERY = Object.freeze({ dexUserId: DEX_USER_ID, since: SINCE });

/** Planted in every place the reader must never copy from. */
const LIST_SENTINELS = Object.freeze({
  answer: 'SENTINEL-ANSWER-8101',
  first: 'SENTINEL-FIRST-8102',
  last: 'SENTINEL-LAST-8103',
  email: 'sentinel-8104@example.test',
  form: 'SENTINEL-FORM-8105',
});

/** One `applicationFeedback.list` entry in the reference's shape, Dex's on the form after SINCE by default. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const person = (id: string) => ({
    id,
    firstName: LIST_SENTINELS.first,
    lastName: LIST_SENTINELS.last,
    email: LIST_SENTINELS.email,
    globalRole: 'Interviewer',
    isEnabled: true,
  });
  return {
    id: '7f000000-0000-4000-8000-0000000fb001',
    applicationId: APPLICATION_ID,
    submittedValues: { summary_path: LIST_SENTINELS.answer, overall_recommendation: '3' },
    submittedByUser: person(DEX_USER_ID),
    creditedToUser: person(DEX_USER_ID),
    submittedAt: AFTER,
    feedbackFormDefinitionId: FORM_ID,
    formDefinition: { title: LIST_SENTINELS.form, sections: [] },
    ...over,
  };
}

function page(results: unknown, more: { moreDataAvailable?: boolean; nextCursor?: string } = {}): AshbyTransportResponse {
  return res(200, JSON.stringify({ success: true, results, ...more }));
}

const CARD = Object.freeze({ formDefinitionId: FORM_ID, submittedAt: AFTER });

async function unreadable(promise: Promise<unknown>): Promise<AshbyError> {
  const error = await failure(promise);
  expect(error.category).toBe('malformed_response');
  expect(error.code).toBe('feedback_list_unreadable');
  expect(error.operation).toBe('applicationFeedback.list');
  expect(classifyR1MeetAshbyFailure(error)?.kind).toBe('unavailable');
  return error;
}

function readerThrows(results: unknown): void {
  let thrown: unknown;
  try {
    r1MeetDexFeedbackCards(results, QUERY);
  } catch (error) {
    thrown = error;
  }
  expect(isAshbyError(thrown) && `${thrown.category}/${thrown.code}`).toBe('malformed_response/feedback_list_unreadable');
}

describe('createR1MeetAshbyFeedbackPort: listDexFeedback (M035 S02)', () => {
  it('the page cap', () => {
    expect(R1_MEET_FEEDBACK_LIST_MAX_PAGES).toBe(5);
  });

  it('one page: the exact body to /applicationFeedback.list, Dex\'s card as two fields, frozen', async () => {
    const { port: feedback, calls, lines } = port([page([entry()])]);
    const cards = await feedback.listDexFeedback(APPLICATION_ID, QUERY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.ashbyhq.com/applicationFeedback.list');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe(`{"applicationId":"${APPLICATION_ID}","limit":100,"createdAfter":${SINCE_MS - 3_600_000}}`);
    expect(cards).toStrictEqual([CARD]);
    expect(Object.isFrozen(cards)).toBe(true);
    expect(Object.isFrozen(cards[0])).toBe(true);
    expect(Object.keys(cards[0]!)).toEqual(['formDefinitionId', 'submittedAt']);
    expect(lines).toEqual([
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'applicationFeedback.list', http_status: 200 } },
    ]);
  });

  it('an empty list is no card', async () => {
    const { port: feedback, calls } = port([page([])]);
    expect(await feedback.listDexFeedback(APPLICATION_ID, QUERY)).toStrictEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('pages with the cursor, one transport call per page, and keeps the cards of every page in order', async () => {
    const second = '2026-11-20T11:00:00.000Z';
    const third = '2026-11-20T11:15:00.000Z';
    const { port: feedback, calls } = port([
      page([entry()], { moreDataAvailable: true, nextCursor: 'cursor-2' }),
      page([entry({ submittedAt: second, feedbackFormDefinitionId: OTHER_FORM_ID })], { moreDataAvailable: true, nextCursor: 'cursor-3' }),
      page([entry({ submittedAt: third })], { moreDataAvailable: false }),
    ]);
    const cards = await feedback.listDexFeedback(APPLICATION_ID, QUERY);
    expect(calls.map((call) => call.body)).toEqual([
      `{"applicationId":"${APPLICATION_ID}","limit":100,"createdAfter":${SINCE_MS - 3_600_000}}`,
      `{"applicationId":"${APPLICATION_ID}","limit":100,"createdAfter":${SINCE_MS - 3_600_000},"cursor":"cursor-2"}`,
      `{"applicationId":"${APPLICATION_ID}","limit":100,"createdAfter":${SINCE_MS - 3_600_000},"cursor":"cursor-3"}`,
    ]);
    expect(cards).toStrictEqual([
      CARD,
      { formDefinitionId: OTHER_FORM_ID, submittedAt: second },
      { formDefinitionId: FORM_ID, submittedAt: third },
    ]);
  });

  it('reads at most five pages: a fifth that ends is fine, a sixth is unreadable (never fetched)', async () => {
    const pages = (n: number, lastMore: boolean) => Array.from({ length: n }, (_, i) =>
      page([], i < n - 1 || lastMore ? { moreDataAvailable: true, nextCursor: `cursor-${i + 2}` } : {}));
    const five = port(pages(5, false));
    expect(await five.port.listDexFeedback(APPLICATION_ID, QUERY)).toStrictEqual([]);
    expect(five.calls).toHaveLength(5);

    const six = port(pages(6, false));
    await unreadable(six.port.listDexFeedback(APPLICATION_ID, QUERY));
    expect(six.calls).toHaveLength(R1_MEET_FEEDBACK_LIST_MAX_PAGES);
  });

  it.each([
    ['a repeated cursor', [
      page([], { moreDataAvailable: true, nextCursor: 'cursor-2' }),
      page([], { moreDataAvailable: true, nextCursor: 'cursor-2' }),
    ], 2],
    ['more data without a cursor', [page([], { moreDataAvailable: true })], 1],
    ['more data with a blank cursor', [page([], { moreDataAvailable: true, nextCursor: '' })], 1],
  ] as const)('%s is unreadable', async (_label, steps, expectedCalls) => {
    const { port: feedback, calls } = port(steps);
    await unreadable(feedback.listDexFeedback(APPLICATION_ID, QUERY));
    expect(calls).toHaveLength(expectedCalls);
  });

  it('an unreadable later page discards the cards already read', async () => {
    const { port: feedback } = port([
      page([entry()], { moreDataAvailable: true, nextCursor: 'cursor-2' }),
      page('not a list'),
    ]);
    await unreadable(feedback.listDexFeedback(APPLICATION_ID, QUERY));
  });

  it.each([
    ['a 429', res(429, '{}', { 'retry-after': '1' }), 'rate_limited', 429],
    ['a 503', res(503, ''), 'unavailable', 503],
    ['a timeout', 'abort', 'unavailable', null],
    ['a network failure', new Error('socket hang up'), 'unavailable', null],
    ['invalid JSON', res(200, 'not json'), 'unavailable', 200],
    ['a 403', res(403, JSON.stringify({ errors: ['missing_endpoint_permission'] })), 'rejected', 403],
    ['success:false', res(200, JSON.stringify({ success: false, errors: ['application_not_found'] })), 'rejected', 200],
  ] as const)('%s is one transport call, then %s', async (_label, step, kind, status) => {
    const { port: feedback, calls, sleeps } = port([step, page([])]);
    const error = await failure(feedback.listDexFeedback(APPLICATION_ID, QUERY));
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe(kind);
    expect(error.httpStatus).toBe(status);
  });

  it('a failure on the second page is that page\'s one call', async () => {
    const { port: feedback, calls } = port([page([], { moreDataAvailable: true, nextCursor: 'cursor-2' }), res(503, '')]);
    const error = await failure(feedback.listDexFeedback(APPLICATION_ID, QUERY));
    expect(calls).toHaveLength(2);
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe('unavailable');
  });

  it.each([
    ['a Dex user that is not a UUID', { dexUserId: 'dex', since: SINCE }, 'invalid_dex_user_id'],
    ['a blank Dex user', { dexUserId: '', since: SINCE }, 'invalid_dex_user_id'],
    ['a since that is not a time', { dexUserId: DEX_USER_ID, since: 'yesterday' }, 'invalid_since'],
    ['a zoneless since', { dexUserId: DEX_USER_ID, since: '2026-11-20T10:00:00' }, 'invalid_since'],
  ])('refuses, before the network, %s', async (_label, query, code) => {
    const { port: feedback, calls } = port([page([])]);
    const error = await failure(feedback.listDexFeedback(APPLICATION_ID, query));
    expect(error.category).toBe('invalid_request');
    expect(error.code).toBe(code);
    expect(classifyR1MeetAshbyFailure(error)?.kind).toBe('request_invalid');
    expect(calls).toHaveLength(0);
  });

  it('refuses, before the network, a blank application id (the client\'s own check)', async () => {
    const { port: feedback, calls } = port([page([])]);
    const error = await failure(feedback.listDexFeedback('', QUERY));
    expect(error.category).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('no sentinel answer, name or email reaches a card, an error or a log line', async () => {
    const all: Line[] = [];
    const seen: string[] = [];
    const ok1 = port([page([entry(), entry({ submittedByUser: { id: OTHER_USER_ID, email: LIST_SENTINELS.email }, creditedToUser: null })])]);
    seen.push(JSON.stringify(await ok1.port.listDexFeedback(APPLICATION_ID, QUERY)));
    all.push(...ok1.lines);
    for (const bad of [
      [entry({ submittedAt: LIST_SENTINELS.answer })],
      [entry({ feedbackFormDefinitionId: LIST_SENTINELS.form })],
      [entry({ submittedByUser: { email: LIST_SENTINELS.email }, creditedToUser: { firstName: LIST_SENTINELS.first } })],
    ]) {
      const run = port([page(bad)]);
      const error = await failure(run.port.listDexFeedback(APPLICATION_ID, QUERY));
      seen.push(JSON.stringify(error), error.message, String(error), error.stack ?? '');
      all.push(...run.lines);
    }
    seen.push(JSON.stringify(all));
    const text = seen.join('\n');
    for (const sentinel of Object.values(LIST_SENTINELS)) expect(text).not.toContain(sentinel);
    const logText = JSON.stringify(all);
    for (const id of [APPLICATION_ID, DEX_USER_ID, OTHER_USER_ID, FORM_ID]) expect(logText).not.toContain(id);
    for (const { meta } of all) {
      expect(meta.error_category).toMatch(/^r1_meet_ashby_(ok|failed)$/);
      expect(meta.error_type).toBe('applicationFeedback.list');
    }
  });
});

describe('r1MeetDexFeedbackCards: the fixed-shape reader (M035 S02)', () => {
  it.each([
    ['an object', {}],
    ['null', null],
    ['a string', 'results'],
    ['absent', undefined],
  ])('results that are %s are unreadable', (_label, results) => {
    readerThrows(results);
  });

  it.each([
    ['null', null],
    ['a string', 'entry'],
    ['an array', [entry()]],
    ['a class instance', new Date()],
  ])('an entry that is %s is unreadable', (_label, bad) => {
    readerThrows([entry(), bad]);
  });

  it.each([
    ['no user at all', { submittedByUser: undefined, creditedToUser: undefined }],
    ['null users', { submittedByUser: null, creditedToUser: null }],
    ['users without an id', { submittedByUser: { email: LIST_SENTINELS.email }, creditedToUser: {} }],
    ['ids that are not UUIDs', { submittedByUser: { id: 'dex' }, creditedToUser: { id: 42 } }],
    ['users that are strings', { submittedByUser: DEX_USER_ID, creditedToUser: DEX_USER_ID }],
  ])('an entry with %s (no readable user id) is unreadable', (_label, over) => {
    readerThrows([entry(over)]);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not a time', 'yesterday'],
    ['zoneless', '2026-11-20T10:45:00'],
    ['an epoch number', Date.parse(AFTER)],
    ['an impossible date', '2026-13-45T10:45:00Z'],
  ])("a Dex entry whose submittedAt is %s is unreadable", (_label, submittedAt) => {
    readerThrows([entry({ submittedAt })]);
  });

  it.each([
    ['not a UUID', 'form-1'],
    ['blank', ''],
    ['a number', 42],
    ['an object', { id: FORM_ID }],
  ])('a Dex entry whose form id is %s is unreadable', (_label, feedbackFormDefinitionId) => {
    readerThrows([entry({ feedbackFormDefinitionId })]);
  });

  it('a Dex entry with no form id (absent or null) is a card with a null form', () => {
    expect(r1MeetDexFeedbackCards([entry({ feedbackFormDefinitionId: undefined })], QUERY)).toStrictEqual([{ formDefinitionId: null, submittedAt: AFTER }]);
    expect(r1MeetDexFeedbackCards([entry({ feedbackFormDefinitionId: null })], QUERY)).toStrictEqual([{ formDefinitionId: null, submittedAt: AFTER }]);
  });

  it('Dex is matched by the submitter OR the credited user, case ignored; ids come back lower-cased', () => {
    const upper = DEX_USER_ID.toUpperCase();
    expect(r1MeetDexFeedbackCards([entry({ submittedByUser: { id: OTHER_USER_ID }, creditedToUser: { id: upper } })], QUERY)).toStrictEqual([CARD]);
    expect(r1MeetDexFeedbackCards([entry({ submittedByUser: { id: upper }, creditedToUser: undefined })], QUERY)).toStrictEqual([CARD]);
    expect(r1MeetDexFeedbackCards([entry({ submittedByUser: null, creditedToUser: { id: DEX_USER_ID } })], QUERY)).toStrictEqual([CARD]);
    expect(r1MeetDexFeedbackCards([entry()], { dexUserId: upper, since: SINCE })).toStrictEqual([CARD]);
    expect(r1MeetDexFeedbackCards([entry({ feedbackFormDefinitionId: FORM_ID.toUpperCase() })], QUERY)).toStrictEqual([CARD]);
  });

  it('only cards at or after since; times are compared as instants and returned in UTC', () => {
    expect(r1MeetDexFeedbackCards([entry({ submittedAt: new Date(SINCE_MS - 1).toISOString() })], QUERY)).toStrictEqual([]);
    expect(r1MeetDexFeedbackCards([entry({ submittedAt: SINCE })], QUERY)).toStrictEqual([{ formDefinitionId: FORM_ID, submittedAt: SINCE }]);
    // 15:30 in India is 10:00 UTC: the same instant as SINCE.
    expect(r1MeetDexFeedbackCards([entry({ submittedAt: '2026-11-20T15:30:00+05:30' })], QUERY)).toStrictEqual([{ formDefinitionId: FORM_ID, submittedAt: SINCE }]);
    expect(r1MeetDexFeedbackCards([entry({ submittedAt: '2026-11-20T15:29:59+05:30' })], QUERY)).toStrictEqual([]);
    // A since with an offset is the same instant too.
    expect(r1MeetDexFeedbackCards([entry()], { dexUserId: DEX_USER_ID, since: '2026-11-20T15:30:00+05:30' })).toStrictEqual([CARD]);
  });

  it("another interviewer's entry is skipped, even when malformed everywhere else", () => {
    const other = entry({
      submittedByUser: { id: OTHER_USER_ID, email: LIST_SENTINELS.email },
      creditedToUser: { id: 'not-a-uuid' },
      submittedAt: 'garbage',
      feedbackFormDefinitionId: 42,
      submittedValues: 'anything',
    });
    expect(r1MeetDexFeedbackCards([other], QUERY)).toStrictEqual([]);
    expect(r1MeetDexFeedbackCards([other, entry()], QUERY)).toStrictEqual([CARD]);
  });

  it('an entry or user with another prototype is unreadable (never an inherited key); a null-prototype entry is read', () => {
    const inherited = Object.create({ submittedByUser: { id: DEX_USER_ID }, submittedAt: AFTER }) as Record<string, unknown>;
    readerThrows([inherited]);
    const inheritedUser = Object.create({ id: DEX_USER_ID }) as Record<string, unknown>;
    readerThrows([entry({ submittedByUser: inheritedUser, creditedToUser: inheritedUser })]);
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, entry());
    expect(r1MeetDexFeedbackCards([nullProto], QUERY)).toStrictEqual([CARD]);
  });

  it('the answer is frozen and carries the two fields only', () => {
    const cards = r1MeetDexFeedbackCards([entry(), entry({ feedbackFormDefinitionId: null })], QUERY);
    expect(Object.isFrozen(cards)).toBe(true);
    for (const card of cards) {
      expect(Object.isFrozen(card)).toBe(true);
      expect(Object.keys(card)).toEqual(['formDefinitionId', 'submittedAt']);
    }
    const text = JSON.stringify(cards);
    for (const sentinel of Object.values(LIST_SENTINELS)) expect(text).not.toContain(sentinel);
    expect(text).not.toContain(DEX_USER_ID);
    expect(text).not.toContain(APPLICATION_ID);
  });

  it('refuses a query that is not a UUID and a zoned instant', () => {
    for (const [query, code] of [
      [{ dexUserId: 'dex', since: SINCE }, 'invalid_dex_user_id'],
      [{ dexUserId: DEX_USER_ID, since: '2026-11-20' }, 'invalid_since'],
    ] as const) {
      let thrown: unknown;
      try {
        r1MeetDexFeedbackCards([entry()], query);
      } catch (error) {
        thrown = error;
      }
      expect(isAshbyError(thrown) && `${thrown.category}/${thrown.code}`).toBe(`invalid_request/${code}`);
    }
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('r1MeetAshbyClientLogger', () => {
  it('maps the client records to closed lines', () => {
    const { log, lines } = capture();
    const logger = r1MeetAshbyClientLogger(log);
    logger.event({ operation: 'applicationFeedback.submit', attempt: 1, outcome: 'success', httpStatus: 200, durationMs: 12 });
    logger.event({ operation: 'applicationFeedback.submit', attempt: 1, outcome: 'retry', category: 'rate_limited', httpStatus: 429, durationMs: 3 });
    logger.event({ operation: 'feedbackFormDefinition.info', attempt: 1, outcome: 'failure', category: 'network', durationMs: 5 });
    expect(lines).toEqual([
      { level: 'info', meta: { error_category: 'r1_meet_ashby_ok', error_type: 'applicationFeedback.submit', http_status: 200 } },
      { level: 'warn', meta: { error_category: 'r1_meet_ashby_failed', error_type: 'applicationFeedback.submit:rate_limited', http_status: 429 } },
      { level: 'warn', meta: { error_category: 'r1_meet_ashby_failed', error_type: 'feedbackFormDefinition.info:network' } },
    ]);
  });

  it('no line from a whole run holds an id, a path, the key, the auth header or any part of the card', async () => {
    const form = await liveForm();
    const request = cardRequest(form);
    const all: Line[] = [];
    const runs: Array<readonly Step[]> = [
      [ok(DEFINITION)],
      [ok({ submittedFormInstance: { id: 'sfi-1' } })],
      [res(429, '{}')],
      [res(500, '')],
      [res(400, JSON.stringify({ errors: ['invalid_input'] }))],
      [res(200, JSON.stringify({ success: false, errors: ['feedback_not_editable'] }))],
      [new Error(`network down ${API_KEY}`)],
    ];
    let authHeader = '';
    for (const [i, steps] of runs.entries()) {
      const run = port(steps);
      await (i === 0 ? run.port.readForm(FORM_ID) : run.port.submit(request)).catch(() => undefined);
      authHeader = run.calls[0]!.headers.authorization ?? authHeader;
      all.push(...run.lines);
    }
    expect(all.length).toBeGreaterThanOrEqual(runs.length);
    const text = JSON.stringify(all);
    const forbidden = [
      API_KEY, authHeader, authHeader.replace(/^Basic /, ''), 'Basic', 'authorization',
      FORM_ID, ROUND_ID, APPLICATION_ID, EVENT_ID, DEX_USER_ID, 'sfi-1',
      'summary_path', 'report_path', 'metric_path', 'overall_recommendation', 'hello.example.test',
      'Rationale', 'Lexy (AI interviewer)', '/',
    ];
    expect(authHeader.startsWith('Basic ')).toBe(true);
    for (const needle of forbidden) expect(text, needle).not.toContain(needle);
    for (const { meta } of all) {
      expect(Object.keys(meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key))).toBe(true);
      expect(meta.error_category).toMatch(/^r1_meet_ashby_(ok|failed)$/);
      expect(meta.error_type ?? '').toMatch(/^(applicationFeedback\.submit|feedbackFormDefinition\.info)(:[a-z_]+)?$/);
    }
  });
});
