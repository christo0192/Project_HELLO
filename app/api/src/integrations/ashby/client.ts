/**
 * ashby/client.ts — typed, injectable Ashby API client foundation.
 *
 * OUTBOUND BOUNDARY. This client is NOT wired to any production route, queue,
 * or worker. It exists so a later tenant-probe/integration step has a hardened
 * transport with: fixed allowlisted HTTPS origin, HTTP Basic auth (API key as
 * username, empty password), envelope parsing (HTTP 200 + success:false is a
 * typed failure), bounded timeout + bounded retries with exponential backoff +
 * jitter honoring a bounded Retry-After, safe-class-only retries (mutations
 * fail closed under ambiguous failure), cursor pagination with page/item caps
 * and loop detection, and metadata-only logging.
 *
 * SECURITY: the API key, request/response bodies, candidate/contact data, file
 * handles/URLs, sync tokens, and feedback content are NEVER logged, returned in
 * errors, serialized, or placed in the URL/query. No caller-controlled arbitrary
 * request URL exists in production — the base origin is fixed/allowlisted and
 * paths come from a fixed operation registry. Injecting a test transport fully
 * replaces the network and is the only way to target a non-production endpoint.
 */

import { AshbyError, sanitizeCodes } from './errors.js';
import {
  ASHBY_OPERATIONS,
  type AshbyOperation,
  type AshbyEnvelope,
  type AshbyResult,
  type ApplicationListParams,
  type FeedbackSubmitRequest,
  type FeedbackRequestCreateRequest,
  type OpaqueRecord,
  type PaginatedList,
} from './types.js';

/** The single allowlisted production origin for the Ashby API. */
export const ASHBY_API_BASE_URL = 'https://api.ashbyhq.com';

// ── Bounds ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CAP = 6;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 10_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_REQUEST_BODY_BYTES = 256 * 1024;          // 256 KiB
const MAX_ID_LEN = 256;
const DEFAULT_PAGE_CAP = 100;                        // Ashby forces full-sync ~100 pages
const DEFAULT_ITEM_CAP = 10_000;

// ── Injection seams ─────────────────────────────────────────────────────────

export interface AshbyTransportRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface AshbyTransportResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type AshbyTransport = (req: AshbyTransportRequest) => Promise<AshbyTransportResponse>;

/** Metadata-only log record. Contains NO bodies, ids, tokens, or credentials. */
export interface AshbyLogRecord {
  operation: string;
  attempt: number;
  outcome: 'success' | 'retry' | 'failure';
  category?: string;
  httpStatus?: number;
  durationMs: number;
}

export interface AshbyClientLogger {
  event(record: AshbyLogRecord): void;
}

/** Default logger: silent. Production wiring supplies a metadata-only sink. */
const NOOP_LOGGER: AshbyClientLogger = { event: () => {} };

export interface AshbyClientConfig {
  /** API key used as the HTTP Basic username (empty password). Never logged. */
  apiKey: string;
  /**
   * Base origin. Defaults to the allowlisted production origin. Any other value
   * is rejected UNLESS a test `transport` is injected (which replaces the
   * network entirely and never touches production).
   */
  baseUrl?: string;
  /** Test seam: fully replaces the network. Non-production-safe by design. */
  transport?: AshbyTransport;
  /** Metadata-only logger. Defaults to a silent no-op. */
  logger?: AshbyClientLogger;
  /** Jitter source in [0,1). Defaults to Math.random; inject for determinism. */
  random?: () => number;
  /** Sleep seam for backoff. Defaults to a real timer; inject to avoid waiting. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxRetryAfterMs?: number;
  maxResponseBytes?: number;
}

export interface RequestOptions {
  /**
   * Only meaningful for mutations: assert the caller has an idempotency /
   * read-before-write strategy, permitting retry of ambiguous transient
   * failures. Defaults to false (mutations fail closed).
   */
  idempotent?: boolean;
}

function defaultTransport(req: AshbyTransportRequest): Promise<AshbyTransportResponse> {
  return fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: req.signal,
  }) as unknown as Promise<AshbyTransportResponse>;
}

function boundedInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return def;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Validate a caller-supplied id/handle string. Fail closed on anything unsafe. */
function validateId(operation: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AshbyError('invalid_request', { code: 'invalid_id', operation });
  }
  if (value.length > MAX_ID_LEN) {
    throw new AshbyError('invalid_request', { code: 'id_too_long', operation });
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      throw new AshbyError('invalid_request', { code: 'id_control_char', operation });
    }
  }
  void field;
  return value;
}

/** A plain-object request body within the size bound; fail closed otherwise. */
function validateBody(operation: string, body: OpaqueRecord): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AshbyError('invalid_request', { code: 'invalid_body', operation });
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new AshbyError('invalid_request', { code: 'unserializable_body', operation });
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new AshbyError('invalid_request', { code: 'body_too_large', operation });
  }
  return serialized;
}

/** Parse a bounded Retry-After header (delta-seconds only) into ms, or null. */
function parseRetryAfterMs(raw: string | null, capMs: number): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null; // only bounded delta-seconds; ignore HTTP-dates
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, capMs);
}

export class AshbyClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly transport: AshbyTransport;
  private readonly logger: AshbyClientLogger;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxResponseBytes: number;

  constructor(config: AshbyClientConfig) {
    if (typeof config?.apiKey !== 'string' || config.apiKey.length === 0) {
      throw new AshbyError('invalid_request', { code: 'missing_api_key', operation: 'client_init' });
    }
    const injectedTransport = config.transport;
    const baseUrl = config.baseUrl ?? ASHBY_API_BASE_URL;
    // Production must use the fixed allowlisted origin. A non-allowlisted base
    // URL is only permitted alongside an injected transport (test seam).
    if (baseUrl !== ASHBY_API_BASE_URL && !injectedTransport) {
      throw new AshbyError('invalid_request', { code: 'base_url_not_allowlisted', operation: 'client_init' });
    }

    // HTTP Basic: API key as username, empty password. Computed once; the raw
    // key is never stored as a field and never logged.
    this.authHeader = 'Basic ' + Buffer.from(`${config.apiKey}:`, 'utf8').toString('base64');
    this.baseUrl = baseUrl;
    this.transport = injectedTransport ?? defaultTransport;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.random = config.random ?? Math.random;
    const timers = config.sleep;
    this.sleep = timers ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = boundedInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxAttempts = boundedInt(config.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_CAP);
    this.backoffBaseMs = boundedInt(config.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, 1, 60_000);
    this.backoffMaxMs = boundedInt(config.backoffMaxMs, DEFAULT_BACKOFF_MAX_MS, this.backoffBaseMs, 120_000);
    this.maxRetryAfterMs = boundedInt(config.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS, 0, 120_000);
    this.maxResponseBytes = boundedInt(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 100 * 1024 * 1024);
  }

  // ── Core request with envelope parsing + bounded retry ────────────────────

  /**
   * Execute one Ashby operation. Reads retry safe classes (429, 5xx, network,
   * timeout) within the attempt cap; mutations do NOT retry ambiguous failures
   * unless `options.idempotent` is set. Returns the typed success result or
   * throws a sanitized {@link AshbyError}.
   */
  async request<T = unknown>(
    operation: AshbyOperation,
    body: OpaqueRecord,
    options: RequestOptions = {},
  ): Promise<AshbyResult<T>> {
    const spec = ASHBY_OPERATIONS[operation];
    if (!spec) throw new AshbyError('invalid_request', { code: 'unknown_operation', operation });
    const serializedBody = validateBody(operation, body);
    const url = this.baseUrl + spec.path; // fixed path; not caller-controlled
    const retryAmbiguous = !spec.mutation || options.idempotent === true;

    let lastError: AshbyError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const started = Date.now();
      let response: AshbyTransportResponse;
      try {
        response = await this.send(url, serializedBody, this.timeoutMs);
      } catch (err) {
        const category = (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network';
        lastError = new AshbyError(category, { operation, attempt, retriable: true });
        this.log(operation, attempt, 'retry', started, category);
        // A send-phase failure is ambiguous for mutations → fail closed.
        if (!retryAmbiguous) {
          this.log(operation, attempt, 'failure', started, category);
          throw new AshbyError(category, { operation, attempt, retriable: false });
        }
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        break;
      }

      // Read the body with a byte cap.
      let raw: string;
      try {
        raw = await response.text();
      } catch {
        lastError = new AshbyError('network', { operation, attempt, httpStatus: response.status });
        this.log(operation, attempt, 'failure', started, 'network', response.status);
        throw lastError;
      }
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        this.log(operation, attempt, 'failure', started, 'output_limit', response.status);
        throw new AshbyError('output_limit', { operation, attempt, httpStatus: response.status });
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 429 || (status >= 500 && status <= 599)) {
          const category = status === 429 ? 'rate_limited' : 'http_server_error';
          lastError = new AshbyError(category, { operation, attempt, httpStatus: status, retriable: true });
          this.log(operation, attempt, 'retry', started, category, status);
          if (attempt < this.maxAttempts) {
            const retryAfter = status === 429
              ? parseRetryAfterMs(response.headers.get('retry-after'), this.maxRetryAfterMs)
              : null;
            await this.sleep(retryAfter ?? this.backoffMs(attempt));
            continue;
          }
          break;
        }
        // Permanent 4xx (401/403/404/405/410/…): never retried.
        this.log(operation, attempt, 'failure', started, 'http_client_error', status);
        throw new AshbyError('http_client_error', { operation, attempt, httpStatus: status, retriable: false });
      }

      // 2xx — parse and validate the envelope.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.log(operation, attempt, 'failure', started, 'malformed_response', response.status);
        throw new AshbyError('malformed_response', { operation, attempt, httpStatus: response.status, code: 'invalid_json' });
      }
      if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { success?: unknown }).success !== 'boolean') {
        this.log(operation, attempt, 'failure', started, 'malformed_response', response.status);
        throw new AshbyError('malformed_response', { operation, attempt, httpStatus: response.status, code: 'invalid_envelope' });
      }
      const envelope = parsed as AshbyEnvelope<T>;
      if (envelope.success === false) {
        const endpointCodes = extractEndpointCodes(envelope);
        this.log(operation, attempt, 'failure', started, 'logical_failure', response.status);
        throw new AshbyError('logical_failure', { operation, attempt, httpStatus: response.status, retriable: false, endpointCodes });
      }

      this.log(operation, attempt, 'success', started, undefined, response.status);
      return {
        results: envelope.results as T,
        moreDataAvailable: envelope.moreDataAvailable === true,
        nextCursor: typeof envelope.nextCursor === 'string' ? envelope.nextCursor : undefined,
        syncToken: typeof envelope.syncToken === 'string' ? envelope.syncToken : undefined,
      };
    }

    // Exhausted the attempt budget on a transient class.
    throw new AshbyError('retry_exhausted', {
      operation,
      attempt: this.maxAttempts,
      httpStatus: lastError?.httpStatus ?? null,
      code: lastError?.category ?? 'retry_exhausted',
      retriable: false,
    });
  }

  private async send(url: string, body: string, timeoutMs: number): Promise<AshbyTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.transport({
        url,
        method: 'POST',
        headers: {
          authorization: this.authHeader,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exponential backoff with full jitter, bounded by backoffMaxMs. */
  private backoffMs(attempt: number): number {
    const exp = Math.min(this.backoffBaseMs * Math.pow(2, attempt - 1), this.backoffMaxMs);
    const jitter = 0.5 + this.random() * 0.5; // [0.5, 1.0)
    return Math.round(exp * jitter);
  }

  private log(
    operation: string,
    attempt: number,
    outcome: 'success' | 'retry' | 'failure',
    startedAt: number,
    category?: string,
    httpStatus?: number,
  ): void {
    try {
      this.logger.event({ operation, attempt, outcome, category, httpStatus, durationMs: Math.max(0, Date.now() - startedAt) });
    } catch {
      // Logging must never break a request.
    }
  }

  // ── Typed endpoint helpers (verified fields named; rest via `extra`) ──────

  async applicationInfo<T = OpaqueRecord>(applicationId: string, extra?: OpaqueRecord): Promise<AshbyResult<T>> {
    validateId('application.info', 'applicationId', applicationId);
    return this.request<T>('application.info', { applicationId, ...(extra ?? {}) });
  }

  async applicationList<T = OpaqueRecord[]>(params: ApplicationListParams = {}): Promise<AshbyResult<T>> {
    const body: OpaqueRecord = { ...(params.extra ?? {}) };
    if (params.cursor !== undefined) body.cursor = validateId('application.list', 'cursor', params.cursor);
    if (params.syncToken !== undefined) body.syncToken = validateId('application.list', 'syncToken', params.syncToken);
    if (params.limit !== undefined) {
      const limit = boundedInt(params.limit, 0, 1, 500);
      if (limit === 0) throw new AshbyError('invalid_request', { code: 'invalid_limit', operation: 'application.list' });
      body.limit = limit;
    }
    return this.request<T>('application.list', body);
  }

  async candidateInfo<T = OpaqueRecord>(candidateId: string, extra?: OpaqueRecord): Promise<AshbyResult<T>> {
    validateId('candidate.info', 'candidateId', candidateId);
    return this.request<T>('candidate.info', { candidateId, ...(extra ?? {}) });
  }

  /**
   * Return file metadata/URL only. This client NEVER fetches the presigned URL;
   * SSRF-controlled downloads are a separate, later concern.
   */
  async fileInfo<T = OpaqueRecord>(fileHandle: string, extra?: OpaqueRecord): Promise<AshbyResult<T>> {
    validateId('file.info', 'fileHandle', fileHandle);
    return this.request<T>('file.info', { fileHandle, ...(extra ?? {}) });
  }

  async jobInterviewPlanInfo<T = OpaqueRecord>(jobId: string, extra?: OpaqueRecord): Promise<AshbyResult<T>> {
    validateId('jobInterviewPlan.info', 'jobId', jobId);
    return this.request<T>('jobInterviewPlan.info', { jobId, ...(extra ?? {}) });
  }

  async applicationFeedbackList<T = OpaqueRecord>(applicationId: string, extra?: OpaqueRecord): Promise<AshbyResult<T>> {
    validateId('applicationFeedback.list', 'applicationId', applicationId);
    return this.request<T>('applicationFeedback.list', { applicationId, ...(extra ?? {}) });
  }

  async applicationFeedbackRequestCreate<T = OpaqueRecord>(req: FeedbackRequestCreateRequest): Promise<AshbyResult<T>> {
    validateId('applicationFeedbackRequest.create', 'applicationId', req.applicationId);
    const body: OpaqueRecord = { applicationId: req.applicationId, ...(req.extra ?? {}) };
    if (req.userId !== undefined) body.userId = validateId('applicationFeedbackRequest.create', 'userId', req.userId);
    if (req.interviewId !== undefined) body.interviewId = validateId('applicationFeedbackRequest.create', 'interviewId', req.interviewId);
    // Mutation: not retried on ambiguous failure by default.
    return this.request<T>('applicationFeedbackRequest.create', body);
  }

  async applicationFeedbackSubmit<T = OpaqueRecord>(req: FeedbackSubmitRequest): Promise<AshbyResult<T>> {
    validateId('applicationFeedback.submit', 'applicationId', req.applicationId);
    validateId('applicationFeedback.submit', 'formDefinitionId', req.formDefinitionId);
    if (req.feedbackForm === null || typeof req.feedbackForm !== 'object' || Array.isArray(req.feedbackForm)) {
      throw new AshbyError('invalid_request', { code: 'invalid_feedback_form', operation: 'applicationFeedback.submit' });
    }
    const body: OpaqueRecord = {
      applicationId: req.applicationId,
      formDefinitionId: req.formDefinitionId,
      feedbackForm: req.feedbackForm,
      ...(req.extra ?? {}),
    };
    if (req.userId !== undefined) body.userId = validateId('applicationFeedback.submit', 'userId', req.userId);
    if (req.interviewEventId !== undefined) body.interviewEventId = validateId('applicationFeedback.submit', 'interviewEventId', req.interviewEventId);
    // Mutation: not retried on ambiguous failure by default.
    return this.request<T>('applicationFeedback.submit', body);
  }

  async applicationChangeStage<T = OpaqueRecord>(applicationId: string, interviewStageId: string, extra?: OpaqueRecord): Promise<AshbyResult<T>> {
    validateId('application.changeStage', 'applicationId', applicationId);
    validateId('application.changeStage', 'interviewStageId', interviewStageId);
    // Mutation: not retried on ambiguous failure by default.
    return this.request<T>('application.changeStage', { applicationId, interviewStageId, ...(extra ?? {}) });
  }

  // ── Cursor pagination helper (page/item caps + loop detection) ────────────

  /**
   * Iterate `application.list` pages until exhausted or a cap is hit. Detects a
   * repeated cursor (loop) and fails closed. The opaque sync token from the
   * final page is surfaced (never logged) so a caller can persist it.
   */
  async listAllApplications<T = OpaqueRecord>(
    params: ApplicationListParams = {},
    caps: { maxPages?: number; maxItems?: number } = {},
  ): Promise<PaginatedList<T>> {
    const maxPages = boundedInt(caps.maxPages, DEFAULT_PAGE_CAP, 1, 1000);
    const maxItems = boundedInt(caps.maxItems, DEFAULT_ITEM_CAP, 1, 1_000_000);
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor = params.cursor;
    let syncToken: string | undefined = params.syncToken;
    let pagesFetched = 0;

    for (;;) {
      if (pagesFetched >= maxPages) {
        throw new AshbyError('invalid_request', { code: 'page_cap_exceeded', operation: 'application.list' });
      }
      const page = await this.applicationList<T[]>({ ...params, cursor, syncToken });
      pagesFetched += 1;

      const pageItems = Array.isArray(page.results) ? page.results : [];
      for (const it of pageItems) {
        items.push(it as T);
        if (items.length > maxItems) {
          throw new AshbyError('invalid_request', { code: 'item_cap_exceeded', operation: 'application.list' });
        }
      }
      if (page.syncToken !== undefined) syncToken = page.syncToken;

      if (!page.moreDataAvailable || !page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) {
        throw new AshbyError('invalid_request', { code: 'cursor_loop_detected', operation: 'application.list' });
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return { items, pagesFetched, syncToken };
  }
}

/**
 * Extract bounded, sanitized endpoint error codes from a failure envelope.
 * Only `code`/`errorCode` string fields that match the safe-identifier pattern
 * survive — messages and any other data are dropped.
 */
function extractEndpointCodes(envelope: AshbyEnvelope<unknown>): string[] {
  const raw: unknown[] = [];
  const errs = (envelope as { errors?: unknown }).errors;
  if (Array.isArray(errs)) {
    for (const e of errs) {
      if (e && typeof e === 'object') {
        const code = (e as Record<string, unknown>).code ?? (e as Record<string, unknown>).errorCode;
        if (typeof code === 'string') raw.push(code);
      } else if (typeof e === 'string') {
        raw.push(e);
      }
    }
  }
  const info = (envelope as { errorInfo?: unknown }).errorInfo;
  if (info && typeof info === 'object') {
    const code = (info as Record<string, unknown>).code ?? (info as Record<string, unknown>).errorCode;
    if (typeof code === 'string') raw.push(code);
  }
  return sanitizeCodes(raw);
}

/** Construct a client from config (mirrors the factory style used elsewhere). */
export function createAshbyClient(config: AshbyClientConfig): AshbyClient {
  return new AshbyClient(config);
}
