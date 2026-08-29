/**
 * The Plivo answer-first ("bounce") ROUTES — /answer, /dial-status, /hangup.
 *
 * Proven here: master-switch gating, V3 signature enforcement on every route,
 * the fail-closed hangup XML on every missing precondition, the answer XML
 * shape (callerId from config, number resolved SERVER-SIDE, action URL from
 * config), the dial-status → apply_phone_event mapping (answer → call.answered
 * via the worker's seam; busy/no-answer → the charged provider events), and
 * that NO route logs or echoes a phone number.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPlivoWebhookRouter } from '../routes/plivo-webhook.js';
import { loadPlivoPhoneConfig } from '../integrations/plivo-phone/config.js';
import { plivoV3Signature } from '../integrations/plivo-phone/verify.js';
import type { PlivoBounceStore } from '../integrations/plivo-phone/stores.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import type { ApplyPhoneEventResult } from '../lib/phone-screening/index.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** The wire form Plivo can actually deliver: dash-free (alphanumeric-only). */
const ATTEMPT_WIRE = ATTEMPT.replace(/-/g, '');
const CANDIDATE_E164 = '+919812345678';
const CALLER_ID = '+919800000001';
const TOKEN = 'plivo-auth-token-abcdef';

const ANSWER_URL = 'https://api.example.com/api/integrations/plivo/answer';
const DIAL_STATUS_URL = 'https://api.example.com/api/integrations/plivo/dial-status';
const HANGUP_URL = 'https://api.example.com/api/integrations/plivo/hangup';

const ENABLED = loadPlivoPhoneConfig({
  PHONE_BOUNCE_MODE: 'true',
  PHONE_BOUNCE_TRUNK_ID: 'bounce-trunk',
  PHONE_BOUNCE_SIP_USER: 'hello_bounce',
  PHONE_BOUNCE_CALLER_ID: CALLER_ID,
  PLIVO_AUTH_TOKEN: TOKEN,
  PLIVO_ANSWER_URL: ANSWER_URL,
  PLIVO_DIAL_STATUS_URL: DIAL_STATUS_URL,
  PLIVO_HANGUP_URL: HANGUP_URL,
} as NodeJS.ProcessEnv);

const DISABLED = loadPlivoPhoneConfig({} as NodeJS.ProcessEnv);

const okApply = { status: 'applied', applied: true, duplicate: false } as ApplyPhoneEventResult;

/** A bounce store that bridges the known attempt to the known number. */
function bridgingStore(overrides: Partial<PlivoBounceStore> = {}): PlivoBounceStore {
  return {
    async resolveForAnswer(attemptId: string) {
      if (attemptId !== ATTEMPT) {
        return { bridgeable: false, terminal: false, answered: false };
      }
      return {
        bridgeable: true,
        terminal: false,
        answered: false,
        candidateNumber: wrapDialableNumber(CANDIDATE_E164),
      };
    },
    async readAnsweredState() {
      return { answered: false, terminal: false };
    },
    ...overrides,
  };
}

function buildApp(deps: Parameters<typeof createPlivoWebhookRouter>[0]) {
  const app = express();
  app.use('/api/integrations/plivo', createPlivoWebhookRouter(deps));
  app.use(express.json({ limit: '2mb' }));
  app.use((_req, res) => res.status(401).json({ error: 'unauthenticated' }));
  return app;
}

/** Sign a form body with the V3 algorithm and post it. */
function signedPost(
  app: express.Express,
  path: string,
  signedUrl: string,
  params: Record<string, string>,
  nonce = 'nonce-xyz',
) {
  const signature = plivoV3Signature(TOKEN, signedUrl, params, nonce);
  return request(app)
    .post(path)
    .type('form')
    .set('X-Plivo-Signature-V3', signature)
    .set('X-Plivo-Signature-V3-Nonce', nonce)
    .send(params);
}

describe('plivo route — disabled does nothing at all', () => {
  it('answer returns 503 without a store or verify', async () => {
    const resolveForAnswer = vi.fn();
    const app = buildApp({
      config: DISABLED,
      bounceStore: { resolveForAnswer, readAnsweredState: vi.fn() } as never,
      stores: { applyEvent: vi.fn() },
    });
    const res = await request(app)
      .post('/api/integrations/plivo/answer')
      .type('form')
      .send({ 'X-PH-HELLOATTEMPT': ATTEMPT_WIRE });
    expect(res.status).toBe(503);
    expect(resolveForAnswer).not.toHaveBeenCalled();
  });
});

describe('plivo /answer — bridges only a valid, live, signed request', () => {
  it('returns the Dial XML with callerId from config and number resolved server-side', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
      To: CALLER_ID,
      From: CANDIDATE_E164,
    });
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/xml/);
    expect(res.text).toBe(
      `<Response><Dial callerId="${CALLER_ID}" action="${DIAL_STATUS_URL}" method="POST" redirect="false"><Number>${CANDIDATE_E164}</Number></Dial></Response>`,
    );
  });

  it('resolves the number SERVER-SIDE — a number in the request is ignored', async () => {
    const store = bridgingStore();
    const app = buildApp({ config: ENABLED, bounceStore: store, stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
      To: '+910000000000',
    });
    // The number came from the store, not the request param.
    expect(res.text).toContain(`<Number>${CANDIDATE_E164}</Number>`);
    expect(res.text).not.toContain('+910000000000');
  });

  it('hangs up on an INVALID signature', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await request(app)
      .post('/api/integrations/plivo/answer')
      .type('form')
      .set('X-Plivo-Signature-V3', 'AAAAwrongAAAA=')
      .set('X-Plivo-Signature-V3-Nonce', 'nonce-xyz')
      .send({ 'X-PH-HELLOATTEMPT': ATTEMPT_WIRE });
    expect(res.status).toBe(200);
    expect(res.text).toBe('<Response><Hangup/></Response>');
  });

  it('hangs up when the correlation header is MISSING', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, { To: CALLER_ID });
    expect(res.text).toBe('<Response><Hangup/></Response>');
  });

  it('hangs up when the correlation id is not a uuid or 32-hex value', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    for (const bad of ['not-a-uuid', 'zz'.repeat(16), ATTEMPT_WIRE.slice(0, 31)]) {
      const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
        'X-PH-HELLOATTEMPT': bad,
      });
      expect(res.text).toBe('<Response><Hangup/></Response>');
    }
  });

  it('still tolerates a dashed uuid, should one ever survive the wire', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT,
    });
    expect(res.text).toContain('<Dial');
  });

  it('re-dashes an UPPERCASE hex wire value to the canonical lowercase uuid', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE.toUpperCase(),
    });
    expect(res.text).toContain('<Dial');
  });

  it('hangs up for an unknown / terminal / non-bridgeable attempt', async () => {
    const store = bridgingStore({
      async resolveForAnswer() {
        return { bridgeable: false, terminal: true, answered: false };
      },
    });
    const app = buildApp({ config: ENABLED, bounceStore: store, stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
    });
    expect(res.text).toBe('<Response><Hangup/></Response>');
  });

  it('accepts the correlation param case-INSENSITIVELY', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'x-ph-helloattempt': ATTEMPT_WIRE,
    });
    expect(res.text).toContain('<Dial');
  });

  it('the bridge XML wires BOTH channels: completion action AND real-time callbackUrl', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
    });
    // Without callbackUrl there is NO mid-call answer signal at all: the
    // action URL fires only at dial END, the worker's answer-wait starves,
    // and the bot sits silent on an answered call (call 13, 2026-08-29).
    expect(res.text).toContain(`action="${DIAL_STATUS_URL}"`);
    expect(res.text).toContain(`callbackUrl="${DIAL_STATUS_URL}"`);
    expect(res.text).toContain('callbackMethod="POST"');
    expect(res.text).toContain('redirect="false"');
  });
});

describe('plivo /dial-status — applies the right ledger event', () => {
  it('DialAction=answer (real-time callback) applies call.answered mid-call', async () => {
    const applyEvent = vi.fn(async () => okApply);
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    const res = await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
      DialAction: 'answer',
      DialBLegUUID: 'bleg-uuid-1',
    });
    expect(res.status).toBe(200);
    expect(applyEvent).toHaveBeenCalledTimes(1);
    const arg = (applyEvent.mock.calls[0] as unknown[])[0] as { eventType: string; source: string; attemptId?: string; providerEventId?: string };
    expect(arg.eventType).toBe('call.answered');
    expect(arg.source).toBe('internal');
    expect(arg.attemptId).toBe(ATTEMPT);
  });

  it('DialStatus=completed (action after a connected call) is the answered FALLBACK, never a no-answer', async () => {
    const applyEvent = vi.fn(async () => okApply);
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    const res = await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
      DialStatus: 'completed',
      CallUUID: 'call-uuid-c',
    });
    expect(res.status).toBe(200);
    expect(applyEvent).toHaveBeenCalledTimes(1);
    const arg = (applyEvent.mock.calls[0] as unknown[])[0] as { eventType: string; source: string };
    expect(arg.eventType).toBe('call.answered');
    expect(arg.source).toBe('internal');
  });

  it('DialAction=hangup / connected are acknowledged with NO ledger transition', async () => {
    const applyEvent = vi.fn(async () => okApply);
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    for (const action of ['hangup', 'connected', 'digits']) {
      const res = await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
        'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
        DialAction: action,
      });
      expect(res.status).toBe(200);
    }
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('DialStatus=busy charges the busy provider event', async () => {
    const applyEvent = vi.fn(async () => okApply);
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
      DialStatus: 'busy',
      CallUUID: 'call-uuid-2',
    });
    const arg = (applyEvent.mock.calls[0] as unknown[])[0] as { eventType: string; source: string; attemptId?: string; providerEventId?: string };
    expect(arg.eventType).toBe('sip.originate_rejected_busy');
    expect(arg.source).toBe('provider_callback');
    expect(arg.providerEventId).toBe('plivo:call-uuid-2:sip.originate_rejected_busy');
  });

  it('DialStatus=no-answer / failure charges the ring-timeout provider event', async () => {
    for (const status of ['no-answer', 'failed', 'timeout', 'cancel']) {
      const applyEvent = vi.fn(async () => okApply);
      const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
      await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
        'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
        DialStatus: status,
        CallUUID: `uuid-${status}`,
      });
      const arg = (applyEvent.mock.calls[0] as unknown[])[0] as { eventType: string; source: string; attemptId?: string; providerEventId?: string };
      expect(arg.eventType, status).toBe('sip.originate_timeout');
      expect(arg.source, status).toBe('provider_callback');
    }
  });

  it('rejects an invalid signature without applying anything', async () => {
    const applyEvent = vi.fn(async () => okApply);
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    const res = await request(app)
      .post('/api/integrations/plivo/dial-status')
      .type('form')
      .set('X-Plivo-Signature-V3', 'AAAAwrongAAAA=')
      .set('X-Plivo-Signature-V3-Nonce', 'nonce-xyz')
      .send({ 'X-PH-HELLOATTEMPT': ATTEMPT_WIRE, DialAction: 'answer' });
    expect(res.status).toBe(200);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('500s so Plivo redelivers when the store throws', async () => {
    const applyEvent = vi.fn(async () => {
      throw new Error('boom');
    });
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    const res = await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
      'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
      DialAction: 'answer',
      CallUUID: 'x',
    });
    expect(res.status).toBe(500);
  });
});

describe('plivo /hangup — validated, fixed-string, no transition', () => {
  it('200s on a valid signature and applies NO event', async () => {
    const applyEvent = vi.fn(async () => okApply);
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent } });
    const res = await signedPost(app, '/api/integrations/plivo/hangup', HANGUP_URL, {
      CallUUID: 'call-uuid-9',
      HangupCause: 'NORMAL_CLEARING',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('still 200s (acknowledges) an invalid signature but does nothing', async () => {
    const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn() } });
    const res = await request(app)
      .post('/api/integrations/plivo/hangup')
      .type('form')
      .set('X-Plivo-Signature-V3', 'AAAAwrongAAAA=')
      .set('X-Plivo-Signature-V3-Nonce', 'nonce-xyz')
      .send({ CallUUID: 'x' });
    expect(res.status).toBe(200);
  });
});

describe('plivo routes — no route logs or echoes a phone number', () => {
  it('never writes a candidate number, caller id or param to the logger', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' ')));
    const info = vi.spyOn(console, 'info').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const app = buildApp({ config: ENABLED, bounceStore: bridgingStore(), stores: { applyEvent: vi.fn(async () => okApply) } });
      await signedPost(app, '/api/integrations/plivo/answer', ANSWER_URL, {
        'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
        To: CALLER_ID,
        From: CANDIDATE_E164,
      });
      await signedPost(app, '/api/integrations/plivo/dial-status', DIAL_STATUS_URL, {
        'X-PH-HELLOATTEMPT': ATTEMPT_WIRE,
        DialAction: 'answer',
        CallUUID: 'c',
        To: CANDIDATE_E164,
      });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      info.mockRestore();
    }
    const blob = logs.join('\n');
    expect(blob).not.toContain(CANDIDATE_E164);
    expect(blob).not.toContain(CALLER_ID);
    // Nor the attempt id (a correlation id, not PII, but still not echoed here).
    expect(blob).not.toContain(ATTEMPT);
  });
});
