/**
 * Export report (M014): the candidate header downloads ONE self-contained HTML
 * file with the call recordings embedded as data: URIs, which plays offline and
 * whose timestamps seek the matching call.
 *
 * The recruiter clicks "Export report"; the page mints each recording link one
 * at a time, fetches the bytes in the browser, builds the file and downloads
 * it. The downloaded file is then opened from disk, exactly as a stakeholder
 * would, under its own Content-Security-Policy.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test } from './fixtures/harness';
import { auditA11y } from './fixtures/axe';
import { SEEK_CANDIDATE_ID, SEEK_LEG1_LATER_TURN_SEC } from './fixtures/data';

test.describe('export report', () => {
  test('downloads an HTML report with embedded, seekable audio and records the export', async ({ app, page, browser }, testInfo) => {
    await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
    // The old CSV action is gone; the report is the one export.
    await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export report' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^screening-report-fatima-qureshi-\d{4}-\d{2}-\d{2}\.html$/);

    // Saved with its real name, so the browser treats it as HTML when it is opened from disk.
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    const html = readFileSync(file, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<audio [^>]*controls[^>]*src="data:audio\/wav;base64,[A-Za-z0-9+/=]+"/);
    // Nothing that could be replayed later: no minted link, no token.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/token|bearer/i);

    // The export is audited once the file is saved (fire-and-forget).
    await expect
      .poll(() => app.calls.filter((c) => /\/api\/export\/[^/]+\/report-audit/.test(c.url)).length)
      .toBe(1);
    // Recordings were minted one after another, never in a burst.
    const mints = app.calls.filter((c) => /\/api\/recordings\/attempts\/[^/]+\/download/.test(c.url));
    expect(mints.length).toBeGreaterThan(0);
    await expect(page.getByText(/Report downloaded/)).toBeVisible();

    // Open the saved file from disk, as a stakeholder would.
    const reader = await (await browser.newContext({ locale: 'en-GB' })).newPage();
    await reader.goto(pathToFileURL(file).href);
    await expect(reader.getByRole('heading', { level: 1 })).toHaveText('Fatima Qureshi');
    const audios = reader.locator('audio[controls]');
    expect(await audios.count()).toBeGreaterThan(0);

    // The script is allowed by the file's own CSP hash: clicking a timestamp seeks the call.
    const stamp = reader.locator(`button.ts[data-t="${SEEK_LEG1_LATER_TURN_SEC}"]`).first();
    await expect(stamp).toBeVisible();
    await stamp.click();
    const audio = reader.locator(`audio[data-audio-id="${await stamp.getAttribute('data-audio')}"]`);
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(SEEK_LEG1_LATER_TURN_SEC - 1);
    await reader.context().close();
    app.expectHealthy();
  });

  test('the report passes axe (audited with the file\'s own CSP bypassed, so the checker can run)', async ({ app, page, browser }, testInfo) => {
    await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export report' }).click();
    const download = await downloadPromise;
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);

    const ctx = await browser.newContext({ bypassCSP: true });
    const reader = await ctx.newPage();
    await reader.goto(pathToFileURL(file).href);
    await expect(reader.getByRole('heading', { level: 1 })).toBeVisible();
    await auditA11y(reader, testInfo, 'report-export', { strict: true });
    await ctx.close();
  });

  test('on a 390px phone the report does not scroll sideways', async ({ app, page, browser }, testInfo) => {
    await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export report' }).click();
    const download = await downloadPromise;
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const reader = await ctx.newPage();
    await reader.goto(pathToFileURL(file).href);
    await expect(reader.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await reader.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await ctx.close();
  });
});
