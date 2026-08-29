/**
 * Plivo V3 signature verification — the ONLY trust boundary of the bounce
 * webhooks. The signed-string construction is pinned against an independently
 * computed reference (the plivo-node algorithm) so a drift from Plivo's own
 * implementation goes red here.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyPlivoSignature,
  plivoV3SignedString,
  plivoV3Signature,
} from '../integrations/plivo-phone/verify.js';

const TOKEN = 'authtoken1234567890';
const URL = 'https://api.example.com/api/integrations/plivo/answer';
const NONCE = 'nonce123';
const PARAMS = {
  To: '+919812345678',
  From: '+919800000000',
  'X-PH-Hello-Attempt': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

/**
 * The plivo-node algorithm, reimplemented independently for the pin — and it
 * must mirror `construct_post_url`'s `?` before the sorted params for
 * non-empty POSTs (v3Security.js). The first version of this reference
 * omitted the `?` in lockstep with the code it was checking, so both were
 * wrong together and every live signature mismatched (2026-08-29). Verified
 * byte-for-byte against plivo-node's own validateV3Signature.
 */
function referenceSignature(
  token: string,
  url: string,
  params: Record<string, string>,
  nonce: string,
): string {
  const keys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(`${k}${params[k]}`);
  const query = keys.length > 0 ? '?' : '';
  const base = `${url}${query}${parts.join('')}.${nonce}`;
  return createHmac('sha256', token).update(base).digest('base64');
}

describe('plivo V3 — the signed string is exactly Plivo\'s', () => {
  it('builds URL + ? + sorted key+value pairs + . + nonce, no separators', () => {
    const s = plivoV3SignedString(URL, PARAMS, NONCE);
    expect(s).toBe(
      `${URL}?From+919800000000To+919812345678X-PH-Hello-Attemptaaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.${NONCE}`,
    );
  });

  it('the computed base64 signature matches the reference algorithm', () => {
    expect(plivoV3Signature(TOKEN, URL, PARAMS, NONCE)).toBe(
      referenceSignature(TOKEN, URL, PARAMS, NONCE),
    );
  });

  it('sorts multiple values of one key (case-sensitive, Unix)', () => {
    const s = plivoV3SignedString(URL, { k: ['b', 'a'] }, NONCE);
    expect(s).toBe(`${URL}?kakb.${NONCE}`);
  });

  it('empty params add no ? (matches Plivo empty-POST branch)', () => {
    const s = plivoV3SignedString(URL, {}, NONCE);
    expect(s).toBe(`${URL}.${NONCE}`);
  });
});

describe('plivo V3 — verification accepts a valid signature', () => {
  it('passes on the exact computed signature and nonce', () => {
    const signature = plivoV3Signature(TOKEN, URL, PARAMS, NONCE);
    const res = verifyPlivoSignature(TOKEN, {
      signedUrl: URL,
      params: PARAMS,
      signatureHeader: signature,
      nonceHeader: NONCE,
    });
    expect(res.ok).toBe(true);
  });

  it('passes when the correct signature is ONE OF a comma-separated list', () => {
    const good = plivoV3Signature(TOKEN, URL, PARAMS, NONCE);
    const res = verifyPlivoSignature(TOKEN, {
      signedUrl: URL,
      params: PARAMS,
      signatureHeader: `AAAAsomeotherbase64signaturevalueAAAA=,${good}`,
      nonceHeader: NONCE,
    });
    expect(res.ok).toBe(true);
  });
});

describe('plivo V3 — verification fails closed', () => {
  const good = plivoV3Signature(TOKEN, URL, PARAMS, NONCE);

  it('rejects a wrong signature as mismatch', () => {
    const res = verifyPlivoSignature(TOKEN, {
      signedUrl: URL,
      params: PARAMS,
      signatureHeader: 'AAAAwrongbase64AAAA=',
      nonceHeader: NONCE,
    });
    expect(res).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature computed over a DIFFERENT url', () => {
    const res = verifyPlivoSignature(TOKEN, {
      signedUrl: 'https://evil.example.com/answer',
      params: PARAMS,
      signatureHeader: good,
      nonceHeader: NONCE,
    });
    expect(res).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a signature computed with a DIFFERENT nonce (replay defence)', () => {
    const res = verifyPlivoSignature(TOKEN, {
      signedUrl: URL,
      params: PARAMS,
      signatureHeader: good,
      nonceHeader: 'a-different-nonce',
    });
    expect(res).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a missing nonce header', () => {
    expect(
      verifyPlivoSignature(TOKEN, {
        signedUrl: URL,
        params: PARAMS,
        signatureHeader: good,
        nonceHeader: undefined,
      }),
    ).toEqual({ ok: false, reason: 'missing_nonce' });
  });

  it('rejects a missing signature header', () => {
    expect(
      verifyPlivoSignature(TOKEN, {
        signedUrl: URL,
        params: PARAMS,
        signatureHeader: undefined,
        nonceHeader: NONCE,
      }),
    ).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects an empty auth token as not_configured', () => {
    expect(
      verifyPlivoSignature('', {
        signedUrl: URL,
        params: PARAMS,
        signatureHeader: good,
        nonceHeader: NONCE,
      }),
    ).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('a length-mismatched candidate does not throw (no timingSafeEqual oracle)', () => {
    const res = verifyPlivoSignature(TOKEN, {
      signedUrl: URL,
      params: PARAMS,
      signatureHeader: 'short',
      nonceHeader: NONCE,
    });
    expect(res).toEqual({ ok: false, reason: 'mismatch' });
  });
});
