/**
 * recall/webhook-verify.ts — inbound Recall.ai webhook signature verification (Svix / Standard
 * Webhooks scheme).
 *
 * INBOUND BOUNDARY, DARK. Nothing imports this module at runtime yet (S01 ships libraries only); the
 * Recall receivers (M034 S03) call it on the RAW request bytes BEFORE any JSON parse. A request
 * that does not verify never reaches storage, the queue or any state change. Reads NO environment:
 * the caller passes the workspace verification secret it got from `getR1MeetConfig()`.
 *
 * The scheme (docs: "Verifying webhooks, websockets and callback requests from Recall.ai"):
 *  - Headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (workspace verification secret)
 *    or, on accounts created before 2025-12-15, the legacy `svix-id`, `svix-timestamp`,
 *    `svix-signature` (same algorithm). The set is chosen by the presence of `webhook-id`: if it is
 *    there all three `webhook-*` headers must be and any `svix-*` header is ignored (a sender may
 *    send both sets); otherwise all three `svix-*` headers must be and no `webhook-timestamp` or
 *    `webhook-signature` may appear. An incomplete or mixed set = `missing_headers`. Headers are
 *    read by their lower-case names (Node and Express lower-case incoming header names).
 *  - The HMAC key is the base64-decoded text after the `whsec_` prefix (`decodeRecallWebhookSecret`:
 *    16..64 bytes, canonical base64).
 *  - The MAC is HMAC-SHA256 over the bytes of `<id>.<timestamp>.` followed by the RAW body bytes,
 *    base64-encoded. Re-serialising the parsed JSON changes the bytes and MUST fail.
 *  - `webhook-signature` is a space-separated list of `<version>,<signature>` entries (several
 *    during a secret rotation). Every `v1` entry must be the 44-character base64 of 32 bytes and
 *    ANY matching `v1` entry accepts; other versions (e.g. the asymmetric `v1a`) are ignored. A
 *    header with no well-formed `v1` entry, a malformed `v1` entry, an empty entry, more than 10
 *    entries or more than 2048 characters is `malformed_signature`.
 *  - Recall's sample checks no timestamp; we do (replay window): 300 s in BOTH directions by
 *    default, clamped to 1..600 s, against an injectable clock.
 *
 * Fail-closed order: secret → body empty/size → header set → id → timestamp format → tolerance →
 * signature parse → constant-time compare. Every reason is a fixed string, safe to log and return.
 * On success the id and timestamp come back for the receiver's replay de-duplication.
 *
 * SECURITY: the secret, the raw body and the signatures are NEVER logged, returned or embedded in a
 * result. Comparisons are `timingSafeEqual` on equal-length 32-byte digests.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeRecallWebhookSecret } from './settings.js';

/** Stable, sanitized rejection reasons: safe to log and return (no secret data). */
export type RecallWebhookVerifyReason =
  | 'not_configured' //             no usable `whsec_` secret (fail closed)
  | 'empty_body' //                 missing or zero-length raw body
  | 'body_too_large' //             raw body over the byte bound
  | 'missing_headers' //            the id/timestamp/signature set is incomplete or mixed
  | 'malformed_id' //               id not 1..128 of [A-Za-z0-9_.:-], or repeated
  | 'malformed_timestamp' //        timestamp not 1..12 digits, or repeated
  | 'timestamp_out_of_tolerance' // outside the replay window (stale or future)
  | 'malformed_signature' //        no well-formed v1 entry, or a malformed entry
  | 'mismatch'; //                  well-formed, but no v1 entry matched the computed MAC

export type RecallWebhookVerifyResult =
  | { readonly ok: true; readonly webhookId: string; readonly timestampSec: number }
  | { readonly ok: false; readonly reason: RecallWebhookVerifyReason };

export interface RecallWebhookVerifyOptions {
  /** Raw-body byte bound; default 256 KiB, hard max 1 MiB (a participant event is tiny). */
  maxBytes?: number;
  /** Replay window in seconds, both directions; default 300, clamped to 1..600. */
  toleranceSec?: number;
  /** Clock seam: epoch milliseconds. Default `Date.now`. */
  now?: () => number;
}

/** Header values as Node/Express present them: lower-case names, string or (repeated) string[]. */
export type RecallWebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

export const RECALL_WEBHOOK_DEFAULT_MAX_BYTES = 256 * 1024;
const RECALL_WEBHOOK_HARD_MAX_BYTES = 1024 * 1024;
export const RECALL_WEBHOOK_DEFAULT_TOLERANCE_SEC = 300;
const MIN_TOLERANCE_SEC = 1;
const MAX_TOLERANCE_SEC = 600;
export const RECALL_WEBHOOK_MAX_SIGNATURE_HEADER_LENGTH = 2048;
export const RECALL_WEBHOOK_MAX_SIGNATURE_ENTRIES = 10;

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;
/** `<version>,<payload>`: a short alphanumeric version, then printable ASCII (no space: we split on it). */
const ENTRY_RE = /^([A-Za-z0-9]{1,16}),([\x21-\x7e]+)$/;
/** Base64 of exactly 32 bytes: 43 characters and one `=`. Canonicality is re-checked after decoding. */
const V1_SIGNATURE_RE = /^[A-Za-z0-9+/]{43}=$/;
const SHA256_BYTES = 32;

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boundedMaxBytes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    return RECALL_WEBHOOK_DEFAULT_MAX_BYTES;
  }
  return Math.min(value, RECALL_WEBHOOK_HARD_MAX_BYTES);
}

/** Own-property read by exact (lower-case) name, so a prototype key never counts as a header. */
function header(headers: RecallWebhookHeaders, name: string): string | string[] | undefined {
  return Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : undefined;
}

interface HeaderSet {
  readonly id: string | string[];
  readonly timestamp: string | string[];
  readonly signature: string | string[];
}

/** The one complete header set, or null when it is incomplete or `svix-*` is mixed with `webhook-*`. */
function selectHeaderSet(headers: RecallWebhookHeaders): HeaderSet | null {
  const useStandard = header(headers, 'webhook-id') !== undefined;
  const prefix = useStandard ? 'webhook-' : 'svix-';
  const id = header(headers, `${prefix}id`);
  const timestamp = header(headers, `${prefix}timestamp`);
  const signature = header(headers, `${prefix}signature`);
  if (id === undefined || timestamp === undefined || signature === undefined) return null;
  if (!useStandard && (header(headers, 'webhook-timestamp') !== undefined || header(headers, 'webhook-signature') !== undefined)) {
    return null;
  }
  return { id, timestamp, signature };
}

/** A `v1` signature's 32 bytes when it is canonical base64 of exactly 32 bytes, else null. */
function decodeV1Signature(text: string): Buffer | null {
  if (!V1_SIGNATURE_RE.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== SHA256_BYTES || bytes.toString('base64') !== text) return null;
  return bytes;
}

/** Every `v1` signature in the header, or null when the header is malformed or has none. */
function parseSignatureHeader(value: string | string[]): Buffer[] | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > RECALL_WEBHOOK_MAX_SIGNATURE_HEADER_LENGTH) {
    return null;
  }
  const entries = value.split(' ');
  if (entries.length > RECALL_WEBHOOK_MAX_SIGNATURE_ENTRIES) return null;
  const candidates: Buffer[] = [];
  for (const entry of entries) {
    const match = ENTRY_RE.exec(entry);
    if (!match) return null;
    if (match[1] !== 'v1') continue;
    const bytes = decodeV1Signature(match[2]);
    if (!bytes) return null;
    candidates.push(bytes);
  }
  return candidates.length > 0 ? candidates : null;
}

/**
 * Verify an inbound Recall webhook over the raw request bytes. Never throws.
 *
 * `headers` is the request's header map (e.g. Express `req.headers`); `secret` is the workspace
 * verification secret text (`whsec_` + base64).
 */
export function verifyRecallWebhook(
  rawBody: Buffer,
  headers: RecallWebhookHeaders,
  secret: string,
  options: RecallWebhookVerifyOptions = {},
): RecallWebhookVerifyResult {
  const key = decodeRecallWebhookSecret(secret);
  if (!key) return { ok: false, reason: 'not_configured' };

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { ok: false, reason: 'empty_body' };
  if (rawBody.length > boundedMaxBytes(options.maxBytes)) return { ok: false, reason: 'body_too_large' };

  if (typeof headers !== 'object' || headers === null) return { ok: false, reason: 'missing_headers' };
  const set = selectHeaderSet(headers);
  if (!set) return { ok: false, reason: 'missing_headers' };

  // A repeated header arrives as an array: malformed for that field, never "pick one".
  const { id, timestamp } = set;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: 'malformed_id' };
  if (typeof timestamp !== 'string' || !TIMESTAMP_RE.test(timestamp)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  const timestampSec = Number(timestamp);
  const toleranceMs =
    boundedInt(options.toleranceSec, RECALL_WEBHOOK_DEFAULT_TOLERANCE_SEC, MIN_TOLERANCE_SEC, MAX_TOLERANCE_SEC) * 1000;
  let nowMs: number;
  try {
    nowMs = options.now ? options.now() : Date.now();
  } catch {
    nowMs = Number.NaN;
  }
  // A broken clock (NaN, Infinity, a non-number) must not turn the window check into a pass.
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs - timestampSec * 1000) > toleranceMs) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const candidates = parseSignatureHeader(set.signature);
  if (!candidates) return { ok: false, reason: 'malformed_signature' };

  const expected = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]))
    .digest();
  // Every candidate is exactly 32 bytes, like the digest, so timingSafeEqual always runs. All
  // candidates are compared: the result does not depend on which entry matched.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched ? { ok: true, webhookId: id, timestampSec } : { ok: false, reason: 'mismatch' };
}
