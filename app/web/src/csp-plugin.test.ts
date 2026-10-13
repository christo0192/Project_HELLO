/**
 * vite-csp-plugin: the optional VITE_R1_RECORDINGS_ORIGIN reaches media-src and nothing else, and a
 * bad value stops the server instead of quietly changing the policy.
 *
 * The policy itself is unit-tested in app/api/src/__tests__/cors-csp.test.ts (it imports csp.ts);
 * this drives the plugin the way Vite does: `configResolved` reads the environment, then the
 * preview/dev middleware stamps the header on an HTML request.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import cspPlugin from '../vite-csp-plugin';

const R2 = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const R2_EU = 'https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com';

const KEYS = [
  'VITE_API_BASE',
  'VITE_SUPABASE_URL',
  'VITE_LIVEKIT_URL',
  'VITE_CSP_MODE',
  'VITE_CSP_REPORT_ENDPOINT',
  'VITE_R1_RECORDINGS_ORIGIN',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.VITE_API_BASE = 'http://localhost:8787';
  process.env.VITE_SUPABASE_URL = 'https://project.supabase.co';
  process.env.VITE_LIVEKIT_URL = 'wss://meet.example.com';
  process.env.VITE_CSP_MODE = 'report-only';
  delete process.env.VITE_CSP_REPORT_ENDPOINT;
  delete process.env.VITE_R1_RECORDINGS_ORIGIN;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The two hooks this test drives, as plain functions (Vite's own types allow object hooks too). */
interface Hooks {
  configResolved(resolved: unknown): void;
  configureServer(server: unknown): void;
}

/** Resolve the config and return the header the dev/preview server would send on an HTML request. */
function headerFor(): string {
  const plugin = cspPlugin() as unknown as Hooks;
  const root = mkdtempSync(join(tmpdir(), 'csp-plugin-'));
  plugin.configResolved({ mode: 'development', root, server: { port: 5173 } });

  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null = null;
  plugin.configureServer({
    middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
  });
  const headers: Record<string, string> = {};
  middleware!({ url: '/', headers: { accept: 'text/html' } }, { setHeader: (k: string, v: string) => (headers[k] = v) }, () => undefined);
  const value = headers['Content-Security-Policy-Report-Only'];
  expect(value, 'the report-only header was sent').toBeTruthy();
  return value;
}

const directive = (header: string, name: string) =>
  header.split(';').map((s) => s.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('VITE_R1_RECORDINGS_ORIGIN', () => {
  it('absent leaves the policy exactly as it was', () => {
    const base = headerFor();
    expect(base).not.toContain('r2.cloudflarestorage.com');
    expect(directive(base, 'media-src')).toBe("media-src 'self' blob: https://project.supabase.co");
  });

  it('blank, whitespace and stray commas count as absent', () => {
    const base = headerFor();
    for (const blank of ['', '   ', ',', ' , , ']) {
      process.env.VITE_R1_RECORDINGS_ORIGIN = blank;
      expect(headerFor(), JSON.stringify(blank)).toBe(base);
    }
  });

  it('one origin goes to media-src only', () => {
    const base = headerFor();
    process.env.VITE_R1_RECORDINGS_ORIGIN = R2;
    const h = headerFor();
    expect(directive(h, 'media-src')).toBe(`media-src 'self' blob: https://project.supabase.co ${R2}`);
    expect(directive(h, 'connect-src')).not.toContain('r2.cloudflarestorage.com');
    const without = (x: string) => x.split('; ').filter((d) => !d.startsWith('media-src ')).join('; ');
    expect(without(h)).toBe(without(base));
  });

  it('a comma list (default and jurisdiction hosts), trimmed and de-duplicated', () => {
    process.env.VITE_R1_RECORDINGS_ORIGIN = ` ${R2} , ${R2_EU},${R2}/ `;
    expect(directive(headerFor(), 'media-src')).toBe(
      `media-src 'self' blob: https://project.supabase.co ${R2} ${R2_EU}`,
    );
  });

  it.each([
    ['a non-https scheme', 'http://account.r2.cloudflarestorage.com'],
    ['a websocket origin', 'wss://account.r2.cloudflarestorage.com'],
    ['a wildcard host', 'https://*.r2.cloudflarestorage.com'],
    ['a bare wildcard', '*'],
    ['credentials', 'https://user:pass@account.r2.cloudflarestorage.com'],
    ['a path', 'https://account.r2.cloudflarestorage.com/r1/'],
    ['a query', 'https://account.r2.cloudflarestorage.com?x=1'],
    ['not a URL', 'not a url'],
    ['one good and one bad', `${R2}, http://insecure.example`],
  ])('stops the server on %s, rather than widening or dropping the policy', (_why, value) => {
    process.env.VITE_R1_RECORDINGS_ORIGIN = value;
    expect(() => headerFor()).toThrow(/VITE_R1_RECORDINGS_ORIGIN must be a comma list of canonical https/);
  });
});
