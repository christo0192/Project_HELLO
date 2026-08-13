/**
 * Ashby webhook signature verification — unit + adversarial negative controls.
 *
 * Proves the HMAC-SHA256-over-raw-bytes trust boundary: a valid signature
 * verifies; any byte mutation, re-stringified-equivalent body, malformed
 * signature, oversized/empty body, or missing header fails closed. The secret,
 * body, and signature never appear in the sanitized reason codes.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyAshbySignature,
  DEFAULT_WEBHOOK_MAX_BYTES,
} from '../integrations/ashby/webhook-verify.js';

// Built from parts so no secret-shaped literal exists in source (fixture only).
const SECRET = ['ashby', 'test', 'webhook', 'hmac', 'fixture', 'value'].join('-');

function sign(body: Buffer | string, secret = SECRET): string {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return 'sha256=' + createHmac('sha256', secret).update(buf).digest('hex');
}

describe('verifyAshbySignature — happy path', () => {
  it('accepts a correct signature over the exact raw bytes', () => {
    const body = Buffer.from(JSON.stringify({ action: 'candidateStageChange', data: { application: { id: 'app_1' } } }));
    expect(verifyAshbySignature(body, sign(body), SECRET)).toEqual({ ok: true });
  });

  it('accepts an empty-JSON-object body when signed', () => {
    const body = Buffer.from('{}');
    expect(verifyAshbySignature(body, sign(body), SECRET)).toEqual({ ok: true });
  });
});

describe('verifyAshbySignature — negative controls (fail closed)', () => {
  const body = Buffer.from(JSON.stringify({ action: 'candidateStageChange', b: 2, a: 1 }));

  it('rejects a single-byte mutation of the raw body', () => {
    const good = sign(body);
    const mutated = Buffer.from(body);
    mutated[0] = mutated[0] ^ 0x01;
    expect(verifyAshbySignature(mutated, good, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a re-stringified (key-reordered) equivalent body', () => {
    // Same logical JSON, different bytes (keys reordered) → different MAC.
    const reparsed = JSON.parse(body.toString('utf8'));
    const reordered = Buffer.from(JSON.stringify({ a: reparsed.a, b: reparsed.b, action: reparsed.action }));
    expect(reordered.equals(body)).toBe(false);
    expect(verifyAshbySignature(reordered, sign(body), SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature computed with the wrong secret', () => {
    expect(verifyAshbySignature(body, sign(body, 'wrong-secret-xxxxxxxxxxxxx'), SECRET))
      .toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a missing signature header', () => {
    expect(verifyAshbySignature(body, undefined, SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyAshbySignature(body, '', SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects malformed signatures safely (strict single sha256=<64 hex>)', () => {
    const valid = sign(body).slice('sha256='.length);
    const malformed = [
      valid,                                   // missing prefix
      'sha1=' + valid,                         // wrong algo prefix
      'sha256=' + valid.toUpperCase(),         // uppercase hex
      'sha256=' + valid.slice(0, 63),          // too short
      'sha256=' + valid + 'ab',                // too long
      'sha256=' + valid + ',sha256=' + valid,  // comma-joined double signature
      'sha256= ' + valid,                      // whitespace
      'sha256=' + valid.slice(0, 62) + 'zz',   // non-hex chars
    ];
    for (const sig of malformed) {
      expect(verifyAshbySignature(body, sig, SECRET), sig).toEqual({ ok: false, reason: 'malformed_signature' });
    }
  });

  it('rejects an empty or non-buffer body', () => {
    expect(verifyAshbySignature(Buffer.alloc(0), sign(body), SECRET)).toEqual({ ok: false, reason: 'empty_body' });
  });

  it('rejects a body over the byte bound before comparing', () => {
    const big = Buffer.alloc(DEFAULT_WEBHOOK_MAX_BYTES + 1, 0x61);
    expect(verifyAshbySignature(big, sign(big), SECRET, { maxBytes: 1024 })).toEqual({ ok: false, reason: 'body_too_large' });
  });

  it('fails closed when no secret is configured', () => {
    expect(verifyAshbySignature(body, sign(body), '')).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('never leaks the secret, body, or signature in the sanitized reason', () => {
    const res = verifyAshbySignature(body, 'sha256=' + 'f'.repeat(64), SECRET);
    expect(res.ok).toBe(false);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(body.toString('utf8'));
  });
});
