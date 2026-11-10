/**
 * Mission Control › Stages (M031 S2) in a real browser, at 1440x900 and on a
 * 390 px phone: the 18 stages every mapped Ashby job shares, in plan order,
 * each with what it counts as on Business impact and who set that; labelling
 * by keyboard; Refresh from Ashby; and the empty, unread and failed states.
 *
 * The fixture is the live plan's stage names (fixtures/data.ts, STAGES); the
 * router applies the API's rules (fixtures/api-router.ts). No candidate data
 * is on this page.
 */
import type { Page } from '@playwright/test';
import { auditA11y } from './fixtures/axe';
import { STAGES } from './fixtures/data';
import { MOCK_API_ORIGIN } from './fixtures/env';
import { CORS_HEADERS, expect, test, type AppHarness } from './fixtures/harness';
import { horizontalOverflow } from './fixtures/layout';

const CATALOG = '/api/integrations/ashby/mission-control/stage-catalog';

function stagesTable(page: Page) {
  return page.getByRole('table', { name: /Ashby stages in plan order/ });
}

async function openStages(app: AppHarness) {
  await app.goto('/mission-control#stages');
  await expect(app.page.getByRole('tab', { name: 'Stages' })).toHaveAttribute('aria-selected', 'true');
  await expect(stagesTable(app.page)).toBeVisible();
}

function calls(app: AppHarness, method: string, pathname: string | RegExp) {
  return app.calls.filter((c) => c.method === method && (typeof pathname === 'string' ? new URL(c.url).pathname === pathname : pathname.test(new URL(c.url).pathname)));
}

async function noSideways(page: Page) {
  expect(await horizontalOverflow(page), 'the page must not scroll sideways').toEqual({ overflowPx: 0, offenders: [] });
}

test.describe('Mission Control › Stages', () => {
  test('lists the 18 live stages in plan order, with type, milestone and who set it', async ({ app, page }, testInfo) => {
    await openStages(app);
    const rows = stagesTable(page).getByRole('row');
    await expect(rows).toHaveCount(19);
    await expect(stagesTable(page).getByRole('columnheader')).toHaveText(['#', 'Stage', 'Ashby type', 'Counts as', 'Set by']);
    const titles = await rows.locator('td:nth-child(2)').allTextContents();
    expect(titles).toEqual(STAGES.map((s) => s.title));

    const r1 = rows.nth(9);
    await expect(r1.getByRole('cell').nth(0)).toHaveText('9');
    await expect(r1.getByRole('cell').nth(2)).toHaveText('Active');
    await expect(r1.getByRole('button', { name: 'What R1 counts as R1' })).toBeVisible();
    await expect(r1.getByRole('cell').nth(4)).toHaveText('Default');
    await expect(rows.nth(5).getByRole('button', { name: 'What Hello Christy counts as Christy stage' })).toBeVisible();
    await expect(rows.nth(7).getByRole('button', { name: 'What HM Review counts as Not labelled' })).toBeVisible();
    await expect(rows.nth(8).getByRole('button', { name: 'What R0 - Online Assessment counts as Not labelled' })).toBeVisible();
    await expect(page.getByText('18 stages · 10 labelled')).toBeVisible();

    // The stage ids address a label change and are never in the page.
    const html = await page.content();
    for (const s of STAGES) expect(html).not.toContain(s.id);
    // Reading the list never asks Ashby: no refresh until someone presses it.
    expect(calls(app, 'GET', CATALOG).length).toBeGreaterThan(0);
    expect(calls(app, 'POST', `${CATALOG}/refresh`)).toHaveLength(0);

    if (testInfo.project.name === 'mobile') await noSideways(page);
    await auditA11y(page, testInfo, 'mission-control-stages', { strict: true });
    app.expectHealthy();
  });

  test('labels a stage by keyboard, and the label is sent and kept', async ({ app, page }) => {
    // Hold the save, so where focus sits while it runs can be seen.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${MOCK_API_ORIGIN}${CATALOG}/*`, async (route) => {
      if (route.request().method() === 'PATCH') await held;
      await route.fallback();
    });
    await openStages(app);
    const trigger = page.getByRole('button', { name: /^What HM Review counts as/ });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const list = page.getByRole('listbox', { name: 'Milestones' });
    await expect(list).toBeVisible();
    // A typed letter moves to the next option starting with it: O is Offer, then Other.
    await page.keyboard.press('o');
    await page.keyboard.press('o');
    await page.keyboard.press('Enter');
    // While it saves, focus stays on the picker just used (never the page body), which says it is busy.
    await expect(trigger).toHaveAttribute('aria-busy', 'true');
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
    release();
    await expect(page.getByRole('status').filter({ hasText: 'HM Review now counts as Other.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'What HM Review counts as Other' })).toBeVisible();
    // And after it: the same row's picker, ready for the next key.
    await expect(page.getByRole('button', { name: 'What HM Review counts as Other' })).toBeFocused();
    await expect(trigger).not.toHaveAttribute('aria-busy', 'true');
    await expect(stagesTable(page).getByRole('row').nth(7).getByRole('cell').nth(4)).toHaveText('Admin');

    const patches = calls(app, 'PATCH', /\/stage-catalog\/[^/]+$/);
    expect(patches).toHaveLength(1);
    expect(app.db.ashby.stages[6]).toMatchObject({ milestone: 'other', milestoneSource: 'admin' });

    // Still there after a reload of the section.
    await page.reload();
    await expect(page.getByRole('button', { name: 'What HM Review counts as Other' })).toBeVisible();
    app.expectHealthy();
  });

  test('a stage Ashby removed is listed last as no longer in the plan, and left out of the counts', async ({ app, page }, testInfo) => {
    // Ashby deleted an old round: HELLO keeps it, label and all, for the history that points at it.
    app.db.ashby.stages.push({ id: 'e2e-stage-gone-r6', title: 'Panel Round', type: 'Active', order: 12, milestone: 'other', milestoneSource: 'admin', inPlan: false });
    await openStages(app);
    const rows = stagesTable(page).getByRole('row');
    await expect(rows).toHaveCount(20);
    const last = rows.nth(19);
    await expect(last.getByRole('cell').nth(0)).toHaveText('—');
    await expect(last.getByRole('cell').nth(1)).toHaveText('Panel RoundNo longer in the Ashby plan');
    await expect(last.getByRole('button', { name: 'What Panel Round, no longer in the Ashby plan, counts as Other' })).toBeVisible();
    await expect(page.getByText('18 stages · 10 labelled · 1 no longer in the plan')).toBeVisible();
    if (testInfo.project.name === 'mobile') await noSideways(page);
    await auditA11y(page, testInfo, 'mission-control-stages-not-in-plan', { strict: true });
    app.expectHealthy();
  });

  test('"Not labelled" returns a relabelled stage to its default', async ({ app, page }) => {
    const offer = app.db.ashby.stages.find((s) => s.title === 'Offer')!;
    offer.milestone = 'other';
    offer.milestoneSource = 'admin';
    await openStages(app);
    await page.getByRole('button', { name: 'What Offer counts as Other' }).click();
    await page.getByRole('listbox', { name: 'Milestones' }).getByRole('option', { name: /^Not labelled/ }).click();
    await expect(page.getByRole('status').filter({ hasText: "Offer's label is cleared. It counts as Offer by default." })).toBeVisible();
    await expect(page.getByRole('button', { name: 'What Offer counts as Offer' })).toBeVisible();
    app.expectHealthy();
  });

  test('Refresh from Ashby reads the plans, reloads the list and reports the counts', async ({ app, page }, testInfo) => {
    await openStages(app);
    // The dev server's StrictMode may read twice on mount; a refresh reads once more.
    const before = calls(app, 'GET', CATALOG).length;
    await page.getByRole('button', { name: 'Refresh from Ashby' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Read 1 job from Ashby: 18 stages, no new stage.' })).toBeVisible();
    await expect.poll(() => calls(app, 'GET', CATALOG).length).toBe(before + 1);
    expect(calls(app, 'POST', `${CATALOG}/refresh`)).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Refresh from Ashby' })).toBeEnabled();
    if (testInfo.project.name === 'mobile') await noSideways(page);
    app.expectHealthy();
  });

  test('an unread catalogue asks for a refresh, and the refresh fills it', async ({ app, page }) => {
    app.db.ashby.stagesRead = false;
    await app.goto('/mission-control#stages');
    await expect(page.getByText('Stages not read yet')).toBeVisible();
    await expect(stagesTable(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh from Ashby' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Read 1 job from Ashby: 18 stages, 18 new stages, 10 labelled by default.' })).toBeVisible();
    await expect(stagesTable(page).getByRole('row')).toHaveCount(19);
    app.expectHealthy();
  });

  test('with no live mapping, says there is nothing to read', async ({ app, page }, testInfo) => {
    for (const m of app.db.ashby.mappings) m.status = 'paused';
    app.db.ashby.stagesRead = false;
    await app.goto('/mission-control#stages');
    await expect(page.getByText('No live Ashby jobs')).toBeVisible();
    if (testInfo.project.name === 'mobile') await noSideways(page);
    await auditA11y(page, testInfo, 'mission-control-stages-empty', { strict: true });
    app.expectHealthy();
  });

  test('a failed load is an error with retry, never an empty list', async ({ app, page }) => {
    let fail = true;
    await page.route(`${MOCK_API_ORIGIN}${CATALOG}`, (route) =>
      route.request().method() === 'GET' && fail
        ? route.fulfill({ status: 500, headers: CORS_HEADERS(route), contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'mission_control_read_error' }) })
        : route.fallback(),
    );
    await app.goto('/mission-control#stages');
    await expect(page.getByRole('alert')).toContainText("The stages couldn't load.");
    await expect(page.locator('body')).not.toContainText('mission_control_read_error');
    await expect(page.getByText('No live Ashby jobs')).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: /try again/i }).click();
    await expect(stagesTable(page).getByRole('row')).toHaveCount(19);
    // Chromium logs the 500 itself; that is this test's expected state.
    const others = app.consoleErrors.filter((e) => !/Failed to load resource: the server responded with a status of 500/.test(e));
    app.consoleErrors.splice(0, app.consoleErrors.length, ...others);
    app.expectHealthy();
  });
});
