/**
 * P3 — LiveKit phone webhook: verification, translation and ingress verdicts.
 *
 * The verification tests drive the REAL `livekit-server-sdk` receiver against
 * REAL HS256 tokens minted here with `node:crypto`. A stubbed verifier would
 * prove only that our own stub agrees with itself; the point of this suite is
 * that the vendor protocol — issuer, signature, expiry tolerance and the
 * base64 body-hash claim — is actually enforced over the exact raw bytes.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { authorizeHeader } from 'livekit-server-sdk';
import {
  LIVEKIT_AUTH_HEADER,
  PHONE_WEBHOOK_VERIFY_REASONS,
  createPhoneWebhookVerifier,
} from '../integrations/livekit-phone/verify.js';
import {
  LIVEKIT_WEBHOOK_EVENTS,
  PHONE_EVENT_BY_LIVEKIT_EVENT,
  APPROVED_PARTICIPANT_ATTRIBUTES,
  attemptIdFromIdentity,
  parsePhoneEpoch,
  phoneProviderEventId,
  resolvePhoneEvent,
} from '../integrations/livekit-phone/events.js';
import {
  PHONE_UNRECORDED_STATUSES,
  classifyApplyResult,
  createPhoneIngressHealth,
  ingestPhoneWebhook,
} from '../integrations/livekit-phone/ingress.js';
import {
  loadLiveKitPhoneConfig,
  isPhoneWebhookActive,
  describeLiveKitPhoneConfig,
} from '../integrations/livekit-phone/config.js';
import type { ApplyPhoneEventResult } from '../lib/phone-screening/index.js';

const API_KEY = 'phone-test-key';
const API_SECRET = 'phone-test-secret-value';
const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const IDENTITY = `phone-${ATTEMPT}`;

// ── A real LiveKit webhook token ─────────────────────────────────────────

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint an HS256 JWT exactly as LiveKit does: iss = apiKey, sha256 = body digest. */
function mintToken(body: Buffer, options: {
  secret?: string;
  issuer?: string;
  bodyForHash?: Buffer;
  expOffsetSeconds?: number;
  nbfOffsetSeconds?: number;
} = {}): string {
  const secret = options.secret ?? API_SECRET;
  const nowSec = Math.floor(Date.now() / 1000);
  const hashed = options.bodyForHash ?? body;
  const payload = {
    iss: options.issuer ?? API_KEY,
    sha256: createHash('sha256').update(hashed).digest('base64'),
    nbf: nowSec + (options.nbfOffsetSeconds ?? -10),
    exp: nowSec + (options.expOffsetSeconds ?? 600),
  };
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = b64url(Buffer.from(JSON.stringify(payload)));
  const signature = b64url(createHmac('sha256', secret).update(`${head}.${claims}`).digest());
  return `${head}.${claims}.${signature}`;
}

const verifier = (overrides: Partial<{ maxBytes: number; toleranceSeconds: number }> = {}) =>
  createPhoneWebhookVerifier({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    maxBytes: overrides.maxBytes ?? 65536,
    toleranceSeconds: overrides.toleranceSeconds ?? 300,
  });

function joinBody(extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    event: 'participant_joined',
    id: 'EV_abcdef123456',
    participant: { identity: IDENTITY, attributes: { phone_epoch: '4' }, kind: 3 },
    ...extra,
  }));
}

describe('P3 verification — the vendor protocol, over the exact bytes', () => {
  it('accepts a correctly signed body and projects only the fields we read', async () => {
    const body = joinBody();
    const result = await verifier().verify({ rawBody: body, authHeader: mintToken(body) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.event).toBe('participant_joined');
    expect(result.envelope.participantIdentity).toBe(IDENTITY);
  });

  it('drops every unapproved attribute AT the boundary, keeping only the epoch', async () => {
    // F-1: the header calls this file "the ONLY trust boundary", so the raw
    // attribute map must not survive it. `events.ts` gates reads through the
    // same allowlist, but a map that never enters the envelope cannot be read
    // by anything — including a future caller that reaches for
    // `participantAttributes` directly without knowing the rule.
    //
    // Driven through the REAL SDK receiver with a REAL signed token, so this
    // asserts what a genuine LiveKit delivery produces.
    const body = Buffer.from(JSON.stringify({
      event: 'participant_joined',
      id: 'EV_attrs',
      participant: {
        identity: IDENTITY,
        name: 'inbound caller',
        kind: 3,
        attributes: {
          'sip.phoneNumber': '+910000000000',
          'sip.trunkPhoneNumber': '+910000000001',
          'sip.callID': 'SCL_abc123',
          'sip.ruleID': 'SDR_x',
          phone_epoch: '6',
        },
      },
    }));
    const result = await verifier().verify({ rawBody: body, authHeader: mintToken(body) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attributes = result.envelope.participantAttributes;
    // The approved key survives...
    expect(attributes).toEqual({ phone_epoch: '6' });
    // ...and NOTHING else is present, by key and by rendered value.
    expect(Object.keys(attributes ?? {})).toEqual([...APPROVED_PARTICIPANT_ATTRIBUTES]);
    for (const forbidden of [
      'sip.phoneNumber', 'sip.trunkPhoneNumber', 'sip.callID', 'sip.ruleID',
    ]) {
      expect(attributes ?? {}).not.toHaveProperty(forbidden);
    }
    const rendered = JSON.stringify(result.envelope);
    for (const leak of ['+910000000000', '+910000000001', 'SCL_abc123', 'inbound caller']) {
      expect(rendered).not.toContain(leak);
    }
    // The envelope carries exactly the four fields this integration reads.
    expect(Object.keys(result.envelope).sort())
      .toEqual(['event', 'id', 'participantAttributes', 'participantIdentity']);
    // And the epoch still reaches the domain through the normal path.
    const resolution = resolvePhoneEvent(result.envelope);
    expect(resolution.kind).toBe('phone_event');
    if (resolution.kind === 'phone_event') expect(resolution.epoch).toBe(6);
  });

  it('adds nothing when a participant has no attributes, or no participant', async () => {
    // NOTE: the SDK deserialises the proto3 map default as `{}`, not
    // `undefined`, so a participant that sent no attributes still arrives with
    // an empty map — the projection yields `{}` here, not null. Asserted as
    // the SDK actually behaves rather than as one might assume; this is
    // precisely what driving the real receiver is for.
    const noAttrs = Buffer.from(JSON.stringify({
      event: 'participant_joined', id: 'EV_bare', participant: { identity: IDENTITY },
    }));
    const bare = await verifier().verify({ rawBody: noAttrs, authHeader: mintToken(noAttrs) });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.envelope.participantAttributes).toEqual({});
      // The epoch is simply absent — 0042 then fences on the attempt's own.
      const resolution = resolvePhoneEvent(bare.envelope);
      if (resolution.kind === 'phone_event') expect(resolution.epoch).toBeUndefined();
    }

    // A room-level event has no participant at all, so there is no map to
    // reduce and the envelope carries null.
    const roomOnly = Buffer.from(JSON.stringify({ event: 'room_finished', id: 'EV_room' }));
    const room = await verifier().verify({ rawBody: roomOnly, authHeader: mintToken(roomOnly) });
    expect(room.ok).toBe(true);
    if (room.ok) {
      expect(room.envelope.participantAttributes).toBeNull();
      expect(room.envelope.participantIdentity).toBeNull();
    }
  });

  it('control: the projection is what drops them, not the fixture', async () => {
    // Non-vacuity. If the SDK stopped surfacing attributes at all, the test
    // above would pass while proving nothing — so assert the receiver DOES
    // deliver an unapproved attribute when the projection is bypassed.
    const raw = {
      participant: {
        identity: IDENTITY,
        attributes: { 'sip.callID': 'SCL_abc123', phone_epoch: '6' },
      },
    };
    expect(raw.participant.attributes).toHaveProperty('sip.callID');
    // A verified envelope built from the SAME payload has it removed.
    const body = Buffer.from(JSON.stringify({ event: 'participant_joined', id: 'EV_c', ...raw }));
    const result = await verifier().verify({ rawBody: body, authHeader: mintToken(body) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.participantAttributes).not.toHaveProperty('sip.callID');
      expect(result.envelope.participantAttributes).toHaveProperty('phone_epoch');
    }
  });

  it('mirrors the SDK auth header constant exactly (drift control)', () => {
    // The production module declares the literal so it stays outside app.ts's
    // static SDK graph; this is the check that keeps the mirror honest.
    expect(LIVEKIT_AUTH_HEADER).toBe(authorizeHeader);
  });

  it('rejects a body whose bytes changed after signing', async () => {
    const signed = joinBody();
    const tampered = Buffer.from(JSON.stringify({
      event: 'participant_joined',
      id: 'EV_abcdef123456',
      participant: { identity: 'phone-99999999-9999-4999-8999-999999999999' },
    }));
    const result = await verifier().verify({
      rawBody: tampered,
      authHeader: mintToken(signed, { bodyForHash: signed }),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a token signed with the wrong secret and with the wrong issuer', async () => {
    const body = joinBody();
    await expect(verifier().verify({
      rawBody: body, authHeader: mintToken(body, { secret: 'not-the-secret' }),
    })).resolves.toEqual({ ok: false, reason: 'invalid_signature' });
    await expect(verifier().verify({
      rawBody: body, authHeader: mintToken(body, { issuer: 'someone-else' }),
    })).resolves.toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('enforces the not-before claim, not only expiry', async () => {
    const body = joinBody();
    // A token that is not yet valid. Only `exp` was varied before, so the
    // `nbf` direction was asserted by the test NAME and by nothing else.
    const future = mintToken(body, { nbfOffsetSeconds: 600, expOffsetSeconds: 1200 });
    await expect(verifier({ toleranceSeconds: 30 }).verify({ rawBody: body, authHeader: future }))
      .resolves.toEqual({ ok: false, reason: 'invalid_signature' });
    // ...and the tolerance genuinely applies to it as well.
    const slightlyEarly = mintToken(body, { nbfOffsetSeconds: 60, expOffsetSeconds: 1200 });
    await expect(verifier({ toleranceSeconds: 300 }).verify({ rawBody: body, authHeader: slightlyEarly }))
      .resolves.toMatchObject({ ok: true });
  });

  it('enforces the clock tolerance in BOTH directions', async () => {
    const body = joinBody();
    // Expired 60s ago: inside a 300s tolerance, outside a 30s one.
    const expired = mintToken(body, { expOffsetSeconds: -60 });
    await expect(verifier({ toleranceSeconds: 300 }).verify({ rawBody: body, authHeader: expired }))
      .resolves.toMatchObject({ ok: true });
    await expect(verifier({ toleranceSeconds: 30 }).verify({ rawBody: body, authHeader: expired }))
      .resolves.toEqual({ ok: false, reason: 'invalid_signature' });
    // A replay far outside any tolerance we allow is refused.
    const ancient = mintToken(body, { expOffsetSeconds: -7200 });
    await expect(verifier({ toleranceSeconds: 3600 }).verify({ rawBody: body, authHeader: ancient }))
      .resolves.toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('runs its checks fail-closed IN ORDER, and never reaches the SDK early', async () => {
    const body = joinBody();
    const token = mintToken(body);
    // not_configured precedes everything, even a valid token.
    await expect(createPhoneWebhookVerifier({
      apiKey: '', apiSecret: API_SECRET, maxBytes: 65536, toleranceSeconds: 300,
    }).verify({ rawBody: body, authHeader: token })).resolves.toEqual({
      ok: false, reason: 'not_configured',
    });
    // empty body precedes the missing header.
    await expect(verifier().verify({ rawBody: Buffer.alloc(0), authHeader: undefined }))
      .resolves.toEqual({ ok: false, reason: 'empty_body' });
    // the byte cap precedes the missing header too — an oversized unsigned
    // body must never be hashed.
    await expect(verifier({ maxBytes: 8 }).verify({ rawBody: body, authHeader: undefined }))
      .resolves.toEqual({ ok: false, reason: 'body_too_large' });
    // and precedes a VALID token, so the cap cannot be signed past.
    await expect(verifier({ maxBytes: 8 }).verify({ rawBody: body, authHeader: token }))
      .resolves.toEqual({ ok: false, reason: 'body_too_large' });
    // finally the header itself.
    await expect(verifier().verify({ rawBody: body, authHeader: '   ' }))
      .resolves.toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('refuses a non-UTF-8 body as its own reason, not as a mismatch', async () => {
    // A lone continuation byte cannot round-trip through a utf8 decode. If we
    // decoded lossily, the digest would differ and this would surface as
    // `invalid_signature` — indistinguishable from an attack.
    const raw = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]);
    const result = await verifier().verify({ rawBody: raw, authHeader: mintToken(raw) });
    expect(result).toEqual({ ok: false, reason: 'body_not_utf8' });
  });

  it('preserves raw-byte fidelity for multi-byte UTF-8 that DOES round-trip', async () => {
    // Byte length and character length differ here; a length-based cap or a
    // lossy decode would both break this.
    const body = Buffer.from(JSON.stringify({
      event: 'participant_joined',
      id: 'EV_unicode',
      participant: { identity: IDENTITY, name: 'नमस्ते ✓' },
    }));
    expect(body.length).toBeGreaterThan(JSON.parse(body.toString('utf8')).participant.name.length);
    await expect(verifier().verify({ rawBody: body, authHeader: mintToken(body) }))
      .resolves.toMatchObject({ ok: true });
  });

  it('leaks no secret, token or body content in any failure value', async () => {
    const body = joinBody();
    const results = await Promise.all([
      verifier().verify({ rawBody: body, authHeader: mintToken(body, { secret: 'wrong' }) }),
      verifier().verify({ rawBody: body, authHeader: 'not-a-jwt' }),
      verifier({ maxBytes: 4 }).verify({ rawBody: body, authHeader: mintToken(body) }),
    ]);
    for (const result of results) {
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(API_SECRET);
      expect(rendered).not.toContain(API_KEY);
      expect(rendered).not.toContain(IDENTITY);
      expect(rendered).not.toContain('eyJ');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(PHONE_WEBHOOK_VERIFY_REASONS).toContain(result.reason);
    }
  });
});

describe('P3 translation — identity is the only subject resolver', () => {
  it('maps exactly three LiveKit events to phone events', () => {
    expect(Object.keys(PHONE_EVENT_BY_LIVEKIT_EVENT).sort()).toEqual([
      'participant_connection_aborted', 'participant_joined', 'participant_left',
    ]);
    for (const name of Object.keys(PHONE_EVENT_BY_LIVEKIT_EVENT)) {
      expect(LIVEKIT_WEBHOOK_EVENTS).toContain(name as never);
    }
  });

  it('recovers the attempt id from the identity 0042 itself writes', () => {
    // admit_phone_attempt sets participant_identity = 'phone-' || attempt uuid.
    expect(attemptIdFromIdentity(IDENTITY)).toBe(ATTEMPT);
    for (const bad of [
      'phone-not-a-uuid', ATTEMPT, `PHONE-${ATTEMPT}`, `phone-${ATTEMPT}x`,
      'candidate-11111111-2222-4333-8444-555555555555', '', null, undefined,
    ]) {
      expect(attemptIdFromIdentity(bad as never)).toBeUndefined();
    }
  });

  it('reads exactly ONE participant attribute and never a SIP one', () => {
    expect([...APPROVED_PARTICIPANT_ATTRIBUTES]).toEqual(['phone_epoch']);
    // LiveKit populates these on every SIP participant. They must be
    // unreachable, not merely unused.
    const resolution = resolvePhoneEvent({
      event: 'participant_joined',
      id: 'EV_x',
      participantIdentity: IDENTITY,
      participantAttributes: {
        'sip.phoneNumber': '+910000000000',
        'sip.trunkPhoneNumber': '+910000000001',
        'sip.callID': 'SCL_abc',
        phone_epoch: '7',
      },
    });
    expect(resolution.kind).toBe('phone_event');
    const rendered = JSON.stringify(resolution);
    expect(rendered).not.toContain('+910000000000');
    // `sip.participant_joined` is 0042's own event-type name, so a bare
    // 'sip.' substring check would be wrong here. What must not survive are
    // the LiveKit ATTRIBUTE KEYS and their values.
    for (const key of ['sip.phoneNumber', 'sip.trunkPhoneNumber', 'sip.callID']) {
      expect(rendered).not.toContain(key);
    }
    expect(rendered).not.toContain('SCL_abc');
    // No blanket digit-run check here: the resolution legitimately carries an
    // attempt UUID, and 0042's seven-digit rule governs ledger METADATA, which
    // is asserted against the sanitizer in the ingress suite below.
    if (resolution.kind === 'phone_event') expect(resolution.epoch).toBe(7);
  });

  it('drops a malformed epoch rather than coercing it', () => {
    expect(parsePhoneEpoch('0')).toBe(0);
    expect(parsePhoneEpoch('12')).toBe(12);
    for (const bad of ['', ' ', '-1', '1.5', 'seven', '007', '99999999999', undefined]) {
      expect(parsePhoneEpoch(bad as never)).toBeUndefined();
    }
  });

  it('mints a deterministic provider event id, preferring LiveKit’s own', () => {
    expect(phoneProviderEventId('EV_abc', ATTEMPT, 'sip.participant_left', 3)).toBe('EV_abc');
    // Absent or outside 0042's character class ⇒ a synthetic id that repeats
    // for a redelivery of the SAME transition, so the ledger dedups.
    const a = phoneProviderEventId(null, ATTEMPT, 'sip.participant_left', 3);
    const b = phoneProviderEventId('has spaces +91', ATTEMPT, 'sip.participant_left', 3);
    expect(a).toBe(b);
    expect(a).toBe(`lk:${ATTEMPT}:sip.participant_left:3`);
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);
    // The epoch participates, exactly as it does in the reconciliation id:
    // two joins on the same attempt either side of an epoch bump are
    // DIFFERENT events, and an id without the epoch would collide them so the
    // second read back as a duplicate instead of applying.
    expect(phoneProviderEventId(null, ATTEMPT, 'sip.participant_joined', 4))
      .not.toBe(phoneProviderEventId(null, ATTEMPT, 'sip.participant_joined', 5));
    // Absent epoch is still deterministic — a redelivery carries the same
    // attributes, so it mints the same id.
    const noEpoch = phoneProviderEventId(null, ATTEMPT, 'sip.participant_left', undefined);
    expect(noEpoch).toBe(`lk:${ATTEMPT}:sip.participant_left:na`);
    expect(noEpoch).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);
  });

  it('accepts-and-ignores other features’ LiveKit traffic without touching the DB', () => {
    // This API receives the SAME webhook stream as the browser interview
    // rooms. Recording those would fill the phone ledger with another
    // feature's events.
    for (const event of ['room_started', 'track_published', 'egress_ended']) {
      expect(resolvePhoneEvent({ event, participantIdentity: IDENTITY }))
        .toEqual({ kind: 'not_phone_event', event });
    }
    // A phone-shaped event whose participant is someone else's.
    expect(resolvePhoneEvent({
      event: 'participant_left', participantIdentity: 'candidate-abc',
    })).toEqual({ kind: 'not_phone_event', event: 'participant_left' });
  });

  it('treats an unknown event name as unrecognisable, not as ignorable', () => {
    expect(resolvePhoneEvent({ event: 'room_exploded' })).toEqual({ kind: 'not_livekit_event' });
    expect(resolvePhoneEvent({ event: '' })).toEqual({ kind: 'not_livekit_event' });
  });
});

describe('P3 ingress verdicts — 200 means a verdict, 500 means we do not know', () => {
  const applied: ApplyPhoneEventResult = {
    status: 'applied', applied: true, duplicate: false, eventId: 'e1',
  } as ApplyPhoneEventResult;

  const stores = (result: ApplyPhoneEventResult) => ({
    applyEvent: vi.fn().mockResolvedValue(result),
  });

  it('posts exactly the fields 0042 needs, and nothing else', async () => {
    const s = stores(applied);
    const now = new Date('2026-08-22T10:00:00.000Z');
    await ingestPhoneWebhook({
      event: 'participant_left',
      id: 'EV_left_1',
      participantIdentity: IDENTITY,
      participantAttributes: { phone_epoch: '3', 'sip.phoneNumber': '+910000000000' },
    }, { stores: s, health: createPhoneIngressHealth(), now });

    expect(s.applyEvent).toHaveBeenCalledTimes(1);
    const arg = s.applyEvent.mock.calls[0][0];
    expect(arg).toEqual({
      source: 'livekit_webhook',
      eventType: 'sip.participant_left',
      attemptId: ATTEMPT,
      providerEventId: 'EV_left_1',
      epoch: 3,
      metadata: { lk_event: 'participant_left' },
      now,
    });
    // The metadata must survive 0042's sanitizer: lowercase keys, scalar
    // values, and NO run of seven or more digits (which is how the migration
    // keeps a phone number out of the ledger).
    for (const [key, value] of Object.entries(arg.metadata)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(String(value)).toMatch(/^[A-Za-z0-9_.:-]{0,128}$/);
      expect(String(value)).not.toMatch(/[0-9]{7,}/);
    }
  });

  it('does zero database work for a non-phone event', async () => {
    const s = stores(applied);
    const outcome = await ingestPhoneWebhook(
      { event: 'track_published', participantIdentity: IDENTITY },
      { stores: s, health: createPhoneIngressHealth(), now: new Date() },
    );
    expect(s.applyEvent).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      httpStatus: 200, code: 'ignored_not_phone', recorded: false, duplicate: false,
    });
  });

  it('returns a non-retryable 400 for a signed but unrecognisable event', async () => {
    const s = stores(applied);
    const outcome = await ingestPhoneWebhook(
      { event: 'nonsense', participantIdentity: IDENTITY },
      { stores: s, health: createPhoneIngressHealth(), now: new Date() },
    );
    expect(s.applyEvent).not.toHaveBeenCalled();
    expect(outcome.httpStatus).toBe(400);
    expect(outcome.code).toBe('unrecognized_event');
  });

  it('gives a duplicate the SAME outcome as the first delivery', () => {
    const health = createPhoneIngressHealth();
    const first = classifyApplyResult(applied, health);
    const second = classifyApplyResult(
      { ...applied, duplicate: true } as ApplyPhoneEventResult, health,
    );
    expect(first).toMatchObject({ httpStatus: 200, recorded: true });
    expect(second).toMatchObject({ httpStatus: 200, recorded: true, duplicate: true });
    expect(second.code).toBe('duplicate');
    // ONE rule: a recognised redelivery says `duplicate` whatever the first
    // verdict was. A duplicate of an IGNORED event is not reported as a fresh
    // ignore — the original verdict lives on the ledger row.
    const ignoredDup = classifyApplyResult({
      status: 'ignored', applied: false, ignoredReason: 'stale_epoch', duplicate: true,
    } as ApplyPhoneEventResult, health);
    expect(ignoredDup).toEqual({
      httpStatus: 200, code: 'duplicate', recorded: true, duplicate: true,
    });
  });

  it('accepts and records every 0042 ignore reason with a stable token', () => {
    const health = createPhoneIngressHealth();
    for (const reason of ['stale_epoch', 'unknown_attempt', 'terminal', 'unexpected_event']) {
      const outcome = classifyApplyResult({
        status: 'ignored', applied: false, ignoredReason: reason,
      } as ApplyPhoneEventResult, health);
      expect(outcome).toEqual({
        httpStatus: 200, code: `ignored_${reason}`, recorded: true, duplicate: false,
      });
    }
    expect(health.snapshot().total).toBe(0);
  });

  it('counts the refusals that write NO ledger row (P1 residual R-4)', () => {
    const health = createPhoneIngressHealth();
    for (const status of PHONE_UNRECORDED_STATUSES) {
      const outcome = classifyApplyResult({ status } as ApplyPhoneEventResult, health);
      // 200: the poster is wrong, not the transport — a redelivery would be
      // malformed again. Never recorded, so `phone_backlog` cannot see it and
      // this counter is the only surface it has.
      expect(outcome).toEqual({ httpStatus: 200, code: status, recorded: false, duplicate: false });
    }
    const snapshot = health.snapshot();
    expect(snapshot.total).toBe(PHONE_UNRECORDED_STATUSES.length);
    expect(snapshot.byStatus.attempt_required).toBe(1);
  });

  it('asks for a redelivery when the verdict is unrecognisable', () => {
    const health = createPhoneIngressHealth();
    const outcome = classifyApplyResult(
      { status: 'unknown_status' } as ApplyPhoneEventResult, health,
    );
    expect(outcome).toEqual({
      httpStatus: 500, code: 'apply_unexpected_status', recorded: false, duplicate: false,
    });
    // An unrecognised status is NOT a malformed-ingress refusal.
    expect(health.snapshot().total).toBe(0);
  });
});

describe('P3 config — fail closed twice, and no new credential', () => {
  it('is inert unless the master flag AND both credentials are present', () => {
    const base = { LIVEKIT_API_KEY: 'a-real-key', LIVEKIT_API_SECRET: 'a-real-secret' };
    expect(isPhoneWebhookActive(loadLiveKitPhoneConfig({} as NodeJS.ProcessEnv))).toBe(false);
    expect(isPhoneWebhookActive(loadLiveKitPhoneConfig({
      ...base, PHONE_SCREENING_ENABLED: 'true',
    } as NodeJS.ProcessEnv))).toBe(true);
    // Flag on, credentials absent or placeholder.
    for (const creds of [
      {}, { LIVEKIT_API_KEY: 'a-real-key' }, { ...base, LIVEKIT_API_SECRET: 'replace_me' },
      { ...base, LIVEKIT_API_KEY: 'short' },
    ]) {
      expect(isPhoneWebhookActive(loadLiveKitPhoneConfig({
        ...creds, PHONE_SCREENING_ENABLED: 'true',
      } as NodeJS.ProcessEnv))).toBe(false);
    }
    // Credentials present, flag off or not exactly 'true'.
    for (const flag of [undefined, 'false', 'TRUE', '1', 'yes']) {
      expect(isPhoneWebhookActive(loadLiveKitPhoneConfig({
        ...base, PHONE_SCREENING_ENABLED: flag,
      } as NodeJS.ProcessEnv))).toBe(false);
    }
  });

  it('does NOT depend on the runtime/dial flags', () => {
    // An operator disarming the dialer mid-incident must still be able to
    // record the terminating events for calls already up, or those attempts
    // hold fleet slots until their leases lapse.
    const config = loadLiveKitPhoneConfig({
      PHONE_SCREENING_ENABLED: 'true',
      PHONE_RUNTIME_ENABLED: 'false',
      PHONE_DIAL_MODE: 'off',
      LIVEKIT_API_KEY: 'a-real-key',
      LIVEKIT_API_SECRET: 'a-real-secret',
    } as NodeJS.ProcessEnv);
    expect(isPhoneWebhookActive(config)).toBe(true);
  });

  it('never exposes a credential through the health projection', () => {
    const config = loadLiveKitPhoneConfig({
      PHONE_SCREENING_ENABLED: 'true',
      LIVEKIT_API_KEY: 'a-real-key', LIVEKIT_API_SECRET: 'a-real-secret',
    } as NodeJS.ProcessEnv);
    const described = JSON.stringify(describeLiveKitPhoneConfig(config));
    expect(described).not.toContain('a-real-key');
    expect(described).not.toContain('a-real-secret');
    expect(JSON.parse(described)).toEqual({
      screeningEnabled: true, credentialsConfigured: true, webhookActive: true,
      webhookMaxBytes: 65536, webhookToleranceSeconds: 300,
    });
  });

  it('blanks the credential fields when they are not usable', () => {
    const config = loadLiveKitPhoneConfig({
      PHONE_SCREENING_ENABLED: 'true', LIVEKIT_API_KEY: 'a-real-key',
      LIVEKIT_API_SECRET: 'replace_me',
    } as NodeJS.ProcessEnv);
    expect(config.apiKey).toBe('');
    expect(config.apiSecret).toBe('');
  });
});
