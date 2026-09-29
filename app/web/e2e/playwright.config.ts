/**
 * Offline Playwright harness for the recruiter/admin web app.
 *
 * Boots the REAL app on the Vite dev server (with mock backend origins in its
 * env) and drives it signed in as a fabricated admin, with every backend
 * request answered by synthetic fixtures — see e2e/fixtures/harness.ts.
 *
 *   npm run e2e         checks: heading, console, mocks, mobile overflow, axe
 *   npm run e2e:shots   full-page screenshots of every route + key state
 *
 * Artifacts (gitignored) land in e2e/.artifacts/.
 */
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { ARTIFACTS_DIR } from './fixtures/axe';
import { E2E_LOCALE, E2E_TIMEZONE, viteEnv } from './fixtures/env';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const ARTIFACTS = ARTIFACTS_DIR;

/** Ask the OS for a free port (bind to 0, read it back, release it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

// Chosen ONCE, in the runner process, and published through the environment:
// Playwright re-evaluates this file in every worker, and workers inherit the
// runner's env, so they all agree on the port the runner's dev server uses.
// Set E2E_PORT yourself to pin it.
process.env.E2E_PORT ??= String(await freePort());
const PORT = Number(process.env.E2E_PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: HERE,
  // `.e2e.ts`, never `.test.ts`/`.spec.ts`: vitest only collects src/**/*.test.*.
  testMatch: /.*\.e2e\.ts$/,
  outputDir: path.join(ARTIFACTS, 'test-results'),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Dev-server transforms are the bottleneck; more workers than this just queue.
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(ARTIFACTS, 'html-report'), open: 'never' }],
    ['json', { outputFile: path.join(ARTIFACTS, 'results.json') }],
  ],
  globalSetup: path.join(HERE, 'fixtures', 'global-setup.ts'),
  globalTeardown: path.join(HERE, 'fixtures', 'global-teardown.ts'),
  use: {
    baseURL: BASE_URL,
    locale: E2E_LOCALE,
    timezoneId: E2E_TIMEZONE,
    // Stable screenshots: Motion and the CSS reveal both collapse under this.
    reducedMotion: 'reduce',
    // The dev server sends a report-only CSP that flags Vite's own injected
    // <style> tags — dev-only artefacts that never ship. CSP is covered by
    // src/csp.ts's unit tests; here it would only be noise in the console.
    bypassCSP: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      // A Chromium phone (touch, mobile UA, meta-viewport honoured) at the
      // 390 × 844 CSS-pixel size of today's most common handsets.
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    // `--no-install`: run the vite pinned in node_modules or FAIL — never let
    // npx fetch and execute whatever `vite` the registry serves today (the
    // "npx canceled due to missing packages" error means: run `npm ci`).
    command: `npx --no-install vite --config e2e/vite.e2e.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: WEB_ROOT,
    url: BASE_URL,
    // Always a fresh server on a fresh port: never reuse a developer's
    // `vite dev`, which would carry real backend URLs.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: viteEnv(),
  },
});
