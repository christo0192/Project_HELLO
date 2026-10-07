/**
 * Offline UI checks for every recruiter/admin route and key state.
 *
 * The app under test is the REAL app on the Vite dev server; only its
 * backends are fake (see fixtures/harness.ts). Every case asserts that:
 *   - the route's <h1> and a data-dependent landmark render;
 *   - nothing was logged as an error and no request escaped the mocks;
 *   - at 390 px (the `mobile` project) the page never scrolls sideways;
 *   - axe finds nothing blocking — STRICTLY (serious/critical fail the test)
 *     for every key state, the surfaces the redesign rebuilt; REPORTED to
 *     .artifacts/axe-summary.json for the legacy routes unless
 *     E2E_AXE_STRICT=1 (see fixtures/axe.ts).
 *
 * A route flagged `knownIssue` runs a PINNED defect check instead: it must
 * fail in exactly the recorded way and no other (see `KnownDefect` in
 * fixtures/routes.ts).
 *
 * The `.e2e.ts` suffix keeps these out of vitest (`src/**\/*.test.*`).
 */

import type { Page } from '@playwright/test';
import { auditA11y } from './fixtures/axe';
import { MOCK_API_ORIGIN, MOCK_SUPABASE_ORIGIN } from './fixtures/env';
import { KEY_STATES, openRoute, revealAddMetric } from './fixtures/flows';
import { horizontalOverflow } from './fixtures/layout';
import { expect, test } from './fixtures/harness';
import { ERROR_BOUNDARY_TEXT, ROUTES } from './fixtures/routes';
import { REALTIME_PATH } from './fixtures/supabase';

interface WebSocketProbe {
  /** The first frame the socket received, JSON-parsed. */
  message?: unknown;
  /** How the socket closed, if it closed before any frame arrived. */
  closed?: { code: number; reason: string };
  timedOut?: true;
}

/**
 * Open a WebSocket FROM THE PAGE (so it goes through the harness's WebSocket
 * routes, exactly as the app's own would), optionally send one frame once it
 * opens, and report the first thing that happens to it.
 */
function probeWebSocket(page: Page, url: string, firstFrame: unknown = null): Promise<WebSocketProbe> {
  return page.evaluate(
    ([target, frame]) =>
      new Promise<WebSocketProbe>((resolve) => {
        const ws = new WebSocket(target);
        const timer = setTimeout(() => resolve({ timedOut: true }), 5_000);
        ws.addEventListener('open', () => {
          if (frame !== null) ws.send(JSON.stringify(frame));
        });
        ws.addEventListener('message', (event) => {
          clearTimeout(timer);
          resolve({ message: JSON.parse(String(event.data)) as unknown });
          ws.close();
        });
        ws.addEventListener('close', (event) => {
          clearTimeout(timer);
          resolve({ closed: { code: event.code, reason: event.reason } });
        });
      }),
    [url, firstFrame] as const,
  );
}

test.describe('recruiter/admin routes', () => {
  for (const route of ROUTES) {
    const defect = route.knownIssue;

    if (defect) {
      // PINNED KNOWN DEFECT — deliberately NOT `test.fail`, which would accept
      // ANY failure (a different crash, an auth redirect, an unmocked call).
      // This passes only while the route fails in exactly the recorded way.
      // When the v2 session crash is fixed (a follow-up PR), this test turns
      // RED on purpose: remove `knownIssue` from the route in routes.ts and
      // it runs the full route checks below again.
      test(`${route.name} (${route.path}) — pinned known defect`, async ({ app, page }, testInfo) => {
        testInfo.annotations.push({ type: 'known defect', description: defect.reason });

        await app.goto(route.path);
        // Not bounced elsewhere (e.g. to sign-in): the crash is the route's own.
        expect(new URL(page.url()).pathname, 'the route must not redirect').toBe(new URL(route.path, page.url()).pathname);
        await expect(
          page.getByRole('alert').filter({ hasText: ERROR_BOUNDARY_TEXT }),
          'the pinned crash must land in the error boundary — if the page now renders, the defect is fixed: remove `knownIssue`',
        ).toBeVisible();
        await expect
          .poll(() => app.consoleErrors.filter((e) => defect.consoleError.test(e)).length, {
            message: `the console must carry the pinned error ${defect.consoleError}`,
          })
          .toBeGreaterThan(0);

        // Clear ONLY the pinned error, now that it has been seen. Any other
        // console error stays and fails `expectHealthy`, as do unmocked calls
        // and external requests (the fixture's teardown checks those too).
        const others = app.consoleErrors.filter((e) => !defect.consoleError.test(e));
        app.consoleErrors.splice(0, app.consoleErrors.length, ...others);
        app.expectHealthy();
      });
      continue;
    }

    test(`${route.name} (${route.path})`, async ({ app, page }, testInfo) => {
      // Asserts redirect target, <h1> and data landmark on the way in.
      await openRoute(app, route);

      if (testInfo.project.name === 'mobile') {
        expect(await horizontalOverflow(page), 'the page must not scroll sideways at 390 px').toEqual({ overflowPx: 0, offenders: [] });
      }

      // Legacy route: report-only unless E2E_AXE_STRICT=1.
      await auditA11y(page, testInfo, route.name);

      app.expectHealthy();
    });
  }
});

/**
 * The harness's own guarantees, seeded deliberately — the same idea as
 * src/test/SeededViolation.test.tsx for axe: if one of these stops tripping,
 * every green result above is worth less. Each clears what it seeded so the
 * fixture's teardown does not (correctly) fail the test.
 */
test.describe('harness self-checks', () => {
  test('an unmocked API endpoint is answered 500 and recorded', async ({ app, page }) => {
    await app.goto('/dashboard');
    const status = await page.evaluate(async (url) => (await fetch(url)).status, `${MOCK_API_ORIGIN}/api/definitely-not-an-endpoint`);
    expect(status).toBe(500);
    expect(app.unmocked.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /api/definitely-not-an-endpoint']);
    app.unmocked.length = 0;
    app.consoleErrors.length = 0; // the browser logs the 500 itself
  });

  test('a request to any other host is blocked and recorded', async ({ app, page }) => {
    await app.goto('/dashboard');
    const outcome = await page.evaluate(() => fetch('https://example.org/beacon').then(() => 'reached', () => 'blocked'));
    expect(outcome).toBe('blocked');
    expect(app.external).toEqual(['GET https://example.org/beacon']);
    app.external.length = 0;
    app.consoleErrors.length = 0;
  });

  test('a WebSocket to any other host is blocked and recorded', async ({ app, page }) => {
    await app.goto('/dashboard');
    // `page.route` never sees WebSockets; this is the separate catch-all's job.
    const probe = await probeWebSocket(page, 'wss://example.org/socket');
    expect(probe, 'the page must see its socket closed by the harness, never connected').toEqual({
      closed: { code: 1008, reason: 'E2E: external WebSocket blocked' },
    });
    // Recorded exactly like an external HTTP request: `app.external` is what
    // `expectHealthy` and the fixture's teardown fail the test on.
    expect(app.external).toEqual(['WEBSOCKET wss://example.org/socket']);
    app.external.length = 0;
    app.consoleErrors.length = 0;
  });

  test('the Realtime mock takes precedence over the WebSocket guard, and only on the mock host', async ({ app, page }) => {
    await app.goto('/dashboard');
    // The guard (`/.*/`) also matches this URL. The mock answering proves the
    // later-registered route wins, as harness.ts relies on.
    const join = ['1', '1', 'realtime:e2e-self-check', 'phx_join', { config: {} }];
    const mocked = await probeWebSocket(page, `${MOCK_SUPABASE_ORIGIN.replace(/^http/, 'ws')}${REALTIME_PATH}?vsn=2.0.0`, join);
    expect(mocked).toEqual({ message: ['1', '1', 'realtime:e2e-self-check', 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }] });
    expect(app.external, 'the mock Realtime socket is not external').toEqual([]);

    // The same path on any other host is not the mock's to answer.
    const foreign = `wss://realtime.example.org${REALTIME_PATH}?vsn=2.0.0`;
    const blocked = await probeWebSocket(page, foreign, join);
    expect(blocked).toEqual({ closed: { code: 1008, reason: 'E2E: external WebSocket blocked' } });
    expect(app.external).toEqual([`WEBSOCKET ${foreign}`]);
    app.external.length = 0;
    app.consoleErrors.length = 0;
  });

  test('console errors are captured', async ({ app, page }) => {
    await app.goto('/dashboard');
    await page.evaluate(() => console.error('seeded console error'));
    await expect.poll(() => app.consoleErrors).toContain('seeded console error');
    app.consoleErrors.length = 0;
  });

  test('the fabricated session is an admin whose calls carry the bearer token', async ({ app, page }) => {
    await app.goto('/mission-control');
    await expect(page.getByRole('link', { name: 'Ashby Live Jobs' })).toBeVisible();

    // The seeded token claims admin…
    const claims = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k));
      const session = key ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }) : {};
      const [, payload] = (session.access_token ?? '..').split('.');
      return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    });
    expect(claims).toMatchObject({ aal: 'aal2', app_role: 'admin', app_metadata: { role: 'admin' } });

    // …but claims alone prove nothing about the APP: it must have sent that
    // token and been answered. The product role comes from `GET /api/me`.
    const apiCalls = app.calls.filter((c) => c.url.startsWith(`${MOCK_API_ORIGIN}/api/`));
    const me = apiCalls.filter((c) => c.method === 'GET' && new URL(c.url).pathname === '/api/me');
    expect(me.length, 'the app must ask GET /api/me for the role').toBeGreaterThan(0);
    expect(
      me.map(({ status, authorized }) => ({ status, authorized })),
      'GET /api/me must carry the seeded bearer token and be answered 200',
    ).toEqual(me.map(() => ({ status: 200, authorized: true })));
    expect(
      apiCalls.filter((c) => !c.authorized).map((c) => `${c.method} ${c.url}`),
      'API calls sent without the seeded session\'s bearer token',
    ).toEqual([]);
    app.expectHealthy();
  });
});

test.describe('key states', () => {
  for (const state of KEY_STATES) {
    test(state.name, async ({ app, page }, testInfo) => {
      test.skip(Boolean(state.mobileOnly) && testInfo.project.name !== 'mobile', 'mobile-only state');

      const subject = await state.run(app);
      await expect(subject).toBeVisible();

      if (testInfo.project.name === 'mobile' && state.fullPage) {
        expect(await horizontalOverflow(page), 'the page must not scroll sideways at 390 px').toEqual({ overflowPx: 0, offenders: [] });
      }

      // Redesigned surface: ALWAYS strict — a serious/critical violation fails.
      await auditA11y(page, testInfo, `state-${state.name}`, { strict: true });

      app.expectHealthy();
    });
  }

  test('Scorebar lists the metric library and authors four-level rubrics', async ({ app }) => {
    expect(app.db.metrics.length, 'the fixture library must hold at least 7 metrics').toBeGreaterThanOrEqual(7);
    const drawer = await KEY_STATES.find((s) => s.name === 'roles-scorebar-top')!.run(app);
    await expect(drawer.getByText(`${app.db.metrics.length} metrics`, { exact: true })).toBeVisible();
    for (const metric of app.db.metrics) {
      await expect(drawer.getByText(metric.name, { exact: true }).first()).toBeAttached();
    }
    // The create form offers exactly the four Ashby-aligned levels.
    await revealAddMetric(drawer);
    for (const level of ['Poor', 'Average', 'Good', 'Excellent']) {
      await expect(drawer.getByText(new RegExp(`\\b${level}\\b`)).first()).toBeVisible();
    }
    app.expectHealthy();
  });

  test('role filters list only Ashby-mapped roles, by title, with no mappings read', async ({ app, page }) => {
    // The seed maps three roles (live, paused, drift) and leaves three
    // unmapped; the roles route flags each (fixtures/api-router.ts).
    const MAPPED = ['Data Analyst', 'Frontend Engineer', 'Senior Backend Engineer'];
    const UNMAPPED = ['Site Reliability Engineer', 'Customer Success Associate', 'QA Automation Engineer'];
    const mappingsReads = () =>
      app.calls.filter((c) => c.method === 'GET' && new URL(c.url).pathname.endsWith('/mission-control/mappings'));

    for (const path of ['/dashboard', '/candidates']) {
      await app.goto(path);
      const filter = page.getByLabel('Filter by role').first();
      await expect(filter).toBeVisible();
      await expect(filter.locator('option')).toHaveText(['All roles', ...MAPPED]);
      for (const title of UNMAPPED) {
        await expect(filter.locator('option', { hasText: title })).toHaveCount(0);
      }
    }
    expect(mappingsReads(), 'the role filters read the flag off /api/roles, not the mappings list').toEqual([]);
    app.expectHealthy();
  });

  test('Candidates Active / Paused scope follows the Ashby job state', async ({ app, page }) => {
    // Seed: backend = enabled (Live), data = paused, frontend = drift (in
    // neither), the rest unmapped.
    await app.goto('/candidates');
    const scope = page.getByRole('group', { name: 'Filter by Ashby job status' });
    await expect(scope).toBeVisible();
    const roleFilter = page.getByLabel('Filter by role').first();

    await scope.getByRole('button', { name: /^Active/ }).click();
    await expect(page).toHaveURL(/ashby=active/);
    await expect(roleFilter.locator('option')).toHaveText(['All roles', 'Senior Backend Engineer']);
    await expect(page.getByText('Ashby jobs: Active').first()).toBeVisible();

    await scope.getByRole('button', { name: /^Paused/ }).click();
    await expect(page).toHaveURL(/ashby=paused/);
    await expect(roleFilter.locator('option')).toHaveText(['All roles', 'Data Analyst']);

    await scope.getByRole('button', { name: /^All/ }).click();
    await expect(page).not.toHaveURL(/ashby=/);
    await expect(roleFilter.locator('option')).toHaveText([
      'All roles',
      'Data Analyst',
      'Frontend Engineer',
      'Senior Backend Engineer',
    ]);
    app.expectHealthy();
  });

  test('Ashby Live Jobs shows every mapping state', async ({ app, page }) => {
    await app.goto('/ashby-mission-control');
    // In words (enabled / paused / drift on the wire).
    for (const status of ['Live', 'Paused', 'Out of sync']) {
      await expect(page.getByText(status, { exact: true }).first()).toBeVisible();
    }
    app.expectHealthy();
  });
});
