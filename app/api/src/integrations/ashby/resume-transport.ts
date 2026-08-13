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
 * reads at most `maxBytes + 1` bytes so an over-limit body is detected without
 * buffering the whole payload. The host allowlist remains DISABLED until a
 * tenant probe approves real hosts, so this transport is not reached in the
 * default configuration — it is the wiring a later activation flips on.
 *
 * The pure helpers (pinned lookup + status classification) are unit-tested; the
 * thin `https.request` wrapper is exercised only when the integration is
 * activated with an approved host.
 */

import https from 'node:https';
import { isIP } from 'node:net';
import type { ResumeTransport, TransportResult, TransportRequest } from './resume-fetch.js';

/** Classify an HTTP status into the transport's coarse result kind. */
export function classifyStatus(status: number): 'redirect' | 'body' | 'error' {
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 200 && status < 300) return 'body';
  return 'error';
}

/**
 * Build a Node `lookup` function that ALWAYS resolves to the given pinned IP,
 * regardless of the hostname passed. This forces the TCP connection to the
 * already-validated address while the TLS layer still uses the hostname for
 * SNI + certificate verification.
 */
export function pinnedLookup(pinnedIp: string): (
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void {
  const family = isIP(pinnedIp); // 4, 6, or 0 (invalid)
  return (_hostname, _options, callback) => {
    if (family === 0) {
      callback(new Error('invalid_pinned_ip') as NodeJS.ErrnoException, '', 0);
      return;
    }
    callback(null, pinnedIp, family);
  };
}

export interface PinnedTransportOptions {
  /** Cap on the number of pinned IPs to actually attempt (defense-in-depth). */
  maxPinnedIps?: number;
}

/**
 * Create the production {@link ResumeTransport}. Connects to the first pinned
 * IP, disables redirect following, and reads a bounded body. Any socket/TLS
 * error or timeout maps to a sanitized transport result (never leaks details).
 */
export function createPinnedHttpsTransport(options: PinnedTransportOptions = {}): ResumeTransport {
  const maxPinnedIps = Math.max(1, options.maxPinnedIps ?? 4);

  return function pinnedHttpsTransport(req: TransportRequest): Promise<TransportResult> {
    return new Promise<TransportResult>((resolve) => {
      let settled = false;
      const done = (r: TransportResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        done({ kind: 'error', status: 0 });
        return;
      }
      const pinnedIp = req.pinnedIps.slice(0, maxPinnedIps)[0];
      if (!pinnedIp) {
        done({ kind: 'error', status: 0 });
        return;
      }

      const request = https.request(
        {
          protocol: 'https:',
          host: url.hostname,
          servername: url.hostname, // SNI stays the hostname
          path: url.pathname + url.search,
          method: 'GET',
          headers: { host: url.hostname, accept: '*/*' },
          lookup: pinnedLookup(pinnedIp) as never,
          timeout: req.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const kind = classifyStatus(status);
          if (kind === 'redirect') {
            res.resume(); // drain
            const loc = res.headers.location;
            done({ kind: 'redirect', status, location: typeof loc === 'string' ? loc : null });
            return;
          }
          if (kind === 'error') {
            res.resume();
            done({ kind: 'error', status });
            return;
          }
          const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;
          const chunks: Buffer[] = [];
          let total = 0;
          let overLimit = false;
          res.on('data', (chunk: Buffer) => {
            if (overLimit) return;
            total += chunk.length;
            if (total > req.maxBytes) {
              overLimit = true;
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => done({ kind: 'body', status, contentType, bytes: Buffer.concat(chunks), overLimit }));
          res.on('close', () => {
            if (overLimit) done({ kind: 'body', status, contentType, bytes: Buffer.concat(chunks), overLimit: true });
          });
          res.on('error', () => done({ kind: 'error', status }));
        },
      );
      request.on('timeout', () => {
        request.destroy();
        done({ kind: 'timeout' });
      });
      request.on('error', () => done({ kind: 'error', status: 0 }));
      request.end();
    });
  };
}
