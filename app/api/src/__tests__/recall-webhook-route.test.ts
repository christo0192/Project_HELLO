/**
 * M034 S03 T3: the Recall.ai webhook receivers (`routes/recall-webhook.ts`), end to end on a bare
 * Express app with a real `getR1MeetConfig(...)`, the independent Svix test signer and the in-memory
 * receipt port.
 *
 * Proves: flag OFF is inert on both paths (200 `disabled` before the raw parser: no verification,
 * no DB, no log, even for a 2 MB unsigned body); the Standard Webhooks known-answer vector verifies
 * through the route; wrong, tampered, missing, stale, future, multi-entry and legacy-header
 * signatures; the Ashby dedupe-space guard; body bounds; accepted, duplicate, ignored, malformed and
 * every failure answer; one receipt call per accepted delivery with the exact contract payload; no
 * secret, signature or webhook id in any response or log line; not in `lib/auth.ts` PUBLIC_ROUTES;
 * and `createApp()` with the default environment answers 200 `disabled`. M035 S09 T2: a join named
 * like the bot (the profile's `Dex`, or `R1_MEET_BOT_NAME` when set) is marked `is_bot: true`, and the
 * name never reaches a receipt, a job or a log line.
 *
 * gitleaks: the workspace secret is generated at run time (`makeRecallWebhookSecret`), the spec
 * vector's secret is assembled from parts, and the Recall API value is joined from parts.
 * Fake data only: fixed fake UUIDs, `Example` names, `example.invalid` emails.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { isPublicRoute } from '../lib/auth.js';
import { getR1MeetConfig, type R1MeetConfig } from '../lib/r1/meet/config.js';
import type { R1MeetReceiptAnswer, R1MeetReceiptPort } from '../lib/r1/meet/receipts.js';
import { createRecallWebhookRouter, type RecallWebhookRouterDeps } from '../routes/recall-webhook.js';
import { FIXTURE_DEX_USER_ID } from './support/ashby-schedule-fixture.js';
import { makeRecallWebhookSecret, signRecallWebhook } from './support/meet-webhook-signing.js';
import { createR1MeetReceiptsFake, type R1MeetReceiptsFake } from './support/r1-meet-receipts-fake.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-11-25T04:00:00.000Z');
const NOW_SEC = NOW_MS / 1000;
const MOUNT = '/api/integrations/recall';
const PATHS = ['webhook', 'realtime'] as const;
type RecallPath = (typeof PATHS)[number];
const LOG_COMPONENT = 'recall-webhook-route-test';

const BOT_ID = '7f000000-0000-4000-8000-000000000001';
const BOOKING_ID_UPPER = '7F000000-0000-4000-8000-0000000000B1';
const BOOKING_ID = BOOKING_ID_UPPER.toLowerCase();
const MSG_ID = 'msg_s03fixtureRecallRoute01';

const PARTICIPANT_NAME = 'Example Person';
/** The bot's own display names used here: the profile's, and an `R1_MEET_BOT_NAME` override. */
const PROFILE_BOT_NAME = 'Dex';
const OVERRIDE_BOT_NAME = 'Dex (AI Interviewer)';
const BOT_NAME_FIXTURES = [PROFILE_BOT_NAME, OVERRIDE_BOT_NAME, 'AI Interviewer'];
const PARTICIPANT_EMAIL = 'person@example.invalid';
const PARTICIPANT_PLATFORM = 'desktop_fixture_platform';
const EXTRA_MARKER = 'extra_fixture_marker';

const RECALL_API_VALUE = ['fixture', 'recall', 'api', 'value'].join('-');
const signingText = makeRecallWebhookSecret();
const otherSigningText = makeRecallWebhookSecret();

function meetEnabled(webhookText: string = signingText, extra: Record<string, string> = {}): R1MeetConfig {
  return getR1MeetConfig({
    R1_MEET_ENABLED: 'true',
    RECALL_API_KEY: RECALL_API_VALUE,
    RECALL_WEBHOOK_SECRET: webhookText,
    R1_MEET_ASHBY_DEX_USER_ID: FIXTURE_DEX_USER_ID,
    WEB_ORIGIN: 'https://hello.example.test',
    ...extra,
  });
}

const MEET_ON = meetEnabled();
const PAYLOAD_KEYS = ['kind', 'event_type', 'recall_bot_id', 'booking_id', 'occurred_at', 'sub_code', 'participant'];

function statusBody(event = 'bot.in_call_recording', bot: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event,
    data: {
      data: { code: event.replace(/^bot\./, ''), sub_code: null, updated_at: '2026-12-01T10:31:00.000Z' },
      bot: { id: BOT_ID, metadata: { booking_id: BOOKING_ID_UPPER, profile: 'r1_dex_sales' }, ...bot },
    },
  });
}

function participantBody(event = 'participant_events.join', name: string = PARTICIPANT_NAME): string {
  return JSON.stringify({
    event,
    data: {
      data: {
        participant: {
          id: 100,
          name,
          is_host: false,
          platform: PARTICIPANT_PLATFORM,
          extra_data: { google_meet: { static_participant_id: EXTRA_MARKER } },
          email: PARTICIPANT_EMAIL,
        },
        timestamp: { absolute: '2026-12-01T10:32:05.250Z', relative: 12.5 },
        data: null,
      },
      realtime_endpoint: { id: '7f000000-0000-4000-8000-000000000011', metadata: {} },
      participant_events: { id: '7f000000-0000-4000-8000-000000000012', metadata: {} },
      recording: { id: '7f000000-0000-4000-8000-000000000013', metadata: {} },
      bot: { id: BOT_ID, metadata: { booking_id: BOOKING_ID, profile: 'r1_dex_sales' } },
    },
  });
}

/** A well-formed v1 entry that matches nothing (32 random bytes). */
const randomV1 = (): string => `v1,${randomBytes(32).toString('base64')}`;

function signed(
  body: string | Buffer,
  options: {
    id?: string;
    timestamp?: number | string;
    headerStyle?: 'webhook' | 'svix';
    extraSignatures?: readonly string[];
    signWith?: string;
  } = {},
): Record<string, string> {
  return signRecallWebhook({
    secret: options.signWith ?? signingText,
    id: options.id ?? MSG_ID,
    timestamp: options.timestamp ?? NOW_SEC,
    body,
    headerStyle: options.headerStyle,
    extraSignatures: options.extraSignatures,
  });
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  app: express.Express;
  fake: R1MeetReceiptsFake;
  r1Config: ReturnType<typeof vi.fn>;
  meetConfig: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
}

function makeHarness(overrides: { r1?: { enabled: boolean }; meet?: R1MeetConfig; receipts?: R1MeetReceiptPort; now?: () => number } = {}): Harness {
  const fake = createR1MeetReceiptsFake();
  const r1Config = vi.fn(() => overrides.r1 ?? { enabled: true });
  const meetConfig = vi.fn(() => overrides.meet ?? MEET_ON);
  const now = vi.fn(overrides.now ?? (() => NOW_MS));
  const deps: RecallWebhookRouterDeps = {
    r1Config,
    meetConfig,
    receipts: overrides.receipts ?? fake,
    now,
    loggerComponent: LOG_COMPONENT,
  };
  const app = express();
  app.use(MOUNT, createRecallWebhookRouter(deps));
  return { app, fake, r1Config, meetConfig, now };
}

/** Every value that must never appear in a response or a log line. */
let forbidden: string[] = [];
let logLines: string[] = [];

function trackForbidden(headers: Record<string, string>): void {
  for (const value of Object.values(headers)) {
    forbidden.push(value);
    for (const entry of value.split(' ')) if (entry.startsWith('v1,')) forbidden.push(entry.slice(3));
  }
}

async function send(
  app: express.Express,
  path: RecallPath,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<request.Response> {
  trackForbidden(headers);
  const call = request(app).post(`${MOUNT}/${path}`).set('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(headers)) call.set(name, value);
  const res = await call.send(body);
  for (const value of forbidden) expect(res.text, 'response leaks a forbidden value').not.toContain(value);
  return res;
}

/**
 * POST a large body over a keep-alive connection and read the answer. The gate answers before the
 * body is read; Node then drains the rest. On a `Connection: close` request (what supertest sends)
 * Node closes the socket right after an early answer and the client sees ECONNRESET mid-upload, a
 * transport artefact that says nothing about the route, so this helper keeps the connection alive.
 */
async function sendLargeKeepAlive(
  app: express.Express,
  path: RecallPath,
  body: Buffer,
): Promise<{ status: number; json: unknown; text: string }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = new http.Agent({ keepAlive: true });
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `${MOUNT}/${path}`,
          method: 'POST',
          agent,
          headers: { 'content-type': 'application/json', 'content-length': body.length },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown = null;
            try {
              json = JSON.parse(text) as unknown;
            } catch {
              json = null; // e.g. the parser's own 413 page
            }
            resolve({ status: res.statusCode ?? 0, json, text });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  } finally {
    agent.destroy();
    server.close();
  }
}

beforeEach(() => {
  forbidden = [signingText, signingText.slice(6), otherSigningText, otherSigningText.slice(6), MSG_ID];
  logLines = [];
  const capture = (chunk: unknown): void => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (text.includes(LOG_COMPONENT)) logLines.push(text);
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    capture(chunk);
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    capture(args.map(String).join(' '));
  });
  // The Meet `invalid` variant logs its own one-time `[r1-meet-config]` line.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const line of logLines) {
    for (const value of [...forbidden, BOT_ID, BOOKING_ID, PARTICIPANT_EMAIL, PARTICIPANT_NAME, ...BOT_NAME_FIXTURES]) {
      expect(line, 'log line leaks a forbidden value').not.toContain(value);
    }
  }
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('setup sanity', () => {
  it('the injected Meet config is enabled, and the signer secret is not an enumerable field', () => {
    expect(MEET_ON.enabled).toBe(true);
    expect(JSON.stringify(MEET_ON)).not.toContain(signingText);
  });
});

describe('flag off is inert (S03 plan R2: 200 disabled before the raw parser)', () => {
  const variants: Array<[string, { r1: { enabled: boolean }; meet: () => R1MeetConfig }]> = [
    ['R1 off + Meet on', { r1: { enabled: false }, meet: () => MEET_ON }],
    ['R1 on + Meet disabled', { r1: { enabled: true }, meet: () => getR1MeetConfig({}) }],
    ['R1 on + Meet invalid', { r1: { enabled: true }, meet: () => getR1MeetConfig({ R1_MEET_ENABLED: 'yes' }) }],
  ];

  for (const [label, variant] of variants) {
    for (const path of PATHS) {
      it(`${label}: /${path} answers 200 disabled with no verification, DB call or log`, async () => {
        const meet = variant.meet();
        expect(meet.enabled === true && variant.r1.enabled).toBe(false);
        const h = makeHarness({ r1: variant.r1, meet });

        const garbage = await send(h.app, path, 'not json at all, and unsigned');
        expect(garbage.status).toBe(200);
        expect(garbage.body).toEqual({ ok: true, status: 'disabled' });

        // 2 MB, over the 1 MiB raw parser bound: still 200, so the gate runs before the parser.
        const huge = await sendLargeKeepAlive(h.app, path, Buffer.alloc(2 * 1024 * 1024, 0x61));
        expect(huge.status).toBe(200);
        expect(huge.json).toEqual({ ok: true, status: 'disabled' });

        // A correctly signed, otherwise acceptable delivery is not recorded either.
        const body = path === 'webhook' ? statusBody() : participantBody();
        const real = await send(h.app, path, body, signed(body));
        expect(real.body).toEqual({ ok: true, status: 'disabled' });

        expect(h.fake.calls).toHaveLength(0);
        expect(h.fake.jobs()).toHaveLength(0);
        expect(h.meetConfig).toHaveBeenCalledTimes(3);
        // The handler (which reads the clock first, then verifies) never ran.
        expect(h.now).not.toHaveBeenCalled();
        expect(logLines).toEqual([]);
      });
    }
  }
});

describe('Standard Webhooks known-answer vector through the route', () => {
  // The published spec example, assembled at run time (identifiers carry no credential words).
  const SPEC_PART_A = 'MfKQ9r8GKYqrTwjUPD8I';
  const SPEC_PART_B = 'LPZIo2LaLaSw';
  const specText = 'whsec' + '_' + SPEC_PART_A + SPEC_PART_B;
  const SPEC_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const SPEC_TIMESTAMP = '1614265330';
  const SPEC_BODY = '{"test": 2432232314}';
  const SPEC_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';

  for (const style of ['webhook', 'svix'] as const) {
    it(`verifies on the ${style}-* headers (not 403) and answers 400 malformed_event with no receipt`, async () => {
      const meet = meetEnabled(specText);
      expect(meet.enabled).toBe(true);
      const h = makeHarness({ meet, now: () => 1614265330000 });
      forbidden.push(specText, SPEC_PART_A + SPEC_PART_B, SPEC_ID, SPEC_SIGNATURE, SPEC_SIGNATURE.slice(3));
      const res = await send(h.app, 'webhook', SPEC_BODY, {
        [`${style}-id`]: SPEC_ID,
        [`${style}-timestamp`]: SPEC_TIMESTAMP,
        [`${style}-signature`]: SPEC_SIGNATURE,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'malformed_event' });
      expect(h.fake.calls).toHaveLength(0);
    });
  }

  it('control: the same vector one second outside the window is 401, and a changed byte is 403', async () => {
    const meet = meetEnabled(specText);
    const late = makeHarness({ meet, now: () => 1614265330000 + 301_000 });
    const headers = { 'webhook-id': SPEC_ID, 'webhook-timestamp': SPEC_TIMESTAMP, 'webhook-signature': SPEC_SIGNATURE };
    forbidden.push(specText, SPEC_ID, SPEC_SIGNATURE.slice(3));
    expect((await send(late.app, 'webhook', SPEC_BODY, headers)).body).toEqual({
      ok: false,
      error: 'timestamp_out_of_tolerance',
    });
    const onTime = makeHarness({ meet, now: () => 1614265330000 });
    const tampered = await send(onTime.app, 'webhook', SPEC_BODY.replace('2432232314', '2432232315'), headers);
    expect(tampered.status).toBe(403);
    expect(tampered.body).toEqual({ ok: false, error: 'mismatch' });
  });
});

describe('signatures and headers', () => {
  it('a signature by another secret is 403 mismatch, with no receipt', async () => {
    const h = makeHarness();
    const body = statusBody();
    const res = await send(h.app, 'webhook', body, signed(body, { signWith: otherSigningText }));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'mismatch' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('a body changed by one byte after signing is 403', async () => {
    const h = makeHarness();
    const body = statusBody();
    const headers = signed(body);
    const res = await send(h.app, 'webhook', body.replace('in_call_recording"', 'in_call_recordinG"'), headers);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'mismatch' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('missing or incomplete headers are 401 missing_headers', async () => {
    const h = makeHarness();
    const body = statusBody();
    expect((await send(h.app, 'webhook', body)).body).toEqual({ ok: false, error: 'missing_headers' });
    const partial: Record<string, string> = { ...signed(body) };
    delete partial['webhook-signature'];
    const res = await send(h.app, 'webhook', body, partial);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'missing_headers' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('malformed signature, id and timestamp headers are 400 with their reason', async () => {
    const h = makeHarness();
    const body = statusBody();
    const malformedSignature = await send(h.app, 'webhook', body, { ...signed(body), 'webhook-signature': 'v1,not-base64' });
    expect(malformedSignature.status).toBe(400);
    expect(malformedSignature.body).toEqual({ ok: false, error: 'malformed_signature' });
    const malformedId = await send(h.app, 'webhook', body, signed(body, { id: 'msg with space' }));
    expect(malformedId.status).toBe(400);
    expect(malformedId.body).toEqual({ ok: false, error: 'malformed_id' });
    const malformedTimestamp = await send(h.app, 'webhook', body, signed(body, { timestamp: 'soon' }));
    expect(malformedTimestamp.status).toBe(400);
    expect(malformedTimestamp.body).toEqual({ ok: false, error: 'malformed_timestamp' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('timestamps 301 s stale or future are 401; 299 s either way is accepted', async () => {
    const h = makeHarness();
    const body = statusBody();
    for (const offset of [-301, 301]) {
      const res = await send(h.app, 'webhook', body, signed(body, { id: `msg_s03fixtureOffset${offset < 0 ? 'M' : 'P'}301`, timestamp: NOW_SEC + offset }));
      expect(res.status, String(offset)).toBe(401);
      expect(res.body, String(offset)).toEqual({ ok: false, error: 'timestamp_out_of_tolerance' });
    }
    expect(h.fake.calls).toHaveLength(0);
    for (const offset of [-299, 299]) {
      const res = await send(h.app, 'webhook', body, signed(body, { id: `msg_s03fixtureOffset${offset < 0 ? 'M' : 'P'}299`, timestamp: NOW_SEC + offset }));
      expect(res.status, String(offset)).toBe(200);
      expect(res.body, String(offset)).toEqual({ ok: true, status: 'accepted' });
    }
    expect(h.fake.jobs()).toHaveLength(2);
  });

  it('several v1 entries (two non-matching first) are accepted', async () => {
    const h = makeHarness();
    const body = statusBody();
    const res = await send(h.app, 'webhook', body, signed(body, { extraSignatures: [randomV1(), randomV1()] }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.calls).toHaveLength(1);
  });

  it('the legacy svix-* header set is accepted, deduped on svix-id', async () => {
    const h = makeHarness();
    const body = participantBody();
    const res = await send(h.app, 'realtime', body, signed(body, { headerStyle: 'svix' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.calls.map((call) => call.dedupeKey)).toEqual([MSG_ID]);
  });

  it('a verified id in the Ashby schedule dedupe space is 400 malformed_id, before any receipt', async () => {
    const h = makeHarness();
    const body = statusBody();
    const res = await send(h.app, 'webhook', body, signed(body, { id: 'ashby-schedule:x' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'malformed_id' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('an unusable secret in an enabled config fails closed with 503 not_configured', async () => {
    if (!MEET_ON.enabled) throw new Error('setup');
    const broken = {
      ...MEET_ON,
      recall: { baseUrl: MEET_ON.recall.baseUrl, googleLoginGroupId: null, apiKey: RECALL_API_VALUE, webhookSecret: 'unusable' },
    } as R1MeetConfig;
    const h = makeHarness({ meet: broken });
    const body = statusBody();
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'not_configured' });
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('body bounds', () => {
  it('a 300 KiB signed body is 413 body_too_large (the verifier bound, under the 1 MiB parser bound)', async () => {
    const h = makeHarness();
    const body = JSON.stringify({ event: 'bot.done', padding: 'a'.repeat(300 * 1024) });
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ ok: false, error: 'body_too_large' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('a body over the 1 MiB parser bound is refused 413 body_too_large in the route shape, with no receipt', async () => {
    const h = makeHarness();
    for (const path of PATHS) {
      const res = await sendLargeKeepAlive(h.app, path, Buffer.alloc(1024 * 1024 + 1024, 0x61));
      expect(res.status, path).toBe(413);
      // S03-R6: the documented `{ ok, error }` body, not Express's (or the app's) generic 413.
      expect(res.json, path).toEqual({ ok: false, error: 'body_too_large' });
      expect(res.text, path).toBe(JSON.stringify({ ok: false, error: 'body_too_large' }));
    }
    expect(h.fake.calls).toHaveLength(0);
    // The parser refused it before the handler ran (the handler reads the clock first).
    expect(h.now).not.toHaveBeenCalled();
  });

  it('an empty body is 400 empty_body', async () => {
    const h = makeHarness();
    const res = await send(h.app, 'webhook', '', signed(''));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'empty_body' });
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('accepted and duplicate deliveries', () => {
  it('bot.in_call_recording on /webhook: one receipt with the exact contract payload, booking id lower-cased', async () => {
    const h = makeHarness();
    const body = statusBody();
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });

    expect(h.fake.calls).toHaveLength(1);
    const call = h.fake.calls[0]!;
    expect(call).toEqual({
      source: 'recall',
      dedupeKey: MSG_ID,
      eventType: 'bot.in_call_recording',
      bookingId: BOOKING_ID,
      payload: {
        kind: 'recall_event',
        event_type: 'bot.in_call_recording',
        recall_bot_id: BOT_ID,
        booking_id: BOOKING_ID,
        occurred_at: '2026-12-01T10:31:00.000Z',
        sub_code: null,
        participant: null,
      },
      nowMs: NOW_MS,
    });
    expect(Object.keys(call.payload)).toEqual(PAYLOAD_KEYS);
    expect(h.fake.jobs()).toHaveLength(1);
    expect(h.fake.jobs()[0]!.payload).toMatchObject({ kind: 'recall_event', source: 'recall' });
    // One clock read per request, shared by the verifier and the receipt.
    expect(h.now).toHaveBeenCalledTimes(1);
  });

  it('participant_events.join on /realtime: a participant object, and no name, email, platform or extra data anywhere', async () => {
    const h = makeHarness();
    const body = participantBody();
    const res = await send(h.app, 'realtime', body, signed(body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.calls).toHaveLength(1);
    const call = h.fake.calls[0]!;
    expect(call.eventType).toBe('participant_events.join');
    expect(call.bookingId).toBe(BOOKING_ID);
    expect(call.payload).toEqual({
      kind: 'recall_event',
      event_type: 'participant_events.join',
      recall_bot_id: BOT_ID,
      booking_id: BOOKING_ID,
      occurred_at: '2026-12-01T10:32:05.250Z',
      sub_code: null,
      participant: { id: 100, is_host: false, is_bot: null },
    });
    expect(Object.keys(call.payload)).toEqual(PAYLOAD_KEYS);
    expectNoParticipantTrace(h, PARTICIPANT_NAME);
  });

  /** Receipts, jobs and record calls hold no name, email, platform or extra data (any case). */
  function expectNoParticipantTrace(h: Harness, name: string): void {
    const seen = JSON.stringify({ calls: h.fake.calls, jobs: h.fake.jobs(), receipts: h.fake.receipts() });
    for (const value of [name, PARTICIPANT_EMAIL, PARTICIPANT_PLATFORM, EXTRA_MARKER, '@', 'example.invalid', 'platform', 'extra_data', '"name"']) {
      expect(seen.toLowerCase(), value).not.toContain(value.toLowerCase());
    }
    for (const value of BOT_NAME_FIXTURES) expect(seen.toLowerCase(), value).not.toContain(value.toLowerCase());
  }

  it("a join named like the bot (default config: the profile's Dex) is marked is_bot true, and the name is kept nowhere", async () => {
    const h = makeHarness();
    const body = participantBody('participant_events.join', PROFILE_BOT_NAME);
    const res = await send(h.app, 'realtime', body, signed(body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.payload).toEqual({
      kind: 'recall_event',
      event_type: 'participant_events.join',
      recall_bot_id: BOT_ID,
      booking_id: BOOKING_ID,
      occurred_at: '2026-12-01T10:32:05.250Z',
      sub_code: null,
      participant: { id: 100, is_host: false, is_bot: true },
    });
    expect(Object.keys(h.fake.calls[0]!.payload)).toEqual(PAYLOAD_KEYS);
    expect(h.fake.jobs()).toHaveLength(1);
    expect(h.fake.jobs()[0]!.payload).toMatchObject({ participant: { id: 100, is_host: false, is_bot: true } });
    expectNoParticipantTrace(h, PROFILE_BOT_NAME);
    for (const line of logLines) expect(line.toLowerCase()).not.toContain('dex');
  });

  it('with R1_MEET_BOT_NAME set, only that name is marked: the profile name is then a person', async () => {
    const meet = meetEnabled(signingText, { R1_MEET_BOT_NAME: OVERRIDE_BOT_NAME });
    expect(meet.enabled && meet.botNameOverride).toBe(OVERRIDE_BOT_NAME);
    const h = makeHarness({ meet });
    const cases: Array<[string, boolean | null]> = [
      [PROFILE_BOT_NAME, null],
      [OVERRIDE_BOT_NAME, true],
      [PARTICIPANT_NAME, null],
    ];
    for (const [index, [name, isBot]] of cases.entries()) {
      const body = participantBody('participant_events.join', name);
      const res = await send(h.app, 'realtime', body, signed(body, { id: `msg_s09fixtureOwnName${index}` }));
      expect(res.body, name).toEqual({ ok: true, status: 'accepted' });
      expect(h.fake.calls[index]!.payload.participant, name).toEqual({ id: 100, is_host: false, is_bot: isBot });
    }
    expect(h.fake.jobs()).toHaveLength(3);
    for (const [name] of cases) expectNoParticipantTrace(h, name);
    for (const line of logLines) expect(line.toLowerCase()).not.toContain('dex');
  });

  it('a leave named like the bot is never marked by name', async () => {
    const h = makeHarness();
    const body = participantBody('participant_events.leave', PROFILE_BOT_NAME);
    const res = await send(h.app, 'realtime', body, signed(body));
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.calls[0]!.payload.participant).toEqual({ id: 100, is_host: false, is_bot: null });
    expectNoParticipantTrace(h, PROFILE_BOT_NAME);
  });

  it('participant_events.leave on /realtime is accepted too', async () => {
    const h = makeHarness();
    const body = participantBody('participant_events.leave');
    const res = await send(h.app, 'realtime', body, signed(body));
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.calls[0]!.eventType).toBe('participant_events.leave');
  });

  it('the same webhook id again answers 200 duplicate, and exactly one job exists', async () => {
    const h = makeHarness();
    const body = statusBody('bot.joining_call');
    expect((await send(h.app, 'webhook', body, signed(body))).body).toEqual({ ok: true, status: 'accepted' });
    const again = await send(h.app, 'webhook', body, signed(body));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, status: 'duplicate' });
    expect(h.fake.calls).toHaveLength(2);
    expect(h.fake.jobs()).toHaveLength(1);
    expect(h.fake.receipts()).toHaveLength(1);
  });
});

describe('ignored and malformed bodies', () => {
  it('events with no Meet meaning on the path are 200 ignored with no receipt', async () => {
    const h = makeHarness();
    const cases: Array<[RecallPath, string]> = [
      ['webhook', statusBody('bot.breakout_room_entered')],
      ['webhook', JSON.stringify({ event: 'recording.done', data: { bot: { id: BOT_ID } } })],
      ['webhook', JSON.stringify({ event: 'unknown.fixture_event', data: {} })],
      ['webhook', participantBody('participant_events.join')],
      ['realtime', statusBody('bot.in_call_recording')],
      ['realtime', JSON.stringify({ event: 'transcript.data', data: { bot: { id: BOT_ID } } })],
    ];
    for (const [index, [path, body]] of cases.entries()) {
      const res = await send(h.app, path, body, signed(body, { id: `msg_s03fixtureIgnored${index}` }));
      expect(res.status, body).toBe(200);
      expect(res.body, body).toEqual({ ok: true, status: 'ignored' });
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it('signed invalid JSON is 400 invalid_json', async () => {
    const h = makeHarness();
    const body = '{"event": "bot.done",';
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('a known event with a non-UUID bot id, or a non-object body, is 400 malformed_event', async () => {
    const h = makeHarness();
    const cases = [statusBody('bot.done', { id: 'not-a-uuid' }), '[1, 2]', '"bot.done"', JSON.stringify({ event: 7 })];
    for (const [index, body] of cases.entries()) {
      const res = await send(h.app, 'webhook', body, signed(body, { id: `msg_s03fixtureMalformed${index}` }));
      expect(res.status, body).toBe(400);
      expect(res.body, body).toEqual({ ok: false, error: 'malformed_event' });
    }
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe('durability failures are retryable 500s', () => {
  it('a receipt RPC failure is 500 receipt_persist_failed; the redelivery is accepted with one job', async () => {
    const h = makeHarness();
    const body = statusBody('bot.call_ended');
    h.fake.throwNext();
    const failed = await send(h.app, 'webhook', body, signed(body));
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ ok: false, error: 'receipt_persist_failed' });
    expect(h.fake.jobs()).toHaveLength(0);
    const retry = await send(h.app, 'webhook', body, signed(body));
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, status: 'accepted' });
    expect(h.fake.jobs()).toHaveLength(1);
  });

  it('a refusal is 500 receipt_rejected', async () => {
    const h = makeHarness();
    const body = statusBody('bot.done');
    h.fake.answerNext(Object.freeze({ status: 'refused' as const, reason: 'invalid_payload' as const }));
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'receipt_rejected' });
  });

  it('an answer with no durable work is 500 enqueue_incomplete', async () => {
    const h = makeHarness();
    const body = statusBody('bot.fatal');
    h.fake.answerNext(
      Object.freeze({
        status: 'inserted' as const,
        id: '5e000000-0000-4000-8000-0000000000ff',
        outcome: 'recorded' as const,
        enqueued: false,
        workPending: false,
        bookingLinked: false,
      }),
    );
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'enqueue_incomplete' });
  });

  it('a duplicate with no durable work is 500 enqueue_incomplete too', async () => {
    const h = makeHarness();
    const body = statusBody('bot.fatal');
    h.fake.answerNext(
      Object.freeze({
        status: 'duplicate' as const,
        id: '5e000000-0000-4000-8000-0000000000fe',
        outcome: 'recorded' as const,
        enqueued: false,
        workPending: false,
        bookingLinked: false,
      }),
    );
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'enqueue_incomplete' });
  });

  it('an unexpected throw after the receipt call is 500 internal_error', async () => {
    const hostile: R1MeetReceiptPort = {
      async record(): Promise<R1MeetReceiptAnswer> {
        return {
          get status(): never {
            throw new Error('hostile answer');
          },
        } as unknown as R1MeetReceiptAnswer;
      },
    };
    const h = makeHarness({ receipts: hostile });
    const body = statusBody('bot.done');
    const res = await send(h.app, 'webhook', body, signed(body));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'internal_error' });
  });
});

describe('logging', () => {
  it('logs only closed codes: the ingress outcome and the rejection reason, never an id, body or signature', async () => {
    const h = makeHarness();
    const body = statusBody();
    await send(h.app, 'webhook', body, signed(body));
    await send(h.app, 'webhook', body, signed(body, { signWith: otherSigningText, id: 'msg_s03fixtureLogMismatch' }));
    const joined = logLines.join('\n');
    expect(joined).toContain('"error_category":"recall_webhook_ingress"');
    expect(joined).toContain('"error_type":"accepted"');
    expect(joined).toContain('"error_category":"recall_webhook_rejected"');
    expect(joined).toContain('"error_type":"mismatch"');
    expect(joined).not.toContain('msg_s03fixture');
    expect(joined).not.toContain('in_call_recording');
  });
});

describe('auth boundary and the real app', () => {
  it('neither path is in lib/auth.ts PUBLIC_ROUTES (critic A7: the pre-auth mount is the boundary)', () => {
    expect(isPublicRoute('POST', `${MOUNT}/webhook`)).toBe(false);
    expect(isPublicRoute('POST', `${MOUNT}/realtime`)).toBe(false);
  });

  describe('createApp()', () => {
    const NAMES = ['R1_ENABLED', 'R1_MEET_ENABLED'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const name of NAMES) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });
    afterEach(() => {
      for (const name of NAMES) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it('with the default environment, both paths answer 200 disabled with no auth header', async () => {
      const app = createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
      for (const path of PATHS) {
        const res = await request(app).post(`${MOUNT}/${path}`).set('Content-Type', 'application/json').send('{}');
        expect(res.status, path).toBe(200);
        expect(res.body, path).toEqual({ ok: true, status: 'disabled' });
      }
      // With R1 on but Meet still unset, still inert.
      process.env.R1_ENABLED = 'true';
      for (const path of PATHS) {
        const res = await request(app).post(`${MOUNT}/${path}`).set('Content-Type', 'application/json').send('{}');
        expect(res.body, path).toEqual({ ok: true, status: 'disabled' });
      }
    });

    it('only the two POSTs are pre-auth: another method or path under the prefix hits recruiter auth', async () => {
      const app = createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
      const get = await request(app).get(`${MOUNT}/webhook`);
      expect(get.status).toBe(401);
      const other = await request(app).post(`${MOUNT}/other`).set('Content-Type', 'application/json').send('{}');
      expect(other.status).toBe(401);
    });
  });
});
