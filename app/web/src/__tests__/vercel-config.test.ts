/**
 * app/web/vercel.json is production routing and nothing else checks it: CI
 * never deploys, and the CSP smoke test drives `vite preview`.
 *
 * It uses `routes`, not `headers` plus `rewrites`, because a missing /assets/
 * file must answer differently from a real one. Vercel applies `headers` before
 * its filesystem check, so with that form the 404 for a missing chunk carries
 * the year-long immutable header. A browser keeps that 404 and fails the import
 * from its cache, so after a rollback or revert brings the same hashed URL back,
 * reload cannot recover the page. Only a rule after `handle: filesystem` can set
 * the miss apart. Vercel's vercel.json docs list `handle` as deprecated, but it
 * is what `rewrites` compile to (@vercel/routing-utils getTransformedRoutes).
 *
 * The /api and app rules are what the earlier `rewrites` compiled to, so the
 * only new behaviour is the 404 rule. `resolve` below walks the routes the way
 * Vercel does, for the parts this config uses; it does not prove what Vercel
 * itself answers. After changing this file check a preview with `curl -I`: a
 * real chunk is immutable, a missing one is 404 and no-store, /api and app paths
 * still work.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolvePath(__dirname, '../..');
const YEAR_IMMUTABLE = 'public, max-age=31536000, immutable';

type Route =
  | { handle: string }
  | { src: string; dest?: string; status?: number; headers?: Record<string, string>; continue?: boolean; check?: boolean };

interface VercelConfig {
  routes: Route[];
  headers?: unknown;
  rewrites?: unknown;
}

const config = JSON.parse(readFileSync(resolvePath(WEB_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

interface Outcome {
  /** True when the file on disk is what gets served. */
  servedFile: boolean;
  status?: number;
  dest?: string;
  cacheControl?: string;
}

/** What this config answers for `path`, given whether a file exists there. */
function resolve(path: string, { fileExists }: { fileExists: boolean }): Outcome {
  let cacheControl: string | undefined;
  for (const route of config.routes) {
    if ('handle' in route) {
      expect(route.handle).toBe('filesystem');
      if (fileExists) return { servedFile: true, cacheControl };
      continue;
    }
    // Vercel matches `src` without regard to case unless a route opts out.
    const match = new RegExp(route.src, 'i').exec(path);
    if (!match) continue;
    for (const [key, value] of Object.entries(route.headers ?? {})) {
      if (key.toLowerCase() === 'cache-control') cacheControl = value;
    }
    if (route.continue) continue;
    return { servedFile: false, status: route.status, dest: route.dest?.replace('$1', match[1] ?? ''), cacheControl };
  }
  return { servedFile: false, cacheControl };
}

describe('app/web/vercel.json', () => {
  it('keeps every rule in `routes`, the only form with a rule after the filesystem check', () => {
    expect(config.headers).toBeUndefined();
    expect(config.rewrites).toBeUndefined();
    expect(config.routes.filter((route) => 'handle' in route)).toEqual([{ handle: 'filesystem' }]);
  });

  describe('a file that exists', () => {
    it('under /assets/ is cacheable for a year and never revalidated', () => {
      for (const path of ['/assets/index-rhdJljo5.js', '/assets/index-abc123.css', '/assets/inter-latin-400.woff2']) {
        expect(resolve(path, { fileExists: true })).toEqual({ servedFile: true, cacheControl: YEAR_IMMUTABLE });
      }
    });

    it('anywhere else is left to revalidate, above all index.html', () => {
      for (const path of ['/', '/index.html', '/favicon.svg', '/ik-logo.png', '/assets-old/x.js']) {
        expect(resolve(path, { fileExists: true })).toEqual({ servedFile: true, cacheControl: undefined });
      }
    });

    it('under /assets/ is always hashed: no unhashed file can land there', () => {
      // `public/` is copied to the output as is, with no hash in the name.
      expect(existsSync(resolvePath(WEB_ROOT, 'public/assets'))).toBe(false);
      // Vite's default names carry the content hash; overriding them must keep it.
      expect(readFileSync(resolvePath(WEB_ROOT, 'vite.config.ts'), 'utf8')).not.toMatch(
        /assetsDir|assetFileNames|chunkFileNames|entryFileNames/,
      );
    });
  });

  describe('a path with no file behind it', () => {
    const MISSING_ASSETS = ['/assets/CandidatesPage-gone1234.js', '/assets/nested/gone.css', '/assets/', '/ASSETS/gone.js'];

    it('is a 404 under /assets/, so a stale tab never gets index.html as a chunk', () => {
      for (const path of MISSING_ASSETS) {
        const outcome = resolve(path, { fileExists: false });
        expect(outcome.status).toBe(404);
        expect(outcome.dest).toBeUndefined();
      }
    });

    it('under /assets/ is never stored, so the chunk loads again once a rollback restores it', () => {
      for (const path of MISSING_ASSETS) {
        expect(resolve(path, { fileExists: false }).cacheControl).toBe('no-store');
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
        expect(resolve(path, { fileExists: false })).toEqual({
          servedFile: false,
          status: undefined,
          dest: '/index.html',
          cacheControl: undefined,
        });
      }
    });

    it('still proxies /api/ to the API on Fly, whole path included, adding no cache header', () => {
      for (const [path, dest] of [
        ['/api/me', 'https://project-hello-api.fly.dev/api/me'],
        ['/api/candidates/summary', 'https://project-hello-api.fly.dev/api/candidates/summary'],
      ]) {
        expect(resolve(path, { fileExists: false })).toEqual({ servedFile: false, status: undefined, dest, cacheControl: undefined });
      }
    });
  });
});
