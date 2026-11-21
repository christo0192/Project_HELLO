/**
 * Recall.ai REST client (M034 S01 T3): request shapes, pre-transport refusals, the single-attempt
 * status taxonomy with bounded retry hints, deadline/size/shape failures, the closed Bot parser, a
 * secret canary over logs and errors, and an end-to-end run against the shared fake.
 *
 * Deterministic: the network is a scripted transport or `createFakeRecall`; nothing sleeps except
 * the timeout cases, which use a 20 ms deadline. Fixture keys are low-entropy.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  RECALL_MAX_REQUEST_BODY_BYTES,
  RecallClient,
  createRecallClient,
  isRecallIsoDateTime,
  parseRecallBot,
  type RecallLogRecord,
  type RecallTransport,
  type RecallTransportRequest,
  type RecallTransportResponse,
} from '../integrations/recall/client.js';
import { RecallError, isRecallError, sanitizeFieldCodes } from '../integrations/recall/errors.js';
import { RECALL_DEFAULT_BASE_URL } from '../integrations/recall/settings.js';
import type { RecallCreateBotRequest } from '../integrations/recall/types.js';
import { FAKE_RECALL_API_KEY, createFakeRecall } from './support/recall-fake.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const API_KEY = 'recall-test-' + 'k'.repeat(24);
const BOT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const IDEMPOTENCY = 'r1-meet-bot-test-v1';
const PAGE_URL = 'https://hello.example.test/candidate/r1/meet#t=fixture';

function createBody(overrides: Record<string, unknown> = {}): RecallCreateBotRequest {
  return {
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    bot_name: 'Dex',
    join_at: '2026-12-01T10:28:00.000Z',
    variant: { google_meet: 'web_4_core' },
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 900,
      everyone_left_timeout: { timeout: 90 },
      in_call_not_recording_timeout: 900,
      in_call_recording_timeout: 2700,
    },
    recording_config: {
      transcript: null,
      video_mixed_mp4: null,
      meeting_metadata: null,
      participant_events: {},
      start_recording_on: 'participant_join',
      retention: { type: 'timed', hours: 1 },
      realtime_endpoints: [
        {
          type: 'webhook',
          url: 'https://hello.example.test/api/integrations/recall/realtime',
          events: ['participant_events.join', 'participant_events.leave'],
        },
      ],
    },
    chat: { on_bot_join: { send_to: 'everyone', message: 'Dex is an AI interviewer from Interview Kickstart.', pin: true } },
    metadata: { booking_id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', profile: 'r1_dex_sales' },
    ...overrides,
  } as RecallCreateBotRequest;
}

function botJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOT_ID,
    meeting_url: { meeting_id: 'abc-defg-hij', platform: 'google_meet' },
    join_at: '2026-12-01T10:28:00.000Z',
    metadata: { booking_id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' },
    status_changes: [{ code: 'ready', sub_code: null, message: 'Bot is ready.', created_at: '2026-11-30T10:00:00.000000Z' }],
    recordings: [{ id: 'rec', media_shortcuts: {} }],
    ...overrides,
  };
}

type Step = RecallTransportResponse | Error | 'hang';

function res(status: number, body: unknown = '', headers: Record<string, string> = {}): RecallTransportResponse {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: { get: (name: string) => lower[name.toLowerCase()] ?? null }, text: async () => text };
}

function scripted(steps: Step[]) {
  const calls: RecallTransportRequest[] = [];
  let index = 0;
  const transport: RecallTransport = async (req) => {
    calls.push(req);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === 'hang') return new Promise<RecallTransportResponse>(() => {});
    if (step instanceof Error) throw step;
    return step;
  };
  return { transport, calls };
}

function makeClient(steps: Step[], overrides: Partial<ConstructorParameters<typeof RecallClient>[0]> = {}) {
  const { transport, calls } = scripted(steps);
  const logs: RecallLogRecord[] = [];
  const client = new RecallClient({
    apiKey: API_KEY,
    transport,
    logger: { event: (record) => logs.push(record) },
    ...overrides,
  });
  return { client, calls, logs };
}

async function failure(promise: Promise<unknown>): Promise<RecallError> {
  try {
    await promise;
  } catch (error) {
    expect(isRecallError(error)).toBe(true);
    return error as RecallError;
  }
  throw new Error('expected the call to fail');
}

/** Every method, as a thunk, with valid inputs. */
function everyOperation(client: RecallClient): Array<[string, () => Promise<unknown>]> {
  return [
    ['bot.create', () => client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY })],
    ['bot.get', () => client.getBot(BOT_ID)],
    ['bot.delete_scheduled', () => client.deleteScheduledBot(BOT_ID)],
    ['bot.leave_call', () => client.leaveCall(BOT_ID)],
    ['bot.output_media.start', () => client.startOutputMedia(BOT_ID, { cameraWebpageUrl: PAGE_URL })],
    ['bot.output_media.stop', () => client.stopOutputMedia(BOT_ID)],
  ];
}

// ── Construction ────────────────────────────────────────────────────────────

describe('RecallClient construction', () => {
  it('uses the Tokyo default origin when no base URL is given', async () => {
    const { client, calls } = makeClient([res(200, botJson())]);
    await client.getBot(BOT_ID);
    expect(RECALL_DEFAULT_BASE_URL).toBe('https://ap-northeast-1.recall.ai');
    expect(calls[0].url).toBe(`https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/`);
  });

  it('accepts another region and drops its trailing slash', async () => {
    const { client, calls } = makeClient([res(200, botJson())], { baseUrl: 'https://us-east-1.recall.ai/' });
    await client.getBot(BOT_ID);
    expect(calls[0].url).toBe(`https://us-east-1.recall.ai/api/v1/bot/${BOT_ID}/`);
  });

  it.each([
    ['', 'empty'],
    ['short-key', 'too short'],
    ['recall key with spaces 1234', 'whitespace'],
    ['k'.repeat(257), 'too long'],
  ])('rejects a malformed API key (%s: %s), even with a transport', (apiKey) => {
    const { transport } = scripted([res(200, botJson())]);
    let caught: unknown;
    try {
      new RecallClient({ apiKey, transport });
    } catch (error) {
      caught = error;
    }
    expect(isRecallError(caught)).toBe(true);
    expect(caught).toMatchObject({ category: 'invalid_request', code: 'api_key', operation: 'client_init' });
    if (apiKey.length > 0) expect(JSON.stringify(caught) + String(caught)).not.toContain(apiKey);
  });

  it('rejects a non-string key', () => {
    expect(() => new RecallClient({ apiKey: 42 as unknown as string })).toThrow(RecallError);
    expect(() => new RecallClient(undefined as unknown as { apiKey: string })).toThrow(RecallError);
  });

  it.each([
    'https://evil.example',
    'http://ap-northeast-1.recall.ai',
    'https://a.b.recall.ai',
    'https://recall.ai',
    'https://ap-northeast-1.recall.ai:8443',
    'https://ap-northeast-1.recall.ai/api',
    'https://user@ap-northeast-1.recall.ai',
  ])('rejects the base URL %s even when a test transport is injected', (baseUrl) => {
    const { transport, calls } = scripted([res(200, botJson())]);
    let caught: unknown;
    try {
      new RecallClient({ apiKey: API_KEY, baseUrl, transport });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ category: 'invalid_request', code: 'base_url', operation: 'client_init' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a transport that is not a function', () => {
    expect(() => new RecallClient({ apiKey: API_KEY, transport: {} as unknown as RecallTransport })).toThrow(RecallError);
  });

  it('keeps the key out of every view of the client object', () => {
    const client = createRecallClient({ apiKey: API_KEY, transport: scripted([res(200, botJson())]).transport });
    expect(client).toBeInstanceOf(RecallClient);
    expect(JSON.stringify(client)).not.toContain(API_KEY);
    expect(JSON.stringify({ ...client })).not.toContain(API_KEY);
    expect(Object.keys(client)).toEqual([]);
    expect(inspect(client, { showHidden: true, depth: 5 })).not.toContain(API_KEY);
  });
});

// ── Request shapes ──────────────────────────────────────────────────────────

describe('RecallClient request shapes', () => {
  it('createBot: POST /api/v1/bot/ with Token auth, JSON body and the Idempotency-Key', async () => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const bot = await client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY });
    expect(calls).toHaveLength(1);
    const [req] = calls;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://ap-northeast-1.recall.ai/api/v1/bot/');
    expect(req.headers).toEqual({
      authorization: `Token ${API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': IDEMPOTENCY,
    });
    expect(JSON.parse(req.body!)).toStrictEqual(JSON.parse(JSON.stringify(createBody())));
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(bot.id).toBe(BOT_ID);
  });

  it('getBot: GET with no body, no content-type and no Idempotency-Key', async () => {
    const { client, calls } = makeClient([res(200, botJson())]);
    await client.getBot(BOT_ID);
    const [req] = calls;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/`);
    expect('body' in req).toBe(false);
    expect(req.headers).toEqual({ authorization: `Token ${API_KEY}`, accept: 'application/json' });
  });

  it('deleteScheduledBot: DELETE /api/v1/bot/{id}/ with no body, resolving to void on 204', async () => {
    const { client, calls } = makeClient([res(204, '')]);
    await expect(client.deleteScheduledBot(BOT_ID)).resolves.toBeUndefined();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/`);
    expect('body' in calls[0]).toBe(false);
  });

  it('leaveCall: POST .../leave_call/ with no body; the Idempotency-Key only when given', async () => {
    const { client, calls } = makeClient([res(200, botJson())]);
    await client.leaveCall(BOT_ID);
    await client.leaveCall(BOT_ID, { idempotencyKey: 'leave-key-0001' });
    expect(calls.map((req) => [req.method, req.url])).toEqual([
      ['POST', `https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/leave_call/`],
      ['POST', `https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/leave_call/`],
    ]);
    expect('body' in calls[0]).toBe(false);
    expect(calls[0].headers).not.toHaveProperty('content-type');
    expect(calls[0].headers).not.toHaveProperty('idempotency-key');
    expect(calls[1].headers['idempotency-key']).toBe('leave-key-0001');
  });

  it('startOutputMedia: POST .../output_media/ with exactly the webpage camera body', async () => {
    const { client, calls } = makeClient([res(200, {})]);
    await expect(client.startOutputMedia(BOT_ID, { cameraWebpageUrl: PAGE_URL })).resolves.toBeUndefined();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/output_media/`);
    expect(calls[0].body).toBe(JSON.stringify({ camera: { kind: 'webpage', config: { url: PAGE_URL } } }));
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  it('stopOutputMedia: DELETE .../output_media/ with body {"camera":true}', async () => {
    const { client, calls } = makeClient([res(200, {})]);
    await client.stopOutputMedia(BOT_ID, { idempotencyKey: 'stop-key-0001' });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`https://ap-northeast-1.recall.ai/api/v1/bot/${BOT_ID}/output_media/`);
    expect(calls[0].body).toBe('{"camera":true}');
    expect(calls[0].headers['idempotency-key']).toBe('stop-key-0001');
  });

  it('accepts a minimal create body (only meeting_url)', async () => {
    const { client, calls } = makeClient([res(201, botJson())]);
    await client.createBot({ meeting_url: 'https://meet.google.com/abc-defg-hij' }, { idempotencyKey: IDEMPOTENCY });
    expect(calls[0].body).toBe('{"meeting_url":"https://meet.google.com/abc-defg-hij"}');
  });
});

// ── Pre-transport refusals ──────────────────────────────────────────────────

describe('RecallClient pre-transport validation (zero transport calls)', () => {
  it.each([
    ['missing options', undefined],
    ['missing key', {}],
    ['too short', { idempotencyKey: 'short' }],
    ['bad characters', { idempotencyKey: 'has spaces in it' }],
    ['too long', { idempotencyKey: 'k'.repeat(129) }],
    ['non-string', { idempotencyKey: 12345678 }],
  ])('createBot without a valid Idempotency-Key (%s)', async (_label, opts) => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const error = await failure(client.createBot(createBody(), opts as never));
    expect(error).toMatchObject({ category: 'invalid_request', code: 'idempotency_key', operation: 'bot.create' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['upper-case uuid', BOT_ID.toUpperCase()],
    ['path traversal', '../bot'],
    ['empty', ''],
    ['uuid with a slash', `${BOT_ID}/x`],
    ['non-string', 7],
  ])('every id method refuses a bad bot id (%s)', async (_label, badId) => {
    const { client, calls } = makeClient([res(200, botJson())]);
    const thunks: Array<() => Promise<unknown>> = [
      () => client.getBot(badId as string),
      () => client.deleteScheduledBot(badId as string),
      () => client.leaveCall(badId as string),
      () => client.startOutputMedia(badId as string, { cameraWebpageUrl: PAGE_URL }),
      () => client.stopOutputMedia(badId as string),
    ];
    for (const thunk of thunks) {
      expect(await failure(thunk())).toMatchObject({ category: 'invalid_request', code: 'bot_id' });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an optional Idempotency-Key that is malformed', async () => {
    const { client, calls } = makeClient([res(200, botJson())]);
    expect(await failure(client.leaveCall(BOT_ID, { idempotencyKey: 'bad key!' }))).toMatchObject({ code: 'idempotency_key' });
    expect(await failure(client.stopOutputMedia(BOT_ID, { idempotencyKey: 'x' }))).toMatchObject({ code: 'idempotency_key' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a LiveKit hand-off (cast)', { camera: { kind: 'livekit', config: { agent_name: 'dex', room: 'r' } } }],
    ['a LiveKit kind with a url', { camera: { kind: 'livekit', config: { url: PAGE_URL } } }],
    ['pipecat', { camera: { kind: 'pipecat', config: { url: PAGE_URL } } }],
    ['a screenshare channel', { camera: { kind: 'webpage', config: { url: PAGE_URL } }, screenshare: { kind: 'webpage', config: { url: PAGE_URL } } }],
    ['screenshare only', { screenshare: { kind: 'webpage', config: { url: PAGE_URL } } }],
    ['extra config keys', { camera: { kind: 'webpage', config: { url: PAGE_URL, agent_name: 'dex' } } }],
    ['extra camera keys', { camera: { kind: 'webpage', config: { url: PAGE_URL }, room: 'r' } }],
    ['null', null],
    ['a string', 'webpage'],
  ])('refuses output media that is not exactly a webpage camera: %s', async (_label, outputMedia) => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const error = await failure(
      client.createBot(createBody({ output_media: outputMedia }), { idempotencyKey: IDEMPOTENCY }),
    );
    expect(error).toMatchObject({ category: 'invalid_request', code: 'output_media_kind' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['http', 'http://hello.example.test/candidate/r1/meet'],
    ['userinfo', 'https://user:pass@hello.example.test/meet'],
    ['too long', `https://hello.example.test/${'a'.repeat(2030)}`],
    ['whitespace', 'https://hello.example.test/a b'],
    ['not a URL', 'nope'],
    ['javascript', 'javascript:alert(1)'],
  ])('refuses an output-media page URL that is %s', async (_label, url) => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const viaCreate = await failure(
      client.createBot(
        createBody({ output_media: { camera: { kind: 'webpage', config: { url } } } }),
        { idempotencyKey: IDEMPOTENCY },
      ),
    );
    expect(viaCreate).toMatchObject({ category: 'invalid_request', code: 'output_media_url' });
    const viaStart = await failure(client.startOutputMedia(BOT_ID, { cameraWebpageUrl: url }));
    expect(viaStart).toMatchObject({ category: 'invalid_request', code: 'output_media_url' });
    expect(calls).toHaveLength(0);
  });

  it('accepts a webpage camera with an https URL of exactly 2048 characters', async () => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const base = 'https://hello.example.test/';
    const url = base + 'a'.repeat(2048 - base.length);
    await client.createBot(createBody({ output_media: { camera: { kind: 'webpage', config: { url } } } }), {
      idempotencyKey: IDEMPOTENCY,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['upper-case code', 'https://meet.google.com/ABC-defg-hij'],
    ['a query', 'https://meet.google.com/abc-defg-hij?authuser=0'],
    ['a trailing slash', 'https://meet.google.com/abc-defg-hij/'],
    ['another platform', 'https://zoom.us/j/123'],
    ['a look-alike host', 'https://meet.google.com.evil.test/abc-defg-hij'],
    ['missing', undefined],
  ])('refuses a meeting URL that is not the canonical Meet link (%s)', async (_label, meetingUrl) => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const error = await failure(client.createBot(createBody({ meeting_url: meetingUrl }), { idempotencyKey: IDEMPOTENCY }));
    expect(error).toMatchObject({ category: 'invalid_request', code: 'meeting_url' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['variant', { variant: { google_meet: 'web_8_core' } }],
    ['variant', { variant: { zoom: 'web_4_core' } }],
    ['variant', { variant: { google_meet: 'web_4_core', zoom: 'web' } }],
    ['join_at', { join_at: 'tomorrow' }],
    ['join_at', { join_at: '2026-02-30T10:00:00Z' }],
    ['join_at', { join_at: '2026-12-01 10:28:00' }],
    ['join_at', { join_at: '2026-12-01T24:00:00Z' }],
    ['join_at', { join_at: 1796120880000 }],
    ['realtime_endpoint', { recording_config: { realtime_endpoints: [{ type: 'websocket', url: 'wss://x.example.test/' }] } }],
    ['realtime_endpoint', { recording_config: { realtime_endpoints: [{ type: 'webhook', url: 'http://x.example.test/' }] } }],
    ['realtime_endpoint', { recording_config: { realtime_endpoints: 'https://x.example.test/' } }],
    ['invalid_body', { recording_config: 'off' }],
  ])('refuses an invalid %s', async (code, overrides) => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const error = await failure(client.createBot(createBody(overrides), { idempotencyKey: IDEMPOTENCY }));
    expect(error).toMatchObject({ category: 'invalid_request', code });
    expect(calls).toHaveLength(0);
  });

  it('accepts a null recording config and an offset join_at', async () => {
    const { client, calls } = makeClient([res(201, botJson())]);
    await client.createBot(createBody({ recording_config: null, join_at: '2026-12-01T15:58:00+05:30' }), {
      idempotencyKey: IDEMPOTENCY,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a body over 64 KiB, a non-object body and an unserializable body', async () => {
    const { client, calls } = makeClient([res(201, botJson())]);
    const huge = createBody({ metadata: { note: 'x'.repeat(RECALL_MAX_REQUEST_BODY_BYTES) } });
    expect(await failure(client.createBot(huge, { idempotencyKey: IDEMPOTENCY }))).toMatchObject({ code: 'body_too_large' });
    expect(await failure(client.createBot(null as never, { idempotencyKey: IDEMPOTENCY }))).toMatchObject({ code: 'invalid_body' });
    expect(await failure(client.createBot([] as never, { idempotencyKey: IDEMPOTENCY }))).toMatchObject({ code: 'invalid_body' });
    const circular: Record<string, unknown> = { ...createBody() };
    circular.self = circular;
    expect(await failure(client.createBot(circular as never, { idempotencyKey: IDEMPOTENCY }))).toMatchObject({
      code: 'invalid_body',
    });
    expect(calls).toHaveLength(0);
  });

  it('logs a refusal as metadata only', async () => {
    const { client, logs } = makeClient([res(201, botJson())]);
    await failure(client.getBot('nope'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ operation: 'bot.get', outcome: 'failure', category: 'invalid_request' });
    expect(Object.keys(logs[0]).sort()).toEqual(['category', 'durationMs', 'operation', 'outcome']);
  });
});

// ── Status taxonomy ─────────────────────────────────────────────────────────

describe('RecallClient status mapping (single attempt, bounded retry hints)', () => {
  it.each([
    [400, 'bad_request', false, null],
    [401, 'unauthorized', false, null],
    [402, 'payment_required', false, null],
    [403, 'forbidden', false, null],
    [404, 'not_found', false, null],
    [405, 'not_allowed', false, null],
    [409, 'conflict', true, 5_000],
    [410, 'http_client_error', false, null],
    [418, 'http_client_error', false, null],
    [422, 'http_client_error', false, null],
    [429, 'rate_limited', true, 30_000],
    [500, 'http_server_error', true, 10_000],
    [502, 'http_server_error', true, 10_000],
    [503, 'http_server_error', true, 10_000],
    [504, 'http_server_error', true, 10_000],
    [507, 'capacity_exhausted', true, 30_000],
    [301, 'malformed_response', false, null],
    [100, 'malformed_response', false, null],
  ])('%i → %s (retriable %s, retryAfterMs %s) on every operation, with exactly one call each', async (status, category, retriable, retryAfter) => {
    const { client, calls, logs } = makeClient([res(status, '{"detail":"x"}')]);
    const operations = everyOperation(client);
    for (const [operation, thunk] of operations) {
      const error = await failure(thunk());
      expect(error.category).toBe(category);
      expect(error.httpStatus).toBe(status);
      expect(error.operation).toBe(operation);
      expect(error.retriable).toBe(retriable);
      expect(error.retryAfterMs).toBe(retryAfter);
      expect(error.message).toBe(`recall_${category}`);
    }
    expect(calls).toHaveLength(operations.length);
    expect(logs.map((record) => record.outcome)).toEqual(operations.map(() => 'failure'));
    expect(logs.every((record) => record.httpStatus === status && record.category === category)).toBe(true);
  });

  it('405 on DELETE of a dispatched bot is not_allowed/bot_already_dispatched; elsewhere the code stays not_allowed', async () => {
    const { client } = makeClient([res(405, '{"detail":"Method \\"DELETE\\" not allowed."}')]);
    expect(await failure(client.deleteScheduledBot(BOT_ID))).toMatchObject({
      category: 'not_allowed',
      code: 'bot_already_dispatched',
      retriable: false,
    });
    expect(await failure(client.leaveCall(BOT_ID))).toMatchObject({ category: 'not_allowed', code: 'not_allowed' });
  });

  it.each([
    [429, '7', 7_000],
    [429, '9999', 300_000],
    [429, '0', 1_000],
    [429, ' 12 ', 12_000],
    [429, 'Wed, 21 Oct 2026 07:28:00 GMT', 30_000],
    [429, '-5', 30_000],
    [429, '1.5', 30_000],
    [507, '45', 45_000],
    [507, 'soon', 30_000],
    [409, '2', 2_000],
    [503, '120', 120_000],
    [503, '301', 300_000],
  ])('%i with Retry-After %j → retryAfterMs %i', async (status, header, expected) => {
    const { client, calls } = makeClient([res(status, '', { 'Retry-After': header })]);
    const error = await failure(client.getBot(BOT_ID));
    expect(error.retriable).toBe(true);
    expect(error.retryAfterMs).toBe(expected);
    expect(calls).toHaveLength(1);
  });

  it('400 keeps only the top-level field names of the body, never its values', async () => {
    const body = {
      meeting_url: ['Enter a valid URL: https://meet.google.com/xqz-wvut-srp'],
      join_at: ['Must be in the future.'],
      'bad key with spaces': ['x'],
    };
    const { client } = makeClient([res(400, body)]);
    const error = await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }));
    expect(error).toMatchObject({ category: 'bad_request', code: 'bad_request', retriable: false, retryAfterMs: null });
    expect(error.fieldCodes).toEqual(['meeting_url', 'join_at']);
    const serialized = JSON.stringify(error) + String(error) + error.stack;
    expect(serialized).not.toContain('xqz-wvut-srp');
    expect(serialized).not.toContain('future');
  });

  it('caps fieldCodes at ten', async () => {
    const body = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field_${i}`, ['bad']]));
    const { client } = makeClient([res(400, body)]);
    const error = await failure(client.getBot(BOT_ID));
    expect(error.fieldCodes).toHaveLength(10);
    expect(error.fieldCodes[0]).toBe('field_0');
  });

  it('keeps a documented vendor code and drops any other code value', async () => {
    const known = makeClient([res(400, { code: 'cannot_command_completed_bot', detail: 'Cannot send a command.' })]);
    expect(await failure(known.client.leaveCall(BOT_ID))).toMatchObject({
      category: 'bad_request',
      code: 'cannot_command_completed_bot',
      fieldCodes: ['code', 'detail'],
    });
    const blocked = makeClient([res(403, { code: 'request_blocked', detail: 'WAF' })]);
    expect(await failure(blocked.client.getBot(BOT_ID))).toMatchObject({ category: 'forbidden', code: 'request_blocked' });
    const unknown = makeClient([res(400, { code: 'xqz-wvut-srp' })]);
    const error = await failure(unknown.client.getBot(BOT_ID));
    expect(error.code).toBe('bad_request');
    expect(JSON.stringify(error)).not.toContain('xqz-wvut-srp');
  });

  it.each([
    [400, true],
    [401, true],
    [402, true],
    [403, true],
    [404, true],
    [405, true],
    [409, true],
    [410, true],
    [422, true],
    [429, false],
    [500, true],
    [501, true],
    [502, false],
    [503, false],
    [504, false],
    [507, false],
    [301, false],
  ])('a keyed POST answered %i → rotateIdempotencyKey %s; unkeyed calls and non-POSTs never', async (status, rotate) => {
    const { client } = makeClient([res(status, '{"detail":"x"}')]);
    const keyed = { idempotencyKey: IDEMPOTENCY };
    expect((await failure(client.createBot(createBody(), keyed))).rotateIdempotencyKey).toBe(rotate);
    expect((await failure(client.leaveCall(BOT_ID, keyed))).rotateIdempotencyKey).toBe(rotate);
    expect((await failure(client.startOutputMedia(BOT_ID, { cameraWebpageUrl: PAGE_URL }, keyed))).rotateIdempotencyKey).toBe(rotate);
    // Nothing is cached under a key that was not sent, and Recall's idempotency covers PUT/POST/PATCH only.
    expect((await failure(client.leaveCall(BOT_ID))).rotateIdempotencyKey).toBe(false);
    expect((await failure(client.getBot(BOT_ID))).rotateIdempotencyKey).toBe(false);
    expect((await failure(client.deleteScheduledBot(BOT_ID))).rotateIdempotencyKey).toBe(false);
    expect((await failure(client.stopOutputMedia(BOT_ID, keyed))).rotateIdempotencyKey).toBe(false);
  });

  it.each([
    ['plain text', 'Another request with this Idempotency-Key is being processed. Retry later.'],
    ['a JSON detail', { detail: 'Another request with this Idempotency-Key is being processed.' }],
    ['a JSON message, other case, leading space', { message: '  another request with this idempotency-key is being processed' }],
  ])('a 409 saying the key is still being processed (%s) keeps the key and echoes nothing', async (_label, body) => {
    const { client } = makeClient([res(409, body)]);
    const error = await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }));
    expect(error).toMatchObject({
      category: 'conflict',
      code: 'idempotency_in_progress',
      retriable: true,
      retryAfterMs: 5_000,
      rotateIdempotencyKey: false,
    });
    expect(JSON.stringify(error) + String(error)).not.toMatch(/another request/i);
  });

  it('a network failure, a timeout or a malformed 2xx keeps the key (the bot may already exist)', async () => {
    const keyed = { idempotencyKey: IDEMPOTENCY };
    const network = makeClient([new Error('ECONNRESET')]);
    expect(await failure(network.client.createBot(createBody(), keyed))).toMatchObject({ category: 'network', rotateIdempotencyKey: false });
    const slow = makeClient(['hang'], { timeoutMs: 20 });
    expect(await failure(slow.client.createBot(createBody(), keyed))).toMatchObject({ category: 'timeout', rotateIdempotencyKey: false });
    const garbled = makeClient([res(201, 'not json')]);
    expect(await failure(garbled.client.createBot(createBody(), keyed))).toMatchObject({
      category: 'malformed_response',
      rotateIdempotencyKey: false,
    });
  });

  it('never retries: a retriable failure followed by success still costs one call per invocation', async () => {
    const { client, calls } = makeClient([res(503, ''), res(200, botJson())]);
    await failure(client.getBot(BOT_ID));
    expect(calls).toHaveLength(1);
    await expect(client.getBot(BOT_ID)).resolves.toMatchObject({ id: BOT_ID });
    expect(calls).toHaveLength(2);
  });
});

// ── Deadline, transport, size and shape failures ────────────────────────────

describe('RecallClient deadline, transport, size and shape failures', () => {
  it('times out a transport that never resolves (and ignores the abort signal)', async () => {
    const { client, calls } = makeClient(['hang'], { timeoutMs: 20 });
    const error = await failure(client.getBot(BOT_ID));
    expect(error).toMatchObject({ category: 'timeout', retriable: true, retryAfterMs: 5_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(true);
  });

  it('times out a transport that honours the signal', async () => {
    const transport: RecallTransport = (req) =>
      new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const client = new RecallClient({ apiKey: API_KEY, transport, timeoutMs: 20 });
    expect(await failure(client.deleteScheduledBot(BOT_ID))).toMatchObject({ category: 'timeout', retriable: true });
  });

  it('the deadline covers the body read', async () => {
    const stalled: RecallTransportResponse = {
      status: 200,
      headers: { get: () => null },
      text: () => new Promise<string>(() => {}),
    };
    const { client } = makeClient([stalled], { timeoutMs: 20 });
    expect(await failure(client.getBot(BOT_ID))).toMatchObject({ category: 'timeout', retriable: true });
  });

  it('maps a transport failure to network (retriable, 5 s) without its message', async () => {
    const { client, calls } = makeClient([new Error(`ECONNRESET ${API_KEY}`)]);
    const error = await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }));
    expect(error).toMatchObject({ category: 'network', retriable: true, retryAfterMs: 5_000, httpStatus: null });
    expect(JSON.stringify(error) + String(error)).not.toContain(API_KEY);
    expect(calls).toHaveLength(1);
  });

  it('maps a failing body read to network', async () => {
    const broken: RecallTransportResponse = {
      status: 200,
      headers: { get: () => null },
      text: async () => {
        throw new Error('socket hang up');
      },
    };
    const { client } = makeClient([broken]);
    expect(await failure(client.getBot(BOT_ID))).toMatchObject({ category: 'network', retriable: true });
  });

  it('caps the response body (output_limit), by the bytes read and by a declared length', async () => {
    const big = makeClient([res(200, JSON.stringify(botJson({ pad: 'x'.repeat(2048) })))], { maxResponseBytes: 1024 });
    expect(await failure(big.client.getBot(BOT_ID))).toMatchObject({ category: 'output_limit', retriable: false, httpStatus: 200 });

    let read = false;
    const declared: RecallTransportResponse = {
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(3 * 1024 * 1024) : null) },
      text: async () => {
        read = true;
        return '';
      },
    };
    const { client } = makeClient([declared]);
    expect(await failure(client.getBot(BOT_ID))).toMatchObject({ category: 'output_limit' });
    expect(read).toBe(false);
  });

  it('enforces the cap WHILE streaming a body that declares no length, without buffering it all', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(256).fill(0x61);
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    let textCalled = false;
    const streamed: RecallTransportResponse = {
      status: 200,
      headers: { get: () => null },
      body: endless,
      text: () => {
        textCalled = true;
        return new Promise<string>(() => {});
      },
    };
    const { client } = makeClient([streamed], { maxResponseBytes: 1024, timeoutMs: 2_000 });
    expect(await failure(client.getBot(BOT_ID))).toMatchObject({ category: 'output_limit', httpStatus: 200, retriable: false });
    expect(textCalled).toBe(false);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(8);
  });

  it('reads a streamed body under the cap, across chunk boundaries and with a byte-order mark', async () => {
    const bytes = new TextEncoder().encode('﻿' + JSON.stringify(botJson({ note: 'é'.repeat(50) })));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const streamed: RecallTransportResponse = {
      status: 200,
      headers: { get: () => null },
      body: stream,
      text: async () => {
        throw new Error('text() must not be used when a stream is available');
      },
    };
    const { client } = makeClient([streamed]);
    await expect(client.getBot(BOT_ID)).resolves.toMatchObject({ id: BOT_ID });
  });

  it('maps a failing or non-byte stream to network', async () => {
    const failing: RecallTransportResponse = {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('socket hang up'));
        },
      }),
      text: async () => '',
    };
    expect(await failure(makeClient([failing]).client.getBot(BOT_ID))).toMatchObject({ category: 'network', retriable: true });
    const strings: RecallTransportResponse = {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue('not bytes');
          controller.close();
        },
      }) as unknown as ReadableStream<Uint8Array>,
      text: async () => '',
    };
    expect(await failure(makeClient([strings]).client.getBot(BOT_ID))).toMatchObject({ category: 'network' });
  });

  it('the default cap is 2 MiB', async () => {
    const pad = 'x'.repeat(2 * 1024 * 1024);
    const { client } = makeClient([res(200, JSON.stringify(botJson({ pad })))]);
    expect(await failure(client.getBot(BOT_ID))).toMatchObject({ category: 'output_limit' });
    const under = makeClient([res(200, JSON.stringify(botJson({ pad: 'x'.repeat(1024 * 1024) })))]);
    await expect(under.client.getBot(BOT_ID)).resolves.toMatchObject({ id: BOT_ID });
  });

  it('non-JSON on a Bot operation is malformed_response/invalid_json; a non-Bot is invalid_bot', async () => {
    const { client } = makeClient([res(200, '<html>oops</html>')]);
    expect(await failure(client.getBot(BOT_ID))).toMatchObject({ category: 'malformed_response', code: 'invalid_json', httpStatus: 200 });
    const notBot = makeClient([res(201, { id: 'not-a-uuid', status_changes: [] })]);
    expect(await failure(notBot.client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }))).toMatchObject({
      category: 'malformed_response',
      code: 'invalid_bot',
    });
    const empty = makeClient([res(204, '')]);
    expect(await failure(empty.client.leaveCall(BOT_ID))).toMatchObject({ code: 'invalid_json' });
  });

  it('void operations ignore the body of any 2xx', async () => {
    const { client } = makeClient([res(202, 'not json')]);
    await expect(client.startOutputMedia(BOT_ID, { cameraWebpageUrl: PAGE_URL })).resolves.toBeUndefined();
    await expect(client.stopOutputMedia(BOT_ID)).resolves.toBeUndefined();
    await expect(client.deleteScheduledBot(BOT_ID)).resolves.toBeUndefined();
  });

  it('logs success as metadata only, and a throwing logger never breaks a call', async () => {
    const { client, logs } = makeClient([res(200, botJson())]);
    await client.getBot(BOT_ID);
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(['durationMs', 'httpStatus', 'operation', 'outcome']);
    expect(logs[0]).toMatchObject({ operation: 'bot.get', outcome: 'success', httpStatus: 200 });

    const throwing = makeClient([res(200, botJson())], {
      logger: {
        event: () => {
          throw new Error('sink down');
        },
      },
    });
    await expect(throwing.client.getBot(BOT_ID)).resolves.toMatchObject({ id: BOT_ID });
  });
});

// ── parseRecallBot ──────────────────────────────────────────────────────────

describe('parseRecallBot', () => {
  it('returns the closed shape and drops meeting_url, recordings, recording_config, output_media and messages', () => {
    const bot = parseRecallBot(
      botJson({
        recording_config: { realtime_endpoints: [] },
        output_media: { camera: { kind: 'webpage', config: { url: PAGE_URL } } },
        bot_name: 'Dex',
      }),
    );
    expect(bot).toStrictEqual({
      id: BOT_ID,
      joinAt: '2026-12-01T10:28:00.000Z',
      statusChanges: [{ code: 'ready', subCode: null, createdAt: '2026-11-30T10:00:00.000000Z' }],
      latestStatus: 'ready',
      metadata: { booking_id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' },
    });
    const text = JSON.stringify(bot);
    for (const dropped of ['meet.google', 'abc-defg-hij', 'recordings', 'output_media', 'hello.example.test', 'Bot is ready']) {
      expect(text).not.toContain(dropped);
    }
    expect(Object.isFrozen(bot)).toBe(true);
    expect(Object.isFrozen(bot!.statusChanges)).toBe(true);
    expect(Object.isFrozen(bot!.statusChanges[0])).toBe(true);
    expect(Object.isFrozen(bot!.metadata)).toBe(true);
  });

  it('keeps the last 50 well-formed status changes and reports the newest as latestStatus', () => {
    const changes = Array.from({ length: 60 }, (_, i) => ({
      code: `code_${i}`,
      sub_code: i % 2 === 0 ? `sub_${i}` : null,
      message: 'free text',
      created_at: `2026-12-01T10:${String(i).padStart(2, '0')}:00Z`,
    }));
    const bot = parseRecallBot(botJson({ status_changes: changes }))!;
    expect(bot.statusChanges).toHaveLength(50);
    expect(bot.statusChanges[0].code).toBe('code_10');
    expect(bot.statusChanges[0].subCode).toBe('sub_10');
    expect(bot.statusChanges[49]).toStrictEqual({ code: 'code_59', subCode: null, createdAt: '2026-12-01T10:59:00Z' });
    expect(bot.latestStatus).toBe('code_59');
  });

  it('drops malformed status changes and nulls a malformed sub-code', () => {
    const bot = parseRecallBot(
      botJson({
        status_changes: [
          { code: 'joining_call', sub_code: null, created_at: '2026-12-01T10:28:00Z' },
          { code: 'In Call', sub_code: null, created_at: '2026-12-01T10:29:00Z' },
          { code: 'x'.repeat(65), created_at: '2026-12-01T10:29:00Z' },
          { code: 'in_call_recording', sub_code: 'Has Spaces', created_at: '2026-12-01T10:30:00Z' },
          { code: 'call_ended', sub_code: 'ok', created_at: 'yesterday' },
          { code: 7, created_at: '2026-12-01T10:31:00Z' },
          'done',
          null,
        ],
      }),
    )!;
    expect(bot.statusChanges).toStrictEqual([
      { code: 'joining_call', subCode: null, createdAt: '2026-12-01T10:28:00Z' },
      { code: 'in_call_recording', subCode: null, createdAt: '2026-12-01T10:30:00Z' },
    ]);
    expect(bot.latestStatus).toBe('in_call_recording');
  });

  it('bounds metadata to 16 string entries with safe keys of at most 64 and values of at most 256 chars', () => {
    const metadata: Record<string, unknown> = {
      'bad key': 'x',
      ['k'.repeat(65)]: 'x',
      long_value: 'v'.repeat(257),
      number_value: 7,
      nested: { a: 'b' },
    };
    for (let i = 0; i < 20; i++) metadata[`key_${i}`] = `value_${i}`;
    const bot = parseRecallBot(botJson({ metadata }))!;
    expect(Object.keys(bot.metadata)).toHaveLength(16);
    expect(bot.metadata.key_0).toBe('value_0');
    expect(bot.metadata).not.toHaveProperty('long_value');
    expect(bot.metadata).not.toHaveProperty('number_value');
    expect(bot.metadata).not.toHaveProperty('bad key');
  });

  it('keeps a __proto__ metadata key as a plain entry without touching the prototype', () => {
    const bot = parseRecallBot(JSON.parse(JSON.stringify(botJson()).replace('"booking_id"', '"__proto__"')))!;
    expect(Object.getPrototypeOf(bot.metadata)).toBe(Object.prototype);
    expect(Object.keys(bot.metadata)).toEqual(['__proto__']);
  });

  it('empty or non-object metadata becomes {}; no status changes gives latestStatus null; a bad join_at is null', () => {
    expect(parseRecallBot(botJson({ metadata: null, status_changes: [], join_at: 'soon' }))).toStrictEqual({
      id: BOT_ID,
      joinAt: null,
      statusChanges: [],
      latestStatus: null,
      metadata: {},
    });
    expect(parseRecallBot(botJson({ metadata: ['a'] }))!.metadata).toStrictEqual({});
  });

  it.each([
    ['null', null],
    ['an array', [botJson()]],
    ['a string', 'bot'],
    ['an upper-case id', botJson({ id: BOT_ID.toUpperCase() })],
    ['a missing id', botJson({ id: undefined })],
    ['a numeric id', botJson({ id: 7 })],
    ['missing status_changes', botJson({ status_changes: undefined })],
    ['non-array status_changes', botJson({ status_changes: {} })],
  ])('returns null for %s', (_label, json) => {
    expect(parseRecallBot(json)).toBeNull();
  });
});

describe('isRecallIsoDateTime', () => {
  it.each([
    ['2026-12-01T10:28:00.000Z', true],
    ['2026-12-01T10:28:00Z', true],
    ['2026-12-01T10:28:00.123456Z', true],
    ['2026-12-01T15:58:00+05:30', true],
    ['2028-02-29T00:00:00Z', true],
    ['2026-02-29T00:00:00Z', false],
    ['2026-13-01T00:00:00Z', false],
    ['2026-12-01T10:60:00Z', false],
    ['2026-12-01T10:28:00+24:00', false],
    ['2026-12-01T10:28:00', false],
    ['2026-12-01', false],
    [' 2026-12-01T10:28:00Z', false],
    [null, false],
  ])('%j → %s', (raw, expected) => {
    expect(isRecallIsoDateTime(raw)).toBe(expected);
  });
});

// ── RecallError ─────────────────────────────────────────────────────────────

describe('RecallError', () => {
  it('serializes only sanitized fields with a fixed message', () => {
    const error = new RecallError('rate_limited', {
      code: 'rate_limited',
      httpStatus: 429,
      operation: 'bot.create',
      retriable: true,
      retryAfterMs: 7_000,
      fieldCodes: ['a'],
    });
    expect(error.message).toBe('recall_rate_limited');
    expect(error.name).toBe('RecallError');
    expect(error.toJSON()).toStrictEqual({
      name: 'RecallError',
      category: 'rate_limited',
      code: 'rate_limited',
      httpStatus: 429,
      operation: 'bot.create',
      retriable: true,
      retryAfterMs: 7_000,
      fieldCodes: ['a'],
      rotateIdempotencyKey: false,
    });
    const cached = new RecallError('http_server_error', { retriable: true, rotateIdempotencyKey: true });
    expect(cached.rotateIdempotencyKey).toBe(true);
    expect(cached.toJSON()).toMatchObject({ rotateIdempotencyKey: true });
    expect(new RecallError('bad_request', { rotateIdempotencyKey: 'yes' as never }).rotateIdempotencyKey).toBe(false);
  });

  it('drops unsafe codes and operations, nulls the hint of a non-retriable error, caps the hint', () => {
    const error = new RecallError('not_found', {
      code: 'has spaces',
      operation: 'https://evil.test/x',
      retryAfterMs: 5_000,
      httpStatus: 4040,
    });
    expect(error).toMatchObject({ code: 'not_found', operation: 'unknown', retryAfterMs: null, httpStatus: null, retriable: false });
    expect(new RecallError('timeout', { retriable: true, retryAfterMs: 10_000_000 }).retryAfterMs).toBe(300_000);
    expect(new RecallError('timeout', { retriable: true, retryAfterMs: -1 }).retryAfterMs).toBeNull();
  });

  it('sanitizeFieldCodes keeps at most ten distinct safe identifiers', () => {
    expect(sanitizeFieldCodes(['a', 'a', 'b c', 7, 'c'])).toEqual(['a', 'c']);
    expect(sanitizeFieldCodes(Array.from({ length: 30 }, (_, i) => `f${i}`))).toHaveLength(10);
    expect(sanitizeFieldCodes('a')).toEqual([]);
  });
});

// ── Secret canary ───────────────────────────────────────────────────────────

describe('Recall secret canary', () => {
  it('no key, Meet code, ticket or bot id reaches a log record or an error, on any path', async () => {
    const canaryKey = 'recall-canary-' + 'q'.repeat(20) + '-7731';
    const canaryCode = 'xqz-wvut-srp';
    const canaryTicket = 'tkt-canary-' + 'z'.repeat(12);
    const canaryBotId = 'cafe0000-1111-4222-8333-444455556666';
    const canaryPage = `https://hello.example.test/candidate/r1/meet#t=${canaryTicket}`;
    const canaries = [canaryKey, canaryCode, canaryTicket, canaryBotId];

    const echo = `${canaryKey} https://meet.google.com/${canaryCode} ${canaryTicket} ${canaryBotId}`;
    const responses: Step[] = [
      res(400, { meeting_url: [echo], code: echo }),
      res(401, { detail: echo }),
      res(403, { code: echo }),
      res(404, echo),
      res(405, echo),
      res(409, echo, { 'Retry-After': echo }),
      res(429, echo, { 'Retry-After': '3' }),
      res(500, echo),
      res(507, echo),
      res(200, `not json ${echo}`),
      res(200, { id: canaryBotId.toUpperCase(), note: echo }),
      new Error(echo),
      'hang',
      res(201, botJson({ id: canaryBotId, meeting_url: `https://meet.google.com/${canaryCode}` })),
      res(200, {}),
    ];
    const seen: string[] = [];
    for (const step of responses) {
      const logs: RecallLogRecord[] = [];
      const client = new RecallClient({
        apiKey: canaryKey,
        transport: scripted([step]).transport,
        logger: { event: (record) => logs.push(record) },
        timeoutMs: 20,
      });
      const thunks: Array<() => Promise<unknown>> = [
        () =>
          client.createBot(
            createBody({
              meeting_url: `https://meet.google.com/${canaryCode}`,
              output_media: { camera: { kind: 'webpage', config: { url: canaryPage } } },
            }),
            { idempotencyKey: IDEMPOTENCY },
          ),
        () => client.getBot(canaryBotId),
        () => client.leaveCall(canaryBotId),
        () => client.deleteScheduledBot(canaryBotId),
        () => client.startOutputMedia(canaryBotId, { cameraWebpageUrl: canaryPage }),
        () => client.stopOutputMedia(canaryBotId),
        // Refusals that carry the canaries in their input.
        () => client.startOutputMedia(canaryBotId, { cameraWebpageUrl: canaryPage.replace('https', 'http') }),
        () => client.getBot(canaryBotId.toUpperCase()),
        () => client.createBot(createBody({ meeting_url: `https://meet.google.com/${canaryCode.toUpperCase()}` }), {
          idempotencyKey: IDEMPOTENCY,
        }),
      ];
      for (const thunk of thunks) {
        try {
          await thunk();
        } catch (error) {
          expect(isRecallError(error)).toBe(true);
          const err = error as RecallError;
          seen.push(String(err), err.message, JSON.stringify(err), err.stack ?? '', inspect(err), err.code, err.operation);
        }
      }
      seen.push(JSON.stringify(logs), inspect(logs));
      seen.push(JSON.stringify(client), inspect(client, { showHidden: true }));
    }
    const corpus = seen.join('\n');
    expect(corpus.length).toBeGreaterThan(1000);
    for (const canary of canaries) {
      expect(corpus).not.toContain(canary);
      expect(corpus.toLowerCase()).not.toContain(canary.toLowerCase());
    }
  });
});

// ── Against the shared fake ─────────────────────────────────────────────────

describe('RecallClient against createFakeRecall', () => {
  it('create → replay returns the same bot → get → leave → delete after dispatch is 405', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });

    const created = await client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY });
    expect(created).toMatchObject({
      joinAt: '2026-12-01T10:28:00.000Z',
      latestStatus: 'ready',
      metadata: { booking_id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', profile: 'r1_dex_sales' },
    });
    const replayed = await client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY });
    expect(replayed.id).toBe(created.id);
    expect(fake.bots.size).toBe(1);
    const other = await client.createBot(createBody(), { idempotencyKey: `${IDEMPOTENCY}-2` });
    expect(other.id).not.toBe(created.id);
    expect(fake.bots.size).toBe(2);

    fake.setStatus(created.id, 'in_call_recording');
    const fetched = await client.getBot(created.id);
    expect(fetched.latestStatus).toBe('in_call_recording');

    await client.startOutputMedia(created.id, { cameraWebpageUrl: PAGE_URL });
    expect(fake.bots.get(created.id)!.outputMedia).toBe('webpage');
    await client.stopOutputMedia(created.id);
    expect(fake.bots.get(created.id)!.outputMedia).toBe('none');

    const left = await client.leaveCall(created.id);
    expect(left.latestStatus).toBe('call_ended');
    expect(left.statusChanges.at(-1)).toMatchObject({ code: 'call_ended', subCode: 'bot_received_leave_call' });

    expect(await failure(client.deleteScheduledBot(created.id))).toMatchObject({
      category: 'not_allowed',
      code: 'bot_already_dispatched',
      httpStatus: 405,
    });

    // The fake recorded what was sent, with the authorization value redacted.
    const create = fake.calls[0];
    expect(create).toMatchObject({ method: 'POST', path: '/api/v1/bot/' });
    expect(create.headers.authorization).toBe('<redacted>');
    expect(create.headers['idempotency-key']).toBe(IDEMPOTENCY);
    expect(create.body).toStrictEqual(JSON.parse(JSON.stringify(createBody())));
    expect(JSON.stringify(fake.calls)).not.toContain(FAKE_RECALL_API_KEY);
    expect(fake.calls.find((call) => call.method === 'GET')!.body).toBeNull();
    expect(fake.calls.at(-3)).toMatchObject({ method: 'DELETE', path: `/api/v1/bot/${created.id}/output_media/`, body: { camera: true } });
  });

  it('deletes a scheduled bot, after which it is not found; markDispatched makes delete 405', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    const first = await client.createBot(createBody(), { idempotencyKey: 'booking-a-v1' });
    await client.deleteScheduledBot(first.id);
    expect(fake.bots.has(first.id)).toBe(false);
    expect(await failure(client.getBot(first.id))).toMatchObject({ category: 'not_found', httpStatus: 404 });

    const second = await client.createBot(createBody(), { idempotencyKey: 'booking-b-v1' });
    fake.markDispatched(second.id);
    expect((await client.getBot(second.id)).latestStatus).toBe('joining_call');
    expect(await failure(client.deleteScheduledBot(second.id))).toMatchObject({ code: 'bot_already_dispatched' });
  });

  it('answers 401 to a wrong key and serves failNext once, caching a canned failure under its key like Recall', async () => {
    const fake = createFakeRecall();
    const wrong = new RecallClient({ apiKey: 'recall-wrong-' + 'w'.repeat(20), transport: fake.transport });
    expect(await failure(wrong.getBot(BOT_ID))).toMatchObject({ category: 'unauthorized', httpStatus: 401 });

    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    // 429 and 507 are never cached by Recall: the same key may be retried.
    fake.failNext(429, { headers: { 'Retry-After': '7' } });
    const limited = await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }));
    expect(limited).toMatchObject({ category: 'rate_limited', retriable: true, retryAfterMs: 7_000, rotateIdempotencyKey: false });
    fake.failNext(507);
    expect(await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }))).toMatchObject({
      category: 'capacity_exhausted',
      retryAfterMs: 30_000,
      rotateIdempotencyKey: false,
    });
    // A 500 IS cached under the key for an hour (reference_idempotency): the client says so ...
    fake.failNext(500, { body: { detail: 'boom' } });
    expect(await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }))).toMatchObject({
      category: 'http_server_error',
      retriable: true,
      retryAfterMs: 10_000,
      rotateIdempotencyKey: true,
    });
    // ... because the same key now replays the cached 500 instead of creating a bot.
    expect(await failure(client.createBot(createBody(), { idempotencyKey: IDEMPOTENCY }))).toMatchObject({
      category: 'http_server_error',
      rotateIdempotencyKey: true,
    });
    expect(fake.bots.size).toBe(0);
    // A new key creates exactly one bot.
    const bot = await client.createBot(createBody(), { idempotencyKey: `${IDEMPOTENCY}-k1` });
    expect(fake.bots.size).toBe(1);
    expect(fake.bots.has(bot.id)).toBe(true);
    expect(fake.calls).toHaveLength(6);
  });

  it('caches like Recall: an in-progress 409 and 502/503/504 are not cached; a 400 and any other 409 are', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    const create = (idempotencyKey: string) => client.createBot(createBody(), { idempotencyKey });

    fake.failNext(409, { body: 'Another request with this Idempotency-Key is being processed. Retry later.' });
    expect(await failure(create('key-in-flight-1'))).toMatchObject({
      category: 'conflict',
      code: 'idempotency_in_progress',
      rotateIdempotencyKey: false,
    });
    for (const gateway of [502, 503, 504]) {
      fake.failNext(gateway);
      expect(await failure(create('key-in-flight-1'))).toMatchObject({ category: 'http_server_error', rotateIdempotencyKey: false });
    }
    const created = await create('key-in-flight-1');
    expect(fake.bots.has(created.id)).toBe(true);

    // A 400 for a bad setting is replayed for the same key even after the setting is fixed.
    fake.failNext(400, { body: { google_meet: ['Unknown login group.'] } });
    for (let i = 0; i < 2; i += 1) {
      expect(await failure(create('key-bad-setting-1'))).toMatchObject({
        category: 'bad_request',
        retriable: false,
        rotateIdempotencyKey: true,
        fieldCodes: ['google_meet'],
      });
    }
    fake.failNext(409, { body: { detail: 'Conflict.' } });
    for (let i = 0; i < 2; i += 1) {
      expect(await failure(create('key-conflict-1'))).toMatchObject({ category: 'conflict', code: 'conflict', rotateIdempotencyKey: true });
    }
    expect(fake.bots.size).toBe(1);
    // 409 + three gateway errors + the create + 2 x 400 + 2 x 409.
    expect(fake.calls).toHaveLength(9);
  });

  it('answers 404 for unknown bots and unknown routes', async () => {
    const fake = createFakeRecall();
    const client = new RecallClient({ apiKey: FAKE_RECALL_API_KEY, transport: fake.transport });
    expect(await failure(client.leaveCall(BOT_ID))).toMatchObject({ category: 'not_found' });
    expect(await failure(client.startOutputMedia(BOT_ID, { cameraWebpageUrl: PAGE_URL }))).toMatchObject({ category: 'not_found' });
    expect(() => fake.setStatus(BOT_ID, 'done')).toThrow();
  });
});
