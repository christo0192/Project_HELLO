/**
 * Recall settings validators: the base URL (one label + `.recall.ai`, origin only), the workspace
 * webhook-secret decoder, and the key / bot id / idempotency-key shapes.
 *
 * Webhook secrets are ALWAYS built at run time from random bytes: no `whsec_`-prefixed base64 ever
 * appears as a literal in this file (gitleaks scans the full PR history).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECALL_BOT_ID_RE,
  RECALL_DEFAULT_BASE_URL,
  RECALL_IDEMPOTENCY_KEY_RE,
  RECALL_SCHEDULED_BOT_MIN_LEAD_MS,
  RECALL_WEBHOOK_SECRET_PREFIX,
  decodeRecallWebhookSecret,
  isRecallApiKeyShaped,
  isRecallBotId,
  normalizeRecallBaseUrl,
} from '../integrations/recall/settings.js';

const PREFIX = 'whsec' + '_';
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A runtime-built workspace secret over `bytes` random bytes, plus the bytes themselves. */
function makeSecret(bytes: number): { value: string; raw: Buffer } {
  const raw = randomBytes(bytes);
  return { value: PREFIX + raw.toString('base64'), raw };
}

/** Flip the lowest bit of the last base64 character: decodes to the same bytes, but non-canonical. */
function nonCanonical(body: string): string {
  const unpadded = body.replace(/=+$/, '');
  const padding = body.slice(unpadded.length);
  const last = unpadded[unpadded.length - 1];
  const flipped = B64_ALPHABET[B64_ALPHABET.indexOf(last) ^ 1];
  return unpadded.slice(0, -1) + flipped + padding;
}

describe('Recall constants', () => {
  it('defaults to the Tokyo region and pins the scheduled-bot lead', () => {
    expect(RECALL_DEFAULT_BASE_URL).toBe('https://ap-northeast-1.recall.ai');
    expect(RECALL_SCHEDULED_BOT_MIN_LEAD_MS).toBe(600_000);
    expect(RECALL_WEBHOOK_SECRET_PREFIX).toBe(PREFIX);
  });
});

describe('normalizeRecallBaseUrl', () => {
  it.each([
    ['the default', RECALL_DEFAULT_BASE_URL, RECALL_DEFAULT_BASE_URL],
    ['a trailing slash (removed)', 'https://us-east-1.recall.ai/', 'https://us-east-1.recall.ai'],
    ['the api alias', 'https://api.recall.ai', 'https://api.recall.ai'],
    ['eu-central-1', 'https://eu-central-1.recall.ai', 'https://eu-central-1.recall.ai'],
  ])('accepts %s', (_name, raw, expected) => {
    expect(normalizeRecallBaseUrl(raw)).toBe(expected);
  });

  it.each([
    ['http', 'http://ap-northeast-1.recall.ai'],
    ['the bare apex', 'https://recall.ai'],
    ['two labels', 'https://a.b.recall.ai'],
    ['a look-alike apex', 'https://evil-recall.ai'],
    ['a look-alike suffix', 'https://ap-northeast-1.recall.ai.evil.test'],
    ['another host', 'https://evil.test'],
    ['an explicit default port', 'https://ap-northeast-1.recall.ai:443'],
    ['another port', 'https://ap-northeast-1.recall.ai:8443'],
    ['a path', 'https://ap-northeast-1.recall.ai/api/v1'],
    ['a path with trailing slash', 'https://ap-northeast-1.recall.ai/api/'],
    ['two trailing slashes', 'https://ap-northeast-1.recall.ai//'],
    ['a query', 'https://ap-northeast-1.recall.ai?x=1'],
    ['a bare query mark', 'https://ap-northeast-1.recall.ai?'],
    ['a fragment', 'https://ap-northeast-1.recall.ai#x'],
    ['userinfo', 'https://user:pw@ap-northeast-1.recall.ai'],
    ['userinfo without password', 'https://user@ap-northeast-1.recall.ai'],
    ['upper case', 'https://AP-NORTHEAST-1.recall.ai'],
    ['leading whitespace', ' https://ap-northeast-1.recall.ai'],
    ['trailing whitespace', 'https://ap-northeast-1.recall.ai '],
    ['a label over 63 chars', `https://${'a'.repeat(64)}.recall.ai`],
    ['an underscore label', 'https://ap_northeast.recall.ai'],
    ['no scheme', 'ap-northeast-1.recall.ai'],
    ['blank (the config reader defaults blank, not this)', ''],
  ])('rejects %s', (_name, raw) => {
    expect(normalizeRecallBaseUrl(raw)).toBeNull();
  });

  it('accepts a 63-char label', () => {
    const host = `https://${'a'.repeat(63)}.recall.ai`;
    expect(normalizeRecallBaseUrl(host)).toBe(host);
  });

  it('rejects non-strings without throwing', () => {
    for (const raw of [null, undefined, 1, {}, [RECALL_DEFAULT_BASE_URL], new URL(RECALL_DEFAULT_BASE_URL)]) {
      expect(normalizeRecallBaseUrl(raw)).toBeNull();
    }
  });
});

describe('decodeRecallWebhookSecret', () => {
  it.each([24, 32])('decodes a %i-byte runtime secret', (bytes) => {
    const { value, raw } = makeSecret(bytes);
    const decoded = decodeRecallWebhookSecret(value);
    expect(decoded).toBeInstanceOf(Buffer);
    expect(decoded).toHaveLength(bytes);
    expect(decoded!.equals(raw)).toBe(true);
  });

  it('accepts the 16- and 64-byte bounds', () => {
    expect(decodeRecallWebhookSecret(makeSecret(16).value)).toHaveLength(16);
    expect(decodeRecallWebhookSecret(makeSecret(64).value)).toHaveLength(64);
  });

  it('accepts the unpadded spelling of a padded secret', () => {
    const { value, raw } = makeSecret(32);
    expect(value.endsWith('=')).toBe(true);
    expect(decodeRecallWebhookSecret(value.replace(/=+$/, ''))!.equals(raw)).toBe(true);
  });

  it('returns a fresh buffer each call', () => {
    const { value } = makeSecret(32);
    const first = decodeRecallWebhookSecret(value)!;
    first.fill(0);
    expect(decodeRecallWebhookSecret(value)!.equals(first)).toBe(false);
  });

  it('rejects a secret without the prefix', () => {
    const { value } = makeSecret(32);
    expect(decodeRecallWebhookSecret(value.slice(PREFIX.length))).toBeNull();
    expect(decodeRecallWebhookSecret('WHSEC' + '_' + value.slice(PREFIX.length))).toBeNull();
    expect(decodeRecallWebhookSecret('whsec' + value.slice(PREFIX.length))).toBeNull();
    expect(decodeRecallWebhookSecret(PREFIX)).toBeNull();
  });

  it('rejects characters outside standard base64', () => {
    const body = randomBytes(32).toString('base64');
    expect(decodeRecallWebhookSecret(PREFIX + randomBytes(32).toString('base64url') + '-_')).toBeNull();
    expect(decodeRecallWebhookSecret(PREFIX + body.slice(0, 10) + ' ' + body.slice(10))).toBeNull();
    expect(decodeRecallWebhookSecret(PREFIX + body.slice(0, 10) + '.' + body.slice(10))).toBeNull();
    expect(decodeRecallWebhookSecret(`${PREFIX}${body}\n`)).toBeNull();
  });

  it('rejects too short and too long secrets', () => {
    expect(decodeRecallWebhookSecret(makeSecret(8).value)).toBeNull();
    expect(decodeRecallWebhookSecret(makeSecret(15).value)).toBeNull();
    expect(decodeRecallWebhookSecret(makeSecret(65).value)).toBeNull();
    expect(decodeRecallWebhookSecret(makeSecret(100).value)).toBeNull();
  });

  it('rejects non-canonical base64 (same bytes, different text)', () => {
    for (const bytes of [16, 32]) {
      const { value } = makeSecret(bytes);
      const body = value.slice(PREFIX.length);
      expect(decodeRecallWebhookSecret(PREFIX + nonCanonical(body))).toBeNull();
    }
  });

  it('rejects wrong padding', () => {
    const { value } = makeSecret(32); // 44 chars, one `=`
    expect(decodeRecallWebhookSecret(`${value}=`)).toBeNull();
    const unpaddedWhole = makeSecret(24).value; // 32 chars, no padding needed
    expect(decodeRecallWebhookSecret(`${unpaddedWhole}=`)).toBeNull();
    expect(decodeRecallWebhookSecret(`${unpaddedWhole}==`)).toBeNull();
  });

  it('rejects non-strings without throwing', () => {
    for (const raw of [null, undefined, 0, {}, [makeSecret(32).value], Buffer.alloc(32)]) {
      expect(decodeRecallWebhookSecret(raw)).toBeNull();
    }
  });
});

describe('isRecallApiKeyShaped', () => {
  it('accepts 16..256 printable ASCII characters', () => {
    expect(isRecallApiKeyShaped('recall-fake-' + 'k'.repeat(24))).toBe(true);
    expect(isRecallApiKeyShaped('k'.repeat(16))).toBe(true);
    expect(isRecallApiKeyShaped('k'.repeat(256))).toBe(true);
  });

  it.each([
    ['too short', 'k'.repeat(15)],
    ['too long', 'k'.repeat(257)],
    ['a space', 'recall-fake key-kkkkkkkk'],
    ['a trailing newline', 'recall-fake-' + 'k'.repeat(24) + '\n'],
    ['a tab', 'recall-fake-\t' + 'k'.repeat(24)],
    ['non-ASCII', 'recall-fake-' + 'é'.repeat(24)],
    ['the env placeholder', 'replace_me'],
    ['empty', ''],
  ])('rejects %s', (_name, raw) => {
    expect(isRecallApiKeyShaped(raw)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const raw of [null, undefined, 1234567890123456, {}, ['k'.repeat(24)]]) {
      expect(isRecallApiKeyShaped(raw)).toBe(false);
    }
  });
});

describe('isRecallBotId', () => {
  it('accepts a lowercase UUID', () => {
    expect(isRecallBotId('0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e')).toBe(true);
    expect(RECALL_BOT_ID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it.each([
    ['upper case', '0F1E2D3C-4B5A-4968-8778-695A4B3C2D1E'],
    ['no hyphens', '0f1e2d3c4b5a49688778695a4b3c2d1e'],
    ['braces', '{0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e}'],
    ['a path suffix', '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e/leave_call'],
    ['a traversal', '../0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'],
    ['too short', '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1'],
    ['non-hex', '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1g'],
    ['empty', ''],
  ])('rejects %s', (_name, raw) => {
    expect(isRecallBotId(raw)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const raw of [null, undefined, 1, {}, ['0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e']]) {
      expect(isRecallBotId(raw)).toBe(false);
    }
  });
});

describe('RECALL_IDEMPOTENCY_KEY_RE', () => {
  it('accepts the R1 create-bot key shape and the length bounds', () => {
    expect(RECALL_IDEMPOTENCY_KEY_RE.test('r1-meet-bot-0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e-v1')).toBe(true);
    expect(RECALL_IDEMPOTENCY_KEY_RE.test('a'.repeat(8))).toBe(true);
    expect(RECALL_IDEMPOTENCY_KEY_RE.test('a'.repeat(128))).toBe(true);
    expect(RECALL_IDEMPOTENCY_KEY_RE.test('A_b.c:d-9')).toBe(true);
  });

  it.each([
    ['too short', 'a'.repeat(7)],
    ['too long', 'a'.repeat(129)],
    ['a space', 'r1-meet bot-1'],
    ['a slash', 'r1-meet/bot-1'],
    ['a newline', 'r1-meet-bot-1\n'],
    ['a plus', 'r1-meet+bot-1'],
  ])('rejects %s', (_name, raw) => {
    expect(RECALL_IDEMPOTENCY_KEY_RE.test(raw)).toBe(false);
  });
});
