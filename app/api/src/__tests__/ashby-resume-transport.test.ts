/**
 * Ashby pinned-IP transport.
 *
 * The pure helpers (status classification, the rebinding-defense pinned lookup,
 * pinned-address ordering) are exercised directly. The `https.request` wrapper
 * is exercised through the injected `request` seam for the whole failover /
 * budget / body matrix with zero network, and once more against a REAL Node 22
 * HTTPS server with a real certificate so the `autoSelectFamily` lookup
 * contract that broke the live canary is proven end to end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  classifyStatus,
  pinnedLookup,
  orderPinnedIps,
  createPinnedHttpsTransport,
  type HttpsRequestFn,
} from '../integrations/ashby/resume-transport.js';

describe('classifyStatus', () => {
  it('maps 2xx/3xx/other to body/redirect/error', () => {
    expect(classifyStatus(200)).toBe('body');
    expect(classifyStatus(206)).toBe('body');
    expect(classifyStatus(301)).toBe('redirect');
    expect(classifyStatus(302)).toBe('redirect');
    expect(classifyStatus(404)).toBe('error');
    expect(classifyStatus(500)).toBe('error');
    expect(classifyStatus(0)).toBe('error');
  });
});

describe('pinnedLookup — Node 22 overloads', () => {
  it('answers the { all: true } overload with an address ARRAY (the canary regression)', () => {
    const lookup = pinnedLookup('93.184.216.34');
    let seen: unknown = null;
    lookup('files.ashby.example', { all: true, family: undefined, hints: 0 }, (err, addresses) => {
      expect(err).toBeNull();
      seen = addresses;
    });
    expect(seen).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(Array.isArray(seen)).toBe(true);
  });

  it('answers the legacy overload with the (address, family) tuple', () => {
    const lookup = pinnedLookup('93.184.216.34');
    let seen: { addr: string; family: number } | null = null;
    lookup('files.ashby.example', {}, (_e, address, family) => {
      seen = { addr: address as string, family: family as number };
    });
    expect(seen).toEqual({ addr: '93.184.216.34', family: 4 });
  });

  it('answers both overloads for a pinned IPv6', () => {
    const lookup = pinnedLookup('2606:4700:4700::1111');
    let all: unknown = null;
    lookup('h', { all: true }, (_e, addresses) => { all = addresses; });
    expect(all).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);

    let fam = 0;
    lookup('h', {}, (_e, _a, family) => { fam = family as number; });
    expect(fam).toBe(6);
  });

  it('errors on an invalid pinned IP in BOTH shapes and never yields an address', () => {
    const lookup = pinnedLookup('not-an-ip');

    let legacyErr: unknown = null;
    let legacyAddr: unknown = 'unset';
    lookup('h', {}, (e, address) => { legacyErr = e; legacyAddr = address; });
    expect(legacyErr).toBeInstanceOf(Error);
    expect(legacyAddr).toBe('');

    let allErr: unknown = null;
    let allAddrs: unknown = 'unset';
    lookup('h', { all: true }, (e, addresses) => { allErr = e; allAddrs = addresses; });
    expect(allErr).toBeInstanceOf(Error);
    expect(allAddrs).toEqual([]);
  });

  it('fails closed on a requested family the pinned IP cannot satisfy — no DNS fallback', () => {
    const v6Only = pinnedLookup('2606:4700:4700::1111');
    let err: unknown = null;
    let addrs: unknown = 'unset';
    v6Only('h', { all: true, family: 4 }, (e, addresses) => { err = e; addrs = addresses; });
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('EAI_NODATA');
    expect(addrs).toEqual([]);
  });

  it('accepts a requested family that matches', () => {
    const v4 = pinnedLookup('93.184.216.34');
    let addrs: unknown = null;
    v4('h', { all: true, family: 4 }, (_e, addresses) => { addrs = addresses; });
    expect(addrs).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('orderPinnedIps', () => {
  it('puts IPv4 first, keeps resolver order within a family, and keeps every family eligible', () => {
    expect(
      orderPinnedIps(['2606:4700::1', '1.1.1.1', '2606:4700::2', '8.8.8.8'], 10),
    ).toEqual(['1.1.1.1', '8.8.8.8', '2606:4700::1', '2606:4700::2']);
  });

  it('de-duplicates, trims, and drops anything that is not a literal IP', () => {
    expect(orderPinnedIps([' 1.1.1.1 ', '1.1.1.1', 'files.example.com', '', 'x'], 10)).toEqual(['1.1.1.1']);
  });

  it('bounds the attempt set and never returns zero slots for a non-empty input', () => {
    expect(orderPinnedIps(['1.1.1.1', '2.2.2.2', '3.3.3.3'], 2)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(orderPinnedIps(['1.1.1.1', '2.2.2.2'], 0)).toEqual(['1.1.1.1']);
    expect(orderPinnedIps([], 4)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Injected-request harness: deterministic, no sockets.                */
/* ------------------------------------------------------------------ */

type Behaviour =
  | { type: 'connect-error' }
  | { type: 'throw' }
  | { type: 'socket-timeout' }
  | { type: 'hang' }
  | { type: 'response'; status: number; headers?: Record<string, string>; chunks?: Buffer[]; truncate?: boolean };

class FakeRequest extends EventEmitter {
  destroyed = false;
  ended = false;
  destroy(): void { this.destroyed = true; }
  end(): void { this.ended = true; }
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  constructor(public statusCode: number, public headers: Record<string, string>) { super(); }
  destroy(): void { this.destroyed = true; }
}

function harness(script: Behaviour[]): { request: HttpsRequestFn; calls: https.RequestOptions[] } {
  const calls: https.RequestOptions[] = [];
  let i = 0;
  const request: HttpsRequestFn = (options, callback) => {
    calls.push(options);
    const behaviour = script[i++] ?? { type: 'connect-error' as const };
    const req = new FakeRequest();
    if (behaviour.type === 'throw') throw new Error('synchronous connect failure');
    setImmediate(() => {
      if (behaviour.type === 'connect-error') { req.emit('error', new Error('ECONNREFUSED')); return; }
      if (behaviour.type === 'socket-timeout') { req.emit('timeout'); return; }
      if (behaviour.type === 'hang') return;
      const res = new FakeResponse(behaviour.status, behaviour.headers ?? {});
      callback(res as unknown as import('node:http').IncomingMessage);
      setImmediate(() => {
        for (const chunk of behaviour.chunks ?? []) res.emit('data', chunk);
        if (behaviour.truncate) res.emit('close');
        else res.emit('end');
      });
    });
    return req as unknown as import('node:http').ClientRequest;
  };
  return { request, calls };
}

const REQ = { url: 'https://files.ashby.example/r.pdf?token=abc&sig=xyz', timeoutMs: 2_000, maxBytes: 1_024 };

describe('createPinnedHttpsTransport — input guards', () => {
  it('fails closed on an unparseable url, a non-https url, and an empty pinned set', async () => {
    const transport = createPinnedHttpsTransport();
    expect(typeof transport).toBe('function');
    expect(await transport({ url: 'not a url', pinnedIps: ['1.1.1.1'], timeoutMs: 10, maxBytes: 10 }))
      .toEqual({ kind: 'error', status: 0 });
    expect(await transport({ url: 'http://h/x', pinnedIps: ['1.1.1.1'], timeoutMs: 10, maxBytes: 10 }))
      .toEqual({ kind: 'error', status: 0 });
    expect(await transport({ url: 'https://h/x', pinnedIps: [], timeoutMs: 10, maxBytes: 10 }))
      .toEqual({ kind: 'error', status: 0 });
    expect(await transport({ url: 'https://h/x', pinnedIps: ['nope'], timeoutMs: 10, maxBytes: 10 }))
      .toEqual({ kind: 'error', status: 0 });
  });
});

describe('createPinnedHttpsTransport — pinned failover', () => {
  it('falls over from a failing first IP to a working second IP', async () => {
    const { request, calls } = harness([
      { type: 'connect-error' },
      { type: 'response', status: 200, headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.from('%PDF-1.7')] },
    ]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'] });
    expect(out).toEqual({
      kind: 'body', status: 200, contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7'), overLimit: false,
    });
    expect(calls).toHaveLength(2);
  });

  it('uses the pinned IPs in IPv4-then-IPv6 order, one per attempt', async () => {
    const { request, calls } = harness([{ type: 'connect-error' }, { type: 'connect-error' }]);
    const transport = createPinnedHttpsTransport({ request, maxPinnedIps: 4 });
    await transport({ ...REQ, pinnedIps: ['2606:4700::1', '9.9.9.9'] });
    const resolved = calls.map((c) => {
      let addr = '';
      (c.lookup as unknown as (h: string, o: unknown, cb: (e: unknown, a: unknown) => void) => void)(
        'h', { all: true }, (_e, a) => { addr = (a as { address: string }[])[0].address; },
      );
      return addr;
    });
    expect(resolved).toEqual(['9.9.9.9', '2606:4700::1']);
  });

  it('returns a sanitized error when every pinned IP fails, bounded by maxPinnedIps', async () => {
    const { request, calls } = harness([
      { type: 'connect-error' }, { type: 'connect-error' }, { type: 'connect-error' }, { type: 'connect-error' },
    ]);
    const transport = createPinnedHttpsTransport({ request, maxPinnedIps: 2 });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'] });
    expect(out).toEqual({ kind: 'error', status: 0 });
    expect(calls).toHaveLength(2);
  });

  it('treats a synchronous connect throw as retryable', async () => {
    const { request, calls } = harness([
      { type: 'throw' },
      { type: 'response', status: 200, chunks: [Buffer.from('ok')] },
    ]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'] });
    expect(out.kind).toBe('body');
    expect(calls).toHaveLength(2);
  });
});

describe('createPinnedHttpsTransport — no replay once the server has answered', () => {
  it('does not try the next IP after an HTTP error status', async () => {
    const { request, calls } = harness([{ type: 'response', status: 500 }, { type: 'response', status: 200 }]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'] });
    expect(out).toEqual({ kind: 'error', status: 500 });
    expect(calls).toHaveLength(1);
  });

  it('does not try the next IP after a redirect, and surfaces the location without following it', async () => {
    const { request, calls } = harness([
      { type: 'response', status: 302, headers: { location: 'https://cdn.example/next' } },
      { type: 'response', status: 200 },
    ]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'] });
    expect(out).toEqual({ kind: 'redirect', status: 302, location: 'https://cdn.example/next' });
    expect(calls).toHaveLength(1);
  });

  it('does not try the next IP after the body was truncated mid-stream', async () => {
    const { request, calls } = harness([
      { type: 'response', status: 200, chunks: [Buffer.from('partial')], truncate: true },
      { type: 'response', status: 200, chunks: [Buffer.from('whole')] },
    ]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'] });
    expect(out).toEqual({ kind: 'error', status: 200 });
    expect(calls).toHaveLength(1);
  });
});

describe('createPinnedHttpsTransport — request shape', () => {
  it('preserves the presigned path AND query, keeps SNI/Host on the hostname, and sends no redirect-following hints', async () => {
    const { request, calls } = harness([{ type: 'response', status: 200, chunks: [Buffer.from('x')] }]);
    const transport = createPinnedHttpsTransport({ request });
    await transport({ ...REQ, pinnedIps: ['1.1.1.1'] });
    const opts = calls[0] as https.RequestOptions & { servername?: string };
    expect(opts.path).toBe('/r.pdf?token=abc&sig=xyz');
    expect(opts.host).toBe('files.ashby.example');
    expect(opts.servername).toBe('files.ashby.example');
    expect((opts.headers as Record<string, string>).host).toBe('files.ashby.example');
    expect(opts.method).toBe('GET');
    expect(opts.port).toBe(443);
  });

  it('carries a non-default port into both the connect target and the Host header', async () => {
    const { request, calls } = harness([{ type: 'response', status: 200, chunks: [Buffer.from('x')] }]);
    const transport = createPinnedHttpsTransport({ request });
    await transport({ url: 'https://files.ashby.example:8443/r.pdf?a=1', pinnedIps: ['1.1.1.1'], timeoutMs: 1_000, maxBytes: 100 });
    const opts = calls[0] as https.RequestOptions;
    expect(opts.port).toBe(8443);
    expect((opts.headers as Record<string, string>).host).toBe('files.ashby.example:8443');
  });
});

describe('createPinnedHttpsTransport — body bounds', () => {
  it('caps an over-limit body and hands back NO bytes rather than a truncated document', async () => {
    const { request } = harness([
      { type: 'response', status: 200, headers: { 'content-type': 'application/pdf' }, chunks: [Buffer.alloc(8, 1), Buffer.alloc(8, 2)] },
    ]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1'], maxBytes: 10 });
    expect(out).toEqual({
      kind: 'body', status: 200, contentType: 'application/pdf',
      bytes: Buffer.alloc(0), overLimit: true,
    });
  });

  it('returns an exactly-at-the-cap body intact', async () => {
    const { request } = harness([{ type: 'response', status: 200, chunks: [Buffer.alloc(10, 7)] }]);
    const transport = createPinnedHttpsTransport({ request });
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1'], maxBytes: 10 });
    expect(out).toMatchObject({ kind: 'body', overLimit: false });
    expect((out as { bytes: Buffer }).bytes).toEqual(Buffer.alloc(10, 7));
  });
});

describe('createPinnedHttpsTransport — wall-clock budget', () => {
  it('stops on its own timer when a connection hangs, and does NOT spend the next IP', async () => {
    const { request, calls } = harness([{ type: 'hang' }, { type: 'response', status: 200, chunks: [Buffer.from('x')] }]);
    const transport = createPinnedHttpsTransport({ request });
    const started = Date.now();
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'], timeoutMs: 60 });
    expect(out).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  it('maps a socket timeout to timeout without failover', async () => {
    const { request, calls } = harness([{ type: 'socket-timeout' }, { type: 'response', status: 200 }]);
    const transport = createPinnedHttpsTransport({ request });
    expect(await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2'] })).toEqual({ kind: 'timeout' });
    expect(calls).toHaveLength(1);
  });

  it('shrinks each attempt to the REMAINING budget rather than restarting the clock', async () => {
    const { request, calls } = harness([{ type: 'connect-error' }, { type: 'connect-error' }, { type: 'connect-error' }]);
    const transport = createPinnedHttpsTransport({ request });
    await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2', '3.3.3.3'], timeoutMs: 500 });
    const timeouts = calls.map((c) => c.timeout as number);
    expect(timeouts).toHaveLength(3);
    expect(timeouts[0]).toBeLessThanOrEqual(500);
    expect(timeouts[1]).toBeLessThanOrEqual(timeouts[0]);
    expect(timeouts[2]).toBeLessThanOrEqual(timeouts[1]);
  });

  it('does not restart the budget for a fresh IP — three failures still finish well inside it', async () => {
    const { request, calls } = harness([{ type: 'connect-error' }, { type: 'connect-error' }, { type: 'connect-error' }]);
    const transport = createPinnedHttpsTransport({ request });
    const started = Date.now();
    const out = await transport({ ...REQ, pinnedIps: ['1.1.1.1', '2.2.2.2', '3.3.3.3'], timeoutMs: 400 });
    expect(out).toEqual({ kind: 'error', status: 0 });
    expect(calls).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(400);
  });
});

/* ------------------------------------------------------------------ */
/* Real Node 22 HTTPS rehearsal — proves the autoSelectFamily contract  */
/* over an actual TLS socket with an actual certificate.               */
/* ------------------------------------------------------------------ */

const PINNED_HOSTNAME = 'pinned.ashby.test';

function makeSelfSignedCert(): { key: Buffer; cert: Buffer } | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'ashby-pinned-tls-'));
    const keyPath = join(dir, 'k.pem');
    const certPath = join(dir, 'c.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', `/CN=${PINNED_HOSTNAME}`,
        '-addext', `subjectAltName=DNS:${PINNED_HOSTNAME}`],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch {
    return null;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

const tls = makeSelfSignedCert();

describe.skipIf(tls === null)('createPinnedHttpsTransport — real Node 22 pinned-certificate rehearsal', () => {
  const previousCa = https.globalAgent.options.ca;
  afterEach(() => { https.globalAgent.options.ca = previousCa; });

  it('connects to the pinned loopback IP, verifies the cert against the SNI hostname, and fails over from a dead IP', async () => {
    https.globalAgent.options.ca = tls!.cert;
    const seen: { url: string | undefined; host: string | undefined }[] = [];
    const server = https.createServer({ key: tls!.key, cert: tls!.cert }, (req, res) => {
      seen.push({ url: req.url, host: req.headers.host });
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.7 rehearsal'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const transport = createPinnedHttpsTransport();
      const out = await transport({
        url: `https://${PINNED_HOSTNAME}:${port}/resume.pdf?token=abc&sig=xyz`,
        // 127.0.0.2 is loopback with nothing listening: a real connect failure
        // that must fail over to the second pinned address.
        pinnedIps: ['127.0.0.2', '127.0.0.1'],
        timeoutMs: 10_000,
        maxBytes: 1_024 * 1_024,
      });

      expect(out.kind).toBe('body');
      expect((out as { status: number }).status).toBe(200);
      expect((out as { contentType: string | null }).contentType).toBe('application/pdf');
      expect((out as { bytes: Buffer }).bytes.toString()).toBe('%PDF-1.7 rehearsal');
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('/resume.pdf?token=abc&sig=xyz');
      expect(seen[0].host).toBe(`${PINNED_HOSTNAME}:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
