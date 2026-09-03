/**
 * fly-machines.ts — typed, injectable, fail-safe Fly Machines API client.
 *
 * PR B (on-demand Fly worker orchestration). This client is the transport the
 * API uses to bring a STOPPED worker machine up on demand (start → wait ready)
 * and to reap it when idle (stop). It is INERT until the orchestration flag
 * (`WORKER_ORCHESTRATION`) is enabled by a caller — constructing it does
 * nothing, and nothing here dispatches a call, mints a room, or reaps a
 * machine on its own.
 *
 * DESIGN (mirrors integrations/ashby/client.ts):
 *   - Fully injectable network seam (`transport`, default global `fetch`), plus
 *     injectable token, base URL, timers, jitter — so tests need no network.
 *   - Bounded per-request timeout via AbortController.
 *   - Bounded retries with exponential backoff + full jitter, honoring a
 *     bounded Retry-After on 429. The retried classes are 429 / 5xx / network /
 *     timeout, and ONLY for idempotent verbs (GET, and the Fly start/stop verbs,
 *     which are idempotent by machine state). Never retries forever.
 *   - Typed errors (`FlyMachinesError`) with a STABLE `code`
 *     ('auth'|'not_found'|'rate_limited'|'server'|'timeout'|'network'|
 *      'invalid_request'|'retry_exhausted'). Provider response bodies are NEVER
 *     placed in logs, errors, or return values (sanitized).
 *   - Fail-CLOSED on a missing token: the client still CONSTRUCTS (so callers
 *     degrade rather than crash at import), but every call short-circuits to a
 *     'auth'-coded error with NO network attempt.
 *
 * SECURITY: the Fly API token, the raw provider response body, and any provider
 * error text are never logged, returned, or serialized. Errors carry only a
 * stable code, an HTTP status number, the operation name, the attempt number,
 * and a retriable flag.
 */

// ── The single allowlisted production origin for the Fly Machines API. ───────
export const FLY_API_BASE_URL = 'https://api.fly.io/v1';

/** Machine lifecycle states the wait endpoint accepts. */
export type FlyMachineState = 'started' | 'stopped' | 'suspended' | 'destroyed';

// ── Bounds ───────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CAP = 6;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 10_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MiB — machine JSON is small
/** The Fly wait endpoint caps its own server-side timeout; we bound the value. */
const MAX_WAIT_TIMEOUT_SEC = 60;
const MAX_ID_LEN = 256;

// ── Error taxonomy ────────────────────────────────────────────────────────────

/** Stable, sanitized error codes. Never carries provider bodies. */
export type FlyMachinesErrorCode =
  | 'auth'             // 401/403, or a missing/blank token (fail closed, no network)
  | 'not_found'        // 404 — machine/app does not exist
  | 'rate_limited'     // 429 — retriable within caps, honors Retry-After
  | 'server'           // 5xx — retriable within caps
  | 'timeout'          // request deadline exceeded (AbortController)
  | 'network'          // connection/DNS/socket failure, or unreadable body
  | 'invalid_request'  // client-side validation (bad app/id/state/args)
  | 'retry_exhausted'; // all bounded attempts exhausted for a transient class

/** Safe identifier for the operation/code fields (no data leakage). */
const SAFE_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface FlyMachinesErrorInit {
  httpStatus?: number | null;
  operation?: string;
  attempt?: number;
  retriable?: boolean;
}

export class FlyMachinesError extends Error {
  public readonly code: FlyMachinesErrorCode;
  public readonly httpStatus: number | null;
  public readonly operation: string;
  public readonly attempt: number;
  public readonly retriable: boolean;

  constructor(code: FlyMachinesErrorCode, init: FlyMachinesErrorInit = {}) {
    // Stable category text only — no dynamic values, no provider body.
    super(`fly_machines_${code}`);
    this.name = 'FlyMachinesError';
    this.code = code;
    this.httpStatus = typeof init.httpStatus === 'number' ? init.httpStatus : null;
    this.operation = SAFE_CODE_RE.test(init.operation ?? '') ? (init.operation as string) : 'unknown';
    this.attempt = Number.isInteger(init.attempt) && (init.attempt as number) >= 0 ? (init.attempt as number) : 0;
    this.retriable = init.retriable === true;
  }

  /** Serialize ONLY sanitized fields — never bodies, tokens, or URLs. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      operation: this.operation,
      attempt: this.attempt,
      retriable: this.retriable,
    };
  }
}

export function isFlyMachinesError(err: unknown): err is FlyMachinesError {
  return err instanceof FlyMachinesError;
}

// ── Injection seams ────────────────────────────────────────────────────────────

export interface FlyTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface FlyTransportResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FlyTransport = (req: FlyTransportRequest) => Promise<FlyTransportResponse>;

/** Metadata-only log record. Contains NO bodies, tokens, URLs, or app/machine ids. */
export interface FlyLogRecord {
  operation: string;
  attempt: number;
  outcome: 'success' | 'retry' | 'failure';
  code?: string;
  httpStatus?: number;
  durationMs: number;
}

export interface FlyMachinesLogger {
  event(record: FlyLogRecord): void;
}

/** Default logger: silent. Production wiring supplies a metadata-only sink. */
const NOOP_LOGGER: FlyMachinesLogger = { event: () => {} };

export interface FlyMachinesClientConfig {
  /**
   * App-scoped Fly deploy token, sent as `Authorization: Bearer <token>`. Never
   * logged. When blank/undefined the client still constructs; every call then
   * fails closed with code 'auth' and makes NO network request.
   */
  token?: string;
  /**
   * Base origin. Defaults to the allowlisted production origin. Any other value
   * is only permitted alongside an injected `transport` (test seam), which
   * replaces the network entirely and never touches production.
   */
  baseUrl?: string;
  /** Test seam: fully replaces the network. Non-production-safe by design. */
  transport?: FlyTransport;
  /** Metadata-only logger. Defaults to a silent no-op. */
  logger?: FlyMachinesLogger;
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

// ── Typed results (fields we name; the rest is preserved as opaque `raw`) ─────

export interface FlyMachine {
  id: string;
  /** e.g. 'started' | 'stopped' | 'starting' | 'stopping' | 'destroyed' | … */
  state: string;
  name?: string;
  region?: string;
  /** The full provider object, preserved verbatim for callers that need more. */
  raw: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function defaultTransport(req: FlyTransportRequest): Promise<FlyTransportResponse> {
  return fetch(req.url, {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
  }) as unknown as Promise<FlyTransportResponse>;
}

function boundedInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return def;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Validate a caller-supplied app slug / machine id. Fail closed on anything unsafe. */
function validatePathSegment(operation: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FlyMachinesError('invalid_request', { operation });
  }
  if (value.length > MAX_ID_LEN) {
    throw new FlyMachinesError('invalid_request', { operation });
  }
  // Fly app slugs are [a-z0-9-]; machine ids are hex. Reject anything with a
  // control char, whitespace, or a URL-structural character so a caller value
  // can never alter the request path/host.
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new FlyMachinesError('invalid_request', { operation });
  }
  return value;
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

function toMachine(operation: string, parsed: unknown): FlyMachine {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FlyMachinesError('network', { operation });
  }
  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : '';
  const state = typeof obj.state === 'string' ? obj.state : '';
  if (id === '' || state === '') {
    throw new FlyMachinesError('network', { operation });
  }
  return {
    id,
    state,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    region: typeof obj.region === 'string' ? obj.region : undefined,
    raw: obj,
  };
}

// ── Client ─────────────────────────────────────────────────────────────────────

export class FlyMachinesClient {
  private readonly token: string;
  private readonly hasToken: boolean;
  private readonly baseUrl: string;
  private readonly transport: FlyTransport;
  private readonly logger: FlyMachinesLogger;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxResponseBytes: number;

  constructor(config: FlyMachinesClientConfig = {}) {
    const injectedTransport = config.transport;
    const baseUrl = config.baseUrl ?? FLY_API_BASE_URL;
    // Production must use the fixed allowlisted origin. A non-allowlisted base
    // URL is only permitted alongside an injected transport (test seam).
    if (baseUrl !== FLY_API_BASE_URL && !injectedTransport) {
      throw new FlyMachinesError('invalid_request', { operation: 'client_init' });
    }

    // A blank token is NOT a construction error: the client must construct so a
    // caller degrades (fails closed with 'auth') rather than crashing at import.
    const token = typeof config.token === 'string' ? config.token : '';
    this.token = token;
    this.hasToken = token.length > 0 && token !== 'replace_me';
    this.baseUrl = baseUrl;
    this.transport = injectedTransport ?? defaultTransport;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.random = config.random ?? Math.random;
    const sleep = config.sleep;
    this.sleep = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = boundedInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxAttempts = boundedInt(config.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_CAP);
    this.backoffBaseMs = boundedInt(config.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, 1, 60_000);
    this.backoffMaxMs = boundedInt(config.backoffMaxMs, DEFAULT_BACKOFF_MAX_MS, this.backoffBaseMs, 120_000);
    this.maxRetryAfterMs = boundedInt(config.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS, 0, 120_000);
    this.maxResponseBytes = boundedInt(
      config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 100 * 1024 * 1024,
    );
  }

  // ── Public surface ──────────────────────────────────────────────────────────

  /** List all machines for an app. GET — retriable. */
  async listMachines(app: string): Promise<FlyMachine[]> {
    const a = validatePathSegment('listMachines', app);
    const parsed = await this.request('listMachines', 'GET', `/apps/${a}/machines`);
    if (!Array.isArray(parsed)) {
      throw new FlyMachinesError('network', { operation: 'listMachines' });
    }
    return parsed.map((m) => toMachine('listMachines', m));
  }

  /** Get one machine by id. GET — retriable. */
  async getMachine(app: string, id: string): Promise<FlyMachine> {
    const a = validatePathSegment('getMachine', app);
    const m = validatePathSegment('getMachine', id);
    const parsed = await this.request('getMachine', 'GET', `/apps/${a}/machines/${m}`);
    return toMachine('getMachine', parsed);
  }

  /**
   * Start a stopped machine. POST — idempotent by machine state (starting an
   * already-started machine is a no-op for Fly), so it is retriable.
   */
  async startMachine(app: string, id: string): Promise<Record<string, unknown>> {
    const a = validatePathSegment('startMachine', app);
    const m = validatePathSegment('startMachine', id);
    const parsed = await this.request('startMachine', 'POST', `/apps/${a}/machines/${m}/start`);
    return asRecord('startMachine', parsed);
  }

  /**
   * Stop a machine. POST — idempotent by machine state (stopping an
   * already-stopped machine is a no-op), so it is retriable. This is the
   * cost-safety verb the reaper drives; it must be robust to a transient blip.
   */
  async stopMachine(app: string, id: string): Promise<Record<string, unknown>> {
    const a = validatePathSegment('stopMachine', app);
    const m = validatePathSegment('stopMachine', id);
    const parsed = await this.request('stopMachine', 'POST', `/apps/${a}/machines/${m}/stop`);
    return asRecord('stopMachine', parsed);
  }

  /**
   * Block until the machine reaches `state`, or the server-side wait times out.
   * GET — retriable. `timeoutSec` is the Fly-side wait budget (bounded to 60);
   * the client's own per-request deadline is separately bounded and is set to
   * comfortably exceed the wait so the transport does not abort a valid long
   * poll. A wait that returns non-2xx (e.g. 408) surfaces as a typed error.
   */
  async waitForState(
    app: string,
    id: string,
    state: FlyMachineState,
    timeoutSec: number,
  ): Promise<Record<string, unknown>> {
    const a = validatePathSegment('waitForState', app);
    const m = validatePathSegment('waitForState', id);
    if (state !== 'started' && state !== 'stopped' && state !== 'suspended' && state !== 'destroyed') {
      throw new FlyMachinesError('invalid_request', { operation: 'waitForState' });
    }
    const waitSec = boundedInt(timeoutSec, MAX_WAIT_TIMEOUT_SEC, 1, MAX_WAIT_TIMEOUT_SEC);
    const query = `?state=${encodeURIComponent(state)}&timeout=${waitSec}`;
    // Give the transport a deadline that outlasts the server-side wait plus slack.
    const requestTimeoutMs = Math.min(waitSec * 1000 + 10_000, MAX_TIMEOUT_MS);
    const parsed = await this.request(
      'waitForState', 'GET', `/apps/${a}/machines/${m}/wait${query}`, requestTimeoutMs,
    );
    return asRecord('waitForState', parsed);
  }

  // ── Core request with bounded retry ─────────────────────────────────────────

  private async request(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    timeoutMsOverride?: number,
  ): Promise<unknown> {
    // Fail CLOSED with no network attempt when no token is configured.
    if (!this.hasToken) {
      this.log(operation, 0, 'failure', Date.now(), 'auth');
      throw new FlyMachinesError('auth', { operation, attempt: 0, retriable: false });
    }
    const url = this.baseUrl + path; // fixed base + validated segments; not caller-controlled
    const timeoutMs = boundedInt(timeoutMsOverride, this.timeoutMs, 1, MAX_TIMEOUT_MS);

    let lastError: FlyMachinesError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const started = Date.now();
      let response: FlyTransportResponse;
      try {
        response = await this.send(url, method, timeoutMs);
      } catch (err) {
        const code: FlyMachinesErrorCode =
          (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network';
        lastError = new FlyMachinesError(code, { operation, attempt, retriable: true });
        this.log(operation, attempt, 'retry', started, code);
        // GET/start/stop/wait are all idempotent → transient send failures retry.
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
        this.log(operation, attempt, 'failure', started, 'network', response.status);
        throw new FlyMachinesError('network', { operation, attempt, httpStatus: response.status });
      }
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        this.log(operation, attempt, 'failure', started, 'network', response.status);
        throw new FlyMachinesError('network', { operation, attempt, httpStatus: response.status });
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 429 || (status >= 500 && status <= 599)) {
          const code: FlyMachinesErrorCode = status === 429 ? 'rate_limited' : 'server';
          lastError = new FlyMachinesError(code, { operation, attempt, httpStatus: status, retriable: true });
          this.log(operation, attempt, 'retry', started, code, status);
          if (attempt < this.maxAttempts) {
            const retryAfter = status === 429
              ? parseRetryAfterMs(response.headers.get('retry-after'), this.maxRetryAfterMs)
              : null;
            await this.sleep(retryAfter ?? this.backoffMs(attempt));
            continue;
          }
          break;
        }
        // Permanent classes — never retried.
        const code: FlyMachinesErrorCode =
          status === 401 || status === 403 ? 'auth'
            : status === 404 ? 'not_found'
              : 'invalid_request';
        this.log(operation, attempt, 'failure', started, code, status);
        throw new FlyMachinesError(code, { operation, attempt, httpStatus: status, retriable: false });
      }

      // 2xx — parse the body. Fly returns JSON; an empty body (204) is valid.
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        this.log(operation, attempt, 'success', started, undefined, response.status);
        return {};
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.log(operation, attempt, 'failure', started, 'network', response.status);
        throw new FlyMachinesError('network', { operation, attempt, httpStatus: response.status });
      }
      this.log(operation, attempt, 'success', started, undefined, response.status);
      return parsed;
    }

    // Exhausted the attempt budget on a transient class.
    throw new FlyMachinesError('retry_exhausted', {
      operation,
      attempt: this.maxAttempts,
      httpStatus: lastError?.httpStatus ?? null,
      retriable: false,
    });
  }

  private async send(
    url: string,
    method: 'GET' | 'POST',
    timeoutMs: number,
  ): Promise<FlyTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.transport({
        url,
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
        },
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
    code?: string,
    httpStatus?: number,
  ): void {
    try {
      this.logger.event({ operation, attempt, outcome, code, httpStatus, durationMs: Math.max(0, Date.now() - startedAt) });
    } catch {
      // Logging must never break a request.
    }
  }
}

/** Narrow an opaque parsed body to a plain record; fail closed otherwise. */
function asRecord(operation: string, parsed: unknown): Record<string, unknown> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FlyMachinesError('network', { operation });
  }
  return parsed as Record<string, unknown>;
}

/** Construct a client from config (mirrors the factory style used elsewhere). */
export function createFlyMachinesClient(config: FlyMachinesClientConfig = {}): FlyMachinesClient {
  return new FlyMachinesClient(config);
}
