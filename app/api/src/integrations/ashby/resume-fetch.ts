/**
 * ashby/resume-fetch.ts — orchestrates a single SSRF-hardened, bounded,
 * ephemeral download of a candidate resume from an Ashby presigned URL.
 *
 * The presigned URL comes from `file.info` and is short-lived. This module:
 *   1. Validates the URL (HTTPS-only, no userinfo, allowlisted host, port) via
 *      {@link checkFetchUrl} — the allowlist is DISABLED BY DEFAULT so this
 *      fails closed until a tenant probe approves the exact host.
 *   2. Resolves DNS and asserts EVERY resolved address is public/routable, then
 *      pins those addresses so the connection cannot be re-pointed at an
 *      internal host between resolution and connect (DNS rebinding defense).
 *   3. Follows a BOUNDED number of redirects, re-running steps 1–2 on every hop
 *      (redirect-to-internal defense).
 *   4. Streams at most `maxBytes` bytes under a wall-clock timeout, rejecting an
 *      over-limit or empty body.
 *   5. Returns the bytes IN MEMORY with a content hash for provenance. The bytes
 *      are ephemeral — the ingestion worker scans+parses them and then drops
 *      them; they are NEVER written to the resume bucket.
 *
 * The DNS resolver and the low-level transport are injected, so the whole
 * redirect/rebinding/limit matrix is deterministically unit-tested with zero
 * real network or DNS. A production transport factory is provided separately.
 *
 * SECURITY: reason codes are sanitized/stable; the URL, host, presigned query,
 * and body bytes never appear in an error or log field emitted from here.
 */

import { createHash } from 'node:crypto';
import { checkFetchUrl, assertPublicAddresses, type UrlPolicy, type SsrfReason } from './ssrf.js';

export type FetchReason =
  | SsrfReason
  | 'redirect_budget_exceeded'
  | 'missing_location'
  | 'relative_redirect_unresolvable'
  | 'http_error'
  | 'too_large'
  | 'empty_body'
  | 'timeout'
  | 'transport_error';

/** Bounds applied to the fetch. All are clamped into safe ranges. */
export interface ResumeFetchLimits {
  /** Hard cap on downloaded bytes. Default 10 MiB. */
  maxBytes?: number;
  /** Wall-clock timeout in ms for the whole fetch. Default 15s. */
  timeoutMs?: number;
  /** Maximum redirect hops to follow. Default 3. */
  maxRedirects?: number;
}

/** A transport result — the transport MUST NOT auto-follow redirects. */
export type TransportResult =
  | { kind: 'redirect'; status: number; location: string | null }
  | { kind: 'body'; status: number; contentType: string | null; bytes: Buffer; overLimit: boolean }
  | { kind: 'error'; status: number }
  | { kind: 'timeout' };

export interface TransportRequest {
  /** The fully-validated absolute HTTPS URL for this hop. */
  url: string;
  /** Pre-resolved, already-validated public IPs to pin the connection to. */
  pinnedIps: readonly string[];
  timeoutMs: number;
  /** Read at most this many bytes; set `overLimit` if the body exceeds it. */
  maxBytes: number;
}

export type ResumeTransport = (req: TransportRequest) => Promise<TransportResult>;

export interface ResumeFetchDeps {
  /** Resolve a hostname to its A/AAAA addresses (strings). */
  resolve: (host: string) => Promise<string[]>;
  /** Low-level single-hop transport (redirects DISABLED). Injected for tests. */
  transport: ResumeTransport;
}

export type ResumeFetchOutcome =
  | {
      ok: true;
      bytes: Buffer;
      contentType: string | null;
      sha256: string;
      finalHost: string;
      hops: number;
    }
  | { ok: false; reason: FetchReason; hops: number };

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_BYTES_CEIL = 25 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS_CEIL = 5;

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return def;
  return v < min ? min : v > max ? max : v;
}

/**
 * Perform one SSRF-hardened, bounded, ephemeral resume fetch. Returns the bytes
 * in memory on success, or a sanitized failure reason. The caller owns the
 * ephemeral lifetime of `bytes` and MUST NOT persist them to a bucket.
 */
export async function fetchEphemeralResume(
  initialUrl: string,
  policy: UrlPolicy,
  deps: ResumeFetchDeps,
  limits: ResumeFetchLimits = {},
): Promise<ResumeFetchOutcome> {
  const maxBytes = clampInt(limits.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_BYTES_CEIL);
  const timeoutMs = clampInt(limits.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxRedirects = clampInt(limits.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, MAX_REDIRECTS_CEIL);

  const deadline = Date.now() + timeoutMs;
  let currentUrl = initialUrl;
  let hops = 0;

  for (;;) {
    // 1. Validate scheme/userinfo/host/allowlist/port for THIS hop.
    const urlCheck = checkFetchUrl(currentUrl, policy);
    if (!urlCheck.ok) return { ok: false, reason: urlCheck.reason, hops };

    // 2. Resolve DNS and assert every resolved address is public. Pin them.
    let addresses: string[];
    try {
      addresses = await deps.resolve(urlCheck.host);
    } catch {
      return { ok: false, reason: 'unresolvable_host', hops };
    }
    const addrCheck = assertPublicAddresses(addresses);
    if (!addrCheck.ok) return { ok: false, reason: addrCheck.reason, hops };
    const pinnedIps = addresses.filter((a) => typeof a === 'string' && a.trim().length > 0);

    // 3. Enforce the wall-clock budget before each network attempt.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: 'timeout', hops };

    let result: TransportResult;
    try {
      result = await deps.transport({
        url: currentUrl,
        pinnedIps,
        timeoutMs: remaining,
        maxBytes,
      });
    } catch {
      return { ok: false, reason: 'transport_error', hops };
    }

    if (result.kind === 'timeout') return { ok: false, reason: 'timeout', hops };
    if (result.kind === 'error') return { ok: false, reason: 'http_error', hops };

    if (result.kind === 'redirect') {
      if (hops >= maxRedirects) return { ok: false, reason: 'redirect_budget_exceeded', hops };
      if (!result.location) return { ok: false, reason: 'missing_location', hops };
      // Resolve the Location against the current URL (supports relative targets)
      // and loop — the next iteration re-runs scheme/host/IP validation so a
      // redirect to http://, an internal host, or a rebinding target fails closed.
      let nextUrl: string;
      try {
        nextUrl = new URL(result.location, currentUrl).toString();
      } catch {
        return { ok: false, reason: 'relative_redirect_unresolvable', hops };
      }
      currentUrl = nextUrl;
      hops += 1;
      continue;
    }

    // result.kind === 'body'
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, reason: 'http_error', hops };
    }
    if (result.overLimit) return { ok: false, reason: 'too_large', hops };
    if (result.bytes.length > maxBytes) return { ok: false, reason: 'too_large', hops };
    if (result.bytes.length === 0) return { ok: false, reason: 'empty_body', hops };

    const sha256 = createHash('sha256').update(result.bytes).digest('hex');
    return {
      ok: true,
      bytes: result.bytes,
      contentType: result.contentType,
      sha256,
      finalHost: urlCheck.host,
      hops,
    };
  }
}
