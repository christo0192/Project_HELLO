/**
 * google/http.ts — the shared, single-attempt HTTP core of the Google client for Dex (M035 S03).
 *
 * OUTBOUND BOUNDARY, DARK. Nothing imports this at runtime yet; the token sources send through
 * `sendGoogleRequest`, the Calendar and Meet clients through `sendAuthorizedGoogleRequest` (the
 * Bearer token, the single re-mint on a 401, one log record per public call). It reads NO environment.
 *
 * What it guarantees (S03 plan R2, R5, R6, R16):
 * - Only three URL families are ever requested: exactly `https://oauth2.googleapis.com/token`
 *   (POST, no query), `https://www.googleapis.com/calendar/v3/calendars/primary/events` (+ `/<id>`)
 *   and `https://meet.googleapis.com/v2/spaces` (+ `/<name or meeting code>`). The URL must be in
 *   canonical form (what the WHATWG parser prints back), https, without userinfo, port or fragment,
 *   and the API query may only name `conferenceDataVersion`, `sendUpdates` and `updateMask` with
 *   plain values (so an `updateMask` of `*` cannot be sent). Anything else is refused with
 *   `invalid_request` and ZERO transport calls, as are an unknown method, a body on GET/DELETE, a
 *   body over 32 KiB and a header name or value that is not plain ASCII.
 * - ONE attempt per call, no internal retry and no sleep. Redirects are never followed (the default
 *   transport sends `redirect: 'manual'`), so the Authorization header is never replayed elsewhere.
 * - The deadline (default 10 s, clamped 1..30 s) covers the headers AND the body, and is raced
 *   against the transport, so a transport that ignores the abort signal still cannot hold the caller.
 * - The response body is capped (default 512 KiB, clamped 1 KiB..4 MiB) by a declared
 *   Content-Length and, when the transport exposes the byte stream (fetch does), WHILE reading.
 * - The status map (R5) is the only place a status becomes a `GoogleError` code, for two contexts:
 *   `api` (Calendar, Meet) and `token` (the OAuth token endpoint).
 * - Logging is metadata only: `{operation, outcome, code?, httpStatus?, durationMs}`. Tokens,
 *   secrets, URLs, ids, emails and bodies are never logged or put into an error. A throwing logger
 *   never breaks a call.
 */

import { GOOGLE_OPERATIONS, GoogleError, type GoogleErrorCode, type GoogleOperation } from './errors.js';

// ── Endpoints ───────────────────────────────────────────────────────────────

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const GOOGLE_MEET_API_URL = 'https://meet.googleapis.com/v2/';

// ── Bounds ──────────────────────────────────────────────────────────────────

export const GOOGLE_DEFAULT_TIMEOUT_MS = 10_000;
export const GOOGLE_MAX_TIMEOUT_MS = 30_000;
export const GOOGLE_DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
export const GOOGLE_MIN_RESPONSE_BYTES = 1024;
export const GOOGLE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Largest request body the client will send. */
export const GOOGLE_MAX_REQUEST_BODY_BYTES = 32 * 1024;

/** Retry-After (delta-seconds) is clamped into this window. */
export const GOOGLE_MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 300_000;

/** Retry hints used when Google sends no usable Retry-After. */
export const GOOGLE_DEFAULT_RETRY_AFTER_MS = Object.freeze({
  quota: 30_000,
  /** A 5xx answer. */
  unavailable: 10_000,
  /** The transport failed before a response was read. */
  network: 5_000,
  timeout: 5_000,
});

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_VALUE_LENGTH = 8192;
/** How many entries of a vendor error array are looked at for a quota signal. */
const MAX_ERROR_ENTRIES = 20;

// ── Transport seam ──────────────────────────────────────────────────────────

export type GoogleHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const METHODS: readonly GoogleHttpMethod[] = Object.freeze(['GET', 'POST', 'PATCH', 'DELETE']);

export interface GoogleTransportRequest {
  method: GoogleHttpMethod;
  url: string;
  /** Lower-case names. Holds the Authorization header on API calls: never log it. */
  headers: Record<string, string>;
  /** Absent on GET and DELETE. */
  body?: string;
  /** The effective deadline of this call (already clamped). */
  timeoutMs: number;
  /** Aborted when the deadline passes or the body goes over the cap. Fakes may ignore it. */
  signal: AbortSignal;
}

export interface GoogleTransportResponse {
  status: number;
  /** Header names in lower case (looked up case-insensitively anyway). */
  headers: Record<string, string>;
  /**
   * The body as a byte stream (fetch's `Response.body`). When present it is read instead of
   * `text()`, and the byte cap is enforced while reading. Fakes may leave it out.
   */
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export interface GoogleTransport {
  (req: GoogleTransportRequest): Promise<GoogleTransportResponse>;
}

/** Metadata-only log record: no token, secret, URL, id, email or body. */
export interface GoogleLogRecord {
  operation: GoogleOperation;
  outcome: 'success' | 'failure';
  code?: GoogleErrorCode;
  httpStatus?: number;
  durationMs: number;
}

export interface GoogleClientLogger {
  event(record: GoogleLogRecord): void;
}

/** The default transport: `fetch` that never follows a redirect, headers flattened to lower case. */
export const defaultGoogleTransport: GoogleTransport = async (req) => {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    // Never follow a redirect: a 3xx surfaces as `malformed_response`, so the Authorization header
    // is never replayed to another location.
    redirect: 'manual',
  };
  if (req.body !== undefined) init.body = req.body;
  const response = await fetch(req.url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: response.body, text: () => response.text() };
};

// ── Small helpers ───────────────────────────────────────────────────────────

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** The effective deadline: default 10 000 ms, an integer clamped to 1..30 000. */
export function resolveGoogleTimeoutMs(value?: number): number {
  return boundedInt(value, GOOGLE_DEFAULT_TIMEOUT_MS, 1, GOOGLE_MAX_TIMEOUT_MS);
}

/** The effective response cap: default 512 KiB, an integer clamped to 1 KiB..4 MiB. */
export function resolveGoogleMaxResponseBytes(value?: number): number {
  return boundedInt(value, GOOGLE_DEFAULT_MAX_RESPONSE_BYTES, GOOGLE_MIN_RESPONSE_BYTES, GOOGLE_MAX_RESPONSE_BYTES);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(stripBom(raw)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Emit one metadata-only record: `{operation, outcome, durationMs}` plus `code` and `httpStatus`
 * when known. The outcome is `failure` exactly when `error` is given. A missing or throwing logger
 * is ignored: logging must never break a call.
 */
export function emitGoogleLog(
  logger: GoogleClientLogger | undefined,
  entry: { operation: GoogleOperation; startedAt: number; error?: GoogleError; httpStatus?: number },
): void {
  if (logger === undefined || logger === null) return;
  const record: GoogleLogRecord = {
    operation: entry.operation,
    outcome: entry.error === undefined ? 'success' : 'failure',
    durationMs: Math.max(0, Date.now() - entry.startedAt),
  };
  if (entry.error !== undefined) {
    record.code = entry.error.code;
    if (entry.error.httpStatus !== null) record.httpStatus = entry.error.httpStatus;
  } else if (typeof entry.httpStatus === 'number') {
    record.httpStatus = entry.httpStatus;
  }
  try {
    logger.event(record);
  } catch {
    // Logging must never break a request.
  }
}

// ── URL families (R6) ───────────────────────────────────────────────────────

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const TOKEN_HOST = new URL(GOOGLE_TOKEN_URL).hostname;
const CALENDAR_HOST = new URL(GOOGLE_CALENDAR_EVENTS_URL).hostname;
const MEET_HOST = new URL(GOOGLE_MEET_API_URL).hostname;
const CALENDAR_EVENTS_PATH = '/calendar/v3/calendars/primary/events';
/** An event id: Google's base32hex alphabet (lowercase a-v and digits), 5..1024 characters. */
const CALENDAR_EVENT_PATH_RE = /^\/calendar\/v3\/calendars\/primary\/events\/[a-v0-9]{5,1024}$/;
const MEET_SPACES_PATH_RE = /^\/v2\/spaces(?:\/[A-Za-z0-9_-]{1,128})?$/;
const QUERY_NAMES: ReadonlySet<string> = new Set(['conferenceDataVersion', 'sendUpdates', 'updateMask']);
const QUERY_VALUE_RE = /^[A-Za-z0-9._]{1,64}$/;

/** `a=b&c=d` with known names, plain values and no repeats. */
function isAllowedQuery(query: string): boolean {
  if (query === '') return false;
  const seen = new Set<string>();
  for (const part of query.split('&')) {
    const equals = part.indexOf('=');
    if (equals <= 0) return false;
    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (!QUERY_NAMES.has(name) || seen.has(name) || !QUERY_VALUE_RE.test(value)) return false;
    seen.add(name);
  }
  return true;
}

/**
 * Whether `method` + `raw` is one of the three allowed URL families (R6). Exported for the tests
 * and the later clients; `sendGoogleRequest` checks it before any network call.
 */
export function isAllowedGoogleUrl(method: unknown, raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  // `new URL` silently strips tabs and newlines, so the raw text is checked first.
  if (!PRINTABLE_ASCII.test(raw) || raw.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Canonical form only: rejects `..` segments, a default `:443`, upper-case hosts, backslashes.
  if (url.href !== raw) return false;
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;

  const queryAt = raw.indexOf('?');
  const query = queryAt === -1 ? null : raw.slice(queryAt + 1);

  if (url.hostname === TOKEN_HOST) return method === 'POST' && url.pathname === '/token' && query === null;
  if (query !== null && !isAllowedQuery(query)) return false;
  if (url.hostname === CALENDAR_HOST) {
    return url.pathname === CALENDAR_EVENTS_PATH || CALENDAR_EVENT_PATH_RE.test(url.pathname);
  }
  if (url.hostname === MEET_HOST) return MEET_SPACES_PATH_RE.test(url.pathname);
  return false;
}

// ── Status map (R5) ─────────────────────────────────────────────────────────

/** `error.errors[].reason` values that mean a quota or rate limit (Calendar v3 style errors). */
const QUOTA_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/**
 * `usageLimits` reasons that are NOT a quota: the API is not enabled for the project, or an API key
 * restriction. They are setup errors (alert), never a backoff.
 */
const USAGE_LIMITS_SETUP_REASONS: ReadonlySet<string> = new Set([
  'accessNotConfigured',
  'ipRefererBlocked',
  'keyExpired',
  'keyInvalid',
]);

/** Whether a 403 body says "quota" rather than "forbidden". Only a boolean leaves this function. */
function hasQuotaSignal(parsed: unknown): boolean {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.error)) return false;
  const error = parsed.error;
  if (error.status === 'RESOURCE_EXHAUSTED') return true;
  if (Array.isArray(error.errors)) {
    for (const entry of error.errors.slice(0, MAX_ERROR_ENTRIES)) {
      if (!isPlainObject(entry)) continue;
      const reason = typeof entry.reason === 'string' ? entry.reason : '';
      if (QUOTA_REASONS.has(reason)) return true;
      if (entry.domain === 'usageLimits' && !USAGE_LIMITS_SETUP_REASONS.has(reason)) return true;
    }
  }
  // google.rpc.ErrorInfo details (Meet v2 style errors).
  if (Array.isArray(error.details)) {
    for (const entry of error.details.slice(0, MAX_ERROR_ENTRIES)) {
      if (isPlainObject(entry) && entry.reason === 'RATE_LIMIT_EXCEEDED') return true;
    }
  }
  return false;
}

/** Retry-After as delta-seconds, clamped to [1 s, 300 s]; an HTTP-date or junk uses the fallback. */
function retryAfterMs(raw: string | undefined, fallbackMs: number): number {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d{1,9}$/.test(trimmed)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(GOOGLE_MIN_RETRY_AFTER_MS, Number(trimmed) * 1000));
    }
  }
  return fallbackMs;
}

export type GoogleSendContext = 'api' | 'token';

/** Map a non-2xx status to the closed taxonomy (single attempt; the caller decides to retry). */
function statusError(
  context: GoogleSendContext,
  operation: GoogleOperation,
  status: number,
  headers: Record<string, string>,
  raw: string,
): GoogleError {
  const httpStatus = status;
  if (status >= 500 && status <= 599) {
    return new GoogleError('unavailable', {
      operation,
      httpStatus,
      retryAfterMs: retryAfterMs(headers['retry-after'], GOOGLE_DEFAULT_RETRY_AFTER_MS.unavailable),
    });
  }
  if (status === 429) {
    return new GoogleError('quota', {
      operation,
      httpStatus,
      retryAfterMs: retryAfterMs(headers['retry-after'], GOOGLE_DEFAULT_RETRY_AFTER_MS.quota),
    });
  }
  // 1xx, 3xx (redirects are never followed) and anything outside the HTTP range.
  if (status < 400 || status > 499) return new GoogleError('malformed_response', { operation, httpStatus });

  const parsed = parseJson(raw);
  if (context === 'token') {
    // OAuth 2.0 error response: `{"error": "<code>", ...}`. Only `invalid_grant` means the grant
    // itself is dead; every other 4xx (invalid_client, unauthorized_client, access_denied,
    // invalid_scope, admin_policy_enforced, org_internal, ...) is a setup error.
    const name = isPlainObject(parsed) && typeof parsed.error === 'string' ? parsed.error : null;
    return new GoogleError(name === 'invalid_grant' ? 'auth_revoked' : 'setup_forbidden', { operation, httpStatus });
  }
  switch (status) {
    case 400:
      return new GoogleError('invalid_request', { operation, httpStatus });
    case 401:
      return new GoogleError('unauthorized', { operation, httpStatus });
    case 403:
      return hasQuotaSignal(parsed)
        ? new GoogleError('quota', {
            operation,
            httpStatus,
            retryAfterMs: retryAfterMs(headers['retry-after'], GOOGLE_DEFAULT_RETRY_AFTER_MS.quota),
          })
        : new GoogleError('setup_forbidden', { operation, httpStatus });
    case 404:
    case 410:
      return new GoogleError('not_found', { operation, httpStatus });
    case 409:
      return new GoogleError('already_exists', { operation, httpStatus });
    default:
      return new GoogleError('invalid_request', { operation, httpStatus });
  }
}

// ── Body reading ────────────────────────────────────────────────────────────

/** `readBody`'s answer when the body went past the byte cap. */
const OVER_LIMIT = Symbol('google_over_limit');

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === 'object' && value !== null && typeof (value as { getReader?: unknown }).getReader === 'function';
}

function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.cancel().catch(() => {});
  } catch {
    // A reader that cannot be cancelled is dropped; the request controller aborts the fetch.
  }
}

/**
 * The response body as UTF-8 (a leading byte-order mark dropped), or `OVER_LIMIT`. With a body
 * stream the cap is enforced WHILE reading: the stream is cancelled as soon as the running byte
 * count passes `maxBytes`. Without one, `text()` is read and then measured. A chunk that is not
 * bytes, or a failing stream, throws (mapped to `unavailable` by the caller).
 */
async function readBody(response: GoogleTransportResponse, maxBytes: number): Promise<string | typeof OVER_LIMIT> {
  const stream = (response as { body?: unknown }).body;
  if (isByteStream(stream)) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        cancelQuietly(reader);
        throw new Error('google_body_not_bytes');
      }
      total += value.byteLength;
      if (total > maxBytes) {
        cancelQuietly(reader);
        return OVER_LIMIT;
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  }
  const raw = await response.text();
  if (typeof raw !== 'string') return '';
  return Buffer.byteLength(raw, 'utf8') > maxBytes ? OVER_LIMIT : stripBom(raw);
}

/** Response headers as a lower-case record; a missing or odd headers value is empty. */
function responseHeaders(response: GoogleTransportResponse): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  try {
    const headers: unknown = response.headers;
    if (isPlainObject(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value === 'string') out[name.toLowerCase()] = value;
      }
    }
  } catch {
    // Unreadable headers count as none.
  }
  return out;
}

// ── Send ────────────────────────────────────────────────────────────────────

export interface GoogleSendRequest {
  operation: GoogleOperation;
  /** `token` only on `GOOGLE_TOKEN_URL`, `api` everywhere else. */
  context: GoogleSendContext;
  method: GoogleHttpMethod;
  url: string;
  /** Lower-case names; `accept: application/json` is added unless given. */
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface GoogleSendOptions {
  /** Test seam: fully replaces the network. Default: `defaultGoogleTransport`. */
  transport?: GoogleTransport;
  /** Per-call deadline in ms, covering headers and body. Default 10 000, clamped to 1..30 000. */
  timeoutMs?: number;
  /** Response byte cap. Default 512 KiB, clamped to 1 KiB..4 MiB. */
  maxResponseBytes?: number;
  /** When given, receives exactly one record per call (refusals included). */
  logger?: GoogleClientLogger;
}

export interface GoogleSendResult {
  status: number;
  /** The parsed JSON body of a 2xx; `undefined` when the body is empty (e.g. 204). */
  json: unknown;
}

interface PreparedRequest {
  operation: GoogleOperation;
  context: GoogleSendContext;
  method: GoogleHttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  transport: GoogleTransport;
  timeoutMs: number;
  maxResponseBytes: number;
}

const HEADER_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;

function prepare(request: GoogleSendRequest, options: GoogleSendOptions): PreparedRequest {
  const operation = request.operation;
  const refuse = () => new GoogleError('invalid_request', { operation });
  const context = request.context;
  if (context !== 'api' && context !== 'token') throw refuse();
  const method = request.method;
  if (!METHODS.includes(method)) throw refuse();
  if (!isAllowedGoogleUrl(method, request.url)) throw refuse();
  // The token context is the token endpoint, and only it.
  if ((context === 'token') !== (request.url === GOOGLE_TOKEN_URL)) throw refuse();

  const headers: Record<string, string> = { accept: 'application/json' };
  const given = request.headers ?? {};
  if (!isPlainObject(given)) throw refuse();
  for (const [name, value] of Object.entries(given)) {
    if (!HEADER_NAME_RE.test(name) || typeof value !== 'string') throw refuse();
    if (value.length > MAX_HEADER_VALUE_LENGTH || !HEADER_VALUE_RE.test(value)) throw refuse();
    headers[name] = value;
  }

  const body = request.body;
  if (body !== undefined) {
    if (typeof body !== 'string' || method === 'GET' || method === 'DELETE') throw refuse();
    if (Buffer.byteLength(body, 'utf8') > GOOGLE_MAX_REQUEST_BODY_BYTES) throw refuse();
  }

  const transport = options.transport ?? defaultGoogleTransport;
  if (typeof transport !== 'function') throw refuse();

  const prepared: PreparedRequest = {
    operation,
    context,
    method,
    url: request.url,
    headers,
    transport,
    timeoutMs: resolveGoogleTimeoutMs(options.timeoutMs),
    maxResponseBytes: resolveGoogleMaxResponseBytes(options.maxResponseBytes),
  };
  if (body !== undefined) prepared.body = body;
  return prepared;
}

function deadlineError(): Error {
  const error = new Error('google_deadline');
  error.name = 'AbortError';
  return error;
}

/** Send ONCE, race the deadline, cap the body, map the status. Throws only `GoogleError`. */
async function transmit(prepared: PreparedRequest): Promise<GoogleSendResult> {
  const { operation } = prepared;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced against the transport and the body read, so a transport that ignores the abort signal
  // still cannot hold the caller past the deadline.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(deadlineError());
    }, prepared.timeoutMs);
  });
  deadline.catch(() => {});

  const transportFailure = (): GoogleError =>
    controller.signal.aborted
      ? new GoogleError('timeout', { operation, retryAfterMs: GOOGLE_DEFAULT_RETRY_AFTER_MS.timeout })
      : new GoogleError('unavailable', { operation, retryAfterMs: GOOGLE_DEFAULT_RETRY_AFTER_MS.network });

  try {
    let response: GoogleTransportResponse;
    try {
      const request: GoogleTransportRequest = {
        method: prepared.method,
        url: prepared.url,
        headers: { ...prepared.headers },
        timeoutMs: prepared.timeoutMs,
        signal: controller.signal,
      };
      if (prepared.body !== undefined) request.body = prepared.body;
      response = await Promise.race([prepared.transport(request), deadline]);
    } catch {
      throw transportFailure();
    }
    if (typeof response !== 'object' || response === null) {
      throw new GoogleError('malformed_response', { operation });
    }
    const status = typeof response.status === 'number' && Number.isInteger(response.status) ? response.status : 0;
    const headers = responseHeaders(response);

    const declared = headers['content-length'];
    if (declared !== undefined && /^\d{1,15}$/.test(declared.trim()) && Number(declared.trim()) > prepared.maxResponseBytes) {
      controller.abort();
      throw new GoogleError('malformed_response', { operation, httpStatus: status });
    }
    let raw: string | typeof OVER_LIMIT;
    try {
      raw = await Promise.race([readBody(response, prepared.maxResponseBytes), deadline]);
    } catch {
      throw transportFailure();
    }
    if (raw === OVER_LIMIT) {
      controller.abort();
      throw new GoogleError('malformed_response', { operation, httpStatus: status });
    }

    if (status < 200 || status > 299) throw statusError(prepared.context, operation, status, headers, raw);
    if (raw.trim() === '') return { status, json: undefined };
    const json = parseJson(raw);
    if (json === undefined) throw new GoogleError('malformed_response', { operation, httpStatus: status });
    return { status, json };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Validate, send ONCE, map. Without `parse` it resolves the status and the parsed 2xx JSON; with
 * `parse` (synchronous) it resolves what `parse` returns, and a `parse` that throws is the call's
 * outcome (a non-`GoogleError` becomes `malformed_response`). Every failure is a `GoogleError`.
 * With a logger, exactly one record is emitted per call, carrying the final outcome.
 */
export function sendGoogleRequest(request: GoogleSendRequest, options?: GoogleSendOptions): Promise<GoogleSendResult>;
export function sendGoogleRequest<T>(
  request: GoogleSendRequest,
  options: GoogleSendOptions | undefined,
  parse: (result: GoogleSendResult) => T,
): Promise<T>;
export async function sendGoogleRequest<T>(
  request: GoogleSendRequest,
  options: GoogleSendOptions = {},
  parse?: (result: GoogleSendResult) => T,
): Promise<T | GoogleSendResult> {
  const startedAt = Date.now();
  const operation = (request as Partial<GoogleSendRequest> | undefined)?.operation;
  // Without a known operation there is nothing safe to log.
  if (!(GOOGLE_OPERATIONS as readonly unknown[]).includes(operation)) throw new GoogleError('invalid_request');
  const op = operation as GoogleOperation;
  const logger = options?.logger;

  let prepared: PreparedRequest;
  try {
    prepared = prepare(request, options ?? {});
  } catch (error) {
    const refusal = error instanceof GoogleError ? error : new GoogleError('invalid_request', { operation: op });
    emitGoogleLog(logger, { operation: op, startedAt, error: refusal });
    throw refusal;
  }

  let result: GoogleSendResult;
  try {
    result = await transmit(prepared);
  } catch (error) {
    // transmit only throws GoogleError; anything else is a bug, reported without its message.
    const failure =
      error instanceof GoogleError
        ? error
        : new GoogleError('unavailable', { operation: op, retryAfterMs: GOOGLE_DEFAULT_RETRY_AFTER_MS.network });
    emitGoogleLog(logger, { operation: op, startedAt, error: failure });
    throw failure;
  }

  if (parse === undefined) {
    emitGoogleLog(logger, { operation: op, startedAt, httpStatus: result.status });
    return result;
  }
  let value: T;
  try {
    value = parse(result);
  } catch (error) {
    const failure =
      error instanceof GoogleError ? error : new GoogleError('malformed_response', { operation: op, httpStatus: result.status });
    emitGoogleLog(logger, { operation: op, startedAt, error: failure });
    throw failure;
  }
  emitGoogleLog(logger, { operation: op, startedAt, httpStatus: result.status });
  return value;
}

// ── Authorized API calls (Calendar, Meet) ───────────────────────────────────

/** What the Calendar and Meet clients need from a token source (structurally a `GoogleTokenSource`). */
export interface GoogleAccessTokenProvider {
  accessToken(): Promise<string>;
  invalidate(): void;
}

/** One Calendar or Meet request, built by the client from already-validated input. */
export interface GoogleApiRequest {
  operation: GoogleOperation;
  method: GoogleHttpMethod;
  url: string;
  /** JSON text, sent with `content-type: application/json`. Absent on GET and DELETE. */
  body?: string;
}

export interface GoogleApiCall<T> {
  /** Map the parsed 2xx. A `GoogleError` it throws is the outcome; anything else is `malformed_response`. */
  parse: (result: GoogleSendResult) => T;
  /** When given, a final `not_found` (404 / 410) resolves this value instead, logged as a success. */
  onNotFound?: () => T;
}

/** What an access token must look like before it is put into an Authorization header. */
const API_ACCESS_TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

/**
 * One public Calendar or Meet call (S03 plan R5, R16): the URL family is checked BEFORE any token is
 * minted (a refused call makes zero transport calls of any kind), then a token is taken from
 * `tokens` and the request is sent once. On a 401 the cached token is dropped (`invalidate()`), ONE
 * new token is minted and the same request is sent ONE more time; a second 401 is `unauthorized`. A
 * token-source failure (`auth_revoked`, `setup_forbidden`, ...) propagates unchanged, with zero API
 * requests. With a logger, exactly ONE record is emitted for the call, carrying the final outcome
 * (the token source logs its own mint attempts separately, when it was given a logger).
 */
export async function sendAuthorizedGoogleRequest<T>(
  request: GoogleApiRequest,
  tokens: GoogleAccessTokenProvider,
  options: GoogleSendOptions,
  call: GoogleApiCall<T>,
): Promise<T> {
  const startedAt = Date.now();
  const operation = request.operation;
  const logger = options.logger;
  const failed = (failure: GoogleError): GoogleError => {
    emitGoogleLog(logger, { operation, startedAt, error: failure });
    return failure;
  };

  if (!(GOOGLE_OPERATIONS as readonly unknown[]).includes(operation)) throw new GoogleError('invalid_request');
  if (!METHODS.includes(request.method) || !isAllowedGoogleUrl(request.method, request.url)) {
    throw failed(new GoogleError('invalid_request', { operation }));
  }

  // The per-attempt sends log nothing: this function emits the one record of the public call.
  const sendOptions: GoogleSendOptions = {};
  if (options.transport !== undefined) sendOptions.transport = options.transport;
  if (options.timeoutMs !== undefined) sendOptions.timeoutMs = options.timeoutMs;
  if (options.maxResponseBytes !== undefined) sendOptions.maxResponseBytes = options.maxResponseBytes;
  const baseHeaders: Record<string, string> =
    request.body === undefined ? {} : { 'content-type': 'application/json' };

  let result: GoogleSendResult | undefined;
  for (let attempt = 1; result === undefined; attempt += 1) {
    let token: unknown;
    try {
      token = await tokens.accessToken();
    } catch (error) {
      throw failed(
        error instanceof GoogleError
          ? error
          : new GoogleError('unavailable', { operation, retryAfterMs: GOOGLE_DEFAULT_RETRY_AFTER_MS.network }),
      );
    }
    if (typeof token !== 'string' || !API_ACCESS_TOKEN_RE.test(token)) {
      throw failed(new GoogleError('malformed_response', { operation }));
    }
    const send: GoogleSendRequest = {
      operation,
      context: 'api',
      method: request.method,
      url: request.url,
      headers: { ...baseHeaders, authorization: `Bearer ${token}` },
    };
    if (request.body !== undefined) send.body = request.body;
    try {
      result = await sendGoogleRequest(send, sendOptions);
    } catch (error) {
      const failure =
        error instanceof GoogleError
          ? error
          : new GoogleError('unavailable', { operation, retryAfterMs: GOOGLE_DEFAULT_RETRY_AFTER_MS.network });
      if (failure.code === 'unauthorized' && attempt === 1) {
        // The token was not accepted: drop it, mint ONE new token, send ONE more time.
        try {
          tokens.invalidate();
        } catch {
          // A provider that cannot invalidate still gets the single retry.
        }
        continue;
      }
      if (failure.code === 'not_found' && call.onNotFound !== undefined) {
        const value = call.onNotFound();
        const entry: { operation: GoogleOperation; startedAt: number; httpStatus?: number } = { operation, startedAt };
        if (failure.httpStatus !== null) entry.httpStatus = failure.httpStatus;
        emitGoogleLog(logger, entry);
        return value;
      }
      throw failed(failure);
    }
  }

  const final: GoogleSendResult = result;
  let value: T;
  try {
    value = call.parse(final);
  } catch (error) {
    throw failed(
      error instanceof GoogleError
        ? error
        : new GoogleError('malformed_response', { operation, httpStatus: final.status }),
    );
  }
  emitGoogleLog(logger, { operation, startedAt, httpStatus: final.status });
  return value;
}
