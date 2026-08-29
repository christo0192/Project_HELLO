/**
 * plivo-phone/verify.ts — the ONLY trust boundary of the Plivo answer-first
 * ("bounce") webhooks.
 *
 * ── THIS IS THE PLIVO V3 ALGORITHM, NOT ASHBY AND NOT LIVEKIT ──────────
 * Three vendors, three signature schemes, and they MUST NOT be conflated:
 *
 *   * Ashby signs `HMAC-SHA256(secret, rawBody)` as `sha256=<hex>`.
 *   * LiveKit signs a JWT whose claim is the base64 body digest.
 *   * Plivo V3 signs a STRING BUILT FROM THE REQUEST — the full request URL,
 *     then the POST parameters sorted alphabetically (Unix, case-sensitive) as
 *     `name+value` concatenated with NO separators, then `.` then a per-request
 *     NONCE — with `HMAC-SHA256(authToken)`, base64-encoded. The signature
 *     rides `X-Plivo-Signature-V3` and the nonce rides `X-Plivo-Signature-V3-Nonce`.
 *     An account with multiple active auth tokens sends a comma-separated list;
 *     a match against ANY member passes.
 *
 * This is a faithful reimplementation of plivo-node's `validateV3Signature`
 * (lib/utils/v3Security.js): `construct_post_url` = URL (no query on our
 * callbacks) + sorted `key+value` string; `get_signature_v3` = HMAC over
 * `base_url + '.' + nonce`, base64. We reimplement rather than depend on the
 * SDK because the whole SDK is a large surface to pull into `app.ts`'s import
 * graph for one HMAC, and the algorithm is small and pinnable by test.
 *
 * ── THE URL MUST BE THE ONE PLIVO SIGNED ──────────────────────────────
 * Plivo signs the URL IT CALLED — scheme, host, port and path exactly as
 * configured in the Plivo application. Behind a proxy, `req.protocol`/`req.host`
 * may not reconstruct that. So the caller passes the EXACT signed URL from
 * configuration (`PLIVO_ANSWER_URL` / `PLIVO_DIAL_STATUS_URL` / `PLIVO_HANGUP_URL`),
 * never a value derived from the inbound request headers, which are attacker-
 * controlled. This module takes the URL as an argument and does not guess it.
 *
 * SECURITY: the auth token, the params (which carry phone numbers), the raw
 * body and the signatures are NEVER logged, returned, stored or embedded in an
 * error. Failures collapse to a closed, sanitized vocabulary. The final
 * comparison is constant-time on equal-length base64 buffers.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the base64 signature (or comma-separated signatures). */
export const PLIVO_SIGNATURE_HEADER = 'x-plivo-signature-v3';
/** Header carrying the per-request nonce. */
export const PLIVO_NONCE_HEADER = 'x-plivo-signature-v3-nonce';

/** Stable, sanitized rejection reasons — safe to log/return (no secret data). */
export type PlivoVerifyReason =
  | 'not_configured' // no usable auth token provisioned (fail closed)
  | 'missing_nonce' // no X-Plivo-Signature-V3-Nonce header
  | 'missing_signature' // no X-Plivo-Signature-V3 header
  | 'mismatch'; // computed signature matched no provided signature

export type PlivoVerifyResult = { ok: true } | { ok: false; reason: PlivoVerifyReason };

/**
 * The V3 signed string for a POST: the signed URL, then the sorted POST
 * parameters as `key+value` concatenated with no separators (each key sorted,
 * and each key's multiple values sorted), then `.` then the nonce.
 *
 * Exported so a test can assert the exact byte string the algorithm hashes,
 * which is the thing most likely to drift from Plivo's own implementation.
 */
export function plivoV3SignedString(
  signedUrl: string,
  params: Record<string, string | readonly string[]>,
  nonce: string,
): string {
  const keys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const raw = params[key];
    const values = Array.isArray(raw) ? [...raw].sort() : [String(raw)];
    for (const value of values) {
      parts.push(`${key}${value}`);
    }
  }
  // Plivo's `construct_post_url` runs the URL through `construct_get_url` with
  // `empty_post_params = isEmpty(params)`, and for NON-EMPTY POST params that
  // branch appends a bare `?` before the sorted `key+value` string — so the
  // signed base is `URL?<sortedParams>.<nonce>`, NOT `URL<sortedParams>...`.
  // The first reimplementation omitted the `?`, so EVERY live webhook
  // signature mismatched and every bounce call fail-closed to <Hangup/>
  // (2026-08-29). Verified byte-for-byte against plivo-node's own
  // validateV3Signature. Empty params → no `?` (matches the empty branch).
  const query = keys.length > 0 ? '?' : '';
  return `${signedUrl}${query}${parts.join('')}.${nonce}`;
}

/**
 * Compute the base64 V3 signature. Kept tiny and pure so the test can drive it
 * against a known Plivo-produced signature.
 */
export function plivoV3Signature(
  authToken: string,
  signedUrl: string,
  params: Record<string, string | readonly string[]>,
  nonce: string,
): string {
  return createHmac('sha256', authToken)
    .update(plivoV3SignedString(signedUrl, params, nonce), 'utf8')
    .digest('base64');
}

export interface PlivoVerifyInput {
  /** The EXACT URL Plivo signed — from config, never from request headers. */
  readonly signedUrl: string;
  /** The POST params exactly as received (they carry phone numbers). */
  readonly params: Record<string, string | readonly string[]>;
  /** `X-Plivo-Signature-V3`, possibly a comma-separated list. */
  readonly signatureHeader: string | undefined | null;
  /** `X-Plivo-Signature-V3-Nonce`. */
  readonly nonceHeader: string | undefined | null;
}

/**
 * Verify an inbound Plivo V3 signature.
 *
 * Fail-closed ordering: not-configured → missing nonce → missing signature →
 * constant-time compare against every comma-separated candidate. A single
 * match passes; the compare is timing-safe on equal-length base64 buffers, and
 * a length mismatch is a `mismatch`, never a length oracle.
 */
export function verifyPlivoSignature(
  authToken: string,
  input: PlivoVerifyInput,
): PlivoVerifyResult {
  if (typeof authToken !== 'string' || authToken.length === 0) {
    return { ok: false, reason: 'not_configured' };
  }
  if (typeof input.nonceHeader !== 'string' || input.nonceHeader.length === 0) {
    return { ok: false, reason: 'missing_nonce' };
  }
  if (typeof input.signatureHeader !== 'string' || input.signatureHeader.length === 0) {
    return { ok: false, reason: 'missing_signature' };
  }

  const expected = plivoV3Signature(authToken, input.signedUrl, input.params, input.nonceHeader);
  const expectedBuf = Buffer.from(expected, 'utf8');

  // Plivo may send several signatures (one per active auth token). A match
  // against ANY member is a pass. Each candidate is compared constant-time;
  // an unequal length short-circuits to non-match WITHOUT calling
  // timingSafeEqual (which would throw), and never as a distinguishable oracle
  // because the candidate is attacker-supplied, not the secret.
  for (const candidate of input.signatureHeader.split(',')) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const candidateBuf = Buffer.from(trimmed, 'utf8');
    if (candidateBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'mismatch' };
}
