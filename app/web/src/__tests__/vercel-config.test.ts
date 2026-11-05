/**
 * app/web/vercel.json is production routing and nothing else checks it: CI
 * never deploys, and the CSP smoke test drives `vite preview`.
 *
 * Vercel reads `headers` before it looks at the filesystem and `rewrites` only
 * after the filesystem misses (@vercel/routing-utils getTransformedRoutes), so
 * for a real file only `headers` applies and for a missing one the first
 * matching rewrite wins. These sources use nothing path-to-regexp treats
 * differently from a plain regular expression, so they are compiled directly.
 *
 * Because `headers` run before the filesystem check, the 404 for a missing
 * /assets/ file carries the year-long immutable header too. A browser may keep
 * that 404, which only matters if the same hashed URL comes back: after a
 * rollback or revert, clearing site data is the fix on that browser.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '../..');

interface VercelConfig {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  rewrites?: Array<{ source: string; destination: string }>;
}

const config = JSON.parse(readFileSync(resolve(WEB_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

const matches = (source: string, path: string): boolean => new RegExp(`^${source}$`, 'i').test(path);

/** The Cache-Control this config adds to a response for `path`, if any. */
function cacheControl(path: string): string | undefined {
  return (config.headers ?? [])
    .filter((rule) => matches(rule.source, path))
    .flatMap((rule) => rule.headers)
    .find((header) => header.key.toLowerCase() === 'cache-control')?.value;
}

/** Where a path with no file behind it goes, or null for the platform's 404. */
function afterFilesystemMiss(path: string): string | null {
  const rewrite = (config.rewrites ?? []).find((rule) => matches(rule.source, path));
  if (!rewrite) return null;
  const captured = new RegExp(`^${rewrite.source}$`, 'i').exec(path);
  return rewrite.destination.replace('$1', captured?.[1] ?? '');
}

describe('app/web/vercel.json', () => {
  describe('hashed assets', () => {
    it('are cacheable for a year and never revalidated', () => {
      for (const path of ['/assets/index-rhdJljo5.js', '/assets/index-abc123.css', '/assets/inter-latin-400.woff2']) {
        expect(cacheControl(path)).toBe('public, max-age=31536000, immutable');
      }
    });

    it('leave everything that is not under /assets/ to revalidate, above all index.html', () => {
      for (const path of ['/', '/index.html', '/dashboard', '/favicon.svg', '/ik-logo.png', '/assets', '/assets-old/x.js']) {
        expect(cacheControl(path)).toBeUndefined();
      }
    });

    it('are all really hashed: no unhashed file can land under /assets/', () => {
      // `public/` is copied to the output as is, with no hash in the name.
      expect(existsSync(resolve(WEB_ROOT, 'public/assets'))).toBe(false);
      // Vite's default names carry the content hash; overriding them must keep it.
      expect(readFileSync(resolve(WEB_ROOT, 'vite.config.ts'), 'utf8')).not.toMatch(
        /assetsDir|assetFileNames|chunkFileNames|entryFileNames/,
      );
    });
  });

  describe('a path with no file behind it', () => {
    it('is a 404 under /assets/, so a stale tab never gets index.html as a chunk', () => {
      for (const path of ['/assets/CandidatesPage-gone1234.js', '/assets/nested/gone.css', '/assets/', '/ASSETS/gone.js']) {
        expect(afterFilesystemMiss(path)).toBeNull();
      }
    });

    it('still reaches the app for every other path', () => {
      for (const path of [
        '/',
        '/dashboard',
        '/candidates/11111111-1111-4111-8111-111111111111',
        '/mfa/enroll',
        '/privacy-notice',
        // A route that merely starts with the word is not an asset.
        '/assets',
        '/assets-old/x.js',
        '/assetsfoo',
      ]) {
        expect(afterFilesystemMiss(path)).toBe('/index.html');
      }
    });

    it('still proxies /api/ to the API on Fly, whole path included', () => {
      expect(afterFilesystemMiss('/api/me')).toBe('https://project-hello-api.fly.dev/api/me');
      expect(afterFilesystemMiss('/api/candidates/summary')).toBe('https://project-hello-api.fly.dev/api/candidates/summary');
    });
  });
});
