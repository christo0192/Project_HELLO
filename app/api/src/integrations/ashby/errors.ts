/**
 * Ashby client — stable, sanitized error taxonomy.
 *
 * SECURITY: an AshbyError never carries the API key, request/response bodies,
 * candidate/contact data, file handles/URLs, sync tokens, or feedback content.
 * It holds only a stable category/code, an HTTP status number, the operation
 * name, the attempt number, a retriable flag, and (optionally) a bounded list
 * of sanitized safe-identifier endpoint error codes. `message` is a stable
 * category string with no dynamic values, and `toJSON()` serializes only the
 * sanitized fields.
 */

/** Stable, sanitized error categories. */
export type AshbyErrorCategory =
  | 'invalid_request'      // client-side validation (bad id, size bound, base URL)
  | 'logical_failure'      // HTTP 200 with success:false (envelope-level failure)
  | 'http_client_error'    // permanent 4xx (not 429) — never retried
  | 'rate_limited'         // 429 — retriable within caps, honors Retry-After
  | 'http_server_error'    // 5xx — retriable within caps
  | 'malformed_response'   // non-JSON body or invalid envelope shape — fail closed
  | 'timeout'              // request deadline exceeded
  | 'network'              // connection/DNS/socket failure
  | 'output_limit'         // response exceeded the byte cap
  | 'retry_exhausted';     // all bounded attempts exhausted for a transient class

/** Safe identifier for sanitized endpoint error codes (no data leakage). */
const SAFE_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface AshbyErrorInit {
  code?: string;
  httpStatus?: number | null;
  operation?: string;
  attempt?: number;
  retriable?: boolean;
  endpointCodes?: string[];
}

export class AshbyError extends Error {
  public readonly category: AshbyErrorCategory;
  public readonly code: string;
  public readonly httpStatus: number | null;
  public readonly operation: string;
  public readonly attempt: number;
  public readonly retriable: boolean;
  /** Bounded, sanitized endpoint error codes (never messages/bodies). */
  public readonly endpointCodes: string[];

  constructor(category: AshbyErrorCategory, init: AshbyErrorInit = {}) {
    // Stable category text only — no dynamic values in the message.
    super(`ashby_${category}`);
    this.name = 'AshbyError';
    this.category = category;
    this.code = sanitizeCode(init.code) ?? category;
    this.httpStatus = typeof init.httpStatus === 'number' ? init.httpStatus : null;
    this.operation = sanitizeCode(init.operation) ?? 'unknown';
    this.attempt = Number.isInteger(init.attempt) && (init.attempt as number) >= 0 ? (init.attempt as number) : 0;
    this.retriable = init.retriable === true;
    this.endpointCodes = sanitizeCodes(init.endpointCodes);
  }

  /** Serialize ONLY sanitized fields — never bodies, credentials, or tokens. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      httpStatus: this.httpStatus,
      operation: this.operation,
      attempt: this.attempt,
      retriable: this.retriable,
      endpointCodes: this.endpointCodes,
    };
  }
}

export function isAshbyError(err: unknown): err is AshbyError {
  return err instanceof AshbyError;
}

/** Accept only a safe-identifier code; otherwise undefined (drop). */
function sanitizeCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return SAFE_CODE_RE.test(raw) ? raw : undefined;
}

/** Keep only safe-identifier codes, bounded to 20 entries. */
export function sanitizeCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const c = sanitizeCode(v);
    if (c) out.push(c);
    if (out.length >= 20) break;
  }
  return out;
}
