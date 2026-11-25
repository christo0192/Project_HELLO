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
 */
import { describe, expect, it } from 'vitest';
import type { AshbyTransport, AshbyTransportRequest, AshbyTransportResponse } from '../integrations/ashby/client.js';
import { AshbyError, isAshbyError, type AshbyErrorCategory } from '../integrations/ashby/errors.js';
import type { ProbeFeedbackForm } from '../integrations/ashby/probe.js';
import {
  R1_MEET_ASHBY_CLIENT_SETTINGS,
  classifyR1MeetAshbyFailure,
  createR1MeetAshbyFeedbackPort,
  r1MeetAshbyClientLogger,
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
  'Dex (AI interviewer): R1 sales role-play over Google Meet. Verdict: Borderline. Weighted 2.65/4 across 4 of 5 metrics; 1 not scored (listed below).',
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
      'Rationale', 'Dex (AI interviewer)', '/',
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
