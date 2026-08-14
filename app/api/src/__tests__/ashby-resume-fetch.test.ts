/**
 * Ashby ephemeral resume fetch — SSRF orchestration + bounds negative controls.
 *
 * Drives the full redirect/rebinding/limit matrix with a fully injected DNS
 * resolver and transport (zero real network): allowlist-disabled fail-closed,
 * redirect-to-internal, redirect-to-http, DNS rebinding across a redirect hop,
 * redirect budget, oversize/empty body, timeout, and the happy path with a
 * provenance hash. No URL/host/body ever leaks into a failure reason.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  fetchEphemeralResume,
  type ResumeTransport,
  type TransportResult,
  type ResumeFetchDeps,
} from '../integrations/ashby/resume-fetch.js';
import type { UrlPolicy } from '../integrations/ashby/ssrf.js';

const HOST = 'files.ashby.example';
const ALT_HOST = 'cdn.ashby.example';
const approved: UrlPolicy = { allowlistEnabled: true, allowedHosts: [HOST, ALT_HOST], allowedPorts: [443] };

/** A resolver that always returns a fixed public IP for any host. */
const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

/** A transport that serves a fixed clean body once. */
function bodyTransport(bytes: Buffer, contentType: string | null = 'application/pdf'): ResumeTransport {
  return async () => ({ kind: 'body', status: 200, contentType, bytes, overLimit: false });
}

function deps(transport: ResumeTransport, resolve = publicResolver): ResumeFetchDeps {
  return { resolve, transport };
}

const PDF = Buffer.from('%PDF-1.4\n...resume bytes...\n%%EOF');

describe('fetchEphemeralResume — happy path', () => {
  it('downloads bounded bytes and returns a provenance sha256', async () => {
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf?sig=x`, approved, deps(bodyTransport(PDF)));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.bytes.equals(PDF)).toBe(true);
      expect(out.contentType).toBe('application/pdf');
      expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(out.finalHost).toBe(HOST);
      expect(out.hops).toBe(0);
    }
  });
});

describe('fetchEphemeralResume — fail closed on policy', () => {
  it('refuses when the allowlist is disabled (default)', async () => {
    const out = await fetchEphemeralResume(
      `https://${HOST}/r.pdf`,
      { allowlistEnabled: false, allowedHosts: [] },
      deps(bodyTransport(PDF)),
    );
    expect(out).toEqual({ ok: false, reason: 'allowlist_disabled', hops: 0 });
  });

  it('refuses a non-HTTPS initial URL without touching the transport', async () => {
    const transport = vi.fn<ResumeTransport>();
    const out = await fetchEphemeralResume(`http://${HOST}/r.pdf`, approved, deps(transport));
    expect(out).toEqual({ ok: false, reason: 'scheme_not_https', hops: 0 });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('fetchEphemeralResume — resolved-IP defenses', () => {
  it('blocks when DNS resolves to a private address (no connect)', async () => {
    const transport = vi.fn<ResumeTransport>();
    const out = await fetchEphemeralResume(
      `https://${HOST}/r.pdf`,
      approved,
      deps(transport, async () => ['169.254.169.254']),
    );
    expect(out).toEqual({ ok: false, reason: 'blocked_address', hops: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks when DNS returns a mixed public+private set (rebinding poison)', async () => {
    const out = await fetchEphemeralResume(
      `https://${HOST}/r.pdf`,
      approved,
      deps(bodyTransport(PDF), async () => ['93.184.216.34', '10.0.0.5']),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('blocked_address');
  });

  it('treats an empty DNS answer as unresolvable', async () => {
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(bodyTransport(PDF), async () => []));
    expect(out).toEqual({ ok: false, reason: 'unresolvable_host', hops: 0 });
  });

  it('treats a resolver throw as unresolvable (fails closed)', async () => {
    const out = await fetchEphemeralResume(
      `https://${HOST}/r.pdf`,
      approved,
      deps(bodyTransport(PDF), async () => {
        throw new Error('nxdomain');
      }),
    );
    expect(out).toEqual({ ok: false, reason: 'unresolvable_host', hops: 0 });
  });
});

describe('fetchEphemeralResume — redirect matrix', () => {
  it('re-validates each hop and blocks a redirect to an internal host', async () => {
    // Hop 0 resolves public; the redirect target host is NOT allowlisted.
    let call = 0;
    const transport: ResumeTransport = async () => {
      call += 1;
      if (call === 1) return { kind: 'redirect', status: 302, location: 'https://evil.example/internal' };
      return { kind: 'body', status: 200, contentType: 'application/pdf', bytes: PDF, overLimit: false };
    };
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('host_not_allowlisted');
  });

  it('blocks a redirect that downgrades to http', async () => {
    const transport: ResumeTransport = async () => ({ kind: 'redirect', status: 302, location: `http://${HOST}/r.pdf` });
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('scheme_not_https');
  });

  it('blocks rebinding: the SAME allowlisted host resolves private on the 2nd hop', async () => {
    let resolveCall = 0;
    const resolve = async (): Promise<string[]> => {
      resolveCall += 1;
      return resolveCall === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
    };
    const transport: ResumeTransport = async () => ({
      kind: 'redirect',
      status: 302,
      location: `https://${ALT_HOST}/r.pdf`,
    });
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, { resolve, transport });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('blocked_address');
      expect(out.hops).toBe(1);
    }
  });

  it('enforces the redirect budget', async () => {
    const transport: ResumeTransport = async () => ({
      kind: 'redirect',
      status: 302,
      location: `https://${HOST}/next`,
    });
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport), { maxRedirects: 2 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('redirect_budget_exceeded');
      expect(out.hops).toBe(2);
    }
  });

  it('rejects a redirect with no Location header', async () => {
    const transport: ResumeTransport = async () => ({ kind: 'redirect', status: 302, location: null });
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('missing_location');
  });

  it('follows a relative redirect resolved against the current URL', async () => {
    let call = 0;
    const transport: ResumeTransport = async (req) => {
      call += 1;
      if (call === 1) {
        expect(req.url).toContain('/a/r.pdf');
        return { kind: 'redirect', status: 302, location: '../b/final.pdf' };
      }
      expect(req.url).toBe(`https://${HOST}/b/final.pdf`);
      return { kind: 'body', status: 200, contentType: 'application/pdf', bytes: PDF, overLimit: false };
    };
    const out = await fetchEphemeralResume(`https://${HOST}/a/r.pdf`, approved, deps(transport));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.hops).toBe(1);
  });
});

describe('fetchEphemeralResume — body bounds', () => {
  it('rejects an over-limit body (transport flag)', async () => {
    const transport: ResumeTransport = async () => ({
      kind: 'body',
      status: 200,
      contentType: 'application/pdf',
      bytes: Buffer.alloc(11),
      overLimit: true,
    });
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport), { maxBytes: 10 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('too_large');
  });

  it('rejects a body that exceeds maxBytes even without the flag', async () => {
    const transport: ResumeTransport = async () => ({
      kind: 'body',
      status: 200,
      contentType: 'application/pdf',
      bytes: Buffer.alloc(20),
      overLimit: false,
    });
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport), { maxBytes: 10 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('too_large');
  });

  it('rejects an empty body', async () => {
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(bodyTransport(Buffer.alloc(0))));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('empty_body');
  });

  it('maps a transport timeout and an http error to sanitized reasons', async () => {
    const t1: ResumeTransport = async () => ({ kind: 'timeout' });
    const t2: ResumeTransport = async () => ({ kind: 'error', status: 500 });
    expect((await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(t1))).ok).toBe(false);
    const e = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(t2));
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.reason).toBe('http_error');
  });

  it('maps a transport throw to transport_error (fails closed)', async () => {
    const transport: ResumeTransport = async () => {
      throw new Error('socket hang up');
    };
    const out = await fetchEphemeralResume(`https://${HOST}/r.pdf`, approved, deps(transport));
    expect(out).toEqual({ ok: false, reason: 'transport_error', hops: 0 });
  });
});
