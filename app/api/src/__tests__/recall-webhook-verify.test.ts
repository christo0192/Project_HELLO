/**
 * Recall.ai webhook verifier (Svix / Standard Webhooks scheme), M034 S01 T5: the published
 * known-answer vector, both header sets and the mixed-set rules, tamper and re-serialisation
 * mismatches, the replay window against an injected clock (including a broken clock), malformed
 * id / timestamp / signature headers, entry and length bounds, body bounds, unusable secrets, and
 * that no result carries the secret, the body or a signature.
 *
 * Secrets are generated at run time (the known-answer one is assembled from parts), so no
 * Svix-prefixed base64 literal exists in source. Signatures come from the independent signer in
 * `support/meet-webhook-signing.ts`, never from the verifier itself.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECALL_WEBHOOK_DEFAULT_MAX_BYTES,
  RECALL_WEBHOOK_DEFAULT_TOLERANCE_SEC,
  RECALL_WEBHOOK_MAX_SIGNATURE_ENTRIES,
  RECALL_WEBHOOK_MAX_SIGNATURE_HEADER_LENGTH,
  verifyRecallWebhook,
  type RecallWebhookHeaders,
  type RecallWebhookVerifyOptions,
  type RecallWebhookVerifyReason,
  type RecallWebhookVerifyResult,
} from '../integrations/recall/webhook-verify.js';
import {
  RECALL_WEBHOOK_SECRET_PREFIX_FOR_TESTS as PREFIX,
  makeRecallWebhookSecret,
  recallWebhookV1Signature,
  signRecallWebhook,
} from './support/meet-webhook-signing.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW_SEC = 1_764_585_000; // 2025-12-01T10:30:00Z
const NOW_MS = NOW_SEC * 1000;
const MSG_ID = 'msg_2fixtureRecallDelivery01';
const EVENT_BODY = JSON.stringify({
  event: 'participant_events.join',
  data: {
    bot: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', metadata: { profile: 'r1_dex_sales' } },
    data: { participant: { id: 100, is_host: false } },
  },
});
const ONE_MIB = 1024 * 1024;

const REASONS: readonly RecallWebhookVerifyReason[] = [
  'not_configured',
  'empty_body',
  'body_too_large',
  'missing_headers',
  'malformed_id',
  'malformed_timestamp',
  'timestamp_out_of_tolerance',
  'malformed_signature',
  'mismatch',
];

type Headers = Record<string, string | string[] | undefined>;

interface Delivery {
  readonly secret: string;
  readonly body: Buffer;
  readonly headers: Headers;
  /** The real `v1,<b64>` entry for this delivery. */
  readonly signature: string;
}

function delivery(input: {
  secret?: string;
  id?: string;
  timestamp?: number | string;
  body?: string | Buffer;
  headerStyle?: 'webhook' | 'svix';
  extraSignatures?: readonly string[];
} = {}): Delivery {
  const secret = input.secret ?? makeRecallWebhookSecret();
  const body =
    input.body === undefined
      ? Buffer.from(EVENT_BODY, 'utf8')
      : typeof input.body === 'string'
        ? Buffer.from(input.body, 'utf8')
        : input.body;
  const id = input.id ?? MSG_ID;
  const timestamp = input.timestamp ?? NOW_SEC;
  return {
    secret,
    body,
    headers: signRecallWebhook({
      secret,
      id,
      timestamp,
      body,
      headerStyle: input.headerStyle,
      extraSignatures: input.extraSignatures,
    }),
    signature: recallWebhookV1Signature({ secret, id, timestamp, body }),
  };
}

function verify(
  d: { secret: string; body: Buffer; headers: Headers },
  options: RecallWebhookVerifyOptions = {},
): RecallWebhookVerifyResult {
  return verifyRecallWebhook(d.body, d.headers, d.secret, { now: () => NOW_MS, ...options });
}

/** The same delivery with its signature header replaced. */
function withSignature(d: Delivery, value: string | string[]): Delivery {
  return { ...d, headers: { ...d.headers, 'webhook-signature': value } };
}

function payloadOf(entry: string): string {
  return entry.slice('v1,'.length);
}

function ok(timestampSec = NOW_SEC, webhookId = MSG_ID): RecallWebhookVerifyResult {
  return { ok: true, webhookId, timestampSec };
}

function fail(reason: RecallWebhookVerifyReason): RecallWebhookVerifyResult {
  return { ok: false, reason };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * A non-canonical spelling of a 32-byte base64 value: the 43rd character carries 2 padding bits,
 * which a canonical encoder leaves at zero. Setting one decodes to the SAME bytes.
 */
function nonCanonical(payload: string): string {
  const index = BASE64_ALPHABET.indexOf(payload[42]!);
  return payload.slice(0, 42) + BASE64_ALPHABET[index | 1] + '=';
}

// ── Known-answer vector ─────────────────────────────────────────────────────

describe('verifyRecallWebhook — Standard Webhooks known-answer vector', () => {
  // The published spec example, assembled at run time (identifiers carry no credential words).
  const SPEC_PART_A = 'MfKQ9r8GKYqrTwjUPD8I';
  const SPEC_PART_B = 'LPZIo2LaLaSw';
  const specText = 'whsec' + '_' + SPEC_PART_A + SPEC_PART_B;
  const SPEC_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const SPEC_TIMESTAMP = '1614265330';
  const SPEC_BODY = '{"test": 2432232314}';
  const SPEC_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
  const specClock = () => 1614265330000;

  it('accepts the spec delivery on the webhook-* headers', () => {
    const headers = {
      'webhook-id': SPEC_ID,
      'webhook-timestamp': SPEC_TIMESTAMP,
      'webhook-signature': SPEC_SIGNATURE,
    };
    expect(verifyRecallWebhook(Buffer.from(SPEC_BODY, 'utf8'), headers, specText, { now: specClock })).toStrictEqual({
      ok: true,
      webhookId: SPEC_ID,
      timestampSec: 1614265330,
    });
  });

  it('accepts the same delivery on the legacy svix-* headers', () => {
    const headers = { 'svix-id': SPEC_ID, 'svix-timestamp': SPEC_TIMESTAMP, 'svix-signature': SPEC_SIGNATURE };
    expect(verifyRecallWebhook(Buffer.from(SPEC_BODY, 'utf8'), headers, specText, { now: specClock })).toStrictEqual(
      ok(1614265330, SPEC_ID),
    );
  });

  it('the independent test signer reproduces the spec signature', () => {
    expect(
      recallWebhookV1Signature({ secret: specText, id: SPEC_ID, timestamp: SPEC_TIMESTAMP, body: SPEC_BODY }),
    ).toBe(SPEC_SIGNATURE);
  });

  it('rejects the spec delivery when one body byte changes or the vector is replayed late', () => {
    const headers = {
      'webhook-id': SPEC_ID,
      'webhook-timestamp': SPEC_TIMESTAMP,
      'webhook-signature': SPEC_SIGNATURE,
    };
    expect(
      verifyRecallWebhook(Buffer.from('{"test": 2432232315}', 'utf8'), headers, specText, { now: specClock }),
    ).toStrictEqual(fail('mismatch'));
    expect(verifyRecallWebhook(Buffer.from(SPEC_BODY, 'utf8'), headers, specText, { now: () => NOW_MS })).toStrictEqual(
      fail('timestamp_out_of_tolerance'),
    );
  });
});

// ── Header sets ─────────────────────────────────────────────────────────────

describe('verifyRecallWebhook — header sets', () => {
  it('accepts a valid webhook-* delivery and returns the id and timestamp for de-duplication', () => {
    const result = verify(delivery());
    expect(result).toStrictEqual(ok());
    expect(Object.keys(result)).toEqual(['ok', 'webhookId', 'timestampSec']);
  });

  it('accepts a valid legacy svix-* delivery', () => {
    const d = delivery({ headerStyle: 'svix' });
    expect(Object.keys(d.headers).sort()).toEqual(['svix-id', 'svix-signature', 'svix-timestamp']);
    expect(verify(d)).toStrictEqual(ok());
  });

  it('uses the webhook-* set when both sets are present, ignoring every svix-* header', () => {
    const d = delivery();
    const other = delivery({ id: 'msg_other', timestamp: NOW_SEC - 5000 });
    // A wrong svix-signature (and a different svix id / stale timestamp) alongside a right webhook-* set.
    const both = {
      ...d,
      headers: {
        ...d.headers,
        'svix-id': 'msg_other',
        'svix-timestamp': String(NOW_SEC - 5000),
        'svix-signature': other.signature,
      },
    };
    expect(verify(both)).toStrictEqual(ok());
    // And the converse: a right svix set never rescues a wrong webhook-signature.
    const svixRight = delivery({ secret: d.secret, headerStyle: 'svix' });
    const rescued = { ...d, headers: { ...svixRight.headers, ...withSignature(d, other.signature).headers } };
    expect(verify(rescued)).toStrictEqual(fail('mismatch'));
  });

  it('never borrows a missing webhook-* header from the svix-* set', () => {
    const d = delivery();
    const svix = delivery({ secret: d.secret, headerStyle: 'svix' });
    const headers = { ...svix.headers, 'webhook-id': d.headers['webhook-id'] };
    expect(verify({ ...d, headers })).toStrictEqual(fail('missing_headers'));
  });

  it('rejects an svix-* set that carries a stray webhook-timestamp or webhook-signature', () => {
    const d = delivery({ headerStyle: 'svix' });
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-signature': d.signature } })).toStrictEqual(
      fail('missing_headers'),
    );
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-timestamp': String(NOW_SEC) } })).toStrictEqual(
      fail('missing_headers'),
    );
  });

  it.each([
    ['webhook', 'webhook-id'],
    ['webhook', 'webhook-timestamp'],
    ['webhook', 'webhook-signature'],
    ['svix', 'svix-id'],
    ['svix', 'svix-timestamp'],
    ['svix', 'svix-signature'],
  ] as const)('rejects a %s set without %s', (headerStyle, name) => {
    const d = delivery({ headerStyle });
    const headers = { ...d.headers };
    delete headers[name];
    expect(verify({ ...d, headers })).toStrictEqual(fail('missing_headers'));
    // An explicitly undefined header is the same as an absent one.
    expect(verify({ ...d, headers: { ...d.headers, [name]: undefined } })).toStrictEqual(fail('missing_headers'));
  });

  it('rejects no headers, non-object headers, inherited headers and non-lower-case names', () => {
    const d = delivery();
    expect(verify({ ...d, headers: {} })).toStrictEqual(fail('missing_headers'));
    for (const headers of [null, undefined, 'webhook-id', 42, true]) {
      expect(
        verifyRecallWebhook(d.body, headers as unknown as RecallWebhookHeaders, d.secret, { now: () => NOW_MS }),
        String(headers),
      ).toStrictEqual(fail('missing_headers'));
    }
    // A header only on the prototype is not a header of this request.
    const inherited = Object.create(d.headers) as Headers;
    expect(verify({ ...d, headers: inherited })).toStrictEqual(fail('missing_headers'));
    // Names are read exactly as Node presents them: lower case.
    const capitalised = {
      'Webhook-Id': d.headers['webhook-id'],
      'Webhook-Timestamp': d.headers['webhook-timestamp'],
      'Webhook-Signature': d.headers['webhook-signature'],
    };
    expect(verify({ ...d, headers: capitalised })).toStrictEqual(fail('missing_headers'));
  });

  it('accepts a null-prototype header map (own properties only)', () => {
    const d = delivery();
    const headers = Object.assign(Object.create(null) as Headers, d.headers);
    expect(verify({ ...d, headers })).toStrictEqual(ok());
  });
});

// ── Tamper and re-serialisation ─────────────────────────────────────────────

describe('verifyRecallWebhook — the MAC covers the exact bytes', () => {
  it('rejects a body with one flipped byte', () => {
    const d = delivery();
    for (const index of [0, Math.floor(d.body.length / 2), d.body.length - 1]) {
      const tampered = Buffer.from(d.body);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(verify({ ...d, body: tampered }), String(index)).toStrictEqual(fail('mismatch'));
    }
  });

  it('rejects a re-serialised JSON body (same data, different bytes)', () => {
    const spaced = '{"event": "participant_events.leave", "data": {"bot": {"id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"}}}';
    const d = delivery({ body: spaced });
    expect(verify(d)).toStrictEqual(ok());
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(spaced)), 'utf8');
    expect(reserialised.equals(d.body)).toBe(false);
    expect(verify({ ...d, body: reserialised })).toStrictEqual(fail('mismatch'));
  });

  it('rejects a signature made with another secret', () => {
    const d = delivery();
    expect(verify({ ...d, secret: makeRecallWebhookSecret() })).toStrictEqual(fail('mismatch'));
  });

  it('rejects a changed id or timestamp (both are inside the MAC)', () => {
    const d = delivery();
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-id': 'msg_2fixtureRecallDelivery02' } })).toStrictEqual(
      fail('mismatch'),
    );
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-timestamp': String(NOW_SEC + 1) } })).toStrictEqual(
      fail('mismatch'),
    );
  });

  it('verifies a non-ASCII UTF-8 body over its raw bytes', () => {
    const text = JSON.stringify({ event: 'participant_events.join', data: { note: 'caf\u00e9 \u2713 \u65e5\u672c\u8a9e \u{1F399}' } });
    const d = delivery({ body: text });
    expect(d.body.length).toBeGreaterThan(text.length);
    expect(verify(d)).toStrictEqual(ok());
    // The same characters in another encoding are different bytes.
    expect(verify({ ...d, body: Buffer.from(text, 'latin1') })).toStrictEqual(fail('mismatch'));
  });

  it('keeps the timestamp text as signed: leading zeros verify and parse to the same second', () => {
    const d = delivery({ timestamp: `0${NOW_SEC}` });
    expect(verify(d)).toStrictEqual(ok(NOW_SEC));
  });
});

// ── Replay window ───────────────────────────────────────────────────────────

describe('verifyRecallWebhook — replay window', () => {
  it(`accepts exactly ±${RECALL_WEBHOOK_DEFAULT_TOLERANCE_SEC} s and rejects ±301 s by default`, () => {
    expect(RECALL_WEBHOOK_DEFAULT_TOLERANCE_SEC).toBe(300);
    expect(verify(delivery({ timestamp: NOW_SEC - 300 }))).toStrictEqual(ok(NOW_SEC - 300));
    expect(verify(delivery({ timestamp: NOW_SEC + 300 }))).toStrictEqual(ok(NOW_SEC + 300));
    expect(verify(delivery({ timestamp: NOW_SEC - 301 }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
    expect(verify(delivery({ timestamp: NOW_SEC + 301 }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
  });

  it('rejects an ancient or a zero timestamp', () => {
    expect(verify(delivery({ timestamp: 1 }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
    expect(verify(delivery({ timestamp: 0 }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
    expect(verify(delivery({ timestamp: '999999999999' }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
  });

  it('honours a smaller window', () => {
    expect(verify(delivery({ timestamp: NOW_SEC - 10 }), { toleranceSec: 10 })).toStrictEqual(ok(NOW_SEC - 10));
    expect(verify(delivery({ timestamp: NOW_SEC + 10 }), { toleranceSec: 10 })).toStrictEqual(ok(NOW_SEC + 10));
    expect(verify(delivery({ timestamp: NOW_SEC - 11 }), { toleranceSec: 10 })).toStrictEqual(
      fail('timestamp_out_of_tolerance'),
    );
    expect(verify(delivery({ timestamp: NOW_SEC + 11 }), { toleranceSec: 10 })).toStrictEqual(
      fail('timestamp_out_of_tolerance'),
    );
  });

  it('clamps a huge window to 600 s and a zero or negative window to 1 s', () => {
    expect(verify(delivery({ timestamp: NOW_SEC - 600 }), { toleranceSec: 10_000 })).toStrictEqual(ok(NOW_SEC - 600));
    expect(verify(delivery({ timestamp: NOW_SEC - 601 }), { toleranceSec: 10_000 })).toStrictEqual(
      fail('timestamp_out_of_tolerance'),
    );
    expect(verify(delivery({ timestamp: NOW_SEC + 601 }), { toleranceSec: 10_000 })).toStrictEqual(
      fail('timestamp_out_of_tolerance'),
    );
    for (const toleranceSec of [0, -50]) {
      expect(verify(delivery({ timestamp: NOW_SEC - 1 }), { toleranceSec })).toStrictEqual(ok(NOW_SEC - 1));
      expect(verify(delivery({ timestamp: NOW_SEC - 2 }), { toleranceSec })).toStrictEqual(
        fail('timestamp_out_of_tolerance'),
      );
    }
  });

  it('falls back to the default window for a non-integer or non-finite option', () => {
    for (const toleranceSec of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(verify(delivery({ timestamp: NOW_SEC - 300 }), { toleranceSec }), String(toleranceSec)).toStrictEqual(
        ok(NOW_SEC - 300),
      );
      expect(verify(delivery({ timestamp: NOW_SEC - 301 }), { toleranceSec }), String(toleranceSec)).toStrictEqual(
        fail('timestamp_out_of_tolerance'),
      );
    }
  });

  it('fails closed on a broken clock: throwing, NaN, infinite or not a number', () => {
    const d = delivery();
    const clocks: Array<() => number> = [
      () => {
        throw new Error('clock unavailable');
      },
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
      () => Number.NEGATIVE_INFINITY,
      (() => String(NOW_MS)) as unknown as () => number,
      (() => undefined) as unknown as () => number,
    ];
    for (const now of clocks) {
      expect(verify(d, { now })).toStrictEqual(fail('timestamp_out_of_tolerance'));
    }
  });

  it('uses the real clock when none is injected', () => {
    const d = delivery({ timestamp: Math.floor(Date.now() / 1000) });
    const result = verifyRecallWebhook(d.body, d.headers, d.secret);
    expect(result.ok).toBe(true);
    const stale = delivery({ timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(verifyRecallWebhook(stale.body, stale.headers, stale.secret)).toStrictEqual(
      fail('timestamp_out_of_tolerance'),
    );
  });
});

// ── Malformed id and timestamp ──────────────────────────────────────────────

describe('verifyRecallWebhook — malformed id and timestamp', () => {
  it.each([
    ['12a'],
    ['1764585000000'], // 13 digits
    [''],
    [' 1764585000'],
    ['1764585000 '],
    ['-1764585000'],
    ['+1764585000'],
    ['1.7e9'],
    ['1764585000.5'],
    ['\uff11\uff17\uff16\uff14\uff15\uff18\uff15\uff10\uff10\uff10'], // full-width digits
  ])('rejects the timestamp %j', (timestamp) => {
    const d = delivery();
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-timestamp': timestamp } })).toStrictEqual(
      fail('malformed_timestamp'),
    );
  });

  it('rejects a repeated (array-valued) timestamp header', () => {
    const d = delivery();
    const ts = String(NOW_SEC);
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-timestamp': [ts, ts] } })).toStrictEqual(
      fail('malformed_timestamp'),
    );
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-timestamp': [ts] } })).toStrictEqual(
      fail('malformed_timestamp'),
    );
  });

  it('accepts 12 digits (the format bound) and 1 digit as well formed', () => {
    // Well formed, so the failure is the window, not the format.
    expect(verify(delivery({ timestamp: '100000000000' }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
    expect(verify(delivery({ timestamp: '7' }))).toStrictEqual(fail('timestamp_out_of_tolerance'));
  });

  it.each([
    ['msg with space'],
    ['a'.repeat(129)],
    [''],
    ['msg/1'],
    ['msg_1\n'],
    ['msg_\u00e9'],
  ])('rejects the id %j', (id) => {
    const d = delivery({ id });
    expect(verify(d)).toStrictEqual(fail('malformed_id'));
  });

  it('accepts a 128-character id of the allowed alphabet', () => {
    const id = ('msg_A-z.0:9_' + 'x'.repeat(128)).slice(0, 128);
    expect(id).toHaveLength(128);
    expect(verify(delivery({ id }))).toStrictEqual(ok(NOW_SEC, id));
  });

  it('rejects a repeated (array-valued) id header', () => {
    const d = delivery();
    expect(verify({ ...d, headers: { ...d.headers, 'webhook-id': [MSG_ID, MSG_ID] } })).toStrictEqual(
      fail('malformed_id'),
    );
  });
});

// ── Signature header ────────────────────────────────────────────────────────

describe('verifyRecallWebhook — signature header', () => {
  const asymmetric = 'v1a,' + randomBytes(64).toString('base64');

  it('rejects a header with only a non-v1 (asymmetric) entry', () => {
    const d = delivery();
    expect(verify(withSignature(d, asymmetric))).toStrictEqual(fail('malformed_signature'));
  });

  it('ignores other versions and accepts any matching v1 entry', () => {
    const wrong = delivery().signature; // a well-formed v1 entry under another secret
    expect(verify(delivery({ extraSignatures: ['v2,x'] }))).toStrictEqual(ok());
    expect(verify(delivery({ extraSignatures: [asymmetric] }))).toStrictEqual(ok());
    expect(verify(delivery({ extraSignatures: [wrong] }))).toStrictEqual(ok());
    const d = delivery();
    expect(verify(withSignature(d, `${d.signature} ${wrong}`))).toStrictEqual(ok());
    expect(verify(withSignature(d, `${wrong} ${asymmetric} ${d.signature}`))).toStrictEqual(ok());
  });

  it('is a mismatch when every v1 entry is well formed but none matches', () => {
    const d = delivery();
    const wrongA = delivery().signature;
    const wrongB = delivery().signature;
    expect(verify(withSignature(d, `${wrongA} ${asymmetric} ${wrongB}`))).toStrictEqual(fail('mismatch'));
  });

  it('rejects a v1 entry that is not the canonical base64 of 32 bytes', () => {
    const d = delivery();
    const payload = payloadOf(d.signature);
    expect(payload).toHaveLength(44);
    const altered = nonCanonical(payload);
    // Same bytes once decoded: only the canonical-text rule rejects it.
    expect(altered).not.toBe(payload);
    expect(Buffer.from(altered, 'base64').equals(Buffer.from(payload, 'base64'))).toBe(true);
    const bad = [
      payload.slice(0, 43), // 43 chars, padding dropped
      payload.slice(0, 42) + '==', // 44 chars, wrong padding
      altered, // non-canonical trailing bits
      payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, 'A') + '=', // URL-safe alphabet, 45 chars
      randomBytes(31).toString('base64'), // 31 bytes
      randomBytes(33).toString('base64'), // 33 bytes
      randomBytes(64).toString('base64'), // 64 bytes
      randomBytes(32).toString('hex'), // hex, not base64
    ];
    for (const value of bad) {
      expect(verify(withSignature(d, `v1,${value}`)), value).toStrictEqual(fail('malformed_signature'));
      // One malformed v1 entry poisons the header even next to the right one.
      expect(verify(withSignature(d, `${d.signature} v1,${value}`)), value).toStrictEqual(
        fail('malformed_signature'),
      );
    }
    // A URL-safe spelling of the right MAC (when it has a + or /) is also refused.
    const urlSafe = payload.replace(/\+/g, '-').replace(/\//g, '_');
    if (urlSafe !== payload) {
      expect(verify(withSignature(d, `v1,${urlSafe}`))).toStrictEqual(fail('malformed_signature'));
    }
  });

  it.each([
    ['an empty header', (_right: string) => ''],
    ['a double space (empty entry)', (right: string) => `v2,x  ${right}`],
    ['a leading space', (right: string) => ` ${right}`],
    ['a trailing space', (right: string) => `${right} `],
    ['a tab separator', (right: string) => `v2,x\t${right}`],
    ['a missing comma', (right: string) => `v1${payloadOf(right)}`],
    ['an empty version', (right: string) => `,${payloadOf(right)}`],
    ['an empty payload', (right: string) => `v2, ${right}`],
    ['a 17-character version', (right: string) => `${'v'.repeat(17)},x ${right}`],
    ['a non-ASCII payload in another version', (right: string) => `v2,\u00e9 ${right}`],
    ['an upper-case V1', (right: string) => `V1,${payloadOf(right)}`],
  ])('rejects %s', (_label, build) => {
    const d = delivery();
    // (`V1` is not `v1`: it is ignored, which leaves no v1 entry.)
    expect(verify(withSignature(d, build(d.signature)))).toStrictEqual(fail('malformed_signature'));
  });

  it(`allows ${RECALL_WEBHOOK_MAX_SIGNATURE_ENTRIES} entries and rejects 11`, () => {
    expect(RECALL_WEBHOOK_MAX_SIGNATURE_ENTRIES).toBe(10);
    const filler = (count: number) => Array.from({ length: count }, (_, index) => `v2,filler${index}`);
    expect(verify(delivery({ extraSignatures: filler(9) }))).toStrictEqual(ok());
    expect(verify(delivery({ extraSignatures: filler(10) }))).toStrictEqual(fail('malformed_signature'));
  });

  it(`allows a ${RECALL_WEBHOOK_MAX_SIGNATURE_HEADER_LENGTH}-character header and rejects 2049`, () => {
    expect(RECALL_WEBHOOK_MAX_SIGNATURE_HEADER_LENGTH).toBe(2048);
    const d = delivery();
    const padTo = (total: number) => {
      const lead = 'v2,' + 'A'.repeat(total - d.signature.length - 1 - 'v2,'.length);
      return `${lead} ${d.signature}`;
    };
    expect(padTo(2048)).toHaveLength(2048);
    expect(padTo(2049)).toHaveLength(2049);
    expect(verify(withSignature(d, padTo(2048)))).toStrictEqual(ok());
    expect(verify(withSignature(d, padTo(2049)))).toStrictEqual(fail('malformed_signature'));
  });

  it('rejects a repeated (array-valued) signature header', () => {
    const d = delivery();
    expect(verify(withSignature(d, [d.signature, d.signature]))).toStrictEqual(fail('malformed_signature'));
    expect(verify(withSignature(d, [d.signature]))).toStrictEqual(fail('malformed_signature'));
  });
});

// ── Body bounds ─────────────────────────────────────────────────────────────

describe('verifyRecallWebhook — body', () => {
  it('rejects an empty or non-Buffer body', () => {
    const d = delivery();
    expect(verify({ ...d, body: Buffer.alloc(0) })).toStrictEqual(fail('empty_body'));
    for (const body of [undefined, null, EVENT_BODY, new Uint8Array(d.body), [1, 2, 3]]) {
      expect(
        verifyRecallWebhook(body as unknown as Buffer, d.headers, d.secret, { now: () => NOW_MS }),
        String(body),
      ).toStrictEqual(fail('empty_body'));
    }
  });

  it('honours a smaller byte bound', () => {
    const ten = delivery({ body: '0123456789' });
    expect(verify(ten, { maxBytes: 10 })).toStrictEqual(ok());
    const eleven = delivery({ body: '0123456789A' });
    expect(verify(eleven, { maxBytes: 10 })).toStrictEqual(fail('body_too_large'));
  });

  it(`defaults to ${RECALL_WEBHOOK_DEFAULT_MAX_BYTES} bytes, also for an unusable option`, () => {
    expect(RECALL_WEBHOOK_DEFAULT_MAX_BYTES).toBe(256 * 1024);
    const atBound = delivery({ body: Buffer.alloc(RECALL_WEBHOOK_DEFAULT_MAX_BYTES, 0x61) });
    expect(verify(atBound)).toStrictEqual(ok());
    const over = delivery({ body: Buffer.alloc(RECALL_WEBHOOK_DEFAULT_MAX_BYTES + 1, 0x61) });
    expect(verify(over)).toStrictEqual(fail('body_too_large'));
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(verify(over, { maxBytes }), String(maxBytes)).toStrictEqual(fail('body_too_large'));
      expect(verify(delivery({ body: '0123456789A' }), { maxBytes }), String(maxBytes)).toStrictEqual(ok());
    }
  });

  it('caps a larger option at the 1 MiB hard maximum', () => {
    const atCap = delivery({ body: Buffer.alloc(ONE_MIB, 0x61) });
    expect(verify(atCap, { maxBytes: 5 * ONE_MIB })).toStrictEqual(ok());
    const overCap = delivery({ body: Buffer.alloc(ONE_MIB + 1, 0x61) });
    expect(verify(overCap, { maxBytes: 5 * ONE_MIB })).toStrictEqual(fail('body_too_large'));
  });
});

// ── Secret ──────────────────────────────────────────────────────────────────

describe('verifyRecallWebhook — unusable secret fails closed', () => {
  it.each([16, 24, 32, 64])('accepts a %i-byte secret', (bytes) => {
    expect(verify(delivery({ secret: makeRecallWebhookSecret(bytes) }))).toStrictEqual(ok());
  });

  it('rejects a secret without the prefix, with bad base64, or of the wrong size', () => {
    const d = delivery();
    const encoded = d.secret.slice(PREFIX.length);
    const unusable: unknown[] = [
      encoded, // no prefix
      'WHSEC' + '_' + encoded, // upper-case prefix
      'whsec' + encoded, // prefix without the underscore
      PREFIX, // prefix only
      '',
      PREFIX + encoded.slice(0, 10) + '*' + encoded.slice(11), // not base64
      PREFIX + randomBytes(32).toString('base64url') + '-_', // URL-safe alphabet
      PREFIX + encoded + '\n', // stray newline
      ` ${d.secret}`, // stray space
      makeRecallWebhookSecret(8), // < 16 bytes
      makeRecallWebhookSecret(15), // < 16 bytes
      makeRecallWebhookSecret(65), // > 64 bytes
      makeRecallWebhookSecret(96), // > 64 bytes
      undefined,
      null,
      42,
      Buffer.from(d.secret),
    ];
    for (const value of unusable) {
      expect(
        verifyRecallWebhook(d.body, d.headers, value as string, { now: () => NOW_MS }),
        typeof value === 'string' ? `len ${value.length}` : String(typeof value),
      ).toStrictEqual(fail('not_configured'));
    }
  });

  it('checks the secret first, then the body, then the headers', () => {
    const d = delivery();
    expect(verifyRecallWebhook(Buffer.alloc(0), {}, '', { now: () => NOW_MS })).toStrictEqual(fail('not_configured'));
    expect(verifyRecallWebhook(Buffer.alloc(0), {}, d.secret, { now: () => NOW_MS })).toStrictEqual(fail('empty_body'));
    expect(verify({ ...d, headers: {} }, { maxBytes: 1 })).toStrictEqual(fail('body_too_large'));
    expect(verify({ ...d, headers: { 'webhook-id': 'bad id' } })).toStrictEqual(fail('missing_headers'));
    // id before timestamp, timestamp format before window, window before signature parse.
    expect(
      verify(withSignature({ ...d, headers: { ...d.headers, 'webhook-id': 'bad id', 'webhook-timestamp': 'x' } }, '')),
    ).toStrictEqual(fail('malformed_id'));
    expect(verify(withSignature({ ...d, headers: { ...d.headers, 'webhook-timestamp': 'x' } }, ''))).toStrictEqual(
      fail('malformed_timestamp'),
    );
    expect(
      verify(withSignature({ ...d, headers: { ...d.headers, 'webhook-timestamp': String(NOW_SEC - 3600) } }, '')),
    ).toStrictEqual(fail('timestamp_out_of_tolerance'));
  });
});

// ── Secrecy ─────────────────────────────────────────────────────────────────

describe('verifyRecallWebhook — results carry no secret, body or signature', () => {
  it('every result is a closed, sanitized object', () => {
    const d = delivery();
    const encoded = d.secret.slice(PREFIX.length);
    const signaturePayload = payloadOf(d.signature);
    const wrong = delivery();
    const results: RecallWebhookVerifyResult[] = [
      verify(d),
      verify({ ...d, secret: makeRecallWebhookSecret(8) }),
      verify({ ...d, body: Buffer.alloc(0) }),
      verify(d, { maxBytes: 10 }),
      verify({ ...d, headers: {} }),
      verify({ ...d, headers: { ...d.headers, 'webhook-id': 'bad id' } }),
      verify({ ...d, headers: { ...d.headers, 'webhook-timestamp': 'x' } }),
      verify(d, { now: () => NOW_MS + 3_600_000 }),
      verify(withSignature(d, `${d.signature}  `)),
      verify({ ...d, secret: wrong.secret }),
    ];
    const seen = new Set<string>();
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(encoded);
      expect(text).not.toContain(d.secret);
      expect(text).not.toContain(signaturePayload);
      expect(text).not.toContain('v1,');
      expect(text).not.toContain('participant_events');
      expect(text).not.toContain(wrong.secret.slice(PREFIX.length));
      if (result.ok) {
        expect(Object.keys(result)).toEqual(['ok', 'webhookId', 'timestampSec']);
      } else {
        expect(Object.keys(result)).toEqual(['ok', 'reason']);
        expect(REASONS).toContain(result.reason);
        seen.add(result.reason);
      }
    }
    expect([...seen].sort()).toEqual([...REASONS].sort());
  });
});
