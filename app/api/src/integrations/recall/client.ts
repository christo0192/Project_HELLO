/**
 * recall/client.ts — typed, injectable Recall.ai REST client for R1-over-Meet bots.
 *
 * OUTBOUND BOUNDARY, DARK. Nothing imports this module at runtime yet (S01 ships libraries only);
 * S07 constructs it from `getR1MeetConfig()` once the Meet flag is on. It reads NO environment.
 *
 * What it guarantees:
 * - The origin is a validated `https://<one-label>.recall.ai` (default: our Tokyo region, D-M034-4),
 *   checked in the constructor even when a test transport is injected. Paths are fixed per
 *   operation; a bot id is checked to be a lowercase UUID before it is put into a path.
 * - `Authorization: Token <key>` is built once and kept in an ES private field, so it never shows up
 *   in `Object.keys`, a spread, `JSON.stringify` or an error.
 * - ONE attempt per call, no internal retry and no sleep (S01 plan R6). A retryable outcome throws a
 *   `RecallError` with `retriable: true` and a bounded `retryAfterMs` (Retry-After delta-seconds
 *   clamped to 1 s..300 s, else 409 5 s, 429 30 s, 507 30 s, 5xx 10 s, network/timeout 5 s); the
 *   durable queue reschedules.
 * - `createBot` REQUIRES an Idempotency-Key (Recall caches key + method + path for an hour, so a
 *   retried create returns the same bot). The key is optional on the other mutations and never sent
 *   on a GET (Recall's WAF rejects a GET that carries a body, so a GET carries none).
 * - Pre-transport validation refuses, with ZERO network calls: a non-canonical meeting URL, any
 *   output-media kind other than `webpage` (never a LiveKit hand-off: that would give Recall our SFU
 *   secret, critic C6), a non-https or credentialed page URL, an unknown variant, a malformed
 *   `join_at`, a non-webhook or non-https realtime endpoint, and a body over 64 KiB.
 * - Deadline (default 15 s, clamp 1..60 s) covers the response body too; the body is capped at
 *   2 MiB by default.
 * - Logging is metadata only: `{operation, outcome, category, httpStatus, durationMs}`. The key,
 *   URLs, bot ids, meeting URLs, bodies and bridge tickets are never logged or put into an error.
 */

import { normalizeGoogleMeetUrl } from '../google-meet/url.js';
import { RecallError, type RecallErrorCategory } from './errors.js';
import {
  RECALL_DEFAULT_BASE_URL,
  RECALL_IDEMPOTENCY_KEY_RE,
  isRecallApiKeyShaped,
  isRecallBotId,
  normalizeRecallBaseUrl,
} from './settings.js';
import {
  RECALL_GOOGLE_MEET_VARIANTS,
  type RecallBot,
  type RecallBotStatusChange,
  type RecallCreateBotRequest,
  type RecallOperation,
} from './types.js';

// ── Bounds ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_RESPONSE_BYTES = 1024;
const MAX_RESPONSE_BYTES_CAP = 16 * 1024 * 1024;
/** Largest request body the client will send. */
export const RECALL_MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** Longest output-media page URL accepted (it carries a bridge ticket in S07). */
export const RECALL_MAX_PAGE_URL_LENGTH = 2048;
const MAX_REALTIME_ENDPOINTS = 4;

/** Retry-After (delta-seconds) is clamped into this window. */
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 300_000;

/** Retry hints used when Recall sends no usable Retry-After. */
export const RECALL_DEFAULT_RETRY_AFTER_MS = Object.freeze({
  conflict: 5_000,
  rate_limited: 30_000,
  capacity_exhausted: 30_000,
  http_server_error: 10_000,
  network: 5_000,
  timeout: 5_000,
});

/** Bounds of the parsed Bot (S01 plan R18). */
export const RECALL_BOT_MAX_STATUS_CHANGES = 50;
export const RECALL_BOT_MAX_METADATA_ENTRIES = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 256;

/**
 * Vendor error codes Recall documents (errors reference). A 4xx body naming one of these keeps it as
 * the error code; any other value is dropped, so a response can never smuggle text into an error.
 */
export const RECALL_KNOWN_ERROR_CODES: readonly string[] = Object.freeze([
  'request_blocked',
  'update_bot_failed',
  'cannot_command_completed_bot',
  'cannot_command_unstarted_bot',
  'teams_blacklisted_tenant',
]);

const STATUS_CODE_RE = /^[a-z0-9_.:-]{1,64}$/;
const METADATA_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const FIELD_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const BOT_PATH = '/api/v1/bot/';

// ── Injection seams ─────────────────────────────────────────────────────────

export interface RecallTransportRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  /** Absent on GET and on a POST that takes no body. */
  body?: string;
  signal: AbortSignal;
}

export interface RecallTransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type RecallTransport = (req: RecallTransportRequest) => Promise<RecallTransportResponse>;

/** Metadata-only log record: no key, URL, id, meeting URL, body or ticket. */
export interface RecallLogRecord {
  operation: RecallOperation;
  outcome: 'success' | 'failure';
  category?: RecallErrorCategory;
  httpStatus?: number;
  durationMs: number;
}

export interface RecallClientLogger {
  event(record: RecallLogRecord): void;
}

const NOOP_LOGGER: RecallClientLogger = { event: () => {} };

export interface RecallClientConfig {
  /** Recall API key (16..256 printable ASCII). Never logged, never stored as a public field. */
  apiKey: string;
  /** Regional origin, validated by `normalizeRecallBaseUrl`. Default: `RECALL_DEFAULT_BASE_URL`. */
  baseUrl?: string;
  /** Test seam: fully replaces the network. The base URL is validated regardless. */
  transport?: RecallTransport;
  /** Metadata-only logger; default silent. */
  logger?: RecallClientLogger;
  /** Per-call deadline in ms, covering headers and body. Default 15 000, clamped to 1..60 000. */
  timeoutMs?: number;
  /** Response byte cap. Default 2 MiB, clamped to 1 KiB..16 MiB. */
  maxResponseBytes?: number;
}

/** `createBot` requires an Idempotency-Key. */
export interface RecallCreateBotOptions {
  idempotencyKey: string;
}

/** Optional Idempotency-Key for the other mutations. */
export interface RecallMutationOptions {
  idempotencyKey?: string;
}

export interface RecallStartOutputMediaInput {
  /** Our https bridge page; in S07 it carries a ticket in its fragment. Never logged. */
  cameraWebpageUrl: string;
}

function defaultTransport(req: RecallTransportRequest): Promise<RecallTransportResponse> {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    // Never follow a redirect: a 3xx surfaces as `malformed_response/unexpected_status`, so the
    // Authorization header is never replayed to another location.
    redirect: 'manual',
  };
  if (req.body !== undefined) init.body = req.body;
  return fetch(req.url, init);
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function invalid(operation: RecallOperation | 'client_init', code: string): RecallError {
  return new RecallError('invalid_request', { code, operation });
}

/**
 * Strict ISO 8601 date-time with a `Z` or `±hh:mm` offset and a real calendar date (Date.parse
 * alone would accept 30 February).
 */
export function isRecallIsoDateTime(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 64) return false;
  const match = ISO_DATE_TIME_RE.exec(raw);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, , oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false;
  return Number.isFinite(Date.parse(raw));
}

/** An https URL without credentials, printable ASCII, at most 2048 characters. */
function isSafeHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RECALL_MAX_PAGE_URL_LENGTH) return false;
  if (!PRINTABLE_ASCII.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
}

function validateBotId(operation: RecallOperation, id: unknown): string {
  if (!isRecallBotId(id)) throw invalid(operation, 'bot_id');
  return id;
}

function validateIdempotencyKey(operation: RecallOperation, key: unknown, required: boolean): string | undefined {
  if (key === undefined && !required) return undefined;
  if (typeof key !== 'string' || !RECALL_IDEMPOTENCY_KEY_RE.test(key)) throw invalid(operation, 'idempotency_key');
  return key;
}

function serializeBody(operation: RecallOperation, body: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw invalid(operation, 'invalid_body');
  }
  if (typeof serialized !== 'string') throw invalid(operation, 'invalid_body');
  if (Buffer.byteLength(serialized, 'utf8') > RECALL_MAX_REQUEST_BODY_BYTES) throw invalid(operation, 'body_too_large');
  return serialized;
}

/** `{camera:{kind:'webpage',config:{url}}}` and nothing else (S01 plan R8). */
function validateOutputMedia(operation: RecallOperation, outputMedia: unknown): void {
  if (!isPlainObject(outputMedia) || !hasExactKeys(outputMedia, ['camera'])) throw invalid(operation, 'output_media_kind');
  const camera = outputMedia.camera;
  if (!isPlainObject(camera) || !hasExactKeys(camera, ['kind', 'config']) || camera.kind !== 'webpage') {
    throw invalid(operation, 'output_media_kind');
  }
  const config = camera.config;
  if (!isPlainObject(config) || !hasExactKeys(config, ['url'])) throw invalid(operation, 'output_media_kind');
  if (!isSafeHttpsUrl(config.url)) throw invalid(operation, 'output_media_url');
}

function validateRecordingConfig(operation: RecallOperation, recordingConfig: unknown): void {
  if (recordingConfig === undefined || recordingConfig === null) return;
  if (!isPlainObject(recordingConfig)) throw invalid(operation, 'invalid_body');
  const endpoints = recordingConfig.realtime_endpoints;
  if (endpoints === undefined) return;
  if (!Array.isArray(endpoints) || endpoints.length > MAX_REALTIME_ENDPOINTS) throw invalid(operation, 'realtime_endpoint');
  for (const endpoint of endpoints) {
    if (!isPlainObject(endpoint) || endpoint.type !== 'webhook' || !isSafeHttpsUrl(endpoint.url)) {
      throw invalid(operation, 'realtime_endpoint');
    }
  }
}

function validateCreateBotBody(operation: RecallOperation, body: unknown): string {
  if (!isPlainObject(body)) throw invalid(operation, 'invalid_body');
  const meetingUrl = body.meeting_url;
  if (typeof meetingUrl !== 'string' || normalizeGoogleMeetUrl(meetingUrl) !== meetingUrl) {
    throw invalid(operation, 'meeting_url');
  }
  if (body.join_at !== undefined && !isRecallIsoDateTime(body.join_at)) throw invalid(operation, 'join_at');
  if (body.variant !== undefined) {
    const variant = body.variant;
    if (
      !isPlainObject(variant) ||
      !hasExactKeys(variant, ['google_meet']) ||
      !(RECALL_GOOGLE_MEET_VARIANTS as readonly unknown[]).includes(variant.google_meet)
    ) {
      throw invalid(operation, 'variant');
    }
  }
  if (body.output_media !== undefined) validateOutputMedia(operation, body.output_media);
  validateRecordingConfig(operation, body.recording_config);
  return serializeBody(operation, body);
}

/** Retry-After as delta-seconds, clamped to [1 s, 300 s]; an HTTP-date or junk uses the fallback. */
function retryAfterMs(raw: string | null, fallbackMs: number): number {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d{1,9}$/.test(trimmed)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Number(trimmed) * 1000));
    }
  }
  return fallbackMs;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Top-level keys of a 400 body (field names, never values). */
function fieldCodesFrom(parsed: unknown): string[] {
  if (!isPlainObject(parsed)) return [];
  return Object.keys(parsed).filter((key) => FIELD_KEY_RE.test(key));
}

/** A documented vendor error code from a 4xx body, or undefined. */
function knownVendorCode(parsed: unknown): string | undefined {
  if (!isPlainObject(parsed) || typeof parsed.code !== 'string') return undefined;
  return RECALL_KNOWN_ERROR_CODES.includes(parsed.code) ? parsed.code : undefined;
}

function safeHeader(response: RecallTransportResponse, name: string): string | null {
  try {
    const value = response.headers.get(name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Map a non-2xx status to the sanitized taxonomy (single attempt; the caller decides to retry). */
function statusError(operation: RecallOperation, response: RecallTransportResponse, raw: string): RecallError {
  const status = response.status;
  const retryAfterHeader = safeHeader(response, 'retry-after');
  const parsed = status >= 400 && status <= 499 ? parseJson(raw) : undefined;
  const vendorCode = knownVendorCode(parsed);
  const fixed = (category: RecallErrorCategory, code?: string) =>
    new RecallError(category, { operation, httpStatus: status, code: code ?? vendorCode, retriable: false });
  const retriable = (category: keyof typeof RECALL_DEFAULT_RETRY_AFTER_MS & RecallErrorCategory) =>
    new RecallError(category, {
      operation,
      httpStatus: status,
      code: vendorCode,
      retriable: true,
      retryAfterMs: retryAfterMs(retryAfterHeader, RECALL_DEFAULT_RETRY_AFTER_MS[category]),
    });

  switch (status) {
    case 400:
      return new RecallError('bad_request', {
        operation,
        httpStatus: status,
        code: vendorCode,
        retriable: false,
        fieldCodes: fieldCodesFrom(parsed),
      });
    case 401:
      return fixed('unauthorized');
    case 402:
      return fixed('payment_required');
    case 403:
      return fixed('forbidden');
    case 404:
      return fixed('not_found');
    case 405:
      // Recall answers 405 to DELETE once a scheduled bot has been sent to its call.
      return fixed('not_allowed', operation === 'bot.delete_scheduled' ? 'bot_already_dispatched' : undefined);
    case 409:
      return retriable('conflict');
    case 429:
      return retriable('rate_limited');
    case 507:
      return retriable('capacity_exhausted');
    default:
      break;
  }
  if (status >= 400 && status <= 499) return fixed('http_client_error');
  if (status >= 500 && status <= 599) return retriable('http_server_error');
  return new RecallError('malformed_response', { operation, httpStatus: status, code: 'unexpected_status' });
}

function abortError(): Error {
  const error = new Error('recall_timeout');
  error.name = 'AbortError';
  return error;
}

// ── Parsed Bot ──────────────────────────────────────────────────────────────

function parseStatusChange(raw: unknown): RecallBotStatusChange | null {
  if (!isPlainObject(raw)) return null;
  const code = raw.code;
  if (typeof code !== 'string' || !STATUS_CODE_RE.test(code)) return null;
  const createdAt = raw.created_at;
  if (!isRecallIsoDateTime(createdAt)) return null;
  const subCode = typeof raw.sub_code === 'string' && STATUS_CODE_RE.test(raw.sub_code) ? raw.sub_code : null;
  return Object.freeze({ code, subCode, createdAt });
}

function parseMetadata(raw: unknown): Readonly<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (entries.length >= RECALL_BOT_MAX_METADATA_ENTRIES) break;
      if (key.length > MAX_METADATA_KEY_LENGTH || !METADATA_KEY_RE.test(key)) continue;
      if (typeof value !== 'string' || value.length > MAX_METADATA_VALUE_LENGTH) continue;
      entries.push([key, value]);
    }
  }
  // fromEntries defines own data properties, so a `__proto__` key stays a plain entry.
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * The closed Bot shape (S01 plan R18), or null when `json` is not a Bot. Keeps `id` (lowercase
 * UUID, required), `join_at` (strict ISO or null), the last 50 well-formed status changes (code and
 * sub-code must be safe identifiers; Recall's free-text `message` is dropped) and up to 16 string
 * metadata entries. Everything else, including `meeting_url`, `recordings`, `recording_config` and
 * `output_media`, is ignored. Exported so S04 can reuse it on webhook payloads.
 */
export function parseRecallBot(json: unknown): RecallBot | null {
  if (!isPlainObject(json)) return null;
  const id = json.id;
  if (!isRecallBotId(id)) return null;
  const rawChanges = json.status_changes;
  if (!Array.isArray(rawChanges)) return null;
  const kept: RecallBotStatusChange[] = [];
  for (const entry of rawChanges) {
    const change = parseStatusChange(entry);
    if (change) kept.push(change);
  }
  const statusChanges = Object.freeze(kept.slice(-RECALL_BOT_MAX_STATUS_CHANGES));
  const latest = statusChanges.length > 0 ? statusChanges[statusChanges.length - 1] : null;
  return Object.freeze({
    id,
    joinAt: isRecallIsoDateTime(json.join_at) ? json.join_at : null,
    statusChanges,
    latestStatus: latest ? latest.code : null,
    metadata: parseMetadata(json.metadata),
  });
}

// ── Client ──────────────────────────────────────────────────────────────────

interface PreparedRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: string;
  idempotencyKey?: string;
}

export class RecallClient {
  readonly #authorization: string;
  readonly #baseUrl: string;
  readonly #transport: RecallTransport;
  readonly #logger: RecallClientLogger;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(config: RecallClientConfig) {
    if (!isRecallApiKeyShaped(config?.apiKey)) throw invalid('client_init', 'api_key');
    const baseUrl = normalizeRecallBaseUrl(config.baseUrl ?? RECALL_DEFAULT_BASE_URL);
    if (baseUrl === null) throw invalid('client_init', 'base_url');
    if (config.transport !== undefined && typeof config.transport !== 'function') {
      throw invalid('client_init', 'transport');
    }
    this.#authorization = `Token ${config.apiKey}`;
    this.#baseUrl = baseUrl;
    this.#transport = config.transport ?? defaultTransport;
    this.#logger = config.logger ?? NOOP_LOGGER;
    this.#timeoutMs = boundedInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.#maxResponseBytes = boundedInt(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES_CAP,
    );
  }

  /** `POST /api/v1/bot/` with a REQUIRED Idempotency-Key. Returns the parsed Bot. */
  async createBot(body: RecallCreateBotRequest, opts: RecallCreateBotOptions): Promise<RecallBot> {
    const operation: RecallOperation = 'bot.create';
    return this.#botCall(operation, () => {
      const idempotencyKey = validateIdempotencyKey(operation, opts?.idempotencyKey, true);
      return { method: 'POST', path: BOT_PATH, body: validateCreateBotBody(operation, body), idempotencyKey };
    });
  }

  /** `GET /api/v1/bot/{id}/`. */
  async getBot(id: string): Promise<RecallBot> {
    const operation: RecallOperation = 'bot.get';
    return this.#botCall(operation, () => ({ method: 'GET', path: `${BOT_PATH}${validateBotId(operation, id)}/` }));
  }

  /**
   * `DELETE /api/v1/bot/{id}/`: unschedule a bot that has not been dispatched. Once it has been
   * sent to its call Recall answers 405, surfaced as `not_allowed/bot_already_dispatched` (use
   * `leaveCall` then).
   */
  async deleteScheduledBot(id: string): Promise<void> {
    const operation: RecallOperation = 'bot.delete_scheduled';
    await this.#call(operation, false, () => ({
      method: 'DELETE',
      path: `${BOT_PATH}${validateBotId(operation, id)}/`,
    }));
  }

  /** `POST /api/v1/bot/{id}/leave_call/` (no body). Irreversible. Returns the parsed Bot. */
  async leaveCall(id: string, opts: RecallMutationOptions = {}): Promise<RecallBot> {
    const operation: RecallOperation = 'bot.leave_call';
    return this.#botCall(operation, () => {
      const path = `${BOT_PATH}${validateBotId(operation, id)}/leave_call/`;
      return { method: 'POST', path, idempotencyKey: validateIdempotencyKey(operation, opts?.idempotencyKey, false) };
    });
  }

  /** `POST /api/v1/bot/{id}/output_media/` with our web page as the bot's camera. */
  async startOutputMedia(
    id: string,
    input: RecallStartOutputMediaInput,
    opts: RecallMutationOptions = {},
  ): Promise<void> {
    const operation: RecallOperation = 'bot.output_media.start';
    await this.#call(operation, false, () => {
      const path = `${BOT_PATH}${validateBotId(operation, id)}/output_media/`;
      const url = input?.cameraWebpageUrl;
      if (!isSafeHttpsUrl(url)) throw invalid(operation, 'output_media_url');
      const body = serializeBody(operation, { camera: { kind: 'webpage', config: { url } } });
      return { method: 'POST', path, body, idempotencyKey: validateIdempotencyKey(operation, opts?.idempotencyKey, false) };
    });
  }

  /** `DELETE /api/v1/bot/{id}/output_media/` with body `{"camera":true}`. */
  async stopOutputMedia(id: string, opts: RecallMutationOptions = {}): Promise<void> {
    const operation: RecallOperation = 'bot.output_media.stop';
    await this.#call(operation, false, () => {
      const path = `${BOT_PATH}${validateBotId(operation, id)}/output_media/`;
      const body = serializeBody(operation, { camera: true });
      return { method: 'DELETE', path, body, idempotencyKey: validateIdempotencyKey(operation, opts?.idempotencyKey, false) };
    });
  }

  async #botCall(operation: RecallOperation, prepare: () => PreparedRequest): Promise<RecallBot> {
    return (await this.#call(operation, true, prepare)) as RecallBot;
  }

  /** Validate, send ONCE, map. Returns the parsed Bot when `expectBot`, else undefined. */
  async #call(
    operation: RecallOperation,
    expectBot: boolean,
    prepare: () => PreparedRequest,
  ): Promise<RecallBot | undefined> {
    const started = Date.now();
    let prepared: PreparedRequest;
    try {
      prepared = prepare();
    } catch (error) {
      const refusal = error instanceof RecallError ? error : invalid(operation, 'invalid_request');
      this.#log(operation, 'failure', started, refusal.category);
      throw refusal;
    }
    try {
      const result = await this.#send(operation, prepared, expectBot);
      this.#log(operation, 'success', started, undefined, result.status);
      return result.bot;
    } catch (error) {
      // #send only throws RecallError; anything else is a bug and is reported as a network failure
      // without its (possibly sensitive) message.
      const failure =
        error instanceof RecallError
          ? error
          : new RecallError('network', { operation, retriable: true, retryAfterMs: RECALL_DEFAULT_RETRY_AFTER_MS.network });
      this.#log(operation, 'failure', started, failure.category, failure.httpStatus ?? undefined);
      throw failure;
    }
  }

  async #send(
    operation: RecallOperation,
    prepared: PreparedRequest,
    expectBot: boolean,
  ): Promise<{ status: number; bot: RecallBot | undefined }> {
    const headers: Record<string, string> = { authorization: this.#authorization, accept: 'application/json' };
    if (prepared.body !== undefined) headers['content-type'] = 'application/json';
    if (prepared.idempotencyKey !== undefined) headers['idempotency-key'] = prepared.idempotencyKey;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced against the transport and the body read, so a transport that ignores the abort signal
    // still cannot hold the caller past the deadline.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(abortError());
      }, this.#timeoutMs);
    });
    deadline.catch(() => {});

    const transportFailure = (): RecallError => {
      const category = controller.signal.aborted ? 'timeout' : 'network';
      return new RecallError(category, {
        operation,
        retriable: true,
        retryAfterMs: RECALL_DEFAULT_RETRY_AFTER_MS[category],
      });
    };

    try {
      let response: RecallTransportResponse;
      try {
        const request: RecallTransportRequest = {
          url: this.#baseUrl + prepared.path,
          method: prepared.method,
          headers,
          signal: controller.signal,
        };
        if (prepared.body !== undefined) request.body = prepared.body;
        response = await Promise.race([this.#transport(request), deadline]);
      } catch {
        throw transportFailure();
      }
      const status = typeof response?.status === 'number' ? response.status : 0;

      const declared = safeHeader(response, 'content-length');
      if (declared !== null && /^\d{1,15}$/.test(declared.trim()) && Number(declared.trim()) > this.#maxResponseBytes) {
        controller.abort();
        throw new RecallError('output_limit', { operation, httpStatus: status });
      }
      let raw: string;
      try {
        raw = await Promise.race([response.text(), deadline]);
      } catch {
        throw transportFailure();
      }
      if (typeof raw !== 'string') raw = '';
      if (Buffer.byteLength(raw, 'utf8') > this.#maxResponseBytes) {
        throw new RecallError('output_limit', { operation, httpStatus: status });
      }

      if (status < 200 || status > 299) throw statusError(operation, response, raw);
      if (!expectBot) return { status, bot: undefined };

      const parsed = parseJson(raw);
      if (parsed === undefined) {
        throw new RecallError('malformed_response', { operation, httpStatus: status, code: 'invalid_json' });
      }
      const bot = parseRecallBot(parsed);
      if (bot === null) {
        throw new RecallError('malformed_response', { operation, httpStatus: status, code: 'invalid_bot' });
      }
      return { status, bot };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #log(
    operation: RecallOperation,
    outcome: 'success' | 'failure',
    startedAt: number,
    category?: RecallErrorCategory,
    httpStatus?: number,
  ): void {
    const record: RecallLogRecord = { operation, outcome, durationMs: Math.max(0, Date.now() - startedAt) };
    if (category !== undefined) record.category = category;
    if (httpStatus !== undefined) record.httpStatus = httpStatus;
    try {
      this.#logger.event(record);
    } catch {
      // Logging must never break a request.
    }
  }
}

/** Factory, mirroring `createAshbyClient`. */
export function createRecallClient(config: RecallClientConfig): RecallClient {
  return new RecallClient(config);
}
