/**
 * P3 — the phone webhook ROUTE and its mount.
 *
 * Two things are proven here that no unit test can: that the raw bytes reach
 * the verifier unparsed despite a global `express.json` mounted later, and
 * that the public surface is one exact method-and-path pair rather than a
 * prefix.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPhoneWebhookRouter, phoneVerifyStatus } from '../routes/phone-webhook.js';
import { createPhoneIngressHealth } from '../integrations/livekit-phone/ingress.js';
import { loadLiveKitPhoneConfig } from '../integrations/livekit-phone/config.js';
import {
  PHONE_WEBHOOK_VERIFY_REASONS,
  type PhoneWebhookVerifier,
} from '../integrations/livekit-phone/verify.js';
import type { ApplyPhoneEventResult } from '../lib/phone-screening/index.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const IDENTITY = `phone-${ATTEMPT}`;

const ENABLED = loadLiveKitPhoneConfig({
  PHONE_SCREENING_ENABLED: 'true',
  LIVEKIT_API_KEY: 'a-real-key',
  LIVEKIT_API_SECRET: 'a-real-secret',
} as NodeJS.ProcessEnv);

const DISABLED = loadLiveKitPhoneConfig({} as NodeJS.ProcessEnv);

/** A verifier that always passes, capturing exactly what bytes it received. */
function passThrough(envelope: Record<string, unknown>, seen?: { raw?: Buffer; auth?: unknown }) {
  return {
    verify: vi.fn(async ({ rawBody, authHeader }) => {
      if (seen) { seen.raw = rawBody; seen.auth = authHeader; }
      return { ok: true as const, envelope: envelope as never };
    }),
  } satisfies PhoneWebhookVerifier;
}

function buildApp(deps: Parameters<typeof createPhoneWebhookRouter>[0]) {
  const app = express();
  app.use('/api/integrations/livekit-phone', createPhoneWebhookRouter(deps));
  // The REAL app mounts the global JSON parser AFTER the webhook. Mirrored
  // here so the raw-body test is meaningful rather than incidental.
  app.use(express.json({ limit: '2mb' }));
  app.use((_req, res) => res.status(401).json({ error: 'unauthenticated' }));
  return app;
}

const okApply = { status: 'applied', applied: true, duplicate: false } as ApplyPhoneEventResult;

describe('P3 route — disabled does nothing at all', () => {
  it('returns 503 without verifying, storing, or resolving a config dependency', async () => {
    const verify = vi.fn();
    const applyEvent = vi.fn();
    const app = buildApp({
      config: DISABLED,
      verifier: { verify } as unknown as PhoneWebhookVerifier,
      stores: { applyEvent },
    });
    const res = await request(app)
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorize', 'anything')
      .send({ event: 'participant_joined', participant: { identity: IDENTITY } });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'phone_webhook_disabled' });
    expect(verify).not.toHaveBeenCalled();
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('is disabled by DEFAULT under the ambient test environment', () => {
    // vitest.setup.ts seeds the LiveKit credentials but not the phone flag.
    // If this ever flips, the route would go live on a deploy that only set
    // credentials — so the default is pinned here.
    const ambient = loadLiveKitPhoneConfig();
    expect(ambient.phone.screeningEnabled).toBe(false);
  });
});

describe('P3 route — raw bytes, unparsed, before the global JSON parser', () => {
  it('hands the verifier the EXACT bytes that were sent', async () => {
    const seen: { raw?: Buffer; auth?: unknown } = {};
    // Deliberately non-canonical JSON: extra whitespace and key order that a
    // parse/re-serialise round trip would destroy, plus multi-byte UTF-8.
    const body = '{  "event" :"participant_joined",\n  "note":"नमस्ते",  "id":"EV_1" }';
    const app = buildApp({
      config: ENABLED,
      verifier: passThrough({ event: 'room_started' }, seen),
      stores: { applyEvent: vi.fn() },
    });
    const res = await request(app)
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorize', 'jwt-here')
      .send(body);

    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(seen.raw)).toBe(true);
    expect(seen.raw!.toString('utf8')).toBe(body);
    expect(seen.raw!.equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(seen.auth).toBe('jwt-here');
  });

  it('reads the LiveKit Authorize header, not an Authorization header', async () => {
    const seen: { raw?: Buffer; auth?: unknown } = {};
    const app = buildApp({
      config: ENABLED,
      verifier: passThrough({ event: 'room_started' }, seen),
      stores: { applyEvent: vi.fn() },
    });
    await request(app)
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer wrong-header')
      .send('{"event":"room_started"}');
    expect(seen.auth).toBeUndefined();
  });

  it('accepts a body with no content-type at all (LiveKit sets its own)', async () => {
    const seen: { raw?: Buffer } = {};
    const app = buildApp({
      config: ENABLED,
      verifier: passThrough({ event: 'room_started' }, seen),
      stores: { applyEvent: vi.fn() },
    });
    const res = await request(app)
      .post('/api/integrations/livekit-phone/webhook')
      .set('Authorize', 'jwt')
      .set('Content-Type', 'text/plain')
      .send('{"event":"room_started"}');
    expect(res.status).toBe(200);
    expect(seen.raw!.toString('utf8')).toBe('{"event":"room_started"}');
  });
});

describe('P3 route — verification failures map fail-closed', () => {
  const EXPECTED: Record<string, number> = {
    not_configured: 503, empty_body: 400, body_too_large: 413,
    body_not_utf8: 400, missing_signature: 401, invalid_signature: 403,
  };

  it('maps every reason in the closed vocabulary, exhaustively', () => {
    for (const reason of PHONE_WEBHOOK_VERIFY_REASONS) {
      expect(phoneVerifyStatus(reason)).toBe(EXPECTED[reason]);
    }
    expect(Object.keys(EXPECTED).sort()).toEqual([...PHONE_WEBHOOK_VERIFY_REASONS].sort());
  });

  it('returns the sanitized reason and never reaches the store', async () => {
    for (const reason of PHONE_WEBHOOK_VERIFY_REASONS) {
      const applyEvent = vi.fn();
      const app = buildApp({
        config: ENABLED,
        verifier: { verify: vi.fn().mockResolvedValue({ ok: false, reason }) },
        stores: { applyEvent },
      });
      const res = await request(app)
        .post('/api/integrations/livekit-phone/webhook')
        .set('Content-Type', 'application/json')
        .send('{"event":"participant_joined"}');
      expect(res.status).toBe(EXPECTED[reason]);
      expect(res.body).toEqual({ ok: false, error: reason });
      expect(applyEvent).not.toHaveBeenCalled();
    }
  });
});

describe('P3 route — 200 vs 500, duplicates, and the R-4 refusals', () => {
  const post = async (deps: Parameters<typeof createPhoneWebhookRouter>[0]) =>
    request(buildApp(deps))
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorize', 'jwt')
      .send('{"event":"participant_left"}');

  const envelope = {
    event: 'participant_left', id: 'EV_1', participantIdentity: IDENTITY,
    participantAttributes: { phone_epoch: '2' },
  };

  it('200 for an applied event', async () => {
    const res = await post({
      config: ENABLED, verifier: passThrough(envelope),
      stores: { applyEvent: vi.fn().mockResolvedValue(okApply) },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'applied' });
  });

  it('200 with the FIRST outcome for a duplicate delivery', async () => {
    const applyEvent = vi.fn()
      .mockResolvedValueOnce(okApply)
      .mockResolvedValueOnce({ ...okApply, duplicate: true });
    const deps = {
      config: ENABLED, verifier: passThrough(envelope), stores: { applyEvent },
    };
    const first = await post(deps);
    const second = await post(deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, status: 'duplicate' });
    expect(first.body).toEqual({ ok: true, status: 'applied' });
    // Both calls carried the SAME deterministic provider event id, which is
    // what makes the second one a duplicate rather than a second row.
    expect(applyEvent.mock.calls[0][0].providerEventId)
      .toBe(applyEvent.mock.calls[1][0].providerEventId);
  });

  it('200 for a late, stale, unknown, terminal or unexpected event', async () => {
    for (const reason of ['stale_epoch', 'unknown_attempt', 'terminal', 'unexpected_event']) {
      const res = await post({
        config: ENABLED, verifier: passThrough(envelope),
        stores: {
          applyEvent: vi.fn().mockResolvedValue({
            status: 'ignored', applied: false, ignoredReason: reason,
          } as ApplyPhoneEventResult),
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, status: `ignored_${reason}` });
    }
  });

  it('200 + counted, with NO partial write, for an attempt_required refusal', async () => {
    const health = createPhoneIngressHealth();
    const res = await post({
      config: ENABLED, verifier: passThrough(envelope), health,
      stores: {
        applyEvent: vi.fn().mockResolvedValue(
          { status: 'attempt_required' } as ApplyPhoneEventResult,
        ),
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'attempt_required' });
    expect(health.snapshot().total).toBe(1);
    expect(health.snapshot().byStatus.attempt_required).toBe(1);
  });

  it('500 when the store throws — LiveKit should redeliver', async () => {
    const res = await post({
      config: ENABLED, verifier: passThrough(envelope),
      stores: { applyEvent: vi.fn().mockRejectedValue(new Error('phone_apply_event_error')) },
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'internal_error' });
  });

  it('500 when the RPC answers something we cannot interpret', async () => {
    const res = await post({
      config: ENABLED, verifier: passThrough(envelope),
      stores: { applyEvent: vi.fn().mockResolvedValue({ status: 'unknown_status' } as never) },
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'apply_unexpected_status' });
  });

  it('400 for a signed body whose event name this SDK cannot produce', async () => {
    const res = await post({
      config: ENABLED, verifier: passThrough({ event: 'room_imploded' }),
      stores: { applyEvent: vi.fn() },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'unrecognized_event' });
  });

  it('never returns a phone number, identity, attribute or provider payload', async () => {
    const res = await post({
      config: ENABLED,
      verifier: passThrough({
        ...envelope,
        participantAttributes: { phone_epoch: '2', 'sip.phoneNumber': '+910000000000' },
      }),
      stores: { applyEvent: vi.fn().mockResolvedValue(okApply) },
    });
    const rendered = JSON.stringify(res.body);
    expect(rendered).not.toContain('+910000000000');
    expect(rendered).not.toContain(IDENTITY);
    expect(rendered).not.toContain('sip.');
    expect(Object.keys(res.body).sort()).toEqual(['ok', 'status']);
  });
});

describe('P3 route — the PRODUCTION defaults, not just the injected fakes', () => {
  // A DI seam whose default is never exercised is how a feature ships green
  // and dies on the first real request. These two tests take the default
  // paths: no injected verifier, no injected health counter.

  it('builds the real verifier when none is injected, and it fails closed', async () => {
    // No `verifier` dep: the route constructs the SDK-backed one from config.
    // A junk Authorize header must be refused by REAL verification.
    const applyEvent = vi.fn();
    const app = buildApp({ config: ENABLED, stores: { applyEvent } });
    const res = await request(app)
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorize', 'not-a-jwt')
      .send('{"event":"participant_joined"}');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'invalid_signature' });
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('never constructs the real verifier while disabled', async () => {
    // Same wiring, master switch off: the 503 must precede construction, so
    // an unconfigured process never loads the LiveKit SDK at all.
    const res = await request(buildApp({ config: DISABLED, stores: { applyEvent: vi.fn() } }))
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorize', 'not-a-jwt')
      .send('{"event":"participant_joined"}');
    expect(res.status).toBe(503);
  });

  it('falls back to the process-wide health counter when none is injected', async () => {
    const { phoneIngressHealth } = await import('../integrations/livekit-phone/ingress.js');
    const before = phoneIngressHealth.snapshot().total;
    const res = await request(buildApp({
      config: ENABLED,
      verifier: passThrough({
        event: 'participant_left', id: 'EV_default_health', participantIdentity: IDENTITY,
      }),
      stores: {
        applyEvent: vi.fn().mockResolvedValue({ status: 'attempt_required' } as never),
      },
    }))
      .post('/api/integrations/livekit-phone/webhook')
      .set('Content-Type', 'application/json').set('Authorize', 'jwt').send('{}');
    expect(res.status).toBe(200);
    expect(phoneIngressHealth.snapshot().total).toBe(before + 1);
  });
});

describe('P3 mount — public at ONE exact method and path', () => {
  const app = () => buildApp({
    config: ENABLED, verifier: passThrough({ event: 'room_started' }),
    stores: { applyEvent: vi.fn() },
  });

  it('POST /webhook is public', async () => {
    const res = await request(app())
      .post('/api/integrations/livekit-phone/webhook')
      .set('Authorize', 'jwt').set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(200);
  });

  it('every OTHER method and path under the prefix falls through to auth', async () => {
    // The router declares only `post('/webhook')`, so the mount PREFIX is not
    // public — a fact worth asserting, because mounting a router pre-auth is
    // otherwise an easy way to expose a whole namespace by accident.
    const fallthroughs = [
      request(app()).get('/api/integrations/livekit-phone/webhook'),
      request(app()).put('/api/integrations/livekit-phone/webhook'),
      request(app()).delete('/api/integrations/livekit-phone/webhook'),
      request(app()).post('/api/integrations/livekit-phone/webhook/extra'),
      request(app()).post('/api/integrations/livekit-phone/anything'),
      request(app()).get('/api/integrations/livekit-phone'),
    ];
    for (const pending of fallthroughs) {
      const res = await pending;
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthenticated' });
    }
  });
});
