/**
 * Typed Ashby client foundation — unit + negative controls.
 *
 * Fully deterministic: the network is replaced by a scripted transport, sleep
 * is a no-op (no unbounded waiting), jitter is fixed, and the logger is a
 * capturing sink. Synthetic IDs/data only. Covers every required invariant and
 * negative control, including a secret/contact/resume-URL/sync-token canary
 * control proving neither logs nor thrown/serialized errors leak sensitive data.
 */

import { describe, it, expect } from 'vitest';
import {
  AshbyClient,
  createAshbyClient,
  AshbyError,
  isAshbyError,
  ASHBY_API_BASE_URL,
  createMetadataLogger,
  type AshbyTransport,
  type AshbyTransportRequest,
  type AshbyTransportResponse,
  type AshbyLogRecord,
} from '../integrations/ashby/index.js';

// ── Transport scripting ───────────────────────────────────────────────────

type Step = AshbyTransportResponse | Error | 'abort';

function res(status: number, body: string, headers: Record<string, string> = {}): AshbyTransportResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function ok(results: unknown, extra: Record<string, unknown> = {}): AshbyTransportResponse {
  return res(200, JSON.stringify({ success: true, results, ...extra }));
}

function scripted(steps: Step[]) {
  const calls: AshbyTransportRequest[] = [];
  let i = 0;
  const transport: AshbyTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === 'abort') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (step instanceof Error) throw step;
    return step;
  };
  return { transport, calls, count: () => i };
}

const sleeps: number[][] = [];
function makeClient(steps: Step[], overrides: Record<string, unknown> = {}) {
  const s = scripted(steps);
  const sleepLog: number[] = [];
  sleeps.push(sleepLog);
  const logs: AshbyLogRecord[] = [];
  const client = new AshbyClient({
    apiKey: 'synthetic-key',
    transport: s.transport,
    random: () => 0.5,
    sleep: async (ms: number) => { sleepLog.push(ms); },
    logger: { event: (r) => logs.push(r) },
    ...overrides,
  });
  return { client, calls: s.calls, count: s.count, sleepLog, logs };
}

// ── Construction / base-URL allowlist ──────────────────────────────────────

describe('construction', () => {
  it('rejects a missing API key', () => {
    expect(() => new AshbyClient({ apiKey: '' } as never)).toThrow(AshbyError);
  });

  it('rejects a non-allowlisted base URL without an injected transport', () => {
    let thrown: unknown;
    try { new AshbyClient({ apiKey: 'k', baseUrl: 'https://evil.example.com' }); } catch (e) { thrown = e; }
    expect(isAshbyError(thrown)).toBe(true);
    expect((thrown as AshbyError).code).toBe('base_url_not_allowlisted');
  });

  it('accepts the default allowlisted origin', () => {
    const c = new AshbyClient({ apiKey: 'k' });
    expect(c).toBeInstanceOf(AshbyClient);
    expect(ASHBY_API_BASE_URL).toBe('https://api.ashbyhq.com');
  });

  it('permits a custom base URL only alongside an injected transport (test seam)', () => {
    const { transport } = scripted([ok({})]);
    expect(() => new AshbyClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9', transport })).not.toThrow();
  });

  it('createAshbyClient factory works', () => {
    expect(createAshbyClient({ apiKey: 'k' })).toBeInstanceOf(AshbyClient);
  });
});

// ── HTTP Basic auth ────────────────────────────────────────────────────────

describe('HTTP Basic auth', () => {
  it('uses the API key as username with an empty password and never puts it in URL/body', async () => {
    const { client, calls } = makeClient([ok({ id: 'a' })]);
    await client.applicationInfo('app_1');
    const req = calls[0];
    expect(req.headers.authorization.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(req.headers.authorization.slice('Basic '.length), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    expect(decoded.slice(0, idx)).toBe('synthetic-key'); // username = API key
    expect(decoded.slice(idx + 1)).toBe('');              // empty password
    // Credential never leaks into URL or body.
    expect(req.url).not.toContain('synthetic-key');
    expect(req.body).not.toContain('synthetic-key');
    expect(req.url).toBe('https://api.ashbyhq.com/application.info');
  });
});

// ── Envelope parsing ───────────────────────────────────────────────────────

describe('envelope parsing', () => {
  it('returns results and pagination primitives on success', async () => {
    const { client } = makeClient([ok([{ id: 'x' }], { moreDataAvailable: true, nextCursor: 'c1', syncToken: 'st1' })]);
    const r = await client.applicationList();
    expect(r.results).toEqual([{ id: 'x' }]);
    expect(r.moreDataAvailable).toBe(true);
    expect(r.nextCursor).toBe('c1');
    expect(r.syncToken).toBe('st1');
  });

  it('200 + success:false is a typed failure, not success, and is not retried', async () => {
    const { client, count } = makeClient([res(200, JSON.stringify({ success: false, errors: [{ code: 'bad_field', message: 'x' }] }))]);
    const err = await client.applicationInfo('app_1').catch((e) => e);
    expect(isAshbyError(err)).toBe(true);
    expect((err as AshbyError).category).toBe('logical_failure');
    expect((err as AshbyError).endpointCodes).toEqual(['bad_field']); // code only, message dropped
    expect(count()).toBe(1);
  });

  it('200 malformed JSON fails closed (no retry)', async () => {
    const { client, count } = makeClient([res(200, 'not-json{')]);
    const err = await client.applicationInfo('app_1').catch((e) => e);
    expect((err as AshbyError).category).toBe('malformed_response');
    expect((err as AshbyError).code).toBe('invalid_json');
    expect(count()).toBe(1);
  });

  it('200 valid JSON but non-boolean success is a malformed envelope', async () => {
    const { client } = makeClient([res(200, JSON.stringify({ results: {} }))]);
    const err = await client.applicationInfo('app_1').catch((e) => e);
    expect((err as AshbyError).category).toBe('malformed_response');
    expect((err as AshbyError).code).toBe('invalid_envelope');
  });
});

// ── HTTP error classes ─────────────────────────────────────────────────────

describe('HTTP error classification', () => {
  for (const status of [400, 401, 403, 404, 405, 410]) {
    it(`${status} is a permanent client error and is not retried`, async () => {
      const { client, count } = makeClient([res(status, JSON.stringify({ success: false }))]);
      const err = await client.applicationInfo('app_1').catch((e) => e);
      expect((err as AshbyError).category).toBe('http_client_error');
      expect((err as AshbyError).httpStatus).toBe(status);
      expect((err as AshbyError).retriable).toBe(false);
      expect(count()).toBe(1);
    });
  }

  it('429 retries within caps and succeeds', async () => {
    const { client, count, sleepLog } = makeClient([res(429, '', { 'retry-after': '2' }), ok({ id: 'a' })]);
    const r = await client.applicationInfo('app_1');
    expect(r.results).toEqual({ id: 'a' });
    expect(count()).toBe(2);
    expect(sleepLog[0]).toBe(2000); // honored bounded Retry-After
  });

  it('429 Retry-After is bounded by the cap', async () => {
    const { client, sleepLog } = makeClient(
      [res(429, '', { 'retry-after': '100000' }), ok({})],
      { maxRetryAfterMs: 30_000 },
    );
    await client.applicationInfo('app_1');
    expect(sleepLog[0]).toBe(30_000); // clamped
  });

  it('429 with a non-numeric Retry-After falls back to bounded backoff', async () => {
    const { client, sleepLog } = makeClient([res(429, '', { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' }), ok({})]);
    await client.applicationInfo('app_1');
    // backoff = base(500)*2^0 * jitter(0.75) = 375
    expect(sleepLog[0]).toBe(375);
  });

  it('transient 5xx retries then succeeds', async () => {
    const { client, count } = makeClient([res(503, ''), ok({ id: 'a' })]);
    const r = await client.applicationInfo('app_1');
    expect(r.results).toEqual({ id: 'a' });
    expect(count()).toBe(2);
  });

  it('exhausting retries yields retry_exhausted', async () => {
    const { client, count } = makeClient([res(503, '')], { maxAttempts: 3 });
    const err = await client.applicationInfo('app_1').catch((e) => e);
    expect((err as AshbyError).category).toBe('retry_exhausted');
    expect(count()).toBe(3);
  });
});

// ── Retry safety: reads vs mutations ───────────────────────────────────────

describe('retry safety', () => {
  it('a read op retries on network error', async () => {
    const { client, count } = makeClient([new Error('econn'), ok({ id: 'a' })]);
    const r = await client.applicationInfo('app_1');
    expect(r.results).toEqual({ id: 'a' });
    expect(count()).toBe(2);
  });

  it('a read op retries on timeout (abort)', async () => {
    const { client, count } = makeClient(['abort', ok({ id: 'a' })]);
    const r = await client.applicationInfo('app_1');
    expect(count()).toBe(2);
    expect(r.results).toEqual({ id: 'a' });
  });

  it('a mutation is NOT retried on ambiguous network failure (fail closed)', async () => {
    const { client, count } = makeClient([new Error('econn'), ok({ id: 'a' })]);
    const err = await client.applicationChangeStage('app_1', 'stage_2').catch((e) => e);
    expect((err as AshbyError).category).toBe('network');
    expect((err as AshbyError).retriable).toBe(false);
    expect(count()).toBe(1); // never re-sent
  });

  it('a mutation is NOT retried on timeout (fail closed)', async () => {
    const { client, count } = makeClient(['abort', ok({})]);
    const err = await client.applicationFeedbackSubmit({ applicationId: 'a', formDefinitionId: 'f', feedbackForm: {} }).catch((e) => e);
    expect((err as AshbyError).category).toBe('timeout');
    expect(count()).toBe(1);
  });

  it('a mutation retries only when an explicit idempotency strategy is supplied', async () => {
    const { client, count } = makeClient([new Error('econn'), ok({ moved: true })]);
    const r = await client.request('application.changeStage', { applicationId: 'a', interviewStageId: 's' }, { idempotent: true });
    expect(r.results).toEqual({ moved: true });
    expect(count()).toBe(2);
  });
});

// ── Output limit ───────────────────────────────────────────────────────────

describe('output limit', () => {
  it('rejects an oversized response body', async () => {
    const big = JSON.stringify({ success: true, results: 'x'.repeat(3000) });
    const { client } = makeClient([res(200, big)], { maxResponseBytes: 1024 });
    const err = await client.applicationInfo('app_1').catch((e) => e);
    expect((err as AshbyError).category).toBe('output_limit');
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe('input validation', () => {
  it('rejects empty / control-char / oversized ids without hitting the network', async () => {
    const { client, count } = makeClient([ok({})]);
    await expect(client.applicationInfo('')).rejects.toMatchObject({ category: 'invalid_request' });
    await expect(client.applicationInfo('ab')).rejects.toMatchObject({ code: 'id_control_char' });
    await expect(client.applicationInfo('a'.repeat(300))).rejects.toMatchObject({ code: 'id_too_long' });
    expect(count()).toBe(0);
  });

  it('rejects an oversized request body', async () => {
    const { client, count } = makeClient([ok({})]);
    const huge = { blob: 'y'.repeat(300 * 1024) };
    await expect(client.applicationInfo('app_1', huge)).rejects.toMatchObject({ code: 'body_too_large' });
    expect(count()).toBe(0);
  });

  it('file.info returns metadata only and never fetches the URL (single call)', async () => {
    const { client, count } = makeClient([ok({ url: 'https://files.example/presigned', handle: 'h' })]);
    const r = await client.fileInfo('file_handle_1');
    expect((r.results as Record<string, unknown>).url).toBe('https://files.example/presigned');
    expect(count()).toBe(1); // no second request to fetch the URL
  });
});

// ── Pagination ─────────────────────────────────────────────────────────────

describe('pagination', () => {
  it('aggregates pages until exhausted and surfaces the final sync token', async () => {
    const { client, logs } = makeClient([
      ok([{ id: 1 }], { moreDataAvailable: true, nextCursor: 'c1' }),
      ok([{ id: 2 }], { moreDataAvailable: true, nextCursor: 'c2' }),
      ok([{ id: 3 }], { moreDataAvailable: false, syncToken: 'sync_final' }),
    ]);
    const out = await client.listAllApplications();
    expect(out.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(out.pagesFetched).toBe(3);
    expect(out.syncToken).toBe('sync_final');
    // Sync token is opaque and must never appear in logs.
    expect(JSON.stringify(logs)).not.toContain('sync_final');
  });

  it('detects a repeated cursor and fails closed', async () => {
    const { client } = makeClient([
      ok([{ id: 1 }], { moreDataAvailable: true, nextCursor: 'loop' }),
      ok([{ id: 2 }], { moreDataAvailable: true, nextCursor: 'loop' }),
    ]);
    const err = await client.listAllApplications().catch((e) => e);
    expect((err as AshbyError).code).toBe('cursor_loop_detected');
  });

  it('enforces the page cap deterministically', async () => {
    const { client } = makeClient([ok([{ id: 1 }], { moreDataAvailable: true, nextCursor: 'c' })]);
    // Distinct cursors each page so the loop guard is not what stops it.
    let n = 0;
    const t: AshbyTransport = async () => ok([{ id: n }], { moreDataAvailable: true, nextCursor: `c${n++}` });
    const c = new AshbyClient({ apiKey: 'k', transport: t, sleep: async () => {}, random: () => 0.5 });
    const err = await c.listAllApplications({}, { maxPages: 3 }).catch((e) => e);
    expect((err as AshbyError).code).toBe('page_cap_exceeded');
  });

  it('enforces the item cap deterministically', async () => {
    const t: AshbyTransport = async () => ok([{ a: 1 }, { a: 2 }], { moreDataAvailable: true, nextCursor: `c${Math.random()}` });
    const c = new AshbyClient({ apiKey: 'k', transport: t, sleep: async () => {}, random: () => 0.5 });
    const err = await c.listAllApplications({}, { maxItems: 3, maxPages: 50 }).catch((e) => e);
    expect((err as AshbyError).code).toBe('item_cap_exceeded');
  });
});

// ── Typed endpoint helpers build the documented bodies ─────────────────────

describe('endpoint helpers', () => {
  it('feedback submit sends the verified fields and validates the form object', async () => {
    const { client, calls } = makeClient([ok({ id: 'fb' })]);
    await client.applicationFeedbackSubmit({
      applicationId: 'app_1', formDefinitionId: 'form_1',
      feedbackForm: { fieldSubmissions: [] }, userId: 'user_1', interviewEventId: 'ev_1',
    });
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({ applicationId: 'app_1', formDefinitionId: 'form_1', userId: 'user_1', interviewEventId: 'ev_1' });

    await expect(client.applicationFeedbackSubmit({ applicationId: 'a', formDefinitionId: 'f', feedbackForm: [] as never }))
      .rejects.toMatchObject({ code: 'invalid_feedback_form' });
  });

  it('changeStage validates both ids and posts to the fixed path', async () => {
    const { client, calls } = makeClient([ok({ moved: true })]);
    await client.applicationChangeStage('app_1', 'stage_2');
    expect(calls[0].url).toBe('https://api.ashbyhq.com/application.changeStage');
    expect(JSON.parse(calls[0].body)).toMatchObject({ applicationId: 'app_1', interviewStageId: 'stage_2' });
  });
});

// ── Metadata-only default logger ───────────────────────────────────────────

describe('createMetadataLogger', () => {
  it('emits only allowlisted metadata and no sensitive values', () => {
    const lines: string[] = [];
    const origOut = process.stdout.write;
    const origWarn = console.warn;
    process.stdout.write = ((s: string | Uint8Array) => { lines.push(String(s)); return true; }) as typeof process.stdout.write;
    console.warn = ((s?: unknown) => { lines.push(String(s)); }) as typeof console.warn;
    try {
      const logger = createMetadataLogger('ashby-client');
      logger.event({ operation: 'application.info', attempt: 1, outcome: 'success', httpStatus: 200, durationMs: 1200 });
      logger.event({ operation: 'application.changeStage', attempt: 2, outcome: 'failure', category: 'http_server_error', httpStatus: 503, durationMs: 50 });
    } finally {
      process.stdout.write = origOut;
      console.warn = origWarn;
    }
    const blob = lines.join('\n');
    expect(blob).toContain('application.info');
    expect(blob).toContain('http_server_error');
    // No body/credential fields could ever be present.
    expect(blob).not.toContain('synthetic-key');
  });
});

// ── Secret / contact / resume-URL / sync-token canary control ──────────────

describe('canary control — no leakage in logs or errors', () => {
  // Synthetic, low-entropy, hyphenated canaries: unique enough to detect a
  // leak, but not shaped like a real secret (so the repo secret scanner does
  // not flag the test itself).
  const CANARY_KEY = 'canary-do-not-log-this-api-credential';
  const CANARY_EMAIL = 'canary.person@example.com';
  const CANARY_RESUME_URL = 'https://files.ashby/canary-resume-do-not-log';
  const CANARY_SYNC = 'canary-do-not-log-this-sync-token';

  it('never emits the API key, contact data, resume URL, or sync token into logs or thrown/serialized errors', async () => {
    const logs: AshbyLogRecord[] = [];
    const errorsSeen: unknown[] = [];

    // Envelope carrying canary contact data in a message field (must be dropped).
    const failEnvelope = res(200, JSON.stringify({
      success: false,
      errors: [{ code: 'contact_rejected', message: `email ${CANARY_EMAIL}` }],
      errorInfo: { code: 'more_info', detail: CANARY_RESUME_URL },
    }));

    const steps: Step[] = [
      ok({ contact: CANARY_EMAIL, resume: CANARY_RESUME_URL }, { syncToken: CANARY_SYNC }), // success carrying canaries
      res(429, '', { 'retry-after': '1' }), ok({}),                                          // retry path
      res(500, ''), res(500, ''), res(500, ''),                                              // exhausted
      failEnvelope,                                                                          // logical failure w/ canary
      new Error('econn'),                                                                    // network
    ];
    const s = scripted(steps);
    const client = new AshbyClient({
      apiKey: CANARY_KEY,
      transport: s.transport,
      random: () => 0.5,
      sleep: async () => {},
      logger: { event: (r) => logs.push(r) },
      maxAttempts: 3,
    });

    // 1. success carrying canary payload + sync token
    const good = await client.applicationList({ extra: { contact: CANARY_EMAIL } });
    expect(good.syncToken).toBe(CANARY_SYNC); // surfaced to caller (that's allowed)
    // 2. retry then success
    await client.applicationInfo('app_1');
    // 3. exhausted
    errorsSeen.push(await client.applicationInfo('app_2').catch((e) => e));
    // 4. logical failure
    errorsSeen.push(await client.applicationInfo('app_3').catch((e) => e));
    // 5. network on a read (retried to exhaustion) — single-step Error repeats
    errorsSeen.push(await client.applicationInfo('app_4').catch((e) => e));

    const canaries = [CANARY_KEY, CANARY_EMAIL, CANARY_RESUME_URL, CANARY_SYNC];

    // Logs: metadata only — no canary anywhere.
    const logBlob = JSON.stringify(logs);
    for (const c of canaries) expect(logBlob).not.toContain(c);

    // Errors: message + toJSON + full serialization contain no canary.
    for (const err of errorsSeen) {
      expect(isAshbyError(err)).toBe(true);
      const e = err as AshbyError;
      const blob = `${e.message}\n${JSON.stringify(e.toJSON())}\n${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
      for (const c of canaries) expect(blob).not.toContain(c);
    }

    // The logical-failure error surfaces only the sanitized safe code.
    const logical = errorsSeen[1] as AshbyError;
    expect(logical.category).toBe('logical_failure');
    expect(logical.endpointCodes).toContain('contact_rejected');
    expect(logical.endpointCodes).toContain('more_info');
  });
});
