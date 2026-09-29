/**
 * The `app` fixture: a real page of the real app, signed in as an admin,
 * with every byte of backend traffic answered locally.
 *
 * Installed automatically for every test (`auto: true`), in this order:
 *   1. the browser clock is frozen at FROZEN_NOW (deterministic dates);
 *   2. a Supabase session is seeded into localStorage (see supabase.ts);
 *   3. WebSockets (which `page.route` never sees) get their own guard:
 *        - the Vite dev server's socket   → connected through untouched
 *        - the mock Supabase Realtime     → answered in-process (supabase.ts)
 *        - anything else                  → CLOSED and recorded as external
 *   4. ONE request interceptor classifies every HTTP request by origin:
 *        - the Vite dev server            → passed through untouched
 *        - the mock API origin            → answered by api-router.ts
 *        - the mock Supabase origin       → answered by supabase.ts
 *        - anything else                  → ABORTED and recorded
 *   5. console errors and uncaught page errors are collected.
 *
 * FAILING LOUDLY. An API or Supabase request no mock recognises is answered
 * `500 {"error":"E2E unmocked endpoint: …"}`, printed to the runner output
 * and recorded; a request or WebSocket to any other host is blocked and
 * recorded. Either one fails the test at teardown even if the test itself
 * never looked — so a screenshot run cannot quietly capture a page that
 * rendered an empty state because its data never arrived.
 */

import { test as base, expect, type Page, type Route, type TestInfo } from '@playwright/test';
import { routeApi } from './api-router';
import { createDataset, type Dataset } from './data';
import { FROZEN_NOW_MS, MOCK_API_ORIGIN, MOCK_SUPABASE_ORIGIN } from './env';
import { ACCESS_TOKEN, mockRealtime, seedAdminSession, supabaseReply } from './supabase';

export interface RecordedCall {
  method: string;
  /** Origin-relative path + query, e.g. `/api/candidates?role_id=…`. */
  url: string;
  status: number;
  mocked: boolean;
  /** Whether the request carried `Authorization: Bearer <the seeded session's access token>`. */
  authorized: boolean;
}

export interface AppHarness {
  page: Page;
  /** This page's private copy of the synthetic world (mutable). */
  db: Dataset;
  /** Every API + Supabase request, in order. */
  calls: RecordedCall[];
  /** Requests no mock recognised (answered 500). */
  unmocked: RecordedCall[];
  /**
   * Requests (`GET https://…`) and WebSockets (`WEBSOCKET wss://…`) to hosts
   * that are neither the dev server nor a mock (blocked).
   */
  external: string[];
  /** `console.error` messages and uncaught page errors. */
  consoleErrors: string[];
  /** Navigate and wait until the route has finished loading its data. */
  goto(path: string): Promise<void>;
  /** Wait for network quiet and for every loading indicator to disappear. */
  settle(): Promise<void>;
  /** Assert no console errors, no unmocked calls and no external requests. */
  expectHealthy(): void;
}

const CORS_HEADERS = (route: Route): Record<string, string> => {
  const req = route.request().headers();
  return {
    'access-control-allow-origin': req['origin'] ?? '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    // Echo what the preflight asked for: `*` does not cover `Authorization`.
    'access-control-allow-headers': req['access-control-request-headers'] ?? 'authorization,content-type,apikey,x-client-info',
    'access-control-expose-headers': 'content-range',
  };
};

function parseBody(route: Route): Record<string, unknown> | null {
  const raw = route.request().postData();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // multipart (resume upload) — handlers do not need it
  }
}

/**
 * A page is "settled" when no element announces that it is still loading.
 * Keyed on what the app renders rather than on timers: `LoadingPanel` is a
 * `role="status"` reading "Loading…"/"Checking…", and skeleton cards carry
 * `aria-busy="true"`.
 */
async function waitForLoadingIndicators(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const nodes = Array.from(document.querySelectorAll('[role="status"], [aria-busy="true"]'));
      return !nodes.some((el) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return false; // hidden / sr-only live regions
        if (el.getAttribute('aria-busy') === 'true') return true;
        return /^(loading|checking)\b/i.test((el.textContent ?? '').trim());
      });
    },
    undefined,
    { timeout: 15_000 },
  );
}

async function installHarness(page: Page, testInfo: TestInfo): Promise<AppHarness> {
  const db = createDataset();
  const calls: RecordedCall[] = [];
  const unmocked: RecordedCall[] = [];
  const external: string[] = [];
  const consoleErrors: string[] = [];
  const baseOrigin = new URL(String(testInfo.project.use.baseURL)).origin;
  const baseHost = new URL(baseOrigin).host;

  await page.clock.setFixedTime(new Date(FROZEN_NOW_MS));
  await seedAdminSession(page);

  // WebSockets bypass `page.route` entirely, so they get their own guard.
  // ORDER MATTERS: for a WebSocket, Playwright runs only the MOST RECENTLY
  // registered route whose pattern matches (`page.routeWebSocket` unshifts
  // onto the page's route list and dispatch takes the first match — see
  // playwright-core's client Page; proved by the "Realtime mock wins" harness
  // self-check). So this catch-all is registered FIRST and the specific
  // Realtime mock AFTER it: the mock answers its URL, everything else lands here.
  await page.routeWebSocket(/.*/, async (ws) => {
    // The dev server's own socket (Vite's client) passes, like its HTTP does.
    if (new URL(ws.url()).host === baseHost) {
      ws.connectToServer();
      return;
    }
    external.push(`WEBSOCKET ${ws.url()}`);
    console.warn(`[e2e] BLOCKED external WebSocket: ${ws.url()}`);
    // Never connected to the real server: the page sees its socket closed.
    await ws.close({ code: 1008, reason: 'E2E: external WebSocket blocked' });
  });
  await mockRealtime(page);

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseOrigin) return route.continue();

    const isApi = url.origin === MOCK_API_ORIGIN;
    const isSupabase = url.origin === MOCK_SUPABASE_ORIGIN;
    if (!isApi && !isSupabase) {
      external.push(`${request.method()} ${url.href}`);
      console.warn(`[e2e] BLOCKED external request: ${request.method()} ${url.href}`);
      return route.abort('blockedbyclient');
    }

    const method = request.method();
    const relative = `${url.pathname}${url.search}`;
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS(route) });
    }
    // THE seeded token, not merely some bearer: a call carrying a stale or
    // anon-key bearer would otherwise read as signed in.
    const authorized = request.headers()['authorization'] === `Bearer ${ACCESS_TOKEN}`;

    const reply = isApi ? routeApi(method, url, parseBody(route), db) : supabaseReply(method, url);
    if (!reply) {
      const call = { method, url: `${url.origin}${relative}`, status: 500, mocked: false, authorized };
      calls.push(call);
      unmocked.push(call);
      console.error(`[e2e] UNMOCKED endpoint: ${method} ${url.origin}${relative}`);
      return route.fulfill({
        status: 500,
        headers: CORS_HEADERS(route),
        contentType: 'application/json',
        body: JSON.stringify({ error: `E2E unmocked endpoint: ${method} ${relative}` }),
      });
    }

    calls.push({ method, url: `${url.origin}${relative}`, status: reply.status, mocked: true, authorized });
    const headers = { ...CORS_HEADERS(route), ...('headers' in reply ? reply.headers : {}) };
    if (reply.status === 204) return route.fulfill({ status: 204, headers });
    if ('text' in reply && reply.text !== undefined) {
      return route.fulfill({ status: reply.status, headers, contentType: reply.contentType ?? 'text/plain', body: reply.text });
    }
    return route.fulfill({ status: reply.status, headers, contentType: 'application/json', body: JSON.stringify(reply.json ?? null) });
  });

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`Uncaught: ${error.message}`));

  const harness: AppHarness = {
    page,
    db,
    calls,
    unmocked,
    external,
    consoleErrors,
    async goto(path: string) {
      await page.goto(path);
      await harness.settle();
    },
    async settle() {
      await page.waitForLoadState('networkidle');
      await waitForLoadingIndicators(page);
      // Two frames: let the last data-driven render and layout flush.
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    },
    expectHealthy() {
      expect.soft(unmocked, 'API/Supabase requests with no mock (answered 500)').toEqual([]);
      expect.soft(external, 'requests to hosts outside the dev server and mocks (aborted)').toEqual([]);
      expect.soft(consoleErrors, 'console errors / uncaught page errors').toEqual([]);
    },
  };
  return harness;
}

export const test = base.extend<{ app: AppHarness }>({
  app: [
    async ({ page }, use, testInfo) => {
      const harness = await installHarness(page, testInfo);
      await use(harness);

      // Diagnostics ride along with every test result.
      await testInfo.attach('api-calls.json', { body: JSON.stringify(harness.calls, null, 2), contentType: 'application/json' });
      if (harness.consoleErrors.length) {
        await testInfo.attach('console-errors.txt', { body: harness.consoleErrors.join('\n\n'), contentType: 'text/plain' });
        // An unexpected failure usually IS a console error (a render crash
        // behind an error boundary); print it where the runner output shows.
        if (testInfo.status !== testInfo.expectedStatus) {
          console.log(`[e2e] console errors in "${testInfo.title}" (${testInfo.project.name}):\n${harness.consoleErrors.map((e) => `  ${e.split('\n')[0]}`).join('\n')}`);
        }
      }
      // Loud by construction: a gap in the mocks fails the test even when the
      // test body never asserted on it (e.g. a screenshot-only test).
      if (harness.unmocked.length || harness.external.length) {
        throw new Error(
          [
            'The page made requests the offline harness does not answer:',
            ...harness.unmocked.map((c) => `  UNMOCKED ${c.method} ${c.url}`),
            ...harness.external.map((u) => `  EXTERNAL ${u}`),
            'Add a row to e2e/fixtures/api-router.ts (or supabase.ts) for each.',
          ].join('\n'),
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
