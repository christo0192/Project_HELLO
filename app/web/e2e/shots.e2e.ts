/**
 * Screenshot capture: every route in the catalogue and every key state, per
 * project, into `.artifacts/screenshots/<project>/<name>.png`.
 *
 * Tagged `@shots` so `npm run e2e` (checks) and `npm run e2e:shots` (capture)
 * select disjoint tests from one config. Capture makes no assertions of its
 * own beyond "the state was reached", but the harness still fails any test
 * whose page made an unmocked request — a screenshot of a page that silently
 * rendered an empty state is worse than no screenshot.
 *
 * Determinism: frozen clock, fixed locale/zone, reduced motion, CSS
 * animations disabled and the caret hidden at capture time.
 */

import path from 'node:path';
import { ARTIFACTS_DIR } from './fixtures/axe';
import { KEY_STATES, openRoute } from './fixtures/flows';
import { test } from './fixtures/harness';
import { ROUTES } from './fixtures/routes';

const shotPath = (project: string, name: string) => path.join(ARTIFACTS_DIR, 'screenshots', project, `${name}.png`);

test.describe('screenshots @shots', () => {
  // A full-page capture of the longest pages (the dashboard is ~7,700 CSS px
  // tall at 390 px wide) rasterises every frosted-glass layer in software;
  // with several workers competing that alone can take tens of seconds.
  test.describe.configure({ timeout: 180_000 });

  for (const route of ROUTES) {
    test(`route ${route.name}`, async ({ app, page }, testInfo) => {
      await openRoute(app, route, { tolerateKnownIssue: true });
      await page.screenshot({ path: shotPath(testInfo.project.name, route.name), fullPage: true, animations: 'disabled', caret: 'hide' });
    });
  }

  for (const state of KEY_STATES) {
    test(`state ${state.name}`, async ({ app, page }, testInfo) => {
      test.skip(Boolean(state.mobileOnly) && testInfo.project.name !== 'mobile', 'mobile-only state');
      await state.run(app);
      await page.screenshot({ path: shotPath(testInfo.project.name, `state-${state.name}`), fullPage: state.fullPage, animations: 'disabled', caret: 'hide' });
    });
  }
});
