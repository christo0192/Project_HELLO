/**
 * The app's own Vite config, adjusted for an unattended test run.
 *
 * - `server.hmr: false` and no file watching: the worktree may be edited while
 *   a run is in flight, and a hot update landing mid-test would re-render a
 *   page between an assertion and its screenshot. Each run starts a fresh
 *   server, so it serves one consistent snapshot of the source.
 * - A private `cacheDir`: a developer's `vite dev` in the same checkout keeps
 *   its own pre-bundled deps, and the two never race to rewrite one cache.
 * - `forwardConsole: false`: see below.
 * - `optimizeDeps.entries` covers every route module up front, so a lazily
 *   loaded page cannot discover a new dependency mid-test and force the
 *   "optimized dependencies changed, reloading" full-page reload.
 * - `resolve.alias` swaps `livekit-client` for a scripted stand-in
 *   (fixtures/mock-livekit-client.ts). Only the candidate pages import the SDK
 *   (they are lazy routes), so recruiter routes are unaffected. Capture stays
 *   real: the stand-in calls the browser's own getUserMedia, which the
 *   harness feeds from Chromium's fake camera and microphone.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from '../vite.config';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    cacheDir: 'node_modules/.vite-e2e',
    clearScreen: false,
    resolve: {
      alias: {
        'livekit-client': path.resolve(HERE, 'fixtures/mock-livekit-client.ts'),
      },
    },
    server: {
      hmr: false,
      watch: { ignored: ['**/*'] },
      // The harness already captures browser console errors per test, with
      // the test they belong to; Vite's unattributed copy is only noise.
      forwardConsole: false,
    },
    optimizeDeps: {
      entries: ['index.html', 'src/**/*.tsx', '!src/**/*.test.tsx', '!src/**/__tests__/**', '!src/test/**'],
    },
  }),
);
