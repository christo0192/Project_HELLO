/**
 * Business impact (M031 S6), in the real app against the harness's invented
 * impact fixture (fixtures/impact.ts: about 400 applications across the two
 * mapped jobs, aggregated by the contract's rules).
 *
 * Every section renders from the fixture; the filters change the request; a
 * count opens the list behind it and a row opens the candidate page; the
 * states (Ashby not read, nothing checked, a failure, nothing at all) each say
 * what they are; the keyboard path in and out of the list; axe, strictly; and
 * the layout at 1440x900 and 1366x768, with screenshots kept as artifacts.
 */

import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ARTIFACTS_DIR, auditA11y } from './fixtures/axe';
import { STAR_CANDIDATE_ID } from './fixtures/data';
import { expect, test, type AppHarness } from './fixtures/harness';
import { IMPACT_JOBS, stuckImportWeek } from './fixtures/impact';
import { horizontalOverflow } from './fixtures/layout';

const shot = (project: string, name: string) => path.join(ARTIFACTS_DIR, 'impact', project, `${name}.png`);

/** The impact reads the page made, as their query strings. */
const summaryReads = (app: AppHarness) =>
  app.calls.filter((call) => call.url.includes('/api/impact/summary')).map((call) => new URL(call.url).searchParams);
const listReads = (app: AppHarness) =>
  app.calls.filter((call) => call.url.includes('/api/impact/candidates')).map((call) => new URL(call.url).searchParams);

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const rowOf = (scope: Locator, attribute: string, value: string) => scope.locator(`tr[${attribute}="${value}"]`);

/** Chromium logs a deliberate failed read itself. Clear only that line; anything else still fails the test. */
function forgetFailedResponse(app: AppHarness, status: number): void {
  const line = `Failed to load resource: the server responded with a status of ${status} `;
  const others = app.consoleErrors.filter((error) => !error.startsWith(line));
  app.consoleErrors.splice(0, app.consoleErrors.length, ...others);
}

async function openImpact(app: AppHarness, search = ''): Promise<void> {
  await app.goto(`/impact${search}`);
  await expect(app.page.getByRole('heading', { level: 1, name: 'Business impact' })).toBeVisible();
}

/** The timings Ashby has to supply: every one after a verdict. */
const ASHBY_TIMINGS = ['verdict_to_decision', 'christy_to_r1', 'r1_to_r2', 'r2_to_offer', 'offer_to_hired'] as const;

/** Each Ashby-side timing is a dash in all three columns, read out as not available, never "n too small" or a 0. */
async function expectAshbyTimingsUnknown(page: Page): Promise<void> {
  const timings = section(page, 'Time between steps');
  for (const key of ASHBY_TIMINGS) {
    const row = rowOf(timings, 'data-timing', key);
    await expect(row, key).not.toContainText('n too small');
    await expect(row.locator('td'), key).toHaveText(['—Not available', '—Not available', '—Not available']);
  }
  // Christy's own timings are counted as usual.
  await expect(rowOf(timings, 'data-timing', 'entry_to_first_call').locator('td').last()).toHaveText(/^\d+$/);
}

/** Holds the next list read until `release`, so what the panel shows before it lands can be checked. */
async function holdListRead(page: Page): Promise<() => void> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/impact/candidates',
    async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.fallback();
    },
  );
  return release;
}

test.describe('Business impact', () => {
  test('renders every section from the fixture, in the plan’s order', async ({ app, page }, testInfo) => {
    await openImpact(app);
    await expect(page.getByText('Ashby applications Christy screened. A person decides in Ashby.')).toBeVisible();
    await expect(page.getByTestId('impact-freshness')).toHaveText(
      'Ashby stages checked 5 minutes ago, 409 of 412 applications. 3 applications are due a fresh check.',
    );
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText([
      'The pipeline',
      'Christy’s verdict against what happened next',
      'Where candidates leave',
      'Time between steps',
      'Weekly cohorts',
      'By job',
    ]);

    // The pipeline: 308 came in over the last 12 IST weeks, down to 4 hired, the connected step's sub-line.
    const pipeline = section(page, 'The pipeline');
    await expect(pipeline.getByRole('group', { name: 'Headline counts' })).toContainText('308');
    await expect(rowOf(pipeline, 'data-step', 'came_in')).toContainText('308');
    await expect(rowOf(pipeline, 'data-step', 'connected')).toContainText('Call answered 214');
    await expect(rowOf(pipeline, 'data-step', 'hired')).toContainText('1.3%');
    // With Ashby read every figure is known. The cells the contract leaves out say they do not apply:
    // nothing comes before Came in, nobody is still at a decision, and Hired is the end.
    await expect(pipeline.getByText('Not available')).toHaveCount(0);
    await expect(rowOf(pipeline, 'data-step', 'came_in').getByText('Does not apply')).toHaveCount(1);
    await expect(rowOf(pipeline, 'data-step', 'decided').getByText('Does not apply')).toHaveCount(1);
    await expect(rowOf(pipeline, 'data-step', 'hired').getByText('Does not apply')).toHaveCount(2);

    // Christy's verdict: five rows, each in words, the verdicts in their families.
    const verdicts = section(page, 'Christy’s verdict against what happened next');
    await expect(verdicts.locator('tbody tr')).toHaveCount(5);
    await expect(rowOf(verdicts, 'data-verdict', 'select').locator('[data-recommendation="advance"]')).toHaveClass(/text-ready-text/);
    await expect(rowOf(verdicts, 'data-verdict', 'reject').locator('[data-recommendation="reject"]')).toHaveClass(/text-closed-text/);
    await expect(rowOf(verdicts, 'data-verdict', 'held')).toContainText('Held (thin evidence)');

    // Several stages where candidates leave, with Ashby's own reasons.
    const leaves = section(page, 'Where candidates leave');
    expect(await leaves.locator('tbody tr').count()).toBeGreaterThanOrEqual(4);
    await expect(leaves.locator('tbody tr').first()).toContainText('Hello Christy');

    // A timing under n 5 says so and keeps n.
    await expect(rowOf(section(page, 'Time between steps'), 'data-timing', 'offer_to_hired')).toContainText('n too small');

    // Twelve IST weeks, the young ones still maturing.
    const cohorts = section(page, 'Weekly cohorts');
    await expect(cohorts.locator('tbody tr')).toHaveCount(12);
    expect(await cohorts.getByText('Still maturing').count()).toBe(6);
    await expect(section(page, 'By job').locator('tbody tr')).toHaveCount(2);

    // The definitions, behind one disclosure.
    await page.getByText('How these numbers are calculated').click();
    await expect(page.locator('dt', { hasText: 'Christy connected' })).toBeVisible();

    if (testInfo.project.name === 'mobile') {
      expect(await horizontalOverflow(page), 'the page must not scroll sideways at 390 px').toEqual({ overflowPx: 0, offenders: [] });
    }
    await auditA11y(page, testInfo, 'impact', { strict: true });
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-full'), fullPage: true, animations: 'disabled', caret: 'hide' });
    app.expectHealthy();
  });

  test('asks again when the filters change, and keeps them in the address', async ({ app, page }) => {
    await openImpact(app);
    expect(summaryReads(app).at(-1)?.toString()).toBe('from=2026-06-29&to=2026-09-16');

    await page.getByRole('button', { name: '4 weeks' }).click();
    await expect.poll(() => summaryReads(app).at(-1)?.toString()).toBe('from=2026-08-24&to=2026-09-16');
    await expect(page).toHaveURL(/\/impact\?weeks=4$/);
    await expect(rowOf(section(page, 'The pipeline'), 'data-step', 'came_in')).toContainText('100');

    await page.getByRole('button', { name: /^Job/ }).click();
    await page.getByRole('listbox').getByRole('option', { name: 'Data Analyst' }).click();
    const job = IMPACT_JOBS[1].id;
    await expect.poll(() => summaryReads(app).at(-1)?.get('job')).toBe(job);
    await expect(page).toHaveURL(new RegExp(`job=${job}`));
    await expect(section(page, 'By job').locator('tbody tr')).toHaveCount(1);

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect.poll(() => summaryReads(app).at(-1)?.get('from')).toBe('2026-01-01');
    app.expectHealthy();
  });

  test('a count opens the applications behind it, and a name opens the candidate', async ({ app, page }, testInfo) => {
    await openImpact(app);
    const verdicts = section(page, 'Christy’s verdict against what happened next');
    const count = rowOf(verdicts, 'data-verdict', 'select').getByRole('button', { name: '11, Select, R1 or later. Show these applications' });
    await count.click();
    const dialog = page.getByRole('dialog', { name: 'Select · R1 or later' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    expect(listReads(app).at(-1)?.toString()).toBe('verdict=select&outcome=r1&from=2026-06-29&to=2026-09-16&page=1&pageSize=50');
    await expect(dialog.getByRole('status')).toHaveText('Showing 1–11 of 11 applications');
    // The list prints no email, phone or Ashby id.
    await expect(dialog).not.toContainText('@');
    await expect(dialog).not.toContainText('app_');

    await auditA11y(page, testInfo, 'impact-list', { strict: true });
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-list'), animations: 'disabled', caret: 'hide' });

    const first = dialog.getByRole('link', { name: 'Meera Iyer' });
    await expect(first).toHaveAttribute('href', `/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`/candidates/${STAR_CANDIDATE_ID}\\?tab=phone$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Meera Iyer' })).toBeVisible();
    app.expectHealthy();
  });

  test('the list behind a dropped step pages through the server', async ({ app, page }) => {
    await openImpact(app, '?weeks=all');
    await section(page, 'The pipeline').getByRole('button', { name: /dropped at A person decided in Ashby/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Dropped at: A person decided in Ashby' });
    await expect(dialog.getByRole('status')).toHaveText(/^Showing 1–50 of \d{3} applications$/);
    await dialog.getByRole('button', { name: 'Next page' }).click();
    await expect(dialog.getByRole('status')).toHaveText(/^Showing 51–100 of \d{3} applications$/);
    expect(listReads(app).at(-1)?.get('page')).toBe('2');
    expect(listReads(app).at(-1)?.get('dropped')).toBe('true');
    app.expectHealthy();
  });

  test('a list opened again starts on its first page, and shows none of the rows it had before', async ({ app, page }) => {
    await openImpact(app, '?weeks=all');
    const opener = section(page, 'The pipeline').getByRole('button', { name: /dropped at A person decided in Ashby/ });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Dropped at: A person decided in Ashby' });
    await expect(dialog.getByRole('status')).toHaveText(/^Showing 1–50 of \d{3} applications$/);
    await dialog.getByRole('button', { name: 'Next page' }).click();
    await expect(dialog.getByRole('status')).toHaveText(/^Showing 51–100 of \d{3} applications$/);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    const release = await holdListRead(page);
    await opener.click();
    await expect(dialog.getByText('Loading applications…')).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(0);
    release();
    await expect(dialog.getByRole('status')).toHaveText(/^Showing 1–50 of \d{3} applications$/);
    expect(listReads(app).at(-1)?.get('page')).toBe('1');
    app.expectHealthy();
  });

  test('the current week’s list asks for nothing past today', async ({ app, page }) => {
    await openImpact(app);
    // Today is Wednesday 16 Sep 2026 (IST): the newest week started on Monday the 14th.
    const week = rowOf(section(page, 'Weekly cohorts'), 'data-week', '2026-09-14');
    await week.getByRole('button', { name: /came in, week of 14 Sep 2026/ }).click();
    await expect(page.getByRole('dialog', { name: 'Came in · Week of 14 Sep 2026' })).toBeVisible();
    expect(listReads(app).at(-1)?.toString()).toBe('step=came_in&from=2026-09-14&to=2026-09-16&page=1&pageSize=50');
    app.expectHealthy();
  });

  test('an application that never became a candidate is listed, with nothing to open', async ({ app, page }, testInfo) => {
    await openImpact(app, '?weeks=all');
    const weekStart = stuckImportWeek();
    await rowOf(section(page, 'Weekly cohorts'), 'data-week', weekStart).getByRole('button', { name: /came in, week of/ }).click();
    const dialog = page.getByRole('dialog', { name: /^Came in · Week of / });
    await expect(dialog.getByRole('status')).toHaveText(/^Showing 1–\d+ of \d+ applications?$/);
    const stuck = dialog.locator('tbody tr', { hasText: 'Not a candidate yet' });
    await expect(stuck).toHaveCount(1);
    await expect(stuck).toContainText('Resume not processed');
    await expect(stuck.getByRole('link')).toHaveCount(0);
    // Every other row still opens its candidate.
    const rows = await dialog.locator('tbody tr').count();
    await expect(dialog.getByRole('link')).toHaveCount(rows - 1);
    await auditA11y(page, testInfo, 'impact-list-stuck-import', { strict: true });
    app.expectHealthy();
  });

  // D-M031-5: the list follows the candidate page's own rule. An interviewer sees the candidates
  // they own; the rest are counted in `hidden`, and the panel says so in one plain line.
  test('an interviewer’s list names only their own candidates, and says how many more there are', async ({ app, page }, testInfo) => {
    app.db.impact.listScope = 'own';
    await openImpact(app);
    const verdicts = section(page, 'Christy’s verdict against what happened next');
    // The figure is the same for everyone: 11 Selects reached R1 or later.
    await rowOf(verdicts, 'data-verdict', 'select').getByRole('button', { name: '11, Select, R1 or later. Show these applications' }).click();
    const dialog = page.getByRole('dialog', { name: 'Select · R1 or later' });
    await expect(dialog.getByRole('status')).toHaveText('Showing 1–4 of 4 applications');
    await expect(dialog.locator('tbody tr')).toHaveCount(4);
    // Read as a paragraph of its own, in the accessibility tree a screen reader walks.
    const line = dialog.getByRole('paragraph').filter({ hasText: /recruiter/ });
    await expect(line).toHaveText('7 more belong to other recruiters and are not listed.');
    await expect(line).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Meera Iyer' })).toHaveAttribute('href', `/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
    await auditA11y(page, testInfo, 'impact-list-hidden', { strict: true });
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-list-hidden'), animations: 'disabled', caret: 'hide' });
    await dialog.getByRole('button', { name: 'Close' }).click();

    // Paging counts the listed applications only: 102 of the 308 that came in are this viewer's.
    await section(page, 'The pipeline').getByRole('button', { name: '308, reached Came in. Show these applications' }).click();
    const cameIn = page.getByRole('dialog', { name: 'Reached: Came in' });
    await expect(cameIn.getByRole('status')).toHaveText('Showing 1–50 of 102 applications');
    await expect(cameIn.getByText('206 more belong to other recruiters and are not listed.')).toBeVisible();
    await cameIn.getByRole('button', { name: 'Next page' }).click();
    await cameIn.getByRole('button', { name: 'Next page' }).click();
    await expect(cameIn.getByRole('status')).toHaveText('Showing 101–102 of 102 applications');
    await expect(cameIn.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(listReads(app).at(-1)?.get('page')).toBe('3');
    app.expectHealthy();
  });

  test('when every application behind a figure is someone else’s, the list says only that', async ({ app, page }, testInfo) => {
    app.db.impact.listScope = 'none';
    await openImpact(app);
    await section(page, 'The pipeline').getByRole('button', { name: '4, reached Hired. Show these applications' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reached: Hired' });
    await expect(dialog.getByRole('paragraph').filter({ hasText: /recruiter/ })).toHaveText('4 more belong to other recruiters and are not listed.');
    await expect(dialog).not.toContainText('No applications to show');
    await expect(dialog.getByRole('table')).toHaveCount(0);
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await expect(dialog.getByRole('link')).toHaveCount(0);
    await auditA11y(page, testInfo, 'impact-list-all-hidden', { strict: true });
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-list-all-hidden'), animations: 'disabled', caret: 'hide' });
    app.expectHealthy();
  });

  test('says when a list fails, in words, and reads it again on Retry', async ({ app, page }) => {
    app.db.impact.failCandidates = { status: 503, error: 'impact_unavailable' };
    await openImpact(app);
    await section(page, 'The pipeline').getByRole('button', { name: '4, reached Hired. Show these applications' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reached: Hired' });
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('The applications couldn’t load. These figures are not available just now.');
    await expect(alert).not.toContainText('impact_unavailable');
    app.db.impact.failCandidates = null;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(dialog.getByRole('link')).toHaveCount(4);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    forgetFailedResponse(app, 503);
    app.expectHealthy();
  });

  test('the keyboard reaches a count, opens its list, stays inside it, and comes back', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'a hardware keyboard path');
    await openImpact(app);
    const count = section(page, 'The pipeline').getByRole('button', { name: '4, reached Hired. Show these applications' });
    await count.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(count).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Reached: Hired' });
    await expect(dialog).toBeFocused();
    await expect(dialog.getByRole('link')).toHaveCount(4);
    // Tab walks the dialog's own controls and never leaves it.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(count).toBeFocused();
    app.expectHealthy();
  });

  test('says Ashby stages are not being read, with dashes and no zeros, when progress is off', async ({ app, page }, testInfo) => {
    app.db.impact.progressEnabled = false;
    await openImpact(app);
    await expect(page.getByText(/^Ashby stages are not being read yet\./)).toBeVisible();
    await expect(page.getByTestId('impact-freshness')).toHaveText('Ashby stages not checked yet, 0 of 412 applications.');
    const hired = rowOf(section(page, 'The pipeline'), 'data-step', 'hired');
    // Reached and both shares are not known; Still here and Dropped here never apply to Hired.
    await expect(hired.getByText('Not available')).toHaveCount(3);
    await expect(hired.getByText('Does not apply')).toHaveCount(2);
    await expect(rowOf(section(page, 'The pipeline'), 'data-step', 'connected')).toContainText('181');
    await expect(section(page, 'Where candidates leave')).toContainText('Not known yet');
    await expectAshbyTimingsUnknown(page);
    await auditA11y(page, testInfo, 'impact-not-enabled', { strict: true });
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-not-enabled'), animations: 'disabled', caret: 'hide' });
    app.expectHealthy();
  });

  test('says the same when the worker is on but has checked nothing yet', async ({ app, page }) => {
    app.db.impact.coverage = 'zero';
    await openImpact(app);
    await expect(page.getByText(/^Ashby stages are not being read yet\./)).toBeVisible();
    await expect(rowOf(section(page, 'Christy’s verdict against what happened next'), 'data-verdict', 'select')).not.toContainText(/\d%/);
    await expectAshbyTimingsUnknown(page);
    app.expectHealthy();
  });

  test('names stages nobody has labelled yet', async ({ app, page }) => {
    app.db.impact.unlabelledStages = 2;
    await openImpact(app);
    await expect(page.getByText(/^2 Ashby stages have no milestone label yet\./)).toBeVisible();
    app.expectHealthy();
  });

  test('says what failed, in words, and reads again on Retry', async ({ app, page }, testInfo) => {
    app.db.impact.fail = { status: 503, error: 'impact_unavailable' };
    await openImpact(app);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Business impact couldn’t load. These figures are not available just now.');
    await expect(alert).not.toContainText('impact_unavailable');
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-error'), animations: 'disabled', caret: 'hide' });
    app.db.impact.fail = null;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'The pipeline' })).toBeVisible();
    forgetFailedResponse(app, 503);
    app.expectHealthy();
  });

  test('refused filters are reset, and the summary read again', async ({ app, page }) => {
    app.db.impact.fail = { status: 400, error: 'invalid_filter' };
    await openImpact(app, '?weeks=4');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Business impact couldn’t load. These filters were not accepted.');
    app.db.impact.fail = null;
    await alert.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page).toHaveURL(/\/impact$/);
    await expect(page.getByRole('heading', { name: 'The pipeline' })).toBeVisible();
    expect(summaryReads(app).at(-1)?.toString()).toBe('from=2026-06-29&to=2026-09-16');
    forgetFailedResponse(app, 400);
    app.expectHealthy();
  });

  test('a refusal with no filter set offers Try again, which reads the summary again', async ({ app, page }) => {
    app.db.impact.fail = { status: 400, error: 'invalid_filter' };
    await openImpact(app);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Business impact couldn’t load.');
    // There is nothing in the address to reset, so the panel does not offer to reset it.
    await expect(alert.getByRole('button', { name: 'Reset filters' })).toHaveCount(0);
    await expect(alert).not.toContainText('Reset them');
    const reads = summaryReads(app).length;
    app.db.impact.fail = null;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'The pipeline' })).toBeVisible();
    expect(summaryReads(app)).toHaveLength(reads + 1);
    forgetFailedResponse(app, 400);
    app.expectHealthy();
  });

  test('says nothing came in, only after the read succeeded', async ({ app, page }, testInfo) => {
    app.db.impact.empty = true;
    await openImpact(app);
    await expect(page.getByText('No Ashby application came in during these weeks')).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveCount(0);
    await auditA11y(page, testInfo, 'impact-empty', { strict: true });
    await page.screenshot({ path: shot(testInfo.project.name, 'impact-empty'), animations: 'disabled', caret: 'hide' });
    app.expectHealthy();
  });

  test('shows a viewer no figure and asks the impact API nothing', async ({ app, page }) => {
    app.db.me.role = 'viewer';
    await openImpact(app);
    await expect(page.getByText('Not available to your role')).toBeVisible();
    expect(summaryReads(app)).toHaveLength(0);
    app.expectHealthy();
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    test(`at ${viewport.width}x${viewport.height} nothing is clipped and the page never scrolls sideways`, async ({ app, page }, testInfo) => {
      test.skip(testInfo.project.name === 'mobile', 'a desktop window');
      await page.setViewportSize(viewport);
      await openImpact(app);
      expect(await horizontalOverflow(page)).toEqual({ overflowPx: 0, offenders: [] });

      // The header's filters sit inside the window, on the title's row.
      const weeks = page.getByRole('group', { name: 'Weeks' });
      const box = (await weeks.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

      // Every table fits its section at this width, so nothing hides behind a sideways scroll.
      const scrolling = await page.evaluate(() =>
        Array.from(document.querySelectorAll('section table'))
          .map((table) => table.parentElement as HTMLElement)
          .filter((box) => box.scrollWidth > box.clientWidth + 1)
          .map((box) => box.querySelector('caption')?.textContent ?? 'a table'),
      );
      expect(scrolling).toEqual([]);

      // No figure, label or header is cut off inside its own box.
      const clipped = await page.evaluate(() =>
        Array.from(document.querySelectorAll('main th, main td, main [role="group"] button, main h1, main h2'))
          .filter((el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1)
          .map((el) => (el.textContent ?? '').trim().slice(0, 40)),
      );
      expect(clipped).toEqual([]);

      await page.screenshot({ path: shot(testInfo.project.name, `impact-${viewport.width}x${viewport.height}`), animations: 'disabled', caret: 'hide' });
      await page.screenshot({ path: shot(testInfo.project.name, `impact-${viewport.width}x${viewport.height}-full`), fullPage: true, animations: 'disabled', caret: 'hide' });
      app.expectHealthy();
    });
  }
});
