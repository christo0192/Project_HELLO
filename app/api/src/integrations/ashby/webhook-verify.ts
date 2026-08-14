/**
 * ashby/webhook-verify.ts — inbound Ashby webhook signature verification.
 *
 * INBOUND BOUNDARY. Verifies the `Ashby-Signature: sha256=<hex>` header as an
 * HMAC-SHA256 over the EXACT raw request bytes, BEFORE any JSON parsing. This
 * is the only trust boundary for the webhook: a request whose signature does
 * not verify is rejected and never reaches receipt storage, the queue, or any
 * downstream reconciliation.
 *
 * Verified webhook facts (canonical Ashby webhook contract, to be re-pinned per
 * tenant before enabling — see docs/runbooks/ashby-webhook-reconciliation.md):
 *  - Ashby signs each webhook delivery with HMAC-SHA256 using a per-webhook
 *    shared secret configured in the Ashby webhook settings.
 *  - The signature is transported in the `Ashby-Signature` header as the ASCII
 *    string `sha256=` followed by the lowercase hex digest.
 *  - The MAC covers the raw, unmodified request body bytes. Re-serializing the
 *    parsed JSON (key reordering / whitespace) changes the bytes and MUST fail.
 *
 * SECURITY: the secret, the raw body, and the signature are NEVER logged,
 * returned, or embedded in errors. Comparison is constant-time on equal-length
 * hex digests. The format is strict and single — exactly one `sha256=<64 hex>`
 * token, no comma-separated lists, no uppercase, no whitespace — so a caller
 * cannot smuggle a second candidate signature or a length-oracle variant.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stable, sanitized rejection reasons — safe to log/return (no secret data). */
export type WebhookVerifyReason =
  | 'not_configured'      // no usable secret provisioned (fail closed)
  | 'empty_body'          // missing/zero-length raw body
  | 'body_too_large'      // raw body exceeded the byte bound
  | 'missing_signature'   // no Ashby-Signature header
  | 'malformed_signature' // not exactly `sha256=<64 lowercase hex>`
  | 'mismatch';           // well-formed but did not match the computed MAC

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: WebhookVerifyReason };

/** Fixed signature envelope. */
const SIG_PREFIX = 'sha256=';
/** A single lowercase 64-char hex SHA-256 digest — nothing else. */
const HEX64_RE = /^[a-f0-9]{64}$/;

/** Default and hard-max raw-body bounds (a webhook body is small metadata). */
export const DEFAULT_WEBHOOK_MAX_BYTES = 512 * 1024; // 512 KiB
const HARD_MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;      // 2 MiB absolute ceiling

export interface WebhookVerifyOptions {
  /** Raw-body byte bound (clamped to [1, 2 MiB]); defaults to 512 KiB. */
  maxBytes?: number;
}

function boundedMax(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
    return DEFAULT_WEBHOOK_MAX_BYTES;
  }
  return Math.min(v, HARD_MAX_WEBHOOK_BYTES);
}

/**
 * Verify an inbound Ashby webhook signature over the raw request bytes.
 *
 * Fail-closed ordering: not-configured → empty/oversized body → missing/
 * malformed signature → constant-time MAC comparison. The HMAC is only
 * computed once the signature is structurally a single `sha256=<64 hex>`
 * token, and the final comparison is timing-safe on equal-length buffers.
 */
export function verifyAshbySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
  options: WebhookVerifyOptions = {},
): WebhookVerifyResult {
  // Fail closed when no usable secret is provisioned.
  if (typeof secret !== 'string' || secret.length === 0) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return { ok: false, reason: 'empty_body' };
  }
  if (rawBody.length > boundedMax(options.maxBytes)) {
    return { ok: false, reason: 'body_too_large' };
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing_signature' };
  }
  // Strict single format: the header must be exactly `sha256=` + 64 lowercase
  // hex chars. Any prefix mismatch, extra token, comma, space, or casing
  // difference is a structural reject (never reaches the MAC compare).
  if (!signatureHeader.startsWith(SIG_PREFIX)) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const provided = signatureHeader.slice(SIG_PREFIX.length);
  if (!HEX64_RE.test(provided)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // provided and expected are both exactly 64 hex chars here, so the buffers
  // are equal-length and timingSafeEqual always runs (no length oracle).
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return { ok: false, reason: 'mismatch' };
  }
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
