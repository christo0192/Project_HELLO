/**
 * OBS-01: Structured JSON logger.
 *
 * Schema per line: timestamp (UTC ISO-8601 with Z suffix), level, component,
 * event, correlationId, plus an explicit allowlisted set of scalar metadata
 * fields with exact key→type enforcement.
 *
 * Multi-layer value safety:
 *  1. Key allowlist — non-allowlisted keys dropped before JSON serialisation.
 *  2. Envelope field validation — timestamp and correlationId are validated
 *     at runtime; corrupted values fall back to safe defaults.
 *  3. Per-field value validation — each allowlisted string field has a strict
 *     format constraint (fixed enum, identifier regex, or parsed origin).
 *  4. Defense-in-depth scan — rejects JWT, bearer, PEM, email, provider API
 *     keys (OpenAI sk-, GitHub ghp_, Slack xox*, AWS AKIA), high-entropy
 *     tokens (30+ alnum), phone numbers (10+ digits) on ANY string value.
 *  5. Boolean values rejected for all metadata (none are boolean-typed).
 *  6. Numeric fields require finite, field-appropriate values.
 *
 * Injectable clock and writer support deterministic unit tests.
 * Component max length: 64 chars (parity with Python).
 */

import { getCorrelationId } from './correlation.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Stable event name catalogue — extend only with a runbook update. */
export type EventName =
  | 'startup_listen'
  | 'csp_violation'
  | 'error_unhandled'
  | 'scoring_trigger'
  | 'scoring_failed'
  | 'session_complete'
  | 'session_fail'
  | 'db_turn_saved'
  | 'db_error'
  | 'unknown_event';

/** Allowlisted metadata keys and their permitted scalar types. */
export type AllowedMeta = Partial<{
  // CSP report fields (string)
  shape: string;
  document_origin: string;
  violated_directive: string;
  effective_directive: string;
  blocked_origin: string;
  // Error classification (string)
  error_category: string;
  error_type: string;
  // HTTP (string / number)
  method: string;
  status: number;
  http_status: number;
  // Startup identifiers (string / number)
  port: number;
  model: string;
  schema: string;
  // Session / persistence (string / number)
  turn_index: number;
  speaker: string;
  duration_sec: number;
}>;

// ── Key→type maps ────────────────────────────────────────────────────────────

/** Keys whose runtime value must be a string. */
const KEY_TYPE_STRING = new Set<string>([
  'shape', 'document_origin', 'violated_directive', 'effective_directive',
  'blocked_origin', 'error_category', 'error_type', 'method', 'model',
  'schema', 'speaker',
]);

/** Keys whose runtime value must be a number. */
const KEY_TYPE_NUMBER = new Set<string>([
  'status', 'http_status', 'port', 'turn_index', 'duration_sec',
]);

/** Union: all allowlisted metadata keys. */
const ALLOWED_KEYS = new Set<string>([
  ...KEY_TYPE_STRING, ...KEY_TYPE_NUMBER,
]);

/** Runtime level set for defense against callers bypassing TS types. */
const LEVEL_SET = new Set<string>(['debug', 'info', 'warn', 'error']);

/** Runtime event catalogue — must mirror Python _ALLOWED_EVENTS exactly. */
export const EVENT_NAMES_SET = new Set<string>([
  'startup_listen', 'csp_violation', 'error_unhandled',
  'scoring_trigger', 'scoring_failed', 'session_complete',
  'session_fail', 'db_turn_saved', 'db_error',
  'unknown_event',
]);

// ── Per-field value constraints ──────────────────────────────────────────────

/** Fixed-value string fields. */
const SPEAKER_ALLOWED = new Set(['bot', 'candidate']);
const SHAPE_ALLOWED   = new Set(['legacy', 'reporting-api']);
const HTTP_METHODS    = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE', 'CONNECT']);

/**
 * Safe identifier: alphanumeric, underscore, colon, dot, hyphen; max 64 chars.
 * Parity with Python _SAFE_IDENT_RE.
 */
const SAFE_IDENT_RE = /^[a-zA-Z0-9_:.\-]{1,64}$/;

/** CSP directive name: lowercase alphanumeric and hyphens only. */
const CSP_DIRECTIVE_RE = /^[a-zA-Z0-9\-]{1,128}$/;

/**
 * Strict UTC timestamp pattern for extraction (not validation alone).
 * Calendar validation is done by parseCanonicalUtc after extraction.
 */
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

/** UUID v4 canonical pattern. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Robust value-defense patterns checked against EVERY allowlisted string
 * value.  If any matches, the field is dropped entirely (never a partial
 * fragment).
 */
const DEFENSE_RE = new RegExp(
  // JWT header
  'eyJ[A-Za-z0-9_-]{4,}'
  // Bearer token
  + '|bearer\\s+\\S{8,}'
  // PEM key header
  + '|-{5}BEGIN\\s'
  // Email address
  + '|[A-Za-z0-9._%+\\-]{2,}@[A-Za-z0-9.\\-]+\\.[a-z]{2,}'
  // 10+ consecutive digits (phone, credit card, national ID, etc.)
  + '|\\d{10,}'
  // OpenAI / Anthropic API keys
  + '|sk-[A-Za-z0-9]{20,}'
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  + '|gh[psuoar]_[A-Za-z0-9]{16,}'
  // Slack tokens
  + '|xox[bpsa]-[A-Za-z0-9-]{8,}'
  // AWS Access Key ID
  + '|AKIA[A-Z0-9]{16}'
  // Generic high-entropy token: 30+ alphanumeric chars in a row
  + '|[A-Za-z0-9]{30,}'
  // Path-like patterns that could indicate file system leakage
  + '|\\/[A-Za-z0-9_\\-\\.]{2,}(?:\\/[A-Za-z0-9_\\-\\.]+)+',
  'i',
);

type ScalarValue = string | number | boolean | null;

export interface LoggerDeps {
  /** Override wall-clock source for deterministic tests. */
  clock?: () => string;
  /** Override the output sink for all log levels (replaces level routing). */
  writer?: (line: string) => void;
  /** Override the correlation ID source (defaults to AsyncLocalStorage getter). */
  correlationIdGetter?: () => string | null;
}

/**
 * Sanitise a string value: truncate at the first control character, then
 * cap at 512 characters.
 *
 * Returns empty string if the original contained a control character,
 * because emitting a partial fragment after truncation could leak
 * a secret that was appended after the control char.
 */
function sanitiseStr(val: string): string {
  for (let i = 0; i < val.length; i++) {
    const c = val.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      // Truncation detected — drop the entire field to avoid
      // emitting a partial fragment of a potentially sensitive value.
      return '';
    }
  }
  return val.length > 512 ? val.slice(0, 512) : val;
}

/**
 * Validate and sanitise a string metadata value for a specific field.
 * Returns the (possibly sanitised) value on acceptance, or null to drop
 * the field entirely. A null return means the caller must NOT emit the field.
 *
 * Sanitisation (control-char truncation) happens FIRST, then defense
 * scanning, then per-field format validation.
 */
function validateStringField(key: string, raw: string): string | null {
  // 1. Sanitise first: strip control characters
  const sanitised = sanitiseStr(raw);
  if (sanitised.length === 0) return null;

  // 2. Defense scan on the sanitised value
  if (DEFENSE_RE.test(sanitised)) return null;

  // 3. Per-field format validation
  switch (key) {
    case 'speaker':
      return SPEAKER_ALLOWED.has(sanitised) ? sanitised : null;
    case 'shape':
      return SHAPE_ALLOWED.has(sanitised) ? sanitised : null;
    case 'method': {
      const up = sanitised.toUpperCase();
      return HTTP_METHODS.has(up) ? up : null;
    }
    case 'document_origin':
    case 'blocked_origin':
      return validateOrigin(sanitised);
    case 'violated_directive':
    case 'effective_directive':
      return CSP_DIRECTIVE_RE.test(sanitised) ? sanitised : null;
    case 'error_category':
    case 'error_type':
    case 'model':
    case 'schema':
      return SAFE_IDENT_RE.test(sanitised) ? sanitised : null;
    default:
      return sanitised;
  }
}

/**
 * Validate a URL origin: http(s), no credentials/path/query/fragment.
 * Returns the canonical origin string or null.
 */
function validateOrigin(val: string): string | null {
  try {
    const url = new URL(val);
    // Must be http or https
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Must not have credentials
    if (url.username || url.password) return null;
    // Must not have path, query, or fragment
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (url.search) return null;
    if (url.hash) return null;
    // Require exact canonical origin per URL Standard.
    // Rejects default-port aliases (https://x:443 → origin = https://x),
    // trailing-slash mismatches, and any input that URL normalises away
    // (the original security bug: https://example.com/path?token=secret
    // parsed as origin https://example.com, leaking the path).
    if (url.origin !== val) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Validate a numeric metadata value for a specific field.
 * Returns the value on acceptance, or null to drop the field.
 */
function validateNumericField(key: string, val: number): number | null {
  if (!Number.isFinite(val)) return null;
  switch (key) {
    case 'port':
      return Number.isInteger(val) && val >= 1 && val <= 65535 ? val : null;
    case 'status':
    case 'http_status':
      return Number.isInteger(val) && val >= 100 && val <= 599 ? val : null;
    case 'turn_index':
      return Number.isInteger(val) && val >= 0 ? val : null;
    case 'duration_sec':
      return val >= 0 && val <= 1_000_000 ? val : null;
    default:
      return val;
  }
}

/** Deterministic safe fallback for invalid/envelope-clock output. */
const FIXED_EPOCH = '1970-01-01T00:00:00.000Z';

/** Days in month for non-leap and leap years. */
function _daysInMonth(yyyy: number, mm: number): number {
  const NORM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mm === 2 && (yyyy % 4 === 0 && (yyyy % 100 !== 0 || yyyy % 400 === 0))) return 29;
  return NORM[mm - 1];
}

/**
 * Parse, calendar-validate, and re-serialize a UTC ISO-8601 timestamp.
 *
 * Returns the canonical Z-suffixed string on success, or FIXED_EPOCH
 * when the value is missing, non-string, structurally invalid, or
 * contains impossible date components (e.g., month=99, day=30 in Feb).
 * Non-string / object clock output is caught and never calls toString().
 *
 * Uses deterministic FIXED_EPOCH rather than `new Date().toISOString()`
 * so that tests with injected corrupt clocks produce repeatable output.
 */
function validateTimestamp(val: unknown): string {
  if (typeof val !== 'string') return FIXED_EPOCH;

  const m = TIMESTAMP_RE.exec(val);
  if (!m) return FIXED_EPOCH;

  const yyyy = Number(m[1]);
  const mm   = Number(m[2]);
  const dd   = Number(m[3]);
  const hh   = Number(m[4]);
  const min  = Number(m[5]);
  const sec  = Number(m[6]);
  const frac = m[7] ? m[7].slice(0, 9) : '';

  // Component range checks
  if (yyyy < 1970 || yyyy > 2100) return FIXED_EPOCH;
  if (mm < 1 || mm > 12) return FIXED_EPOCH;
  if (dd < 1 || dd > _daysInMonth(yyyy, mm)) return FIXED_EPOCH;
  if (hh > 23) return FIXED_EPOCH;
  if (min > 59) return FIXED_EPOCH;
  if (sec > 59) return FIXED_EPOCH;

  // Re-serialize to canonical Z form (preserve ms precision if present)
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const y = `${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(min)}:${pad(sec)}`;
  return frac ? `${y}.${frac.padEnd(3, '0')}Z` : `${y}.000Z`;
}

/** Validate correlation ID envelope: must be UUID v4 or null. */
function validateCorrelationEnvelope(val: string | null): string | null {
  if (val === null) return null;
  if (UUID_V4_RE.test(val)) return val.toLowerCase();
  return null;
}

function defaultWrite(level: LogLevel, line: string): void {
  if (level === 'warn') { console.warn(line); return; }
  if (level === 'error') { console.error(line); return; }
  process.stdout.write(line + '\n');
}

/**
 * Create a component-scoped structured logger.
 *
 * @param component  Safe identifier for the source component (max 64 chars).
 * @param deps       Optional overrides for clock, writer, and correlationId getter.
 */
export function createLogger(component: string, deps: LoggerDeps = {}) {
  // Defense-scan component too: if it contains secrets/high-entropy tokens,
  // drop to 'unknown' (parity with Python).
  const safeComponent = SAFE_IDENT_RE.test(component) && !DEFENSE_RE.test(component) ? component : 'unknown';
  const clock = deps.clock ?? (() => new Date().toISOString());
  const getCorrelation = deps.correlationIdGetter ?? getCorrelationId;

  function emit(level: LogLevel, event: EventName, meta?: AllowedMeta): void {
    // Match Python behavior: unknown level rewrites to 'info' (not silently dropped).
    if (!LEVEL_SET.has(level)) level = 'info' as LogLevel;
    const safeEvent: string = EVENT_NAMES_SET.has(event) ? event : 'unknown_event';

    // Validate envelope fields at runtime; fall back to safe values.
    // Validate every envelope dependency BEFORE regex dispatch:
    // a malformed clock (non-string, object with __str__) is caught by
    // validateTimestamp which never calls toString() on it.
    let rawTs: unknown;
    let rawCid: string | null;
    try {
      rawTs = clock();
    } catch {
      rawTs = undefined;
    }
    try {
      rawCid = getCorrelation();
    } catch {
      rawCid = null;
    }

    const entry: Record<string, ScalarValue> = {
      timestamp: validateTimestamp(rawTs),
      level,
      component: safeComponent,
      event: safeEvent,
      correlationId: validateCorrelationEnvelope(rawCid),
    };

    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (!ALLOWED_KEYS.has(k)) continue;
        if (v === undefined || v === null) continue;

        // Reject boolean — no boolean metadata fields exist.
        if (typeof v === 'boolean') continue;

        if (typeof v === 'string') {
          // Only accept string-typed keys
          if (!KEY_TYPE_STRING.has(k)) continue;
          const safe = validateStringField(k, v);
          if (safe !== null) entry[k] = safe;
        } else if (typeof v === 'number') {
          // Only accept number-typed keys
          if (!KEY_TYPE_NUMBER.has(k)) continue;
          const safe = validateNumericField(k, v);
          if (safe !== null) entry[k] = safe;
        }
        // non-scalar (object, array, etc.) → silently dropped
      }
    }

    // Serialise safely: catch TypeError so malformed injected
    // clock/context/meta does not crash the request/job.
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      // Last-resort fallback: emit minimal entry without bad values
      line = JSON.stringify({
        timestamp: validateTimestamp(rawTs),
        level,
        component: safeComponent,
        event: safeEvent,
        correlationId: validateCorrelationEnvelope(rawCid),
      });
    }
    if (deps.writer) {
      deps.writer(line);
    } else {
      defaultWrite(level, line);
    }
  }

  return {
    debug: (event: EventName, meta?: AllowedMeta) => emit('debug', event, meta),
    info:  (event: EventName, meta?: AllowedMeta) => emit('info',  event, meta),
    warn:  (event: EventName, meta?: AllowedMeta) => emit('warn',  event, meta),
    error: (event: EventName, meta?: AllowedMeta) => emit('error', event, meta),
  };
}
