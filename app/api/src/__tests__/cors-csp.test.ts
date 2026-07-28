/**
 * SEC-07: CORS exact hardening + CSP policy + CSP report endpoint tests.
 *
 * Covers:
 *  - CORS: exact match only, no-Origin, preflight, production-vs-dev,
 *    malformed config rejection (without echoing raw values), webOrigin
 *    override, credentials/path/query/hash rejection.
 *  - CSP construction: canonical origin (URL.omit-default-ports),
 *    http→ws/https→wss, ws/wss native, banned keywords rejection,
 *    injection rejection, invalid modes, malformed endpoints,
 *    report-endpoint validation with path support, config errors
 *    never echo raw values.
 *  - CSP report endpoint: legacy, Reporting API, multiple content types,
 *    exact 413 oversized, exact 400 malformed JSON, structured log
 *    with origin-only, no path/query/fragment/credential leakage,
 *    log injection sanitisation, control char stripping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

// ── Helpers ───────────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'http://localhost:5173';

// ===================================================================
//  CORS BEHAVIOUR
// ===================================================================

describe('CORS (SEC-07)', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  // ── Allowed origin ────────────────────────────────────────────

  it('allows exact canonical WEB_ORIGIN', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.status).toBe(200);
  });

  it('allows request with no Origin (server-to-server, curl)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Exact match only ─────────────────────────────────────────

  it('rejects origin with trailing slash (exact match)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', ALLOWED_ORIGIN + '/');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Disallowed origin → no ACAO ───────────────────────────────

  it('disallowed origin receives NO Access-Control-Allow-Origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.status).toBe(200);
  });

  // ── Preflight ──────────────────────────────────────────────────

  it('allows preflight from approved origin', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('preflight from disallowed origin omits ACAO', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Production vs development ──────────────────────────────────

  it('blocks localhost:NNNN in production mode', async () => {
    const prodApp = createApp({
      nodeEnv: 'production',
      webOrigin: 'https://dashboard.example.com',
    });
    const res = await request(prodApp)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows production WEB_ORIGIN exactly', async () => {
    const prodApp = createApp({
      nodeEnv: 'production',
      webOrigin: 'https://dashboard.example.com',
    });
    const res = await request(prodApp)
      .get('/api/health')
      .set('Origin', 'https://dashboard.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://dashboard.example.com');
  });

  it('allows localhost:any in non-production mode', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:4000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4000');
  });

  it('allows 127.0.0.1:any in non-production mode', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://127.0.0.1:9000');
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:9000');
  });

  it('blocks 127.0.0.1 in production mode', async () => {
    const prodApp = createApp({
      nodeEnv: 'production',
      webOrigin: 'https://dashboard.example.com',
    });
    const res = await request(prodApp)
      .get('/api/health')
      .set('Origin', 'http://127.0.0.1:8080');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── webOrigin override ─────────────────────────────────────────

  it('accepts webOrigin override via createApp options', async () => {
    const customApp = createApp({ webOrigin: 'https://custom.example.com' });
    const res = await request(customApp)
      .get('/api/health')
      .set('Origin', 'https://custom.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://custom.example.com');
  });

  it('custom webOrigin rejects other origins', async () => {
    const customApp = createApp({ webOrigin: 'https://custom.example.com' });
    const res = await request(customApp)
      .get('/api/health')
      .set('Origin', 'https://other.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Malformed config — fail closed ─────────────────────────────

  it('throws on WEB_ORIGIN with path component', () => {
    expect(() => createApp({ webOrigin: 'http://localhost:5173/dashboard' })).toThrow(
      /malformed/,
    );
  });

  it('throws on WEB_ORIGIN with query string', () => {
    expect(() => createApp({ webOrigin: 'http://localhost:5173?foo=bar' })).toThrow(
      /malformed/,
    );
  });

  it('throws on WEB_ORIGIN with hash', () => {
    expect(() => createApp({ webOrigin: 'http://localhost:5173#section' })).toThrow(
      /malformed/,
    );
  });

  it('throws on WEB_ORIGIN with credentials', () => {
    expect(() =>
      createApp({ webOrigin: 'http://user:pass@localhost:5173' }),
    ).toThrow(/malformed/);
  });

  it('throws on WEB_ORIGIN with non-http scheme', () => {
    expect(() => createApp({ webOrigin: 'ftp://localhost:5173' })).toThrow(
      /malformed/,
    );
  });

  it('throws on empty WEB_ORIGIN', () => {
    expect(() => createApp({ webOrigin: '' })).toThrow();
  });

  // ── Production rejects loopback explicitly in WEB_ORIGIN ─────

  it('production rejects localhost loopback in WEB_ORIGIN', () => {
    expect(() =>
      createApp({
        nodeEnv: 'production',
        webOrigin: 'http://localhost:1234',
      }),
    ).toThrow(/loopback/);
  });

  it('production rejects 127.0.0.1 loopback in WEB_ORIGIN', () => {
    expect(() =>
      createApp({
        nodeEnv: 'production',
        webOrigin: 'http://127.0.0.1:8080',
      }),
    ).toThrow(/loopback/);
  });

  it('production rejects 0.0.0.0 loopback in WEB_ORIGIN', () => {
    expect(() =>
      createApp({
        nodeEnv: 'production',
        webOrigin: 'https://0.0.0.0:443',
      }),
    ).toThrow(/loopback/);
  });

  it('production rejects https://localhost loopback', () => {
    expect(() =>
      createApp({
        nodeEnv: 'production',
        webOrigin: 'https://localhost:5173',
      }),
    ).toThrow(/loopback/);
  });

  it('production rejects https://[::1] loopback', () => {
    expect(() =>
      createApp({
        nodeEnv: 'production',
        webOrigin: 'https://[::1]:5173',
      }),
    ).toThrow(/loopback/);
  });

  // ── Production must use HTTPS ─────────────────────────────────

  it('production rejects http:// even for non-loopback hosts', () => {
    expect(() =>
      createApp({
        nodeEnv: 'production',
        webOrigin: 'http://dashboard.example.com',
      }),
    ).toThrow(/https/);
  });

  it('production http:// error does NOT echo raw value', () => {
    try {
      createApp({
        nodeEnv: 'production',
        webOrigin: 'http://dashboard.example.com',
      });
    } catch (e: any) {
      expect(e.message).not.toContain('dashboard');
      expect(e.message).toContain('https');
    }
  });

  it('production loopback error does NOT echo raw value', () => {
    try {
      createApp({
        nodeEnv: 'production',
        webOrigin: 'http://localhost:4321',
      });
    } catch (e: any) {
      expect(e.message).not.toContain('4321');
      expect(e.message).toContain('loopback');
    }
  });

  // ── NODE_ENV validation ───────────────────────────────────────

  it('rejects invalid NODE_ENV', () => {
    expect(() =>
      createApp({ nodeEnv: 'staging' as any }),
    ).toThrow(/NODE_ENV/);
  });

  it('allows undefined NODE_ENV (defaults to development behaviour)', () => {
    // undefined NODE_ENV → treated as non-production → localhost works.
    const a = createApp({ nodeEnv: undefined });
    expect(a).toBeDefined();
  });

  // ── Config errors never echo raw values ────────────────────────

  it('config error does NOT echo raw malformed value', () => {
    try {
      createApp({ webOrigin: 'http://user:secret123@evil.com' });
    } catch (e: any) {
      expect(e.message).not.toContain('secret123');
      expect(e.message).not.toContain('evil.com');
      expect(e.message).toContain('malformed');
    }
  });
});

// ===================================================================
//  CSP REPORT ENDPOINT
// ===================================================================

describe('CSP report endpoint (SEC-07)', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.restoreAllMocks();
  });

  // ── Legacy / Reporting API ─────────────────────────────────────

  it('accepts legacy csp-report format with 204', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://example.com',
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.example.com/inject.js',
        },
      });
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).toContain('csp_violation');
    expect(logged).toContain('https://example.com');
    expect(logged).not.toContain('/page');
    warnSpy.mockRestore();
  });

  it('accepts application/csp-report content type', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(
        JSON.stringify({
          'csp-report': {
            'document-uri': 'https://example.com',
            'violated-directive': 'script-src',
          },
        }),
      );
    expect(res.status).toBe(204);
  });

  it('accepts Reporting API format with 204', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send([
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://example.com/page',
            violatedDirective: 'script-src-elem',
            blockedURL: 'https://evil.example.com/bad.js',
          },
        },
      ]);
    expect(res.status).toBe(204);
  });

  // ── Unknown shapes → 204 (fail-safe) ───────────────────────────

  it('returns 204 for unknown shape', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({ random: 'garbage' });
    expect(res.status).toBe(204);
  });

  it('returns 204 for empty array', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send([]);
    expect(res.status).toBe(204);
  });

  // ── Malformed JSON → exact 400 ─────────────────────────────────

  it('returns exact 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send('not-valid-json');
    expect(res.status).toBe(400);
  });

  // ── Oversized → exact 413 ──────────────────────────────────────

  it('returns exact 413 for oversized body (over 64 KiB)', async () => {
    const big = { 'csp-report': { 'document-uri': 'x'.repeat(70_000) } };
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body?.error?.type).toBe('payload_too_large');
  });

  // ── URL-origin-only logging ────────────────────────────────────

  it('logs URL origins only — strips paths', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri':
            'https://example.com/dashboard/sessions?secret=abc#fragment',
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.com/beacon?id=123',
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).toContain('https://example.com');
    expect(logged).not.toContain('/dashboard');
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('fragment');
    expect(logged).not.toContain('/beacon');
    expect(logged).not.toContain('id=123');
    warnSpy.mockRestore();
  });

  it('logs origin-only — never echoes credentials in URL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://user:pass@evil.com/page',
          'violated-directive': 'script-src',
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).not.toContain('user:pass');
    expect(logged).not.toContain('@evil');
    warnSpy.mockRestore();
  });

  it('logs origin-only — never echoes query string', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://example.com/?token=secret123',
          'violated-directive': 'script-src',
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).not.toContain('token');
    expect(logged).not.toContain('secret123');
    warnSpy.mockRestore();
  });

  it('logs origin-only — never echoes fragment', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://example.com/#access_token=abc',
          'violated-directive': 'script-src',
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).not.toContain('access_token');
    expect(logged).not.toContain('#');
    warnSpy.mockRestore();
  });

  // ── Control characters / log injection ─────────────────────────

  it('strips control characters from logged fields', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://evil.com',
          'violated-directive': 'script-src\x00\x1finjected',
          'blocked-uri': 'https://evil.com',
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).not.toContain('\x00');
    expect(logged).not.toContain('\x1f');
    warnSpy.mockRestore();
  });

  it('sanitises newline injection in logged directive', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://example.com',
          'violated-directive': "script-src\n\n{\"fake_log\":true}",
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    // \n = 0x0A, a control char — must be stripped
    expect(logged).not.toContain('fake_log');
    expect(logged).not.toContain('\n');
    warnSpy.mockRestore();
  });

  // ── Structured JSON log ────────────────────────────────────────

  it('emits structured JSON via console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://example.com',
          'violated-directive': 'script-src',
        },
      });
    const logged = warnSpy.mock.calls[0][0];
    const parsed = JSON.parse(logged);
    expect(parsed.event).toBe('csp_violation');
    expect(parsed.shape).toBe('legacy');
    expect(parsed).toHaveProperty('timestamp');
    warnSpy.mockRestore();
  });

  // ── Never leaks stack traces ───────────────────────────────────

  it('never leaks stack traces in responses', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send(Buffer.alloc(0));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('stack');
    expect(body).not.toContain(' at ');
  });

  // ── Reporting API requires documentURL ─────────────────────────

  it('returns 204 for Reporting API entry missing documentURL', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send([
        { type: 'csp-violation', body: { violatedDirective: 'script-src' } },
      ]);
    expect(res.status).toBe(204);
  });
});

// ===================================================================
//  CSP HEADER CONSTRUCTION (unit tests — imported from app/web)
// ===================================================================

import {
  buildCspHeader,
  cspHeaderName,
  canonicalizeOrigin,
  toWebSocketOrigin,
  parseCspMode,
  validateSources,
  validateReportEndpoint,
} from '../../../web/src/csp.js';

describe('CSP policy construction (SEC-07)', () => {
  const defaults = {
    apiOrigin: 'http://localhost:8787',
    supabaseOrigin: 'https://project.supabase.co',
    livekitOrigin: 'wss://meet.example.com',
    mode: 'report-only' as const,
    reportEndpoint: 'http://localhost:8787/api/csp-report',
    dev: false,
  };

  // ── canonicalizeOrigin — URL.origin semantics (no default ports) ──

  it('canonicalizes valid http:// origin', () => {
    expect(canonicalizeOrigin('http://localhost:5173')).toBe(
      'http://localhost:5173',
    );
  });

  it('canonicalizes https:// origin without :443 (URL.origin)', () => {
    expect(canonicalizeOrigin('https://example.com')).toBe(
      'https://example.com',
    );
  });

  it('canonicalizes http:// origin without :80 (URL.origin)', () => {
    expect(canonicalizeOrigin('http://example.com')).toBe(
      'http://example.com',
    );
  });

  it('preserves explicit non-default port', () => {
    expect(canonicalizeOrigin('http://example.com:8080')).toBe(
      'http://example.com:8080',
    );
  });

  it('accepts ws:// URLs', () => {
    expect(canonicalizeOrigin('ws://example.com')).toBe('ws://example.com');
  });

  it('accepts wss:// URLs', () => {
    expect(canonicalizeOrigin('wss://example.com')).toBe('wss://example.com');
  });

  it('rejects origin with path', () => {
    expect(canonicalizeOrigin('http://localhost:5173/dashboard')).toBeUndefined();
  });

  it('rejects origin with query', () => {
    expect(canonicalizeOrigin('http://localhost:5173?foo=bar')).toBeUndefined();
  });

  it('rejects origin with hash', () => {
    expect(canonicalizeOrigin('http://localhost:5173#section')).toBeUndefined();
  });

  it('rejects origin with credentials', () => {
    expect(
      canonicalizeOrigin('http://user:pass@localhost:5173'),
    ).toBeUndefined();
  });

  it('rejects non-http schemes', () => {
    expect(canonicalizeOrigin('ftp://example.com')).toBeUndefined();
  });

  // ── toWebSocketOrigin ──────────────────────────────────────────

  it('maps https → wss (no default port)', () => {
    expect(toWebSocketOrigin('https://example.com')).toBe('wss://example.com');
  });

  it('maps http → ws', () => {
    expect(toWebSocketOrigin('http://localhost:8787')).toBe(
      'ws://localhost:8787',
    );
  });

  it('passes through wss:// natively', () => {
    expect(toWebSocketOrigin('wss://meet.example.com')).toBe(
      'wss://meet.example.com',
    );
  });

  it('passes through ws:// natively', () => {
    expect(toWebSocketOrigin('ws://meet.example.com')).toBe(
      'ws://meet.example.com',
    );
  });

  it('maps https:// with explicit port to wss:// with port', () => {
    expect(toWebSocketOrigin('https://example.com:8443')).toBe(
      'wss://example.com:8443',
    );
  });

  it('returns undefined for malformed origin', () => {
    expect(toWebSocketOrigin('not-a-url')).toBeUndefined();
  });

  // ── parseCspMode ───────────────────────────────────────────────

  it('parses "report-only"', () => {
    expect(parseCspMode('report-only')).toBe('report-only');
  });

  it('parses "enforce"', () => {
    expect(parseCspMode('enforce')).toBe('enforce');
  });

  it('rejects undefined', () => {
    expect(parseCspMode(undefined)).toBeUndefined();
  });

  it('rejects garbage', () => {
    expect(parseCspMode('disabled')).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(parseCspMode('')).toBeUndefined();
  });

  // ── cspHeaderName ──────────────────────────────────────────────

  it('returns Report-Only header name by default', () => {
    expect(cspHeaderName(defaults)).toBe(
      'Content-Security-Policy-Report-Only',
    );
  });

  it('returns enforce header name when mode=enforce', () => {
    expect(cspHeaderName({ ...defaults, mode: 'enforce' })).toBe(
      'Content-Security-Policy',
    );
  });

  // ── No unsafe directives ───────────────────────────────────────

  it('does NOT contain unsafe-inline', () => {
    const h = buildCspHeader(defaults);
    expect(h).toBeDefined();
    expect(h!).not.toContain('unsafe-inline');
  });

  it('does NOT contain unsafe-eval', () => {
    const h = buildCspHeader(defaults);
    expect(h!).not.toContain('unsafe-eval');
  });

  it('does NOT contain strict-dynamic', () => {
    const h = buildCspHeader(defaults);
    expect(h!).not.toContain('strict-dynamic');
  });

  it('does NOT contain bare * as source value', () => {
    const h = buildCspHeader(defaults)!;
    for (const d of h.split(';').map((s: string) => s.trim())) {
      const srcs = d.split(/\s+/).slice(1);
      expect(srcs).not.toContain('*');
    }
  });

  // ── Directive coverage ─────────────────────────────────────────

  it('includes all required directives', () => {
    const h = buildCspHeader(defaults)!;
    for (const dir of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'connect-src',
      'media-src',
      'frame-ancestors',
      'form-action',
      'base-uri',
      'object-src',
    ]) {
      expect(h).toContain(dir);
    }
  });

  // ── LiveKit wss:// appears in connect-src ─────────────────────

  it('includes LiveKit wss:// origin in connect-src', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).toMatch(/connect-src[^;]*wss:\/\/meet\.example\.com/);
  });

  it('includes Supabase https:// origin in connect-src', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).toMatch(/connect-src[^;]*https:\/\/project\.supabase\.co/);
  });

  // ── Dev HMR ws:// ──────────────────────────────────────────────

  it('includes ws://localhost:5173 in connect-src when dev=true', () => {
    const h = buildCspHeader({ ...defaults, dev: true })!;
    expect(h).toContain('ws://localhost:5173');
  });

  it('omits ws://localhost when dev=false', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).not.toContain('ws://localhost');
  });

  // ── Supabase in media-src ──────────────────────────────────────

  it('includes Supabase https:// origin in media-src', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).toMatch(/media-src[^;]*https:\/\/project\.supabase\.co/);
  });

  // ── API origin in connect-src ──────────────────────────────────

  it('includes API origin in connect-src', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).toContain('http://localhost:8787');
  });

  // ── Report endpoint ────────────────────────────────────────────

  it('includes report-uri when configured', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).toContain('report-uri http://localhost:8787/api/csp-report');
  });

  it('omits report-uri when not configured', () => {
    const h = buildCspHeader({ ...defaults, reportEndpoint: undefined })!;
    expect(h).not.toContain('report-uri');
  });

  // ── Report endpoint normalization ─────────────────────────────

  it('normalizes default port :80 in report endpoint', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: 'http://localhost:80/api/csp-report',
    })!;
    // URL.origin strips :80 — the emitted value must NOT contain :80.
    expect(h).toContain('report-uri http://localhost/api/csp-report');
    expect(h).not.toContain('localhost:80');
  });

  it('normalizes default port :443 in report endpoint', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: 'https://example.com:443/report',
    })!;
    expect(h).toContain('report-uri https://example.com/report');
    expect(h).not.toContain('example.com:443');
  });

  it('strips whitespace from report endpoint', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: '  http://localhost:8787/api/csp-report  ',
    })!;
    expect(h).toContain('report-uri http://localhost:8787/api/csp-report');
  });

  // ── Malformed report endpoint → fail closed ───────────────────

  it('returns undefined for malformed report endpoint', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: 'not-a-url',
    });
    expect(h).toBeUndefined();
  });

  it('rejects report endpoint with credentials', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: 'http://user:pass@evil.com/report',
    });
    expect(h).toBeUndefined();
  });

  it('rejects report endpoint with query', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: 'http://example.com/report?token=abc',
    });
    expect(h).toBeUndefined();
  });

  it('rejects report endpoint with fragment', () => {
    const h = buildCspHeader({
      ...defaults,
      reportEndpoint: 'http://example.com/report#secret',
    });
    expect(h).toBeUndefined();
  });

  // ── Injection rejection ────────────────────────────────────────

  it('rejects semicolon injection in source', () => {
    expect(canonicalizeOrigin('http://localhost; script-src *;')).toBeUndefined();
  });

  it('rejects empty source', () => {
    expect(validateSources([''])).toHaveLength(1);
  });

  it('rejects control character in source', () => {
    expect(validateSources(['https://example.com\x00'])).toHaveLength(1);
  });

  // ── validateSources rejects banned keywords ────────────────────

  it('rejects unsafe-inline', () => {
    expect(validateSources(["'unsafe-inline'"])).toHaveLength(1);
  });

  it('rejects unsafe-eval', () => {
    expect(validateSources(["'unsafe-eval'"])).toHaveLength(1);
  });

  it('rejects strict-dynamic', () => {
    expect(validateSources(["'strict-dynamic'"])).toHaveLength(1);
  });

  it('rejects wildcard *', () => {
    expect(validateSources(['*'])).toHaveLength(1);
  });

  it('rejects unsafe-hashes', () => {
    expect(validateSources(["'unsafe-hashes'"])).toHaveLength(1);
  });

  it('rejects report-sample', () => {
    expect(validateSources(["'report-sample'"])).toHaveLength(1);
  });

  // ── validateSources accepts safe values ────────────────────────

  it('accepts valid https:// URL', () => {
    expect(validateSources(['https://example.com'])).toHaveLength(0);
  });

  it('accepts valid wss:// URL', () => {
    expect(validateSources(['wss://example.com:443'])).toHaveLength(0);
  });

  it('accepts safe CSP keywords', () => {
    expect(
      validateSources(["'self'", "'none'", 'data:', 'blob:']),
    ).toHaveLength(0);
  });

  it('rejects javascript: scheme', () => {
    expect(validateSources(['javascript:alert(1)'])).toEqual([
      'javascript:alert(1)',
    ]);
  });

  it('rejects ftp:// scheme', () => {
    expect(validateSources(['ftp://example.com'])).toEqual([
      'ftp://example.com',
    ]);
  });

  // ── validateReportEndpoint ─────────────────────────────────────

  it('validates absolute HTTP report endpoint with path', () => {
    expect(
      validateReportEndpoint('http://localhost:8787/api/csp-report'),
    ).toBe('http://localhost:8787/api/csp-report');
  });

  it('validates HTTPS report endpoint', () => {
    expect(validateReportEndpoint('https://example.com/report')).toBe(
      'https://example.com/report',
    );
  });

  it('rejects report endpoint with credentials', () => {
    expect(
      validateReportEndpoint('http://user:pass@evil.com/report'),
    ).toBeUndefined();
  });

  it('rejects report endpoint with query', () => {
    expect(
      validateReportEndpoint('http://example.com/report?token=abc'),
    ).toBeUndefined();
  });

  it('rejects report endpoint with fragment', () => {
    expect(
      validateReportEndpoint('http://example.com/report#secret'),
    ).toBeUndefined();
  });

  it('rejects report endpoint with semicolon injection', () => {
    expect(
      validateReportEndpoint('http://example.com/report;script-src unsa'),
    ).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(validateReportEndpoint(undefined)).toBeUndefined();
  });

  // ── buildCspHeader fails on invalid mode ───────────────────────

  it('buildCspHeader returns undefined for invalid mode', () => {
    const h = buildCspHeader({ ...defaults, mode: 'invalid' as any });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader returns undefined for non-HTTP API origin', () => {
    const h = buildCspHeader({
      ...defaults,
      apiOrigin: 'wss://api.example.com',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader returns undefined for non-WS LiveKit origin', () => {
    const h = buildCspHeader({
      ...defaults,
      livekitOrigin: 'https://meet.example.com',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader returns undefined for Supabase non-HTTP origin', () => {
    const h = buildCspHeader({
      ...defaults,
      supabaseOrigin: 'wss://db.example.com',
    });
    expect(h).toBeUndefined();
  });

  // ── buildCspHeader rejects non-canonical bypass ───────────────

  it('buildCspHeader rejects API origin with path', () => {
    const h = buildCspHeader({
      ...defaults,
      apiOrigin: 'http://localhost:8787/api',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader rejects API origin with query', () => {
    const h = buildCspHeader({
      ...defaults,
      apiOrigin: 'http://localhost:8787?foo=bar',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader rejects API origin with hash', () => {
    const h = buildCspHeader({
      ...defaults,
      apiOrigin: 'http://localhost:8787#secret',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader rejects API origin with credentials', () => {
    const h = buildCspHeader({
      ...defaults,
      apiOrigin: 'http://user:pass@localhost:8787',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader rejects Supabase origin with path', () => {
    const h = buildCspHeader({
      ...defaults,
      supabaseOrigin: 'https://project.supabase.co/rest',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader rejects LiveKit origin with path', () => {
    const h = buildCspHeader({
      ...defaults,
      livekitOrigin: 'wss://meet.example.com/room',
    });
    expect(h).toBeUndefined();
  });

  it('buildCspHeader accepts only canonical HTTPS → wss conversion for LiveKit', () => {
    // Supplying an HTTPS origin is NOT canonical to buildCspHeader —
    // the caller (plugin) must convert to wss:// first.
    const h = buildCspHeader({
      ...defaults,
      livekitOrigin: 'https://meet.example.com',
    });
    expect(h).toBeUndefined();
  });

  // ── object-src 'none' ──────────────────────────────────────────

  it('includes object-src none', () => {
    const h = buildCspHeader(defaults)!;
    expect(h).toContain("object-src 'none'");
  });
});
