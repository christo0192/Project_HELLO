/**
 * google/errors.ts — the stable, sanitized error taxonomy of the Google client for Dex (M035 S03).
 *
 * SECURITY: a GoogleError never carries a token, a client secret, a refresh token, a private key, a
 * JWT assertion, a request or response body, a URL, an event id, a Meet code, an email address or
 * any vendor message. It holds a closed code, the operation name, the HTTP status number and the
 * retry hint. `message` is the fixed text `google_<code>` and `toJSON()` serializes only
 * `{name, code, operation, httpStatus, retriable, retryAfterMs}`.
 *
 * Retry policy (S03 plan R4, R5): the client makes ONE attempt per call (plus the single re-mint on
 * a 401, done by the Calendar and Meet clients) and never sleeps. `retriable` is DERIVED from the
 * code: true exactly for `quota`, `unavailable` and `timeout`. `auth_revoked` and `setup_forbidden`
 * are never retried in a loop: the caller fails closed and alerts.
 */

/** The ten closed codes of contract §7.1. */
export type GoogleErrorCode =
  | 'unauthorized' //        401 twice (once after a fresh token): the token is not accepted
  | 'auth_revoked' //        token endpoint `invalid_grant`: the refresh token (or the DWD grant) is dead
  | 'setup_forbidden' //     403 (not quota), or a token-endpoint client/scope/policy refusal
  | 'quota' //               429, or a 403 with a quota signal (retriable, honours Retry-After)
  | 'not_found' //           404 / 410
  | 'already_exists' //      409 (an event with that id exists)
  | 'invalid_request' //     refused before any network call, or a 400 / other 4xx from an API
  | 'unavailable' //         5xx or a transport failure (retriable)
  | 'timeout' //             the deadline passed (retriable)
  | 'malformed_response'; // a 3xx, a non-JSON or wrongly shaped 2xx, or a body over the cap

export const GOOGLE_ERROR_CODES: readonly GoogleErrorCode[] = Object.freeze([
  'unauthorized',
  'auth_revoked',
  'setup_forbidden',
  'quota',
  'not_found',
  'already_exists',
  'invalid_request',
  'unavailable',
  'timeout',
  'malformed_response',
]);

/** Every public call of the Google client, by name (logs and errors carry only this). */
export type GoogleOperation =
  | 'token.refresh'
  | 'token.jwt_bearer'
  | 'calendar.insert'
  | 'calendar.get'
  | 'calendar.patch'
  | 'calendar.delete'
  | 'meet.get'
  | 'meet.patch'
  | 'meet.create';

export const GOOGLE_OPERATIONS: readonly GoogleOperation[] = Object.freeze([
  'token.refresh',
  'token.jwt_bearer',
  'calendar.insert',
  'calendar.get',
  'calendar.patch',
  'calendar.delete',
  'meet.get',
  'meet.patch',
  'meet.create',
]);

/** Upper bound of a retry hint: five minutes. */
export const GOOGLE_MAX_RETRY_AFTER_MS = 300_000;

const RETRIABLE_CODES: ReadonlySet<GoogleErrorCode> = new Set<GoogleErrorCode>(['quota', 'unavailable', 'timeout']);

/** Whether a code is one the caller may retry later (quota, unavailable, timeout). */
export function isRetriableGoogleErrorCode(code: GoogleErrorCode): boolean {
  return RETRIABLE_CODES.has(code);
}

export interface GoogleErrorInit {
  operation?: GoogleOperation | null;
  httpStatus?: number | null;
  /** Only kept when the code is retriable; a non-negative integer, capped at five minutes. */
  retryAfterMs?: number | null;
}

export class GoogleError extends Error {
  public readonly code: GoogleErrorCode;
  /** The public call that failed; null when the error was built without one. */
  public readonly operation: GoogleOperation | null;
  public readonly httpStatus: number | null;
  /** True exactly for `quota`, `unavailable` and `timeout`. */
  public readonly retriable: boolean;
  /** When the caller may try again (ms from now); null when the error is not retriable. */
  public readonly retryAfterMs: number | null;

  constructor(code: GoogleErrorCode, init: GoogleErrorInit = {}) {
    // A code outside the closed set (a bug in a caller) becomes `malformed_response`, so the
    // message can only ever be one of ten fixed texts.
    const safeCode: GoogleErrorCode = (GOOGLE_ERROR_CODES as readonly unknown[]).includes(code)
      ? code
      : 'malformed_response';
    super(`google_${safeCode}`);
    this.name = 'GoogleError';
    this.code = safeCode;
    this.operation = sanitizeOperation(init?.operation);
    this.httpStatus = sanitizeHttpStatus(init?.httpStatus);
    this.retriable = RETRIABLE_CODES.has(safeCode);
    this.retryAfterMs = this.retriable ? sanitizeRetryAfter(init?.retryAfterMs) : null;
  }

  /** Serialize ONLY the sanitized fields: never tokens, secrets, bodies, URLs, ids or emails. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      httpStatus: this.httpStatus,
      retriable: this.retriable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export function isGoogleError(err: unknown): err is GoogleError {
  return err instanceof GoogleError;
}

function sanitizeOperation(raw: unknown): GoogleOperation | null {
  return (GOOGLE_OPERATIONS as readonly unknown[]).includes(raw) ? (raw as GoogleOperation) : null;
}

function sanitizeHttpStatus(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 999 ? raw : null;
}

function sanitizeRetryAfter(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.min(Math.round(raw), GOOGLE_MAX_RETRY_AFTER_MS);
}
