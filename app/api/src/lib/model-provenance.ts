// ───────────────────────────────────────────────────────────────────────────
// LLM-06: Non-secret immutable provenance for interview-generation and
// scoring operations.  Defines a strict validated shape with allowlisted
// provider/workload values, safe optional inference parameters, schema
// version, and UTC RFC 3339 timestamp.
//
// Validation rejects unknown fields, control characters, URLs/paths,
// key/token-like values, and oversized strings.  Diagnostics never echo
// the rejected value (use fixed category labels to avoid accidental secret
// disclosure in logs).
//
// validateProvenance() deep-copies and deep-freezes the canonical object.
// It reads only own enumerable string-keyed properties.  Symbol keys,
// prototype-property lookups, and accessor-based getters are rejected.
// The returned data is frozen; the caller cannot mutate stored payload.
// ───────────────────────────────────────────────────────────────────────────

import {
  SCREENING_PROMPT_TEMPLATE_VERSION,
  SCORING_PROMPT_TEMPLATE_VERSION,
} from './prompts.js';

// ── Allowlists ──────────────────────────────────────────────────────────

export const ALLOWLISTED_PROVIDERS = ['anthropic', 'deepseek'] as const;
export type Provider = (typeof ALLOWLISTED_PROVIDERS)[number];

export const ALLOWLISTED_WORKLOADS = ['screening', 'scoring'] as const;
export type Workload = (typeof ALLOWLISTED_WORKLOADS)[number];

// ── Schema version ──────────────────────────────────────────────────────

/** Current provenance schema version.  Must be exactly 1 for validated rows. */
export const MODEL_PROVENANCE_SCHEMA_VERSION = 1;

/** Legacy sentinel uses schema_version = 0. */
export const LEGACY_SCHEMA_VERSION = 0;

// ── Safe inference parameter keys (the only optional params accepted) ──

const SAFE_INFERENCE_KEYS: ReadonlySet<string> = new Set(['temperature', 'max_tokens']);

// ── Validation constants ────────────────────────────────────────────────

const MAX_MODEL_LENGTH = 200;
const MAX_VERSION_LENGTH = 100;
const MAX_TIMESTAMP_LENGTH = 30;
const MAX_TOTAL_JSON_BYTES = 2048; // 2 KB

// ── UTC RFC 3339 regex ─────────────────────────────────────────────────
// Accepts: 2026-07-28T12:00:00Z  or  2026-07-28T12:00:00.000Z
// The millisecond part is optional; trailing Z is mandatory.
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ── Closed identifier grammar ──────────────────────────────────────────
//
// model      = alphanumeric + hyphens, dots, underscores, colons, slashes
//              (slashes for Anthropic model paths like "claude-3-5-sonnet-20241022")
// version    = date-based + patch number (e.g. "2026-07-28.1")
// provider   = fixed closed set (anthropic)
// workload   = fixed closed set (screening, scoring)
//
// These reject: whitespace, control chars, URLs, paths, secrets, email
// addresses, phone numbers, high-entropy payloads, etc.
const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
const VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]{0,98}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

// ── Type definition ─────────────────────────────────────────────────────

export interface InferenceParams {
  temperature?: number;
  max_tokens?: number;
}

/** Validated provenance for current operations (schema_version === 1). */
export interface ModelProvenance {
  schema_version: 1;
  provider: Provider;
  /** The model identifier that was *requested/configured* for this operation.
   *  This is the design-intent model, not a provider-resolved exact value.
   *  The provider may have returned a different actual model; that is not
   *  tracked by provenance. */
  requestedModel: string;
  workload: Workload;
  prompt_template_version: string;
  inference_params?: InferenceParams;
  timestamp: string; // UTC RFC 3339
}

/** Legacy/unknown provenance sentinel (schema_version === 0). */
export interface LegacyProvenance {
  schema_version: 0;
  provider: 'legacy';
  requestedModel: 'unknown';
  workload: 'unknown';
  prompt_template_version: 'legacy';
  timestamp: '1970-01-01T00:00:00Z';
}

// ── Validation result ──────────────────────────────────────────────────

export interface ProvenanceValidationResult {
  valid: boolean;
  /** Human-readable error message (never includes the rejected value). */
  error?: string;
  /** Cleaned/parsed payload — deep-frozen, cannot be mutated (only set when valid). */
  data?: ModelProvenance;
}

// ── Helpers: own plain-object property checks ──────────────────────────

/**
 * Return true iff obj is a plain object (not null, not array, not class instance)
 * with only own enumerable string properties (no symbols, no accessors).
 */
function isPlainProvenanceObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return false; // class instance or custom prototype
  }
  // Reject if any own property is a getter/setter (accessor descriptor)
  for (const key of Object.getOwnPropertyNames(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && (typeof desc.get === 'function' || typeof desc.set === 'function')) {
      return false;
    }
  }
  // Reject if any symbol-keyed property exists
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  return true;
}

/**
 * Deep-copy a validated provenance object: simple JSON-safe values only
 * (string, number, boolean, null, plain object, array).  Returns a frozen
 * copy with no reference aliases to the original.
 */
function deepFreezeCopy<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'boolean' || typeof obj === 'number' || typeof obj === 'string') {
    return obj;
  }
  if (Array.isArray(obj)) {
    const copy = obj.map(deepFreezeCopy);
    Object.freeze(copy);
    return copy as unknown as T;
  }
  if (typeof obj === 'object') {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      // Unknown prototype — treat as scalar (should not happen after validation)
      return obj;
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      copy[key] = deepFreezeCopy((obj as Record<string, unknown>)[key]);
    }
    Object.freeze(copy);
    return copy as unknown as T;
  }
  // function, symbol, bigint — shouldn't reach here post-validation
  return obj;
}

// ── Internal string validators ──────────────────────────────────────────

/** Closed identifier pattern — rejects whitespace, URLs, paths, secrets, etc. */
/** Control characters (including newlines/tabs). */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * A value that looks like a URL or filesystem path.
 * Covers: http/https/ftp/file schemes, leading absolute paths (/usr/...),
 * Windows drive paths (C:\\), UNC paths (\\\\host\\share), parent refs (..),
 * and URL-like userinfo (user:pass@host).
 */
const URL_OR_PATH_RE =
  /(?:https?:\/\/|ftp:\/\/|file:\/\/|[\s(]\/[\w./-]|^\/[\w./-]|\.\.(?:[/\\]|$)|\\(?:\\[\w.-]+)+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})/i;

/**
 * A value that looks like an API key, JWT, private key, token, or
 * high-entropy secret payload.
 */
const TOKEN_LIKE_RE =
  /\b(?:sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/i;

function hasUrlOrPath(value: string): boolean {
  return URL_OR_PATH_RE.test(value);
}

function hasCredential(value: string): boolean {
  return TOKEN_LIKE_RE.test(value);
}

function isValidIdentifier(value: unknown, maxLength: number, label: string, errors: string[]): value is string {
  if (typeof value !== 'string') {
    errors.push(`${label}: must be a string`);
    return false;
  }
  if (value.length === 0) {
    errors.push(`${label}: must not be empty`);
    return false;
  }
  if (value.length > maxLength) {
    errors.push(`${label}: exceeds maximum length`);
    return false;
  }
  if (!IDENTIFIER_RE.test(value)) {
    errors.push(`${label}: contains invalid characters`);
    return false;
  }
  // Defense-in-depth: reject URLs/paths and credential-like patterns
  // that happen to match the closed grammar.
  if (hasUrlOrPath(value)) {
    errors.push(`${label}: must not contain URLs or paths`);
    return false;
  }
  if (hasCredential(value)) {
    errors.push(`${label}: must not contain credentials`);
    return false;
  }
  return true;
}

function isValidVersion(value: unknown, maxLength: number, label: string, errors: string[]): value is string {
  if (typeof value !== 'string') {
    errors.push(`${label}: must be a string`);
    return false;
  }
  if (value.length === 0) {
    errors.push(`${label}: must not be empty`);
    return false;
  }
  if (value.length > maxLength) {
    errors.push(`${label}: exceeds maximum length`);
    return false;
  }
  if (!VERSION_RE.test(value)) {
    errors.push(`${label}: contains invalid characters`);
    return false;
  }
  return true;
}

function isStrictNumber(
  value: unknown,
  label: string,
  errors: string[],
): value is number {
  if (typeof value === 'boolean') {
    errors.push(`${label}: must be a number (got boolean)`);
    return false;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label}: must be a finite number`);
    return false;
  }
  return true;
}

// ── Clock interface ───────────────────────────────────────────────────

export interface ProvenanceClock {
  now(): Date;
  parseDate(iso: string): number; // Date.parse wrapper for testability
}

const defaultClock: ProvenanceClock = {
  now: () => new Date(),
  parseDate: (iso: string) => Date.parse(iso),
};

/**
 * Maximum tolerance in milliseconds for future timestamps.
 * A timestamp up to FUTURE_TOLERANCE_MS ahead of the clock is accepted
 * (to handle minor clock skew between services).
 */
const FUTURE_TOLERANCE_MS = 5_000; // 5 seconds

// ── Public validation function ─────────────────────────────────────────

export function validateProvenance(
  raw: unknown,
  clock: ProvenanceClock = defaultClock,
): ProvenanceValidationResult {
  const errors: string[] = [];

  // ── Must be a non-null, plain object ──────────────────────────────
  if (!isPlainProvenanceObject(raw)) {
    return { valid: false, error: 'provenance: must be a plain non-null object' };
  }

  const record = raw as Record<string, unknown>;

  // ── Reject unknown top-level fields ──────────────────────────────
  const allowedKeys: ReadonlySet<string> = new Set([
    'schema_version',
    'provider',
    'requestedModel',
    'workload',
    'prompt_template_version',
    'inference_params',
    'timestamp',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      // Diagnostics use a fixed category label — never echo the attacker key.
      errors.push(`provenance: unknown field at top level`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }

  // ── schema_version (must be exactly 1) ───────────────────────────
  if (!isStrictNumber(record.schema_version, 'schema_version', errors)) {
    /* errors already pushed */
  } else if (!Number.isInteger(record.schema_version)) {
    errors.push('schema_version: must be an integer');
  } else if (record.schema_version !== MODEL_PROVENANCE_SCHEMA_VERSION) {
    errors.push('schema_version: must be 1');
  }

  // ── provider ──────────────────────────────────────────────────────
  if (!isValidIdentifier(record.provider, MAX_MODEL_LENGTH, 'provider', errors)) {
    /* errors already pushed */
  } else if (
    !(ALLOWLISTED_PROVIDERS as readonly string[]).includes(record.provider as string)
  ) {
    errors.push('provider: not allowlisted');
  }

  // ── requestedModel ────────────────────────────────────────────────
  if (!isValidIdentifier(record.requestedModel, MAX_MODEL_LENGTH, 'requestedModel', errors)) {
    /* errors already pushed */
  }

  // ── workload ──────────────────────────────────────────────────────
  if (!isValidIdentifier(record.workload, MAX_MODEL_LENGTH, 'workload', errors)) {
    /* errors already pushed */
  } else if (
    !(ALLOWLISTED_WORKLOADS as readonly string[]).includes(record.workload as string)
  ) {
    errors.push('workload: not allowlisted');
  }

  // ── prompt_template_version ───────────────────────────────────────
  if (!isValidVersion(
    record.prompt_template_version,
    MAX_VERSION_LENGTH,
    'prompt_template_version',
    errors,
  )) {
    /* errors already pushed */
  }

  // ── inference_params (optional) ───────────────────────────────────
  if (record.inference_params !== undefined && record.inference_params !== null) {
    if (!isPlainProvenanceObject(record.inference_params)) {
      errors.push('inference_params: must be a plain object');
    } else {
      const params = record.inference_params as Record<string, unknown>;
      for (const key of Object.keys(params)) {
        if (!SAFE_INFERENCE_KEYS.has(key)) {
          // Fixed category diagnostic — never echo attacker key.
          errors.push('inference_params: unknown parameter');
        }
      }
      const temp = params.temperature;
      if (temp !== undefined) {
        if (!isStrictNumber(temp, 'inference_params.temperature', errors)) {
          /* errors already pushed */
        } else if (temp < 0 || temp > 2) {
          errors.push('inference_params.temperature: must be between 0 and 2');
        }
      }
      const mt = params.max_tokens;
      if (mt !== undefined) {
        if (!isStrictNumber(mt, 'inference_params.max_tokens', errors)) {
          /* errors already pushed */
        } else if (!Number.isInteger(mt) || mt < 1 || mt > 100_000) {
          errors.push('inference_params.max_tokens: must be an integer between 1 and 100000');
        }
      }
    }
  }

  // ── timestamp (strict UTC RFC 3339) ───────────────────────────────
  const ts = record.timestamp;
  if (typeof ts !== 'string') {
    errors.push('timestamp: must be a string');
  } else if (ts.length === 0) {
    errors.push('timestamp: must not be empty');
  } else if (ts.length > MAX_TIMESTAMP_LENGTH) {
    errors.push('timestamp: exceeds maximum length');
  } else if (!RFC3339_UTC_RE.test(ts)) {
    errors.push('timestamp: must be UTC RFC 3339 (YYYY-MM-DDTHH:mm:ss(.sss)?Z)');
  } else {
    // Validate real calendar date by parsing and round-tripping
    const parsedMs = clock.parseDate(ts);
    if (isNaN(parsedMs)) {
      errors.push('timestamp: not a valid date');
    } else {
      // Round-trip to reject impossible dates (e.g. Feb 31)
      const normalized = ts.replace(/\.\d{1,3}Z$/, 'Z');
      const roundtrip = new Date(parsedMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (roundtrip !== normalized) {
        errors.push('timestamp: not a valid date');
      }
      // Reject timestamps older than epoch (implausibly old)
      if (parsedMs < 0) {
        errors.push('timestamp: must not be before epoch');
      }
      const now = clock.now().getTime();
      if (parsedMs > now + FUTURE_TOLERANCE_MS) {
        errors.push('timestamp: must not be in the future');
      }
    }
  }

  // ── Total size guard ──────────────────────────────────────────────
  if (errors.length === 0) {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_TOTAL_JSON_BYTES) {
      errors.push('provenance: payload exceeds maximum size');
    }
  }

  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }

  // Deep-copy and deep-freeze before returning — caller cannot mutate
  const frozen = deepFreezeCopy(record as unknown as ModelProvenance);
  return {
    valid: true,
    data: frozen,
  };
}

// ── Factory: build a validated provenance object ────────────────────────

export function createProvenance(
  input: {
    provider: Provider;
    requestedModel: string;
    workload: Workload;
    prompt_template_version: string;
    inference_params?: InferenceParams;
    timestamp?: string;
  },
  clock: ProvenanceClock = defaultClock,
): ModelProvenance {
  const payload: Record<string, unknown> = {
    schema_version: MODEL_PROVENANCE_SCHEMA_VERSION,
    provider: input.provider,
    requestedModel: input.requestedModel,
    workload: input.workload,
    prompt_template_version: input.prompt_template_version,
    timestamp: input.timestamp ?? clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  if (input.inference_params && Object.keys(input.inference_params).length > 0) {
    const cleaned: Record<string, unknown> = {};
    if (input.inference_params.temperature !== undefined) {
      cleaned.temperature = input.inference_params.temperature;
    }
    if (input.inference_params.max_tokens !== undefined) {
      cleaned.max_tokens = input.inference_params.max_tokens;
    }
    if (Object.keys(cleaned).length > 0) {
      payload.inference_params = cleaned;
    }
  }

  const result = validateProvenance(payload, clock);
  if (!result.valid || !result.data) {
    throw new Error(`Provenance construction failed: ${result.error}`);
  }
  return result.data;
}

// ── Legacy/unknown provenance sentinel ──────────────────────────────────

export const LEGACY_PROVENANCE: LegacyProvenance = Object.freeze({
  schema_version: 0,
  provider: 'legacy',
  requestedModel: 'unknown',
  workload: 'unknown',
  prompt_template_version: 'legacy',
  timestamp: '1970-01-01T00:00:00Z',
});

// ── Helper: build provenance for a screening session ──────────────────

export function screeningProvenance(
  requestedModel: string,
  clock?: ProvenanceClock,
  provider: Provider = 'deepseek',
): ModelProvenance {
  return createProvenance(
    {
      provider,
      requestedModel,
      workload: 'screening',
      prompt_template_version: SCREENING_PROMPT_TEMPLATE_VERSION,
    },
    clock,
  );
}

// ── Helper: build provenance for a scoring/assessment operation ────────

export function scoringProvenance(
  requestedModel: string,
  clock?: ProvenanceClock,
  provider: Provider = 'deepseek',
): ModelProvenance {
  return createProvenance(
    {
      provider,
      requestedModel,
      workload: 'scoring',
      prompt_template_version: SCORING_PROMPT_TEMPLATE_VERSION,
    },
    clock,
  );
}
