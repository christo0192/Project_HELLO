/**
 * CSP policy construction for the recruiter dashboard.
 *
 * SEC-07: No unsafe-inline, no unsafe-eval, no wildcard sources.
 * Report-only by default; enforce after owner-approved clean window.
 */

// ── Banned CSP keyword / literal sources ────────────────────────────
// These are explicitly forbidden in our policy. validateSources rejects them.

const BANNED_CSP_KEYWORDS = new Set([
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'strict-dynamic'",
  "'unsafe-hashes'",
  "'report-sample'",
  '*',
]);

// ── Approved CSP scheme-less tokens that are NOT URLs ────────────────

const APPROVED_TOKENS = new Set([
  "'self'",
  "'none'",
  'data:',
  'blob:',
  'mediastream:',
  'filesystem:',
]);

const ALLOWED_URL_SCHEMES = new Set(['https:', 'http:', 'wss:', 'ws:']);

// ── Character guards ─────────────────────────────────────────────────

// Control characters (0x00–0x1F, 0x7F) and semicolon (0x3B = CSP directive separator)
function hasForbiddenChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x3b) return true;
  }
  return false;
}

// ── Types ────────────────────────────────────────────────────────────

export interface CspConfig {
  /** Canonical API origin (scheme://host:port — URL.origin, no default-ports). */
  apiOrigin: string;
  /** Canonical Supabase origin (same semantics). */
  supabaseOrigin: string;
  /** Canonical LiveKit WebSocket origin (ws:// or wss:// URL.origin). */
  livekitOrigin: string;
  /** Exact 'report-only' or 'enforce'. Any other value rejected. */
  mode: 'report-only' | 'enforce';
  /** Absolute HTTP(S) report endpoint URL with optional path, or undefined. */
  reportEndpoint?: string;
  /** If true, add Vite HMR ws://localhost:PORT to connect-src. */
  dev?: boolean;
  /** Dev server port for HMR (default 5173). */
  devPort?: number;
}

// ── Origin canonicalization (http/https/ws/wss) ──────────────────────

/**
 * Parse and canonicalize an origin.
 *
 * Accepts http, https, ws, or wss schemes.  Returns the standard
 * URL.origin (scheme://host:port — default ports 80 / 443 are OMITTED,
 * matching the living URL Standard and browser behaviour).
 *
 * Rejects credentials, path, query, hash, forbidden characters,
 * and any scheme not in the allowed set.
 */
export function canonicalizeOrigin(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (!ALLOWED_URL_SCHEMES.has(u.protocol)) return undefined;
    if (u.username || u.password) return undefined;
    if (u.pathname !== '/' && u.pathname !== '') return undefined;
    if (u.search || u.hash) return undefined;
    if (hasForbiddenChars(raw)) return undefined;

    // u.origin uses the living URL Standard: default ports are omitted.
    return u.origin;
  } catch {
    return undefined;
  }
}

// ── WebSocket origin helpers ─────────────────────────────────────────

/**
 * Return the canonical WebSocket origin for a LiveKit-compatible source.
 *
 * Accepts wss:// / ws:// values directly (used by LiveKit tooling) as
 * well as https:// → wss:// and http:// → ws:// conversions.
 *
 * Returns undefined on malformed input or schemes outside the allowed set.
 */
export function toWebSocketOrigin(raw: string): string | undefined {
  try {
    const s = raw.trim();
    if (hasForbiddenChars(s)) return undefined;

    const u = new URL(s);
    if (u.username || u.password) return undefined;
    if (u.pathname !== '/' && u.pathname !== '') return undefined;
    if (u.search || u.hash) return undefined;

    // Already a WebSocket origin — canonicalize and return.
    if (u.protocol === 'wss:' || u.protocol === 'ws:') return u.origin;

    // Convert https → wss, http → ws.
    if (u.protocol === 'https:') return u.origin.replace(/^https:/, 'wss:');
    if (u.protocol === 'http:') return u.origin.replace(/^http:/, 'ws:');

    return undefined;
  } catch {
    return undefined;
  }
}

// ── Source validation ────────────────────────────────────────────────

/**
 * Validate a single CSP source value.
 *
 * Approved: http(s)/ws(s) URLs, and the APPROVED_TOKENS set.
 * Rejected: banned keywords (unsafe-inline, unsafe-eval, strict-dynamic,
 *   unsafe-hashes, report-sample), wildcard '*', control characters,
 *   semicolons, unknown schemes, and unparseable strings.
 */
export function isValidCspSource(s: string): boolean {
  if (!s) return false;
  if (hasForbiddenChars(s)) return false;

  // Banned keywords always rejected.
  if (BANNED_CSP_KEYWORDS.has(s.trim())) return false;

  // Approved scheme-less tokens.
  if (APPROVED_TOKENS.has(s)) return true;

  // Must be a parseable URL with an allowed scheme.
  try {
    const u = new URL(s);
    return ALLOWED_URL_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

/**
 * Validate every member in a source array.  Returns the list of
 * rejected sources (empty → all valid).
 */
export function validateSources(sources: string[]): string[] {
  const rejected: string[] = [];
  for (const src of sources) {
    if (!isValidCspSource(src)) rejected.push(src);
  }
  return rejected;
}

// ── Report-endpoint validation ───────────────────────────────────────

/**
 * Validate a CSP report endpoint URL.
 *
 * Must be an absolute http:// or https:// URL.  Path components are
 * allowed (e.g. /api/csp-report).  Rejects credentials, query strings,
 * fragments, control characters, semicolons, and non-HTTP schemes.
 *
 * Returns the canonical string on success, undefined on failure.
 */
export function validateReportEndpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const s = raw.trim();
    if (hasForbiddenChars(s)) return undefined;

    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    if (u.search || u.hash) return undefined;

    // Rebuild without search/hash and with forbidden-char check already passed.
    return u.origin + u.pathname;
  } catch {
    return undefined;
  }
}

// ── Header construction ──────────────────────────────────────────────

/**
 * Build the Content-Security-Policy header value.
 *
 * Fails closed (returns undefined) when:
 *  - Any origin input is not a canonical HTTP(S) origin
 *  - LiveKit origin isn't a valid WebSocket / convertible source
 *  - Mode is invalid
 *  - Report endpoint is malformed
 *  - ANY assembled source value fails validation
 */
export function buildCspHeader(config: CspConfig): string | undefined {
  // ── Input guards ────────────────────────────────────────────────

  // Mode must be exact.
  if (config.mode !== 'report-only' && config.mode !== 'enforce') return undefined;

  // API and Supabase origins must be canonical HTTP(S).  Require
  // canonicalizeOrigin to return the *exact* supplied value so no
  // path/credentials/query/non-canonical forms slip through.
  const apiCanon = canonicalizeOrigin(config.apiOrigin);
  if (!apiCanon || apiCanon !== config.apiOrigin || !config.apiOrigin.startsWith('http')) return undefined;
  const supabaseCanon = canonicalizeOrigin(config.supabaseOrigin);
  if (!supabaseCanon || supabaseCanon !== config.supabaseOrigin || !config.supabaseOrigin.startsWith('http')) return undefined;

  // LiveKit origin must be a canonical WebSocket origin.  Require
  // toWebSocketOrigin to round-trip identically.
  const livekitCanon = toWebSocketOrigin(config.livekitOrigin);
  if (!livekitCanon || livekitCanon !== config.livekitOrigin) return undefined;

  // Report endpoint — validated separately (allows path).
  // Store the NORMALIZED value so the emitted directive uses the
  // canonical form, not the original raw string.
  let validatedReportEndpoint: string | undefined;
  if (config.reportEndpoint !== undefined) {
    validatedReportEndpoint = validateReportEndpoint(config.reportEndpoint);
    if (!validatedReportEndpoint) return undefined;
  }

  // ── Assemble directives ─────────────────────────────────────────

  // connect-src: self + API + Supabase REST/Realtime WSS + LiveKit signalling WSS
  const connectSrc = [
    "'self'",
    config.apiOrigin,
    config.supabaseOrigin,
    config.livekitOrigin,
  ];
  if (config.dev) {
    connectSrc.push(`ws://localhost:${config.devPort ?? 5173}`);
  }

  // media-src: self + blob (recording playback) + Supabase (signed recording URLs)
  const mediaSrc = ["'self'", 'blob:', config.supabaseOrigin];

  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': "'self'",
    'style-src': "'self'",
    'img-src': "'self' data:",
    'font-src': "'self'",
    'connect-src': connectSrc.join(' '),
    'media-src': mediaSrc.join(' '),
    'frame-ancestors': "'none'",
    'form-action': "'self'",
    'base-uri': "'self'",
    'object-src': "'none'",
  };

  if (validatedReportEndpoint) {
    directives['report-uri'] = validatedReportEndpoint;
  }

  // ── Final safety scan: reject any banned source that snuck through ─
  const allSources: string[] = [];
  for (const [key, val] of Object.entries(directives)) {
    if (key === 'report-uri') continue;
    allSources.push(...val.split(/\s+/));
  }
  if (validateSources(allSources).length > 0) return undefined;

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

/**
 * Return the HTTP header name for the configured mode.
 */
export function cspHeaderName(config: CspConfig): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return config.mode === 'enforce'
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
}

/**
 * Validate and normalise the CSP mode string.
 * Returns a valid mode constant, or undefined for any other input.
 */
export function parseCspMode(raw: string | undefined): CspConfig['mode'] | undefined {
  if (raw === 'report-only') return 'report-only';
  if (raw === 'enforce') return 'enforce';
  return undefined;
}
