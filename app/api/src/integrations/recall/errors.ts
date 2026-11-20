/**
 * recall/errors.ts — the stable, sanitized error taxonomy of the Recall.ai REST client.
 *
 * SECURITY: a RecallError never carries the API key, a request or response body, a bot id, a
 * meeting URL, an output-media URL (which will carry a bridge ticket in its fragment) or any
 * candidate data. It holds a stable category and code, the HTTP status number, the operation name,
 * the retry hint, and at most ten sanitized top-level KEYS of a 400 body (never its values).
 * `message` is the fixed text `recall_<category>` and `toJSON()` serializes only those fields.
 *
 * Retry policy (S01 plan R6): the client makes ONE attempt per call and never sleeps. A retryable
 * outcome comes back as `retriable: true` with a bounded `retryAfterMs`, and the durable queue
 * (S07) reschedules the job.
 */

/** Stable, sanitized error categories. */
export type RecallErrorCategory =
  | 'invalid_request' //     refused before any network call (bad id, body, URL, key, idempotency key)
  | 'unauthorized' //        401: the API key is wrong or revoked
  | 'payment_required' //    402: the workspace is out of credit
  | 'forbidden' //           403: Recall's WAF blocked the request
  | 'not_found' //           404: unknown bot (or already deleted)
  | 'not_allowed' //         405: e.g. DELETE on a bot that was already dispatched
  | 'conflict' //            409: the same Idempotency-Key is still being processed (retriable)
  | 'bad_request' //         400: Recall rejected the body (fieldCodes names the fields)
  | 'rate_limited' //        429 (retriable, honours a bounded Retry-After)
  | 'capacity_exhausted' //  507: the ad-hoc bot pool is empty (retriable)
  | 'http_client_error' //   any other 4xx
  | 'http_server_error' //   5xx (retriable)
  | 'malformed_response' //  non-JSON, an invalid Bot shape, or an unexpected status class
  | 'timeout' //             the request deadline passed (retriable)
  | 'network' //             the transport failed before a response was read (retriable)
  | 'output_limit'; //       the response exceeded the byte cap

export const RECALL_ERROR_CATEGORIES: readonly RecallErrorCategory[] = Object.freeze([
  'invalid_request',
  'unauthorized',
  'payment_required',
  'forbidden',
  'not_found',
  'not_allowed',
  'conflict',
  'bad_request',
  'rate_limited',
  'capacity_exhausted',
  'http_client_error',
  'http_server_error',
  'malformed_response',
  'timeout',
  'network',
  'output_limit',
]);

/** Upper bound of a retry hint: five minutes (S01 plan R6). */
export const RECALL_MAX_RETRY_AFTER_MS = 300_000;

/** A safe identifier: what a code, an operation name or a field key may look like. */
const SAFE_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_FIELD_CODES = 10;

export interface RecallErrorInit {
  code?: string;
  httpStatus?: number | null;
  operation?: string;
  retriable?: boolean;
  /** Only kept when `retriable` is true; a non-negative integer, capped at five minutes. */
  retryAfterMs?: number | null;
  fieldCodes?: readonly unknown[];
}

export class RecallError extends Error {
  public readonly category: RecallErrorCategory;
  public readonly code: string;
  public readonly httpStatus: number | null;
  public readonly operation: string;
  public readonly retriable: boolean;
  /** When the caller may try again (ms from now); null when the error is not retriable. */
  public readonly retryAfterMs: number | null;
  /** Up to ten sanitized top-level keys of a 400 body: field NAMES only, never values. */
  public readonly fieldCodes: readonly string[];

  constructor(category: RecallErrorCategory, init: RecallErrorInit = {}) {
    // Fixed text only: no dynamic value ever reaches the message.
    super(`recall_${category}`);
    this.name = 'RecallError';
    this.category = category;
    this.code = sanitizeCode(init.code) ?? category;
    this.httpStatus =
      typeof init.httpStatus === 'number' && Number.isInteger(init.httpStatus) && init.httpStatus >= 0 && init.httpStatus <= 999
        ? init.httpStatus
        : null;
    this.operation = sanitizeCode(init.operation) ?? 'unknown';
    this.retriable = init.retriable === true;
    this.retryAfterMs = this.retriable ? sanitizeRetryAfter(init.retryAfterMs) : null;
    this.fieldCodes = Object.freeze(sanitizeFieldCodes(init.fieldCodes));
  }

  /** Serialize ONLY the sanitized fields: never bodies, keys, ids or URLs. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      httpStatus: this.httpStatus,
      operation: this.operation,
      retriable: this.retriable,
      retryAfterMs: this.retryAfterMs,
      fieldCodes: [...this.fieldCodes],
    };
  }
}

export function isRecallError(err: unknown): err is RecallError {
  return err instanceof RecallError;
}

/** Keep a safe-identifier code; anything else is dropped. */
function sanitizeCode(raw: unknown): string | undefined {
  return typeof raw === 'string' && SAFE_CODE_RE.test(raw) ? raw : undefined;
}

function sanitizeRetryAfter(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.min(Math.round(raw), RECALL_MAX_RETRY_AFTER_MS);
}

/** At most ten distinct safe-identifier strings, in order. */
export function sanitizeFieldCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    const code = sanitizeCode(value);
    if (code !== undefined && !out.includes(code)) out.push(code);
    if (out.length >= MAX_FIELD_CODES) break;
  }
  return out;
}
