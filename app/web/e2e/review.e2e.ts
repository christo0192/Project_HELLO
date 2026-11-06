/**
 * The Logsheet Review screen in a real browser: what jsdom cannot see. At 1180px and up the page does
 * not scroll and the two panes do; below that they stack. A cue moves everything at once, the strip's
 * boxes stay pressable, and the Legal-approved consent line opens to every word.
 *
 * Selectors are roles and accessible names where the element has one. A tick, a chip and the clock
 * use their data hooks.
 */

import type { Locator, Page } from '@playwright/test';
import { SCOPED_REVIEW_LINK_ID, SEEK_CANDIDATE_ID, STAR_CANDIDATE_ID } from './fixtures/data';
import { expect, test, type AppHarness } from './fixtures/harness';

/** The star candidate has one completed session, so Review opens on it with nothing to pick. */
async function openReview(app: AppHarness, page: Page): Promise<Locator> {
  await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
  const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
  await expect(panel.getByRole('heading', { name: 'AI recommendation' })).toBeVisible();
  await app.settle();
  return panel;
}

const pageScrolls = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);

/**
 * For a test of what the press itself does. The fixture clip is shorter than any cued moment, so once
 * its link answers the seek clamps to the end of the clip, and the screen rightly follows that instead.
 */
const holdTheRecording = async (page: Page): Promise<void> => {
  await page.route(/\/api\/recordings\//, () => undefined);
};

const scrollsOnItsOwn = (pane: Locator): Promise<boolean> =>
  pane.evaluate((el) => {
    const before = window.scrollY;
    el.scrollTop = 80;
    const moved = el.scrollTop > 0 && window.scrollY === before;
    el.scrollTop = 0;
    return moved;
  });

test.describe('Review, the panes', () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    test(`at ${viewport.width}x${viewport.height} the page stays put and each pane scrolls on its own`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      const panel = await openReview(app, page);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
      expect(await scrollsOnItsOwn(panel.getByRole('region', { name: 'Transcript' }))).toBe(true);
      expect(await scrollsOnItsOwn(panel.getByRole('region', { name: 'AI recommendation' }))).toBe(true);
    });
  }

  test('below 1180px the panes stack, the transcript first', async ({ app, page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const panel = await openReview(app, page);
    const transcript = (await panel.getByRole('region', { name: 'Transcript' }).boundingBox())!;
    const reasoning = (await panel.getByRole('region', { name: 'AI recommendation' }).boundingBox())!;
    expect(reasoning.y).toBeGreaterThanOrEqual(transcript.y + transcript.height - 1);
  });

  test('a skip link lands in each pane', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    for (const [link, pane] of [
      ['Skip to transcript', 'Transcript'],
      ['Skip to AI recommendation', 'AI recommendation'],
    ] as const) {
      await panel.getByRole('link', { name: link }).focus();
      await page.keyboard.press('Enter');
      await expect(panel.getByRole('region', { name: pane })).toBeFocused();
    }
  });
});

test.describe('Review, the log header', () => {
  test('reads the length from the session list: GET /api/screening/:id has no recorded total', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(panel.locator('[data-log-header]')).toContainText(/Length\s*Recorded \d+m \d+s/);
  });

  test('one session is a line of text, and two are a picker that opens over the page', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const one = await openReview(app, page);
    await expect(one.getByRole('button', { name: /^Screening/ })).toHaveCount(0);
    await expect(one.locator('[data-session-text]')).toContainText('Live voice');

    await app.goto(`/candidates/${SEEK_CANDIDATE_ID}?tab=phone`);
    const two = page.getByRole('tabpanel', { name: 'Phone screening' });
    const transcript = two.getByRole('region', { name: 'Transcript' });
    await expect(two.getByRole('heading', { name: 'Transcript' })).toBeVisible();
    await app.settle();
    const before = (await transcript.boundingBox())!;
    await two.getByRole('button', { name: /^Screening/ }).click();
    await expect(two.getByRole('listbox', { name: 'Sessions' })).toBeVisible();
    // In flow, the list would push the tape and both panes down the page.
    expect((await transcript.boundingBox())!.y).toBe(before.y);
    await expect(two.getByRole('option', { name: /Recorded 1m 30s/ })).toBeInViewport();
  });
});

async function allFiveRowsFit(panel: Locator): Promise<void> {
  const pane = panel.getByRole('region', { name: 'AI recommendation' });
  const rows = pane.locator('[data-rubric-row]');
  await expect(rows).toHaveCount(5);
  const paneBox = (await pane.boundingBox())!;
  for (const row of await rows.all()) {
    const box = (await row.boundingBox())!;
    expect(box.y + box.height, 'a rubric row is below the fold').toBeLessThanOrEqual(paneBox.y + paneBox.height);
    expect((await row.locator('h4').boundingBox())!.height, 'a metric name wrapped').toBeLessThan(26);
  }
}

test.describe('Review, the rubric', () => {
  test('all five rows are on screen when Review opens at 1440x900, each on one line', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await allFiveRowsFit(await openReview(app, page));
  });

  test('a second session keeps them there: the picker in the log header stays one line', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a touch screen keeps its 44px target');
    await page.setViewportSize({ width: 1440, height: 900 });
    const read = app.db.candidateDetail;
    app.db.candidateDetail = (id) => {
      const detail = read(id);
      if (detail && id === STAR_CANDIDATE_ID) {
        detail.sessions = [...detail.sessions, { ...detail.sessions[0], id: '33333333-3333-4333-8333-333333333333', created_at: '2026-01-05T10:00:00.000Z' }];
      }
      return detail;
    };
    const panel = await openReview(app, page);
    const picker = panel.locator('#sync-session-select');
    await expect(picker).toBeVisible();
    expect((await picker.boundingBox())!.height, 'the picker wrapped').toBeLessThanOrEqual(26);
    await allFiveRowsFit(panel);
  });

  test('metric names stay on one line at 1366x768', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    for (const name of await panel.locator('[data-rubric-row] h4').all()) {
      expect((await name.boundingBox())!.height, 'a metric name wrapped').toBeLessThan(26);
    }
  });
});

test.describe('Review, a call past the hour', () => {
  test('a seek chip stays clear of the rating on every row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    for (const detail of Object.values(app.db.sessionDetails)) {
      detail.transcript = detail.transcript.map((turn) => ({
        ...turn,
        start_offset_sec: (turn.start_offset_sec ?? 0) + 25 * 3600,
      }));
    }
    const panel = await openReview(app, page);
    const chips = panel.locator('[data-seek-chip]');
    await expect(chips.first()).toContainText(/\d+:\d\d:\d\d/);
    for (const chip of await chips.all()) {
      const clear = await chip.evaluate(
        (el) => el.getBoundingClientRect().right <= el.parentElement!.nextElementSibling!.getBoundingClientRect().left,
      );
      expect(clear, 'a chip runs over the rating').toBe(true);
    }
  });
});

test.describe('Review, the Ashby deep link', () => {
  test('the Review tab is on paper, so its sticky head and labels are no patches on the desk', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await app.goto(`/ashby/review/${SCOPED_REVIEW_LINK_ID}`);
    await app.settle();
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });

    const workspace = panel.locator('[data-review-workspace]');
    const ground = await workspace.evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
    const head = await panel.getByRole('heading', { name: 'Transcript' }).evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
    expect(ground).toBe(head);
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(head);

    // The sheet reaches both edges of the workspace, and adds nothing to the page's height.
    const sheetBox = (await workspace.evaluate((el) => {
      const { left, right } = el.parentElement!.getBoundingClientRect();
      return { left, right };
    }))!;
    const box = (await workspace.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(sheetBox.left);
    expect(box.x + box.width).toBeLessThanOrEqual(sheetBox.right);
    expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
  });
});

test.describe('Review, the cue', () => {
  test('pressing a tick moves everything before the audio answers, and the row comes into view', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    const transcript = panel.getByRole('region', { name: 'Transcript' });
    const clock = panel.locator('[data-tape-clock]');
    const before = await clock.textContent();
    // The mint never answers, so everything below can only have come from the press itself.
    await holdTheRecording(page);

    const ticks = panel.locator('[data-strip-tick]');
    expect(await ticks.count()).toBeGreaterThanOrEqual(2);
    const tick = (await ticks.first().getAttribute('aria-pressed')) === 'true' ? ticks.last() : ticks.first();
    await tick.click();
    await expect(tick).toHaveAttribute('aria-pressed', 'true');
    await expect(clock).not.toHaveText(before!);

    const row = transcript.locator('[data-turn-row] [aria-current="true"]');
    await expect(row).toHaveCount(1);
    await expect(row).toBeInViewport();
    const pressed = await tick.getAttribute('data-strip-tick');
    await expect(panel.locator(`[data-quote-button="${pressed}"]`)).toHaveAttribute('aria-pressed', 'true');
  });

  test('pressing the cued quote again brings its row back after scrolling away', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    const transcript = panel.getByRole('region', { name: 'Transcript' });
    const row = transcript.locator('[data-turn-row] [aria-current="true"]');
    await expect(row).toHaveCount(1);
    await transcript.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(row).not.toBeInViewport();
    await holdTheRecording(page);
    await panel.locator('[data-strip-tick][aria-pressed="true"]').click();
    await expect(row).toBeInViewport();
  });

  test('entering Review from another tab lands on the cued row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=profile`);
    await app.settle();
    await page.getByRole('tab', { name: 'Phone screening' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
    await expect(panel.locator('[data-turn-row] [aria-current="true"]')).toBeInViewport();
  });

  test('the Ashby deep link says where the candidate stands, and lands on the cued row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    // A worker session as GET /api/screening/:id sends it: stamps and no offsets. This page lists no
    // calls, so those stamps are all it has to place a turn with.
    const stampFrom = Date.parse('2026-10-05T03:30:00.000Z');
    for (const detail of Object.values(app.db.sessionDetails)) {
      detail.transcript = detail.transcript.map((turn) => ({
        ...turn,
        start_offset_sec: null,
        started_at_ms: stampFrom + (turn.start_offset_sec ?? 0) * 1000,
      }));
    }
    await app.goto(`/ashby/review/${SCOPED_REVIEW_LINK_ID}`);
    await app.settle();
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    const header = panel.locator('[data-log-header]');
    await expect(header).toContainText('Writing results back to Ashby');
    await expect(header).not.toContainText('Not linked');
    await expect(header).not.toContainText('Role');
    await expect(header).toContainText(/Length\s*≈\d/);
    await expect(panel.locator('[data-call-strip]')).toBeVisible();
    await expect(panel.locator('[data-turn-active]')).toBeInViewport();
    await expect(panel.getByText('no timing data')).toHaveCount(0);

    // The clock is for reading: it says so, and a press plays nothing.
    const chip = panel.locator('[data-seek-chip]').first();
    await expect(chip).toContainText('≈');
    await expect(chip).toHaveAccessibleName(/Go to this turn\.$/);
    await chip.click();
    const mints = app.calls.filter((c) => /\/api\/recordings\//.test(new URL(c.url).pathname));
    expect(mints).toEqual([]);
  });

  test('a recording that will not mint says so on the tape, in view, with Try again', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    await page.route(/\/api\/recordings\/.*\/download/, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { type: 'not_found', message: 'Recording not found' } }) }),
    );
    await panel.getByRole('button', { name: /^Play from/ }).click();
    const failure = panel.locator('[data-tape-status]').getByRole('alert');
    await expect(failure).toHaveText('Recording not found');
    await expect(failure).toBeInViewport();
    await expect(panel.locator('[data-tape-status]').getByRole('button', { name: 'Try again' })).toBeInViewport();
  });

  test('Play leaves the verdict where it is', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    const pane = panel.getByRole('region', { name: 'AI recommendation' });
    await panel.getByRole('button', { name: /^Play from/ }).click();
    await expect(panel.locator('[data-tape-status]')).not.toHaveAttribute('data-tape-status', 'idle');
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(pane.locator('[data-verdict-box]')).toBeInViewport();
  });

  test('below 1180px a press in the reasoning pane brings its row into the window', async ({ app, page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const panel = await openReview(app, page);
    const chips = panel.locator('[data-seek-chip]');
    const chip = chips.nth((await chips.count()) - 1);
    await chip.scrollIntoViewIfNeeded();
    await holdTheRecording(page);
    await chip.click();
    await expect(panel.locator('[data-turn-row] [aria-current="true"]')).toBeInViewport();
  });

  test('Review opens cued and mints nothing until a press', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(panel.getByRole('button', { name: /^Play from/ })).toBeVisible();
    const mints = () => app.calls.filter((c) => /\/api\/recordings\/|\/recording/.test(new URL(c.url).pathname));
    expect(mints()).toEqual([]);
    await panel.getByRole('button', { name: /^Play from/ }).click();
    await expect.poll(() => mints().length).toBeGreaterThan(0);
  });
});

test.describe('Review, the wording Legal approved', () => {
  test('the consent line opens to the full gate', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    const transcript = panel.getByRole('region', { name: 'Transcript' });
    const line = transcript.locator('[data-consent-line]');
    await expect(line).toContainText(/Consent given at \d\d:\d\d/);
    await line.getByRole('button', { name: /^Show \d+ turns$/ }).click();
    await expect(transcript.getByText('Do you consent to this call being recorded and assessed?')).toBeVisible();
    await expect(transcript.getByText('Yes, I consent.')).toBeVisible();
  });

  test('the what-if line is one line of text, and only on a provisional score', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(panel.locator('[data-what-if]')).toHaveText(
      /^Once .+ (is|are) scored it would read \d+ to \d+; at \w+, \d+ \((Select|Borderline|Reject)\)$/,
    );
  });

  // FIXTURE ONLY, not evidence the feature works: no API supplies `ashbyProfileUrl` yet, so production
  // never shows this link or the sentence beside it. e2e/fixtures/data.ts adds the field by hand. Whether
  // the workflow projection may carry a link is the owner's decision (see types.ts).
  test('fixture only: given a link, the decision goes to Ashby as the one filled action', async ({ app, page }) => {
    test.info().annotations.push({ type: 'fixture-only', description: 'No API supplies ashbyProfileUrl yet.' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReview(app, page);
    const decide = page.getByRole('link', { name: /^Open in Ashby to decide/ });
    await expect(decide).toHaveAttribute('href', /^https:\/\/app\.ashbyhq\.com\//);
    await expect(decide).toHaveAttribute('target', '_blank');
    await expect(page.getByText('The decision is made in Ashby.')).toBeVisible();
  });
});
