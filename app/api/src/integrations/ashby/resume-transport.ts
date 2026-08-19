/**
 * ashby/resume-transport.ts — production pinned-IP HTTPS transport for the
 * ephemeral resume fetch. The orchestrator in resume-fetch.ts validates the URL
 * and asserts every resolved IP is public BEFORE calling a transport; this
 * transport then CONNECTS TO THE PINNED IP while keeping the TLS SNI + Host
 * header on the original hostname — so a DNS answer cannot be re-pointed at an
 * internal address between validation and connect (rebinding defense), and the
 * certificate is still verified against the real hostname.
 *
 * It NEVER follows redirects (that is the orchestrator's re-validated job) and
 * reads at most `maxBytes` bytes so an over-limit body is detected without
 * buffering the whole payload.
 *
 * NODE 22 LOOKUP CONTRACT. `net.Socket` calls the injected `lookup` with two
 * different callback shapes. With `autoSelectFamily` (the Node 20+ default) it
 * passes `{ all: true }` and expects `callback(err, [{ address, family }])`;
 * without it, it expects the legacy `callback(err, address, family)` tuple.
 * A lookup that only ever answers in the legacy shape makes Node 22 read an
 * address array out of a bare string and reject the connect with
 * `ERR_INVALID_IP_ADDRESS` — which is exactly what took the live canary's
 * resume fetch to `failed_review / fetch_http_error` while the same presigned
 * URL fetched fine by hand. {@link pinnedLookup} answers BOTH shapes and never
 * falls back to system DNS.
 *
 * FAILOVER. A hostname behind a CDN resolves to many A/AAAA records and any one
 * of them can be black-holed. The transport walks a bounded, ordered set of the
 * already-validated pinned addresses, but ONLY while the failure is a
 * connect/TLS/socket error raised before a response begins. Once the server has
 * answered — any status, any byte of body — the attempt is final: replaying a
 * one-shot presigned GET after it has been served is neither safe nor useful.
 * The whole sequence shares the caller's single wall-clock budget.
 */

import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { ResumeTransport, TransportResult, TransportRequest } from './resume-fetch.js';

/** Classify an HTTP status into the transport's coarse result kind. */
export function classifyStatus(status: number): 'redirect' | 'body' | 'error' {
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 200 && status < 300) return 'body';
  return 'error';
}

/** The `{ all: true }` callback shape Node uses under `autoSelectFamily`. */
export type LookupAllCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: { address: string; family: number }[],
) => void;

/** The legacy single-address callback shape. */
export type LookupLegacyCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

/**
 * Two call signatures, matching Node's two lookup contracts. The `{ all: true }`
 * overload is listed first so a caller that asks for the array shape is typed
 * against the array callback.
 */
export interface PinnedLookup {
  (hostname: string, options: { all: true } & Record<string, unknown>, callback: LookupAllCallback): void;
  (hostname: string, options: unknown, callback: LookupLegacyCallback): void;
}

function lookupError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = 'getaddrinfo';
  return err;
}

/**
 * Build a Node `lookup` function that ALWAYS resolves to the given pinned IP,
 * regardless of the hostname passed. This forces the TCP connection to the
 * already-validated address while the TLS layer still uses the hostname for
 * SNI + certificate verification.
 *
 * It answers in whichever shape the caller asked for (`options.all === true` ⇒
 * address array, otherwise the legacy tuple), and it FAILS CLOSED: an invalid
 * pinned IP, or a requested address family the pinned IP cannot satisfy, is an
 * error. There is no path from here to system DNS — a rebinding-safe lookup
 * that silently fell back to the resolver would defeat its own purpose.
 */
export function pinnedLookup(pinnedIp: string): PinnedLookup {
  const family = isIP(pinnedIp); // 4, 6, or 0 (invalid)
  const lookup = (
    _hostname: string,
    options: unknown,
    callback: LookupAllCallback | LookupLegacyCallback,
  ): void => {
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      all?: unknown;
      family?: unknown;
    };
    const wantsAll = opts.all === true;
    const fail = (err: NodeJS.ErrnoException): void => {
      if (wantsAll) (callback as LookupAllCallback)(err, []);
      else (callback as LookupLegacyCallback)(err, '', 0);
    };

    if (family === 0) {
      fail(lookupError('EAI_NONAME', 'invalid_pinned_ip'));
      return;
    }
    // `family: 4|6` is a hard constraint from the socket, not a preference. If
    // the pinned address cannot satisfy it we must error rather than hand back
    // a mismatched family (which Node would reject) or resolve some other way.
    const requested = opts.family;
    if ((requested === 4 || requested === 6) && requested !== family) {
      fail(lookupError('EAI_NODATA', 'pinned_ip_family_mismatch'));
      return;
    }

    if (wantsAll) (callback as LookupAllCallback)(null, [{ address: pinnedIp, family }]);
    else (callback as LookupLegacyCallback)(null, pinnedIp, family);
  };
  return lookup as PinnedLookup;
}

/**
 * Order and bound the pinned addresses to actually attempt. IPv4 first, then
 * IPv6, each preserving the resolver's own order, de-duplicated, and truncated
 * to `maxPinnedIps`. Anything that is not a literal IP is dropped — the
 * orchestrator only ever pins parsed addresses, so a non-IP here is a bug, not
 * a hostname to resolve.
 *
 * This ORDERS, it never filters by family: every address the orchestrator
 * validated as public stays eligible, so the upstream all-address check is not
 * weakened into a "the v4 records were fine" check.
 */
export function orderPinnedIps(ips: readonly string[], maxPinnedIps: number): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  const seen = new Set<string>();
  for (const raw of ips) {
    if (typeof raw !== 'string') continue;
    const ip = raw.trim();
    if (ip.length === 0 || seen.has(ip)) continue;
    const family = isIP(ip);
    if (family === 4) {
      seen.add(ip);
      v4.push(ip);
    } else if (family === 6) {
      seen.add(ip);
      v6.push(ip);
    }
  }
  return [...v4, ...v6].slice(0, Math.max(1, maxPinnedIps));
}

/** The `https.request` surface this module depends on (injected in tests). */
export type HttpsRequestFn = (
  options: https.RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

export interface PinnedTransportOptions {
  /** Cap on the number of pinned IPs to actually attempt (defense-in-depth). */
  maxPinnedIps?: number;
  /**
   * Override the `https.request` implementation. Test/rehearsal seam only —
   * production leaves it unset and gets `node:https`.
   */
  request?: HttpsRequestFn;
}

/** One connect attempt, plus whether the NEXT pinned IP may be tried. */
interface AttemptOutcome {
  result: TransportResult;
  retryable: boolean;
}

const DEFAULT_MAX_PINNED_IPS = 4;

/**
 * Run exactly one request against one pinned IP under its own wall-clock bound.
 * Resolves (never rejects) with a sanitized result — no URL, IP, header, or
 * error detail escapes. All listeners, timers, sockets and buffered bytes are
 * released before the promise settles.
 */
function attemptOnce(
  url: URL,
  pinnedIp: string,
  timeoutMs: number,
  maxBytes: number,
  requestImpl: HttpsRequestFn,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>((resolve) => {
    let settled = false;
    let responseStarted = false;
    let request: ClientRequest | null = null;
    let response: IncomingMessage | null = null;
    let chunks: Buffer[] = [];

    /** Zero and release everything buffered so far. */
    const discard = (): void => {
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
    };

    // Not unref'd: this timer is the only guarantee that a stalled socket still
    // settles the promise, and `finish` clears it on every path.
    const timer = setTimeout(() => {
      discard();
      // A timeout is the caller's wall clock running out, not a bad address:
      // trying the next pinned IP would spend budget that no longer exists.
      finish({ kind: 'timeout' }, false);
    }, timeoutMs);

    function finish(result: TransportResult, retryable: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drop every listener, then re-arm a no-op `error` handler BEFORE
      // destroying: an aborted socket can still emit ECONNRESET, and an
      // 'error' with no listener is an uncaught exception, not a log line.
      if (response) {
        response.removeAllListeners();
        response.on('error', () => {});
        response.destroy();
        response = null;
      }
      if (request) {
        request.removeAllListeners();
        request.on('error', () => {});
        request.destroy();
        request = null;
      }
      resolve({ result, retryable });
    }

    const onResponse = (res: IncomingMessage): void => {
      response = res;
      responseStarted = true;
      const status = res.statusCode ?? 0;
      const kind = classifyStatus(status);

      if (kind === 'redirect') {
        const loc = res.headers.location;
        finish({ kind: 'redirect', status, location: typeof loc === 'string' ? loc : null }, false);
        return;
      }
      if (kind === 'error') {
        finish({ kind: 'error', status }, false);
        return;
      }

      const contentType =
        typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;
      let total = 0;

      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          // Over the cap: the bytes are unusable, so wipe rather than hand back
          // a truncated document that could be mistaken for a resume.
          discard();
          finish({ kind: 'body', status, contentType, bytes: Buffer.alloc(0), overLimit: true }, false);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        discard();
        finish({ kind: 'body', status, contentType, bytes, overLimit: false }, false);
      });
      // A close without `end` is a truncated body — an error, and NOT retryable
      // because the server already answered.
      res.on('close', () => {
        discard();
        finish({ kind: 'error', status }, false);
      });
      res.on('error', () => {
        discard();
        finish({ kind: 'error', status }, false);
      });
    };

    try {
      request = requestImpl(
        {
          protocol: 'https:',
          host: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          servername: url.hostname, // SNI stays the hostname
          path: `${url.pathname}${url.search}`, // presigned query preserved verbatim
          method: 'GET',
          headers: { host: url.host, accept: '*/*' },
          lookup: pinnedLookup(pinnedIp) as never,
          timeout: timeoutMs,
        },
        onResponse,
      );
    } catch {
      // A synchronous throw is a connect-side failure: the next pinned IP may
      // still work.
      finish({ kind: 'error', status: 0 }, true);
      return;
    }

    request.on('timeout', () => {
      discard();
      finish({ kind: 'timeout' }, false);
    });
    request.on('error', () => {
      discard();
      // Retry the next address ONLY while nothing has been served yet.
      finish({ kind: 'error', status: 0 }, !responseStarted);
    });
    request.end();
  });
}

/**
 * Create the production {@link ResumeTransport}. Walks a bounded ordered set of
 * pinned IPs on connect/TLS failure, disables redirect following, and reads a
 * bounded body. Any socket/TLS error or timeout maps to a sanitized transport
 * result (never leaks details).
 */
export function createPinnedHttpsTransport(options: PinnedTransportOptions = {}): ResumeTransport {
  const maxPinnedIps = Math.max(1, options.maxPinnedIps ?? DEFAULT_MAX_PINNED_IPS);
  const requestImpl: HttpsRequestFn = options.request ?? (https.request as HttpsRequestFn);

  return async function pinnedHttpsTransport(req: TransportRequest): Promise<TransportResult> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return { kind: 'error', status: 0 };
    }
    if (url.protocol !== 'https:') return { kind: 'error', status: 0 };

    const ips = orderPinnedIps(req.pinnedIps, maxPinnedIps);
    if (ips.length === 0) return { kind: 'error', status: 0 };

    const budgetMs = Math.max(1, Math.floor(req.timeoutMs));
    const deadline = Date.now() + budgetMs;
    let last: TransportResult | null = null;

    for (const ip of ips) {
      const remaining = deadline - Date.now();
      // Defensive: each attempt is already bounded by the remaining budget, so
      // an expiry normally surfaces as that attempt's own timeout. This guard
      // catches the boundary case where the clock ran out between attempts.
      if (remaining <= 0) return { kind: 'timeout' };
      const attempt = await attemptOnce(url, ip, remaining, req.maxBytes, requestImpl);
      if (!attempt.retryable) return attempt.result;
      last = attempt.result;
    }

    return last ?? { kind: 'error', status: 0 };
  };
}
